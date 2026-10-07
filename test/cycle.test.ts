import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.ts";
import { JsonCursorStore } from "../src/cursor/store.ts";
import type { CursorStore } from "../src/cursor/store.ts";
import { runCycle, type CycleDeps } from "../src/cycle.ts";
import { MediaTooLargeError } from "../src/waha/client.ts";
import type { Cursor } from "../src/parse/messages.ts";
import type { WebhookPayload } from "../src/payload/format.ts";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const config: AppConfig = {
  wahaUrl: "http://waha:3000",
  wahaSession: "default",
  wahaGroupId: "120363012345@g.us",
  intervalMinutes: 5,
  transcribeProvider: "speaches",
  whisperBaseUrl: "http://whisper:8000/v1",
  whisperModel: "Systran/faster-whisper-base",
  maxInlineFileMb: 5,
  webhookUrl: "https://example.test/hook",
  webhookKey: "secret",
  webhookHeader: "Authorization: Bearer ${GROKBOT_WEBHOOK_KEY}",
  repoAliases: [{ alias: "#plataforma", repo: "jreyessn/plataforma_tm" }],
  dataDir: "/data",
};

class MemoryCursor implements CursorStore {
  value: Cursor | null = null;
  async load(): Promise<Cursor | null> {
    return this.value;
  }
  async save(cursor: Cursor): Promise<void> {
    this.value = cursor;
  }
}

function deps(overrides: Partial<CycleDeps> = {}): { deps: CycleDeps; posts: WebhookPayload[]; cursor: MemoryCursor } {
  const posts: WebhookPayload[] = [];
  const cursor = new MemoryCursor();
  const base: CycleDeps = {
    config,
    cursor,
    listMessages: async () => [],
    refetchMedia: async () => null,
    download: async () => ({ data: Buffer.from("file"), contentType: "application/octet-stream" }),
    transcriber: { name: "fake", transcribe: async () => "transcribed words" },
    extractAudio: async () => Buffer.from("audio"),
    extractPdfText: async () => "pdf #plataforma",
    postWebhook: async (payload) => {
      posts.push(payload);
    },
    now: () => 1_704_067_200_000,
    sleep: async () => {},
    ...overrides,
  };
  return { deps: base, posts, cursor };
}

