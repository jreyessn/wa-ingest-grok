import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WebhookPayload } from "../src/payload/format.ts";
import { PermanentWebhookError, postWebhook } from "../src/webhook/client.ts";

const payload: WebhookPayload = {
  source: "whatsapp",
  group: "120363012345@g.us",
  batch_id: "abc123",
  messages: [],
};

function response(status: number, body = ""): Response {
  return new Response(body, { status });
}

describe("postWebhook", () => {
  it("posts JSON with the configured header and the batch id as an idempotency key", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    await postWebhook({
      url: "https://example.test/hook",
      payload,
      header: { name: "Authorization", value: "Bearer secret" },
      sleep: async () => {},
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: String(init?.body),
        });
        return response(200, "ok");
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://example.test/hook");
    assert.equal(calls[0]?.headers.get("Authorization"), "Bearer secret");
    assert.equal(calls[0]?.headers.get("Idempotency-Key"), "abc123");
    assert.equal(calls[0]?.headers.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? "{}"), payload);
  });

  it("retries 429 and 5xx with backoff and then succeeds", async () => {
    const statuses = [503, 429, 200];
    const delays: number[] = [];
    await postWebhook({
      url: "https://example.test/hook",
      payload,
      header: { name: "Authorization", value: "Bearer secret" },
      sleep: async (ms) => {
        delays.push(ms);
      },
      fetchImpl: async () => response(statuses.shift() ?? 500),
    });
    assert.deepEqual(delays, [1000, 2000]);
  });

  it("does not retry a permanent client error", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        postWebhook({
          url: "https://example.test/hook",
          payload,
          header: { name: "Authorization", value: "Bearer secret" },
          sleep: async () => {
            throw new Error("should not sleep");
          },
          fetchImpl: async () => {
            calls += 1;
            return response(400, "no");
          },
        }),
      PermanentWebhookError,
    );
    assert.equal(calls, 1);
  });

  it("stops after the attempt budget when the network keeps failing", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        postWebhook({
          url: "https://example.test/hook",
          payload,
          header: { name: "Authorization", value: "Bearer secret" },
          maxAttempts: 3,
          sleep: async () => {},
          fetchImpl: async () => {
            calls += 1;
            throw new Error("socket hang up");
          },
        }),
      /after 3 attempts/,
    );
    assert.equal(calls, 3);
  });
});
