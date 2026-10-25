import assert from "node:assert/strict";
import test from "node:test";
import { estimatePrices } from "../../backend/src/agents/pricing";
import { predictTrees } from "../../backend/src/ml/gbdt";
import { AIRFARE, FLIGHT_TIME, HISTORY, PERIODS, RIDESHARE, airportsNear, estimateAirfare, estimateRideshare, flightFactor, pastFarePerMile, periodOf, predictRange, type PriceModelFile } from "../../backend/src/ml/price";

for (const model of [RIDESHARE, AIRFARE, FLIGHT_TIME] as PriceModelFile[]) {
  test(`${model.name}: TypeScript trees reproduce the notebook's XGBoost predictions`, () => {
    for (const key of ["p10", "p50", "p90"] as const) {
      model.golden.X.forEach((row, i) => {
        const got = predictTrees(model.quantiles[key], row);
        assert.ok(Math.abs(got - model.golden[key][i]!) < 0.01, `${key} row ${i}: ${got} vs ${model.golden[key][i]}`);
      });
    }
  });

  test(`${model.name}: model card says it beat its baseline on held-out data`, () => {
    assert.ok(model.metrics.mae_p50! < model.metrics.mae_baseline!);
    assert.ok(model.metrics.coverage_p10_p90! > 0.6 && model.metrics.coverage_p10_p90! < 0.95);
    assert.ok(model.parity_max_abs_diff < 0.01);
  });
}

test("ranges stay ordered and non-negative", () => {
  for (const row of RIDESHARE.golden.X) {
    const r = predictRange(RIDESHARE, row);
    assert.ok(r.p10 >= 0 && r.p10 <= r.p50 && r.p50 <= r.p90);
  }
});

test("price outlook runs only for domestic trips between different states", async () => {
  const sameState = await estimatePrices({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 33.68, lon: -117.82 }, startsAt: "2026-11-14T17:00:00Z", fromState: "CA", toState: "CA" });
  assert.equal(sameState.scope.eligible, false);
  assert.equal(sameState.rideshare, null);
  assert.equal(sameState.airfare, null);
  assert.match(sameState.scope.reason, /stays within CA/);

  const unknownState = await estimatePrices({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 30.27, lon: -97.74 }, startsAt: "2026-11-14T17:00:00Z" });
  assert.equal(unknownState.scope.eligible, false);
  assert.match(unknownState.scope.reason, /could not be verified/);
});

test("a longer rideshare costs more than a short one", () => {
  const at = "2026-11-14T17:00:00Z";
  const short = estimateRideshare({ miles: 3, minutes: 12, arriveBy: at });
  const long = estimateRideshare({ miles: 25, minutes: 45, arriveBy: at });
  assert.ok(long.uber.p50 > short.uber.p50 * 2);
  assert.ok(long.lyft.p50 > short.lyft.p50 * 2);
  assert.match(long.caveat, /New York City/);
});

test("flights: none for short hops, a real airport pair for long trips", () => {
  const davis = { lat: 38.5449, lon: -121.7405 };
  const sf = { lat: 37.8063, lon: -122.4306 };
  const austin = { lat: 30.2672, lon: -97.7431 };
  assert.equal(estimateAirfare({ from: davis, to: sf, when: "2026-11-14T17:00:00Z" }), null);
  const trip = estimateAirfare({ from: davis, to: austin, when: "2026-11-14T17:00:00Z" });
  assert.ok(trip, "expected an airfare estimate Davis -> Austin");
  assert.ok(trip.miles > 1000 && trip.range.p50 > 50 && trip.range.p50 < 1000);
  assert.ok(airportsNear(davis).some((a) => a.code === trip.from.code));
  assert.equal(trip.to.code, "AUS"); // nearest real airport wins once ground travel is counted
  assert.ok(trip.groundMiles < 60);
});

test("flights: regional commercial airports keep smaller cities connected", () => {
  const galesburg = { lat: 40.9478, lon: -90.3712 };
  const durham = { lat: 35.994, lon: -78.899 };
  assert.ok(airportsNear(galesburg).some((airport) => airport.code === "PIA"));
  const trip = estimateAirfare({ from: galesburg, to: durham, when: "2026-10-30T17:00:00Z" });
  assert.ok(trip, "expected an airfare estimate Galesburg -> Durham");
  assert.ok(["RDU", "GSO", "FAY"].includes(trip.to.code));
});

