import { createHash, createHmac } from "node:crypto";
import { ApiError, Photon, type SharedLineAssignment } from "@photon-ai/api";

const DEFAULT_API_ORIGIN = "https://api.photon.codes";
const STARTER_MESSAGE = "@smile I’m planning a trip. My home ZIP is _____ and the event link is _____.";

export class PhotonJoinError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export type PhotonJoinResult = {
  assignedPhoneNumber: string;
  messageUrl: string;
  starterMessage: string;
  reused: boolean;
};

type AssignmentClient = Pick<Photon, "projects">;
type JoinRuntime = {
  client?: AssignmentClient;
  env?: NodeJS.ProcessEnv;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Photon requires the exact identity selected in Messages → Send & Receive.
 * We accept a reasonably formatted North American number, strict E.164, or an
 * Apple Account email and send Photon only the normalized value.
 */
export function normalizeImessageHandle(input: unknown): string {
  if (typeof input !== "string" || input.length > 254 || /[\u0000-\u001F\u007F]/.test(input)) {
    throw new PhotonJoinError("Enter a valid iMessage phone number or Apple Account email.", 400, "INVALID_HANDLE");
  }
  const value = input.trim();
  if (!value) throw new PhotonJoinError("Enter the phone number or Apple Account email you send iMessages from.", 400, "INVALID_HANDLE");

  if (value.includes("@")) {
    const email = value.toLowerCase();
    const parts = email.split("@");
    const local = parts[0] ?? "";
    const domain = parts[1] ?? "";
    if (parts.length !== 2 || !local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(domain) || !domain.includes(".")) {
      throw new PhotonJoinError("Enter a valid Apple Account email.", 400, "INVALID_HANDLE");
    }
    return email;
  }

  let phone = value.replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(phone)) phone = `+1${phone}`;
  else if (/^1\d{10}$/.test(phone)) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new PhotonJoinError("Use a U.S. 10-digit number or an international number beginning with + and the country code.", 400, "INVALID_HANDLE");
  }
  return phone;
}

function configuration(env: NodeJS.ProcessEnv) {
  const projectId = env.PHOTON_PROJECT_ID?.trim() ?? "";
  const apiKey = env.PHOTON_API_KEY?.trim() ?? "";
  const bridgeSecret = env.PHOTON_BRIDGE_SECRET?.trim() ?? "";
  if (!/^pho_prj_[A-Za-z0-9_-]+$/.test(projectId) || !/^pho_sk_[A-Za-z0-9_-]+$/.test(apiKey) || bridgeSecret.length < 16) {
    throw new PhotonJoinError("Private iMessage setup is not available yet.", 503, "NOT_CONFIGURED");
  }
  return {
    projectId,
    apiKey,
    bridgeSecret,
    apiOrigin: (env.PHOTON_API_ORIGIN?.trim() || DEFAULT_API_ORIGIN).replace(/\/$/, ""),
  };
}

function assignmentNumber(value: SharedLineAssignment): string {
  const number = value.assignedPhoneNumber.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(number) || value.platform !== "imessage" || value.releasedAt) {
    throw new PhotonJoinError("Photon did not return an active iMessage number.", 503, "INVALID_ASSIGNMENT");
  }
  return number;
}

async function findAssignment(client: AssignmentClient, projectId: string, handle: string): Promise<SharedLineAssignment | undefined> {
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await client.projects.platforms.imessage.assignments.list({
      path: { id: projectId },
      query: { pageSize: 100, ...(pageToken ? { pageToken } : {}) },
    });
    const match = result.assignments.find((assignment) => !assignment.releasedAt && assignment.platform === "imessage" && assignment.handle.toLowerCase() === handle.toLowerCase());
    if (match) return match;
    pageToken = result.nextPageToken;
    if (!pageToken) return undefined;
  }
  throw new PhotonJoinError("Photon has too many assignment pages to search safely.", 503, "ASSIGNMENT_LOOKUP_LIMIT");
}

function apiCode(error: unknown): string | undefined {
  return error instanceof ApiError && isRecord(error.body) && typeof error.body.code === "string" ? error.body.code : undefined;
}

function safePhotonError(error: unknown): never {
  const status = error instanceof ApiError ? error.status : undefined;
  const code = apiCode(error);
  if (code === "SHARED_LINE_CAP_EXCEEDED") {
    throw new PhotonJoinError("All shared iMessage seats are in use. Try again later or ask the organizer to add capacity.", 503, code);
  }
  if (["SHARED_LINE_POOL_EXHAUSTED", "BILLING_NOT_PROVISIONED", "BILLING_ENTITLEMENTS_PENDING", "IMESSAGE_MODE_DEDICATED"].includes(code ?? "")) {
    throw new PhotonJoinError("Photon cannot assign a private iMessage line right now.", 503, code ?? "PHOTON_UNAVAILABLE");
  }
  if (status === 401 || status === 403) {
    throw new PhotonJoinError("The Photon server key needs platforms:read and platforms:write access.", 503, "PHOTON_PERMISSION");
  }
  if (status === 429) throw new PhotonJoinError("Photon is receiving too many requests. Try again shortly.", 429, "PHOTON_RATE_LIMIT", 60);
  if (status === 422) throw new PhotonJoinError("Photon could not use that iMessage identity. Check Messages → Send & Receive and try again.", 400, code ?? "PHOTON_VALIDATION");
  throw new PhotonJoinError("Photon could not create the private iMessage connection. Try again shortly.", 503, code ?? "PHOTON_UNAVAILABLE");
}

/** Create or reuse the visitor-specific shared-line assignment. */
export async function assignPhotonDirectChat(input: unknown, runtime: JoinRuntime = {}): Promise<PhotonJoinResult> {
  const handle = normalizeImessageHandle(input);
  const config = configuration(runtime.env ?? process.env);
  const client = runtime.client ?? new Photon({
    baseUrl: config.apiOrigin,
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });

  try {
    const existing = await findAssignment(client, config.projectId, handle);
    let assignment = existing;
    if (!assignment) {
      const idempotencyKey = `smile-join-${createHmac("sha256", config.bridgeSecret).update(`${config.projectId}\n${handle}`).digest("hex")}`;
      try {
        assignment = await client.projects.platforms.imessage.assignments.create({
          path: { id: config.projectId },
          headers: { idempotencyKey },
          body: { handle },
        });
      } catch (error) {
        if (apiCode(error) !== "ASSIGNMENT_EXISTS") throw error;
        assignment = await findAssignment(client, config.projectId, handle);
        if (!assignment) throw error;
      }
    }
    const assignedPhoneNumber = assignmentNumber(assignment);
    return {
      assignedPhoneNumber,
      messageUrl: `sms:${assignedPhoneNumber}`,
      starterMessage: STARTER_MESSAGE,
      reused: Boolean(existing),
    };
  } catch (error) {
    if (error instanceof PhotonJoinError) throw error;
    safePhotonError(error);
  }
}

export function photonJoinFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
