import assert from "node:assert/strict";
import test from "node:test";
import { planExtensionRoute } from "../../backend/src/extension-route";

const input = { originCoordinates: { lat: 34.0689, lon: -118.4452 }, includeSelfDrive: false, event: { name: "Example campus event", url: "https://events.example.edu/", location: "Campus event hall", lat: 33.6405, lon: -117.8443, startsAt: "2027-01-16T18:00:00Z" } };

test("the extension keeps train and bus alternatives without requesting self-drive or fares", async (t) => {
  const requested: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    requested.push(new URL(String(url)));
    const itineraries = [["LONG_DISTANCE", "Regional train", 3600], ["BUS", "Express bus", 5400]].map(([mode, displayName, duration]) => ({ duration, startTime: "2027-01-16T15:00:00Z", endTime: "2027-01-16T16:30:00Z", transfers: 0, legs: [{ mode, displayName, duration, startTime: "2027-01-16T15:00:00Z", endTime: "2027-01-16T16:30:00Z", from: { name: "Campus stop" }, to: { name: "Event hall stop" }, realTime: false }], fareTransfers: [{ transferProducts: [{ name: "Adult fare", amount: 20, currency: "USD" }] }] }));
    return new Response(JSON.stringify({ itineraries }));
  });
  const plan = await planExtensionRoute(input);
  assert.deepEqual(plan.routes.map((route) => route.mode), ["train", "bus"]);
  assert.equal(plan.fastestRouteId, plan.routes[0]!.id);
  assert.equal(requested.length, 1);
  assert.ok(requested.every((url) => url.hostname === "api.transitous.org" && url.searchParams.get("withFares") === "false"));
  assert.equal(/amountUsd|costCents|fareQuote/.test(JSON.stringify(plan.routes)), false);
});

test("an empty extension search keeps self-drive excluded instead of suggesting a driving fallback", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ itineraries: [] })));
  const plan = await planExtensionRoute(input);
  assert.deepEqual(plan.routes, []);
  assert.match(plan.messages.join(" "), /Self-drive remains excluded/);
  assert.doesNotMatch(plan.messages.join(" "), /enable self-drive/);
});
