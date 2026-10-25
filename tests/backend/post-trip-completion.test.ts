import assert from "node:assert/strict";
import test from "node:test";
import { verifyChain } from "../../backend/hyphenate/audit";
import { closeReadiness } from "../../backend/hyphenate/financeControls";
import { answer, completeTripFromMap } from "../../backend/src/orchestrator";
import { PermissionDenied } from "../../backend/src/permissions";
import { buildSeed } from "../../backend/src/seed/trips";
import type { State } from "../../backend/src/store";
import type { Trip } from "../../backend/src/types";

function fixture() {
  const { state } = buildSeed();
  const travelerId = "T-live-map";
  state.travelers.push({ id: travelerId, initials: "KM", school: "Test University", homeZip: "94720" });
  const trip: Trip = {
    id: "TR-L-map-completion",
    travelerId,
    eventId: state.events[0]!.id,
    period: state.company.openPeriod,
    method: "virtual_card",
    mode: "train",
    distanceMiles: 90,
    quoteCents: 7_500,
    requestedBy: "agent:policy",
    approvals: [],
    state: "booked",
  };
  state.trips.push(trip);
  state.evidence.push(
    { id: "EV-live-quote", tripId: trip.id, kind: "quote", source: "live fare", fetchedAt: "2026-10-25T10:00:00.000Z", status: "ok", provenance: "live", data: { amountCents: 7_500 } },
    { id: "EV-live-auth", tripId: trip.id, kind: "card_auth", source: "Visa mandate network (SIMULATED)", fetchedAt: "2026-10-25T10:01:00.000Z", status: "ok", provenance: "simulated", data: { amountCents: 7_500, result: "approved", captured: false } },
    { id: "EV-live-bank", tripId: trip.id, kind: "bank_line", source: "Card statement feed (SIMULATED settlement)", fetchedAt: "2026-10-25T10:02:00.000Z", status: "ok", provenance: "simulated", data: { amountCents: 7_500, currency: "USD", captured: false } },
  );
  state.ridePayments = {
    owners: [{ ownerHash: "a".repeat(64), expiresAt: "2026-11-25T00:00:00.000Z" }],
    receipts: [{
      ownerHash: "a".repeat(64),
      fingerprint: "demo-only",
      receipt: {
        id: "ride_sim_demo",
        legId: "ride-one",
        mode: "train",
        service: "Demo train",
        from: "Station A",
        to: "Station B",
        amountCents: 12_345,
        currency: "USD",
        paidAt: "2026-10-25T10:03:00.000Z",
        provenance: "simulated",
        captured: false,
        provider: "visa_simulation",
        amountSource: "traveler_entered_demo",
      },
    }],
  };
  return { state, trip };
}

function counts(state: State, tripId: string) {
  return {
    evidence: state.evidence.filter((item) => item.tripId === tripId).length,
    audit: state.audit.filter((item) => item.subject === tripId).length,
    inbox: state.inbox.filter((item) => item.tripId === tripId).length,
    journal: state.journal.filter((item) => item.refs.includes(tripId)).length,
  };
}

test("an authenticated map finish creates one non-financial signal and an organizer handoff", () => {
  const { state, trip } = fixture();
  const beforeJournal = state.journal.length;
  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId }, new Date("2026-10-25T11:00:00.000Z"));

  assert.deepEqual(result, {
    replayed: false,
    tripState: "needs_human",
    decisionCode: "require_checkin",
    needsHuman: true,
    evidenceId: `EV-${trip.id}-map-completion`,
  });
  const completion = state.evidence.find((item) => item.kind === "trip_completion" && item.tripId === trip.id)!;
  assert.equal(completion.provenance, "live");
  assert.equal(completion.data.reimbursementEvidence, false);
  assert.equal(completion.data.operatorReceipt, false);
  assert.equal(completion.data.bankSettlement, false);
  assert.equal(completion.data.venueCheckin, false);
  assert.equal(state.journal.length, beforeJournal, "map progress alone must not post money");
  const question = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;
  assert.equal(question.askedOf, "organizer");
  assert.match(question.question, /map guidance alone is not attendance proof/i);
  assert.equal(state.evidence.some((item) => item.id === "ride_sim_demo" || item.source === "Demo train"), false);
  assert.equal(verifyChain(state.audit).ok, true);

  const afterFirst = counts(state, trip.id);
  const replay = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId }, new Date("2026-10-25T11:05:00.000Z"));
  assert.equal(replay.replayed, true);
  assert.deepEqual(counts(state, trip.id), afterFirst, "retry must not duplicate evidence, audit, inbox, or journal records");
});

