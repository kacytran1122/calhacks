import assert from "node:assert/strict";
import test from "node:test";
import { messageFrom, textOf } from "../../backend/photon/index";

test("extracts Photon 2.0 plain text and group text", () => {
  assert.equal(textOf({ type: "text", format: "plain", text: "@smile 95616" }), "@smile 95616");
  assert.equal(textOf({ type: "group", parts: [{ type: "text", format: "plain", text: "hello" }, { type: "text", format: "markdown", text: "ignored" }] }), "hello");
  assert.equal(textOf({ type: "attachment" }), undefined);
});

test("accepts only received human-to-agent iMessages", () => {
  const base = {
    id: "evt_1", type: "message.received", source: "imessage.photon",
    data: { object: { id: "msg_1", platform: "imessage", status: "received", content: { type: "text", format: "plain", text: "@smile" }, sentBy: { id: "human", kind: "human", platform: "imessage" }, receivedBy: { id: "agent", kind: "agent", platform: "imessage" }, space: { id: "space", kind: "group", platform: "imessage" } } },
  };
  assert.equal(messageFrom(base)?.id, "msg_1");
  assert.equal(messageFrom({ ...base, type: "message.delivered" }), undefined);
});
