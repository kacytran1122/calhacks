import { createHash } from "node:crypto";
import { appendAudit } from "../hyphenate/audit";
import { ROAD_DETOUR } from "./carbon";
import { explain } from "../hyphenate/agents/auditor";
import type { TravelConstraints } from "./agents/constraints";
import { gatherEvidence } from "./agents/evidence";
import { chargeTrip } from "../visa/payments";
import { decide, parseReceipt } from "../hyphenate/agents/reconciler";
import { compareRoutes } from "./agents/route";
import { scoutEvent, type LensHints } from "./agents/scout";
import { createMandate } from "../visa/visaSim";
import { postEntry, type JournalLine } from "../hyphenate/ledger";
import { fmt } from "./money";
import { assertNotSelfApproval, authorize, PermissionDenied } from "./permissions";
import { capFor, POLICY } from "../hyphenate/policy";
import type { State } from "./store";
import { newId } from "./store";
import type { Actor, Cents, Decision, HumanRole, InboxItem, Trip } from "./types";
import { bindApproval } from "../hyphenate/financeControls";

const recon: Actor = { kind: "agent", id: "reconciler" };
const orch: Actor = { kind: "agent", id: "orchestrator" };
const INVALID_REFUND_TOPIC = "invalid_refund_evidence_review";

const charged = (state: State, tripId: string): Cents => {
  const amounts = state.evidence
    .filter((e) => e.tripId === tripId
      && e.kind === "bank_line"
      && e.status === "ok"
      && String(e.data.currency ?? "").toUpperCase() === "USD"
      && typeof e.data.amountCents === "number"
      && Number.isSafeInteger(e.data.amountCents)
      && e.data.amountCents > 0)
    .map((e) => e.data.amountCents as Cents);
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(total + amount)) return 0;
    total += amount;
  }
  return total;
};

function post(state: State, trip: Trip, memo: string, lines: JournalLine[], refs: string[], by: Actor = recon) {
  return postEntry(state, {
    date: new Date().toISOString().slice(0, 10),
    period: state.company.openPeriod, // late items for closed periods land here (R9)
    memo,
    lines: lines.filter((l) => l.debit > 0 || l.credit > 0),
    refs: [...new Set([trip.id, ...refs])],
    postedBy: by,
  });
}

const dr = (account: JournalLine["account"], c: Cents): JournalLine => ({ account, debit: c, credit: 0 });
const cr = (account: JournalLine["account"], c: Cents): JournalLine => ({ account, debit: 0, credit: c });

function bookPayout(state: State, trip: Trip, pay: Cents, refs: string[], parked: boolean, memo: string) {
  const who = state.travelers.find((t) => t.id === trip.travelerId)?.initials ?? trip.travelerId;
  if (trip.method === "virtual_card") {
    const card = charged(state, trip.id);
    const recover = Math.max(0, card - pay);
    post(state, trip, `${memo} — ${who}`, [dr("5100", pay), dr("1200", recover), cr(parked ? "1300" : "2100", card)], refs);
  } else if (pay > 0) {
    post(state, trip, `${memo} — ${who}`, [dr("5100", pay), cr("2000", pay)], refs);
    post(state, trip, `ACH payout to ${who} (SIMULATED transfer)`, [dr("2000", pay), cr("1000", pay)], refs);
  }
}

function ask(state: State, trip: Trip, kind: InboxItem["kind"], askedOf: HumanRole, question: string, options: InboxItem["options"], meta: InboxItem["meta"]) {
  const item: InboxItem = { id: newId("Q"), kind, tripId: trip.id, createdAt: new Date().toISOString(), askedOf, question, options, status: "open", meta };
  state.inbox.push(item);
  appendAudit(state, { actor: orch, action: "human.asked", subject: trip.id, reason: `Asked ${askedOf}: ${question}`, refs: [item.id] });
  return item;
}

/**
 * An FYI for a person (price moved, heat ahead, event date changed). One per topic, so a job that
 * wakes every hour doesn't repeat itself. Notices carry no money and answering one approves nothing.
 */
export function notify(state: State, trip: Trip, askedOf: HumanRole, topic: string, text: string): InboxItem | null {
  if (state.inbox.some((i) => i.kind === "notice" && i.tripId === trip.id && i.meta.topic === topic)) return null;
  return ask(state, trip, "notice", askedOf, text, [{ id: "ok", label: "Got it" }], { topic });
}

