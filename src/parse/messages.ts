export type MessageType = "text" | "audio" | "video" | "image" | "document";

export interface MediaRef {
  url: string | null;
  mimetype: string | null;
  filename: string | null;
  error: string | null;
}

export interface ParsedMessage {
  id: string;
  author: string;
  timestamp: string;
  timestampUnixMs: number;
  type: MessageType;
  text: string | null;
  replyTo: string | null;
  media: MediaRef | null;
}

export interface Cursor {
  lastTimestamp: number;
  seenIdsAtTimestamp: string[];
  /** How many cycles a media message has been held back because the file was not ready. */
  mediaHolds?: Record<string, number>;
}

interface ReplyTo {
  id?: unknown;
}

interface LooseMessage {
  id?: unknown;
  timestamp?: unknown;
  from?: unknown;
  fromMe?: unknown;
  participant?: unknown;
  author?: unknown;
  body?: unknown;
  hasMedia?: unknown;
  media?: {
    url?: unknown;
    mimetype?: unknown;
    filename?: unknown;
    error?: unknown;
  } | null;
  mediaUrl?: unknown;
  replyTo?: ReplyTo | string | null;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  _data?: {
    type?: unknown;
    mimetype?: unknown;
    filename?: unknown;
    participant?: unknown;
    author?: unknown;
    key?: { participant?: unknown };
    Info?: { Sender?: unknown; SenderAlt?: unknown };
  } | null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * WAHA engines disagree on ids. WEBJS often sends `{ _serialized }` (or `user` + `server`)
 * where GOWS and NOWEB send a string.
 */
export function readSerializedId(value: unknown): string | null {
  if (typeof value === "string") return asString(value);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const serialized = asString(record._serialized);
  if (serialized) return serialized;
  const user = asString(record.user);
  const server = asString(record.server);
  if (user && server) return `${user}@${server}`;
  if (record.remote !== undefined && record.id !== undefined) {
    const remote = readSerializedId(record.remote);
    const local = asString(record.id);
    if (remote && local && !local.includes("@")) {
      const fromMe = record.fromMe === true ? "true" : "false";
      const participant = record.participant ? readSerializedId(record.participant) : null;
      return participant ? `${fromMe}_${remote}_${local}_${participant}` : `${fromMe}_${remote}_${local}`;
    }
  }
  if (record.id !== undefined && record.id !== value) return readSerializedId(record.id);
  return null;
}

/** WhatsApp / WAHA sometimes uses @s.whatsapp.net for the same user as @c.us. */
export function normalizeJid(value: unknown): string | null {
  const jid = readSerializedId(value);
  if (!jid) return null;
  if (jid.endsWith("@s.whatsapp.net")) return jid.replace(/@s\.whatsapp\.net$/, "@c.us");
  return jid;
}

function pickAuthor(message: LooseMessage): string {
  const candidates = [
    message.participant,
    message.author,
    message._data?.participant,
    message._data?.author,
    message._data?.key?.participant,
    message._data?.Info?.Sender,
    message._data?.Info?.SenderAlt,
  ];
  for (const candidate of candidates) {
    const jid = normalizeJid(candidate);
    if (jid && !jid.endsWith("@g.us")) return jid;
  }
  if (message.fromMe === true) return "me";
  const from = normalizeJid(message.from);
  if (from && !from.endsWith("@g.us")) return from;
  return "unknown";
}

export function timestampToUnixMs(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  if (numeric < 1e12) return Math.round(numeric * 1000);
  return Math.round(numeric);
}

export function toIsoTimestamp(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

export function kindFromMime(mimetype: string | null, filename: string | null, hasMedia: boolean): MessageType {
  const mime = (mimetype ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  if (mime.startsWith("audio/") || mime === "application/ogg") return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (name.endsWith(".mp4") || name.endsWith(".mov") || name.endsWith(".webm") || name.endsWith(".mkv")) return "video";
  if (name.endsWith(".ogg") || name.endsWith(".opus") || name.endsWith(".mp3") || name.endsWith(".m4a")) return "audio";
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "document";
  if (mime || hasMedia) return "document";
  return "text";
}

function kindFromEngine(engineType: string | null, mimetype: string | null, filename: string | null, hasMedia: boolean): MessageType {
  switch ((engineType ?? "").toLowerCase()) {
    case "video":
    case "gif":
      return "video";
    case "ptt":
    case "audio":
      return "audio";
    case "image":
    case "sticker":
      return "image";
    default:
      return kindFromMime(mimetype, filename, hasMedia);
  }
}

function replyId(replyTo: LooseMessage["replyTo"]): string | null {
  if (!replyTo) return null;
  if (typeof replyTo === "string") return asString(replyTo);
  return readSerializedId(replyTo.id) ?? readSerializedId(replyTo);
}

function textOf(message: LooseMessage): string | null {
  const body = typeof message.body === "string" && message.body.length > 0 ? message.body : null;
  if (body) return body;
  const latitude = message.location?.latitude;
  const longitude = message.location?.longitude;
  if (typeof latitude === "number" && typeof longitude === "number") {
    return `${latitude},${longitude}`;
  }
  return null;
}

function errorText(value: unknown): string | null {
  const direct = asString(value);
  if (direct) return direct.slice(0, 300);
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const message = asString(record.message);
  const details = asString(record.details);
  if (message && details) return `${message}: ${details}`.slice(0, 300);
  return message ?? details;
}

/** WEBJS puts the original filename and mimetype on `_data` when `media.url` is still null. */
export function mediaOf(message: LooseMessage): MediaRef | null {
  const raw = message._data;
  const engineType = asString(raw?.type)?.toLowerCase() ?? "";
  const hasEngineMedia = ["video", "gif", "ptt", "audio", "image", "sticker", "document"].includes(engineType);
  if (!message.media && message.hasMedia !== true && !hasEngineMedia) return null;
  const mimetype = asString(message.media?.mimetype) ?? asString(raw?.mimetype);
  const filename = asString(message.media?.filename) ?? asString(raw?.filename);
  const url = asString(message.media?.url);
  return {
    url,
    mimetype,
    filename,
    error: errorText(message.media?.error),
  };
}

/**
 * Map one WAHA chat-message object into the fields this service forwards.
 * Returns null when the object has no id (engine noise, not a message).
 */
export function parseWahaMessage(raw: unknown): ParsedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as LooseMessage;
  const id = readSerializedId(message.id);
  const timestampUnixMs = timestampToUnixMs(message.timestamp);
  if (!id || timestampUnixMs === null) return null;
  const media = mediaOf(message);
  const type = kindFromEngine(
    asString(message._data?.type),
    media?.mimetype ?? null,
    media?.filename ?? null,
    message.hasMedia === true || Boolean(media),
  );
  return {
    id,
    author: pickAuthor(message),
    timestamp: toIsoTimestamp(timestampUnixMs),
    timestampUnixMs,
    type,
    text: textOf(message),
    replyTo: replyId(message.replyTo),
    media: type === "text" ? null : media,
  };
}

export function selectNewMessages<T extends { id: string; timestampUnixMs: number }>(
  messages: T[],
  cursor: Cursor,
): T[] {
  const seen = new Set(cursor.seenIdsAtTimestamp);
  const fresh = new Map<string, T>();
  for (const message of messages) {
    const isNewer = message.timestampUnixMs > cursor.lastTimestamp;
    const isUnseenTie = message.timestampUnixMs === cursor.lastTimestamp && !seen.has(message.id);
    if (!isNewer && !isUnseenTie) continue;
    fresh.set(message.id, message);
  }
  return [...fresh.values()].sort((a, b) => {
    if (a.timestampUnixMs !== b.timestampUnixMs) return a.timestampUnixMs - b.timestampUnixMs;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function advanceCursor(cursor: Cursor, accepted: Array<{ id: string; timestampUnixMs: number }>): Cursor {
  if (accepted.length === 0) return cursor;
  const lastTimestamp = Math.max(cursor.lastTimestamp, ...accepted.map((message) => message.timestampUnixMs));
  const ids = new Set<string>();
  if (lastTimestamp === cursor.lastTimestamp) {
    for (const id of cursor.seenIdsAtTimestamp) ids.add(id);
  }
  for (const message of accepted) {
    if (message.timestampUnixMs === lastTimestamp) ids.add(message.id);
  }
  const next: Cursor = { lastTimestamp, seenIdsAtTimestamp: [...ids].sort() };
  if (!cursor.mediaHolds) return next;
  const holds: Record<string, number> = {};
  for (const [id, count] of Object.entries(cursor.mediaHolds)) {
    if (!accepted.some((message) => message.id === id) && Number.isFinite(count) && count > 0) holds[id] = count;
  }
  if (Object.keys(holds).length > 0) next.mediaHolds = holds;
  return next;
}

export function emptyCursor(nowMs: number): Cursor {
  return { lastTimestamp: nowMs, seenIdsAtTimestamp: [] };
}
