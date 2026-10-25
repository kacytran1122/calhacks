import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type { Photon } from "../../backend/node_modules/@photon-ai/api";
import type { Socket } from "../../backend/node_modules/socket.io-client";
import { processMessage, start, type Config, type PhotonMessage } from "../../backend/photon/index";

type Sent = { path: { id: string }; headers: { "idempotency-key": string }; body: { spaceId: string; senderId: string; parentMessageId?: string; content: { text: string } } };
type BrainBody = { projectId: string; messageId: string; spaceId: string; senderId: string; text: string };
type Reply = { id: string; text: string; approvalPath?: string; mapPath?: string };
const incoming = (id = "msg_1", spaceId = "direct_1", text = "@smile help me travel"): PhotonMessage => ({
  id, platform: "imessage", status: "received", content: { type: "text", format: "plain", text },
  sentBy: { id: "human_1", kind: "human", platform: "imessage" }, receivedBy: { id: "agent_1", kind: "agent", platform: "imessage" },
  space: { id: spaceId, kind: "direct", platform: "imessage" },
});
const eventFor = (message: PhotonMessage, projectId = "pho_prj_test") => ({ id: `evt_${message.id}`, type: "message.received", source: "imessage.photon", data: { projectId, object: message } });

async function fixture(t: TestContext, replies: Reply[] = [{ id: "reply_1", text: "Take the airport train to the venue." }]) {
  const logs: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { logs.push(args); });
  const directory = await mkdtemp(join(tmpdir(), "smile-photon-test-"));
  const calls: BrainBody[] = [];
  const requestTimes: number[] = [];
  const controls: {
    status: number;
    raw?: string;
    beforeResponse?: () => Promise<void>;
    responseFor?: (body: BrainBody) => { status: number; raw: string } | undefined;
  } = { status: 200 };
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/api/chat/photon");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-smile-photon-secret"], "test-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BrainBody;
    calls.push(body);
    requestTimes.push(Date.now());
    await controls.beforeResponse?.();
    const response = controls.responseFor?.(body);
    res.writeHead(response?.status ?? controls.status, { "content-type": "application/json" });
    res.end(response?.raw ?? controls.raw ?? JSON.stringify({ replies }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = { projectId: "pho_prj_test", apiKey: "pho_sk_test", bridgeSecret: "test-secret", webUrl: `http://127.0.0.1:${address.port}`, cursorFile: join(directory, "cursor.json"), apiOrigin: "https://api.photon.codes" };
  const sent: Sent[] = [];
  const effects = new Map<string, Sent>();
  const spaces: unknown[] = [];
  const fail = { count: 0, target: "", idempotencyKey: "", error: undefined as Error | undefined, status: "accepted" };
  const photon = { projects: {
    get: async ({ path }: { path: { projectId: string } }) => { assert.equal(path.projectId, config.projectId); return {}; },
    sendMessage: async (value: Sent) => {
      sent.push(value);
      if (fail.count > 0 && (!fail.target || value.body.spaceId === fail.target) && (!fail.idempotencyKey || value.headers["idempotency-key"] === fail.idempotencyKey)) { fail.count--; throw fail.error ?? new Error("temporary Photon delivery failure"); }
      effects.set(value.headers["idempotency-key"], value);
      return { id: `out_${effects.size}`, status: fail.status };
    },
    createOrGetSpace: async (value: unknown) => { spaces.push(value); return { id: "private_1" }; },
  } } as unknown as Photon;
  return { config, calls, requestTimes, controls, photon, sent, effects, spaces, fail, logs };
}

class FakeSocket extends EventEmitter {
  connected = false;
  connections: number[] = [];
  subscriptions: { startSeq: number; apiVersion: string }[] = [];
  timeout() { return { emit: (_event: string, payload: { startSeq: number; apiVersion: string }, callback: (error: Error | null, result: { ok: boolean }) => void) => { this.subscriptions.push(payload); callback(null, { ok: true }); } }; }
  connect() { this.connected = true; this.connections.push(Date.now()); this.emit("connect"); return this; }
  disconnect() { const wasConnected = this.connected; this.connected = false; if (wasConnected) this.emit("disconnect", "io client disconnect"); return this; }
  deliver(message: PhotonMessage, seq: number) { this.emit("delivery", eventFor(message), { seq, replyExpected: true }); }
}

async function until(check: () => boolean | Promise<boolean>, message = "condition", timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}
const cursorOf = async (config: Config) => JSON.parse(await readFile(config.cursorFile, "utf8")) as { seq: number; projectId: string };
const journalPathFor = (config: Config, projectId = config.projectId) =>
  `${config.cursorFile}.${createHash("sha256").update(projectId).digest("hex").slice(0, 16)}.pending`;
const journalOf = async (config: Config) => JSON.parse(await readFile(journalPathFor(config), "utf8")) as {
  version: number;
  projectId: string;
  deliveries: { seq: number; message: PhotonMessage | null }[];
  deadLetters: { seq: number; messageId?: string; stage: string; status?: number; diagnosticCode?: string }[];
};

test("does not contact the brain or Photon until someone explicitly mentions smile", async (t) => {
  const f = await fixture(t);
  for (const text of ["Can someone plan this?", "smile", "@smiley", "email@smile.com"]) await processMessage(f.photon, f.config, incoming("ordinary", "direct_1", text));
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.spaces.length, 0);
});