describe("runCycle", () => {
  it("baselines an empty cursor and sends nothing", async () => {
    const harness = deps();
    const result = await runCycle(harness.deps);
    assert.deepEqual(result, { sent: false, count: 0 });
    assert.equal(harness.posts.length, 0);
    assert.equal(harness.cursor.value?.lastTimestamp, 1_704_067_200_000);
  });

  it("sends nothing when every returned message was already processed", async () => {
    const harness = deps({
      listMessages: async () => [
        { id: "old", timestamp: 1704067200, from: "5491111111111@c.us", body: "ya visto" },
      ],
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: ["old"] };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, false);
    assert.equal(harness.posts.length, 0);
  });

  it("posts raw text with author, timestamp, and reply_to, then advances the cursor", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "new",
          timestamp: 1704067260,
          from: "120363012345@g.us",
          participant: "5491111111111@c.us",
          body: "revisar #plataforma",
          replyTo: { id: "old" },
        },
      ],
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: ["old"] };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, true);
    assert.equal(result.count, 1);
    const payload = harness.posts[0];
    assert.ok(payload);
    assert.equal(payload.repo, "jreyessn/plataforma_tm");
    assert.deepEqual(payload.messages[0], {
      id: "new",
      author: "5491111111111@c.us",
      timestamp: "2024-01-01T00:01:00.000Z",
      type: "text",
      text: "revisar #plataforma",
      transcript: null,
      mime_type: null,
      file_name: null,
      data_base64: null,
      note: null,
      reply_to: "old",
    });
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("new"), true);

    const again = await runCycle(harness.deps);
    assert.equal(again.sent, false);
    assert.equal(harness.posts.length, 1);
  });

  it("transcribes audio and does not inline the file", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "voice",
          timestamp: 1704067260,
          from: "5491111111111@c.us",
          hasMedia: true,
          media: { url: "http://localhost:3000/api/files/voice.ogg", mimetype: "audio/ogg; codecs=opus", filename: null },
        },
      ],
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    await runCycle(harness.deps);
    assert.equal(harness.posts[0]?.messages[0]?.type, "audio");
    assert.equal(harness.posts[0]?.messages[0]?.transcript, "transcribed words");
    assert.equal(harness.posts[0]?.messages[0]?.data_base64, null);
    assert.equal(harness.posts[0]?.messages[0]?.note, null);
  });

  it("extracts video audio through ffmpeg and transcribes that buffer", async () => {
    let seen: Buffer | undefined;
    const harness = deps({
      listMessages: async () => [
        {
          id: "clip",
          timestamp: 1704067260,
          participant: "5491111111111@c.us",
          from: "120363012345@g.us",
          hasMedia: true,
          media: { url: "http://waha:3000/api/files/clip.mp4", mimetype: "video/mp4", filename: "clip.mp4" },
        },
      ],
      extractAudio: async (video) => {
        seen = video;
        return Buffer.from("extracted-audio");
      },
      transcriber: {
        name: "fake",
        transcribe: async (input) => {
          assert.equal(input.filename, "audio.mp3");
          assert.equal(input.data.toString(), "extracted-audio");
          return "video words";
        },
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    await runCycle(harness.deps);
    assert.equal(seen?.toString(), "file");
    assert.equal(harness.posts[0]?.messages[0]?.type, "video");
    assert.equal(harness.posts[0]?.messages[0]?.transcript, "video words");
    assert.equal(harness.posts[0]?.messages[0]?.data_base64, null);
    assert.equal(harness.posts[0]?.messages[0]?.mime_type, "video/mp4");
    assert.equal(harness.posts[0]?.messages[0]?.file_name, "clip.mp4");
    assert.equal(harness.posts[0]?.messages[0]?.note, null);
  });

  it("retries a WEBJS video until media.url appears, then transcribes it", async () => {
    const urls: string[] = [];
    let refetches = 0;
    const harness = deps({
      listMessages: async () => [
        {
          id: "false_120363012345@g.us_VID",
          timestamp: 1704067260,
          from: "120363012345@g.us",
          participant: "5491111111111@lid",
          hasMedia: true,
          media: { url: null, mimetype: "video/mp4", filename: null, error: null },
          _data: { type: "video", mimetype: "video/mp4", filename: "ajustesfacturacion.mp4" },
        },
      ],
      refetchMedia: async () => {
        refetches += 1;
        if (refetches < 2) return { url: null, mimetype: "video/mp4", filename: "ajustesfacturacion.mp4", error: null };
        return {
          url: "http://localhost:3000/api/files/default/false_120363012345@g.us_VID.mp4",
          mimetype: "video/mp4",
          filename: "ajustesfacturacion.mp4",
          error: null,
        };
      },
      download: async (url) => {
        urls.push(url);
        return { data: Buffer.from("video-bytes"), contentType: "video/mp4" };
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, true);
    assert.equal(refetches, 2);
    assert.equal(urls.length, 1);
    const message = harness.posts[0]?.messages[0];
    assert.equal(message?.type, "video");
    assert.equal(message?.author, "5491111111111@lid");
    assert.equal(message?.transcript, "transcribed words");
    assert.equal(message?.mime_type, "video/mp4");
    assert.equal(message?.file_name, "ajustesfacturacion.mp4");
    assert.equal(message?.note, null);
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("false_120363012345@g.us_VID"), true);
  });

  it("does not advance the cursor past a video whose media is still missing", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "video-pending",
          timestamp: 1704067260,
          from: "120363012345@g.us",
          participant: "5491111111111@lid",
          hasMedia: true,
          media: { url: null, mimetype: "video/mp4", filename: null },
          _data: { filename: "ajustesfacturacion.mp4", type: "video" },
        },
        {
          id: "later-text",
          timestamp: 1704067320,
          from: "120363012345@g.us",
          participant: "5491111111111@lid",
          body: "despues",
        },
      ],
      refetchMedia: async () => ({ url: null, mimetype: "video/mp4", filename: "ajustesfacturacion.mp4", error: null }),
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, false);
    assert.equal(harness.posts.length, 0);
    assert.equal(harness.cursor.value?.lastTimestamp, 1_704_067_200_000);
    assert.equal(harness.cursor.value?.mediaHolds?.["video-pending"], 1);
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("later-text"), false);
  });

  it("sends download_failed after the video has been held for three cycles", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "video-pending",
          timestamp: 1704067260,
          from: "120363012345@g.us",
          participant: "5491111111111@lid",
          hasMedia: true,
          media: { url: null, mimetype: "video/mp4", filename: null, error: "not ready" },
          _data: { type: "video", filename: "ajustesfacturacion.mp4" },
        },
      ],
      refetchMedia: async () => null,
    });
    harness.cursor.value = {
      lastTimestamp: 1_704_067_200_000,
      seenIdsAtTimestamp: [],
      mediaHolds: { "video-pending": 2 },
    };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, true);
    const message = harness.posts[0]?.messages[0];
    assert.equal(message?.transcript, null);
    assert.equal(message?.data_base64, null);
    assert.equal(message?.mime_type, "video/mp4");
    assert.equal(message?.file_name, "ajustesfacturacion.mp4");
    assert.match(message?.note ?? "", /^download_failed: /);
    assert.equal(harness.cursor.value?.mediaHolds, undefined);
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("video-pending"), true);
  });

  it("sends transcription_failed with the known file name when ffmpeg or whisper throws", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "clip",
          timestamp: 1704067260,
          participant: "5491111111111@lid",
          from: "120363012345@g.us",
          hasMedia: true,
          media: { url: "http://waha:3000/api/files/clip.mp4", mimetype: "video/mp4", filename: "ajustesfacturacion.mp4" },
        },
      ],
      extractAudio: async () => {
        throw new Error("ffmpeg exited 1");
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    const result = await runCycle(harness.deps);
    assert.equal(result.sent, true);
    const message = harness.posts[0]?.messages[0];
    assert.equal(message?.transcript, null);
    assert.equal(message?.mime_type, "video/mp4");
    assert.equal(message?.file_name, "ajustesfacturacion.mp4");
    assert.equal(message?.note, "transcription_failed: ffmpeg exited 1");
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("clip"), true);
  });

  it("marks an oversized video too_large and still keeps the file name", async () => {
    const harness = deps({
      listMessages: async () => [
        {
          id: "huge",
          timestamp: 1704067260,
          from: "120363012345@g.us",
          participant: "5491111111111@c.us",
          hasMedia: true,
          media: { url: "http://waha:3000/api/files/huge.mp4", mimetype: "video/mp4", filename: "huge.mp4" },
        },
      ],
      download: async () => {
        throw new MediaTooLargeError(40 * 1024 * 1024, 25 * 1024 * 1024);
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    await runCycle(harness.deps);
    const message = harness.posts[0]?.messages[0];
    assert.equal(message?.note, "too_large");
    assert.equal(message?.mime_type, "video/mp4");
    assert.equal(message?.file_name, "huge.mp4");
    assert.equal(message?.transcript, null);
    assert.equal(harness.cursor.value?.seenIdsAtTimestamp.includes("huge"), true);
  });

  it("inlines a pdf as base64 plus extracted text, and does not advance the cursor when the webhook fails", async () => {
    const seen: WebhookPayload[] = [];
    const harness = deps({
      listMessages: async () => [
        {
          id: "doc",
          timestamp: 1704067260,
          participant: "5491111111111@c.us",
          from: "120363012345@g.us",
          body: "adjunto",
          hasMedia: true,
          media: { url: "http://waha:3000/api/files/spec.pdf", mimetype: "application/pdf", filename: "spec.pdf" },
        },
      ],
      postWebhook: async (payload) => {
        seen.push(payload);
        throw new Error("webhook down");
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    await assert.rejects(() => runCycle(harness.deps), /webhook down/);
    assert.equal(seen[0]?.messages[0]?.mime_type, "application/pdf");
    assert.equal(seen[0]?.messages[0]?.file_name, "spec.pdf");
    assert.equal(seen[0]?.messages[0]?.data_base64, Buffer.from("file").toString("base64"));
    assert.equal(seen[0]?.messages[0]?.note, null);
    assert.equal(seen[0]?.messages[0]?.text, "adjunto\n\npdf #plataforma");
    assert.equal(seen[0]?.repo, "jreyessn/plataforma_tm");
    assert.deepEqual(harness.cursor.value, { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] });
  });

  it("sends an oversized image without bytes and with note too_large", async () => {
    let extracted = false;
    const harness = deps({
      listMessages: async () => [
        {
          id: "big",
          timestamp: 1704067260,
          participant: "5491111111111@c.us",
          from: "120363012345@g.us",
          hasMedia: true,
          media: { url: "http://waha:3000/api/files/photo.jpg", mimetype: "image/jpeg", filename: "photo.jpg" },
        },
      ],
      download: async () => {
        throw new MediaTooLargeError(9 * 1024 * 1024, 5 * 1024 * 1024);
      },
      extractPdfText: async () => {
        extracted = true;
        return "no";
      },
    });
    harness.cursor.value = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: [] };
    await runCycle(harness.deps);
    const message = harness.posts[0]?.messages[0];
    assert.equal(message?.type, "image");
    assert.equal(message?.mime_type, "image/jpeg");
    assert.equal(message?.file_name, "photo.jpg");
    assert.equal(message?.data_base64, null);
    assert.equal(message?.note, "too_large");
    assert.equal(extracted, false);
  });

  it("persists the cursor as json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wa-cursor-"));
    const store = new JsonCursorStore(join(dir, "cursor.json"));
    await store.save({ lastTimestamp: 10, seenIdsAtTimestamp: ["a"] });
    const loaded = await store.load();
    assert.deepEqual(loaded, { lastTimestamp: 10, seenIdsAtTimestamp: ["a"] });
    const raw = await readFile(join(dir, "cursor.json"), "utf8");
    assert.equal(raw.includes("\"lastTimestamp\":10"), true);
  });
});
