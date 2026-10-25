import assert from "node:assert/strict";
import test from "node:test";
import { officialTransitFareUrl, transitOptionsFrom, type TransitPlanPayload } from "../../backend/src/integrations/transitous";

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
  assert.equal(options[0].durationMinutes, 120);
  assert.deepEqual(options[0].agencies, ["Metro - Los Angeles", "Metrolink"]);
  assert.equal(options[0].fareUrl, "https://www.metro.net/riding/fares/");
  assert.match(options[0].steps[0].instruction, /Walk from UCLA to Westwood/);
  assert.match(options[0].steps[0].instruction, /look for 761 toward Downtown/);
  assert.match(options[0].steps[1].detail ?? "", /live timing/);
  assert.match(options[0].steps[2].instruction, /follow station signs for Orange County Line/);
  assert.match(options[0].steps[2].instruction, /direction of Oceanside/);
});

test("Transitous links supported agencies to their official fare pages", () => {
  assert.equal(officialTransitFareUrl(["Bay Area Rapid Transit"]), "https://www.bart.gov/tickets/calculator");
  assert.equal(officialTransitFareUrl(["Metrolink"]), "https://metrolinktrains.com/ticketsOverview/");
  assert.equal(officialTransitFareUrl(["Unknown Local Operator"]), undefined);
});

test("Transitous keeps long multimodal itineraries instead of shortening the instructions", () => {
  const legs = Array.from({ length: 15 }, (_, index) => ({
    mode: index % 3 === 0 ? "WALK" : index % 3 === 1 ? "BUS" : "RAIL",
    from: { name: `Stop ${index}` },
    to: { name: `Stop ${index + 1}` },
    duration: 300,
    startTime: new Date(Date.parse(baseTime) + index * 300_000).toISOString(),
    endTime: new Date(Date.parse(baseTime) + (index + 1) * 300_000).toISOString(),
    realTime: false,
    displayName: index % 3 === 1 ? `Bus ${index}` : index % 3 === 2 ? `Rail ${index}` : undefined,
    agencyName: index % 3 === 0 ? undefined : "Metrolink",
  }));

  const options = transitOptionsFrom(payload(legs));

  assert.equal(options[0].steps.length, 15);
  assert.match(options[0].steps[14].instruction, /Stop 14/);
  assert.equal(options[0].fareUrl, "https://metrolinktrains.com/ticketsOverview/");
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