test("forwards stable source identity and keeps replies in their original direct iMessage chats", async (t) => {
  const f = await fixture(t);
  await processMessage(f.photon, f.config, incoming("msg_a", "direct_a", "(@SMILE), route please"));
  await processMessage(f.photon, f.config, incoming("msg_b", "direct_b", "Thanks, @smile!"));
  assert.deepEqual(f.calls.map(({ projectId, messageId, spaceId, senderId }) => ({ projectId, messageId, spaceId, senderId })), [
    { projectId: "pho_prj_test", messageId: "msg_a", spaceId: "direct_a", senderId: "human_1" },
    { projectId: "pho_prj_test", messageId: "msg_b", spaceId: "direct_b", senderId: "human_1" },
  ]);
  assert.deepEqual(f.sent.map((message) => [message.body.spaceId, message.body.parentMessageId, message.body.senderId]), [["direct_a", "msg_a", "agent_1"], ["direct_b", "msg_b", "agent_1"]]);
  assert.ok(f.sent.every((message) => message.path.id === "pho_prj_test"));
});

test("sends replies and approval links into the same direct chat without creating another space", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Your trip is ready. Your approval follows.", approvalPath: "/desk#approve=private-token&trip=trip_1" }]);
  await processMessage(f.photon, f.config, incoming());
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.body.spaceId, "direct_1");
  assert.doesNotMatch(f.sent[0]!.body.content.text, /private-token|https?:/);
  assert.equal(f.sent[1]!.body.spaceId, "direct_1");
  assert.match(f.sent[1]!.body.content.text, new RegExp(`${f.config.webUrl}/desk#approve=private-token`));
  assert.deepEqual(f.sent.map((message) => message.headers["idempotency-key"]), ["smile:msg_1:room:0", "smile:msg_1:dm:0"]);
  assert.equal(f.spaces.length, 0);
});

test("delivers a validated opaque map handoff in the same direct chat", async (t) => {
  const token = `phm1_${"a".repeat(43)}`;
  const f = await fixture(t, [{ id: "reply_1", text: "Your route is ready.", mapPath: `/map?handoff=${token}` }]);
  await processMessage(f.photon, f.config, incoming());
  assert.equal(f.sent.length, 2);
  assert.doesNotMatch(f.sent[0]!.body.content.text, /phm1_|https?:/);
  assert.match(f.sent[1]!.body.content.text, new RegExp(`${f.config.webUrl}/map\\?handoff=${token}`));
  assert.match(f.sent[1]!.body.content.text, /expires in 12 hours/i);
  assert.deepEqual(f.sent.map((message) => message.headers["idempotency-key"]), ["smile:msg_1:room:0", "smile:msg_1:map:0"]);
  assert.ok(f.sent.every((message) => message.body.spaceId === "direct_1"));
  assert.equal(f.spaces.length, 0);
});

