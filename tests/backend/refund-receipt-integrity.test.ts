import assert from "node:assert/strict";
import test from "node:test";
import { decide, parseReceipt } from "../../backend/hyphenate/agents/reconciler";
import { answer, tick } from "../../backend/src/orchestrator";
import { buildSeed } from "../../backend/src/seed/trips";
import type { Evidence } from "../../backend/src/types";

function refundFixture() {
  const { state } = buildSeed();
  const trip = state.trips.find((candidate) => candidate.id === "TR-F-19")!;
  for (const candidate of state.trips) if (candidate.id !== trip.id) candidate.state = "closed";
  trip.state = "reimbursed";
  const refund = state.evidence.find((candidate) => candidate.tripId === trip.id && candidate.kind === "refund")!;
  refund.status = "ok";
  refund.data = { amountCents: 2_900, currency: "USD", descriptor: "VALID REFUND", processed: false };
  state.inbox = state.inbox.filter((item) => item.tripId !== trip.id);
  return { state, trip, refund };
}

for (const [label, change] of [
  ["error status", (refund: Evidence) => { refund.status = "error"; }],
  ["blocked status", (refund: Evidence) => { refund.status = "blocked"; }],
  ["non-USD currency", (refund: Evidence) => { refund.data.currency = "CAD"; }],
  ["missing amount", (refund: Evidence) => { delete refund.data.amountCents; }],
  ["string amount", (refund: Evidence) => { refund.data.amountCents = "2900"; }],
  ["fractional amount", (refund: Evidence) => { refund.data.amountCents = 2_900.5; }],
  ["infinite amount", (refund: Evidence) => { refund.data.amountCents = Number.POSITIVE_INFINITY; }],
  ["NaN amount", (refund: Evidence) => { refund.data.amountCents = Number.NaN; }],
  ["zero amount", (refund: Evidence) => { refund.data.amountCents = 0; }],
  ["negative amount", (refund: Evidence) => { refund.data.amountCents = -2_900; }],
] as const) {
  test(`a pending refund with ${label} is held and never posted`, async () => {
    const { state, trip, refund } = refundFixture();
    change(refund);
    const journalBefore = state.journal.length;

    const first = await tick(state);
    assert.deepEqual(first.map((item) => item.code), ["require_payment_evidence"]);
    assert.equal(trip.state, "needs_human");
    assert.equal(trip.decision?.payCents, 0);
    assert.equal(refund.data.processed, false);
    assert.equal(state.journal.length, journalBefore);
    const review = state.inbox.find((item) => item.tripId === trip.id && item.status === "open" && item.meta.topic === "invalid_refund_evidence_review")!;
    assert.ok(review);

    assert.deepEqual(await tick(state), []);
    assert.equal(state.journal.length, journalBefore);
    answer(state, review.id, { id: "P-maya", role: "controller" }, "reject");
    assert.equal(trip.state, "closed");
    assert.equal(refund.data.processed, false);
    assert.equal(state.journal.length, journalBefore);
  });
}

test("an already processed refund is not selected again", async () => {
  const { state, trip, refund } = refundFixture();
  refund.data.processed = true;
  const journalBefore = state.journal.length;

  assert.deepEqual(await tick(state), []);
  assert.equal(trip.state, "reimbursed");
  assert.equal(state.journal.length, journalBefore);
});

test("multiple valid refunds are posted one per tick and mark only the exact evidence", async () => {
  const { state, trip, refund: firstRefund } = refundFixture();
  const secondRefund: Evidence = {
    id: "EV-second-valid-refund",
    tripId: trip.id,
    kind: "refund",
    source: "Card statement feed",
    fetchedAt: "2026-10-25T12:00:00.000Z",
    status: "ok",
    provenance: "live",
    data: { amountCents: 700, currency: "USD", descriptor: "SECOND REFUND", processed: false },
  };
  state.evidence.push(secondRefund);
  const journalBefore = state.journal.length;

  const first = await tick(state);
  assert.deepEqual(first.map((item) => item.code), ["recover_refund"]);
  assert.equal(firstRefund.data.processed, true);
  assert.equal(secondRefund.data.processed, false);
  assert.equal(trip.state, "reimbursed");
  assert.equal(state.journal.length, journalBefore + 1);
  assert.ok(state.journal.at(-1)!.refs.includes(firstRefund.id));
  assert.equal(state.journal.at(-1)!.refs.includes(secondRefund.id), false);

  const second = await tick(state);
  assert.deepEqual(second.map((item) => item.code), ["recover_refund"]);
  assert.equal(secondRefund.data.processed, true);
  assert.equal(trip.state, "closed");
  assert.equal(state.journal.length, journalBefore + 2);
  assert.ok(state.journal.at(-1)!.refs.includes(secondRefund.id));
  assert.equal(state.journal.at(-1)!.refs.includes(firstRefund.id), false);

  assert.deepEqual(await tick(state), []);
  assert.equal(state.journal.length, journalBefore + 2);
});

