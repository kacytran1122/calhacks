import "../scripts/env";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Photon } from "@photon-ai/api";
import { io, type Socket } from "socket.io-client";

type PhotonUser = { id: string; kind: string; handle?: string; platform: string };
type PhotonSpace = { id: string; kind: string; platform: string };
type PhotonMessage = {
  id: string;
  platform: string;
  status: string;
  content: unknown;
  sentBy: PhotonUser;
  receivedBy?: PhotonUser;
  space: PhotonSpace;
};
type PhotonEvent = { id: string; type: string; source?: string; data?: { projectId?: string; object?: PhotonMessage } };
type DeliveryMeta = { seq: number; replyExpected: boolean };
type BridgeReply = { id: string; text: string; approvalPath?: string };

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
    cursorFile: resolve(process.env.PHOTON_CURSOR_FILE?.trim() || ".data/photon-cursor.json"),
    apiOrigin: (process.env.PHOTON_API_ORIGIN?.trim() || "https://api.photon.codes").replace(/\/$/, ""),
  };
}

export function textOf(content: unknown): string | undefined {
  if (!content || typeof content !== "object") return undefined;
  const c = content as { type?: unknown; format?: unknown; text?: unknown; parts?: unknown };
  if (c.type === "text" && c.format === "plain" && typeof c.text === "string") return c.text;
  if (c.type === "group" && Array.isArray(c.parts)) {
    const parts = c.parts.map(textOf).filter((v): v is string => Boolean(v));
    return parts.length ? parts.join("\n") : undefined;
  }
  return undefined;
}

export function messageFrom(event: PhotonEvent): PhotonMessage | undefined {
  const message = event.data?.object;
  if (event.type !== "message.received" || event.source !== "imessage.photon") return undefined;
  if (!message || message.platform !== "imessage" || message.status !== "received") return undefined;
  if (message.sentBy.kind !== "human" || message.receivedBy?.kind !== "agent") return undefined;
  return textOf(message.content) ? message : undefined;
}

async function loadCursor(path: string) {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { seq?: unknown };
    return Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 ? Number(value.seq) : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function saveCursor(path: string, seq: number) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.tmp`;
  await writeFile(pending, JSON.stringify({ seq, savedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  await rename(pending, path);
}

async function callBrain(config: Config, message: PhotonMessage, text: string): Promise<BridgeReply[]> {
  const response = await fetch(`${config.webUrl}/api/chat/photon`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-smile-photon-secret": config.bridgeSecret },
    body: JSON.stringify({ spaceId: message.space.id, senderId: message.sentBy.id, text }),
    signal: AbortSignal.timeout(290_000),
  });
  const body = (await response.json().catch(() => ({}))) as { replies?: BridgeReply[]; error?: string };
  if (!response.ok) throw new Error(`S’mile bridge ${response.status}: ${body.error ?? "request failed"}`);
  return body.replies ?? [];
}

const idempotency = (messageId: string, channel: "room" | "dm", index: number) => `smile:${messageId}:${channel}:${index}`;

export async function processMessage(photon: Photon, config: Config, message: PhotonMessage) {
  const text = textOf(message.content);
  if (!text || !/(^|\s)@smile\b/i.test(text)) return;
  const agent = message.receivedBy!;
  const replies = await callBrain(config, message, text);

  for (const [index, reply] of replies.entries()) {
    await photon.projects.sendMessage({
      path: { id: config.projectId },
      headers: { "idempotency-key": idempotency(message.id, "room", index) },
      body: {
        spaceId: message.space.id,
        senderId: agent.id,
        parentMessageId: message.id,
        content: { type: "text", format: "plain", text: reply.text },
      },
    });

    if (!reply.approvalPath) continue;
    const approvalUrl = new URL(reply.approvalPath, config.webUrl).toString();
    const direct = message.space.kind === "direct"
      ? message.space
      : await photon.projects.createOrGetSpace({
          path: { id: config.projectId },
          headers: { "idempotency-key": `smile:${message.id}:dm-space` },
          body: { platform: "imessage", participantIds: [agent.id, message.sentBy.id] },
        });
    if (typeof direct.id !== "string") throw new Error("Photon did not return a direct-space ID.");
    await photon.projects.sendMessage({
      path: { id: config.projectId },
      headers: { "idempotency-key": idempotency(message.id, "dm", index) },
      body: {
        spaceId: direct.id,
        senderId: agent.id,
        content: { type: "text", format: "plain", text: `Private approval for your S’mile trip: ${approvalUrl}\n\nThis link is scoped to one trip and expires in 24 hours. Don’t forward it.` },
      },
    });
  }
}

export async function start(config = configuration()) {
  const { Photon } = await import("@photon-ai/api");
  assertPhoton2Credentials(config.projectId, config.apiKey);
  const photon = new Photon({ baseUrl: config.apiOrigin, headers: { Authorization: `Bearer ${config.apiKey}` } });
  await photon.projects.get({ path: { projectId: config.projectId } });
  let cursor = await loadCursor(config.cursorFile);
  let epoch = 0;
  let pending = 0;
  let queue = Promise.resolve();
  const socket: Socket = io(config.apiOrigin, {
    path: `/v1/projects/${config.projectId}/events/ws`,
    addTrailingSlash: false,
    transports: ["websocket"],
    extraHeaders: { Authorization: `Bearer ${config.apiKey}` },
    autoConnect: false,
  });

  socket.on("connect", () => {
    socket.timeout(10_000).emit("subscribe", { startSeq: cursor, apiVersion: "2026-07-01" }, (error: Error | null, result: { ok: boolean; error?: { code?: string } }) => {
      if (error || !result?.ok) {
        console.error("Photon subscription failed", error?.message ?? result?.error?.code ?? "unknown");
        socket.io.engine.close();
      } else console.info(`S’mile connected to Photon 2.0 at cursor ${cursor}.`);
    });
  });
  socket.on("disconnect", () => { epoch++; });
  socket.on("delivery", (event: PhotonEvent, meta: DeliveryMeta) => {
    const generation = epoch;
    if (++pending > 128) {
      pending--;
      epoch++;
      socket.io.engine.close();
      return;
    }
    queue = queue.then(async () => {
      if (generation !== epoch || meta.seq <= cursor) return;
      const message = messageFrom(event);
      if (message) await processMessage(photon, config, message);
      await saveCursor(config.cursorFile, meta.seq);
      cursor = meta.seq;
    }).catch((error) => {
      console.error("Photon event processing failed", error);
      if (generation === epoch) {
        epoch++;
        socket.io.engine.close();
      }
    }).finally(() => { pending--; });
  });
  socket.on("delivery_error", (error: { code?: string; message?: string }) => console.error("Photon delivery error", error.code, error.message));
  socket.on("connect_error", (error) => console.error("Photon connection error", error.message));
  socket.connect();
  return socket;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
