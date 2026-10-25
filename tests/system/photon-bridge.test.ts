import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smile-photon-bridge-"));
process.env.SMILE_DATA_DIR = dir;
process.env.SMILE_CONCIERGE = "off";
delete process.env.VERCEL;
const { POST } = await import("../../frontend/app/api/chat/photon/route");
const { handleMessage, initialsOf, parseMention, view } = await import("../../frontend/lib/chat");
const { DurableChatStore, chatStore } = await import("../../backend/src/chatStore");
const core = await import("../../backend/src/index");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const body = (overrides: Record<string, unknown> = {}) => ({ projectId: "pho_prj_test", messageId: "message-1", spaceId: "direct-1", senderId: "human-1", text: "@smile hello", ...overrides });
const request = (value: unknown, secret = "test-bridge-secret") => new Request("http://localhost/api/chat/photon", { method: "POST", headers: { "content-type": "application/json", "x-smile-photon-secret": secret }, body: JSON.stringify(value) });
const configure = () => { process.env.PHOTON_BRIDGE_SECRET = "test-bridge-secret"; process.env.PHOTON_PROJECT_ID = "pho_prj_test"; };

test("checks secret before attempting to parse JSON", async () => {
  delete process.env.PHOTON_BRIDGE_SECRET;
  assert.equal((await POST(request(body()))).status, 503);
  configure();
  const unauthorized = new Request("http://localhost/api/chat/photon", { method: "POST", body: "not json" });
  assert.equal((await POST(unauthorized)).status, 401);
  const malformed = new Request("http://localhost/api/chat/photon", { method: "POST", headers: { "x-smile-photon-secret": "test-bridge-secret" }, body: "not json" });
  assert.equal((await POST(malformed)).status, 400);
  delete process.env.PHOTON_PROJECT_ID;
  assert.equal((await POST(request(body()))).status, 503);
  configure();
});

test("requires valid message identity and validates configured project and input sizes", async () => {
  configure();
  for (const value of [null, [], {}, body({ messageId: undefined }), body({ messageId: 9 }), body({ projectId: "legacy-project" }), body({ messageId: "../escape" }), body({ senderId: "\nprivate" }), body({ text: " " })])
    assert.equal((await POST(request(value))).status, 400);
  assert.equal((await POST(request(body({ projectId: "pho_prj_other" })))).status, 403);
  assert.equal((await POST(request(body({ text: "x".repeat(4_001) })))).status, 413);
});

test("only @smile mentions trigger a response including punctuation and case variants", async () => {
  configure();
  const silentSpace = "direct-without-mention";
  for (const text of ["hello everyone", "@smiley hello", "foo@smile.com", "@smile_travel"]) {
    assert.equal(parseMention(text).mentioned, false);
    const response = await POST(request(body({ spaceId: silentSpace, messageId: hash(text), text })));
    assert.deepEqual(await response.json(), { replies: [] });
  }
  const silentRoomId = `photon:${hash(["pho_prj_test", silentSpace])}`;
  assert.equal(view(silentRoomId).messages.length, 0);
  const restarted = new DurableChatStore({ file: path.join(dir, "chat.db") });
  assert.equal(restarted.read(silentRoomId).state, undefined);
  for (const text of ["@smile", "Hi,@SMILE!", "(@smile) hello", "hello @smile."]) {
    assert.equal(parseMention(text).mentioned, true);
    const response = await POST(request(body({ spaceId: "direct-with-mention", messageId: hash(text), text })));
    const result = await response.json();
    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0].text, /home ZIP/);
    assert.equal(result.replies[0].approvalPath, undefined);
  }
});

test("replays identical concurrent deliveries without duplicate transcript and rejects altered payload", async () => {
  configure();
  const value = body({ spaceId: "concurrent", messageId: "repeat", text: "Hi,@smile help" });
  const responses = await Promise.all([POST(request(value)), POST(request(value)), POST(request(value))]);
  const results = await Promise.all(responses.map((response) => response.json()));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  const roomId = `photon:${hash([value.projectId, value.spaceId])}`;
  assert.equal(view(roomId).messages.length, 2);
  assert.equal((await POST(request({ ...value, text: "different @smile text" }))).status, 409);
  assert.equal((await POST(request({ ...value, senderId: "different-person" }))).status, 409);
  assert.equal(view(roomId).messages.length, 2);
});

