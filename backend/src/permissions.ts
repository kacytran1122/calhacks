import { appendAudit, actorLabel } from "./audit";
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
  | "x402.pay"
  | "inbox.ask"
  | "approve";

export const AGENT_CAPS: Record<AgentId, readonly Capability[]> = {
  scout: ["web.read", "feeds.read"],
  evidence: ["web.read", "feeds.read", "x402.pay"],
  route: ["policy.read"],
  policy: ["policy.read", "ledger.read", "mandate.request", "inbox.ask"],
  payments: ["mandate.charge"],
  reconciler: ["policy.read", "ledger.read", "ledger.post", "inbox.ask"],
  auditor: ["ledger.read", "policy.read"],
  orchestrator: ["inbox.ask"],
};

export const AGENT_NEVER: Record<AgentId, string> = {
  scout: "Never logs in, reads cookies, or touches form/payment fields.",
  evidence: "Never writes to the ledger. x402 spend is capped per call and per day.",
  route: "Never picks a policy exception — it scores, the Policy agent decides.",
  policy: "Never approves its own requests (R8).",
  payments: "Never raises a mandate cap or charges an unapproved mandate.",
  reconciler: "Never approves or pays; it posts balanced entries with refs and escalates.",
  auditor: "Read-only. Can question anything, change nothing.",
  orchestrator: "Routes work and asks humans. Holds no money capabilities.",
};

export class PermissionDenied extends Error {
  readonly persistAudit = true;
}

export function authorize(state: State, actor: Actor, cap: Capability, subject: string): void {
  const allowed = actor.kind === "human" ? cap === "approve" || cap === "ledger.read" || cap === "policy.read" : AGENT_CAPS[actor.id].includes(cap);
  if (!allowed) {
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
