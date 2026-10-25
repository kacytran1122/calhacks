import assert from "node:assert/strict";
import test from "node:test";
import { buildSeed } from "../../backend/src/seed/trips";
import { createRideDemoOwner, createRidePayment, listRidePayments, requireRideDemoStorage, RidePaymentError, RIDE_DEMO_LIMITS, RIDE_DEMO_SESSION_SECONDS } from "../../backend/visa/ridePayments";

const input = { legId: "route-one:bus:0", mode: "bus", service: "Public express", from: "Origin stop", to: "Venue stop", amountCents: 250, completed: true, consent: true };

test("completed rides create private simulated receipts without affecting trip finances or calling a network", (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network call belongs in a demo receipt"); });
  const state = buildSeed().state;
  const finances = JSON.stringify([state.trips, state.evidence, state.mandates, state.journal]);
  const owner = createRideDemoOwner(state);
  const created = createRidePayment(state, owner.token, input);
  assert.equal(created.replayed, false);
  const { completed, consent, ...details } = input;
  assert.deepEqual({ ...created.receipt, id: "server-id", paidAt: "server-time" }, { ...details, id: "server-id", paidAt: "server-time", currency: "USD", provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "traveler_entered_demo" });
  assert.match(created.receipt.id, /^ride_sim_/);
  assert.ok(Number.isFinite(Date.parse(created.receipt.paidAt)));
  assert.equal(JSON.stringify([state.trips, state.evidence, state.mandates, state.journal]), finances);
  assert.equal(JSON.stringify(state.ridePayments).includes(owner.token), false);
  assert.match(state.ridePayments!.owners[0]!.ownerHash, /^[a-f0-9]{64}$/);
  assert.equal("ownerHash" in created.receipt, false);
  assert.equal(state.audit.at(-1)!.reason.includes(input.from), false);
});

test("same-owner retries reuse their exact receipt and changed ride details are rejected", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const first = createRidePayment(state, owner.token, input);
  const retry = createRidePayment(state, owner.token, { ...input });
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.receipt, first.receipt);
  assert.equal(state.ridePayments!.receipts.length, 1);
  assert.throws(() => createRidePayment(state, owner.token, { ...input, amountCents: 500 }), (error) => error instanceof RidePaymentError && error.status === 409);
  assert.throws(() => createRidePayment(state, owner.token, { ...input, to: "Different stop" }), (error) => error instanceof RidePaymentError && error.status === 409);
  assert.equal(listRidePayments(state, owner.token)[0]!.amountCents, 250);
});

test("bus, train, and taxi rides each produce a separate simulated receipt", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  for (const mode of ["bus", "train", "taxi"] as const) {
    const result = createRidePayment(state, owner.token, { ...input, mode, legId: `journey:${mode}` });
    assert.equal(result.receipt.mode, mode);
    assert.equal(result.receipt.provenance, "simulated");
    assert.equal(result.receipt.captured, false);
  }
  assert.equal(listRidePayments(state, owner.token).length, 3);
});

test("owners cannot list or collide with another owner's ride receipts", () => {
  const state = buildSeed().state;
  const a = createRideDemoOwner(state);
  const b = createRideDemoOwner(state);
  const first = createRidePayment(state, a.token, input);
  assert.deepEqual(listRidePayments(state, b.token), []);
  const second = createRidePayment(state, b.token, input);
  assert.notEqual(first.receipt.id, second.receipt.id);
  assert.equal(listRidePayments(state, a.token)[0]!.id, first.receipt.id);
  assert.equal(listRidePayments(state, b.token)[0]!.id, second.receipt.id);
  assert.throws(() => listRidePayments(state, "x".repeat(43)), (error) => error instanceof RidePaymentError && error.status === 401);
});

test("invalid consent, completion, amounts, text, and card fields fail before any receipt state changes", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const before = JSON.stringify(state);
  for (const change of [{ completed: false }, { consent: false }, { amountCents: 0 }, { amountCents: 1.1 }, { amountCents: -1 }, { amountCents: RIDE_DEMO_LIMITS.maxAmountCents + 1 }, { mode: "drive" }, { service: "x".repeat(121) }, { to: "venue\u0000" }, { cardNumber: "4111111111111111" }, { card: { cvv: "123" } }, { ownerHash: "other-owner" }]) {
    assert.throws(() => createRidePayment(state, owner.token, { ...input, ...change }), (error) => error instanceof RidePaymentError && error.status === 400);
    assert.equal(JSON.stringify(state), before);
  }
});

test("expired demo sessions require re-enabling and serverless receipt storage fails closed", () => {
  const state = buildSeed().state;
  const now = new Date("2030-01-01T00:00:00Z");
  const owner = createRideDemoOwner(state, now);
  const expired = new Date(now.getTime() + RIDE_DEMO_SESSION_SECONDS * 1000 + 1);
  assert.throws(() => listRidePayments(state, owner.token, expired), (error) => error instanceof RidePaymentError && error.code === "ride_demo_session_expired");
  assert.throws(() => createRidePayment(state, owner.token, input, expired), (error) => error instanceof RidePaymentError && error.status === 401);
  assert.throws(() => requireRideDemoStorage({ VERCEL: "1" }), (error) => error instanceof RidePaymentError && error.status === 503);
  assert.doesNotThrow(() => requireRideDemoStorage({}));
});

test("bounded receipt storage keeps exact retries available after the owner limit", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  for (let i = 0; i < RIDE_DEMO_LIMITS.receiptsPerOwner; i += 1) createRidePayment(state, owner.token, { ...input, legId: `leg-${i}` });
  assert.throws(() => createRidePayment(state, owner.token, { ...input, legId: "one-too-many" }), (error) => error instanceof RidePaymentError && error.status === 429);
  assert.equal(createRidePayment(state, owner.token, { ...input, legId: "leg-0" }).replayed, true);
  assert.equal(state.ridePayments!.receipts.length, RIDE_DEMO_LIMITS.receiptsPerOwner);
});
