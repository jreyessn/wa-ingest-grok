import { log } from "../log.js";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const LIST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export interface SpeachesModelOptions {
  /** Origin plus `/v1`, for example `http://whisper:8000/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  listTimeoutMs?: number;
  downloadTimeoutMs?: number;
}

/**
 * Speaches does not always install PRELOAD_MODELS on the published image.
 * GET /v1/models lists local models. POST /v1/models/{id} downloads one.
 * A successful check is remembered for this process.
 */
export class SpeachesModels {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly listTimeoutMs: number;
  private readonly downloadTimeoutMs: number;
  private ready = false;
  private pending: Promise<void> | null = null;

  constructor(options: SpeachesModelOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.listTimeoutMs = options.listTimeoutMs ?? LIST_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  }

  /** List models and download WHISPER_MODEL when it is absent. */
  async ensureInstalled(): Promise<void> {
    if (this.ready) return;
    await this.share(async () => {
      const ids = await this.listModels();
      if (ids.includes(this.model)) {
        log("info", "whisper.model_ready", { model: this.model });
        return;
      }
      log("info", "whisper.model_missing", { model: this.model });
      await this.download();
    });
  }

  /** POST the model again. Used after a transcription 404 that says it is not installed. */
  async reinstall(): Promise<void> {
    this.ready = false;
    await this.share(() => this.download());
  }

  private async share(task: () => Promise<void>): Promise<void> {
    if (this.ready) return;
    if (!this.pending) {
      this.pending = task()
        .then(() => {
          this.ready = true;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    await this.pending;
  }

  private async listModels(): Promise<string[]> {
    log("info", "whisper.model_check", { model: this.model });
    const response = await this.fetchImpl(`${this.baseUrl}/models`, {
      method: "GET",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.listTimeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`speaches model list failed (${response.status}): ${truncate(body)}`);
    }
    return modelIds(body);
  }

  private async download(): Promise<void> {
    const url = `${this.baseUrl}/models/${this.model.split("/").map(encodeURIComponent).join("/")}`;
    log("info", "whisper.model_download", { model: this.model });
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.downloadTimeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`speaches model download failed (${response.status}): ${truncate(body)}`);
    }
    log("info", "whisper.model_downloaded", { model: this.model, status: response.status });
  }

  private headers(): Headers {
    const headers = new Headers({ Accept: "application/json" });
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    return headers;
  }
}

export function modelNotInstalled(status: number, body: string): boolean {
  return status === 404 && body.toLowerCase().includes("not installed");
}

function modelIds(body: string): string[] {
  const parsed = JSON.parse(body) as { data?: unknown };
  if (!Array.isArray(parsed.data)) throw new Error("speaches model list did not include data");
  const ids: string[] = [];
  for (const item of parsed.data) {
    if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
      ids.push((item as { id: string }).id);
    }
  }
  return ids;
}

function truncate(value: string): string {
  return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}
