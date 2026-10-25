import { appendAudit, actorLabel } from "../hyphenate/audit";
import type { Actor, AgentId } from "./types";
import type { State } from "./store";

export type Capability =
  | "web.read"
  | "feeds.read"
  | "policy.read"
  | "ledger.read"
  | "ledger.post"
  | "mandate.request"
  | "mandate.charge"
  | "inbox.ask"
  | "approve"
  | "events.snapshot"
  | "model.predict"
  | "schedule.run"
  // Permission to call another agent. The callee still checks its own capabilities.
  | "events.search"
  | "trip.plan"
  | "price.estimate"
  | "heat.read"
  // Leave a note for another agent on the team board (only along TALKS_TO).
  | "agent.message";

export const AGENT_CAPS: Record<AgentId, readonly Capability[]> = {
  scout: ["web.read", "feeds.read", "agent.message"],
  evidence: ["web.read", "feeds.read", "agent.message"],
  route: ["policy.read", "agent.message"],
  policy: ["policy.read", "ledger.read", "mandate.request", "inbox.ask", "agent.message"],
  payments: ["mandate.charge", "agent.message"],
  reconciler: ["policy.read", "ledger.read", "ledger.post", "inbox.ask", "agent.message"],
  auditor: ["ledger.read", "policy.read", "agent.message"],
  orchestrator: ["inbox.ask", "agent.message"],
  discover: ["web.read", "feeds.read", "events.snapshot", "agent.message"],
  heat: ["feeds.read", "agent.message"],
  pricing: ["web.read", "feeds.read", "model.predict", "agent.message"],
  scheduler: ["schedule.run", "events.search", "price.estimate", "heat.read", "inbox.ask", "agent.message"],
  concierge: ["events.search", "trip.plan", "price.estimate", "heat.read", "agent.message"],
};

/**
 * Who may leave a note for whom on the team board. Findings flow toward the orchestrator, which
 * decides what reaches a person; the auditor and reconciler argue a decision out between them.
 * Replies follow the same lines.
 */
export const TALKS_TO: Record<AgentId, readonly AgentId[]> = {
  scheduler: ["reconciler", "pricing", "heat", "discover"],
  pricing: ["orchestrator"],
  heat: ["orchestrator"],
  discover: ["orchestrator", "scout"],
  scout: ["discover", "orchestrator"],
  evidence: ["orchestrator", "route"],
  route: ["orchestrator", "evidence"],
  policy: ["orchestrator"],
  payments: ["orchestrator"],
  reconciler: ["auditor", "orchestrator"],
  auditor: ["reconciler", "orchestrator"],
  orchestrator: ["route", "evidence", "policy", "scout", "pricing", "concierge"],
  concierge: ["orchestrator"],
};

export const AGENT_NEVER: Record<AgentId, string> = {
  scout: "Never logs in, reads cookies, or touches form/payment fields.",
  evidence: "Never writes to the ledger. It only gathers public, source-linked evidence.",
  route: "Never picks a policy exception — it scores, the Policy agent decides.",
  policy: "Never approves its own requests (R8).",
  payments: "Never raises a mandate cap or charges an unapproved mandate.",
  reconciler: "Never approves or pays; it posts balanced entries with refs and escalates. It may hold a decision for a person, never loosen one.",
  auditor: "Read-only. Can question anything and escalate through the orchestrator; changes nothing.",
  orchestrator: "Routes work between agents and decides what reaches a person. Holds no money capabilities; its questions to people approve nothing.",
  discover: "Reads public, logged-out event listings. Never signs in, registers, or RSVPs.",
  heat: "Reads public weather models and reports heat risk. Never changes a plan or a price.",
  pricing: "Reads public live fares and predicts price ranges for comparison. Never approves, books, or charges a fare.",
  scheduler: "Wakes the other agents on a timer and sends notices. Never approves, charges, or changes an amount.",
  concierge: "Picks which tools to call for a chat message. Holds no money capabilities and never states a dollar amount that code didn't compute.",
};

export class PermissionDenied extends Error {
  readonly persistAudit = true;
}

export function can(actor: Actor, cap: Capability): boolean {
  return actor.kind === "human" ? cap === "approve" || cap === "ledger.read" || cap === "policy.read" : AGENT_CAPS[actor.id].includes(cap);
}

export function authorize(state: State, actor: Actor, cap: Capability, subject: string): void {
  if (!can(actor, cap)) {
    appendAudit(state, {
      actor,
      action: "permission.denied",
      subject,
      reason: `${actorLabel(actor)} attempted "${cap}" without that capability`,
    });
    throw new PermissionDenied(`${actorLabel(actor)} may not ${cap}`);
  }
}

export function assertNotSelfApproval(state: State, approverId: string, requestedBy: string, subject: string): void {
  if (approverId === requestedBy) {
    appendAudit(state, {
      actor: { kind: "agent", id: "orchestrator" },
      action: "sod.blocked",
      subject,
      reason: `${approverId} requested this spend and tried to approve it (R8 segregation of duties)`,
      refs: ["R8", approverId],
    });
    throw new PermissionDenied(`R8: ${approverId} requested this spend and cannot approve it`);
  }
}
