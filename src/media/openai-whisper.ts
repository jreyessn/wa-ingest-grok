import type { AudioInput, Transcriber } from "./transcriber.js";

const WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const WHISPER_MODEL = "whisper-1";

export class OpenAiWhisperTranscriber implements Transcriber {
  readonly name = "openai-whisper";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly model: string = WHISPER_MODEL,
  ) {}

  async transcribe(input: AudioInput): Promise<string> {
    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([new Uint8Array(input.data)], { type: input.mimeType }), input.filename);
    const response = await this.fetchImpl(WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenAI Whisper failed (${response.status}): ${truncate(body)}`);
    }
    const parsed = JSON.parse(body) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  }
}

function truncate(value: string): string {
  return value.length > 400 ? `${value.slice(0, 400)}…` : value;
}