export function applyDecision(state: State, trip: Trip, d: ReturnType<typeof decide>) {
  const { askedOf, options, ...decision } = d;
  trip.decision = decision;
  appendAudit(state, { actor: recon, action: "decision.made", subject: trip.id, reason: `${d.code}: ${d.reasons.join(" ")}`, refs: d.refs });
  const card = charged(state, trip.id);

  if (d.code === "recover_refund") {
    const refund = state.evidence.find((e) => e.tripId === trip.id
      && e.kind === "refund"
      && d.refs.includes(e.id)
      && e.status === "ok"
      && e.data.processed === false
      && String(e.data.currency ?? "").toUpperCase() === "USD"
      && typeof e.data.amountCents === "number"
      && Number.isSafeInteger(e.data.amountCents)
      && e.data.amountCents > 0
      && e.data.amountCents === -d.payCents);
    if (!refund) throw new Error("the exact valid pending refund evidence is missing");
    post(state, trip, `Card refund reverses travel grant (R11)`, [dr("2100", -d.payCents), cr("5100", -d.payCents)], d.refs);
    refund.data.processed = true;
    trip.state = state.evidence.some((e) => e.tripId === trip.id && e.kind === "refund" && e.data.processed === false) ? "reimbursed" : "closed";
    return;
  }
  if (d.needsHuman) {
    const pendingRefundHold = trip.state === "reimbursed"
      && d.code === "require_payment_evidence"
      && state.evidence.some((e) => e.tripId === trip.id && e.kind === "refund" && e.data.processed === false && d.refs.includes(e.id));
    if (!pendingRefundHold && trip.method === "virtual_card" && card > 0) post(state, trip, `Parked in suspense pending ${askedOf} — ${d.code}`, [dr("1300", card), cr("2100", card)], d.refs);
    trip.state = "needs_human";
    ask(state, trip, "reconcile", askedOf ?? "controller", d.question ?? "Review needed", options ?? [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], { code: d.code, ...(pendingRefundHold ? { topic: INVALID_REFUND_TOPIC } : {}) });
    return;
  }
  if (d.code === "deny_no_show") {
    if (card > 0) post(state, trip, `No-show: ticket cost recoverable from traveler (R12)`, [dr("1200", card), cr("2100", card)], d.refs);
    const ev = state.events.find((e) => e.id === trip.eventId);
    state.noShows.push({ travelerId: trip.travelerId, eventId: trip.eventId, date: (ev?.startsAt ?? new Date().toISOString()).slice(0, 10), tripId: trip.id });
    trip.state = "denied";
    return;
  }
  if (d.code === "reject_duplicate") {
    trip.state = "denied";
    return;
  }
  bookPayout(state, trip, d.payCents, d.refs, false, `Travel grant (${d.code.replace(/_/g, " ")})`);
  trip.state = "reimbursed";
}

export async function tick(state: State, opts: { explainWithClaude?: boolean; limit?: number } = {}) {
  const todo = state.trips
    .filter((t) => t.state === "submitted" || (t.state === "reimbursed" && state.evidence.some((e) => e.tripId === t.id && e.kind === "refund" && e.data.processed === false)))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""))
    .slice(0, opts.limit ?? Infinity);
  const done: { tripId: string; code: string; needsHuman: boolean }[] = [];
  for (const trip of todo) {
    const d = decide(state, trip);
    applyDecision(state, trip, d);
    if (opts.explainWithClaude) {
      const ex = await explain(state, trip.id);
      trip.decision!.explanation = ex.text;
      trip.decision!.explainedBy = ex.by;
    }
    done.push({ tripId: trip.id, code: d.code, needsHuman: d.needsHuman });
  }
  appendAudit(state, { actor: orch, action: "tick.completed", subject: "backlog", reason: `Reconciled ${done.length} trip(s); ${done.filter((d) => d.needsHuman).length} need a person` });
  return done;
}

const MAP_COMPLETION_TOPIC = "authenticated_map_completion";
const UNBOOKED_COMPLETION_TOPIC = "unbooked_map_completion_review";

function unbookedCompletionDecision(state: State, trip: Trip, completionId: string, attendanceId: string, stateAtCompletion: string, at: string): ReturnType<typeof decide> {
  return {
    code: "require_payment_evidence",
    payCents: 0,
    reasons: [
      `Map guidance was finished while the trip was ${stateAtCompletion}; there is no completed booking authorization to reconcile.`,
      "A check-in or organizer attendance response does not replace traveler approval, an operator receipt, or a bank settlement.",
      "A controller must keep the trip unpaid unless valid approval and payment evidence are attached and reviewed.",
    ],
    refs: [completionId, attendanceId, ...state.evidence.filter((e) => e.tripId === trip.id && ["quote", "card_auth", "bank_line", "receipt"].includes(e.kind)).map((e) => e.id)],
    needsHuman: true,
    question: "This route was completed before a booked authorization existed. Keep it unpaid unless finance receives valid approval and payment evidence?",
    askedOf: "controller",
    options: [{ id: "reject", label: "Do not reimburse without evidence" }],
    decidedAt: at,
    decidedBy: "reconciler",
  };
}