test("retries partial reply and approval deliveries using exactly the same Photon idempotency keys", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Your plan is ready.", approvalPath: "/desk#approve=token" }]);
  f.fail.count = 1;
  f.fail.idempotencyKey = "smile:msg_1:dm:0";
  await assert.rejects(processMessage(f.photon, f.config, incoming()), /temporary Photon delivery/);
  await processMessage(f.photon, f.config, incoming());
  assert.deepEqual(f.sent.map((value) => value.headers["idempotency-key"]), ["smile:msg_1:room:0", "smile:msg_1:dm:0", "smile:msg_1:room:0", "smile:msg_1:dm:0"]);
  assert.equal(f.effects.size, 2);
  assert.equal(f.calls[0]!.messageId, f.calls[1]!.messageId);
  assert.equal(f.calls[0]!.projectId, f.calls[1]!.projectId);
});

test("does not silently accept a failed or malformed brain response or an off-site approval", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  await assert.rejects(processMessage(f.photon, f.config, incoming()), /bridge 503/);
  f.controls.status = 200;
  for (const raw of [
    "",
    "{}",
    "{\"replies\":[{}]}",
    JSON.stringify({ replies: [{ id: "r", text: "Ready", approvalPath: "https://other.example/approve" }] }),
    JSON.stringify({ replies: [{ id: "r", text: "Ready", mapPath: `https://other.example/map?handoff=phm1_${"a".repeat(43)}` }] }),
    JSON.stringify({ replies: [{ id: "r", text: "Ready", mapPath: `/desk?handoff=phm1_${"a".repeat(43)}` }] }),
    JSON.stringify({ replies: [{ id: "r", text: "Ready", mapPath: "/map?handoff=not-opaque" }] }),
  ]) {
    f.controls.raw = raw;
    await assert.rejects(processMessage(f.photon, f.config, incoming()), /invalid repl|configured website|map handoff/);
  }
  assert.equal(f.sent.length, 0);
});

test("retries a failed first delivery in memory when the durable cursor starts at zero", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 25, retryMaxMs: 100 });

  socket.deliver(incoming("first_after_deploy"), 48_685);
  await until(() => f.calls.length === 1, "initial bridge attempt");
  await assert.rejects(readFile(f.config.cursorFile), /ENOENT/);
  assert.equal(socket.connected, true);
  assert.equal(socket.connections.length, 1);
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [0]);

  f.controls.status = 200;
  await until(async () => {
    try { return (await cursorOf(f.config)).seq === 48_685; } catch { return false; }
  }, "locally retried first delivery");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["first_after_deploy", "first_after_deploy"]);
  assert.equal(f.effects.size, 1);
  assert.equal(socket.connections.length, 1);
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [0]);
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "first delivery cleanup");
});

test("writes an inbound delivery to the durable journal before calling the bridge and clears it only after checkpointing", async (t) => {
  const f = await fixture(t);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  let inspected = 0;
  f.controls.beforeResponse = async () => {
    const journal = await journalOf(f.config);
    assert.equal(journal.version, 1);
    assert.equal(journal.projectId, "pho_prj_test");
    assert.deepEqual(journal.deliveries.map(({ seq }) => seq), [22]);
    const saved = await readFile(journalPathFor(f.config), "utf8");
    assert.doesNotMatch(saved, /private@example\.com|outer-private-metadata|handle|metadata/);
    await assert.rejects(readFile(f.config.cursorFile), /ENOENT/);
    inspected++;
  };
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  const privateMessage = incoming("journal_first");
  privateMessage.sentBy.handle = "private@example.com";
  socket.emit("delivery", { ...eventFor(privateMessage), metadata: "outer-private-metadata" }, { seq: 22, replyExpected: true });
  await until(async () => { try { return (await cursorOf(f.config)).seq === 22; } catch { return false; } }, "journaled delivery checkpoint");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "journal clear after checkpoint");
  assert.equal(inspected, 1);
  assert.equal(f.effects.size, 1);
});

