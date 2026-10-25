import { appendAudit } from "../../hyphenate/audit";
import { authorize, PermissionDenied, TALKS_TO } from "../permissions";
import { newId, type State } from "../store";
import type { AgentId, BoardMessage } from "../types";

/**
 * The team board: how agents hand work to each other. A message is a finding ("price moved 18%"),
 * a task ("check this event page"), or the reply to a task. Posting needs the agent.message
 * capability and a line in TALKS_TO; every post is written to the audit chain. Chains of hand-offs
 * stop at MAX_DEPTH, so agents can't keep each other busy forever.
 */

export const MAX_DEPTH = 4;
/** A message being handled for longer than this is assumed abandoned and can be picked up again. */
const STALE_MS = 10 * 60_000;
const KEEP_CLOSED = 400;

export interface Post {
  from: AgentId;
  to: AgentId;
  topic: string;
  subject: string;
  text: string;
  data?: Record<string, unknown>;
  wantsReply?: boolean;
  replyTo?: BoardMessage;
}

const short = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function canMessage(from: AgentId, to: AgentId): boolean {
  return TALKS_TO[from].includes(to);
}

/** Leave a note for another agent. Returns null when it's a duplicate of an open note or the chain is too long. */
export function post(state: State, p: Post): BoardMessage | null {
  const actor = { kind: "agent" as const, id: p.from };
  authorize(state, actor, "agent.message", p.subject);
  if (!canMessage(p.from, p.to)) {
    appendAudit(state, { actor, action: "permission.denied", subject: p.subject, reason: `agent:${p.from} may not message agent:${p.to}` });
    throw new PermissionDenied(`agent:${p.from} may not message agent:${p.to}`);
  }
  const depth = p.replyTo ? p.replyTo.depth + 1 : 0;
  if (depth > MAX_DEPTH) {
    appendAudit(state, { actor, action: "board.dropped", subject: p.subject, reason: `Not sent to agent:${p.to}: ${MAX_DEPTH} hand-offs already in this chain`, refs: [p.replyTo!.id] });
    return null;
  }
  const board = (state.board ??= []);
  const text = p.text.trim().slice(0, 2_000);
  if (board.some((m) => (m.status === "open" || m.status === "working") && m.from === p.from && m.to === p.to && m.topic === p.topic && m.subject === p.subject && m.text === text)) return null;
  const m: BoardMessage = {
    id: newId("B"),
    at: new Date().toISOString(),
    from: p.from,
    to: p.to,
    topic: p.topic,
    subject: p.subject,
    text,
    data: p.data ?? {},
    wantsReply: p.wantsReply || undefined,
    replyTo: p.replyTo?.id,
    depth,
    status: "open",
  };
  board.push(m);
  appendAudit(state, { actor, action: "agent.messaged", subject: p.subject, reason: `To agent:${p.to} (${p.topic}): ${short(text)}`, refs: [m.id, ...(p.replyTo ? [p.replyTo.id] : [])] });
  // Keep every open note and the most recent closed ones.
  const closed = board.filter((x) => x.status === "done" || x.status === "failed");
  if (closed.length > KEEP_CLOSED) {
    const drop = new Set(closed.slice(0, closed.length - KEEP_CLOSED).map((x) => x.id));
    state.board = board.filter((x) => !drop.has(x.id));
  }
  return m;
}

/** Take the oldest open note (or one abandoned mid-handling) so no one else handles it at the same time. */
export function claimNext(state: State, now = new Date()): BoardMessage | null {
  const board = state.board ?? [];
  const m = board.find((x) => x.status === "open" || (x.status === "working" && now.getTime() - new Date(x.claimedAt ?? x.at).getTime() > STALE_MS));
  if (!m) return null;
  m.status = "working";
  m.claimedAt = now.toISOString();
  return structuredClone(m);
}

export function close(state: State, id: string, outcome: { ok: boolean; result: string; by: "claude" | "code" }): BoardMessage | undefined {
  const m = state.board?.find((x) => x.id === id);
  if (!m) return undefined;
  m.status = outcome.ok ? "done" : "failed";
  m.result = outcome.result.trim().slice(0, 2_000);
  m.handledBy = outcome.by;
  m.doneAt = new Date().toISOString();
  appendAudit(state, { actor: { kind: "agent", id: m.to }, action: outcome.ok ? "agent.handled" : "agent.handled.failed", subject: m.subject, reason: `${m.topic} from agent:${m.from} (${outcome.by === "claude" ? "Claude" : "code"}): ${short(m.result)}`, refs: [m.id] });
  return m;
}

/** Notes still waiting for an agent. */
export const openNotes = (state: State) => (state.board ?? []).filter((m) => m.status === "open" || m.status === "working");