function applyUnbookedCompletionDecision(state: State, trip: Trip, decision: ReturnType<typeof decide>) {
  const { askedOf, options, ...stored } = decision;
  trip.decision = stored;
  trip.state = "needs_human";
  appendAudit(state, {
    actor: recon,
    action: "decision.made",
    subject: trip.id,
    reason: `${decision.code}: ${decision.reasons.join(" ")}`,
    refs: decision.refs,
    at: decision.decidedAt,
  });
  ask(
    state,
    trip,
    "reconcile",
    askedOf ?? "controller",
    decision.question ?? "Keep this unbooked trip unpaid pending evidence review?",
    options ?? [{ id: "reject", label: "Do not reimburse without evidence" }],
    { code: decision.code, topic: UNBOOKED_COMPLETION_TOPIC },
  );
}

export interface MapTripCompletionScope {
  tripId: string;
  travelerId: string;
}

/**
 * Records a traveler's authenticated map-finish signal without pretending it is
 * a receipt, settlement, or venue check-in. Missing attendance evidence is sent
 * to an organizer before the ordinary reconciler is allowed to decide payment.
 */
function completeTripFromMapMutating(state: State, scope: MapTripCompletionScope, now = new Date()) {
  const trip = state.trips.find((candidate) => candidate.id === scope.tripId && candidate.travelerId === scope.travelerId);
  if (!trip || !trip.id.startsWith("TR-L")) throw new PermissionDenied("the map handoff is not authorized for this live trip");

  const existing = state.evidence.find((e) => e.tripId === trip.id && e.kind === "trip_completion");
  if (existing) {
    return {
      replayed: true,
      tripState: trip.state,
      decisionCode: trip.decision?.code,
      needsHuman: trip.state === "needs_human",
      evidenceId: existing.id,
    };
  }
  if (!(["planned", "pre_approved", "booked"] as const).includes(trip.state as "planned" | "pre_approved" | "booked"))
    throw new Error("only an active live trip can be completed from the map");

  const at = now.toISOString();
  const tripStateAtCompletion = trip.state;
  const completion = {
    id: `EV-${trip.id}-map-completion`,
    tripId: trip.id,
    kind: "trip_completion" as const,
    source: "Authenticated Photon map handoff",
    fetchedAt: at,
    status: "ok" as const,
    provenance: "live" as const,
    data: {
      signal: "route_guidance_finished",
      attestedBy: "traveler_browser",
      reimbursementEvidence: false,
      operatorReceipt: false,
      bankSettlement: false,
      venueCheckin: false,
      tripStateAtCompletion,
    },
    note: "This proves only that authenticated route guidance was finished. It is not proof of travel, attendance, purchase, or payment.",
  };
  state.evidence.push(completion);
  trip.submittedAt = at;
  appendAudit(state, {
    actor: { kind: "human", id: trip.travelerId, role: "traveler" },
    action: "trip.map_completed",
    subject: trip.id,
    reason: "Authenticated route guidance finished; recorded as a non-financial signal and sent to post-trip controls",
    refs: [completion.id],
    at,
  });

  const staleFinancialItems = state.inbox.filter((item) => item.tripId === trip.id && item.kind !== "notice" && item.status === "open");
  for (const item of staleFinancialItems) {
    item.status = "answered";
    item.answer = { by: "agent:orchestrator", option: "closed", note: "Closed after authenticated post-trip completion", at };
  }
  const mandate = state.mandates.find((candidate) => candidate.id === trip.mandateId);
  if (mandate && (mandate.status === "pending" || mandate.status === "approved")) mandate.status = "void";
  if (staleFinancialItems.length || mandate?.status === "void") {
    appendAudit(state, {
      actor: orch,
      action: "pretrip_work.closed_after_trip",
      subject: trip.id,
      reason: "Closed stale pre-trip approval and exception work after authenticated post-trip completion; it cannot authorize a later charge or payout",
      refs: [...staleFinancialItems.map((item) => item.id), ...(mandate ? [mandate.id] : [])],
      at,
    });
  }

  const attendance = state.evidence.find((e) => e.tripId === trip.id && e.kind === "checkin" && e.status === "ok" && ["present", "checked_in", "absent"].includes(String(e.data.result)));
  if (attendance) {
    trip.state = "submitted";
    const unbooked = tripStateAtCompletion !== "booked";
    const decision = unbooked
      ? unbookedCompletionDecision(state, trip, completion.id, attendance.id, tripStateAtCompletion, at)
      : decide(state, trip, now);
    if (unbooked) applyUnbookedCompletionDecision(state, trip, decision);
    else applyDecision(state, trip, decision);
    return { replayed: false, tripState: trip.state, decisionCode: decision.code, needsHuman: decision.needsHuman, evidenceId: completion.id };
  }

  const event = state.events.find((candidate) => candidate.id === trip.eventId);
  const decision: Decision = {
    code: "require_checkin",
    payCents: 0,
    reasons: [
      "The authenticated traveler finished the map route, but that app action is not venue attendance evidence.",
      "No operator receipt, bank settlement, or venue check-in is inferred from map progress or from a Visa simulation receipt.",
      "An organizer must confirm attendance before the financial reconciler evaluates reimbursement.",
    ],
    refs: [completion.id],
    needsHuman: true,
    question: `Can you confirm that this traveler attended ${event?.name ?? "the event"}? Finishing map guidance alone is not attendance proof.`,
    decidedAt: at,
    decidedBy: "reconciler",
  };
  trip.decision = decision;
  trip.state = "needs_human";
  appendAudit(state, {
    actor: recon,
    action: "decision.made",
    subject: trip.id,
    reason: `${decision.code}: ${decision.reasons.join(" ")}`,
    refs: decision.refs,
    at,
  });
  ask(
    state,
    trip,
    "reconcile",
    "organizer",
    decision.question!,
    [
      { id: "approve", label: "Confirm attendance" },
      { id: "reject", label: "Could not confirm attendance" },
    ],
    { code: decision.code, topic: MAP_COMPLETION_TOPIC },
  );
  return { replayed: false, tripState: trip.state, decisionCode: decision.code, needsHuman: true, evidenceId: completion.id };
}

