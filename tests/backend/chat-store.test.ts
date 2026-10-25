import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ChatBusy, ChatReplayConflict, DurableChatStore } from "../../backend/src/chatStore";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t: { after: (fn: () => void) => void }, overrides: Partial<ConstructorParameters<typeof DurableChatStore>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smile-chat-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "chat.db");
  return { file, store: new DurableChatStore({ file, pollMs: 5, ...overrides }) };
}

test("persists complete room state and original private result across new store instances", async (t) => {
  const { file, store } = fixture(t);
  const request = { id: "message-1", payloadHash: hash("same-message") };
  const room = { messages: ["hello"], memory: [["alice", { zip: "61401", includeSelfDrive: false, travelerBudgetCents: 22000, requirements: "arrive by 10 PM", ownMessages: ["first answer", "follow-up answer"] }]], plans: [["alice", { eventKey: "event", mode: "train" }]], listings: [["event", { name: "Test event", city: "Chicago" }]] };
  let calls = 0;
  const output = await store.transact("group", () => room, async (state) => {
    calls++;
    state.messages.push("reply");
    return { replies: [{ id: "reply-1", text: "A route is ready.", approvalPath: "/desk#approve=original-token&trip=trip-1" }] };
  }, request);
  const restarted = new DurableChatStore({ file });
  const replay = await restarted.transact("group", () => room, async () => { calls++; return { replies: [] }; }, request);
  assert.equal(calls, 1);
  assert.deepEqual(replay, output);
  assert.deepEqual(restarted.read("group").state, room);
  assert.equal(restarted.read("group").busy, false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("serializes concurrent duplicate messages across independent connections and calls the brain once", async (t) => {
  const { file, store } = fixture(t, { leaseMs: 150 });
  const other = new DurableChatStore({ file, leaseMs: 150, pollMs: 5 });
  const request = { id: "message-2", payloadHash: hash("payload") };
  let calls = 0;
  const run = async (state: { count: number }) => {
    calls++;
    state.count++;
    await pause(220);
    return { reply: "same reply", approvalPath: "original-private-path" };
  };
  const [a, b] = await Promise.all([store.transact("group", () => ({ count: 0 }), run, request), other.transact("group", () => ({ count: 0 }), run, request)]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.deepEqual(store.read("group").state, { count: 1 });
});

test("serializes different messages within one room without blocking other rooms", async (t) => {
  const { store } = fixture(t);
  const first = store.transact("group", () => ({ order: [] as string[] }), async (state) => { state.order.push("first"); await pause(40); return "first"; });
  const second = store.transact("group", () => ({ order: [] as string[] }), async (state) => { state.order.push("second"); return "second"; });
  await store.transact("different-group", () => ({ own: true }), async (state) => state.own);
  assert.equal(store.read("group").busy, true);
  await Promise.all([first, second]);
  assert.deepEqual(store.read("group").state, { order: ["first", "second"] });
  assert.deepEqual(store.read("different-group").state, { own: true });
});

test("rejects a reused identity with changed payload without changing history", async (t) => {
  const { store } = fixture(t);
  await store.transact("group", () => ({ count: 0 }), async (state) => ++state.count, { id: "same-id", payloadHash: hash("a") });
  await assert.rejects(store.transact("group", () => ({ count: 0 }), async (state) => ++state.count, { id: "same-id", payloadHash: hash("b") }), ChatReplayConflict);
  assert.deepEqual(store.read("group").state, { count: 1 });
});

test("rolls back failed processing and retries cleanly instead of saving partial memory", async (t) => {
  const { store } = fixture(t);
  const request = { id: "retry", payloadHash: hash("retry") };
  await assert.rejects(store.transact("group", () => ({ messages: [] as string[] }), async (state) => { state.messages.push("partial"); throw new Error("interrupted"); }, request), /interrupted/);
  assert.equal(store.read("group").state, undefined);
  const restarted = new DurableChatStore({ file: store.file });
  await assert.rejects(restarted.transact("group", () => ({}), async () => "wrong sender or text", { ...request, payloadHash: hash("changed after crash") }), ChatReplayConflict);
  const output = await store.transact("group", () => ({ messages: [] as string[] }), async (state) => { state.messages.push("complete"); return "saved"; }, request);
  assert.equal(output, "saved");
  assert.deepEqual(store.read("group").state, { messages: ["complete"] });
});

test("recovers an expired process lease and fences the previous owner", async (t) => {
  const { file, store } = fixture(t);
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO chat_room_locks (room_id, owner, expires_at) VALUES (?, ?, ?)").run("group", "crashed-process", Date.now() - 1);
  db.close();
  assert.equal(await store.transact("group", () => ({ recovered: true }), async () => "recovered"), "recovered");
  assert.equal(store.read("group").busy, false);
  await assert.rejects(store.transact("fenced", () => ({ partial: true }), async () => {
    const competing = new DatabaseSync(file);
    competing.prepare("UPDATE chat_room_locks SET owner = ?, expires_at = ? WHERE room_id = ?").run("replacement-process", Date.now() + 60_000, "fenced");
    competing.close();
    return "stale result";
  }), ChatBusy);
  assert.equal(store.read("fenced").state, undefined);
});

test("fails closed for live leases, prevents reset during processing and keeps replay receipts after reset", async (t) => {
  const { file, store } = fixture(t, { waitMs: 15 });
  const db = new DatabaseSync(file);
  db.prepare("INSERT INTO chat_room_locks (room_id, owner, expires_at) VALUES (?, ?, ?)").run("busy", "active-process", Date.now() + 60_000);
  db.close();
  await assert.rejects(store.transact("busy", () => ({}), async () => "bad"), ChatBusy);
  assert.throws(() => store.reset("busy"), ChatBusy);
  const request = { id: "old", payloadHash: hash("old") };
  await store.transact("group", () => ({ saved: true }), async () => "original", request);
  store.reset("group");
  assert.equal(store.read("group").state, undefined);
  assert.equal(await store.transact("group", () => ({}), async () => "duplicate", request), "original");
});

test("rejects unsafe storage and malformed replay identities", async (t) => {
  assert.throws(() => new DurableChatStore({ file: ":memory:" }), /durable database/);
  assert.throws(() => new DurableChatStore({ file: "relative.db" }), /durable database/);
  const { store } = fixture(t);
  await assert.rejects(store.transact("group", () => ({}), async () => ({}), { id: "message", payloadHash: "not-a-sha256" }), /payload hash/);
});
