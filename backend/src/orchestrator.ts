import { appendAudit } from "./audit";
import { explain } from "./agents/auditor";
import type { TravelConstraints } from "./agents/constraints";
import { gatherEvidence } from "./agents/evidence";
import { chargeTrip } from "./agents/payments";
import { decide, parseReceipt } from "./agents/reconciler";
import { compareRoutes } from "./agents/route";
import { scoutEvent, type LensHints } from "./agents/scout";
import { createMandate } from "./integrations/visaSim";
import { postEntry, type JournalLine } from "./ledger";
import { fmt, sum } from "./money";
import { assertNotSelfApproval, authorize, PermissionDenied } from "./permissions";
import { capFor, POLICY } from "./policy";
import type { State } from "./store";
import { newId } from "./store";
import type { Actor, Cents, Decision, HumanRole, InboxItem, Trip } from "./types";

const recon: Actor = { kind: "agent", id: "reconciler" };
const orch: Actor = { kind: "agent", id: "orchestrator" };

const charged = (state: State, tripId: string): Cents =>
  sum(state.evidence.filter((e) => e.tripId === tripId && e.kind === "bank_line").map((e) => Number(e.data.amountCents)));

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

export function applyDecision(state: State, trip: Trip, d: ReturnType<typeof decide>) {
  const { askedOf, options, ...decision } = d;
  trip.decision = decision;
  appendAudit(state, { actor: recon, action: "decision.made", subject: trip.id, reason: `${d.code}: ${d.reasons.join(" ")}`, refs: d.refs });
  const card = charged(state, trip.id);

  if (d.code === "recover_refund") {
    post(state, trip, `Card refund reverses travel grant (R11)`, [dr("2100", -d.payCents), cr("5100", -d.payCents)], d.refs);
    const refund = state.evidence.find((e) => e.tripId === trip.id && e.kind === "refund");
    if (refund) refund.data.processed = true;
    trip.state = "closed";
    return;
  }
  if (d.needsHuman) {
    if (trip.method === "virtual_card" && card > 0) post(state, trip, `Parked in suspense pending ${askedOf} — ${d.code}`, [dr("1300", card), cr("2100", card)], d.refs);
    trip.state = "needs_human";
    ask(state, trip, "reconcile", askedOf ?? "controller", d.question ?? "Review needed", options ?? [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], { code: d.code });
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

  const roleOk = who.role === item.askedOf || who.role === "controller";
  const travelerOk = item.askedOf !== "traveler" || who.id === trip.travelerId || who.role === "controller";
  if (!roleOk || !travelerOk) {
    appendAudit(state, { actor, action: "permission.denied", subject: trip.id, reason: `${who.id} (${who.role}) can't answer a question for ${item.askedOf}` });
    throw new PermissionDenied(`this question is for the ${item.askedOf}`);
  }
  assertNotSelfApproval(state, who.id, trip.requestedBy, trip.id);
  if (item.meta.code === "block_self_approval") assertNotSelfApproval(state, who.id, trip.approvals.find((a) => a.by === trip.requestedBy)?.by ?? "", trip.id);

  item.status = "answered";
  item.answer = { by: who.id, option, note, at: new Date().toISOString() };
  trip.approvals.push({ by: who.id, role: who.role, at: item.answer.at, subject: item.kind === "mandate_approval" ? "mandate" : "reimbursement", decision: option === "reject" ? "reject" : "approve", note });
  appendAudit(state, { actor, action: "human.answered", subject: trip.id, reason: `${option}${note ? ` — "${note}"` : ""}`, refs: [item.id, who.id] });

  if (item.kind === "mandate_approval") return resolveMandate(state, trip, item, who, option);
  return resolveReconcile(state, trip, item, option);
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
    if (d.code === "require_checkin") {
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

export async function planTrip(
  state: State,
  args: { zip: string; originText?: string; originCoordinates?: { lat: number; lon: number }; eventUrl?: string; hints?: LensHints; initials?: string; event?: PickedEvent; travelerBudgetCents?: Cents; maxDistanceMiles?: number; includeSelfDrive?: boolean; travelConstraints?: TravelConstraints & { raw: string } },
) {
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
    id: newId("TR-L"), travelerId, eventId: event.id, period: state.company.openPeriod, method: "virtual_card", mode: "train", distanceMiles: 0,
    travelerMaxDistanceMiles: args.maxDistanceMiles, travelerBudgetCents: args.travelerBudgetCents, travelConstraintSummary: args.travelConstraints?.summary,
    quoteCents: 0, requestedBy: "agent:policy", approvals: [], state: "planned",
  };
  state.trips.push(trip);
  if (args.travelConstraints) {
    state.evidence.push({ id: newId("EV-constraint"), tripId: trip.id, kind: "traveler_constraint", source: "Claude travel constraint coordinator", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: args.travelConstraints });
  }
  if (scoutEvidenceId) state.evidence.find((e) => e.id === scoutEvidenceId)!.tripId = trip.id;

  const g = await gatherEvidence(state, { tripId: trip.id, homeZip: args.zip, originText: args.originText, originCoordinates: args.originCoordinates, event: { ...(facts ?? { extractedBy: picked ? "json-ld" : "lens-hints", verified: Boolean(picked) }), name: event.name, venue: event.venue, city: event.city, startsAt: event.startsAt, lat: event.lat, lon: event.lon }, travelConstraintSummary: args.travelConstraints?.summary });
  if (g.miles === undefined) {
    appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: "Couldn't compute distance (ZIP or venue location unavailable)", refs: g.evidence.map((e) => e.id) });
    return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes: null, inbox: null };
  }
  trip.distanceMiles = g.miles;
  trip.organizerCapCents = capFor(g.miles);
  const fareEv = g.evidence.find((e) => e.kind === "fare");
  const routes = compareRoutes(state, { miles: g.miles, fares: g.fares, fareEvidenceId: fareEv?.id, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, includeSelfDrive: args.includeSelfDrive, deadlineCritical: Boolean(args.travelConstraints?.arriveBy || args.travelConstraints?.departAfter) });

  authorize(state, { kind: "agent", id: "policy" }, "mandate.request", trip.id);
  if (!routes.pick) {
    if (routes.blockReason === "TRAVELER_BUDGET") {
      appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: `No organizer-eligible route fits the traveler's ${fmt(args.travelerBudgetCents ?? 0)} personal budget`, refs: ["R1"] });
      return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, inbox: null };
    }
    if (routes.blockReason === "MAX_DISTANCE") {
      appendAudit(state, { actor: orch, action: "plan.blocked", subject: trip.id, reason: `${g.miles} mi exceeds the traveler's ${args.maxDistanceMiles} mi search limit` });
      return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, inbox: null };
    }
    const q = ask(state, trip, "reconcile", "controller", `No option for ${g.homeLabel ?? args.zip} → ${event.name} fits the ${fmt(routes.cap)} cap (R1). Approve an exception?`, [{ id: "approve", label: "Approve exception" }, { id: "reject", label: "Decline" }], {});
    return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, inbox: q };
  }
  trip.mode = routes.pick.mode;
  trip.quoteCents = routes.pick.costCents;
  trip.reimbursementEligibleCents = Math.min(trip.quoteCents, routes.cap);
  state.evidence.push({ id: `EV-${trip.id}-quote`, tripId: trip.id, kind: "quote", source: "S'mile Route Analyst", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { amountCents: trip.quoteCents, mode: trip.mode, costSource: routes.pick.costSource, pMiss: routes.pick.pMiss, organizerCapCents: routes.cap, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, reimbursementEligibleCents: trip.reimbursementEligibleCents } });
  const m = createMandate({ tripId: trip.id, maxCents: trip.quoteCents, merchantCategory: trip.mode === "drive" ? "fuel" : trip.mode === "bus" ? "bus" : "rail", requestedBy: "agent:policy" });
  state.mandates.push(m);
  trip.mandateId = m.id;
  const remaining = 600_000 - state.journal.reduce((a, j) => a + j.lines.filter((l) => l.account === "5100").reduce((x, l) => x + l.debit - l.credit, 0), 0);
  const q = ask(
    state,
    trip,
    "mandate_approval",
    "traveler",
    `${trip.mode} for ${fmt(trip.quoteCents)} (cap ${fmt(capFor(g.miles))}, ${routes.pick.history.trips ? `${Math.round(routes.pick.pMiss * 100)}% chance of missing kickoff from ${routes.pick.history.trips} past trips` : "no trip history for this mode yet"})${args.travelConstraints ? `. Travel requirement: ${args.travelConstraints.summary}` : ""}. Approve exactly ${fmt(trip.quoteCents)}? Nothing is charged until you do.`,
    [{ id: "approve", label: `Approve ${fmt(trip.quoteCents)}` }, { id: "reject", label: "Not now" }],
    { amountCents: trip.quoteCents },
  );
  appendAudit(state, { actor: { kind: "agent", id: "policy" }, action: "mandate.requested", subject: trip.id, reason: `Requested ${fmt(trip.quoteCents)} single-use mandate; season budget remaining ${fmt(remaining)}`, refs: [m.id, "R1", "R7", ...g.evidence.map((e) => e.id)] });
  if (trip.quoteCents > POLICY.controllerThresholdCents) ask(state, trip, "reconcile", "controller", `Pre-approve ${fmt(trip.quoteCents)} (over the R3 threshold)?`, [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }], {});
  return { trip, event, evidence: state.evidence.filter((e) => e.tripId === trip.id), routes, inbox: q };
}

export function bookTrip(state: State, tripId: string, fareDeltaCents = 0) {
  const trip = state.trips.find((t) => t.id === tripId);
  if (!trip || trip.state !== "pre_approved") throw new Error("trip isn't pre-approved");
  const amount = trip.quoteCents + fareDeltaCents;
  const r = chargeTrip(state, tripId, amount, `${trip.mode.toUpperCase()} via S'mile`);
  if (!r.ok) {
    const m = createMandate({ tripId, maxCents: amount, merchantCategory: state.mandates.find((x) => x.id === trip.mandateId)!.merchantCategory, requestedBy: "agent:policy" });
    state.mandates.push(m);
    trip.mandateId = m.id;
    trip.state = "planned";
    ask(state, trip, "mandate_approval", "traveler", `The fare changed from ${fmt(trip.quoteCents)} to ${fmt(amount)} at checkout and the card declined it. Approve exactly ${fmt(amount)}?`, [{ id: "approve", label: `Approve ${fmt(amount)}` }, { id: "reject", label: "Cancel" }], { amountCents: amount });
  }
  return r;
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