/**
 * The state store deliberately persists authorization and ledger audit failures.
 * Keep the map-completion unit atomic so one of those failures cannot leave the
 * completion marker behind and make a later retry look successful.
 */
export function completeTripFromMap(state: State, scope: MapTripCompletionScope, now = new Date()) {
  const before = structuredClone(state);
  try {
    return completeTripFromMapMutating(state, scope, now);
  } catch (error) {
    const target = state as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, before);
    throw error;
  }
}

export interface Answerer {
  id: string;
  role: HumanRole;
}

export function answer(state: State, itemId: string, who: Answerer, option: string, note?: string) {
  const item = state.inbox.find((i) => i.id === itemId);
  if (!item || item.status !== "open") throw new Error("question not open");
  const trip = state.trips.find((t) => t.id === item.tripId)!;
  const actor: Actor = { kind: "human", id: who.id, role: who.role };
  authorize(state, actor, "approve", trip.id);
  if (item.kind === "mandate_approval" && trip.state !== "planned") throw new Error("this trip is no longer awaiting mandate approval");

  const roleOk = who.role === item.askedOf || who.role === "controller";
  const travelerOk = item.askedOf !== "traveler" || who.id === trip.travelerId || who.role === "controller";
  if (!roleOk || !travelerOk) {
    appendAudit(state, { actor, action: "permission.denied", subject: trip.id, reason: `${who.id} (${who.role}) can't answer a question for ${item.askedOf}` });
    throw new PermissionDenied(`this question is for the ${item.askedOf}`);
  }
  if (!item.options.some((candidate) => candidate.id === option)) throw new Error("answer option is not available for this question");
  if (item.kind === "notice") {
    item.status = "answered";
    item.answer = { by: who.id, option, note, at: new Date().toISOString() };
    appendAudit(state, { actor, action: "notice.acknowledged", subject: trip.id, reason: item.meta.topic ?? item.question, refs: [item.id, who.id] });
    return { tripId: trip.id, outcome: "noted" };
  }
  assertNotSelfApproval(state, who.id, trip.requestedBy, trip.id);
  if (item.meta.code === "block_self_approval") assertNotSelfApproval(state, who.id, trip.approvals.find((a) => a.by === trip.requestedBy)?.by ?? "", trip.id);

  item.status = "answered";
  item.answer = { by: who.id, option, note, at: new Date().toISOString() };
  appendAudit(state, { actor, action: "human.answered", subject: trip.id, reason: `${option}${note ? ` — "${note}"` : ""}`, refs: [item.id, who.id] });

  if (item.meta.topic === MAP_COMPLETION_TOPIC) return resolveMapCompletionAttendance(state, trip, item, who, option);
  if (item.meta.topic === UNBOOKED_COMPLETION_TOPIC) {
    trip.state = "denied";
    return { tripId: trip.id, outcome: "kept unpaid pending valid booking and payment evidence" };
  }
  if (item.meta.topic === INVALID_REFUND_TOPIC) {
    trip.state = "closed";
    return { tripId: trip.id, outcome: "invalid refund retained as evidence and left unposted" };
  }

  trip.approvals.push({ by: who.id, role: who.role, at: item.answer.at, subject: item.kind === "mandate_approval" ? "mandate" : "reimbursement", decision: option === "reject" ? "reject" : "approve", note });

  if (item.kind === "mandate_approval") return resolveMandate(state, trip, item, who, option);
  return resolveReconcile(state, trip, item, option);
}

