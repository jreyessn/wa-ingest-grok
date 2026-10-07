import { buildWebhookHeader, type AppConfig } from "./config.js";
import type { CursorStore } from "./cursor/store.js";
import { errorMessage, log } from "./log.js";
import type { Transcriber } from "./media/transcriber.js";
import {
  advanceCursor,
  emptyCursor,
  parseWahaMessage,
  selectNewMessages,
  type Cursor,
  type MediaRef,
  type ParsedMessage,
} from "./parse/messages.js";
import { buildPayload, TOO_LARGE_NOTE, type OutboundMessage, type WebhookPayload } from "./payload/format.js";
import { MediaTooLargeError } from "./waha/client.js";

const MAX_WHISPER_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGES_PER_CYCLE = 200;
const MEDIA_ATTEMPTS = 4;
const MEDIA_RETRY_MS = [3_000, 6_000, 9_000];
const MAX_MEDIA_HOLDS = 3;

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
  sleep?: (ms: number) => Promise<void>;
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
  const accepted: ParsedMessage[] = [];
  const holds: Record<string, number> = { ...(cursor.mediaHolds ?? {}) };
  let deferred: { id: string; reason: string } | null = null;

  for (const message of fresh) {
    const enriched = await enrichMessage(deps, groupId, message);
    if (enriched.action === "defer") {
      const count = (holds[message.id] ?? 0) + 1;
      holds[message.id] = count;
      if (count < MAX_MEDIA_HOLDS) {
        deferred = { id: message.id, reason: enriched.reason };
        log("warn", "media.deferred", {
          id: message.id,
          type: message.type,
          holds: count,
          error: enriched.reason,
          note: "cursor will not move past this message",
        });
        break;
      }
      delete holds[message.id];
      log("error", "media.download_gave_up", { id: message.id, type: message.type, holds: count, error: enriched.reason });
      outbound.push(enriched.giveUp);
      accepted.push(message);
      continue;
    }
    delete holds[message.id];
    outbound.push(enriched.message);
    accepted.push(message);
  }

  const heldCursor = withHolds(cursor, holds);
  if (outbound.length === 0) {
    if (deferred) await deps.cursor.save(heldCursor);
    else log("info", "cycle.no_new_messages", { group: groupId });
    return { sent: false, count: 0 };
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
  const next = advanceCursor(heldCursor, accepted);
  await deps.cursor.save(next);
  log("info", "webhook.sent", { batch_id: payload.batch_id, count: payload.messages.length });
  return { sent: true, batchId: payload.batch_id, count: payload.messages.length };
}

function withHolds(cursor: Cursor, holds: Record<string, number>): Cursor {
  const kept: Record<string, number> = {};
  for (const [id, count] of Object.entries(holds)) {
    if (Number.isFinite(count) && count > 0) kept[id] = count;
  }
  if (Object.keys(kept).length === 0) {
    const next = { ...cursor };
    delete next.mediaHolds;
    return next;
  }
  return { ...cursor, mediaHolds: kept };
}

type EnrichResult =
  | { action: "send"; message: OutboundMessage }
  | { action: "defer"; reason: string; giveUp: OutboundMessage };

async function enrichMessage(deps: CycleDeps, groupId: string, message: ParsedMessage): Promise<EnrichResult> {
  const outbound = blankOutbound(message);
  if (message.type === "text") return { action: "send", message: outbound };

  log("info", "media.seen", {
    id: message.id,
    type: message.type,
    mimetype: message.media?.mimetype ?? null,
    filename: message.media?.filename ?? null,
    hasUrl: Boolean(message.media?.url),
    mediaError: message.media?.error ?? null,
  });

  try {
    const fetched = await fetchMedia(deps, groupId, message);
    applyKnownFile(outbound, fetched.media, message.type);
    if (!fetched.data || !fetched.media?.url) {
      const reason = fetched.reason ?? fetched.media?.error ?? "media url missing";
      outbound.note = failureNote("download_failed", reason);
      return { action: "defer", reason, giveUp: outbound };
    }

    const fileName = outbound.file_name ?? filenameFromUrl(fetched.media.url, message.type);
    const contentType = outbound.mime_type ?? fetched.data.contentType ?? "application/octet-stream";
    outbound.file_name = fileName;
    outbound.mime_type = contentType;

    if (message.type === "audio" || message.type === "video") {
      outbound.transcript = await transcribe(deps, message, fetched.data.data, contentType, fileName);
      if (!outbound.transcript) {
        outbound.note = failureNote("transcription_failed", "empty transcript");
        log("warn", "media.transcription_empty", { id: message.id, type: message.type });
      }
      return { action: "send", message: outbound };
    }

    outbound.data_base64 = fetched.data.data.toString("base64");
    if (isPdf(contentType, fileName)) {
      try {
        const extracted = (await deps.extractPdfText(fetched.data.data)).trim();
        outbound.text = joinText(message.text, extracted);
      } catch (err) {
        log("warn", "media.pdf_text_failed", { id: message.id, error: errorMessage(err) });
      }
    }
    return { action: "send", message: outbound };
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      applyKnownFile(outbound, message.media, message.type);
      const marked = markTooLarge(outbound, outbound.mime_type, outbound.file_name ?? "file.bin", message.id, err.bytes);
      return { action: "send", message: marked };
    }
    const reason = errorMessage(err);
    const transcription = message.type === "audio" || message.type === "video";
    outbound.note = failureNote(transcription ? "transcription_failed" : "download_failed", reason);
    log("error", transcription ? "media.transcription_failed" : "media.enrich_failed", {
      id: message.id,
      type: message.type,
      error: reason,
    });
    if (transcription) return { action: "send", message: outbound };
    return { action: "defer", reason, giveUp: outbound };
  }
}

