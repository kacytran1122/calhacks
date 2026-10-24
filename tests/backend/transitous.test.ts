import assert from "node:assert/strict";
import test from "node:test";
import { transitOptionsFrom, type TransitPlanPayload } from "../../backend/src/integrations/transitous";

const baseTime = "2026-10-24T18:00:00Z";

function payload(legs: TransitPlanPayload["itineraries"] extends (infer T)[] | undefined ? T["legs"] : never, fareTransfers?: TransitPlanPayload["itineraries"] extends (infer T)[] | undefined ? T["fareTransfers"] : never): TransitPlanPayload {
  return {
    itineraries: [{
      duration: 7200,
      startTime: baseTime,
      endTime: "2026-10-24T20:00:00Z",
      transfers: 1,
      legs,
      fareTransfers,
    }],
  };
}

test("Transitous turns GTFS legs into detailed live route instructions", () => {
  const options = transitOptionsFrom(payload([
    { mode: "WALK", from: { name: "UCLA" }, to: { name: "Westwood / Weyburn" }, duration: 600, startTime: baseTime, endTime: "2026-10-24T18:10:00Z", realTime: false },
    { mode: "BUS", from: { name: "Westwood / Weyburn" }, to: { name: "Union Station" }, duration: 3000, startTime: "2026-10-24T18:10:00Z", endTime: "2026-10-24T19:00:00Z", realTime: true, displayName: "761", headsign: "Downtown", agencyName: "Metro - Los Angeles" },
    { mode: "RAIL", from: { name: "Union Station" }, to: { name: "Tustin" }, duration: 3600, startTime: "2026-10-24T19:00:00Z", endTime: "2026-10-24T20:00:00Z", realTime: false, displayName: "Orange County Line", headsign: "Oceanside", agencyName: "Metrolink" },
  ]));

  assert.equal(options.length, 1);
  assert.equal(options[0].mode, "train");
  assert.deepEqual(options[0].agencies, ["Metro - Los Angeles", "Metrolink"]);
  assert.match(options[0].steps[0].instruction, /Walk to Westwood/);
  assert.match(options[0].steps[1].detail ?? "", /live timing/);
  assert.match(options[0].steps[2].instruction, /Orange County Line toward Oceanside/);
});

test("Transitous keeps an intercity coach itinerary in the bus category", () => {
  const options = transitOptionsFrom(payload([
    { mode: "COACH", from: { name: "Los Angeles" }, to: { name: "Irvine" }, duration: 7200, startTime: baseTime, endTime: "2026-10-24T20:00:00Z", realTime: false, displayName: "Greyhound", headsign: "San Diego", agencyName: "Greyhound" },
  ]));

  assert.equal(options[0].mode, "bus");
});

test("Transitous adds auditable USD fare products", () => {
  const options = transitOptionsFrom(payload([
    { mode: "BUS", from: { name: "UCLA" }, to: { name: "Irvine" }, duration: 7200, startTime: baseTime, endTime: "2026-10-24T20:00:00Z", realTime: false, displayName: "Bus", agencyName: "Agency" },
  ], [{ transferProducts: [{ name: "Adult", amount: 2.5, currency: "USD" }, { name: "Transfer", amount: 1.25, currency: "USD" }] }]));

  assert.equal(options[0].amountUsd, 3.75);
  assert.equal(options[0].fareQuote, "Transitous GTFS fare products total $3.75.");
});