test("journals later deliveries while the head delivery is still retrying", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 50, retryMaxMs: 100 });
  socket.deliver(incoming("blocked_head"), 31);
  socket.deliver(incoming("queued_second"), 32);
  socket.deliver(incoming("queued_third"), 33);

  await until(async () => (await journalOf(f.config)).deliveries.length === 3, "all queued deliveries journaled");
  assert.deepEqual((await journalOf(f.config)).deliveries.map(({ seq }) => seq), [31, 32, 33]);
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["blocked_head"]);
  f.controls.status = 200;
  await until(async () => { try { return (await cursorOf(f.config)).seq === 33; } catch { return false; } }, "journaled queue recovery");
  assert.deepEqual(f.calls.slice(-3).map(({ messageId }) => messageId), ["blocked_head", "queued_second", "queued_third"]);
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "journaled queue cleanup");
});

test("replays a pending delivery after restart without waiting for another socket delivery", async (t) => {
  const f = await fixture(t);
  const pendingMessages = [
    incoming("survived_restart_1", "direct_restart"),
    incoming("survived_restart_2", "direct_restart"),
    incoming("survived_restart_3", "direct_restart"),
  ];
  await writeFile(journalPathFor(f.config), JSON.stringify({
    version: 1,
    projectId: f.config.projectId,
    deliveries: pendingMessages.map((message, index) => ({ seq: 35 + index, message })),
    deadLetters: [],
    savedAt: new Date().toISOString(),
  }) + "\n", { mode: 0o600 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });

  await until(async () => { try { return (await cursorOf(f.config)).seq === 37; } catch { return false; } }, "restart journal replay");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "restart journal clear");
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["survived_restart_1", "survived_restart_2", "survived_restart_3"]);
  assert.deepEqual(f.sent.map((value) => value.headers["idempotency-key"]), [
    "smile:survived_restart_1:room:0",
    "smile:survived_restart_2:room:0",
    "smile:survived_restart_3:room:0",
  ]);
  assert.ok(f.sent.every((message) => message.body.spaceId === "direct_restart"));
});

