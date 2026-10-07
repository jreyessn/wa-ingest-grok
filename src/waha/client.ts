import { log } from "../log.js";

/**
 * WAHA HTTP API (verified against https://waha.devlike.pro/docs/):
 * - POST /api/sessions
 * - POST /api/sessions/{session}/start
 * - GET  /api/sessions/{session}
 * - GET  /api/{session}/auth/qr?format=raw
 * - GET  /api/{session}/groups
 * - GET  /api/{session}/chats/{chatId}/messages
 * - GET  /api/{session}/chats/{chatId}/messages/{messageId}
 * Media bytes are downloaded from `media.url` with the `X-Api-Key` header.
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

export class WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly session: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch,
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
    const groups: WahaGroup[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
        sortBy: "subject",
        sortOrder: "asc",
        exclude: "participants",
      });
      const response = await this.request(`/api/${encodeURIComponent(this.session)}/groups?${params}`);
      if (!response.ok) throw await this.failure("list groups", response);
      const body = (await response.json()) as unknown;
      const batch = unwrapList(body).map(normalizeGroup).filter((group) => group.id.length > 0);
      groups.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return groups;
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
      const batch = unwrapList(body);
      if (batch.length === 0) break;
      for (const item of batch) {
        const id = item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
          ? (item as { id: string }).id
          : undefined;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        collected.push(item);
      }
      if (batch.length < PAGE_SIZE) break;
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

  async download(url: string): Promise<{ data: Buffer; contentType: string | null }> {
    const resolved = resolveMediaUrl(url, this.baseUrl);
    const headers = new Headers();
    if (this.apiKey) headers.set("X-Api-Key", this.apiKey);
    const response = await this.fetchImpl(resolved, { headers });
    if (!response.ok) throw await this.failure("download media", response);
    const advertised = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(advertised) && advertised > 50 * 1024 * 1024) {
      throw new Error(`media is ${advertised} bytes, over the 50MB download limit`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    return { data, contentType: response.headers.get("content-type") };
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

function unwrapList(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    for (const key of ["groups", "data", "messages"]) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
  }
  return [];
}

function normalizeGroup(raw: unknown): WahaGroup {
  if (!raw || typeof raw !== "object") return { id: "", name: "" };
  const group = raw as Record<string, unknown>;
  const id = typeof group.id === "string" ? group.id : typeof group.JID === "string" ? group.JID : "";
  const name =
    typeof group.subject === "string"
      ? group.subject
      : typeof group.name === "string"
        ? group.name
        : typeof group.Name === "string"
          ? group.Name
          : "";
  return { id, name };
}

/** WAHA defaults media.url to localhost unless WAHA_BASE_URL is set. Rewrite file URLs onto the configured host. */
export function resolveMediaUrl(mediaUrl: string, wahaUrl: string): string {
  const base = new URL(wahaUrl.endsWith("/") ? wahaUrl : `${wahaUrl}/`);
  const parsed = new URL(mediaUrl, base);
  if (!parsed.pathname.startsWith("/api/files/")) return parsed.toString();
  return new URL(`${parsed.pathname}${parsed.search}`, base).toString();
}