test("organizer attendance confirmation resumes normal reconciliation without using the demo receipt", () => {
  const { state, trip } = fixture();
  completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  const question = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;

  assert.throws(() => answer(state, question.id, { id: "P-organizer", role: "organizer" }, "invented-option"), /option is not available/);
  assert.equal(question.status, "open");
  const result = answer(state, question.id, { id: "P-organizer", role: "organizer" }, "approve", "Badge desk confirmed attendance");

  assert.equal(result.outcome, "reimburse_full");
  assert.equal(trip.state, "reimbursed");
  assert.equal(trip.decision?.payCents, 7_500);
  assert.notEqual(trip.decision?.payCents, state.ridePayments!.receipts[0]!.receipt.amountCents);
  assert.equal(state.evidence.some((item) => item.tripId === trip.id && item.kind === "receipt" && item.source.includes("Visa")), false);
  const attendance = state.evidence.find((item) => item.id === `EV-${trip.id}-organizer-attendance`)!;
  assert.equal(attendance.kind, "checkin");
  assert.equal(attendance.data.confirmedBy, "P-organizer");
  assert.equal(trip.approvals.some((approval) => approval.by === "P-organizer"), false, "attendance evidence must not be relabeled as reimbursement approval");
  assert.equal(verifyChain(state.audit).ok, true);

  const replayCounts = counts(state, trip.id);
  const replay = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  assert.equal(replay.replayed, true);
  assert.deepEqual(counts(state, trip.id), replayCounts);
});

test("the opaque handoff scope cannot complete another traveler's trip", () => {
  const { state, trip } = fixture();
  const before = counts(state, trip.id);
  assert.throws(
    () => completeTripFromMap(state, { tripId: trip.id, travelerId: "T-someone-else" }),
    PermissionDenied,
  );
  assert.deepEqual(counts(state, trip.id), before);
  assert.equal(trip.state, "booked");
});

for (const unbookedState of ["planned", "pre_approved"] as const) {
  test(`a ${unbookedState} handoff records completion but cannot reimburse`, () => {
    const { state, trip } = fixture();
    trip.state = unbookedState;
    state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || !["card_auth", "bank_line"].includes(item.kind));
    const journalBefore = state.journal.length;

    const completion = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
    assert.equal(completion.tripState, "needs_human");
    const attendanceQuestion = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;
    answer(state, attendanceQuestion.id, { id: "P-organizer", role: "organizer" }, "approve");

    assert.equal(trip.state, "needs_human");
    assert.equal(trip.decision?.code, "require_payment_evidence");
    assert.equal(trip.decision?.payCents, 0);
    assert.equal(state.journal.length, journalBefore);
    const controllerQuestion = state.inbox.find((item) => item.tripId === trip.id && item.status === "open" && item.askedOf === "controller")!;
    assert.match(controllerQuestion.question, /before a booked authorization existed/i);
    assert.deepEqual(controllerQuestion.options.map((option) => option.id), ["reject"]);
    assert.equal(state.evidence.some((item) => item.tripId === trip.id && item.kind === "receipt"), false);
  });
}

test("confirmed attendance with no settlement stays unpaid and is not mislabeled a no-show", () => {
  const { state, trip } = fixture();
  state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || item.kind !== "bank_line");
  const journalBefore = state.journal.length;
  completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  const attendanceQuestion = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;
  answer(state, attendanceQuestion.id, { id: "P-organizer", role: "organizer" }, "approve");

  assert.equal(trip.state, "needs_human");
  assert.equal(trip.decision?.code, "require_payment_evidence");
  assert.equal(trip.decision?.payCents, 0);
  assert.equal(state.journal.length, journalBefore);
  assert.equal(state.noShows.some((item) => item.tripId === trip.id), false);

  const controllerQuestion = state.inbox.find((item) => item.tripId === trip.id && item.status === "open" && item.askedOf === "controller")!;
  answer(state, controllerQuestion.id, { id: "P-controller", role: "controller" }, "reject");
  assert.equal(trip.state, "denied");
  assert.equal(state.noShows.some((item) => item.tripId === trip.id), false);
  assert.equal(state.journal.length, journalBefore);
});

