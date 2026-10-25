import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { HeatMap } from "../../backend/src/agents/heat";
import type { PriceEstimate } from "../../backend/src/agents/pricing";
import type { EventListing } from "../../backend/src/eventStore";

// The books live in a throwaway folder; it must be set before the store module loads.
process.env.SMILE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "smile-scheduler-"));
const core = await import("../../backend/src/index");

const NOW = new Date("2026-11-12T17:00:00Z"); // two days before Golden Gate Hack 2026 (E-main)
const range = (p50: number) => ({ p10: p50 * 0.8, p50, p90: p50 * 1.3 });
const prices = (p50: number) => async () => ({ scope: { eligible: true, fromState: "IL", toState: "CA", reason: "Domestic interstate trip from IL to CA." }, rideshare: { uber: range(p50), lyft: range(p50 + 2) }, airfare: null, drive: { status: "ok", source: "test", miles: 12, minutes: 25 }, models: {} }) as unknown as PriceEstimate;
const flightEstimate = (p50: number) => async () => ({ scope: { eligible: true, fromState: "IL", toState: "CA", reason: "Domestic interstate trip from IL to CA." }, rideshare: null, airfare: { from: { code: "PIA" }, to: { code: "SFO" }, range: range(p50) }, drive: { status: "ok", source: "test", miles: 2_000, minutes: 2_000 }, models: {} }) as unknown as PriceEstimate;
const heat = (band: string, feelsLikeF: number) => async () => ({ status: "ok", basis: "forecast", band, summary: `feels like ${feelsLikeF}°F`, cells: [{ feelsLikeF }], hotspots: [] }) as unknown as HeatMap;

async function seedWithLiveTrip() {
  core.saveState(core.buildSeed().state);
  return core.withState((s) => {
    s.travelers.push({ id: "T-live-test", initials: "JP", school: "test", homeZip: "94110" });
    s.trips.push({ id: "TR-L-test", travelerId: "T-live-test", eventId: "E-main", period: s.company.openPeriod, method: "virtual_card", mode: "rideshare", distanceMiles: 4, quoteCents: 2_000, requestedBy: "agent:policy", approvals: [], state: "pre_approved" });
    s.evidence.push({ id: "EV-geo-test", tripId: "TR-L-test", kind: "geocode", source: "test", fetchedAt: NOW.toISOString(), status: "ok", provenance: "live", data: { zip: "94110", lat: 37.75, lon: -122.415 } });
  });
}

const notices = () => core.loadState().inbox.filter((i) => i.kind === "notice" && i.tripId === "TR-L-test");

test("price_watch re-prices upcoming trips and sends one notice per 15% move", async () => {
  await seedWithLiveTrip();
  const r = await core.runJob("price_watch", { now: NOW, prices: prices(30) });
  assert.equal(r.checked, 1);
  assert.equal(r.notices, 1);
  const [n] = notices();
  assert.match(n!.question, /predicted at about \$30\.00 .* 50% above the \$20\.00 on your trip/);
  assert.equal(n!.askedOf, "traveler");
  assert.equal(core.loadState().evidence.filter((e) => e.kind === "price_watch").length, 1);

  // Waking again at the same price doesn't repeat the notice.
  assert.equal((await core.runJob("price_watch", { now: NOW, prices: prices(30) })).notices, 0);
  assert.equal(notices().length, 1);

  const audit = core.loadState().audit;
  assert.ok(audit.some((e) => e.action === "pricing.estimated" && /asked by agent:scheduler/.test(e.reason)));
  assert.ok(audit.some((e) => e.action === "scheduler.price_watch"));
  assert.ok(core.verifyChain(audit).ok);
});

test("price_watch compares a live Google Flights fare with the trained forecast without changing the trip", async () => {
  await seedWithLiveTrip();
  await core.withState((s) => {
    const trip = s.trips.find((item) => item.id === "TR-L-test")!;
    trip.mode = "flight";
    trip.quoteCents = 20_000;
  });
  const flightPrices = async () => ({
    live: { status: "ok", amountUsd: 150, currency: "USD", fromAirport: "PIA", toAirport: "SFO", departDate: "2026-11-13", observedAt: NOW.toISOString(), sourceUrl: "https://www.google.com/travel/flights?q=PIA+SFO", via: "Bright Data Google Flights scraper", ms: 800, snapshotId: "s_scheduler123", collectionState: "ready" },
    prediction: { range: range(190) },
    signal: "below_prediction" as const,
    differencePct: -21,
  }) as any;
  const result = await core.runJob("price_watch", { now: NOW, prices: flightEstimate(190), flightPrices });
  assert.equal(result.notices, 1);
  const state = core.loadState();
  assert.equal(state.trips.find((item) => item.id === "TR-L-test")?.quoteCents, 20_000);
  const evidence = state.evidence.find((item) => item.tripId === "TR-L-test" && item.kind === "price_watch")!;
  assert.equal(evidence.data.liveCents, 15_000);
  assert.equal(evidence.data.predictedCents, 19_000);
  assert.equal(evidence.data.liveSnapshotId, "s_scheduler123");
  assert.equal(evidence.data.liveCollectionState, "ready");
  assert.match(notices()[0]!.question, /Live Google Flights check.*\$150\.00.*forecast is \$152\.00–\$247\.00/);
});