function resolveMapCompletionAttendance(state: State, trip: Trip, item: InboxItem, who: Answerer, option: string) {
  const completion = state.evidence.find((e) => e.tripId === trip.id && e.kind === "trip_completion");
  if (!completion) throw new Error("the authenticated map completion evidence is missing");
  const result = option === "approve" ? "present" : "absent";
  const attendanceId = `EV-${trip.id}-organizer-attendance`;
  if (!state.evidence.some((e) => e.id === attendanceId)) {
    state.evidence.push({
      id: attendanceId,
      tripId: trip.id,
      kind: "checkin",
      source: "Organizer post-trip confirmation",
      fetchedAt: item.answer!.at,
      status: "ok",
      provenance: "live",
      data: { result, confirmedBy: who.id, confirmationRole: who.role, mapCompletionEvidenceId: completion.id },
      note: "Human attendance confirmation. This is separate from the map signal and from any Visa simulation receipt.",
    });
  }
  appendAudit(state, {
    actor: { kind: "human", id: who.id, role: who.role },
    action: "attendance.confirmed",
    subject: trip.id,
    reason: result === "present" ? "Organizer confirmed event attendance" : "Organizer could not confirm event attendance",
    refs: [item.id, completion.id, attendanceId],
    at: item.answer!.at,
  });
  trip.state = "submitted";
  const stateAtCompletion = String(completion.data.tripStateAtCompletion ?? "booked");
  const unbooked = stateAtCompletion !== "booked";
  const decision: ReturnType<typeof decide> = unbooked
    ? unbookedCompletionDecision(state, trip, completion.id, attendanceId, stateAtCompletion, item.answer!.at)
    : decide(state, trip, new Date(item.answer!.at));
  if (unbooked) applyUnbookedCompletionDecision(state, trip, decision);
  else applyDecision(state, trip, decision);
  return {
    tripId: trip.id,
    outcome: decision.needsHuman ? `sent for ${decision.code} review` : decision.code,
  };
}

function resolveMandate(state: State, trip: Trip, item: InboxItem, who: Answerer, option: string) {
  const m = state.mandates.find((x) => x.id === trip.mandateId);
  if (!m) throw new Error("no mandate");
  if (option === "reject") {
    m.status = "void";
    trip.state = "denied";
    return { tripId: trip.id, outcome: "mandate voided" };
  }
  m.status = "approved";
  m.approvedBy = who.id;
  trip.quoteCents = m.maxCents;
  bindApproval(state, trip, m, item.answer!.at);
  trip.state = "pre_approved";
  appendAudit(state, { actor: orch, action: "mandate.approved", subject: trip.id, reason: `${who.id} approved exactly ${fmt(m.maxCents)} on ${m.token}`, refs: [m.id, who.id, "R7"] });
  return { tripId: trip.id, outcome: `approved ${fmt(m.maxCents)}` };
}

function resolveReconcile(state: State, trip: Trip, item: InboxItem, option: string) {
  const d = trip.decision as Decision;
  const card = charged(state, trip.id);
  const parked = trip.method === "virtual_card" && card > 0;
  const receiptEv = state.evidence.find((e) => e.tripId === trip.id && e.kind === "receipt");
  const receiptCents = receiptEv ? (parseReceipt(String(receiptEv.data.text ?? "")).amountCents ?? 0) : 0;
  const refs = [...d.refs, item.id];
  let pay: Cents = 0;

  switch (d.code) {
    case "hold_price_changed":
      pay = option === "approve" ? card || receiptCents : trip.quoteCents;
      break;
    case "reimburse_capped":
      pay = option === "exception" ? receiptCents : option === "approve" ? d.payCents : 0;
      break;
    case "require_checkin":
    case "block_self_approval":
      pay = option === "approve" ? (parked ? card : trip.quoteCents) : 0;
      break;
    default:
      pay = option === "reject" ? 0 : d.payCents;
  }

  if (pay > 0) {
    bookPayout(state, trip, pay, refs, parked, `Travel grant after ${item.askedOf} answered "${option}"`);
    trip.state = "reimbursed";
  } else {
    if (parked) post(state, trip, `Cleared suspense: ${item.askedOf} answered "${option}" — recoverable from traveler`, [dr("1200", card), cr("1300", card)], refs);
    if (d.code === "require_checkin" && !state.evidence.some((e) => e.tripId === trip.id && e.kind === "checkin" && e.status === "ok" && (e.data.result === "present" || e.data.result === "checked_in"))) {
      const ev = state.events.find((e) => e.id === trip.eventId);
      state.noShows.push({ travelerId: trip.travelerId, eventId: trip.eventId, date: (ev?.startsAt ?? "").slice(0, 10), tripId: trip.id });
    }
    trip.state = "denied";
  }
  return { tripId: trip.id, outcome: pay > 0 ? `paid ${fmt(pay)}` : "not paid" };
}

