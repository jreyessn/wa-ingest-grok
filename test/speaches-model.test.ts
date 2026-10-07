import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiCompatibleTranscriber } from "../src/media/openai-compatible.ts";
import { SpeachesModels, type FetchLike } from "../src/media/speaches-model.ts";

const MODEL = "Systran/faster-whisper-base";
const BASE = "http://whisper:8000/v1";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("SpeachesModels", () => {
  it("skips the download when the model is already listed and remembers that", async () => {
    const calls: string[] = [];
    const models = new SpeachesModels({
      baseUrl: BASE,
      model: MODEL,
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method ?? "GET"} ${String(input)}`);
        return json({ object: "list", data: [{ id: MODEL, object: "model" }] });
      },
    });
    await models.ensureInstalled();
    await models.ensureInstalled();
    assert.deepEqual(calls, [`GET ${BASE}/models`]);
  });

  it("POSTs the model id once when it is missing, then caches the success", async () => {
    const calls: Array<{ method: string; url: string; authorization: string | null }> = [];
    const models = new SpeachesModels({
      baseUrl: `${BASE}/`,
      model: MODEL,
      apiKey: "secret",
      fetchImpl: async (input, init) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        if (init?.method === "POST") return text("Model downloaded", 200);
        return json({ data: [] });
      },
    });
    await models.ensureInstalled();
    await models.ensureInstalled();
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [`GET ${BASE}/models`, `POST ${BASE}/models/${MODEL}`],
    );
    assert.equal(calls[0]?.authorization, "Bearer secret");
    assert.equal(calls[1]?.authorization, "Bearer secret");
  });

  it("does not cache a failed check, so a later call tries again", async () => {
    let calls = 0;
    const models = new SpeachesModels({
      baseUrl: BASE,
      model: MODEL,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("connect ECONNREFUSED");
      },
    });
    await assert.rejects(() => models.ensureInstalled(), /ECONNREFUSED/);
    await assert.rejects(() => models.ensureInstalled(), /ECONNREFUSED/);
    assert.equal(calls, 2);
  });
});

describe("speaches transcription install retry", () => {
  const audio = { data: Buffer.from("audio"), filename: "audio.mp3", mimeType: "audio/mpeg" };

  function wired(fetchImpl: FetchLike): OpenAiCompatibleTranscriber {
    const models = new SpeachesModels({ baseUrl: BASE, model: MODEL, fetchImpl });
    return new OpenAiCompatibleTranscriber({
      name: "speaches",
      baseUrl: BASE,
      model: MODEL,
      fetchImpl,
      prepareModel: () => models.ensureInstalled(),
      reinstallModel: () => models.reinstall(),
    });
  }

  it("installs and retries once when transcription says the model is not installed", async () => {
    const calls: string[] = [];
    let transcriptions = 0;
    const transcriber = wired(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/audio/transcriptions")) {
        transcriptions += 1;
        if (transcriptions === 1) return text(`Model '${MODEL}' is not installed locally`, 404);
        const form = init?.body as FormData;
        assert.equal(form.get("model"), MODEL);
        return json({ text: "hola" });
      }
      if (init?.method === "POST") return text("downloaded", 200);
      return json({ data: [] });
    });
    assert.equal(await transcriber.transcribe(audio), "hola");
    assert.deepEqual(calls, [
      `GET ${BASE}/models`,
      `POST ${BASE}/models/${MODEL}`,
      `POST ${BASE}/audio/transcriptions`,
      `POST ${BASE}/models/${MODEL}`,
      `POST ${BASE}/audio/transcriptions`,
    ]);
  });

  it("does not install again when a 404 is unrelated", async () => {
    const calls: string[] = [];
    const transcriber = wired(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/audio/transcriptions")) return text("nope", 404);
      return json({ data: [{ id: MODEL }] });
    });
    await assert.rejects(() => transcriber.transcribe(audio), /transcription failed \(404\)/);
    assert.deepEqual(calls, [`GET ${BASE}/models`, `POST ${BASE}/audio/transcriptions`]);
  });
});