test("a pending Google Flights snapshot is resumed promptly and stops after it is ready", async () => {
  await seedWithLiveTrip();
  await core.withState((s) => {
    s.trips.find((item) => item.id === "TR-L-test")!.mode = "flight";
    s.scheduler = { lastRun: { price_watch: NOW.toISOString() } };
    s.evidence.push({ id: "EV-pending-flight", tripId: "TR-L-test", kind: "price_watch", source: "test", fetchedAt: NOW.toISOString(), status: "ok", provenance: "live", data: { liveStatus: "timeout", liveSnapshotId: "s_pending_agent123", liveCollectionState: "running" } });
  });
  assert.deepEqual(core.dueJobs(core.loadState(), new Date(NOW.getTime() + 4 * 60_000)), ["reconcile", "weather_watch", "event_watch"]);
  assert.ok(core.dueJobs(core.loadState(), new Date(NOW.getTime() + 6 * 60_000)).includes("price_watch"));
  assert.equal(core.priceWatchTargets(core.loadState(), new Date(NOW.getTime() + 6 * 60_000))[0]?.snapshotId, "s_pending_agent123");

  await core.withState((s) => {
    s.evidence.push({ id: "EV-ready-flight", tripId: "TR-L-test", kind: "price_watch", source: "test", fetchedAt: new Date(NOW.getTime() + 7 * 60_000).toISOString(), status: "ok", provenance: "live", data: { liveStatus: "ok", liveSnapshotId: "s_pending_agent123", liveCollectionState: "ready", liveCents: 15_000 } });
  });
  assert.equal(core.priceWatchTargets(core.loadState(), new Date(NOW.getTime() + 8 * 60_000))[0]?.snapshotId, undefined);
  assert.ok(!core.dueJobs(core.loadState(), new Date(NOW.getTime() + 8 * 60_000)).includes("price_watch"));
});

test("weather_watch warns travelers about heat at the venue in the next 3 days", async () => {
  await seedWithLiveTrip();
  assert.equal((await core.runJob("weather_watch", { now: NOW, heat: heat("Comfortable", 64) })).notices, 0);
  assert.equal((await core.runJob("weather_watch", { now: NOW, heat: heat("Extreme caution", 93) })).notices, 1);
  assert.match(notices()[0]!.question, /feels like up to 93°F .*Extreme caution, NWS heat-index bands/);
  // Too far ahead: nothing to check.
  assert.equal((await core.runJob("weather_watch", { now: new Date("2026-11-01T00:00:00Z"), heat: heat("Danger", 110) })).checked, 0);
});

test("event_watch flags a date change, updates the event, and keeps the approved amount", async () => {
  await seedWithLiveTrip();
  const moved: EventListing = { key: "luma-x", source: "luma", name: "Golden Gate Hack 2026", startsAt: "2026-11-15T17:00:00Z", venue: "Fort Mason Center", locationPrecision: "exact", url: "https://lu.ma/example", kind: "hackathon", fetchedAt: NOW.toISOString(), via: "direct" };
  const discover = async () => ({ origin: { zip: "94110", lat: 0, lon: 0 }, radiusMiles: 200, events: [moved], outsideRadius: [], unplaced: [], sources: [], store: "local" as const, classifiedBy: "keywords" as const });
  const r = await core.runJob("event_watch", { now: NOW, discover });
  assert.equal(r.notices, 1);
  const s = core.loadState();
  assert.equal(s.events.find((e) => e.id === "E-main")?.startsAt, "2026-11-15T17:00:00Z");
  assert.equal(s.trips.find((t) => t.id === "TR-L-test")?.quoteCents, 2_000);
  assert.equal(s.evidence.filter((e) => e.kind === "event_change").length, 1);
  assert.ok(s.audit.some((e) => e.action === "event.changed"));
  assert.match(notices()[0]!.question, /now starts Nov 15/);
});

test("answering a notice records it but approves nothing", async () => {
  await seedWithLiveTrip();
  await core.runJob("price_watch", { now: NOW, prices: prices(30) });
  const id = notices()[0]!.id;
  const out = await core.withState((s) => core.answer(s, id, { id: "T-live-test", role: "traveler" }, "ok"));
  assert.equal(out.outcome, "noted");
  const s = core.loadState();
  assert.equal(s.inbox.find((i) => i.id === id)?.status, "answered");
  assert.equal(s.trips.find((t) => t.id === "TR-L-test")?.approvals.length, 0);
  assert.ok(s.audit.some((e) => e.action === "notice.acknowledged"));
});

test("runDue runs every job whose interval has passed, then waits", async () => {
  await seedWithLiveTrip();
  const deps = { now: NOW, prices: prices(20), heat: heat("Comfortable", 60), discover: async () => ({ origin: { zip: "94110", lat: 0, lon: 0 }, radiusMiles: 200, events: [], outsideRadius: [], unplaced: [], sources: [], store: "local" as const, classifiedBy: "keywords" as const }) };
  const first = await core.runDue(deps);
  assert.deepEqual(first.map((r) => r.job), ["reconcile", "price_watch", "weather_watch", "event_watch"]);
  assert.ok(first.every((r) => !("error" in r)));
  assert.match((first[0] as { summary: string }).summary, /^Reconciled \d+ trip/);
  assert.deepEqual(core.dueJobs(core.loadState(), new Date(NOW.getTime() + 60_000)), []);
  assert.deepEqual(core.dueJobs(core.loadState(), new Date(NOW.getTime() + 16 * 60_000)), ["reconcile"]);
});