test("treats the cursor as authoritative when a restart finds a stale journal entry", async (t) => {
  const f = await fixture(t);
  await writeFile(f.config.cursorFile, JSON.stringify({ seq: 44, projectId: f.config.projectId }) + "\n", { mode: 0o600 });
  await writeFile(journalPathFor(f.config), JSON.stringify({
    version: 1,
    projectId: f.config.projectId,
    deliveries: [{ seq: 44, message: incoming("already_checkpointed") }],
    deadLetters: [],
  }) + "\n", { mode: 0o600 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [44]);
  assert.equal((await journalOf(f.config)).deliveries.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test("fails closed on a corrupt pending-event journal", async (t) => {
  const f = await fixture(t);
  await writeFile(journalPathFor(f.config), "{truncated", { mode: 0o600 });
  const socket = new FakeSocket();
  await assert.rejects(
    start(f.config, { photon: f.photon, socket: socket as unknown as Socket }),
    (error: unknown) => Boolean(error && typeof error === "object" && "stage" in error && error.stage === "journal"),
  );
  assert.equal(socket.connections.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test("uses a project-scoped journal without overwriting another project's pending events", async (t) => {
  const f = await fixture(t);
  const otherProject = "pho_prj_other";
  const otherJournal = journalPathFor(f.config, otherProject);
  const original = JSON.stringify({
    version: 1,
    projectId: otherProject,
    deliveries: [{ seq: 9, message: incoming("other_project_pending") }],
    deadLetters: [],
  }) + "\n";
  await writeFile(otherJournal, original, { mode: 0o600 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  assert.equal(await readFile(otherJournal, "utf8"), original);
  assert.equal((await journalOf(f.config)).deliveries.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});

test("pauses socket intake while a large durable backlog drains, then resumes from its checkpoint", async (t) => {
  const f = await fixture(t);
  await writeFile(journalPathFor(f.config), JSON.stringify({
    version: 1,
    projectId: f.config.projectId,
    deliveries: Array.from({ length: 128 }, (_, index) => ({ seq: index + 1, message: null })),
    deadLetters: [],
  }) + "\n", { mode: 0o600 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  assert.equal(socket.connections.length, 0);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 128; } catch { return false; } }, "durable backlog checkpoint", 5_000);
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "durable backlog cleanup", 5_000);
  assert.equal(socket.connections.length, 1);
  assert.equal(socket.subscriptions[0]!.startSeq >= 64, true);
  assert.equal(f.calls.length, 0);
});

test("persists the cursor only after deliveries succeed and keeps later deliveries queued during a local retry", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Ready", approvalPath: "/desk#approve=token" }]);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 30, retryMaxMs: 100 });
  assert.match(JSON.stringify(f.logs), /S’mile connected to Photon 2\.0 at cursor 0/);
  socket.deliver(incoming("first"), 1);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "initial cursor");
  f.fail.count = 1;
  f.fail.idempotencyKey = "smile:second:dm:0";
  socket.deliver(incoming("second"), 2);
  socket.deliver(incoming("not_processed_yet"), 3);
  await until(() => f.calls.filter((body) => body.messageId === "second").length === 1, "failed second delivery");
  assert.equal((await cursorOf(f.config)).seq, 1);
  assert.equal(socket.connected, true);
  assert.equal(socket.connections.length, 1);
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [0]);
  await until(async () => (await cursorOf(f.config)).seq === 3, "locally retried and queued cursor");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "retried queue cleanup");
  assert.equal(f.effects.size, 6);
  assert.equal(f.calls.filter((body) => body.messageId === "second").length, 2);
  assert.equal(f.calls.filter((body) => body.messageId === "not_processed_yet").length, 1);
  assert.equal((await cursorOf(f.config)).projectId, "pho_prj_test");
  socket.disconnect();
  const restarted = new FakeSocket();
  t.after(() => restarted.disconnect());
  await start(f.config, { photon: f.photon, socket: restarted as unknown as Socket });
  assert.equal(restarted.subscriptions[0]!.startSeq, 3);
  const count = f.calls.length;
  restarted.deliver(incoming("not_processed_yet"), 3);
  restarted.deliver(incoming("fourth"), 4);
  await until(async () => (await cursorOf(f.config)).seq === 4, "new message after restart");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "restart delivery cleanup");
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.calls.at(-1)!.messageId, "fourth");
});

test("skips unrelated projects, bot loops, group spaces, and malformed events without breaking later direct messages", async (t) => {
  const f = await fixture(t);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  socket.emit("delivery", eventFor(incoming("wrong_project"), "pho_prj_other"), { seq: 1 });
  const loop = incoming("bot_loop");
  loop.sentBy.kind = "agent";
  socket.deliver(loop, 2);
  socket.emit("delivery", { type: "message.received", source: "imessage.photon", data: { projectId: "pho_prj_test", object: { sentBy: null } } }, { seq: 3 });
  const group = incoming("group_ignored", "group_1");
  group.space.kind = "group";
  socket.deliver(group, 4);
  socket.deliver(incoming("real", "direct_2"), 5);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 5; } catch { return false; } }, "later direct delivery");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "ignored delivery cleanup");
  assert.deepEqual(f.calls.map((body) => body.messageId), ["real"]);
  assert.equal(f.sent[0]!.body.spaceId, "direct_2");
});

