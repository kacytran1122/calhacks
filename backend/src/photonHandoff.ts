import { createHash, createHmac, randomBytes as secureRandomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR } from "./store";

const CLAIM_TTL_MS = 15 * 60 * 1_000;
const MAP_TTL_MS = 12 * 60 * 60 * 1_000;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_PATTERN = /SMILE-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}/;
const MAP_TOKEN_PATTERN = /^phm1_[A-Za-z0-9_-]{43}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photon_handoffs (
  code_hash TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  traveler_id TEXT NOT NULL,
  code_expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  claimed_by_hash TEXT,
  map_token_hash TEXT UNIQUE,
  map_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK ((claimed_at IS NULL AND claimed_by_hash IS NULL AND map_token_hash IS NULL AND map_expires_at IS NULL)
      OR (claimed_at IS NOT NULL AND claimed_by_hash IS NOT NULL AND map_token_hash IS NOT NULL AND map_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS photon_handoffs_map_token ON photon_handoffs(map_token_hash);
CREATE INDEX IF NOT EXISTS photon_handoffs_expiry ON photon_handoffs(code_expires_at, map_expires_at);
CREATE TABLE IF NOT EXISTS photon_trip_bindings (
  identity_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  traveler_id TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photon_trip_bindings_trip ON photon_trip_bindings(trip_id, traveler_id);
`;

export class PhotonHandoffError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

export class PhotonHandoffStorageUnavailable extends PhotonHandoffError {
  constructor() {
    super("The secure iMessage handoff is temporarily unavailable. Please try again.", 503, "HANDOFF_STORAGE_UNAVAILABLE", 5);
  }
}

export type PhotonHandoffJoinResult = {
  messageUrl: string;
  starterMessage: string;
  expiresAt: string;
};

export type PhotonHandoffIdentity = {
  projectId: string;
  spaceId: string;
  senderId: string;
};

/** Server-only trip context bound to one direct Photon conversation. */
export type PhotonTripBinding = {
  tripId: string;
  travelerId: string;
  boundAt: string;
  mapPath?: string;
  expiresAt?: string;
};

export type PhotonHandoffClaim =
  | { kind: "none" }
  | { kind: "invalid" | "expired" | "used" }
  | { kind: "ready"; mapPath: string; expiresAt: string; reused: boolean; scope: PhotonTripBinding };

export type PhotonMapHandoff = {
  tripId: string;
  travelerId: string;
  expiresAt: string;
};

type HandoffRuntime = {
  env?: NodeJS.ProcessEnv;
  database?: string;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

type Row = {
  trip_id: string;
  traveler_id: string;
  code_expires_at: number;
  claimed_at: number | null;
  claimed_by_hash: string | null;
  map_token_hash: string | null;
  map_expires_at: number | null;
};

type BindingRow = {
  code_hash: string;
  trip_id: string;
  traveler_id: string;
  bound_at: number;
  map_token_hash: string | null;
  map_expires_at: number | null;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function secretFrom(env: NodeJS.ProcessEnv): string {
  const secret = env.PHOTON_BRIDGE_SECRET?.trim() ?? "";
  if (secret.length < 16) {
    throw new PhotonHandoffError("The secure iMessage handoff is not configured yet.", 503, "HANDOFF_NOT_CONFIGURED");
  }
  return secret;
}

function lineFrom(env: NodeJS.ProcessEnv): string {
  const line = env.PHOTON_LINE_ADDRESS?.trim() ?? "";
  if (!/^\+[1-9]\d{7,14}$/.test(line)) {
    throw new PhotonHandoffError("A Photon iMessage line has not been configured yet.", 503, "LINE_NOT_CONFIGURED");
  }
  return line;
}

function databaseFrom(runtime: HandoffRuntime): string {
  if (runtime.database) return path.resolve(runtime.database);
  const env = runtime.env ?? process.env;
  if (env.VERCEL) {
    throw new PhotonHandoffError("The secure iMessage handoff must run on the persistent web service.", 503, "PERSISTENT_STORAGE_REQUIRED");
  }
  return path.join(DATA_DIR, "photon-handoffs.db");
}

function open(runtime: HandoffRuntime): DatabaseSync {
  const file = databaseFrom(runtime);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    if (error instanceof PhotonHandoffError) throw error;
    throw new PhotonHandoffStorageUnavailable();
  }
}

function assertScope(tripId: string, travelerId: string): void {
  const valid = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
  if (!valid(tripId) || !valid(travelerId)) {
    throw new PhotonHandoffError("This trip cannot create a secure iMessage handoff.", 400, "INVALID_TRIP_SCOPE");
  }
}

function randomCode(bytes: Buffer): string {
  if (bytes.length < 16) throw new Error("Photon handoff randomness is too short.");
  const raw = [...bytes.subarray(0, 16)].map((value) => CODE_ALPHABET[value & 31]).join("");
  return `SMILE-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function identityHash(secret: string, identity: PhotonHandoffIdentity): string {
  return createHmac("sha256", secret)
    .update("smile-photon-sender-v1\0")
    .update(identity.projectId).update("\0")
    .update(identity.spaceId).update("\0")
    .update(identity.senderId)
    .digest("hex");
}

function mapToken(secret: string, codeKey: string, claimant: string): string {
  const value = createHmac("sha256", secret)
    .update("smile-photon-map-v1\0")
    .update(codeKey).update("\0")
    .update(claimant)
    .digest("base64url");
  return `phm1_${value}`;
}

function saveBinding(db: DatabaseSync, claimant: string, codeHash: string, row: Pick<Row, "trip_id" | "traveler_id">, now: number): void {
  db.prepare(`
    INSERT INTO photon_trip_bindings (identity_hash, code_hash, trip_id, traveler_id, bound_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(identity_hash) DO UPDATE SET
      code_hash = excluded.code_hash,
      trip_id = excluded.trip_id,
      traveler_id = excluded.traveler_id,
      bound_at = CASE
        WHEN photon_trip_bindings.code_hash = excluded.code_hash THEN photon_trip_bindings.bound_at
        ELSE excluded.bound_at
      END,
      updated_at = excluded.updated_at
  `).run(claimant, codeHash, row.trip_id, row.traveler_id, now, now);
}

function bindingFromRow(secret: string, claimant: string, row: BindingRow, now: number): PhotonTripBinding {
  const currentToken = mapToken(secret, row.code_hash, claimant);
  const activeMap = Boolean(
    row.map_expires_at
    && row.map_expires_at > now
    && row.map_token_hash === sha256(currentToken),
  );
  return {
    tripId: row.trip_id,
    travelerId: row.traveler_id,
    boundAt: new Date(row.bound_at).toISOString(),
    ...(activeMap ? {
      mapPath: `/map?handoff=${currentToken}`,
      expiresAt: new Date(row.map_expires_at!).toISOString(),
    } : {}),
  };
}

function codeFromMessage(text: string): { kind: "none" | "invalid" | "code"; code?: string } {
  const command = /(?:^|\s)@smile\s+open\s+my\s+route\b/iu;
  if (!command.test(text)) return { kind: "none" };
  const match = text.toUpperCase().match(new RegExp(`(?:^|\\s)@SMILE\\s+OPEN\\s+MY\\s+ROUTE\\s+(${CODE_PATTERN.source})(?=$|\\s|[.!?,])`, "u"));
  return match?.[1] ? { kind: "code", code: match[1] } : { kind: "invalid" };
}

/**
 * Creates a short-lived, trip-scoped claim code for a prefilled Messages QR.
 * The browser receives neither the original trip token nor a Photon API key.
 */
export function createPhotonTripHandoff(
  scope: { tripId: string; travelerId: string },
  runtime: HandoffRuntime = {},
): PhotonHandoffJoinResult {
  assertScope(scope.tripId, scope.travelerId);
  const env = runtime.env ?? process.env;
  const line = lineFrom(env);
  secretFrom(env);
  const now = (runtime.now ?? (() => new Date()))().getTime();
  const expiresAt = now + CLAIM_TTL_MS;
  const bytes = runtime.randomBytes ?? secureRandomBytes;
  const db = open(runtime);
  let code = "";
  try {
    db.prepare("DELETE FROM photon_handoffs WHERE COALESCE(map_expires_at, code_expires_at) < ?").run(now - 7 * 24 * 60 * 60 * 1_000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      code = randomCode(bytes(16));
      try {
        db.prepare("INSERT INTO photon_handoffs (code_hash, trip_id, traveler_id, code_expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(sha256(code), scope.tripId, scope.travelerId, expiresAt, now);
        break;
      } catch (error) {
        if (!/UNIQUE|PRIMARY KEY|constraint/i.test((error as Error).message)) throw error;
        code = "";
      }
    }
  } catch (error) {
    if (error instanceof PhotonHandoffError) throw error;
    throw new PhotonHandoffStorageUnavailable();
  } finally {
    db.close();
  }
  if (!code) throw new PhotonHandoffStorageUnavailable();
  const starterMessage = `@smile open my route ${code}`;
  return {
    messageUrl: `sms:${line}?&body=${encodeURIComponent(starterMessage)}`,
    starterMessage,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

/** Claim a QR code from the direct Photon sender. Raw sender identities are never stored. */
export function claimPhotonTripHandoff(
  text: string,
  identity: PhotonHandoffIdentity,
  runtime: HandoffRuntime = {},
): PhotonHandoffClaim {
  const parsed = codeFromMessage(text);
  if (parsed.kind !== "code") return { kind: parsed.kind };
  const env = runtime.env ?? process.env;
  const secret = secretFrom(env);
  const claimant = identityHash(secret, identity);
  const code = parsed.code!;
  const codeHash = sha256(code);
  // New claims derive the bearer from the non-reversible code hash, allowing the
  // same direct conversation to recover its active route without storing a raw bearer.
  const token = mapToken(secret, codeHash, claimant);
  const legacyToken = mapToken(secret, code, claimant);
  const tokenHash = sha256(token);
  const now = (runtime.now ?? (() => new Date()))().getTime();
  const db = open(runtime);
  try {
    db.exec("BEGIN IMMEDIATE");
    const row = db.prepare("SELECT trip_id, traveler_id, code_expires_at, claimed_at, claimed_by_hash, map_token_hash, map_expires_at FROM photon_handoffs WHERE code_hash = ?")
      .get(codeHash) as Row | undefined;
    if (!row) {
      db.exec("COMMIT");
      return { kind: "invalid" };
    }
    if (row.claimed_at !== null) {
      if (row.claimed_by_hash !== claimant) {
        db.exec("COMMIT");
        return { kind: "used" };
      }
      const replayToken = row.map_token_hash === tokenHash
        ? token
        : row.map_token_hash === sha256(legacyToken)
          ? legacyToken
          : undefined;
      if (!row.map_expires_at || row.map_expires_at <= now || !replayToken) {
        db.exec("COMMIT");
        return { kind: "expired" };
      }
      saveBinding(db, claimant, codeHash, row, now);
      db.exec("COMMIT");
      return {
        kind: "ready",
        mapPath: `/map?handoff=${replayToken}`,
        expiresAt: new Date(row.map_expires_at).toISOString(),
        reused: true,
        scope: {
          tripId: row.trip_id,
          travelerId: row.traveler_id,
          boundAt: new Date(row.claimed_at).toISOString(),
          mapPath: `/map?handoff=${replayToken}`,
          expiresAt: new Date(row.map_expires_at).toISOString(),
        },
      };
    }
    if (row.code_expires_at <= now) {
      db.exec("COMMIT");
      return { kind: "expired" };
    }
    const mapExpiresAt = now + MAP_TTL_MS;
    db.prepare("UPDATE photon_handoffs SET claimed_at = ?, claimed_by_hash = ?, map_token_hash = ?, map_expires_at = ? WHERE code_hash = ? AND claimed_at IS NULL")
      .run(now, claimant, tokenHash, mapExpiresAt, codeHash);
    saveBinding(db, claimant, codeHash, row, now);
    db.exec("COMMIT");
    const mapPath = `/map?handoff=${token}`;
    return {
      kind: "ready",
      mapPath,
      expiresAt: new Date(mapExpiresAt).toISOString(),
      reused: false,
      scope: {
        tripId: row.trip_id,
        travelerId: row.traveler_id,
        boundAt: new Date(now).toISOString(),
        mapPath,
        expiresAt: new Date(mapExpiresAt).toISOString(),
      },
    };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* the transaction may already be closed */ }
    if (error instanceof PhotonHandoffError) throw error;
    throw new PhotonHandoffStorageUnavailable();
  } finally {
    db.close();
  }
}

/** Recover the latest trip bound to this direct Photon conversation. */
export function photonTripBinding(
  identity: PhotonHandoffIdentity,
  runtime: HandoffRuntime = {},
): PhotonTripBinding | null {
  const secret = secretFrom(runtime.env ?? process.env);
  const claimant = identityHash(secret, identity);
  const now = (runtime.now ?? (() => new Date()))().getTime();
  const db = open(runtime);
  try {
    const row = db.prepare(`
      SELECT b.code_hash, b.trip_id, b.traveler_id, b.bound_at, h.map_token_hash, h.map_expires_at
      FROM photon_trip_bindings b
      LEFT JOIN photon_handoffs h ON h.code_hash = b.code_hash
      WHERE b.identity_hash = ?
    `).get(claimant) as BindingRow | undefined;
    return row ? bindingFromRow(secret, claimant, row, now) : null;
  } catch (error) {
    if (error instanceof PhotonHandoffError) throw error;
    throw new PhotonHandoffStorageUnavailable();
  } finally {
    db.close();
  }
}

/** Resolve the opaque map bearer. Returns no sender identity and never reveals it to the browser. */
export function resolvePhotonMapHandoff(token: unknown, runtime: HandoffRuntime = {}): PhotonMapHandoff | null {
  if (typeof token !== "string" || !MAP_TOKEN_PATTERN.test(token)) return null;
  secretFrom(runtime.env ?? process.env);
  const now = (runtime.now ?? (() => new Date()))().getTime();
  const db = open(runtime);
  try {
    const row = db.prepare("SELECT trip_id, traveler_id, map_expires_at FROM photon_handoffs WHERE map_token_hash = ? AND claimed_at IS NOT NULL")
      .get(sha256(token)) as Pick<Row, "trip_id" | "traveler_id" | "map_expires_at"> | undefined;
    if (!row?.map_expires_at || row.map_expires_at <= now) return null;
    return { tripId: row.trip_id, travelerId: row.traveler_id, expiresAt: new Date(row.map_expires_at).toISOString() };
  } catch (error) {
    if (error instanceof PhotonHandoffError) throw error;
    throw new PhotonHandoffStorageUnavailable();
  } finally {
    db.close();
  }
}

export function photonHandoffFingerprint(value: string): string {
  return sha256(value);
}

export const PHOTON_HANDOFF_MAP_TOKEN_PATTERN = MAP_TOKEN_PATTERN;
