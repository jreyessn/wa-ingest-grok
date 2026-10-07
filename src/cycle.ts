import { buildWebhookHeader, type AppConfig } from "./config.js";
import type { CursorStore } from "./cursor/store.js";
import { errorMessage, log } from "./log.js";
import type { Transcriber } from "./media/transcriber.js";
import {
  advanceCursor,
  emptyCursor,
  parseWahaMessage,
  selectNewMessages,
  type ParsedMessage,
} from "./parse/messages.js";
import { buildPayload, TOO_LARGE_NOTE, type OutboundMessage, type WebhookPayload } from "./payload/format.js";
import { MediaTooLargeError } from "./waha/client.js";

const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGES_PER_CYCLE = 200;

export interface CycleDeps {
  config: AppConfig;
  listMessages: (chatId: string, sinceUnixSeconds: number) => Promise<unknown[]>;
  refetchMedia: (chatId: string, messageId: string) => Promise<ParsedMessage["media"]>;
  download: (url: string, maxBytes: number) => Promise<{ data: Buffer; contentType: string | null }>;
  cursor: CursorStore;
  transcriber: Transcriber | null;
  extractAudio: (video: Buffer) => Promise<Buffer>;
  extractPdfText: (data: Buffer) => Promise<string>;
  postWebhook: (payload: WebhookPayload, header: { name: string; value: string }) => Promise<void>;
  now?: () => number;
}

export interface CycleResult {
  sent: boolean;
  batchId?: string;
  count: number;
}

export async function runCycle(deps: CycleDeps): Promise<CycleResult> {
  const groupId = deps.config.wahaGroupId;
  const webhookUrl = deps.config.webhookUrl;
  if (!groupId) throw new Error("Missing required environment variable WAHA_GROUP_ID");
  if (!webhookUrl) throw new Error("Missing required environment variable GROKBOT_WEBHOOK_URL");

  const now = deps.now ?? Date.now;
  let cursor = await deps.cursor.load();
  if (!cursor) {
    cursor = emptyCursor(now());
    await deps.cursor.save(cursor);
    log("info", "cursor.initialized", {
      group: groupId,
      lastTimestamp: cursor.lastTimestamp,
      note: "history before this timestamp is not forwarded",
    });
    return { sent: false, count: 0 };
  }

  const sinceUnixSeconds = Math.floor(cursor.lastTimestamp / 1000);
  const rawMessages = await deps.listMessages(groupId, sinceUnixSeconds);
  const parsed = rawMessages
    .map((raw) => parseWahaMessage(raw))
    .filter((message): message is ParsedMessage => message !== null);
  const pending = selectNewMessages(parsed, cursor);
  const fresh = pending.slice(0, MAX_MESSAGES_PER_CYCLE);
  if (fresh.length === 0) {
    log("info", "cycle.no_new_messages", { group: groupId });
    return { sent: false, count: 0 };
  }
  if (pending.length > fresh.length) {
    log("warn", "cycle.truncated", { group: groupId, kept: fresh.length, pending: pending.length });
  }

  const outbound: OutboundMessage[] = [];
  for (const message of fresh) {
    outbound.push(await enrichMessage(deps, groupId, message));
  }

  const payload = buildPayload({
    group: groupId,
    messages: outbound,
    aliases: deps.config.repoAliases,
  });
  if (!payload) return { sent: false, count: 0 };

  const header = buildWebhookHeader(deps.config.webhookHeader, deps.config.webhookKey);
  log("info", "webhook.post", {
    batch_id: payload.batch_id,
    count: payload.messages.length,
    repo: payload.repo ?? null,
    group: groupId,
  });
  await deps.postWebhook(payload, header);
  const next = advanceCursor(cursor, fresh);
  await deps.cursor.save(next);
  log("info", "webhook.sent", { batch_id: payload.batch_id, count: payload.messages.length });
  return { sent: true, batchId: payload.batch_id, count: payload.messages.length };
}