test("invalid sequence metadata cannot advance the durable cursor", async (t) => {
  const f = await fixture(t);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 30 });
  socket.emit("delivery", eventFor(incoming()), { seq: -1 });
  assert.equal(socket.connected, false);
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(f.config.cursorFile), /ENOENT/);
  await until(() => socket.connections.length === 2, "metadata retry");
  assert.equal(socket.subscriptions.at(-1)!.startSeq, 0);
});

test("repeated brain failures increase local retry backoff without reconnecting or losing the event", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 25, retryMaxMs: 100 });
  socket.deliver(incoming("retry_me"), 1);
  await until(() => f.calls.length >= 3, "three local attempts");
  assert.ok(f.requestTimes[1]! - f.requestTimes[0]! >= 15);
  assert.ok(f.requestTimes[2]! - f.requestTimes[1]! >= 35);
  assert.equal(socket.connected, true);
  assert.equal(socket.connections.length, 1);
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [0]);
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["retry_me", "retry_me", "retry_me"]);
  assert.equal(f.sent.length, 0);
  f.controls.status = 200;
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "recovered message");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "recovered message cleanup");
  assert.equal(f.effects.size, 1);
  assert.equal(socket.connections.length, 1);
});

test("logs an allowlisted bridge diagnostic code without exposing the response body", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  f.controls.raw = JSON.stringify({
    error: "secret deployment detail",
    code: "PHOTON_PROJECT_NOT_CONFIGURED",
    internal: "private-stack-trace",
  });
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 25, retryMaxMs: 100 });
  socket.deliver(incoming("diagnostic_code"), 1);
  await until(() => JSON.stringify(logs).includes("PHOTON_PROJECT_NOT_CONFIGURED"), "safe bridge diagnostic");
  assert.match(JSON.stringify(logs), /bridge \(HTTP 503, PHOTON_PROJECT_NOT_CONFIGURED\)/);
  assert.doesNotMatch(JSON.stringify(logs), /secret deployment detail|private-stack-trace/);
  f.controls.status = 200;
  f.controls.raw = undefined;
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "diagnostic retry recovery");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "diagnostic retry cleanup");
});

test("quarantines a permanent replay conflict and continues with the next valid event", async (t) => {
  const f = await fixture(t);
  f.controls.responseFor = (body) => body.messageId === "poison_conflict"
    ? { status: 409, raw: JSON.stringify({ error: "private conflict detail", code: "CHAT_REPLAY_CONFLICT" }) }
    : undefined;
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 10 });
  socket.deliver(incoming("poison_conflict"), 61);
  socket.deliver(incoming("valid_after_conflict"), 62);

  await until(async () => { try { return (await cursorOf(f.config)).seq === 62; } catch { return false; } }, "event after quarantined conflict");
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["poison_conflict", "valid_after_conflict"]);
  assert.deepEqual(f.sent.map((value) => value.headers["idempotency-key"]), ["smile:valid_after_conflict:room:0"]);
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "conflict journal cleanup");
  const journal = await journalOf(f.config);
  assert.deepEqual(journal.deadLetters.map(({ seq, messageId, stage, status, diagnosticCode }) => ({ seq, messageId, stage, status, diagnosticCode })), [{
    seq: 61,
    messageId: "poison_conflict",
    stage: "bridge",
    status: 409,
    diagnosticCode: "CHAT_REPLAY_CONFLICT",
  }]);
  assert.match(JSON.stringify(logs), /quarantined.*bridge \(HTTP 409, CHAT_REPLAY_CONFLICT\)/);
  assert.doesNotMatch(JSON.stringify(logs), /private conflict detail/);
  assert.doesNotMatch(JSON.stringify(journal), /@smile|private conflict detail/);
});

