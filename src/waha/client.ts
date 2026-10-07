import { log } from "../log.js";
import { readSerializedId } from "../parse/messages.js";

/**
 * WAHA HTTP API (verified against https://waha.devlike.pro/docs/):
 * - POST /api/sessions
 * - POST /api/sessions/{session}/start
 * - POST /api/sessions/{session}/stop
 * - GET  /api/sessions/{session}
 * - GET  /api/{session}/auth/qr?format=raw
 * - GET  /api/{session}/groups
 * - GET  /api/{session}/chats
 * - GET  /api/{session}/chats/{chatId}/messages
 * - GET  /api/{session}/chats/{chatId}/messages/{messageId}
 * Media bytes are downloaded from `media.url` with the `X-Api-Key` header.
 *
 * Groups and chats are engine-dependent: an array, or an object keyed by id.
 * WEBJS ids are often `{ _serialized }` and the subject may live on `name`,
 * `subject`, or `groupMetadata.subject`.
 */

export interface WahaSession {
  name: string;
  status: string;
}

export interface WahaGroup {
  id: string;
  name: string;
}

export interface WahaMedia {
  url: string | null;
  mimetype: string | null;
  filename: string | null;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export class MediaTooLargeError extends Error {
  readonly bytes: number;
  readonly limit: number;

  constructor(bytes: number, limit: number) {
    super(`media is ${bytes} bytes, over the ${limit} byte limit`);
    this.name = "MediaTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

export class WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly session: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  ) {}

  async getSession(): Promise<WahaSession | null> {
    const response = await this.request(`/api/sessions/${encodeURIComponent(this.session)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failure("get session", response);
    const body = (await response.json()) as { name?: unknown; status?: unknown };
    return {
      name: typeof body.name === "string" ? body.name : this.session,
      status: typeof body.status === "string" ? body.status : "UNKNOWN",
    };
  }

  async ensureSession(): Promise<WahaSession> {
    const existing = await this.getSession();
    if (!existing) {
      const created = await this.request("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ name: this.session }),
      });
      if (!created.ok && created.status !== 409 && created.status !== 422) {
        throw await this.failure("create session", created);
      }
    }
    const started = await this.request(`/api/sessions/${encodeURIComponent(this.session)}/start`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!started.ok && started.status !== 409) {
      throw await this.failure("start session", started);
    }
    const session = await this.getSession();
    if (!session) throw new Error(`WAHA session ${this.session} was not found after start`);
    return session;
  }

  /** Stop, then start. Used when login finds FAILED or STOPPED. Stop is idempotent. */
  async restartSession(): Promise<WahaSession> {
    const stopped = await this.request(`/api/sessions/${encodeURIComponent(this.session)}/stop`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!stopped.ok && stopped.status !== 404) {
      throw await this.failure("stop session", stopped);
    }
    return this.ensureSession();
  }

  async getQrValue(): Promise<string> {
    const response = await this.request(`/api/${encodeURIComponent(this.session)}/auth/qr?format=raw`);
    if (!response.ok) throw await this.failure("get qr", response);
    const body = (await response.json()) as { value?: unknown };
    if (typeof body.value !== "string" || body.value.length === 0) {
      throw new Error("WAHA QR response did not include a value");
    }
    return body.value;
  }

  async listGroups(): Promise<WahaGroup[]> {
    const groups = await this.collectGroups("groups");
    if (groups.length > 0) return groups;
    log("info", "groups.fallback_chats");
    return this.collectGroups("chats");
  }

  /**
   * Messages at or after `sinceUnixSeconds`. WAHA's filter.timestamp.gte is inclusive,
   * so the caller drops ids already stored in the cursor.
   */
  async listMessages(chatId: string, sinceUnixSeconds: number): Promise<unknown[]> {
    const collected: unknown[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        downloadMedia: "true",
        "filter.timestamp.gte": String(sinceUnixSeconds),
      });
      const path = `/api/${encodeURIComponent(this.session)}/chats/${encodeURIComponent(chatId)}/messages?${params}`;
      const response = await this.request(path);
      if (!response.ok) throw await this.failure("list messages", response);
      const body = (await response.json()) as unknown;
      const batch = listedRecords(body);
      if (batch.length === 0) break;
      let added = 0;
      for (const item of batch) {
        const id = readSerializedId(idField(item.value)) ?? (item.key?.includes("@") ? item.key : null);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        collected.push(item.value);
        added += 1;
      }
      if (batch.length < PAGE_SIZE || added === 0) break;
    }
    if (collected.length === MAX_PAGES * PAGE_SIZE) {
      log("warn", "waha.messages.page_cap", { chatId, pages: MAX_PAGES });
    }
    return collected;
  }

  async getMessageMedia(chatId: string, messageId: string): Promise<WahaMedia | null> {
    const params = new URLSearchParams({ downloadMedia: "true" });
    const path =
      `/api/${encodeURIComponent(this.session)}/chats/${encodeURIComponent(chatId)}` +
      `/messages/${encodeURIComponent(messageId)}?${params}`;
    const response = await this.request(path);
    if (response.status === 404) return null;
    if (!response.ok) throw await this.failure("get message", response);
    const body = (await response.json()) as { media?: { url?: unknown; mimetype?: unknown; filename?: unknown } | null };
    return {
      url: typeof body.media?.url === "string" ? body.media.url : null,
      mimetype: typeof body.media?.mimetype === "string" ? body.media.mimetype : null,
      filename: typeof body.media?.filename === "string" ? body.media.filename : null,
    };
  }

  async download(url: string, maxBytes: number): Promise<{ data: Buffer; contentType: string | null }> {
    const resolved = resolveMediaUrl(url, this.baseUrl);
    const headers = new Headers();
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    const response = await this.fetchImpl(resolved, { headers });
    if (!response.ok) throw await this.failure("download media", response);
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new MediaTooLargeError(advertised, maxBytes);
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new MediaTooLargeError(data.length, maxBytes);
    return { data, contentType: response.headers.get("content-type") };
  }

  private async collectGroups(kind: "groups" | "chats"): Promise<WahaGroup[]> {
    const found: WahaGroup[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (kind === "groups") {
        params.set("sortBy", "subject");
        params.set("sortOrder", "asc");
        params.set("exclude", "participants");
      }
      const response = await this.request(`/api/${encodeURIComponent(this.session)}/${kind}?${params}`);
      if (!response.ok) throw await this.failure(`list ${kind}`, response);
      const records = listedRecords(await response.json());
      let groupRows = 0;
      let added = 0;
      for (const record of records) {
        const group = normalizeGroup(record.value, record.key);
        if (!group.id.endsWith("@g.us")) continue;
        groupRows += 1;
        if (seen.has(group.id)) continue;
        seen.add(group.id);
        found.push(group);
        added += 1;
      }
      if (records.length < PAGE_SIZE) break;
      if (groupRows > 0 && added === 0) break;
    }
    return found;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    return this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
  }

  private async failure(action: string, response: Response): Promise<Error> {
    const body = await response.text();
    return new Error(`WAHA ${action} failed (${response.status}): ${body.slice(0, 400)}`);
  }
}

interface ListedRecord {
  key?: string;
  value: unknown;
}

/** Arrays, `{ groups|data|messages|chats: ... }`, or an object keyed by id. */
function listedRecords(body: unknown): ListedRecord[] {
  if (Array.isArray(body)) return body.map((value) => ({ value }));
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["groups", "data", "messages", "chats"]) {
    if (!(key in record)) continue;
    const nested = record[key];
    if (Array.isArray(nested) || isIdMap(nested)) return listedRecords(nested);
  }
  if (!isIdMap(record)) return [];
  return Object.entries(record).map(([key, value]) => ({ key, value }));
}

function isIdMap(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const values = Object.values(body as Record<string, unknown>);
  return values.length > 0 && values.every((value) => value !== null && typeof value === "object" && !Array.isArray(value));
}

function idField(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as { id?: unknown }).id;
}

function firstString(values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normalizeGroup(raw: unknown, key?: string): WahaGroup {
  const group = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const metadata =
    group.groupMetadata && typeof group.groupMetadata === "object"
      ? (group.groupMetadata as Record<string, unknown>)
      : undefined;
  const id =
    readSerializedId(group.id) ??
    readSerializedId(group.JID) ??
    readSerializedId(metadata?.id) ??
    (key?.endsWith("@g.us") ? key : "");
  const name = firstString([group.name, group.subject, group.Name, metadata?.subject, metadata?.name]);
  return { id, name };
}

/** WAHA defaults media.url to localhost unless WAHA_BASE_URL is set. Rewrite file URLs onto the configured host. */
export function resolveMediaUrl(mediaUrl: string, wahaUrl: string): string {
  const base = new URL(wahaUrl.endsWith("/") ? wahaUrl : `${wahaUrl}/`);
  const parsed = new URL(mediaUrl, base);
  if (!parsed.pathname.startsWith("/api/files/")) return parsed.toString();
  return new URL(`${parsed.pathname}${parsed.search}`, base).toString();
}
