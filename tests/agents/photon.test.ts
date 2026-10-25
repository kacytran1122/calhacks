import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { assertPhoton2Credentials, configuration, mentionsSmile, messageFrom, textOf } from "../../backend/photon/index";

test("requires Photon 2.0 project credentials", () => {
  assert.doesNotThrow(() => assertPhoton2Credentials("pho_prj_example", "pho_sk_example"));
  assert.throws(() => assertPhoton2Credentials("0c831622-1b06-4b77-917b-3aee8e7e8aa7", "pho_sk_example"), /Spectrum UUIDs/);
  assert.throws(() => assertPhoton2Credentials("pho_prj_example", "legacy-secret"), /Spectrum project secrets/);
});

test("extracts Photon 2.0 plain text and group text", () => {
  assert.equal(textOf({ type: "text", format: "plain", text: "@smile 95616" }), "@smile 95616");
  assert.equal(textOf({ type: "group", parts: [{ type: "text", format: "plain", text: "hello" }, { type: "text", format: "markdown", text: "ignored" }] }), "hello");
  assert.equal(textOf({ type: "attachment" }), undefined);
});

test("accepts only received human-to-agent direct iMessages", () => {
  const base = {
    id: "evt_1", type: "message.received", source: "imessage.photon",
    data: { object: { id: "msg_1", platform: "imessage", status: "received", content: { type: "text", format: "plain", text: "@smile" }, sentBy: { id: "human", kind: "human", platform: "imessage" }, receivedBy: { id: "agent", kind: "agent", platform: "imessage" }, space: { id: "space", kind: "direct", platform: "imessage" } } },
  };
  assert.equal(messageFrom(base)?.id, "msg_1");
  assert.equal(messageFrom({ ...base, type: "message.delivered" }), undefined);
  assert.equal(messageFrom({ ...base, data: { object: { ...base.data.object, space: { ...base.data.object.space, kind: "group" } } } }), undefined);
});

test("recognizes explicit mentions with punctuation and case without waking on names or email", () => {
  for (const text of ["@smile plan our trip", "Hey, @SMILE!", "(@Smile), yes", "Please ask @smile."]) assert.equal(mentionsSmile(text), true, text);
  for (const text of ["smile", "@smiley", "@smile_travel", "hello@smile.com", "@@smile", "@smile2"]) assert.equal(mentionsSmile(text), false, text);
});

test("rejects malformed envelopes and never mistakes agent traffic for an incoming message", () => {
  const message = { id: "msg_1", platform: "imessage", status: "received", content: { type: "text", format: "plain", text: "@smile" }, sentBy: { id: "human", kind: "human", platform: "imessage" }, receivedBy: { id: "agent", kind: "agent", platform: "imessage" }, space: { id: "space", kind: "direct", platform: "imessage" } };
  const envelope = (object: unknown, projectId = "pho_prj_test") => ({ type: "message.received", source: "imessage.photon", data: { projectId, object } });
  for (const invalid of [null, [], {}, { data: null }, envelope(null), envelope({}), envelope({ ...message, sentBy: null }), envelope({ ...message, receivedBy: null }), envelope({ ...message, space: null }), envelope({ ...message, id: "" }), envelope({ ...message, sentBy: { ...message.sentBy, kind: "agent" } }), envelope({ ...message, space: { ...message.space, kind: "group" } }), envelope({ ...message, space: { ...message.space, platform: "sms" } }), envelope({ ...message, content: { type: "text", format: "plain", text: "x".repeat(4_001) } })]) {
    assert.doesNotThrow(() => messageFrom(invalid, "pho_prj_test"));
    assert.equal(messageFrom(invalid, "pho_prj_test"), undefined);
  }
  assert.equal(messageFrom(envelope(message, "pho_prj_other"), "pho_prj_test"), undefined);
  assert.equal(messageFrom(envelope({ ...message, space: { ...message.space, projectId: "pho_prj_other" } }), "pho_prj_test"), undefined);
  assert.equal(messageFrom(envelope(message), "pho_prj_test")?.id, "msg_1");
});

test("bounds nested group content", () => {
  const recursive: { type: string; parts: unknown[] } = { type: "group", parts: [] };
  recursive.parts.push(recursive);
  assert.equal(textOf(recursive), undefined);
});

test("stores the Photon cursor on the configured persistent data volume", () => {
  const values = { SMILE_WEB_URL: "https://smilefromhereto.work", PHOTON_PROJECT_ID: "pho_prj_test", PHOTON_API_KEY: "pho_sk_test", PHOTON_BRIDGE_SECRET: "test-secret", SMILE_DATA_DIR: "/persistent/smile", DATA_DIR: "/persistent/fallback", PHOTON_CURSOR_FILE: undefined };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(configuration().cursorFile, "/persistent/smile/photon-cursor.json");
    delete process.env.SMILE_DATA_DIR;
    assert.equal(configuration().cursorFile, "/persistent/fallback/photon-cursor.json");
    process.env.PHOTON_CURSOR_FILE = "/other-volume/custom.json";
    assert.equal(configuration().cursorFile, "/other-volume/custom.json");
    delete process.env.PHOTON_CURSOR_FILE;
    delete process.env.DATA_DIR;
    assert.equal(configuration().cursorFile, resolve(".data/photon-cursor.json"));
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("refuses to start Photon with any non-canonical website or API origin", () => {
  const values = { SMILE_WEB_URL: "https://smilefromhereto.work", PHOTON_API_ORIGIN: undefined as string | undefined, PHOTON_PROJECT_ID: "pho_prj_test", PHOTON_API_KEY: "pho_sk_test", PHOTON_BRIDGE_SECRET: "test-secret" };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    assert.equal(configuration().webUrl, "https://smilefromhereto.work");
    assert.equal(configuration().apiOrigin, "https://api.photon.codes");
    for (const value of ["http://localhost:3000", "http://127.0.0.1:3000", "http://0.0.0.0:3000", "http://[::1]:3000", "https://smilefromhereto.work/", "https://smilefromhereto.work//", "https://smilefromhereto.work/landing", "https://www.smilefromhereto.work"] ) {
      process.env.SMILE_WEB_URL = value;
      assert.throws(() => configuration(), /SMILE_WEB_URL must be exactly/);
    }
    process.env.SMILE_WEB_URL = "https://smilefromhereto.work";
    for (const value of ["http://localhost:4000", "https://api.photon.codes/", "https://api.photon.codes//"]) {
      process.env.PHOTON_API_ORIGIN = value;
      assert.throws(() => configuration(), /PHOTON_API_ORIGIN must be exactly/);
    }
  } finally {
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
