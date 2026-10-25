import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.SMILE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "smile-plan-replay-"));
delete process.env.BRIGHTDATA_API_TOKEN;
delete process.env.BRIGHTDATA_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
const core = await import("../../backend/src/index");
const { cachedTripPlan, PlanRequestConflict } = await import("../../backend/src/orchestrator");
core.saveState(core.buildSeed().state);

const args = {
  zip: "94101",
  initials: "QA",
  originCoordinates: { lat: 37.78, lon: -122.42 },
  event: { key: "replay-event", name: "Group trip test", startsAt: "2030-06-15T17:00:00Z", venue: "Event venue", city: "San Francisco, CA", lat: 37.8, lon: -122.43 },
  includeSelfDrive: true,
  travelerBudgetCents: 10_000,
};

test("a message replay reuses the committed trip, mandate, evidence and traveler after reloading the books", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const first = await core.withState((s) => core.planTrip(s, { ...args, requestKey: "group-a:message-1" }));
  const before = core.loadState();
  const repeated = await core.withState((s) => core.planTrip(s, { ...args, requestKey: "group-a:message-1" }));
  const after = core.loadState();
  assert.equal(repeated.trip.id, first.trip.id);
  assert.equal(repeated.trip.travelerId, first.trip.travelerId);
  assert.deepEqual(repeated, JSON.parse(JSON.stringify(first)));
  assert.equal(after.trips.length, before.trips.length);
  assert.equal(after.travelers.length, before.travelers.length);
  assert.equal(after.mandates.length, before.mandates.length);
  assert.equal(after.inbox.length, before.inbox.length);
  assert.equal(after.evidence.length, before.evidence.length);
  assert.ok(first.trip.mandateId);
});

test("concurrent deliveries of one message create only one trip", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const before = core.loadState().trips.length;
  const results = await Promise.all(Array.from({ length: 4 }, () => core.withState((s) => core.planTrip(s, { ...args, requestKey: "group-a:message-2" }))));
  assert.equal(new Set(results.map((r) => r.trip.id)).size, 1);
  assert.equal(core.loadState().trips.length, before + 1);
});

test("a reused message identifier cannot silently change its budget or destination", async () => {
  const before = core.loadState().trips.length;
  await assert.rejects(core.withState((s) => core.planTrip(s, { ...args, travelerBudgetCents: 50_000, requestKey: "group-a:message-1" })), PlanRequestConflict);
  await assert.rejects(core.withState((s) => core.planTrip(s, { ...args, event: { ...args.event, key: "other-event" }, requestKey: "group-a:message-1" })), PlanRequestConflict);
  assert.equal(core.loadState().trips.length, before);
});

test("reordered object fields do not turn a retry into a different request", async () => {
  const result = await core.withState((s) => core.planTrip(s, { ...args, originCoordinates: { lon: -122.42, lat: 37.78 }, requestKey: "group-a:message-1" }));
  assert.ok(result.trip.id);
});

test("a committed plan can be recovered without asking a model to reconstruct its inputs", () => {
  const state = core.loadState();
  const recovered = cachedTripPlan(state, "group-a:message-1");
  assert.ok(recovered);
  assert.ok(Number.isFinite(Date.parse(recovered.createdAt)));
  assert.equal(cachedTripPlan(state, "unknown-message"), undefined);
  assert.ok(state.trips.some((trip) => trip.id === recovered.result.trip.id));
  recovered.result.trip.id = "changed-in-memory";
  assert.notEqual(cachedTripPlan(state, "group-a:message-1")!.result.trip.id, "changed-in-memory");
});

test("a new message or another direct conversation can intentionally request a new trip", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const before = core.loadState().trips.length;
  const next = await core.withState((s) => core.planTrip(s, { ...args, requestKey: "group-a:message-3" }));
  const other = await core.withState((s) => core.planTrip(s, { ...args, requestKey: "group-b:message-1" }));
  assert.notEqual(next.trip.id, other.trip.id);
  assert.equal(core.loadState().trips.length, before + 2);
});
