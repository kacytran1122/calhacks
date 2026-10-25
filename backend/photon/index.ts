import "../scripts/env";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
type PendingDelivery = { seq: number; message: PhotonMessage | null };
type DeadLetter = {
  seq: number;
  messageId?: string;
  stage: FailureStage;
  status?: number;
  diagnosticCode?: string;
  quarantinedAt: string;
};
type BridgeReply = { id: string; text: string; approvalPath?: string; mapPath?: string };
type PhotonClient = Pick<Photon, "projects">;
type Runtime = { photon?: PhotonClient; socket?: Socket; retryBaseMs?: number; retryMaxMs?: number };
type FailureStage = "bridge" | "bridge-response" | "photon-send" | "cursor-checkpoint" | "journal" | "processing";

const MAX_PENDING_DELIVERIES = 512;
const MAX_DEAD_LETTERS = 256;
const PAUSE_AT_PENDING_DELIVERIES = 128;
const RESUME_AT_PENDING_DELIVERIES = 64;
const MAX_INVALID_RESPONSE_ATTEMPTS = 5;
const CANONICAL_WEB_ORIGIN = "https://smilefromhereto.work";
const PHOTON_API_ORIGIN = "https://api.photon.codes";
const BRIDGE_DIAGNOSTIC_CODES = new Set([
  "PHOTON_BRIDGE_NOT_CONFIGURED",
  "PHOTON_PROJECT_NOT_CONFIGURED",
  "PHOTON_HANDOFF_STORAGE_UNAVAILABLE",
  "PHOTON_HANDOFF_UNAVAILABLE",
  "CHAT_BUSY",
  "CHAT_STORAGE_UNAVAILABLE",
  "CHAT_REPLAY_CONFLICT",
  "PHOTON_PROCESSING_FAILED",
]);
const PERMANENT_EVENT_STATUSES = new Set([400, 409, 413, 422]);

class ProcessingFailure extends Error {
  readonly stage: FailureStage;
  readonly status?: number;
  readonly diagnosticCode?: string;