test("every hour of the day belongs to exactly one named period", () => {
  assert.equal(PERIODS.length, 7);
  for (let h = 0; h < 24; h++) assert.ok(periodOf(h).index >= 0, `hour ${h}`);
  assert.equal(periodOf(8).name, "morning rush");
  assert.equal(periodOf(17).name, "evening rush");
});

test("rideshare: the same trip is priced differently at different times of day", () => {
  const est = estimateRideshare({ miles: 8, minutes: 25, arriveBy: "2026-11-11T17:00:00Z" }); // Wednesday, 9:00 am Pacific
  assert.equal(est.byHour.length, 24);
  const p50s = est.byHour.map((h) => h.uber.p50);
  assert.ok(Math.max(...p50s) - Math.min(...p50s) > 1, "time of day should move the price by more than $1");
  assert.equal(est.departHour, 8);
  assert.equal(est.period, "morning rush");
  assert.ok(est.cheapestOnTime && est.cheapestOnTime.hour <= est.departHour, "the cheapest suggestion must still arrive on time");
  assert.ok(est.cheapestOnTime.hour >= est.departHour - 3, "and not ask anyone to leave hours early");
});

test("the model card shows time of day lowers error", () => {
  assert.ok(RIDESHARE.metrics.mae_p50! < RIDESHARE.metrics.mae_without_time_features!);
  assert.ok(RIDESHARE.by_period && Object.keys(RIDESHARE.by_period).length === 7);
  assert.ok(FLIGHT_TIME.metrics.mae_fare_nzd! < FLIGHT_TIME.metrics.mae_fare_nzd_no_time!);
});

test("flights: price by departure hour around the route-level fare", () => {
  const trip = estimateAirfare({ from: { lat: 38.5449, lon: -121.7405 }, to: { lat: 30.2672, lon: -97.7431 }, when: "2026-11-14T17:00:00Z" })!;
  assert.equal(trip.byHour.length, 18); // 5 am .. 10 pm departures
  const factors = trip.byHour.map((h) => h.factor);
  assert.ok(Math.max(...factors) > Math.min(...factors), "departure hour should change the factor");
  assert.ok(factors.every((f) => f > 0.3 && f < 3));
  const avg = factors.reduce((a, b) => a + b, 0) / factors.length;
  assert.ok(Math.abs(avg - 1) < 0.01, "factors describe the shape of the day around the route fare");
  assert.ok(trip.cheapestHour && trip.byHour.every((h) => h.range.p50 >= trip.cheapestHour!.range.p50));
  assert.equal(flightFactor(9, 2), flightFactor(9, 2));
});

test("past pattern: real hourly history sits next to the prediction", () => {
  const est = estimateRideshare({ miles: 8, minutes: 25, arriveBy: "2026-11-11T17:00:00Z" });
  assert.equal(est.pastByHour.length, 24);
  const known = est.pastByHour.filter((v): v is number => typeof v === "number");
  assert.equal(known.length, 24, "every hour has at least 30 past trips for an 8-mile weekday ride");
  est.byHour.forEach((h, i) => {
    const past = est.pastByHour[i]!;
    assert.ok(past > h.uber.p50 * 0.5 && past < h.uber.p50 * 2, `hour ${i}: past ${past} vs predicted ${h.uber.p50}`);
  });
  // Weekday rush hour cost more per mile than the middle of the night in the past data.
  const fpm = pastFarePerMile(8, false);
  assert.ok(fpm[17]! > fpm[3]!);
});

test("past pattern for flights follows departure hours and leaves gaps instead of guessing", () => {
  const trip = estimateAirfare({ from: { lat: 38.5449, lon: -121.7405 }, to: { lat: 30.2672, lon: -97.7431 }, when: "2026-11-11T17:00:00Z" })!;
  const past = trip.byHour.map((h) => h.past);
  assert.ok(past.filter((v) => v !== null).length >= 15);
  assert.equal(HISTORY.flights.hours.length, HISTORY.flights.factor.weekday.length);
});
