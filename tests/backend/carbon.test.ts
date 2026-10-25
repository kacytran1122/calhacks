import assert from "node:assert/strict";
import test from "node:test";
import { compareRoutes } from "../../backend/src/agents/route";
import { compareCarbon, estimateCarbon, FACTORS, organizerCarbon } from "../../backend/src/carbon";
import { buildSeed } from "../../backend/src/seed/trips";
import type { Trip } from "../../backend/src/types";

test("EPA Table 10 factors combine CO₂, CH₄ and N₂O with AR5 warming potentials", () => {
  // 0.297 kg CO₂ + 0.0059 g CH₄ × 28 + 0.0053 g N₂O × 265, per vehicle-mile
  assert.equal(FACTORS.car.kgPerUnit, 0.2986);
  assert.equal(FACTORS.bus.kgPerUnit, 0.0666);
  assert.equal(FACTORS.commuterRail.kgPerUnit, 0.134);
  assert.equal(FACTORS.intercityRail.kgPerUnit, 0.1504);
  assert.equal(FACTORS.airShort.kgPerUnit, 0.2089);
  assert.equal(FACTORS.rideshare.kgPerUnit, 0.301);
  assert.equal(FACTORS.rideshare.source, "carb");
});

test("every mode is factor × distance, and the formula says so", () => {
  const ctx = { straightMiles: 80, roadMiles: 100 };
  assert.equal(estimateCarbon("drive", ctx)?.kg, 29.9);
  assert.equal(estimateCarbon("rideshare", ctx)?.kg, 30.1);
  assert.equal(estimateCarbon("bus", ctx)?.kg, 6.7);
  assert.equal(estimateCarbon("train", ctx)?.factor.id, "intercity_rail"); // over 75 mi, outside the Northeast Corridor
  assert.equal(estimateCarbon("train", { straightMiles: 30, roadMiles: 40 })?.factor.id, "commuter_rail");
  const pool = estimateCarbon("carpool", { ...ctx, carpool: { people: 3, detourMiles: 0, hypothetical: false } });
  assert.equal(pool?.kg, 10);
  assert.match(pool!.formula, /÷ 3 travelers/);
  for (const e of compareCarbon(ctx).estimates) assert.match(e.formula, /kg CO₂e per (vehicle|passenger)-mile × /);
});

test("without a live road route, distance is the straight line × 1.2 and says so", () => {
  const e = estimateCarbon("drive", { straightMiles: 50 })!;
  assert.equal(e.miles, 60);
  assert.match(e.basis, /straight-line distance × 1.2/);
});

test("Northeast Corridor trains use Amtrak's electrified-corridor factor", () => {
  const nyc = { lat: 40.75, lon: -73.99 };
  const dc = { lat: 38.9, lon: -77.0 };
  assert.equal(estimateCarbon("train", { straightMiles: 205, roadMiles: 225, from: nyc, to: dc })?.factor.id, "intercity_rail_nec");
});

test("a flight counts the air miles between the nearest airports plus the rides to them", () => {
  const e = estimateCarbon("flight", { straightMiles: 350, from: { lat: 37.87, lon: -122.27 }, to: { lat: 34.07, lon: -118.44 } })!;
  assert.ok(e);
  assert.match(e.formula, /mi flown \+ .* mi of airport rides/);
  assert.ok(e.kg > estimateCarbon("bus", { straightMiles: 350 })!.kg);
});

function history(mode: Trip["mode"], n: number, late = 0): Trip[] {
  return Array.from({ length: n }, (_, i) => ({ id: `H-${mode}-${i}`, mode, arrivalMarginMin: i < late ? -10 : 15 }) as Trip);
}

test("R13 recommends the train over cheaper driving when the extra cost and time are small", () => {
  const state = buildSeed().state;
  state.trips = [...history("train", 10), ...history("drive", 10)];
  const fares = [{ mode: "train", amountUsd: 20 }];
  const minutes = { train: { minutes: 50, source: "test" }, drive: { minutes: 30, source: "test" } };

  const noTimes = compareRoutes(state, { miles: 20, fares });
  assert.equal(noTimes.pick?.mode, "drive"); // a travel time we don't know is never assumed short

  const r = compareRoutes(state, { miles: 20, fares, context: { roadMiles: 24, minutes } });
  assert.equal(r.pick?.mode, "train");
  assert.match(r.pickReason ?? "", /^R13: the train costs \$6\.00 more and takes 20 min longer than driving, and emits/);
  assert.equal(r.fastest, "drive");
  assert.equal(r.lowestCarbon, "train");
  assert.ok(r.options.every((o) => o.co2eKg !== undefined));
});

test("R13 keeps the cheaper pick when the train costs too much more, or the traveler has a deadline", () => {
  const state = buildSeed().state;
  state.trips = [...history("train", 10), ...history("drive", 10)];
  const minutes = { train: { minutes: 50, source: "test" }, drive: { minutes: 30, source: "test" } };
  assert.equal(compareRoutes(state, { miles: 20, fares: [{ mode: "train", amountUsd: 30 }], context: { minutes } }).pick?.mode, "drive");
  assert.equal(compareRoutes(state, { miles: 20, fares: [{ mode: "train", amountUsd: 20 }], deadlineCritical: true, context: { minutes } }).pick?.mode, "drive");
});

test("R13 never trades reliability for emissions", () => {
  const state = buildSeed().state;
  state.trips = [...history("train", 10, 4), ...history("drive", 10)];
  const minutes = { train: { minutes: 50, source: "test" }, drive: { minutes: 30, source: "test" } };
  assert.equal(compareRoutes(state, { miles: 20, fares: [{ mode: "train", amountUsd: 20 }], context: { minutes } }).pick?.mode, "drive");
});

test("organizer totals compare the chosen routes with every attendee driving alone", () => {
  const c = organizerCarbon(buildSeed().state);
  assert.ok(c.trips > 0);
  assert.equal(Math.round((c.driveAloneKg - c.chosenKg) * 10) / 10, c.avoidedKg);
  assert.equal(c.byEvent.reduce((a, e) => a + e.trips, 0), c.trips);
  assert.ok(c.sources.some((s) => s.url.includes("epa.gov")));
});
