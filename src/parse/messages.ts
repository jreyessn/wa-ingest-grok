export type MessageType = "text" | "audio" | "video" | "image" | "document";

export interface MediaRef {
  url: string | null;
  mimetype: string | null;
  filename: string | null;
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
  } | null;
  replyTo?: ReplyTo | string | null;
  location?: { latitude?: unknown; longitude?: unknown } | null;
  _data?: {
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

/** WhatsApp / WAHA sometimes uses @s.whatsapp.net for the same user as @c.us. */
export function normalizeJid(value: unknown): string | null {
  const jid = asString(value);
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
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "document";
  if (mime || hasMedia) return "document";
  return "text";
}

function replyId(replyTo: LooseMessage["replyTo"]): string | null {
  if (!replyTo) return null;
  if (typeof replyTo === "string") return asString(replyTo);
  return asString(replyTo.id);
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

function mediaOf(message: LooseMessage): MediaRef | null {
  if (!message.media && message.hasMedia !== true) return null;
  return {
    url: asString(message.media?.url),
    mimetype: asString(message.media?.mimetype),
    filename: asString(message.media?.filename),
  };
}

/**
 * Map one WAHA chat-message object into the fields this service forwards.
 * Returns null when the object has no id (engine noise, not a message).
 */
export function parseWahaMessage(raw: unknown): ParsedMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as LooseMessage;
  const id = asString(message.id);
  const timestampUnixMs = timestampToUnixMs(message.timestamp);
  if (!id || timestampUnixMs === null) return null;
  const media = mediaOf(message);
  const type = kindFromMime(media?.mimetype ?? null, media?.filename ?? null, message.hasMedia === true || Boolean(media));
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
  return { lastTimestamp, seenIdsAtTimestamp: [...ids].sort() };
}

export function emptyCursor(nowMs: number): Cursor {
  return { lastTimestamp: nowMs, seenIdsAtTimestamp: [] };
}
