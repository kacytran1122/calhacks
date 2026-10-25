
export type Cents = number;

export type AgentId =
  | "scout"
  | "evidence"
  | "route"
  | "policy"
  | "payments"
  | "reconciler"
  | "auditor"
  | "orchestrator"
  | "discover"
  | "heat"
  | "pricing"
  | "scheduler"
  | "concierge";

export type HumanRole = "traveler" | "organizer" | "controller";

export type Actor =
  | { kind: "agent"; id: AgentId }
  | { kind: "human"; id: string; role: HumanRole };

export type Provenance =
  | "live"
  | "simulated"
  | "testnet"
  | "seeded";

export type FetchStatus = "ok" | "blocked" | "empty" | "timeout" | "error";

export type EvidenceKind =
  | "event_page"
  | "traveler_constraint"
  | "geocode"
  | "weather"
  | "fare"
  | "route_guide"
  | "stop"
  | "quote"
  | "card_auth"
  | "bank_line"
  | "receipt"
  | "checkin"
  | "refund"
  | "price_watch"
  | "heat_watch"
  | "event_change";

export interface Evidence {
  id: string;
  tripId?: string;
  kind: EvidenceKind;
  source: string;
  url?: string;
  fetchedAt: string;
  status: FetchStatus;
  provenance: Provenance;
  data: Record<string, unknown>;
  note?: string;
}

export interface Traveler {
  id: string;
  initials: string;
  school: string;
  homeZip: string;
}

export interface HackEvent {
  id: string;
  name: string;
  venue: string;
  city: string;
  startsAt: string;
  url?: string;
  lat?: number;
  lon?: number;
}

export type PaymentMethod = "virtual_card" | "out_of_pocket";

export type TripState =
  | "planned"
  | "pre_approved"
  | "booked"
  | "submitted"
  | "needs_human"
  | "reimbursed"
  | "denied"
  | "closed";

export interface Approval {
  by: string;
  role: HumanRole;
  at: string;
  subject: "mandate" | "reimbursement" | "exception";
  decision: "approve" | "reject";
  note?: string;
}

export interface Trip {
  id: string;
  travelerId: string;
  eventId: string;
  period: string;
  method: PaymentMethod;
  mode: "train" | "bus" | "drive" | "rideshare" | "flight";
  distanceMiles: number;
  travelerMaxDistanceMiles?: number;
  travelerBudgetCents?: Cents;
  travelConstraintSummary?: string;
  organizerCapCents?: Cents;
  reimbursementEligibleCents?: Cents;
  quoteCents: Cents;
  mandateId?: string;
  requestedBy: string;
  approvals: Approval[];
  state: TripState;
  submittedAt?: string;
  decision?: Decision;
  arrivalMarginMin?: number;
  co2eKg?: number; // per traveler for the chosen mode, from carbon.ts
  co2eDriveAloneKg?: number; // same trip driven alone, the baseline for "avoided"
  chatRoom?: string; // the group chat it was planned in, so @smile can post updates there
}

export type DecisionCode =
  | "reimburse_full"
  | "reimburse_within_tolerance"
  | "hold_price_changed"
  | "reject_duplicate"
  | "reimburse_capped"
  | "deny_no_show"
  | "require_checkin"
  | "convert_currency"
  | "match_split_charge"
  | "trust_bank_over_receipt"
  | "recover_refund"
  | "block_self_approval"
  | "post_to_open_period";

export interface Decision {
  code: DecisionCode;
  payCents: Cents;
  reasons: string[];
  refs: string[];
  needsHuman: boolean;
  question?: string;
  explanation?: string;
  explainedBy?: "claude" | "template";
  decidedAt: string;
  decidedBy: AgentId;
}

export interface Mandate {
  id: string;
  tripId: string;
  token: string;
  maxCents: Cents;
  merchantCategory: string;
  expiresAt: string;
  singleUse: boolean;
  status: "pending" | "approved" | "consumed" | "declined" | "void";
  requestedBy: string;
  approvedBy?: string;
  approvalBinding?: {
    travelerId: string;
    eventId: string;
    fareEvidenceId: string;
    amountCents: Cents;
    currency: "USD";
    merchantCategory: string;
    approvedAt: string;
    fingerprint: string;
  };
  authorization?: {
    idempotencyKey: string;
    provider: "visa_acceptance" | "simulated";
    providerReference?: string;
    status: "authorized" | "declined";
    amountCents: Cents;
    authorizedAt: string;
  };
  provenance: "simulated";
}

export interface InboxItem {
  id: string;
  kind: "mandate_approval" | "reconcile" | "notice";
  tripId: string;
  meta: { code?: DecisionCode; amountCents?: Cents; topic?: string };
  createdAt: string;
  askedOf: HumanRole;
  question: string;
  options: { id: string; label: string }[];
  status: "open" | "answered";
  answer?: { by: string; option: string; note?: string; at: string };
}

export interface Person {
  id: string;
  name: string;
  role: HumanRole;
  title: string;
}

/**
 * A note from one agent to another on the team board (agents/board.ts): a finding to act on, a
 * task to do, or a reply to a task. `data` carries facts code computed; `text` is what the sender
 * wrote. Who may write to whom is fixed in permissions.ts.
 */
export interface BoardMessage {
  id: string;
  at: string;
  from: AgentId;
  to: AgentId;
  topic: string;
  subject: string;
  text: string;
  data: Record<string, unknown>;
  /** The sender wants the receiver's answer posted back to it when the receiver is done. */
  wantsReply?: boolean;
  replyTo?: string;
  /** Hand-offs since the first message in this chain. */
  depth: number;
  status: "open" | "working" | "done" | "failed";
  claimedAt?: string;
  result?: string;
  handledBy?: "claude" | "code";
  doneAt?: string;
}