export interface PickedEvent {
  key: string;
  name: string;
  startsAt: string;
  venue?: string;
  city?: string;
  lat?: number;
  lon?: number;
  url?: string;
}

export type PlanTripArgs = { zip: string; originText?: string; originCoordinates?: { lat: number; lon: number }; eventUrl?: string; hints?: LensHints; initials?: string; event?: PickedEvent; travelerBudgetCents?: Cents; maxDistanceMiles?: number; includeSelfDrive?: boolean; travelConstraints?: TravelConstraints & { raw: string }; requestKey?: string };
export type PlanTripResult = Awaited<ReturnType<typeof createTripPlan>>;

export class PlanRequestConflict extends Error {}

export function cachedTripPlan(state: State, requestKey: string) {
  const key = createHash("sha256").update(requestKey).digest("hex");
  const previous = state.planningReceipts?.[key];
  return previous ? structuredClone({ result: previous.result, createdAt: previous.createdAt }) : undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}

export async function planTrip(state: State, args: PlanTripArgs): Promise<PlanTripResult> {
  if (!args.requestKey) return createTripPlan(state, args);
  if (args.requestKey.length > 500) throw new Error("The trip request identifier is too long.");
  const { requestKey, ...details } = args;
  const key = createHash("sha256").update(requestKey).digest("hex");
  const fingerprint = createHash("sha256").update(JSON.stringify(canonical(details))).digest("hex");
  const previous = state.planningReceipts?.[key];
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new PlanRequestConflict("This message already requested a different trip. Send a new @smile message to change the plan.");
    return structuredClone(previous.result);
  }
  const result = await createTripPlan(state, details);
  (state.planningReceipts ??= {})[key] = { fingerprint, createdAt: new Date().toISOString(), result: structuredClone(result) };
  return result;
}

