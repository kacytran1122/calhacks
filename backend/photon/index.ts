import "../scripts/env";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Photon } from "@photon-ai/api";
import { io, type Socket } from "socket.io-client";

type PhotonUser = { id: string; kind: string; handle?: string; platform: string };
type PhotonSpace = { id: string; kind: string; platform: string };
export type PhotonMessage = {
  id: string;
  platform: string;
  status: string;
  content: unknown;
  sentBy: PhotonUser;
  receivedBy?: PhotonUser;
  space: PhotonSpace;
};
type DeliveryMeta = { seq: number; replyExpected?: boolean };
type BridgeReply = { id: string; text: string; approvalPath?: string };
type PhotonClient = Pick<Photon, "projects">;
type Runtime = { photon?: PhotonClient; socket?: Socket; retryBaseMs?: number; retryMaxMs?: number };

export type Config = {
  apiKey: string;
  projectId: string;
  webUrl: string;
  bridgeSecret: string;
  cursorFile: string;
  apiOrigin: string;
};

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};

export function assertPhoton2Credentials(projectId: string, apiKey: string) {
  if (!projectId.startsWith("pho_prj_")) {
    throw new Error("PHOTON_PROJECT_ID must be a Photon 2.0 project ID beginning with pho_prj_. Spectrum UUIDs are not compatible.");
  }
  if (!apiKey.startsWith("pho_sk_")) {
    throw new Error("PHOTON_API_KEY must be a Photon 2.0 project key beginning with pho_sk_. Spectrum project secrets are not compatible.");
  }
}

export function configuration(): Config {
  const webUrl = required("SMILE_WEB_URL").replace(/\/$/, "");
  const parsed = new URL(webUrl);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("SMILE_WEB_URL must be an http(s) origin.");
  const apiKey = required("PHOTON_API_KEY");
  const projectId = required("PHOTON_PROJECT_ID");
  assertPhoton2Credentials(projectId, apiKey);
  return {
    apiKey,
    projectId,
    webUrl,
    bridgeSecret: required("PHOTON_BRIDGE_SECRET"),
    cursorFile: resolve(process.env.PHOTON_CURSOR_FILE?.trim() || resolve(process.env.SMILE_DATA_DIR?.trim() || process.env.DATA_DIR?.trim() || ".data", "photon-cursor.json")),
    apiOrigin: (process.env.PHOTON_API_ORIGIN?.trim() || "https://api.photon.codes").replace(/\/$/, ""),
  };
}