test("persists sender-only preferences and answers across store restart and keeps private direct chats isolated", async () => {
  configure();
  const first = body({ spaceId: "memory", messageId: "first-answer", text: "@smile my ZIP is 61401, my budget is $220 and I cannot drive" });
  const response = await POST(request(first));
  assert.match((await response.json()).replies[0].text, /event website/);
  await POST(request({ ...first, messageId: "follow-up", text: "@smile I must arrive by 10 PM PST on October 26, 2026" }));
  await POST(request({ ...first, senderId: "another-person", messageId: "different-person", text: "@smile help me too" }));
  const roomId = `photon:${hash([first.projectId, first.spaceId])}`;
  const restarted = new DurableChatStore({ file: path.join(dir, "chat.db") });
  const data = restarted.read<{ memory: [string, { zip?: string; includeSelfDrive?: boolean; travelerBudgetCents?: number; ownMessages?: string[]; requirements?: string }][]; messages: unknown[] }>(roomId).state!;
  const sender = `Traveler ${hash([first.projectId, first.senderId]).slice(0, 24).toUpperCase()}`;
  const memory = new Map(data.memory).get(sender)!;
  assert.equal(memory.zip, "61401");
  assert.equal(memory.includeSelfDrive, false);
  assert.equal(memory.travelerBudgetCents, 22_000);
  assert.equal(memory.ownMessages?.length, 2);
  assert.match(memory.requirements!, /October 26/);
  const otherSender = `Traveler ${hash([first.projectId, "another-person"]).slice(0, 24).toUpperCase()}`;
  assert.equal(new Map(data.memory).get(otherSender)?.zip, undefined);
  assert.notEqual(initialsOf(sender), initialsOf(otherSender));
  const differentDirect = await POST(request({ ...first, spaceId: "different-direct", messageId: "different-direct", text: "@smile help" }));
  assert.match((await differentDirect.json()).replies[0].text, /home ZIP/);
});

test("bounds history while preserving room listings, plans and sender memory", async () => {
  const file = path.join(dir, "bounded.db");
  const store = new DurableChatStore({ file });
  const listing = { key: "event", name: "Test event", url: "https://example.com/event", source: "mlh", kind: "hackathon", fetchedAt: new Date().toISOString(), via: "direct" };
  await store.transact("bounded", () => ({ messages: [], plans: [["person", { initials: "P", eventKey: "event", eventName: "Test event", mode: "train" }]], memory: [["person", { zip: "61401", requirements: "prior answer" }]], listings: [["event", listing]] }), async () => true);
  for (let i = 0; i < 205; i++) await handleMessage("bounded", "person", `ordinary message ${i}`, { store });
  const restarted = new DurableChatStore({ file });
  const data = restarted.read<{ messages: { text: string }[]; plans: unknown[]; memory: unknown[]; listings: unknown[] }>("bounded").state!;
  assert.equal(data.messages.length, 200);
  assert.equal(data.messages[0]!.text, "ordinary message 5");
  assert.equal(data.plans.length, 1);
  assert.equal(data.memory.length, 1);
  assert.deepEqual(data.listings, [["event", listing]]);
});

