import assert from "node:assert/strict";
import test from "node:test";
import { buildSeed } from "../../backend/src/seed/trips";
import { createRideDemoOwner, createRidePayment, createTripDemoReceipt, listRidePayments, listTripDemoReceipts, requireRideDemoStorage, RidePaymentError, RIDE_DEMO_LIMITS, RIDE_DEMO_SESSION_SECONDS } from "../../backend/visa/ridePayments";

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

const legDetails = (receipt: { legId: string; mode: "bus" | "train" | "taxi"; service: string; from: string; to: string }) => ({ legId: receipt.legId, mode: receipt.mode, service: receipt.service, from: receipt.from, to: receipt.to });

test("final journey receipts sum only matching owned demo records and identify unpaid legs without another charge", (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network call belongs in a final demo receipt"); });
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const finances = JSON.stringify([state.trips, state.evidence, state.mandates, state.journal]);
  const bus = createRidePayment(state, owner.token, { ...input, journeyId: "complete-trip" }).receipt;
  const train = createRidePayment(state, owner.token, { ...input, journeyId: "complete-trip", legId: "rail:0", mode: "train", amountCents: 575 }).receipt;
  createRidePayment(state, owner.token, { ...input, journeyId: "other-trip", legId: "other-trip:0", amountCents: 900 });
  createRidePayment(state, owner.token, { ...input, legId: "legacy:0", amountCents: 300 });
  const payload = { journeyId: "complete-trip", from: "Trip start", to: "Trip end", completed: true, legs: [{ ...legDetails(bus), expectedReceiptId: bus.id }, { ...legDetails(train), expectedReceiptId: train.id }, { ...legDetails(bus), legId: "taxi:0", mode: "taxi" }] };
  const result = createTripDemoReceipt(state, owner.token, payload);
  assert.equal(result.replayed, false);
  assert.equal(result.receipt.totalRecordedCents, 825);
  assert.deepEqual(result.receipt.legs.map((leg) => [leg.status, leg.amountCents, leg.receiptId]), [["demo_receipt_recorded", 250, bus.id], ["demo_receipt_recorded", 575, train.id], ["no_payment_recorded", null, undefined]]);
  assert.equal("expectedReceiptId" in result.receipt.legs[0]!, false);
  assert.equal(result.receipt.captured, false);
  assert.equal(result.receipt.amountSource, "owned_demo_receipts");
  assert.equal(result.receipt.provider, "visa_simulation");
  assert.equal(state.ridePayments!.receipts.length, 4);
  assert.equal(JSON.stringify([state.trips, state.evidence, state.mandates, state.journal]), finances);
  assert.equal(JSON.stringify(result).includes(state.ridePayments!.owners[0]!.ownerHash), false);
  assert.equal(state.audit.at(-1)!.reason.includes(payload.from), false);
  assert.deepEqual(createTripDemoReceipt(state, owner.token, payload).receipt, result.receipt);
  assert.equal(createTripDemoReceipt(state, owner.token, payload).replayed, true);
  assert.equal(state.ridePayments!.tripReceipts!.length, 1);
  assert.equal(createRidePayment(state, owner.token, { ...input, journeyId: "complete-trip" }).replayed, true);
  assert.throws(() => createRidePayment(state, owner.token, { ...input, journeyId: "complete-trip", legId: "new-ride" }), (error) => error instanceof RidePaymentError && error.code === "ride_demo_journey_closed");
  assert.throws(() => createTripDemoReceipt(state, owner.token, { ...payload, to: "Different destination" }), (error) => error instanceof RidePaymentError && error.status === 409);
  result.receipt.legs[0]!.amountCents = 1;
  assert.equal(listTripDemoReceipts(state, owner.token)[0]!.legs[0]!.amountCents, 250);
});

