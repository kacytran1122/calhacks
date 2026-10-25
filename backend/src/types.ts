
export type Cents = number;

export type AgentId =
  | "scout"
  | "evidence"
  | "route"
  | "policy"
  | "payments"
  | "reconciler"
  | "auditor"
  | "orchestrator";

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
  | "refund";

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
  kind: "mandate_approval" | "reconcile";
  tripId: string;
  meta: { code?: DecisionCode; amountCents?: Cents };
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