function blankOutbound(message: ParsedMessage): OutboundMessage {
  return {
    id: message.id,
    author: message.author,
    timestamp: message.timestamp,
    type: message.type,
    text: message.text,
    transcript: null,
    mime_type: message.media?.mimetype ?? null,
    file_name: message.media?.filename ? safeFilename(message.media.filename) : null,
    data_base64: null,
    note: null,
    reply_to: message.replyTo,
  };
}

function applyKnownFile(outbound: OutboundMessage, media: MediaRef | null, type: ParsedMessage["type"]): void {
  if (media?.mimetype) outbound.mime_type = media.mimetype;
  if (media?.filename) outbound.file_name = safeFilename(media.filename);
  else if (!outbound.file_name && media?.url) outbound.file_name = filenameFromUrl(media.url, type);
}

function failureNote(kind: "download_failed" | "transcription_failed", reason: string): string {
  const clean = reason.replace(/\s+/g, " ").trim().slice(0, 240);
  return `${kind}: ${clean || "unknown"}`;
}

async function fetchMedia(
  deps: CycleDeps,
  groupId: string,
  message: ParsedMessage,
): Promise<{ data: { data: Buffer; contentType: string | null } | null; media: MediaRef | null; reason: string | null }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const limit = message.type === "audio" || message.type === "video"
    ? MAX_WHISPER_BYTES
    : Math.floor(deps.config.maxInlineFileMb * 1024 * 1024);
  let media = message.media;
  let reason: string | null = media?.error ?? null;

  for (let attempt = 1; attempt <= MEDIA_ATTEMPTS; attempt++) {
    if (!media?.url) {
      log("warn", "media.url_missing", { id: message.id, type: message.type, attempt, error: reason });
      log("info", "media.refetch", { id: message.id, attempt });
      const refetched = await deps.refetchMedia(groupId, message.id);
      media = mergeMedia(media, refetched);
      if (refetched?.error) reason = refetched.error;
    }
    if (media?.url) {
      log("info", "media.download", { id: message.id, type: message.type, attempt, filename: media.filename, mimetype: media.mimetype });
      try {
        const data = await deps.download(media.url, limit);
        log("info", "media.downloaded", { id: message.id, bytes: data.data.length, contentType: data.contentType });
        return { data, media, reason: null };
      } catch (err) {
        if (err instanceof MediaTooLargeError) throw err;
        reason = errorMessage(err);
        log("warn", "media.download_failed", { id: message.id, type: message.type, attempt, error: reason });
        media = media ? { ...media, url: null } : media;
      }
    } else {
      reason = reason ?? "media url missing";
    }
    if (attempt < MEDIA_ATTEMPTS) {
      const delay = MEDIA_RETRY_MS[attempt - 1] ?? 3_000;
      log("warn", "media.retry", { id: message.id, attempt, delayMs: delay });
      await sleep(delay);
    }
  }
  return { data: null, media, reason: reason ?? "media url missing" };
}

function mergeMedia(current: MediaRef | null, next: MediaRef | null): MediaRef | null {
  if (!next) return current;
  if (!current) return next;
  return {
    url: next.url ?? current.url,
    mimetype: next.mimetype ?? current.mimetype,
    filename: next.filename ?? current.filename,
    error: next.error ?? current.error,
  };
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

async function transcribe(
  deps: CycleDeps,
  message: ParsedMessage,
  data: Buffer,
  contentType: string,
  filename: string | null,
): Promise<string | null> {
  if (!deps.transcriber) {
    log("error", "transcriber.not_configured", { id: message.id, type: message.type });
    throw new Error("transcriber not configured");
  }
  let audio = data;
  let audioName = filename ?? "audio.ogg";
  let audioType = contentType;
  if (message.type === "video") {
    log("info", "media.extract_audio", { id: message.id, bytes: data.length });
    audio = await deps.extractAudio(data);
    audioName = "audio.mp3";
    audioType = "audio/mpeg";
    log("info", "media.extract_audio_done", { id: message.id, bytes: audio.length });
  }
  log("info", "media.transcribe", { id: message.id, bytes: audio.length, mimeType: audioType });
  if (audio.length > MAX_WHISPER_BYTES) {
    throw new Error(`audio is ${audio.length} bytes, over the Whisper ${MAX_WHISPER_BYTES} byte limit`);
  }
  const text = await deps.transcriber.transcribe({
    data: audio,
    filename: audioName.includes(".") ? audioName : `${audioName}.ogg`,
    mimeType: audioType,
  });
  const trimmed = text.trim();
  log("info", "media.transcribed", { id: message.id, chars: trimmed.length });
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
