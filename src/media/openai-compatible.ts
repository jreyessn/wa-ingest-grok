import type { AudioInput, Transcriber } from "./transcriber.js";

export interface OpenAiCompatibleOptions {
  name: string;
  /** Origin plus `/v1`, for example `http://whisper:8000/v1` or `https://api.openai.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** OpenAI Whisper and Speaches both accept this multipart transcription call. */
export class OpenAiCompatibleTranscriber implements Transcriber {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(input: AudioInput): Promise<string> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("response_format", "json");
    form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
    const headers = new Headers();
    if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
    const response = await this.fetchImpl(`${this.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: form,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${this.name} transcription failed (${response.status}): ${truncate(body)}`);
    }
    return readTranscript(body);
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
