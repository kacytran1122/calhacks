import assert from "node:assert/strict";
import test from "node:test";
import { bindApproval, closeReadiness, paymentPreflight } from "../../backend/hyphenate/financeControls";
import { createMandate } from "../../backend/visa/visaSim";
import { buildSeed } from "../../backend/src/seed/trips";
import type { Trip } from "../../backend/src/types";
import { chargeTrip } from "../../backend/visa/payments";

function fixture() {
  const { state } = buildSeed();
  const trip: Trip = {
    id: "TR-control",
    travelerId: state.travelers[0]!.id,
    eventId: state.events[0]!.id,
    period: state.company.openPeriod,
    method: "virtual_card",
    mode: "train",
    distanceMiles: 90,
    quoteCents: 7_500,
    requestedBy: "agent:policy",
    approvals: [],
    state: "pre_approved",
  };
  state.trips.push(trip);
  state.evidence.push({ id: "EV-control-quote", tripId: trip.id, kind: "quote", source: "live fare", fetchedAt: "2026-10-24T12:00:00Z", status: "ok", provenance: "live", data: { amountCents: 7_500 } });
  const mandate = createMandate({ tripId: trip.id, maxCents: 7_500, merchantCategory: "rail", requestedBy: trip.requestedBy });
  mandate.status = "approved";
  state.mandates.push(mandate);
  trip.mandateId = mandate.id;
  bindApproval(state, trip, mandate, "2026-10-24T12:01:00Z");
  return { state, trip, mandate };
}

test("authorization is bound to the exact approved fare and context", () => {
  const { state, trip, mandate } = fixture();
  assert.equal(paymentPreflight(state, trip, mandate, 7_500, "rail").ok, true);
  const changed = paymentPreflight(state, trip, mandate, 7_501, "rail");
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "approval_changed");
});

test("a newer fare invalidates the previous approval", () => {
  const { state, trip, mandate } = fixture();
  state.evidence.push({ id: "EV-new-quote", tripId: trip.id, kind: "quote", source: "checkout", fetchedAt: "2026-10-24T12:02:00Z", status: "ok", provenance: "live", data: { amountCents: 8_000 } });
  const result = paymentPreflight(state, trip, mandate, 7_500, "rail");
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale_fare");
});

test("an authorization key can only be processed once", () => {
  const { state, trip, mandate } = fixture();
  const first = paymentPreflight(state, trip, mandate, 7_500, "rail");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  mandate.authorization = { idempotencyKey: first.idempotencyKey, provider: "simulated", status: "authorized", amountCents: 7_500, authorizedAt: "2026-10-24T12:03:00Z" };
  const second = paymentPreflight(state, trip, mandate, 7_500, "rail");
  assert.equal(second.ok, false);
  assert.equal(second.code, "duplicate_authorization");
});

test("the payment agent authorizes once and blocks a replay", async () => {
  const { state, trip, mandate } = fixture();
  const first = await chargeTrip(state, trip.id, 7_500, "rail ticket");
  assert.equal(first.ok, true);
  assert.equal(mandate.status, "consumed");
  assert.equal(first.evidence.some((e) => e.kind === "card_auth"), true);
  const second = await chargeTrip(state, trip.id, 7_500, "rail ticket");
  assert.equal(second.ok, false);
  assert.match(second.detail, /already processed/);
  assert.equal(state.evidence.filter((e) => e.kind === "card_auth" && e.tripId === trip.id).length, 1);
});

test("close readiness surfaces unresolved work without changing the books", () => {
  const { state } = buildSeed();
  const report = closeReadiness(state);
  assert.equal(report.booksBalanced, true);
  assert.equal(typeof report.authorizedCents, "number");
  assert.equal(report.ready, false);
  assert.ok(report.issues.length > 0);
});