  constructor(stage: FailureStage, message: string, options: { cause?: unknown; status?: number; diagnosticCode?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProcessingFailure";
    this.stage = stage;
    this.status = options.status;
    this.diagnosticCode = options.diagnosticCode;
  }
}

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
  const webUrl = required("SMILE_WEB_URL");
  if (webUrl !== CANONICAL_WEB_ORIGIN) throw new Error(`SMILE_WEB_URL must be exactly ${CANONICAL_WEB_ORIGIN}.`);
  const configuredApiOrigin = process.env.PHOTON_API_ORIGIN?.trim() || PHOTON_API_ORIGIN;
  if (configuredApiOrigin !== PHOTON_API_ORIGIN) throw new Error(`PHOTON_API_ORIGIN must be exactly ${PHOTON_API_ORIGIN}.`);
  const apiKey = required("PHOTON_API_KEY");
  const projectId = required("PHOTON_PROJECT_ID");
  assertPhoton2Credentials(projectId, apiKey);
  return {
    apiKey,
    projectId,
    webUrl,
    bridgeSecret: required("PHOTON_BRIDGE_SECRET"),
    cursorFile: resolve(process.env.PHOTON_CURSOR_FILE?.trim() || resolve(process.env.SMILE_DATA_DIR?.trim() || process.env.DATA_DIR?.trim() || ".data", "photon-cursor.json")),
    apiOrigin: configuredApiOrigin,
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
const httpStatus = (error: unknown) => {
  const status = record(error) ? error.status ?? error.statusCode : undefined;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
};
const failureSummary = (error: unknown) => {
  const stage = record(error) && typeof error.stage === "string" && ["bridge", "bridge-response", "photon-send", "cursor-checkpoint", "journal", "processing"].includes(error.stage)
    ? error.stage
    : "request";
  const status = httpStatus(error);
  const diagnosticCode = record(error) && typeof error.diagnosticCode === "string" && BRIDGE_DIAGNOSTIC_CODES.has(error.diagnosticCode)
    ? error.diagnosticCode
    : undefined;
  const details = [status ? `HTTP ${status}` : undefined, diagnosticCode].filter(Boolean).join(", ");
  return details ? `${stage} (${details})` : stage;
};
const processingFailure = (stage: FailureStage, error: unknown, fallback: string) => error instanceof ProcessingFailure
  ? error
  : new ProcessingFailure(stage, error instanceof Error && error.message ? error.message : fallback, { cause: error, status: httpStatus(error) });
const isPermanentEventFailure = (failure: ProcessingFailure, attempt: number) =>
  ((failure.stage === "bridge" || failure.stage === "photon-send")
    && failure.status !== undefined
    && PERMANENT_EVENT_STATUSES.has(failure.status))
  || (failure.stage === "bridge-response" && attempt >= MAX_INVALID_RESPONSE_ATTEMPTS - 1);
export const mentionsSmile = (text: string) => /(^|[^\p{L}\p{N}_@])@smile(?=$|[^\p{L}\p{N}_])/iu.test(text);

export function messageFrom(event: unknown, projectId?: string): PhotonMessage | undefined {
  if (!record(event) || event.type !== "message.received" || event.source !== "imessage.photon" || !record(event.data)) return undefined;
  if (projectId && event.data.projectId !== projectId) return undefined;
  const message = event.data.object;
  if (!record(message) || !identifier(message.id) || message.platform !== "imessage" || message.status !== "received") return undefined;
  const { sentBy, receivedBy, space } = message;
  if (!record(sentBy) || !identifier(sentBy.id) || sentBy.kind !== "human" || sentBy.platform !== "imessage") return undefined;
  if (!record(receivedBy) || !identifier(receivedBy.id) || receivedBy.kind !== "agent" || receivedBy.platform !== "imessage") return undefined;
  if (!record(space) || !identifier(space.id) || space.platform !== "imessage" || space.kind !== "direct") return undefined;
  if (projectId && [message, sentBy, receivedBy, space].some((item) => item.projectId !== undefined && item.projectId !== projectId)) return undefined;
  const text = textOf(message.content);
  if (!text || text.length > 4_000) return undefined;
  return message as PhotonMessage;
}

function minimalMessage(message: PhotonMessage): PhotonMessage {
  return {
    id: message.id,
    platform: "imessage",
    status: "received",
    content: { type: "text", format: "plain", text: textOf(message.content)! },
    sentBy: { id: message.sentBy.id, kind: "human", platform: "imessage" },
    receivedBy: { id: message.receivedBy!.id, kind: "agent", platform: "imessage" },
    space: { id: message.space.id, kind: "direct", platform: "imessage" },
  };
}

function normalizedMessage(event: unknown, projectId: string) {
  const message = messageFrom(event, projectId);
  return message ? minimalMessage(message) : null;
}

function storedMessage(value: unknown, projectId: string) {
  if (value === null) return null;
  const message = messageFrom({
    type: "message.received",
    source: "imessage.photon",
    data: { projectId, object: value },
  }, projectId);
  if (!message) throw new Error("Photon pending-event journal contains an invalid message.");
  return minimalMessage(message);
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
  await writeAtomicJson(path, { seq, projectId, savedAt: new Date().toISOString() });
}

async function writeAtomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const pending = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(pending, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(pending, path);
  } finally {
    await unlink(pending).catch(() => undefined);
  }
}

const journalPath = (cursorFile: string, projectId: string) => {
  const projectKey = createHash("sha256").update(projectId).digest("hex").slice(0, 16);
  return `${cursorFile}.${projectKey}.pending`;
};

async function loadJournal(path: string, projectId: string): Promise<{ deliveries: PendingDelivery[]; deadLetters: DeadLetter[] }> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deliveries: [], deadLetters: [] };
    throw error;
  }
  if (!record(value) || value.version !== 1 || typeof value.projectId !== "string" || !Array.isArray(value.deliveries)) {
    throw new Error("Photon pending-event journal is invalid.");
  }
  if (value.projectId !== projectId) throw new Error("Photon pending-event journal belongs to another project.");
  if (value.deliveries.length > MAX_PENDING_DELIVERIES) throw new Error("Photon pending-event journal exceeds its safety limit.");
  const deliveries: PendingDelivery[] = [];
  for (const item of value.deliveries) {
    if (!record(item) || !Number.isSafeInteger(item.seq) || Number(item.seq) <= 0 || !("message" in item)) {
      throw new Error("Photon pending-event journal contains an invalid delivery.");
    }
    deliveries.push({ seq: Number(item.seq), message: storedMessage(item.message, projectId) });
  }
  const rawDeadLetters = value.deadLetters === undefined ? [] : value.deadLetters;
  if (!Array.isArray(rawDeadLetters) || rawDeadLetters.length > MAX_DEAD_LETTERS) throw new Error("Photon dead-letter journal is invalid.");
  const deadLetters: DeadLetter[] = rawDeadLetters.map((item) => {
    if (
      !record(item)
      || !Number.isSafeInteger(item.seq)
      || Number(item.seq) <= 0
      || (item.messageId !== undefined && !identifier(item.messageId))
      || typeof item.stage !== "string"
      || !["bridge", "bridge-response", "photon-send", "cursor-checkpoint", "journal", "processing"].includes(item.stage)
      || (item.status !== undefined && httpStatus(item) === undefined)
      || (item.diagnosticCode !== undefined && (typeof item.diagnosticCode !== "string" || !BRIDGE_DIAGNOSTIC_CODES.has(item.diagnosticCode)))
      || typeof item.quarantinedAt !== "string"
    ) throw new Error("Photon dead-letter journal contains an invalid entry.");
    return {
      seq: Number(item.seq),
      messageId: item.messageId as string | undefined,
      stage: item.stage as FailureStage,
      status: item.status as number | undefined,
      diagnosticCode: item.diagnosticCode as string | undefined,
      quarantinedAt: item.quarantinedAt,
    };
  });
  return { deliveries, deadLetters };
}

