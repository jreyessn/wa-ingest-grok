import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWahaMessage } from "../src/parse/messages.ts";
import { sessionForLogin } from "../src/session.ts";
import { WahaClient, resolveMediaUrl } from "../src/waha/client.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

describe("listGroups", () => {
  it("reads an object keyed by id, serialized ids, and name or subject", async () => {
    const urls: string[] = [];
    const client = new WahaClient("http://waha:3000", "default", undefined, async (input) => {
      urls.push(String(input));
      return json({
        "1203631@g.us": {
          id: { server: "g.us", user: "1203631", _serialized: "1203631@g.us" },
          name: "From name",
        },
        "1203632@g.us": {
          id: "1203632@g.us",
          subject: "From subject",
        },
        "1203633@g.us": {
          id: { server: "g.us", user: "1203633", _serialized: "1203633@g.us" },
          groupMetadata: { subject: "From metadata" },
        },
        "1203634@g.us": {
          groupMetadata: { subject: "From key" },
        },
      });
    });

    const groups = await client.listGroups();
    assert.deepEqual(groups, [
      { id: "1203631@g.us", name: "From name" },
      { id: "1203632@g.us", name: "From subject" },
      { id: "1203633@g.us", name: "From metadata" },
      { id: "1203634@g.us", name: "From key" },
    ]);
    assert.equal(urls.length, 1);
    assert.match(urls[0] ?? "", /\/api\/default\/groups\?/);
  });

  it("keeps an array of groups", async () => {
    const client = new WahaClient("http://waha:3000", "default", undefined, async () =>
      json([{ id: "1203635@g.us", subject: "Array group" }]),
    );
    assert.deepEqual(await client.listGroups(), [{ id: "1203635@g.us", name: "Array group" }]);
  });

  it("falls back to chats and keeps only @g.us when groups yields nothing", async () => {
    const urls: string[] = [];
    const client = new WahaClient("http://waha:3000", "default", undefined, async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/groups?")) return json({});
      return json([
        { id: "5491111111111@c.us", name: "Ana" },
        { id: { _serialized: "1203639@g.us" }, name: "From chats" },
        { id: "1203638@g.us", groupMetadata: { subject: "Meta chat" } },
      ]);
    });

    assert.deepEqual(await client.listGroups(), [
      { id: "1203639@g.us", name: "From chats" },
      { id: "1203638@g.us", name: "Meta chat" },
    ]);
    assert.match(urls[0] ?? "", /\/groups\?/);
    assert.match(urls[1] ?? "", /\/chats\?/);
  });
});

describe("listMessages", () => {
  it("reads a map of messages whose ids are serialized objects", async () => {
    const client = new WahaClient("http://waha:3000", "default", undefined, async () =>
      json({
        "false_120363012345@g.us_AAAA": {
          id: {
            fromMe: false,
            remote: "120363012345@g.us",
            id: "AAAA",
            _serialized: "false_120363012345@g.us_AAAA",
          },
          timestamp: 1704067200,
          from: "120363012345@g.us",
          participant: { _serialized: "5491111111111@c.us" },
          body: "hola",
        },
        "false_120363012345@g.us_CCCC": {
          id: { fromMe: false, remote: "120363012345@g.us", id: "CCCC" },
          timestamp: 1704067201,
          from: "120363012345@g.us",
          body: "sin serialized",
        },
      }),
    );

    const messages = await client.listMessages("120363012345@g.us", 1704067200);
    assert.deepEqual(
      messages.map((message) => parseWahaMessage(message)?.id),
      ["false_120363012345@g.us_AAAA", "false_120363012345@g.us_CCCC"],
    );
  });
});

describe("sessionForLogin", () => {
  it("stops and starts a FAILED session before returning the new status", async () => {
    const calls: string[] = [];
    const client = new WahaClient("http://waha:3000", "default", "secret", async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      assert.equal(new Headers(init?.headers).get("X-Api-Key"), "secret");
      if (url.pathname.endsWith("/stop")) return json({ name: "default", status: "STOPPED" });
      if (url.pathname.endsWith("/start")) return json({ name: "default", status: "STARTING" });
      const gets = calls.filter((call) => call.startsWith("GET ")).length;
      if (gets === 1) return json({ name: "default", status: "FAILED" });
      return json({ name: "default", status: "SCAN_QR_CODE" });
    });

    const session = await sessionForLogin(client);
    assert.equal(session.status, "SCAN_QR_CODE");
    assert.deepEqual(calls, [
      "GET /api/sessions/default",
      "POST /api/sessions/default/stop",
      "GET /api/sessions/default",
      "POST /api/sessions/default/start",
      "GET /api/sessions/default",
    ]);
  });

  it("stops and starts a STOPPED session", async () => {
    const calls: string[] = [];
    const client = new WahaClient("http://waha:3000", "default", undefined, async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname.endsWith("/stop") || url.pathname.endsWith("/start")) return json({});
      const gets = calls.filter((call) => call.startsWith("GET ")).length;
      if (gets === 1) return json({ name: "default", status: "STOPPED" });
      return json({ name: "default", status: "SCAN_QR_CODE" });
    });

    const session = await sessionForLogin(client);
    assert.equal(session.status, "SCAN_QR_CODE");
    assert.equal(calls[1], "POST /api/sessions/default/stop");
    assert.ok(calls.includes("POST /api/sessions/default/start"));
  });

  it("leaves a WORKING session running", async () => {
    const calls: string[] = [];
    const client = new WahaClient("http://waha:3000", "default", undefined, async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);
      return json({ name: "default", status: "WORKING" });
    });
    const session = await sessionForLogin(client);
    assert.equal(session.status, "WORKING");
    assert.deepEqual(calls, ["GET /api/sessions/default"]);
  });
});
