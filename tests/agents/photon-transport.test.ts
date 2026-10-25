import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
type Reply = { id: string; text: string; approvalPath?: string };
const incoming = (id = "msg_1", spaceId = "group_1", text = "@smile help us travel"): PhotonMessage => ({
  id, platform: "imessage", status: "received", content: { type: "text", format: "plain", text },
  sentBy: { id: "human_1", kind: "human", platform: "imessage" }, receivedBy: { id: "agent_1", kind: "agent", platform: "imessage" },
  space: { id: spaceId, kind: "group", platform: "imessage" },
});
const eventFor = (message: PhotonMessage, projectId = "pho_prj_test") => ({ id: `evt_${message.id}`, type: "message.received", source: "imessage.photon", data: { projectId, object: message } });

async function fixture(t: TestContext, replies: Reply[] = [{ id: "reply_1", text: "Take the airport train to the venue." }]) {
  const directory = await mkdtemp(join(tmpdir(), "smile-photon-test-"));
  const calls: BrainBody[] = [];
  const controls = { status: 200, raw: undefined as string | undefined };
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/api/chat/photon");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-smile-photon-secret"], "test-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(controls.status, { "content-type": "application/json" });
    res.end(controls.raw ?? JSON.stringify({ replies }));
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
  const fail = { count: 0, target: "", error: undefined as Error | undefined, status: "accepted" };
  const photon = { projects: {
    get: async ({ path }: { path: { projectId: string } }) => { assert.equal(path.projectId, config.projectId); return {}; },
    sendMessage: async (value: Sent) => {
      sent.push(value);
      if (fail.count > 0 && (!fail.target || value.body.spaceId === fail.target)) { fail.count--; throw fail.error ?? new Error("temporary Photon delivery failure"); }
      effects.set(value.headers["idempotency-key"], value);
      return { id: `out_${effects.size}`, status: fail.status };
    },
    createOrGetSpace: async (value: unknown) => { spaces.push(value); return { id: "private_1" }; },
  } } as unknown as Photon;
  return { config, calls, controls, photon, sent, effects, spaces, fail };
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

test("does not contact the brain or Photon until someone explicitly mentions smile", async (t) => {
  const f = await fixture(t);
  for (const text of ["Can someone plan this?", "smile", "@smiley", "email@smile.com"]) await processMessage(f.photon, f.config, incoming("ordinary", "group_1", text));
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.spaces.length, 0);
});

test("forwards stable source identity and keeps replies in their original iMessage groups", async (t) => {
  const f = await fixture(t);
  await processMessage(f.photon, f.config, incoming("msg_a", "group_a", "(@SMILE), route please"));
  await processMessage(f.photon, f.config, incoming("msg_b", "group_b", "Thanks, @smile!"));
  assert.deepEqual(f.calls.map(({ projectId, messageId, spaceId, senderId }) => ({ projectId, messageId, spaceId, senderId })), [
    { projectId: "pho_prj_test", messageId: "msg_a", spaceId: "group_a", senderId: "human_1" },
    { projectId: "pho_prj_test", messageId: "msg_b", spaceId: "group_b", senderId: "human_1" },
  ]);
  assert.deepEqual(f.sent.map((message) => [message.body.spaceId, message.body.parentMessageId, message.body.senderId]), [["group_a", "msg_a", "agent_1"], ["group_b", "msg_b", "agent_1"]]);
  assert.ok(f.sent.every((message) => message.path.id === "pho_prj_test"));
});

test("sends group replies publicly but approval links only to the requesting traveler", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Your trip is ready. I sent your approval privately.", approvalPath: "/desk#approve=private-token&trip=trip_1" }]);
  await processMessage(f.photon, f.config, incoming());
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0]!.body.spaceId, "group_1");
  assert.doesNotMatch(f.sent[0]!.body.content.text, /private-token|https?:/);
  assert.equal(f.sent[1]!.body.spaceId, "private_1");
  assert.match(f.sent[1]!.body.content.text, new RegExp(`${f.config.webUrl}/desk#approve=private-token`));
  assert.deepEqual(f.spaces, [{ path: { id: "pho_prj_test" }, headers: { "idempotency-key": "smile:msg_1:dm-space" }, body: { platform: "imessage", participantIds: ["agent_1", "human_1"] } }]);
  const direct = incoming("msg_direct", "existing_private");
  direct.space.kind = "direct";
  await processMessage(f.photon, f.config, direct);
  assert.equal(f.spaces.length, 1);
  assert.equal(f.sent.at(-1)!.body.spaceId, "existing_private");
});

test("retries partial room and private deliveries using exactly the same Photon idempotency keys", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Your plan is ready.", approvalPath: "/desk#approve=token" }]);
  f.fail.count = 1;
  f.fail.target = "private_1";
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
  for (const raw of ["", "{}", "{\"replies\":[{}]}", JSON.stringify({ replies: [{ id: "r", text: "Ready", approvalPath: "https://other.example/approve" }] })]) {
    f.controls.raw = raw;
    await assert.rejects(processMessage(f.photon, f.config, incoming()), /invalid repl|configured website/);
  }
  assert.equal(f.sent.length, 0);
});

