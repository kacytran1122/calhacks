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

test("the selected departure remains identifiable through approval and checkout repricing", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("api.zippopotam.us")) return new Response(JSON.stringify({ places: [{ latitude: "37.78", longitude: "-122.42", "place name": "San Francisco", "state abbreviation": "CA" }] }), { status: 200 });
    if (url.includes("api.transitous.org")) return new Response(JSON.stringify({ itineraries: [0, 30].map((offset) => {
      const startTime = new Date(Date.parse("2030-06-15T14:00:00Z") + offset * 60_000).toISOString();
      const endTime = new Date(Date.parse(startTime) + 3_600_000).toISOString();
      return { duration: 3600, startTime, endTime, transfers: 0, legs: [{ mode: "BUS", from: { name: "Origin stop", tz: "America/Los_Angeles" }, to: { name: "Venue stop", tz: "America/Los_Angeles" }, duration: 3600, startTime, endTime, realTime: false, displayName: "Public express", agencyName: "Local transit" }], fareTransfers: [{ transferProducts: [{ name: "Adult", amount: 20, currency: "USD" }] }] };
    }) }), { status: 200 });
    return new Response("unavailable", { status: 503 });
  });
  const state = core.buildSeed().state;
  const planned = await core.planTrip(state, { ...args, includeSelfDrive: false });
  assert.equal(planned.routes?.options.length, 2);
  const title = planned.routes?.pick?.routeTitle;
  assert.ok(title);
  assert.equal(planned.trip.routeTitle, title);
  assert.match(title, /departs/);
  assert.ok(planned.inbox?.question.includes(title));
  assert.equal(planned.inbox?.meta.routeTitle, title);
  core.answer(state, planned.inbox!.id, { id: planned.trip.travelerId, role: "traveler" }, "approve");
  assert.equal(planned.trip.state, "pre_approved");
  delete planned.trip.routeTitle;
  const declined = await core.bookTrip(state, planned.trip.id, 100);
  assert.equal(declined.ok, false);
  assert.equal(planned.trip.routeTitle, title);
  const quote = state.evidence.filter((e) => e.tripId === planned.trip.id && e.kind === "quote").at(-1)!;
  assert.equal(quote.data.routeTitle, title);
  assert.equal(quote.data.amountCents, 2100);
  const followUp = state.inbox.filter((item) => item.tripId === planned.trip.id && item.kind === "mandate_approval" && item.status === "open").at(-1)!;
  assert.ok(followUp.question.includes(title));
  assert.equal(followUp.meta.routeTitle, title);
  core.answer(state, followUp.id, { id: planned.trip.travelerId, role: "traveler" }, "approve");
  assert.equal(planned.trip.quoteCents, 2100);
  assert.equal(planned.trip.routeTitle, title);
  assert.equal(state.mandates.find((mandate) => mandate.id === planned.trip.mandateId)?.approvalBinding?.fareEvidenceId, quote.id);
});

test("the no-self-drive preference survives saving and replaying a trip", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const input = { ...args, includeSelfDrive: false, requestKey: "group-a:no-driving" };
  const planned = await core.withState((s) => core.planTrip(s, input));
  assert.equal(planned.trip.includeSelfDrive, false);
  assert.equal(core.loadState().trips.find(trip => trip.id === planned.trip.id)?.includeSelfDrive, false);
  const replayed = await core.withState((s) => core.planTrip(s, input));
  assert.equal(replayed.trip.includeSelfDrive, false);
  assert.ok(replayed.routes?.options.every(option => option.mode !== "drive"));
});