test("a planned trip with an existing checked_in record and stray settlement still cannot reimburse", () => {
  const { state, trip } = fixture();
  trip.state = "planned";
  state.evidence.push({ id: "EV-existing-checkin", tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "checked_in" } });
  const journalBefore = state.journal.length;
  const expenseBefore = state.journal.flatMap((entry) => entry.lines).filter((line) => line.account === "5100").reduce((sum, line) => sum + line.debit - line.credit, 0);

  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

  assert.equal(result.tripState, "needs_human");
  assert.equal(result.decisionCode, "require_payment_evidence");
  assert.equal(trip.decision?.payCents, 0);
  assert.equal(state.inbox.some((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion"), false);
  assert.equal(state.inbox.some((item) => item.tripId === trip.id && item.status === "open" && item.askedOf === "controller"), true);
  const expenseAfter = state.journal.flatMap((entry) => entry.lines).filter((line) => line.account === "5100").reduce((sum, line) => sum + line.debit - line.credit, 0);
  assert.equal(expenseAfter, expenseBefore, "a stray settlement must not be reimbursed");
  assert.equal(state.journal.length, journalBefore, "an unbooked completion must not post even to suspense");
});

for (const kind of ["bank_line", "receipt"] as const) {
  for (const status of ["error", "blocked"] as const) {
    test(`${status} ${kind} evidence is ignored and cannot fund a map completion`, () => {
      const { state, trip } = fixture();
      state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || !["bank_line", "receipt"].includes(item.kind));
      state.evidence.push(
        { id: `EV-${kind}-${status}`, tripId: trip.id, kind, source: "Unusable payment feed", fetchedAt: "2026-10-25T10:20:00.000Z", status, provenance: "live", data: kind === "bank_line" ? { amountCents: 7_500, currency: "USD" } : { text: "Rail Operator\nTotal: USD $75.00\n2026-10-25\nReservation ABC123" } },
        { id: `EV-checkin-${kind}-${status}`, tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } },
      );
      const journalBefore = state.journal.length;

      const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

      assert.equal(result.decisionCode, "require_payment_evidence");
      assert.equal(result.tripState, "needs_human");
      assert.equal(trip.decision?.payCents, 0);
      assert.equal(state.journal.length, journalBefore);
    });
  }
}

for (const status of ["error", "blocked"] as const) {
  test(`${status} card authorization evidence is ignored`, () => {
    const { state, trip } = fixture();
    state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || item.kind !== "bank_line");
    const auth = state.evidence.find((item) => item.tripId === trip.id && item.kind === "card_auth")!;
    auth.status = status;
    state.evidence.push({ id: `EV-checkin-auth-${status}`, tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } });
    const journalBefore = state.journal.length;

    const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

    assert.equal(result.decisionCode, "require_payment_evidence");
    assert.equal(result.tripState, "needs_human");
    assert.equal(trip.decision?.payCents, 0);
    assert.equal(state.journal.length, journalBefore);
  });
}

test("a non-USD bank settlement is held without posting", () => {
  const { state, trip } = fixture();
  const bank = state.evidence.find((item) => item.tripId === trip.id && item.kind === "bank_line")!;
  bank.data.currency = "CAD";
  state.evidence.push({ id: "EV-checkin-non-usd", tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } });
  const journalBefore = state.journal.length;

  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

  assert.equal(result.decisionCode, "require_payment_evidence");
  assert.equal(result.tripState, "needs_human");
  assert.equal(trip.decision?.payCents, 0);
  assert.ok(trip.decision?.refs.includes(bank.id));
  assert.equal(state.journal.length, journalBefore);
});