export function textOf(content: unknown, depth = 0): string | undefined {
  if (!content || typeof content !== "object" || depth > 8) return undefined;
  const c = content as { type?: unknown; format?: unknown; text?: unknown; parts?: unknown };
  if (c.type === "text" && c.format === "plain" && typeof c.text === "string") return c.text;
  if (c.type === "group" && Array.isArray(c.parts)) {
    const parts = c.parts.slice(0, 100).map((part) => textOf(part, depth + 1)).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const failureSummary = (error: unknown) => {
  const status = record(error) ? error.status ?? error.statusCode : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? `HTTP ${status}` : "request failed";
};
export const mentionsSmile = (text: string) => /(^|[^\p{L}\p{N}_@])@smile(?=$|[^\p{L}\p{N}_])/iu.test(text);

export function messageFrom(event: unknown, projectId?: string): PhotonMessage | undefined {
  if (!record(event) || event.type !== "message.received" || event.source !== "imessage.photon" || !record(event.data)) return undefined;
  if (projectId && event.data.projectId !== projectId) return undefined;
  const message = event.data.object;
  if (!record(message) || !identifier(message.id) || message.platform !== "imessage" || message.status !== "received") return undefined;
  const { sentBy, receivedBy, space } = message;
  if (!record(sentBy) || !identifier(sentBy.id) || sentBy.kind !== "human" || sentBy.platform !== "imessage") return undefined;
  if (!record(receivedBy) || !identifier(receivedBy.id) || receivedBy.kind !== "agent" || receivedBy.platform !== "imessage") return undefined;
  if (!record(space) || !identifier(space.id) || space.platform !== "imessage" || !["direct", "group"].includes(String(space.kind))) return undefined;
  if (projectId && [message, sentBy, receivedBy, space].some((item) => item.projectId !== undefined && item.projectId !== projectId)) return undefined;
  const text = textOf(message.content);
  if (!text || text.length > 4_000) return undefined;
  return message as PhotonMessage;
}

async function loadCursor(path: string, projectId: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { seq?: unknown; projectId?: string };
    if (value.projectId && value.projectId !== projectId) return 0;
    return Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 ? Number(value.seq) : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function saveCursor(path: string, seq: number, projectId: string) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.tmp`;
  await writeFile(pending, JSON.stringify({ seq, projectId, savedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  await rename(pending, path);
}

async function callBrain(config: Config, message: PhotonMessage, text: string): Promise<BridgeReply[]> {
  const response = await fetch(`${config.webUrl}/api/chat/photon`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-smile-photon-secret": config.bridgeSecret },
    body: JSON.stringify({ projectId: config.projectId, messageId: message.id, spaceId: message.space.id, senderId: message.sentBy.id, text }),
    signal: AbortSignal.timeout(290_000),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`S’mile bridge ${response.status}: request failed`);
  if (!record(body) || !Array.isArray(body.replies) || body.replies.length > 20) throw new Error("S’mile bridge returned invalid replies.");
  if (body.replies.some((reply) => !record(reply) || !identifier(reply.id) || typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 20_000 || (reply.approvalPath !== undefined && typeof reply.approvalPath !== "string"))) throw new Error("S’mile bridge returned an invalid reply.");
  const replies = body.replies as BridgeReply[];
  for (const reply of replies) {
    if (!reply.approvalPath) continue;
    const url = new URL(reply.approvalPath, config.webUrl);
    if (url.origin !== new URL(config.webUrl).origin || url.username || url.password) throw new Error("S’mile approval must use the configured website.");
  }
  return replies;
}

const idempotency = (messageId: string, channel: "room" | "dm", index: number) => `smile:${messageId}:${channel}:${index}`;

export async function processMessage(photon: PhotonClient, config: Config, message: PhotonMessage) {
  const text = textOf(message.content);
  if (!text || !mentionsSmile(text)) return;
  const agent = message.receivedBy!;
  const replies = await callBrain(config, message, text);

  for (const [index, reply] of replies.entries()) {
    const roomDelivery = await photon.projects.sendMessage({
      path: { id: config.projectId },
      headers: { "idempotency-key": idempotency(message.id, "room", index) },
      body: {
        spaceId: message.space.id,
        senderId: agent.id,
        parentMessageId: message.id,
        content: { type: "text", format: "plain", text: reply.text },
      },
    });
    if (roomDelivery.status === "failed") throw new Error("Photon did not accept the room reply.");

    if (!reply.approvalPath) continue;
    const approvalUrl = new URL(reply.approvalPath, config.webUrl).toString();
    const direct = message.space.kind === "direct"
      ? message.space
      : await photon.projects.createOrGetSpace({
          path: { id: config.projectId },
          headers: { "idempotency-key": `smile:${message.id}:dm-space` },
          body: { platform: "imessage", participantIds: [agent.id, message.sentBy.id] },
        });
    if (!identifier(direct.id)) throw new Error("Photon did not return a direct-space ID.");
    const privateDelivery = await photon.projects.sendMessage({
      path: { id: config.projectId },
      headers: { "idempotency-key": idempotency(message.id, "dm", index) },
      body: {
        spaceId: direct.id,
        senderId: agent.id,
        content: { type: "text", format: "plain", text: `Private approval for your S’mile trip: ${approvalUrl}\n\nThis link is scoped to one trip and expires in 24 hours. Don’t forward it.` },
      },
    });
    if (privateDelivery.status === "failed") throw new Error("Photon did not accept the private reply.");
  }
}

export async function start(config = configuration(), runtime: Runtime = {}) {
  assertPhoton2Credentials(config.projectId, config.apiKey);
  const photon = runtime.photon ?? new (await import("@photon-ai/api")).Photon({ baseUrl: config.apiOrigin, headers: { Authorization: `Bearer ${config.apiKey}` } });
  await photon.projects.get({ path: { projectId: config.projectId } });
  let cursor = await loadCursor(config.cursorFile, config.projectId);
  let epoch = 0;
  let pending = 0;
  let queue = Promise.resolve();
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const retryBaseMs = runtime.retryBaseMs ?? 1_000;
  const retryMaxMs = runtime.retryMaxMs ?? 30_000;
  const socket: Socket = runtime.socket ?? io(config.apiOrigin, {
    path: `/v1/projects/${config.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.apiKey}` },
    autoConnect: false,
    reconnectionDelay: retryBaseMs,
    reconnectionDelayMax: retryMaxMs,
  });

  const retry = () => {
    if (retryTimer) return;
    epoch++;
    socket.disconnect();
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(retryAttempt++, 10));
    retryTimer = setTimeout(() => { retryTimer = undefined; socket.connect(); }, delay);
  };

  socket.on("connect", () => {
    socket.timeout(10_000).emit("subscribe", { startSeq: cursor, apiVersion: "2026-07-01" }, (error: Error | null, result: { ok: boolean; error?: { code?: string } }) => {
      if (error || !result?.ok) {
        console.error("Photon subscription failed. The worker will retry.");
        retry();
      } else console.info(`S’mile connected to Photon 2.0 at cursor ${cursor}.`);
    });
  });
  socket.on("disconnect", () => {
    epoch++;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  });
  socket.on("delivery", (event: unknown, meta: DeliveryMeta) => {
    if (!record(meta) || !Number.isSafeInteger(meta.seq) || Number(meta.seq) <= 0) {
      console.error("Photon delivery has an invalid sequence.");
      retry();
      return;
    }
    const generation = epoch;
    if (++pending > 128) {
      pending--;
      retry();
      return;
    }
    queue = queue.then(async () => {
      if (generation !== epoch || meta.seq <= cursor) return;
      const message = messageFrom(event, config.projectId);
      if (message) await processMessage(photon, config, message);
      await saveCursor(config.cursorFile, meta.seq, config.projectId);
      cursor = meta.seq;
      retryAttempt = 0;
    }).catch((error) => {
      console.error("Photon event processing failed. The worker will retry:", failureSummary(error));
      if (generation === epoch) {
        retry();
      }
    }).finally(() => { pending--; });
  });
  socket.on("delivery_error", (error: { code?: string; message?: string }) => {
    console.error("Photon delivery error. The worker will retry.");
    retry();
  });
  socket.on("connect_error", (error) => console.error("Photon connection error:", failureSummary(error)));
  socket.connect();
  return socket;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error("Photon worker could not start:", failureSummary(error));
    process.exitCode = 1;
  });
}
