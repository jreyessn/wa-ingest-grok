import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { OpenAiCompatibleTranscriber } from "../src/media/openai-compatible.ts";
import { createTranscriber } from "../src/runtime.ts";

describe("transcription provider", () => {
  it("defaults to the local Speaches base model and a 5 MB inline limit", () => {
    const config = loadConfig("login", {});
    assert.equal(config.transcribeProvider, "speaches");
    assert.equal(config.whisperModel, "Systran/faster-whisper-base");
    assert.equal(config.whisperBaseUrl, "http://localhost:8000/v1");
    assert.equal(config.maxInlineFileMb, 5);
    assert.equal(createTranscriber(config)?.name, "speaches");
  });

  it("uses OpenAI only when TRANSCRIBE_PROVIDER=openai and a key is set", () => {
    const missing = loadConfig("login", { TRANSCRIBE_PROVIDER: "openai" });
    assert.equal(createTranscriber(missing), null);
    const ready = loadConfig("login", { TRANSCRIBE_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" });
    assert.equal(createTranscriber(ready)?.name, "openai-whisper");
  });

  it("posts to the configured base URL without an Authorization header when no key is set", async () => {
    let seen: { url: string; authorization: string | null; model: string } | undefined;
    const transcriber = new OpenAiCompatibleTranscriber({
      name: "speaches",
      baseUrl: "http://whisper:8000/v1",
      model: "Systran/faster-whisper-base",
      fetchImpl: async (url, init) => {
        const form = init?.body as FormData;
        seen = {
          url: String(url),
          authorization: new Headers(init?.headers).get("Authorization"),
          model: String(form.get("model")),
        };
        return new Response(JSON.stringify({ text: "hola" }), { status: 200 });
      },
    });
    const text = await transcriber.transcribe({
      data: Buffer.from("audio"),
      filename: "audio.mp3",
      mimeType: "audio/mpeg",
    });
    assert.equal(text, "hola");
    assert.equal(seen?.url, "http://whisper:8000/v1/audio/transcriptions");
    assert.equal(seen?.authorization, null);
    assert.equal(seen?.model, "Systran/faster-whisper-base");
  });
});