test("persists the cursor only after all deliveries succeed and replays failed messages after backoff", async (t) => {
  const f = await fixture(t, [{ id: "reply_1", text: "Ready", approvalPath: "/desk#approve=token" }]);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 30, retryMaxMs: 100 });
  socket.deliver(incoming("first"), 1);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "initial cursor");
  f.fail.count = 1;
  f.fail.target = "private_1";
  socket.deliver(incoming("second"), 2);
  socket.deliver(incoming("not_processed_yet"), 3);
  await until(() => !socket.connected, "delivery failure disconnect");
  assert.equal((await cursorOf(f.config)).seq, 1);
  assert.equal(socket.connections.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.connections.length, 1);
  await until(() => socket.connections.length === 2, "backoff reconnect");
  assert.equal(socket.subscriptions.at(-1)!.startSeq, 1);
  socket.deliver(incoming("second"), 2);
  await until(async () => (await cursorOf(f.config)).seq === 2, "replayed cursor");
  assert.equal(f.effects.size, 4);
  assert.equal(f.calls.filter((body) => body.messageId === "second").length, 2);
  assert.equal(f.calls.filter((body) => body.messageId === "not_processed_yet").length, 0);
  assert.equal((await cursorOf(f.config)).projectId, "pho_prj_test");
  socket.disconnect();
  const restarted = new FakeSocket();
  t.after(() => restarted.disconnect());
  await start(f.config, { photon: f.photon, socket: restarted as unknown as Socket });
  assert.equal(restarted.subscriptions[0]!.startSeq, 2);
  const count = f.calls.length;
  restarted.deliver(incoming("second"), 2);
  restarted.deliver(incoming("third"), 3);
  await until(async () => (await cursorOf(f.config)).seq === 3, "new message after restart");
  assert.equal(f.calls.length, count + 1);
  assert.equal(f.calls.at(-1)!.messageId, "third");
});

test("skips unrelated projects, bot loops, and malformed events without breaking later group messages", async (t) => {
  const f = await fixture(t);
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket });
  socket.emit("delivery", eventFor(incoming("wrong_project"), "pho_prj_other"), { seq: 1 });
  const loop = incoming("bot_loop");
  loop.sentBy.kind = "agent";
  socket.deliver(loop, 2);
  socket.emit("delivery", { type: "message.received", source: "imessage.photon", data: { projectId: "pho_prj_test", object: { sentBy: null } } }, { seq: 3 });
  socket.deliver(incoming("ordinary", "group_1", "hello everyone"), 4);
  socket.deliver(incoming("real", "group_2"), 5);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 5; } catch { return false; } }, "later group delivery");
  assert.deepEqual(f.calls.map((body) => body.messageId), ["real"]);
  assert.equal(f.sent[0]!.body.spaceId, "group_2");
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

test("repeated brain failures increase replay backoff instead of creating a hot loop", async (t) => {
  const f = await fixture(t);
  f.controls.status = 503;
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 25, retryMaxMs: 100 });
  socket.deliver(incoming("retry_me"), 1);
  await until(() => socket.connections.length === 2, "first retry");
  socket.deliver(incoming("retry_me"), 1);
  await until(() => !socket.connected, "second failure");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(socket.connections.length, 2);
  await until(() => socket.connections.length === 3, "increased retry delay");
  assert.ok(socket.connections[2]! - socket.connections[1]! >= 45);
  assert.deepEqual(socket.subscriptions.map(({ startSeq }) => startSeq), [0, 0, 0]);
  assert.deepEqual(f.calls.map(({ messageId }) => messageId), ["retry_me", "retry_me"]);
  assert.equal(f.sent.length, 0);
  f.controls.status = 200;
  socket.deliver(incoming("retry_me"), 1);
  await until(async () => { try { return (await cursorOf(f.config)).seq === 1; } catch { return false; } }, "recovered message");
  assert.equal(f.effects.size, 1);
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
  f.fail.target = "private_1";
  f.fail.error = Object.assign(new Error("SDK request /desk#approve=hidden-approval-token, sensitive user message and api-secret"), { status: 503 });
  const socket = new FakeSocket();
  t.after(() => socket.disconnect());
  await start(f.config, { photon: f.photon, socket: socket as unknown as Socket, retryBaseMs: 5 });
  socket.deliver(incoming("private_error"), 1);
  await until(() => logs.length > 0, "safe error log");
  assert.match(JSON.stringify(logs), /HTTP 503/);
  assert.doesNotMatch(JSON.stringify(logs), /hidden-approval-token|sensitive user message|api-secret/);
  await until(() => socket.connections.length === 2, "safe retry");
  socket.disconnect();
});

test("the standalone worker stays alive until its reconnect timer fires", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "smile-photon-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `
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
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: fileURLToPath(new URL("../../backend", import.meta.url)), encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /RECONNECTED/);
});
