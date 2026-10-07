import { log } from "../log.js";
import { modelNotInstalled, type FetchLike } from "./speaches-model.js";
import type { AudioInput, Transcriber } from "./transcriber.js";

export interface OpenAiCompatibleOptions {
  name: string;
  /** Origin plus `/v1`, for example `http://whisper:8000/v1` or `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Speaches only. Makes sure the model is installed before the first request. */
  prepareModel?: () => Promise<void>;
  /** Speaches only. Installs the model again after a 404 that says it is not installed. */
  reinstallModel?: () => Promise<void>;
}

/** OpenAI Whisper and Speaches both accept this multipart transcription call. */
export class OpenAiCompatibleTranscriber implements Transcriber {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: FetchLike;
  private readonly prepareModel?: () => Promise<void>;
  private readonly reinstallModel?: () => Promise<void>;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.prepareModel = options.prepareModel;
    this.reinstallModel = options.reinstallModel;
  }

  async transcribe(input: AudioInput): Promise<string> {
    if (this.prepareModel) await this.prepareModel();
    let response = await this.postAudio(input);
    let body = await response.text();
    if (!response.ok && this.reinstallModel && modelNotInstalled(response.status, body)) {
      log("warn", "whisper.model_not_installed", { model: this.model, error: truncate(body) });
      await this.reinstallModel();
      response = await this.postAudio(input);
      body = await response.text();
    }
    if (!response.ok) {
      throw new Error(`${this.name} transcription failed (${response.status}): ${truncate(body)}`);
    }
    return readTranscript(body);
  }

  private postAudio(input: AudioInput): Promise<Response> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("response_format", "json");
    form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
    const headers = new Headers();
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    return this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
    });
  }
}

function readTranscript(body: string): string {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed = JSON.parse(trimmed) as { text?: unknown };
  return typeof parsed.text === "string" ? parsed.text : "";
}

function truncate(value: string): string {
  return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}
