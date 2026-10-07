import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWebhookHeader, parseRepoAliases } from "../src/config.ts";
import { batchIdFor, buildPayload, detectRepo, type OutboundMessage } from "../src/payload/format.ts";

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    id: "m1",
    author: "5491111111111@c.us",
    timestamp: "2024-01-01T00:00:00.000Z",
    type: "text",
    text: "hola",
    transcript: null,
    file_url: null,
    file_name: null,
    reply_to: null,
    ...overrides,
  };
}

const aliases = parseRepoAliases("#plataforma=jreyessn/plataforma_tm,#otro=acme/otro");

describe("buildPayload", () => {
  it("formats a whatsapp batch and leaves repo unset when no alias matches", () => {
    const payload = buildPayload({
      group: "120363012345@g.us",
      messages: [message({ reply_to: "m0" })],
      aliases,
    });
    assert.ok(payload);
    assert.equal(payload.source, "whatsapp");
    assert.equal(payload.group, "120363012345@g.us");
    assert.equal("repo" in payload, false);
    assert.equal(payload.messages.length, 1);
    assert.deepEqual(payload.messages[0], message({ reply_to: "m0" }));
    assert.equal(payload.batch_id, batchIdFor("120363012345@g.us", ["m1"]));
  });

  it("sets repo from the first alias found in message text", () => {
    const payload = buildPayload({
      group: "g",
      messages: [
        message({ id: "1", text: "sin alias" }),
        message({ id: "2", text: "ver #plataforma por favor", transcript: "spoken #otro" }),
      ],
      aliases,
    });
    assert.equal(payload?.repo, "jreyessn/plataforma_tm");
  });

  it("does not treat a transcript as text when matching aliases", () => {
    assert.equal(detectRepo([message({ text: null, transcript: "dije #plataforma" })], aliases), undefined);
    const payload = buildPayload({
      group: "g",
      messages: [message({ text: null, transcript: "dije #plataforma" })],
      aliases,
    });
    assert.equal(payload?.repo, undefined);
    assert.equal(payload && "repo" in payload, false);
  });

  it("uses extracted pdf text, which lives in the text field", () => {
    const payload = buildPayload({
      group: "g",
      messages: [
        message({
          type: "document",
          text: "caption\n\nbody #otro",
          file_url: "https://files.example/spec.pdf",
          file_name: "spec.pdf",
        }),
      ],
      aliases,
    });
    assert.equal(payload?.repo, "acme/otro");
    assert.equal(payload?.messages[0]?.file_url, "https://files.example/spec.pdf");
  });

  it("returns null when there is nothing to send", () => {
    assert.equal(buildPayload({ group: "g", messages: [], aliases }), null);
  });

  it("builds a batch id that depends on the ids and not their order", () => {
    const left = batchIdFor("g", ["b", "a"]);
    const right = batchIdFor("g", ["a", "b"]);
    assert.equal(left, right);
    assert.notEqual(left, batchIdFor("g", ["a", "c"]));
    assert.notEqual(left, batchIdFor("other", ["a", "b"]));
  });
});

describe("webhook header", () => {
  it("defaults to Authorization Bearer", () => {
    assert.deepEqual(buildWebhookHeader(undefined, "secret"), {
      name: "Authorization",
      value: "Bearer secret",
    });
    assert.deepEqual(buildWebhookHeader("Authorization: Bearer ${GROKBOT_WEBHOOK_KEY}", "secret"), {
      name: "Authorization",
      value: "Bearer secret",
    });
  });

  it("accepts a custom header template or a bare header name", () => {
    assert.deepEqual(buildWebhookHeader("X-Webhook-Token: ${GROKBOT_WEBHOOK_KEY}", "k"), {
      name: "X-Webhook-Token",
      value: "k",
    });
    assert.deepEqual(buildWebhookHeader("X-Api-Key", "k"), { name: "X-Api-Key", value: "k" });
  });
});

describe("parseRepoAliases", () => {
  it("parses comma-separated alias=repo pairs and rejects broken entries", () => {
    assert.deepEqual(parseRepoAliases(" #plataforma=jreyessn/plataforma_tm , #otro=acme/otro "), aliases);
    assert.deepEqual(parseRepoAliases("  "), []);
    assert.throws(() => parseRepoAliases("no-equals"), /REPO_ALIASES/);
  });
});
