import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveMediaUrl } from "../src/waha/client.ts";

describe("resolveMediaUrl", () => {
  it("rewrites WAHA file URLs onto the configured base URL", () => {
    assert.equal(
      resolveMediaUrl("http://localhost:3000/api/files/voice.ogg", "http://waha:3000"),
      "http://waha:3000/api/files/voice.ogg",
    );
    assert.equal(
      resolveMediaUrl("http://waha:3000/api/files/a.jpg?x=1", "http://waha:3000"),
      "http://waha:3000/api/files/a.jpg?x=1",
    );
  });

  it("leaves non-file URLs alone", () => {
    assert.equal(
      resolveMediaUrl("https://cdn.example/file.pdf", "http://waha:3000"),
      "https://cdn.example/file.pdf",
    );
  });
});