async function saveJournal(path: string, projectId: string, deliveries: PendingDelivery[], deadLetters: DeadLetter[]) {
  await writeAtomicJson(path, { version: 1, projectId, deliveries, deadLetters, savedAt: new Date().toISOString() });
}

async function callBrain(config: Config, message: PhotonMessage, text: string): Promise<BridgeReply[]> {
  let response: Response;
  try {
    response = await fetch(`${config.webUrl}/api/chat/photon`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-smile-photon-secret": config.bridgeSecret },
      body: JSON.stringify({ projectId: config.projectId, messageId: message.id, spaceId: message.space.id, senderId: message.sentBy.id, text }),
      signal: AbortSignal.timeout(290_000),
    });
  } catch (error) {
    throw processingFailure("bridge", error, "S’mile bridge request failed.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const diagnosticCode = record(body) && typeof body.code === "string" && BRIDGE_DIAGNOSTIC_CODES.has(body.code) ? body.code : undefined;
    throw new ProcessingFailure("bridge", `S’mile bridge ${response.status}: request failed`, { status: response.status, diagnosticCode });
  }
  if (!record(body) || !Array.isArray(body.replies) || body.replies.length > 20) throw new ProcessingFailure("bridge-response", "S’mile bridge returned invalid replies.");
  if (body.replies.some((reply) => !record(reply) || !identifier(reply.id) || typeof reply.text !== "string" || !reply.text.trim() || reply.text.length > 20_000 || (reply.approvalPath !== undefined && typeof reply.approvalPath !== "string") || (reply.mapPath !== undefined && typeof reply.mapPath !== "string"))) throw new ProcessingFailure("bridge-response", "S’mile bridge returned an invalid reply.");
  const replies = body.replies as BridgeReply[];
  for (const reply of replies) {
    if (reply.approvalPath) {
      const url = new URL(reply.approvalPath, config.webUrl);
      if (url.origin !== new URL(config.webUrl).origin || url.username || url.password) throw new ProcessingFailure("bridge-response", "S’mile approval must use the configured website.");
    }
    if (reply.mapPath) {
      const url = new URL(reply.mapPath, config.webUrl);
      const keys = [...url.searchParams.keys()];
      const token = url.searchParams.get("handoff") ?? "";
      if (
        url.origin !== new URL(config.webUrl).origin
        || url.username
        || url.password
        || url.pathname !== "/map"
        || url.hash
        || keys.length !== 1
        || keys[0] !== "handoff"
        || !/^phm1_[A-Za-z0-9_-]{43}$/.test(token)
      ) throw new ProcessingFailure("bridge-response", "S’mile map handoff must use the configured website and an opaque map token.");
    }
  }
  return replies;
}

