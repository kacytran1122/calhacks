import assert from "node:assert/strict";
import test from "node:test";
import { officialTransitFareUrl, planPublicTransit, transitOptionsFrom, type TransitPlanPayload } from "../../backend/src/integrations/transitous";

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

function service(mode: string, displayName: string, offsetMinutes = 0) {
  const startTime = new Date(new Date(baseTime).getTime() + offsetMinutes * 60_000).toISOString();
  const endTime = new Date(new Date(startTime).getTime() + 7_200_000).toISOString();
  const itinerary = payload([{ mode, displayName, from: { name: "Origin Station" }, to: { name: "Venue Station" }, duration: 7200, startTime, endTime, realTime: false, agencyName: "Public operator" }]).itineraries![0]!;
  return { ...itinerary, startTime, endTime };
}

test("distinct departure and arrival itineraries survive while exact duplicates are removed", () => {
  const fareTransfers = [{ transferProducts: [{ name: "Adult", amount: 10, currency: "USD" }] }];
  const first = { ...service("RAIL", "Regional train"), fareTransfers };
  const laterService = service("RAIL", "Regional train", 30);
  const endTime = new Date(new Date(laterService.startTime).getTime() + 9_000_000).toISOString();
  const later = { ...laterService, duration: 9000, endTime, legs: [{ ...laterService.legs[0]!, duration: 9000, endTime }], fareTransfers };
  const options = transitOptionsFrom({ itineraries: [first, first, later] });
  assert.equal(options.length, 2);
  assert.notEqual(options[0]!.title, options[1]!.title);
  assert.ok(options.every((option) => /departs/.test(option.title) && option.title.length <= 120));
  assert.equal(options[0]!.amountUsd, options[1]!.amountUsd);
  assert.notEqual(options[0]!.durationMinutes, options[1]!.durationMinutes);
  assert.notEqual(options[0]!.departAt, options[1]!.departAt);
  assert.notEqual(options[0]!.arriveAt, options[1]!.arriveAt);
  assert.notEqual(options[0]!.steps[0]!.detail, options[1]!.steps[0]!.detail);
});

test("same-time transit alternatives keep distinct human titles and long-distance rail stays a train", () => {
  const first = service("LONG_DISTANCE", "Amtrak");
  const suburban = service("SUBURBAN", "Commuter rail");
  assert.equal(transitOptionsFrom({ itineraries: [first, suburban] })[0]!.mode, "train");
  assert.equal(transitOptionsFrom({ itineraries: [first, suburban] })[1]!.mode, "train");
  const midpoint = new Date(new Date(first.startTime).getTime() + 3_600_000).toISOString();
  const branch = (stop: string) => ({ ...first, legs: [{ ...first.legs[0]!, duration: 3600, endTime: midpoint, to: { name: stop } }, { ...first.legs[0]!, duration: 3600, startTime: midpoint, from: { name: stop } }] });
  const alternatives = transitOptionsFrom({ itineraries: [branch("East transfer"), branch("West transfer")] });
  assert.equal(alternatives.length, 2);
  assert.notEqual(alternatives[0]!.title, alternatives[1]!.title);
  assert.match(alternatives[1]!.title, /via West transfer/);
});

test("cancelled or self-drive legs invalidate the complete itinerary", () => {
  const valid = service("RAIL", "Regional train");
  const cancelled = { ...valid, legs: [{ ...valid.legs[0]!, cancelled: true }, ...service("BUS", "Local connector").legs] };
  const cancelledStop = { ...valid, legs: [{ ...valid.legs[0]!, from: { name: "Origin Station", cancelled: true } }] };
  const withCar = { ...valid, legs: [...service("CAR", "Car access").legs, ...valid.legs] };
  const withParking = { ...valid, legs: [...service("CAR_PARKING", "Park and ride").legs, ...valid.legs] };
  assert.deepEqual(transitOptionsFrom({ itineraries: [cancelled, cancelledStop, withCar, withParking] }), []);
  assert.equal(transitOptionsFrom({ itineraries: [cancelled, withCar, valid] }).length, 1);
});

