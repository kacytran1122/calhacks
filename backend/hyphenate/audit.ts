import { createHash } from "node:crypto";
import type { Actor } from "../src/types";

export interface AuditEvent {
  seq: number;
  at: string;
  actor: Actor;
  action: string;
  subject: string;
  reason: string;
  refs: string[];
  prevHash: string;
  hash: string;
}

export interface HasAudit {
  audit: AuditEvent[];
}

const GENESIS = "0".repeat(64);

function hashOf(e: Omit<AuditEvent, "hash">): string {
  const body = JSON.stringify([e.seq, e.at, e.actor, e.action, e.subject, e.reason, e.refs, e.prevHash]);
  return createHash("sha256").update(body).digest("hex");
}

export function appendAudit(
  state: HasAudit,
  ev: { actor: Actor; action: string; subject: string; reason: string; refs?: string[]; at?: string },
): AuditEvent {
  const prev = state.audit[state.audit.length - 1];
  const partial = {
    seq: (prev?.seq ?? 0) + 1,
    at: ev.at ?? new Date().toISOString(),
    actor: ev.actor,
    action: ev.action,
    subject: ev.subject,
    reason: ev.reason,
    refs: ev.refs ?? [],
    prevHash: prev?.hash ?? GENESIS,
  };
  const full: AuditEvent = { ...partial, hash: hashOf(partial) };
  state.audit.push(full);
  return full;
}

export function verifyChain(events: AuditEvent[]): { ok: true; length: number } | { ok: false; brokenAt: number } {
  let prevHash = GENESIS;
  for (const e of events) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prevHash || hashOf(rest) !== hash) return { ok: false, brokenAt: e.seq };
    prevHash = hash;
  }
  return { ok: true, length: events.length };
}

export const actorLabel = (a: Actor): string => (a.kind === "agent" ? `agent:${a.id}` : `${a.role}:${a.id}`);