const idempotency = (messageId: string, channel: "room" | "dm" | "map", index: number) => `smile:${messageId}:${channel}:${index}`;

async function sendPhotonMessage(
  photon: PhotonClient,
  input: Parameters<Photon["projects"]["sendMessage"]>[0],
  rejectedMessage: string,
) {
  try {
    const delivery = await photon.projects.sendMessage(input);
    if (delivery.status === "failed") throw new ProcessingFailure("photon-send", rejectedMessage);
    return delivery;
  } catch (error) {
    throw processingFailure("photon-send", error, "Photon reply request failed.");
  }
}

export async function processMessage(photon: PhotonClient, config: Config, message: PhotonMessage) {
  const text = textOf(message.content);
  if (message.space.kind !== "direct" || !text || !mentionsSmile(text)) return;
  const agent = message.receivedBy!;
  const replies = await callBrain(config, message, text);

  for (const [index, reply] of replies.entries()) {
    await sendPhotonMessage(photon, {
      path: { id: config.projectId },
      headers: { "idempotency-key": idempotency(message.id, "room", index) },
      body: {
        spaceId: message.space.id,
        senderId: agent.id,
        parentMessageId: message.id,
        content: { type: "text", format: "plain", text: reply.text },
      },
    }, "Photon did not accept the room reply.");

    if (reply.approvalPath) {
      const approvalUrl = new URL(reply.approvalPath, config.webUrl).toString();
      await sendPhotonMessage(photon, {
        path: { id: config.projectId },
        headers: { "idempotency-key": idempotency(message.id, "dm", index) },
        body: {
          spaceId: message.space.id,
          senderId: agent.id,
          content: { type: "text", format: "plain", text: `Private approval for your S’mile trip: ${approvalUrl}\n\nThis link is scoped to one trip and expires in 24 hours. Don’t forward it.` },
        },
      }, "Photon did not accept the private reply.");
    }

    if (reply.mapPath) {
      const mapUrl = new URL(reply.mapPath, config.webUrl).toString();
      await sendPhotonMessage(photon, {
        path: { id: config.projectId },
        headers: { "idempotency-key": idempotency(message.id, "map", index) },
        body: {
          spaceId: message.space.id,
          senderId: agent.id,
          content: {
            type: "text",
            format: "plain",
            text: `TRIP UPDATE\n\nYour current step-by-step route is ready:\n${mapUrl}\n\nSave or pin this message for quick access. Message @smile status, @smile trip, or @smile location for the latest saved update. This secure, trip-specific link expires in 12 hours; please do not forward it.`,
          },
        },
      }, "Photon did not accept the map link.");
    }
  }
}