for (const [label, amount] of [
  ["missing", undefined],
  ["not numeric", "7500"],
  ["fractional", 7_500.5],
  ["not finite", Number.POSITIVE_INFINITY],
  ["not a number", Number.NaN],
  ["zero", 0],
  ["negative", -1],
] as const) {
  test(`a ${label} bank amount is held without posting`, () => {
    const { state, trip } = fixture();
    const bank = state.evidence.find((item) => item.tripId === trip.id && item.kind === "bank_line")!;
    bank.data.amountCents = amount;
    state.evidence.push({ id: `EV-checkin-malformed-${label.replaceAll(" ", "-")}`, tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } });
    const journalBefore = state.journal.length;

    const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

    assert.equal(result.decisionCode, "require_payment_evidence");
    assert.equal(result.tripState, "needs_human");
    assert.equal(trip.decision?.payCents, 0);
    assert.equal(state.journal.length, journalBefore);
  });
}

test("a non-finite parsed receipt amount is held without posting", () => {
  const { state, trip } = fixture();
  state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || item.kind !== "bank_line");
  state.evidence.push(
    { id: "EV-overflow-receipt", tripId: trip.id, kind: "receipt", source: "Operator receipt", fetchedAt: "2026-10-25T10:20:00.000Z", status: "ok", provenance: "live", data: { text: `Rail Operator\nTotal: USD $${"9".repeat(400)}.00\n2026-10-25\nReservation ABC123` } },
    { id: "EV-checkin-overflow-receipt", tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } },
  );
  const journalBefore = state.journal.length;

  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

  assert.equal(result.decisionCode, "require_payment_evidence");
  assert.equal(result.tripState, "needs_human");
  assert.equal(trip.decision?.payCents, 0);
  assert.equal(state.journal.length, journalBefore);
});

test("a virtual-card receipt without a valid USD bank settlement stays unpaid", () => {
  const { state, trip } = fixture();
  state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || item.kind !== "bank_line");
  state.evidence.push(
    { id: "EV-receipt-only", tripId: trip.id, kind: "receipt", source: "Operator receipt", fetchedAt: "2026-10-25T10:20:00.000Z", status: "ok", provenance: "live", data: { text: "Rail Operator\nTotal: USD $75.00\n2026-10-25\nReservation ABC123" } },
    { id: "EV-checkin-receipt-only", tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "present" } },
  );
  const journalBefore = state.journal.length;

  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });

  assert.equal(result.decisionCode, "require_payment_evidence");
  assert.equal(result.tripState, "needs_human");
  assert.equal(trip.decision?.payCents, 0);
  assert.ok(trip.decision?.refs.includes("EV-receipt-only"));
  assert.equal(state.journal.length, journalBefore);
});

