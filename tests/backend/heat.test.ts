import assert from "node:assert/strict";
import test from "node:test";
import { ANOMALY_THRESHOLD_F, confidenceFor, gridAround, scoreCells, severityFor } from "../../backend/src/agents/heat";

test("severity follows the NWS heat-index bands", () => {
  assert.equal(severityFor(65).band, "Comfortable");
  assert.equal(severityFor(85).band, "Caution");
  assert.equal(severityFor(95).band, "Extreme caution");
  assert.equal(severityFor(110).band, "Danger");
  assert.equal(severityFor(130).score, 1);
  assert.ok(severityFor(95).score > severityFor(85).score);
});

test("confidence drops with lead time and model disagreement", () => {
  assert.ok(confidenceFor(1, 0, "forecast") > confidenceFor(10, 0, "forecast"));
  assert.ok(confidenceFor(1, 0, "forecast") > confidenceFor(1, 8, "forecast"));
  assert.ok(confidenceFor(30, null, "climatology") < confidenceFor(10, 0, "forecast"));
});

test("UrbanLens gate: only cells hotter than the area become ranked hotspots", () => {
  const base = { lat: 0, lon: 0, airTempF: 80, modelSpreadF: 1 };
  const { cells, regionMedianF } = scoreCells(
    [
      { ...base, feelsLikeF: 84 },
      { ...base, feelsLikeF: 84.2 },
      { ...base, feelsLikeF: 84.4 },
      { ...base, feelsLikeF: 88 }, // 3.6°F above the median: a hotspot
    ],
    1,
    "forecast",
  );
  assert.equal(regionMedianF, 84.3);
  const ranked = cells.filter((c) => c.rank > 0);
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0]!.anomalyF >= ANOMALY_THRESHOLD_F);
  assert.equal(ranked[0]!.rank, Math.round(ranked[0]!.severity * ranked[0]!.confidence * 1000) / 1000);
});

test("grid covers the requested radius around the venue", () => {
  const pts = gridAround({ lat: 37.8, lon: -122.43 }, 3, 7);
  assert.equal(pts.length, 49);
  const lats = pts.map((p) => p.lat);
  assert.ok(Math.abs(Math.max(...lats) - Math.min(...lats) - 6 / 69) < 0.001);
});