async function createTripPlan(state: State, args: Omit<PlanTripArgs, "requestKey">) {
  const travelerId = newId("T-live");
  state.travelers.push({ id: travelerId, initials: args.initials ?? "YOU", school: "Lens user", homeZip: args.zip });

  let facts;
  let scoutEvidenceId: string | undefined;
  if (args.eventUrl) {
    const s = await scoutEvent(state, args.eventUrl, args.hints);
    facts = s.facts;
    scoutEvidenceId = s.evidence.id;
  }
  const main = state.events.find((e) => e.id === "E-main")!;
  const picked = args.event;
  const event = picked
    ? (state.events.find((e) => e.id === picked.key) ?? { id: picked.key, name: picked.name, venue: picked.venue ?? "", city: picked.city ?? "", startsAt: picked.startsAt, url: picked.url, lat: picked.lat, lon: picked.lon })
    : facts?.name
      ? { id: newId("E-live"), name: facts.name, venue: facts.venue ?? "", city: facts.address ?? "", startsAt: facts.startsAt ?? main.startsAt, url: args.eventUrl, lat: facts.lat, lon: facts.lon }
      : main;
  if (!state.events.some((e) => e.id === event.id)) state.events.push(event);

  const trip: Trip = {
    id: newId("TR-L"), travelerId, eventId: event.id, period: state.company.openPeriod, method: "virtual_card", mode: "train", includeSelfDrive: args.includeSelfDrive !== false, distanceMiles: 0,
    travelerMaxDistanceMiles: args.maxDistanceMiles, travelerBudgetCents: args.travelerBudgetCents, travelConstraintSummary: args.travelConstraints?.summary,
    quoteCents: 0, requestedBy: "agent:policy", approvals: [], state: "planned",
  };
  state.trips.push(trip);
  if (args.travelConstraints) {
    state.evidence.push({ id: newId("EV-constraint"), tripId: trip.id, kind: "traveler_constraint", source: "Claude travel constraint coordinator", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: args.travelConstraints });
  }
  if (scoutEvidenceId) state.evidence.find((e) => e.id === scoutEvidenceId)!.tripId = trip.id;

  const g = await gatherEvidence(state, { tripId: trip.id, homeZip: args.zip, originText: args.originText, originCoordinates: args.originCoordinates, event: { ...(facts ?? { extractedBy: picked ? "json-ld" : "lens-hints", verified: Boolean(picked) }), name: event.name, venue: event.venue, city: event.city, startsAt: event.startsAt, lat: event.lat, lon: event.lon }, travelConstraintSummary: args.travelConstraints?.summary, includeSelfDrive: args.includeSelfDrive });
  if (g.miles === undefined) {
    appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: "Couldn't compute distance (ZIP or venue location unavailable)", refs: g.evidence.map((e) => e.id) });
    return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes: null, carpool: null, inbox: null };
  }
  trip.distanceMiles = g.miles;
  trip.organizerCapCents = capFor(g.miles);
  const fareEv = g.evidence.find((e) => e.kind === "fare");
  const pool = carpoolFor(state, trip.id);
  const routes = compareRoutes(state, {
    miles: g.miles, fares: g.fares, fareEvidenceId: fareEv?.id, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, includeSelfDrive: args.includeSelfDrive,
    deadlineCritical: Boolean(args.travelConstraints?.arriveBy || args.travelConstraints?.departAfter),
    context: { roadMiles: g.roadMiles, from: g.homePoint, to: g.venuePoint, minutes: g.minutes, itineraries: g.itineraries, carpool: pool },
  });
  const pooled = routes.carbon.estimates.find((e) => e.mode === "carpool");
  const carpool = { ...pool, perTravelerKg: pooled?.kg ?? null, driveAloneKg: routes.carbon.driveAloneKg, savedKgPerTraveler: pooled ? Math.round((routes.carbon.driveAloneKg - pooled.kg) * 10) / 10 : null, formula: pooled?.formula ?? null };

  authorize(state, { kind: "agent", id: "policy" }, "mandate.request", trip.id);
  if (!routes.pick) {
    if (routes.blockReason === "TRAVELER_BUDGET") {
      appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: `No organizer-eligible route fits the traveler's ${fmt(args.travelerBudgetCents ?? 0)} personal budget`, refs: ["R1"] });
      return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, carpool, inbox: null };
    }
    if (routes.blockReason === "MAX_DISTANCE") {
      appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: `${g.miles} mi exceeds the traveler's ${args.maxDistanceMiles} mi search limit` });
      return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, carpool, inbox: null };
    }
    if (routes.blockReason === "NO_VERIFIED_FARE") {
      appendAudit(state, { actor: orch, action: "plan.awaiting_fare", subject: trip.id, reason: "Live routes were found without an auditable total fare; no payment mandate was created", refs: g.evidence.map((e) => e.id) });
      return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, carpool, inbox: null };
    }
    const q = ask(state, trip, "reconcile", "controller", `No option from ${g.homeLabel ?? args.zip} to ${event.name} fits the ${fmt(routes.cap)} cap (R1). Approve an exception?`, [{ id: "approve", label: "Approve exception" }, { id: "reject", label: "Decline" }], {});
    return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, carpool, inbox: q };
  }
  trip.mode = routes.pick.mode;
  trip.routeTitle = routes.pick.routeTitle;
  trip.quoteCents = routes.pick.costCents;
  trip.reimbursementEligibleCents = Math.min(trip.quoteCents, routes.cap);
  trip.co2eKg = routes.pick.co2eKg;
  trip.co2eDriveAloneKg = routes.carbon.driveAloneKg;
  state.evidence.push({ id: `EV-${trip.id}-quote`, tripId: trip.id, kind: "quote", source: "S'mile Route Analyst", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { amountCents: trip.quoteCents, mode: trip.mode, routeTitle: routes.pick.routeTitle, costSource: routes.pick.costSource, pMiss: routes.pick.pMiss, organizerCapCents: routes.cap, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, reimbursementEligibleCents: trip.reimbursementEligibleCents, pickReason: routes.pickReason, co2eKg: routes.pick.co2eKg, co2eFormula: routes.pick.co2eFormula, co2eDriveAloneKg: routes.carbon.driveAloneKg, fastest: routes.fastest, lowestCarbon: routes.lowestCarbon } });
  const m = createMandate({ tripId: trip.id, maxCents: trip.quoteCents, merchantCategory: trip.mode === "drive" ? "fuel" : trip.mode === "bus" ? "bus" : "rail", requestedBy: "agent:policy" });
  state.mandates.push(m);
  trip.mandateId = m.id;
  const remaining = 600_000 - state.journal.reduce((a, j) => a + j.lines.filter((l) => l.account === "5100").reduce((x, l) => x + l.debit - l.credit, 0), 0);
  const q = ask(
    state,
    trip,
    "mandate_approval",
    "traveler",
    `${trip.routeTitle ?? trip.mode} for ${fmt(trip.quoteCents)} (cap ${fmt(capFor(g.miles))}, ${routes.pick.history.trips ? `${Math.round(routes.pick.pMiss * 100)}% chance of missing kickoff from ${routes.pick.history.trips} past trips` : "no trip history for this mode yet"}${routes.pick.co2eKg !== undefined ? `, about ${routes.pick.co2eKg} kg CO₂e` : ""})${args.travelConstraints ? `. Travel requirement: ${args.travelConstraints.summary}` : ""}. Approve exactly ${fmt(trip.quoteCents)}? Nothing is charged until you do.`,
    [{ id: "approve", label: `Approve ${fmt(trip.quoteCents)}` }, { id: "reject", label: "Not now" }],
    { amountCents: trip.quoteCents, routeTitle: trip.routeTitle },
  );
  appendAudit(state, { actor: { kind: "agent", id: "policy" }, action: "mandate.requested", subject: trip.id, reason: `Requested ${fmt(trip.quoteCents)} single-use mandate; season budget remaining ${fmt(remaining)}`, refs: [m.id, "R1", "R7", ...g.evidence.map((e) => e.id)] });
  if (trip.quoteCents > POLICY.controllerThresholdCents) ask(state, trip, "reconcile", "controller", `Pre-approve ${fmt(trip.quoteCents)} (over the R3 threshold)?`, [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], {});
  return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, carpool, inbox: q };
}