async function enrichMessage(deps: CycleDeps, groupId: string, message: ParsedMessage): Promise<OutboundMessage> {
  const outbound: OutboundMessage = {
    id: message.id,
    author: message.author,
    timestamp: message.timestamp,
    type: message.type,
    text: message.text,
    transcript: null,
    mime_type: null,
    file_name: null,
    data_base64: null,
    note: null,
    reply_to: message.replyTo,
  };
  if (message.type === "text") return outbound;

  try {
    const media = await resolveMedia(deps, groupId, message);
    if (!media?.url) {
      log("warn", "message.media_missing", { id: message.id, type: message.type });
      return outbound;
    }
    const fileName = media.filename ? safeFilename(media.filename) : filenameFromUrl(media.url, message.type);

    if (message.type === "audio" || message.type === "video") {
      const downloaded = await deps.download(media.url, MAX_WHISPER_BYTES);
      const contentType = media.mimetype ?? downloaded.contentType ?? "application/octet-stream";
      outbound.transcript = await transcribe(deps, message, downloaded.data, contentType, fileName);
      return outbound;
    }

    const limit = Math.floor(deps.config.maxInlineFileMb * 1024 * 1024);
    let downloaded: { data: Buffer; contentType: string | null };
    try {
      downloaded = await deps.download(media.url, limit);
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        return markTooLarge(outbound, media.mimetype, fileName, message.id, err.bytes);
      }
      throw err;
    }
    const contentType = media.mimetype ?? downloaded.contentType ?? "application/octet-stream";
    outbound.mime_type = contentType;
    outbound.file_name = fileName;
    outbound.data_base64 = downloaded.data.toString("base64");
    if (isPdf(contentType, fileName)) {
      const extracted = (await deps.extractPdfText(downloaded.data)).trim();
      outbound.text = joinText(message.text, extracted);
    }
    return outbound;
  } catch (err) {
    log("error", "message.enrich_failed", { id: message.id, type: message.type, error: errorMessage(err) });
    return outbound;
  }
}

function markTooLarge(
  outbound: OutboundMessage,
  mimeType: string | null,
  fileName: string,
  id: string,
  bytes: number,
): OutboundMessage {
  outbound.mime_type = mimeType;
  outbound.file_name = fileName;
  outbound.data_base64 = null;
  outbound.note = TOO_LARGE_NOTE;
  log("warn", "message.too_large", { id, bytes, type: outbound.type });
  return outbound;
}

function isPdf(mimeType: string, fileName: string): boolean {
  return mimeType.toLowerCase().includes("pdf") || fileName.toLowerCase().endsWith(".pdf");
}

async function resolveMedia(deps: CycleDeps, groupId: string, message: ParsedMessage): Promise<ParsedMessage["media"]> {
  if (message.media?.url) return message.media;
  const refetched = await deps.refetchMedia(groupId, message.id);
  if (!refetched) return message.media;
  return {
    url: refetched.url,
    mimetype: refetched.mimetype ?? message.media?.mimetype ?? null,
    filename: refetched.filename ?? message.media?.filename ?? null,
  };
}

async function transcribe(
  deps: CycleDeps,
  message: ParsedMessage,
  data: Buffer,
  contentType: string,
  filename: string | null,
): Promise<string | null> {
  if (!deps.transcriber) {
    log("error", "transcriber.not_configured", { id: message.id, type: message.type });
    return null;
  }
  let audio = data;
  let audioName = filename ?? "audio.ogg";
  let audioType = contentType;
  if (message.type === "video") {
    audio = await deps.extractAudio(data);
    audioName = "audio.mp3";
    audioType = "audio/mpeg";
  }
  if (audio.length > MAX_WHISPER_BYTES) {
    throw new Error(`audio is ${audio.length} bytes, over the Whisper ${MAX_WHISPER_BYTES} byte limit`);
  }
  const text = await deps.transcriber.transcribe({
    data: audio,
    filename: audioName.includes(".") ? audioName : `${audioName}.ogg`,
    mimeType: audioType,
  });
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function joinText(caption: string | null, extracted: string): string | null {
  const parts = [caption?.trim(), extracted.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function filenameFromUrl(url: string, type: ParsedMessage["type"]): string {
  try {
    const name = new URL(url).pathname.split("/").pop();
    if (name) return safeFilename(decodeURIComponent(name));
  } catch {
    // fall through to a type-based name
  }
  if (type === "audio") return "audio.ogg";
  if (type === "video") return "video.mp4";
  if (type === "image") return "image.jpg";
  return "file.bin";
}

export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file.bin";
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned.length > 0 ? cleaned : "file.bin";
}
