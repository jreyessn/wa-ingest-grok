import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  advanceCursor,
  kindFromMime,
  normalizeJid,
  parseWahaMessage,
  selectNewMessages,
  timestampToUnixMs,
} from "../src/parse/messages.ts";

const GROUP = "120363012345@g.us";

describe("parseWahaMessage", () => {
  it("keeps text, author, ISO timestamp, and reply id", () => {
    const parsed = parseWahaMessage({
      id: "false_120363012345@g.us_AAAA",
      timestamp: 1704067200,
      from: GROUP,
      fromMe: false,
      participant: "5491111111111@c.us",
      body: "hola #plataforma",
      hasMedia: false,
      replyTo: {
        id: "false_120363012345@g.us_BBBB",
        participant: "5492222222222@c.us",
        body: "orig",
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.type, "text");
    assert.equal(parsed.author, "5491111111111@c.us");
    assert.equal(parsed.timestamp, "2024-01-01T00:00:00.000Z");
    assert.equal(parsed.text, "hola #plataforma");
    assert.equal(parsed.replyTo, "false_120363012345@g.us_BBBB");
    assert.equal(parsed.media, null);
  });

  it("reads the sender from GOWS _data and normalizes @s.whatsapp.net", () => {
    const parsed = parseWahaMessage({
      id: "msg-gows",
      timestamp: 1704067200.5,
      from: GROUP,
      body: "desde gows",
      _data: { Info: { Sender: "5492222222222@s.whatsapp.net", PushName: "Ana" } },
    });
    assert.ok(parsed);
    assert.equal(parsed.author, "5492222222222@c.us");
    assert.equal(parsed.timestamp, "2024-01-01T00:00:00.500Z");
    assert.equal(normalizeJid("5492222222222@s.whatsapp.net"), "5492222222222@c.us");
  });

  it("reads the Baileys participant and falls back to me", () => {
    const fromKey = parseWahaMessage({
      id: "msg-key",
      timestamp: 1704067200,
      from: GROUP,
      body: "key",
      _data: { key: { participant: "5493333333333@s.whatsapp.net" } },
    });
    assert.equal(fromKey?.author, "5493333333333@c.us");

    const mine = parseWahaMessage({
      id: "msg-me",
      timestamp: 1704067200,
      from: GROUP,
      fromMe: true,
      body: "yo",
    });
    assert.equal(mine?.author, "me");
  });

  it("classifies voice notes, video, images, and pdfs from the media mimetype", () => {
    const audio = parseWahaMessage({
      id: "ptt",
      timestamp: 1704067200,
      from: "5491111111111@c.us",
      hasMedia: true,
      body: "",
      media: { url: "http://waha:3000/api/files/a.ogg", mimetype: "audio/ogg; codecs=opus", filename: null },
    });
    assert.equal(audio?.type, "audio");
    assert.equal(audio?.text, null);
    assert.equal(audio?.media?.mimetype, "audio/ogg; codecs=opus");

    const video = parseWahaMessage({
      id: "vid",
      timestamp: 1704067200,
      participant: "5491111111111@c.us",
      from: GROUP,
      hasMedia: true,
      media: { url: "http://waha:3000/api/files/a.mp4", mimetype: "video/mp4", filename: "clip.mp4" },
    });
    assert.equal(video?.type, "video");
    assert.equal(video?.media?.filename, "clip.mp4");

    const image = parseWahaMessage({
      id: "img",
      timestamp: 1704067200,
      participant: "5491111111111@c.us",
      from: GROUP,
      hasMedia: true,
      body: "mira",
      media: { url: "http://waha:3000/api/files/a.jpg", mimetype: "image/jpeg", filename: null },
    });
    assert.equal(image?.type, "image");
    assert.equal(image?.text, "mira");

    const pdf = parseWahaMessage({
      id: "pdf",
      timestamp: 1704067200,
      participant: "5491111111111@c.us",
      from: GROUP,
      hasMedia: true,
      media: { url: "http://waha:3000/api/files/a.pdf", mimetype: "application/pdf", filename: "spec.pdf" },
    });
    assert.equal(pdf?.type, "document");
    assert.equal(pdf?.media?.filename, "spec.pdf");
  });

  it("treats other files as documents and keeps a location as raw text", () => {
    assert.equal(kindFromMime("application/zip", "notes.zip", true), "document");
    assert.equal(kindFromMime(null, "report.PDF", true), "document");
    const location = parseWahaMessage({
      id: "loc",
      timestamp: "1704067200",
      from: "5491111111111@c.us",
      location: { latitude: -34.6, longitude: -58.38 },
    });
    assert.equal(location?.type, "text");
    assert.equal(location?.text, "-34.6,-58.38");
    assert.equal(timestampToUnixMs("1704067200"), 1704067200000);
  });

  it("reads WEBJS ids and senders stored as _serialized objects", () => {
    const parsed = parseWahaMessage({
      id: {
        fromMe: false,
        remote: "120363012345@g.us",
        id: "AAAA",
        _serialized: "false_120363012345@g.us_AAAA",
      },
      timestamp: 1704067200,
      from: { server: "g.us", user: "120363012345", _serialized: GROUP },
      participant: { _serialized: "5491111111111@s.whatsapp.net" },
      body: "desde webjs",
      replyTo: { id: { _serialized: "false_120363012345@g.us_BBBB" } },
    });
    assert.ok(parsed);
    assert.equal(parsed.id, "false_120363012345@g.us_AAAA");
    assert.equal(parsed.author, "5491111111111@c.us");
    assert.equal(parsed.replyTo, "false_120363012345@g.us_BBBB");
    assert.equal(parsed.text, "desde webjs");
  });

  it("keeps a WEBJS video whose file url is not ready yet", () => {
    const parsed = parseWahaMessage({
      id: "false_120363012345@g.us_VID",
      timestamp: 1704067260,
      from: GROUP,
      participant: "5491111111111@lid",
      hasMedia: true,
      body: "",
      media: { url: null, mimetype: "video/mp4", filename: null, error: null },
      _data: { type: "video", mimetype: "video/mp4", filename: "ajustesfacturacion.mp4" },
    });
    assert.ok(parsed);
    assert.equal(parsed.type, "video");
    assert.equal(parsed.author, "5491111111111@lid");
    assert.equal(parsed.media?.url, null);
    assert.equal(parsed.media?.mimetype, "video/mp4");
    assert.equal(parsed.media?.filename, "ajustesfacturacion.mp4");
  });

  it("drops objects that are not messages", () => {
    assert.equal(parseWahaMessage(null), null);
    assert.equal(parseWahaMessage({ body: "no id" }), null);
    assert.equal(parseWahaMessage({ id: "x" }), null);
  });
});

describe("cursor selection", () => {
  const cursor = { lastTimestamp: 1_704_067_200_000, seenIdsAtTimestamp: ["a"] };

  it("skips the processed id and keeps later messages plus unseen ids at the same timestamp", () => {
    const selected = selectNewMessages(
      [
        { id: "a", timestampUnixMs: 1_704_067_200_000 },
        { id: "b", timestampUnixMs: 1_704_067_200_000 },
        { id: "old", timestampUnixMs: 1_704_067_199_000 },
        { id: "c", timestampUnixMs: 1_704_067_201_000 },
      ],
      cursor,
    );
    assert.deepEqual(
      selected.map((message) => message.id),
      ["b", "c"],
    );
  });

  it("advances to the newest timestamp and remembers every id at that timestamp", () => {
    const next = advanceCursor(cursor, [
      { id: "b", timestampUnixMs: 1_704_067_200_000 },
      { id: "c", timestampUnixMs: 1_704_067_205_000 },
      { id: "d", timestampUnixMs: 1_704_067_205_000 },
    ]);
    assert.equal(next.lastTimestamp, 1_704_067_205_000);
    assert.deepEqual(next.seenIdsAtTimestamp, ["c", "d"]);
  });

  it("keeps media holds for messages that were not accepted", () => {
    const next = advanceCursor(
      { lastTimestamp: 1, seenIdsAtTimestamp: [], mediaHolds: { video: 1, done: 2 } },
      [{ id: "done", timestampUnixMs: 5 }],
    );
    assert.equal(next.lastTimestamp, 5);
    assert.deepEqual(next.mediaHolds, { video: 1 });
  });

  it("keeps older ids when the newest timestamp does not move", () => {
    const next = advanceCursor(cursor, [{ id: "b", timestampUnixMs: cursor.lastTimestamp }]);
    assert.deepEqual(next.seenIdsAtTimestamp, ["a", "b"]);
  });
});