test("a single public-transit result triggers one bounded bus and coach alternative search", async (t) => {
  const requests: { url: URL; signal?: AbortSignal | null }[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push({ url: new URL(String(input)), signal: init?.signal });
    return new Response(JSON.stringify({ itineraries: [requests.length === 1 ? service("RAIL", "Regional train") : service("COACH", "Intercity coach", 15)] }), { status: 200 });
  });
  const plan = await planPublicTransit({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 33.64, lon: -117.84 }, startsAt: "2027-01-16T17:00:00Z", includeFares: false });
  assert.equal(plan.status, "ok");
  assert.equal(plan.options.length, 2);
  assert.deepEqual(plan.options.map((option) => option.mode), ["train", "bus"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]!.signal, requests[1]!.signal);
  assert.equal(requests[0]!.url.searchParams.get("transitModes"), "TRANSIT");
  assert.equal(requests[1]!.url.searchParams.get("transitModes"), "BUS,COACH");
  for (const request of requests) {
    assert.equal(request.url.searchParams.get("preTransitModes"), "WALK");
    assert.equal(request.url.searchParams.get("postTransitModes"), "WALK");
    assert.equal(request.url.searchParams.get("directModes"), "");
    assert.equal(request.url.searchParams.get("withFares"), "false");
  }
});

test("multiple real route patterns avoid an extra mode search even when fares are missing", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    return new Response(JSON.stringify({ itineraries: [service("RAIL", "Regional train"), service("RAIL", "Express train", 30)] }), { status: 200 });
  });
  const plan = await planPublicTransit({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 33.64, lon: -117.84 } });
  assert.equal(plan.status, "ok");
  assert.equal(plan.options.length, 2);
  assert.ok(plan.options.every((option) => option.amountUsd === undefined));
  assert.equal(requests, 1);
});

test("repeated train departures still seek a bus alternative and preserve it within the result limit", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    requests += 1;
    const modes = new URL(String(input)).searchParams.get("transitModes");
    const bus = service("COACH", "Intercity coach", 15);
    const endTime = new Date(new Date(bus.startTime).getTime() + 9_000_000).toISOString();
    return new Response(JSON.stringify({ itineraries: modes === "BUS,COACH" ? [{ ...bus, duration: 9000, endTime, legs: [{ ...bus.legs[0]!, duration: 9000, endTime }] }] : [0, 30, 60, 90, 120].map((offset) => service("RAIL", "Regional train", offset)) }), { status: 200 });
  });
  const plan = await planPublicTransit({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 33.64, lon: -117.84 } });
  assert.equal(requests, 2);
  assert.equal(plan.options.length, 4);
  assert.equal(plan.options.filter((option) => option.mode === "train").length, 3);
  assert.equal(plan.options.filter((option) => option.mode === "bus").length, 1);
  assert.equal(new Set(plan.options.map((option) => option.title)).size, 4);
});

test("alternative lookup shares the original deadline and retains a valid first route on timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: new Date("2026-10-25T12:00:00Z") });
  let requests = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_input, init) => {
    requests += 1;
    signals.push(init?.signal);
    if (requests === 1) {
      t.mock.timers.tick(8_000);
      return new Response(JSON.stringify({ itineraries: [service("RAIL", "Regional train")] }), { status: 200 });
    }
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true }));
  });
  const pending = planPublicTransit({ from: { lat: 34.07, lon: -118.44 }, to: { lat: 33.64, lon: -117.84 } });
  for (let i = 0; i < 20 && requests < 2; i += 1) await Promise.resolve();
  assert.equal(requests, 2);
  t.mock.timers.tick(1_000);
  const plan = await pending;
  assert.equal(plan.status, "ok");
  assert.equal(plan.options.length, 1);
  assert.equal(plan.options[0]!.mode, "train");
  assert.equal(plan.ms, 9_000);
  assert.equal(signals[0], signals[1]);
  assert.match(plan.error ?? "", /shared 9-second limit/);
});

test("a multi-transfer alternative retains the final walk to the event", () => {
  const legs = Array.from({ length: 13 }, (_, index) => ({ mode: index % 2 ? "BUS" : "WALK", from: { name: index === 0 ? "Origin" : `Stop ${index}` }, to: { name: index === 12 ? "Event entrance" : `Stop ${index + 1}` }, duration: 60, startTime: new Date(new Date(baseTime).getTime() + index * 60_000).toISOString(), endTime: new Date(new Date(baseTime).getTime() + (index + 1) * 60_000).toISOString(), realTime: false, displayName: index % 2 ? `Local ${index}` : undefined }));
  const option = transitOptionsFrom(payload(legs))[0]!;
  assert.equal(option.steps.length, 13);
  assert.match(option.steps.at(-1)!.instruction, /Walk from Stop 12 to Event entrance/);
});
