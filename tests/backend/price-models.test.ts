import assert from "node:assert/strict";
import test from "node:test";
import { predictTrees } from "../../backend/src/ml/gbdt";
import { AIRFARE, RIDESHARE, airportsNear, estimateAirfare, estimateRideshare, predictRange, type PriceModelFile } from "../../backend/src/ml/price";

for (const model of [RIDESHARE, AIRFARE] as PriceModelFile[]) {
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