test("a known receipt cannot be downgraded or borrowed from another journey or owner", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const other = createRideDemoOwner(state);
  const receipt = createRidePayment(state, owner.token, { ...input, journeyId: "owned-trip" }).receipt;
  const payload = { journeyId: "owned-trip", from: "A", to: "B", completed: true, legs: [{ ...legDetails(receipt), expectedReceiptId: receipt.id }] };
  const fails = (token: string, value: unknown) => assert.throws(() => createTripDemoReceipt(state, token, value), (error) => error instanceof RidePaymentError && error.code === "ride_demo_trip_unverifiable");
  fails(other.token, payload);
  fails(owner.token, { ...payload, journeyId: "unrelated-trip" });
  fails(owner.token, { ...payload, legs: [] });
  fails(owner.token, { ...payload, legs: [{ ...payload.legs[0], service: "Different service" }] });
  fails(owner.token, { ...payload, legs: [{ ...payload.legs[0], expectedReceiptId: "not-the-original" }] });
  assert.equal(state.ridePayments!.tripReceipts, undefined);
  assert.deepEqual(listTripDemoReceipts(state, other.token), []);
  assert.equal(state.ridePayments!.receipts.length, 1);
});

test("walking-only final summaries record no payments without inventing a fare and expire with their session", () => {
  const state = buildSeed().state;
  const now = new Date("2030-01-01T00:00:00Z");
  const owner = createRideDemoOwner(state, now);
  const result = createTripDemoReceipt(state, owner.token, { journeyId: "walk-only", from: "A", to: "B", completed: true, legs: [] }, now);
  assert.equal(result.receipt.totalRecordedCents, 0);
  assert.deepEqual(result.receipt.legs, []);
  assert.equal(state.ridePayments!.receipts.length, 0);
  const expired = new Date(now.getTime() + RIDE_DEMO_SESSION_SECONDS * 1000 + 1);
  assert.throws(() => listTripDemoReceipts(state, owner.token, expired), (error) => error instanceof RidePaymentError && error.status === 401);
  assert.deepEqual(state.ridePayments!.tripReceipts, []);
});

test("final receipt input rejects client totals, duplicate legs, card fields, and invalid journey details before writes", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const base = { journeyId: "trip", from: "A", to: "B", completed: true, legs: [legDetails({ ...input, mode: "bus" })] };
  const before = JSON.stringify(state);
  for (const payload of [{ ...base, totalRecordedCents: 1 }, { ...base, completed: false }, { ...base, card: "4111111111111111" }, { ...base, journeyId: "x".repeat(201) }, { ...base, to: "B\u0000" }, { ...base, legs: [...base.legs, ...base.legs] }, { ...base, legs: [{ ...base.legs[0], amountCents: 250 }] }, { ...base, legs: [{ ...base.legs[0], expectedReceiptId: "x".repeat(201) }] }, { ...base, legs: Array.from({ length: RIDE_DEMO_LIMITS.tripLegs + 1 }, (_, i) => ({ ...base.legs[0], legId: String(i) })) }]) {
    assert.throws(() => createTripDemoReceipt(state, owner.token, payload), (error) => error instanceof RidePaymentError && error.status === 400);
    assert.equal(JSON.stringify(state), before);
  }
});

test("bounded final summary storage preserves immutable exact retries", () => {
  const state = buildSeed().state;
  const owner = createRideDemoOwner(state);
  const payload = { journeyId: "journey-0", from: "A", to: "B", completed: true, legs: [] };
  for (let index = 0; index < RIDE_DEMO_LIMITS.tripReceiptsPerOwner; index += 1) createTripDemoReceipt(state, owner.token, { ...payload, journeyId: `journey-${index}` });
  assert.equal(createTripDemoReceipt(state, owner.token, payload).replayed, true);
  assert.throws(() => createTripDemoReceipt(state, owner.token, { ...payload, journeyId: "one-too-many" }), (error) => error instanceof RidePaymentError && error.status === 429);
  assert.equal(listTripDemoReceipts(state, owner.token).length, RIDE_DEMO_LIMITS.tripReceiptsPerOwner);
});