test("bounds malformed bridge-response retries before quarantining the poison event", async (t) => {
  const f = await fixture(t);
  f.controls.responseFor = (body) => body.messageId === "poison_response"
    ? { status: 200, raw: JSON.stringify({ replies: [{ private: "malformed response detail" }] }) }
    : undefined;
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 1, retryMaxMs: 4 });
  socket.deliver(incoming("poison_response"), 71);
  socket.deliver(incoming("valid_after_response"), 72);

  await until(async () => { try { return (await cursorOf(f.config)).seq === 72; } catch { return false; } }, "event after malformed bridge response");
  assert.equal(f.calls.filter(({ messageId }) => messageId === "poison_response").length, 5);
  assert.equal(f.calls.filter(({ messageId }) => messageId === "valid_after_response").length, 1);
  assert.deepEqual(f.sent.map((value) => value.headers["idempotency-key"]), ["smile:valid_after_response:room:0"]);
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "malformed-response journal cleanup");
  const journal = await journalOf(f.config);
  assert.deepEqual(journal.deadLetters.map(({ seq, messageId, stage, status }) => ({ seq, messageId, stage, status })), [{
    seq: 71,
    messageId: "poison_response",
    stage: "bridge-response",
    status: undefined,
  }]);
  assert.match(JSON.stringify(logs), /quarantined after bridge-response/);
  assert.doesNotMatch(JSON.stringify(logs), /malformed response detail/);
});

test("does not checkpoint a Photon message that already reports delivery failure", async (t) => {
  const f = await fixture(t);
  f.fail.status = "failed";
  await assert.rejects(processMessage(f.photon, f.config, incoming()), /did not accept the room reply/);
});

test("failure logs never expose SDK payloads, user messages, or private approval tokens", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Ready", approvalPath: "/desk#approve=hidden-approval-token" }]);
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  f.fail.count = 1;
  f.fail.idempotencyKey = "smile:private_error:dm:0";
  f.fail.error = Object.assign(new Error("SDK request /desk#approve=hidden-approval-token, sensitive user message and api-secret"), { status: 503 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 5 });
  socket.deliver(incoming("private_error"), 1);
  await until(() => logs.length > 0, "safe error log");
  assert.match(JSON.stringify(logs), /HTTP 503/);
  assert.doesNotMatch(JSON.stringify(logs), /hidden-approval-token|sensitive user message|api-secret/);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "safe local retry");
  await until(async () => (await journalOf(f.config)).deliveries.length === 0, "safe retry cleanup");
  assert.equal(socket.connections.length, 1);
  socket.disconnect();
});

test("the standalone worker stays alive until its reconnect timer fires", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "smile-photon-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
    if (process.env.NODE_TEST_CONTEXT) throw new Error('Standalone worker inherited the test runner context');
    import { EventEmitter } from 'node:events';
    import { start } from ${JSON.stringify(new URL("../../backend/photon/index.ts", import.meta.url).href)};
    class Socket extends EventEmitter {
      connected = false;
      count = 0;
      timeout() { return { emit: (_name, _payload, ack) => ack(null, { ok: true }) }; }
      connect() { this.connected = true; this.count++; this.emit('connect'); if (this.count === 2) { console.log('RECONNECTED'); this.disconnect(); } return this; }
      disconnect() { if (this.connected) { this.connected = false; this.emit('disconnect'); } return this; }
    }
    const socket = new Socket();
    await start({ projectId: 'pho_prj_test', apiKey: 'pho_sk_test', bridgeSecret: 'test-secret', webUrl: 'https://smile.example', apiOrigin: 'https://api.photon.codes', cursorFile: ${JSON.stringify(join(directory, "cursor.json"))} }, { photon: { projects: { get: async () => ({}) } }, socket, retryBaseMs: 20 });
    socket.emit('delivery', {}, { seq: -1 });
  `;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../../backend", import.meta.url)), env: environment, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /RECONNECTED/);
});