test("recovers a committed trip after a pre-reply crash without rerunning the agent or planning", async (t) => {
  configure();
  const value = body({ spaceId: "crash-recovery", messageId: "committed-before-reply", text: "@smile my ZIP is 94101, budget $15, no driving, arrive by 10 PM" });
  const roomId = `photon:${hash([value.projectId, value.spaceId])}`;
  const requestId = `photon:${hash([value.projectId, value.spaceId, value.messageId])}`;
  const payloadHash = hash([value.projectId, value.messageId, value.spaceId, value.senderId, value.text]);
  const sender = `Traveler ${hash([value.projectId, value.senderId]).slice(0, 24).toUpperCase()}`;
  let networkCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { networkCalls++; return new Response("unavailable", { status: 503 }); });
  let original: Awaited<ReturnType<typeof core.planTrip>> | undefined;
  await assert.rejects(chatStore().transact(roomId, () => ({ messages: [], plans: [], memory: [], listings: [] }), async () => {
    original = await core.withState((state) => core.planTrip(state, {
      zip: "94101", initials: initialsOf(sender), requestKey: requestId,
      originCoordinates: { lat: 37.78, lon: -122.42 },
      event: { key: "crash-recovery-event", name: "Recovery test event", startsAt: "2030-06-15T17:00:00Z", venue: "Event venue", city: "San Francisco, CA", lat: 37.8, lon: -122.43 },
      includeSelfDrive: true, travelerBudgetCents: 10_000,
    }));
    throw new Error("process stopped before chat commit");
  }, { id: requestId, payloadHash }), /process stopped/);
  assert.ok(original!.routes?.pick);
  assert.equal(view(roomId).messages.length, 0);
  const before = core.loadState();
  assert.equal((await POST(request({ ...value, text: "@smile changed requirements" }))).status, 409);
  assert.equal((await POST(request({ ...value, senderId: "someone-else" }))).status, 409);
  networkCalls = 0;
  const previousConcierge = process.env.SMILE_CONCIERGE;
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.SMILE_CONCIERGE = "on";
  process.env.ANTHROPIC_API_KEY = "test-recovery-must-not-call-network";
  t.after(() => {
    if (previousConcierge === undefined) delete process.env.SMILE_CONCIERGE; else process.env.SMILE_CONCIERGE = previousConcierge;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previousKey;
  });
  const response = await POST(request(value));
  assert.equal(response.status, 200);
  const recovered = await response.json();
  assert.equal(recovered.replies.length, 1);
  assert.match(recovered.replies[0].text, /Recovery test event/);
  assert.match(recovered.replies[0].approvalPath, /\/desk#approve=/);
  const approval = new URL(`http://localhost${recovered.replies[0].approvalPath}`);
  const token = new URLSearchParams(approval.hash.slice(1)).get("approve")!;
  assert.equal(core.travelerForTripToken(token, original!.trip.id), original!.trip.travelerId);
  assert.equal(networkCalls, 0);
  const after = core.loadState();
  assert.equal(after.trips.length, before.trips.length);
  assert.equal(after.travelers.length, before.travelers.length);
  assert.equal(after.mandates.length, before.mandates.length);
  assert.deepEqual(await (await POST(request(value))).json(), recovered);
});

test("never renews a private approval for expired or invalid planning receipts", async () => {
  configure();
  const state = core.loadState();
  const original = Object.values(state.planningReceipts ?? {})[0]!;
  assert.ok(original);
  for (const [index, createdAt] of [new Date(Date.now() - 86_400_001).toISOString(), "invalid", "", new Date(Date.now() + 60_000).toISOString()].entries()) {
    const value = body({ spaceId: "expired-recovery", messageId: `expired-${index}`, text: "@smile please recover my trip" });
    const requestId = `photon:${hash([value.projectId, value.spaceId, value.messageId])}`;
    await core.withState((s) => { (s.planningReceipts ??= {})[createHash("sha256").update(requestId).digest("hex")] = { ...structuredClone(original), createdAt }; });
    const before = core.loadState().trips.length;
    const response = await POST(request(value));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.match(result.replies[0].text, /send a new @smile message/);
    assert.equal(result.replies[0].approvalPath, undefined);
    assert.equal(core.loadState().trips.length, before);
  }
});

test("fails closed on a serverless filesystem instead of silently losing direct chat memory", () => {
  process.env.VERCEL = "1";
  try { assert.throws(() => chatStore(), /persistent chat service/); }
  finally { delete process.env.VERCEL; }
});
