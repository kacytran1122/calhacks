/**
 * Who is acting. The books never take a person's identity or role from a request body:
 * it comes from a server-side session (staff and seeded travelers) or from a trip-scoped
 * approval token handed only to the traveler who planned that trip (Lens / web planner).
 *
 * Sign-ins live in their own database (.data/auth.db), so resetting the books doesn't
 * reset who can sign in. Passwords are scrypt-hashed; tokens are stored only as SHA-256.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { appendAudit } from "./audit";
import { PermissionDenied } from "./permissions";
import { TEST_USERS } from "./seed/users";
import type { State } from "./store";
import { DATA_DIR } from "./store";
import type { HumanRole } from "./types";

export interface User {
  id: string;
  personId: string;
  role: HumanRole;
  name: string;
}

const AUTH_FILE = path.join(DATA_DIR, "auth.db");
const SESSION_HOURS = 12;
const TRIP_TOKEN_HOURS = 24;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => randomBytes(32).toString("base64url");

function open(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(AUTH_FILE);
  db.exec(`
    PRAGMA busy_timeout = 10000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, person_id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('controller', 'organizer', 'traveler')),
      name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS trip_tokens (
      token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL, traveler_id TEXT NOT NULL, expires_at TEXT NOT NULL);
  `);
  return db;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

/** Create the test-only accounts from seed/users.ts if they aren't there yet. */
export function ensureUsers(): void {
  const db = open();
  try {
    const insert = db.prepare("INSERT OR IGNORE INTO users (id, person_id, role, name, salt, hash) VALUES (?, ?, ?, ?, ?, ?)");
    const exists = db.prepare("SELECT 1 FROM users WHERE id = ?");
    for (const u of TEST_USERS) {
      if (exists.get(u.id)) continue;
      const salt = randomBytes(16).toString("hex");
      insert.run(u.id, u.personId, u.role, u.name, salt, hashPassword(u.password, salt));
    }
  } finally {
    db.close();
  }
}

// Simple lockout: 5 failures per sign-in name per 10 minutes.
const failures = new Map<string, number[]>();
export class TooManyAttempts extends Error {}

export function login(id: string, password: string): { token: string; user: User; expiresAt: string } | null {
  const key = id.toLowerCase();
  const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < 600_000);
  if (recent.length >= 5) throw new TooManyAttempts("too many failed sign-ins — wait 10 minutes");
  ensureUsers();
  const db = open();
  try {
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(key) as Record<string, string> | undefined;
    // Always run scrypt so a missing user and a wrong password take the same time.
    const candidate = Buffer.from(hashPassword(password, row?.salt ?? "no-such-user"), "hex");
    const stored = Buffer.from(row?.hash ?? "00".repeat(32), "hex");
    if (!row || !timingSafeEqual(candidate, stored)) {
      failures.set(key, [...recent, Date.now()]);
      return null;
    }
    failures.delete(key);
    const t = token();
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha(t), row.id!, new Date().toISOString(), expiresAt);
    return { token: t, user: { id: row.id!, personId: row.person_id!, role: row.role as HumanRole, name: row.name! }, expiresAt };
  } finally {
    db.close();
  }
}

export function userForSession(t: string | undefined): User | null {
  if (!t) return null;
  const db = open();
  try {
    const row = db
      .prepare("SELECT u.id, u.person_id, u.role, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?")
      .get(sha(t)) as Record<string, string> | undefined;
    if (!row || new Date(row.expires_at!) < new Date()) return null;
    return { id: row.id!, personId: row.person_id!, role: row.role as HumanRole, name: row.name! };
  } finally {
    db.close();
  }
}

export function logout(t: string | undefined): void {
  if (!t) return;
  const db = open();
  try {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(t));
  } finally {
    db.close();
  }
}

/** Handed only to whoever planned the trip; lets them approve that trip's mandate, nothing else. */
export function issueTripToken(tripId: string, travelerId: string): string {
  const t = token();
  const db = open();
  try {
    db.prepare("INSERT INTO trip_tokens (token_hash, trip_id, traveler_id, expires_at) VALUES (?, ?, ?, ?)").run(sha(t), tripId, travelerId, new Date(Date.now() + TRIP_TOKEN_HOURS * 3_600_000).toISOString());
  } finally {
    db.close();
  }
  return t;
}

/** The traveler a trip token speaks for — only for that trip, only before it expires. */
export function travelerForTripToken(t: string | undefined, tripId: string): string | null {
  if (!t) return null;
  const db = open();
  try {
    const row = db.prepare("SELECT traveler_id, trip_id, expires_at FROM trip_tokens WHERE token_hash = ?").get(sha(t)) as Record<string, string> | undefined;
    if (!row || row.trip_id !== tripId || new Date(row.expires_at!) < new Date()) return null;
    return row.traveler_id!;
  } finally {
    db.close();
  }
}

/**
 * If a request also claims an identity, it must match the session. A mismatch is not
 * silently corrected — it's recorded as an attempted forgery and refused.
 */
export function assertClaimMatches(state: State, user: User, claimed: { personId?: string; role?: string } | undefined, subject: string): void {
  if (!claimed || (claimed.personId === undefined && claimed.role === undefined)) return;
  const forged = (claimed.personId !== undefined && claimed.personId !== user.personId) || (claimed.role !== undefined && claimed.role !== user.role);
  if (!forged) return;
  appendAudit(state, {
    actor: { kind: "human", id: user.personId, role: user.role },
    action: "identity.forged",
    subject,
    reason: `Signed in as ${user.personId} (${user.role}) but the request claimed ${claimed.personId ?? user.personId} (${claimed.role ?? user.role})`,
    refs: [user.personId],
  });
  throw new PermissionDenied(`you are signed in as ${user.name} (${user.role}); a request can't claim another identity`);
}
