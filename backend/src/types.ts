// Domain model for the Golden Gate Hack travel desk.
// All money is integer cents (USD) unless a field says otherwise.

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

/** Where a fact came from. Shown on every value in the UI. */
export type Provenance =
  | "live" // fetched from the real public web / an official API during this run
  | "simulated" // Visa mandate + card network (clearly labeled, not real money)
  | "testnet" // Coinbase x402 on Base Sepolia
  | "seeded"; // the company's historical books (synthetic, with planted errors)

export type FetchStatus = "ok" | "blocked" | "empty" | "timeout" | "error";

export type EvidenceKind =
  | "event_page"
  | "geocode"
  | "weather"
  | "fare"
  | "stop"
  | "quote"
  | "card_auth"
  | "bank_line"
  | "receipt"
  | "checkin"
  | "refund"
  | "x402_purchase";

export interface Evidence {
  id: string;
  tripId?: string;
  kind: EvidenceKind;
  source: string; // human-readable source name, e.g. "Bright Data Web Unlocker → luma.com"
  url?: string;
  fetchedAt: string; // ISO
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
  startsAt: string; // ISO
  url?: string;
  lat?: number;
  lon?: number;
}

export type PaymentMethod = "virtual_card" | "out_of_pocket";

export type TripState =
  | "planned" // route chosen, quote exists, mandate pending approval
  | "pre_approved" // traveler (and controller if needed) approved the exact quote
  | "booked" // virtual card charged / traveler paid
  | "submitted" // receipts + bank lines are in; ready to reconcile
  | "needs_human" // reconciler escalated with a specific question
  | "reimbursed" // books posted, payout done
  | "denied"
  | "closed";

export interface Approval {
  by: string; // person id
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
  period: string; // accounting period the trip belongs to, "2026-06"
  method: PaymentMethod;
  mode: "train" | "bus" | "drive" | "rideshare" | "flight";
  distanceMiles: number;
  /** Traveler-controlled discovery limit. It never changes the organizer's reimbursement policy. */
  travelerMaxDistanceMiles?: number;
  /** Traveler-controlled ceiling used to filter route choices. */
  travelerBudgetCents?: Cents;
  /** Immutable policy snapshot used when this trip was planned (R1). */
  organizerCapCents?: Cents;
  /** Amount eligible for the organizer workflow before receipts/check-in are reconciled. */
  reimbursementEligibleCents?: Cents;
  quoteCents: Cents; // the exact quote the traveler approved
  mandateId?: string;
  requestedBy: string; // person or agent id that requested the spend
  approvals: Approval[];
  state: TripState;
  submittedAt?: string;
  decision?: Decision;
  /** minutes before kickoff the traveler actually arrived (negative = late); history for P(miss) */
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
  reasons: string[]; // plain sentences, each one backed by refs
  refs: string[]; // evidence ids, rule ids (R1..), person ids
  needsHuman: boolean;
  question?: string; // the one specific question for the human, when needsHuman
  explanation?: string;
  explainedBy?: "claude" | "template";
  decidedAt: string;
  decidedBy: AgentId;
}

export interface Mandate {
  id: string;
  tripId: string;
  token: string; // simulated network token, never a real PAN
  maxCents: Cents;
  merchantCategory: string;
  expiresAt: string;
  singleUse: boolean;
  status: "pending" | "approved" | "consumed" | "declined" | "void";
  requestedBy: string;
  approvedBy?: string;
  provenance: "simulated";
}

export interface InboxItem {
  id: string;
  kind: "mandate_approval" | "reconcile";
  tripId: string;
  /** decision code (reconcile) or the amount being approved (mandate_approval) */
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