export async function bookTrip(state: State, tripId: string, fareDeltaCents = 0) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip || trip.state !== "pre_approved") throw new Error("trip isn't pre-approved");
  const previousQuote = state.evidence.filter((e) => e.tripId === tripId && e.kind === "quote" && e.status === "ok").at(-1);
  if (!trip.routeTitle && typeof previousQuote?.data.routeTitle === "string") trip.routeTitle = previousQuote.data.routeTitle;
  const amount = trip.quoteCents + fareDeltaCents;
  const r = await chargeTrip(state, tripId, amount, `${trip.mode.toUpperCase()} via S'mile`);
  if (!r.ok) {
    state.evidence.push({ id: newId("EV-quote"), tripId, kind: "quote", source: "S'mile checkout verification", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { amountCents: amount, mode: trip.mode, routeTitle: trip.routeTitle, previousAmountCents: trip.quoteCents, reason: "fare_changed_at_checkout" } });
    const m = createMandate({ tripId, maxCents: amount, merchantCategory: state.mandates.find((x) => x.id === trip.mandateId)!.merchantCategory, requestedBy: "agent:policy" });
    state.mandates.push(m);
    trip.mandateId = m.id;
    trip.state = "planned";
    ask(state, trip, "mandate_approval", "traveler", `The fare for ${trip.routeTitle ?? trip.mode} changed from ${fmt(trip.quoteCents)} to ${fmt(amount)} at checkout and the card declined it. Approve exactly ${fmt(amount)}?`, [{ id: "approve", label: `Approve ${fmt(amount)}` }, { id: "reject", label: "Cancel" }], { amountCents: amount, routeTitle: trip.routeTitle });
  }
  return r;
}

/** Travelers per car, driver included. */
const CAR_SEATS = 4;

/**
 * Nearby travelers to the same event who could share one car. The car drives this trip's route
 * plus a pickup detour of ROAD_DETOUR × the straight-line distance to each rider.
 */
export function carpoolFor(state: State, tripId: string) {
  const riders = buddiesFor(state, tripId).slice(0, CAR_SEATS - 1);
  return {
    riders: riders.map((r) => r.initials),
    people: riders.length + 1,
    detourMiles: Math.round(riders.reduce((a, r) => a + r.milesApart * ROAD_DETOUR, 0) * 10) / 10,
    hypothetical: riders.length === 0,
  };
}

export function buddiesFor(state: State, tripId: string, withinMiles = 15) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip) return [];
  const home = (id: string) => state.evidence.find((e) => e.tripId === id && e.kind === "geocode" && e.status === "ok")?.data as { lat?: number; lon?: number } | undefined;
  const me = home(trip.id);
  if (me?.lat === undefined || me.lon === undefined) return [];
  const R = 3958.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const miles = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
    2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2));
  return state.trips
    .filter((t) => t.id !== trip.id && t.eventId === trip.eventId && t.travelerId !== trip.travelerId && t.state !== "denied")
    .map((t) => {
      const h = home(t.id);
      if (h?.lat === undefined || h.lon === undefined) return null;
      const d = miles({ lat: me.lat!, lon: me.lon! }, { lat: h.lat, lon: h.lon });
      return d <= withinMiles ? { initials: state.travelers.find((x) => x.id === t.travelerId)?.initials ?? "?", mode: t.mode, sameMode: t.mode === trip.mode, milesApart: Math.round(d) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => Number(b.sameMode) - Number(a.sameMode) || a.milesApart - b.milesApart);
}
