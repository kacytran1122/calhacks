import { actorLabel, appendAudit } from "../../hyphenate/audit";
import { authorize, can, type Capability } from "../permissions";
import { withState, type State } from "../store";
import type { Actor, AgentId } from "../types";

/**
 * One call to a registered agent. The caller, when there is one, must hold the capability that
 * lets it ask; the agent must hold every capability its work needs. Each call is written to the
 * audit chain whether it succeeds, fails, or is refused.
 */
export interface AgentCall<T> {
  agent: AgentId;
  needs: Capability[];
  action: string;
  subject: string;
  on?: { actor: Actor; cap: Capability };
  summarize: (out: T) => string;
  refs?: (out: T) => string[];
}

type Who = Pick<AgentCall<unknown>, "agent" | "needs" | "subject" | "on">;

const self = (call: Who): Actor => ({ kind: "agent", id: call.agent });

function check(state: State, call: Who) {
  if (call.on) authorize(state, call.on.actor, call.on.cap, call.subject);
  for (const cap of call.needs) authorize(state, self(call), cap, call.subject);
}

const allowed = (call: Who) => (!call.on || can(call.on.actor, call.on.cap)) && call.needs.every((cap) => can(self(call), cap));

function record<T>(state: State, call: AgentCall<T>, out: { ok: true; value: T } | { ok: false; error: unknown }) {
  const via = call.on ? ` (asked by ${actorLabel(call.on.actor)})` : "";
  if (out.ok) appendAudit(state, { actor: self(call), action: call.action, subject: call.subject, reason: `${call.summarize(out.value)}${via}`, refs: call.refs?.(out.value) });
  else appendAudit(state, { actor: self(call), action: `${call.action}.failed`, subject: call.subject, reason: `${out.error instanceof Error ? out.error.message : String(out.error)}${via}` });
}

/** For work that already holds the books (scheduler jobs, trip planning). */
export async function runAgentIn<T>(state: State, call: AgentCall<T>, work: () => Promise<T>): Promise<T> {
  check(state, call);
  try {
    const value = await work();
    record(state, call, { ok: true, value });
    return value;
  } catch (error) {
    record(state, call, { ok: false, error });
    throw error;
  }
}

/** Runs the work without holding the books, so slow network calls never block the ledger. */
export async function runAgent<T>(call: AgentCall<T>, work: () => Promise<T>): Promise<T> {
  if (!allowed(call)) await withState((s) => check(s, call)); // records the denial, then throws
  let value: T;
  try {
    value = await work();
  } catch (error) {
    await withState((s) => record(s, call, { ok: false, error })).catch(() => undefined);
    throw error;
  }
  await withState((s) => record(s, call, { ok: true, value }));
  return value;
}