test("a valid refund after an invalid pending row is selected exactly, then the invalid row is held", async () => {
  const { state, trip, refund: invalidRefund } = refundFixture();
  invalidRefund.data.currency = "CAD";
  const validRefund: Evidence = {
    id: "EV-valid-after-invalid",
    tripId: trip.id,
    kind: "refund",
    source: "Card statement feed",
    fetchedAt: "2026-10-25T12:00:00.000Z",
    status: "ok",
    provenance: "live",
    data: { amountCents: 500, currency: "USD", descriptor: "VALID LATER REFUND", processed: false },
  };
  state.evidence.push(validRefund);
  const journalBefore = state.journal.length;

  await tick(state);
  assert.equal(invalidRefund.data.processed, false);
  assert.equal(validRefund.data.processed, true);
  assert.equal(state.journal.length, journalBefore + 1);
  assert.equal(trip.state, "reimbursed");

  const held = await tick(state);
  assert.deepEqual(held.map((item) => item.code), ["require_payment_evidence"]);
  assert.equal(trip.state, "needs_human");
  assert.equal(state.journal.length, journalBefore + 1);
  assert.equal(invalidRefund.data.processed, false);
});

test("receipt fingerprints require a supported currency, safe positive cents, a real date, and a reference", () => {
  const validCad = parseReceipt("Greyhound Lines\nOrder # BUS-123\n2026-10-16\nTOTAL CAD 61.50");
  assert.ok(validCad.fingerprint);
  assert.equal(parseReceipt("Greyhound Lines\nOrder # BUS-123\n2026-02-30\nTOTAL CAD 61.50").fingerprint, undefined);
  assert.equal(parseReceipt("Greyhound Lines\n2026-10-16\nTOTAL CAD 61.50").fingerprint, undefined);
  assert.equal(parseReceipt(`Greyhound Lines\nOrder # BUS-123\n2026-10-16\nTOTAL USD ${"9".repeat(400)}.00`).fingerprint, undefined);
});

test("a malformed current receipt cannot trigger duplicate rejection", () => {
  const { state } = buildSeed();
  const trip = state.trips.find((candidate) => candidate.id === "TR-F-22")!;
  const receipt = state.evidence.find((candidate) => candidate.tripId === trip.id && candidate.kind === "receipt")!;
  receipt.data.text = String(receipt.data.text).replace("2026-10-16", "2026-02-30");

  assert.notEqual(decide(state, trip).code, "reject_duplicate");
});

test("a malformed prior receipt cannot make a later valid receipt look duplicated", () => {
  const { state } = buildSeed();
  const trip = state.trips.find((candidate) => candidate.id === "TR-F-22")!;
  const prior = state.evidence.find((candidate) => candidate.tripId === "TR-F-02" && candidate.kind === "receipt")!;
  prior.data.text = String(prior.data.text).replace("Ride ID LYFT-88213", "Receipt reference unavailable");

  assert.notEqual(decide(state, trip).code, "reject_duplicate");
});

test("an overflowing aggregate of individually valid bank lines is held", () => {
  const { state } = buildSeed();
  const trip = state.trips.find((candidate) => candidate.id === "TR-F-11")!;
  const banks = state.evidence.filter((candidate) => candidate.tripId === trip.id && candidate.kind === "bank_line");
  assert.equal(banks.length, 2);
  for (const bank of banks) bank.data.amountCents = Number.MAX_SAFE_INTEGER;

  const decision = decide(state, trip);
  assert.equal(decision.code, "require_payment_evidence");
  assert.equal(decision.payCents, 0);
  assert.deepEqual(decision.refs, banks.map((bank) => bank.id));
});