for (const unbookedState of ["planned", "pre_approved"] as const) {
  test(`a verified absent check-in on a ${unbookedState} trip creates neither a no-show nor a posting`, () => {
    const { state, trip } = fixture();
    trip.state = unbookedState;
    state.evidence.push({ id: `EV-${unbookedState}-absent`, tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "ok", provenance: "live", data: { result: "absent" } });
    const journalBefore = state.journal.length;
    const noShowsBefore = state.noShows.length;

    const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
    assert.equal(result.tripState, "needs_human");
    assert.equal(result.decisionCode, "require_payment_evidence");
    assert.equal(state.journal.length, journalBefore);
    assert.equal(state.noShows.length, noShowsBefore);
    assert.equal(state.inbox.some((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion"), false);

    const review = state.inbox.find((item) => item.tripId === trip.id && item.status === "open" && item.meta.topic === "unbooked_map_completion_review")!;
    answer(state, review.id, { id: "P-controller", role: "controller" }, "reject");
    assert.equal(trip.state, "denied");
    assert.equal(state.journal.length, journalBefore);
    assert.equal(state.noShows.length, noShowsBefore);
  });
}

test("an error-status check-in is ignored and still goes to an organizer", () => {
  const { state, trip } = fixture();
  state.evidence.push({ id: "EV-broken-checkin", tripId: trip.id, kind: "checkin", source: "Venue badge feed", fetchedAt: "2026-10-25T10:30:00.000Z", status: "error", provenance: "live", data: { result: "checked_in" } });

  const result = completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  assert.equal(result.tripState, "needs_human");
  assert.equal(result.decisionCode, "require_checkin");
  const attendanceQuestion = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;
  assert.ok(attendanceQuestion);

  answer(state, attendanceQuestion.id, { id: "P-organizer", role: "organizer" }, "approve");
  assert.equal(trip.state, "reimbursed");
  assert.equal(trip.decision?.code, "reimburse_full");
});

test("map completion closes a stale mandate question so it cannot resurrect the trip", () => {
  const { state, trip } = fixture();
  trip.state = "planned";
  state.evidence = state.evidence.filter((item) => item.tripId !== trip.id || !["card_auth", "bank_line"].includes(item.kind));
  trip.mandateId = "MDT-stale";
  state.mandates.push({
    id: "MDT-stale",
    tripId: trip.id,
    token: "vtok_sim_stale",
    maxCents: trip.quoteCents,
    merchantCategory: "rail",
    expiresAt: "2026-10-28T00:00:00.000Z",
    singleUse: true,
    status: "pending",
    requestedBy: trip.requestedBy,
    provenance: "simulated",
  });
  state.inbox.push({
    id: "Q-stale-mandate",
    kind: "mandate_approval",
    tripId: trip.id,
    meta: { amountCents: trip.quoteCents },
    createdAt: "2026-10-25T10:00:00.000Z",
    askedOf: "traveler",
    question: "Approve the original fare?",
    options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    status: "open",
  });

  completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  const attendanceQuestion = state.inbox.find((item) => item.tripId === trip.id && item.meta.topic === "authenticated_map_completion")!;
  answer(state, attendanceQuestion.id, { id: "P-organizer", role: "organizer" }, "reject");

  assert.equal(trip.state, "needs_human");
  assert.equal(state.mandates.find((mandate) => mandate.id === "MDT-stale")!.status, "void");
  assert.equal(state.inbox.find((item) => item.id === "Q-stale-mandate")!.status, "answered");
  assert.throws(() => answer(state, "Q-stale-mandate", { id: trip.travelerId, role: "traveler" }, "approve"), /question not open/);
  assert.equal(trip.state, "needs_human");
  assert.equal(trip.decision?.code, "require_payment_evidence");
  assert.equal(state.noShows.some((item) => item.tripId === trip.id), false);
  assert.equal(trip.approvals.some((approval) => approval.subject === "mandate"), false);
});

test("map completion closes stale controller pre-approval so it cannot pay against the new decision", () => {
  const { state, trip } = fixture();
  trip.state = "planned";
  state.inbox.push({
    id: "Q-stale-controller",
    kind: "reconcile",
    tripId: trip.id,
    meta: {},
    createdAt: "2026-10-25T10:00:00.000Z",
    askedOf: "controller",
    question: "Pre-approve the original high fare?",
    options: [{ id: "approve", label: "Approve" }, { id: "reject", label: "Reject" }],
    status: "open",
  });

  completeTripFromMap(state, { tripId: trip.id, travelerId: trip.travelerId });
  const stale = state.inbox.find((item) => item.id === "Q-stale-controller")!;
  const journalAfterCompletion = state.journal.length;
  assert.equal(stale.status, "answered");
  assert.deepEqual(stale.answer, {
    by: "agent:orchestrator",
    option: "closed",
    note: "Closed after authenticated post-trip completion",
    at: trip.submittedAt,
  });
  assert.throws(() => answer(state, stale.id, { id: "P-controller", role: "controller" }, "approve"), /question not open/);
  assert.equal(state.journal.length, journalAfterCompletion);
  assert.equal(trip.state, "needs_human");
  assert.equal(trip.decision?.code, "require_checkin");
});

test("period close treats a booked live trip as unresolved", () => {
  const { state, trip } = fixture();
  const expected = state.trips.filter((candidate) => candidate.state === "booked" || candidate.state === "submitted" || candidate.state === "needs_human").length;
  const report = closeReadiness(state);
  assert.equal(report.unresolvedTrips, expected);
  assert.equal(report.ready, false);
  assert.ok(report.issues.some((issue) => issue.includes("trip(s) remain unresolved")));
  assert.equal(trip.state, "booked");
});