export async function start(config = configuration(), runtime: Runtime = {}) {
  assertPhoton2Credentials(config.projectId, config.apiKey);
  const photon = runtime.photon ?? new (await import("@photon-ai/api")).Photon({ baseUrl: config.apiOrigin, headers: { Authorization: `Bearer ${config.apiKey}` } });
  await photon.projects.get({ path: { projectId: config.projectId } });
  let cursor = await loadCursor(config.cursorFile, config.projectId);
  const pendingFile = journalPath(config.cursorFile, config.projectId);
  let pendingDeliveries: PendingDelivery[];
  let deadLetters: DeadLetter[];
  try {
    const loaded = await loadJournal(pendingFile, config.projectId);
    const bySequence = new Map<number, PendingDelivery>();
    for (const delivery of loaded.deliveries) {
      if (delivery.seq <= cursor) continue;
      const existing = bySequence.get(delivery.seq);
      if (existing && JSON.stringify(existing.message) !== JSON.stringify(delivery.message)) {
        throw new Error("Photon pending-event journal contains conflicting deliveries.");
      }
      bySequence.set(delivery.seq, delivery);
    }
    pendingDeliveries = [...bySequence.values()].sort((left, right) => left.seq - right.seq);
    deadLetters = loaded.deadLetters;
    await saveJournal(pendingFile, config.projectId, pendingDeliveries, deadLetters);
  } catch (error) {
    throw processingFailure("journal", error, "Photon pending-event journal could not be opened.");
  }

  let journalWrites: Promise<unknown> = Promise.resolve();
  const appendPending = (delivery: PendingDelivery) => {
    const operation = journalWrites.then(async () => {
      if (delivery.seq <= cursor) return false;
      const existing = pendingDeliveries.find((item) => item.seq === delivery.seq);
      if (existing) {
        if (JSON.stringify(existing.message) !== JSON.stringify(delivery.message)) throw new Error("Photon delivered conflicting events for one sequence.");
        return false;
      }
      if (pendingDeliveries.length >= MAX_PENDING_DELIVERIES) throw new Error("Photon pending-event journal is full.");
      const next = [...pendingDeliveries, delivery].sort((left, right) => left.seq - right.seq);
      await saveJournal(pendingFile, config.projectId, next, deadLetters);
      pendingDeliveries = next;
      return true;
    });
    journalWrites = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const removePending = (seq: number) => {
    const operation = journalWrites.then(async () => {
      if (!pendingDeliveries.some((item) => item.seq === seq)) return;
      const next = pendingDeliveries.filter((item) => item.seq !== seq);
      await saveJournal(pendingFile, config.projectId, next, deadLetters);
      pendingDeliveries = next;
    });
    journalWrites = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const quarantinePending = (delivery: PendingDelivery, failure: ProcessingFailure) => {
    const operation = journalWrites.then(async () => {
      if (deadLetters.some((item) => item.seq === delivery.seq)) return;
      const next = [...deadLetters, {
        seq: delivery.seq,
        messageId: delivery.message?.id,
        stage: failure.stage,
        status: failure.status,
        diagnosticCode: failure.diagnosticCode && BRIDGE_DIAGNOSTIC_CODES.has(failure.diagnosticCode) ? failure.diagnosticCode : undefined,
        quarantinedAt: new Date().toISOString(),
      }].slice(-MAX_DEAD_LETTERS);
      await saveJournal(pendingFile, config.projectId, pendingDeliveries, next);
      deadLetters = next;
    });
    journalWrites = operation.then(() => undefined, () => undefined);
    return operation;
  };

  let acceptanceQueue = Promise.resolve();
  let processingQueue = Promise.resolve();
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
  let pausedForBackpressure = false;

  const retry = () => {
    if (retryTimer || pausedForBackpressure) return;
    socket.disconnect();
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(retryAttempt++, 10));
    retryTimer = setTimeout(() => { retryTimer = undefined; socket.connect(); }, delay);
  };

  const pauseForBackpressure = () => {
    if (pausedForBackpressure) return;
    pausedForBackpressure = true;
    socket.disconnect();
    console.info("Photon intake paused while durable pending events are processed.");
  };

  const resumeAfterBackpressure = () => {
    if (!pausedForBackpressure || pendingDeliveries.length > RESUME_AT_PENDING_DELIVERIES) return;
    pausedForBackpressure = false;
    socket.connect();
  };

  const waitBeforeRetry = (attempt: number) => {
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempt, 10));
    return { delay, done: new Promise<void>((resolve) => setTimeout(resolve, delay)) };
  };

  const processPending = async (delivery: PendingDelivery) => {
    let processingAttempt = 0;
    while (true) {
      try {
        if (delivery.seq <= cursor) {
          await removePending(delivery.seq);
          resumeAfterBackpressure();
          return;
        }
        if (delivery.message) await processMessage(photon, config, delivery.message);
        try {
          await saveCursor(config.cursorFile, delivery.seq, config.projectId);
        } catch (error) {
          throw processingFailure("cursor-checkpoint", error, "Photon cursor checkpoint failed.");
        }
        cursor = delivery.seq;
        try {
          await removePending(delivery.seq);
        } catch (error) {
          throw processingFailure("journal", error, "Photon pending event could not be cleared.");
        }
        retryAttempt = 0;
        resumeAfterBackpressure();
        return;
      } catch (error) {
        let failure = error instanceof ProcessingFailure ? error : processingFailure("processing", error, "Photon event processing failed.");
        if (isPermanentEventFailure(failure, processingAttempt)) {
          try {
            await quarantinePending(delivery, failure);
            try {
              await saveCursor(config.cursorFile, delivery.seq, config.projectId);
            } catch (checkpointError) {
              throw processingFailure("cursor-checkpoint", checkpointError, "Photon cursor checkpoint failed.");
            }
            cursor = delivery.seq;
            try {
              await removePending(delivery.seq);
            } catch (journalError) {
              throw processingFailure("journal", journalError, "Photon pending event could not be cleared.");
            }
            console.error(`Photon event was quarantined after ${failureSummary(failure)}. Later events will continue.`);
            retryAttempt = 0;
            resumeAfterBackpressure();
            return;
          } catch (finalizationError) {
            failure = finalizationError instanceof ProcessingFailure
              ? finalizationError
              : processingFailure("journal", finalizationError, "Photon event could not be quarantined.");
          }
        }
        const retryWait = waitBeforeRetry(processingAttempt++);
        console.error(`Photon event processing failed at ${failureSummary(failure)}. Retrying this event in ${retryWait.delay} ms.`);
        await retryWait.done;
      }
    }
  };

  const enqueue = (delivery: PendingDelivery) => {
    processingQueue = processingQueue.then(() => processPending(delivery));
  };

  for (const delivery of pendingDeliveries) enqueue(delivery);

  socket.on("connect", () => {
    socket.timeout(10_000).emit("subscribe", { startSeq: cursor, apiVersion: "2026-07-01" }, (error: Error | null, result: { ok: boolean; error?: { code?: string } }) => {
      if (error || !result?.ok) {
        console.error("Photon subscription failed. The worker will retry.");
        retry();
      } else console.info(`S’mile connected to Photon 2.0 at cursor ${cursor}.`);
    });
  });
  socket.on("disconnect", () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
  });
  socket.on("delivery", (event: unknown, meta: DeliveryMeta) => {
    if (!record(meta) || !Number.isSafeInteger(meta.seq) || Number(meta.seq) <= 0) {
      console.error("Photon delivery has an invalid sequence.");
      retry();
      return;
    }
    const delivery = { seq: meta.seq, message: normalizedMessage(event, config.projectId) };
    acceptanceQueue = acceptanceQueue.then(async () => {
      let journalAttempt = 0;
      while (delivery.seq > cursor) {
        try {
          if (await appendPending(delivery)) {
            enqueue(delivery);
            if (pendingDeliveries.length >= PAUSE_AT_PENDING_DELIVERIES) pauseForBackpressure();
          }
          return;
        } catch (error) {
          const failure = processingFailure("journal", error, "Photon event could not be journaled.");
          const retryWait = waitBeforeRetry(journalAttempt++);
          console.error(`Photon event processing failed at ${failureSummary(failure)}. Retrying this event in ${retryWait.delay} ms.`);
          await retryWait.done;
        }
      }
    });
  });
  socket.on("delivery_error", (error: { code?: string; message?: string }) => {
    console.error("Photon delivery error. The worker will retry.");
    retry();
  });
  socket.on("connect_error", (error) => console.error("Photon connection error:", failureSummary(error)));
  if (pendingDeliveries.length >= PAUSE_AT_PENDING_DELIVERIES) pauseForBackpressure();
  else socket.connect();
  return socket;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((error) => {
    console.error("Photon worker could not start:", failureSummary(error));
    process.exitCode = 1;
  });
}
