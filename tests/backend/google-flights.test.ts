import assert from "node:assert/strict";
import test from "node:test";
import { googleFlightsUrl, liveGoogleFlightQuote } from "../../backend/src/integrations/googleFlights";

test("Google Flights URL fixes route, date, currency, and locale", () => {
  const url = new URL(googleFlightsUrl("sfo", "lax", "2027-01-16"));
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.pathname, "/travel/flights");
  assert.match(url.searchParams.get("q") ?? "", /SFO to LAX on 2027-01-16/);
  assert.equal(url.searchParams.get("curr"), "USD");
  assert.equal(url.searchParams.get("gl"), "US");
});

test("live fare uses Bright Data structured Google Flights output", async (t) => {
  const before = process.env.BRIGHTDATA_API_TOKEN;
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.after(() => {
    if (before === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
    else process.env.BRIGHTDATA_API_TOKEN = before;
  });
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_ready123" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([
      {
        timestamp: "2026-10-24T19:00:00Z",
        url: "https://www.google.com/travel/flights/booking?tfs=example",
        pricing: { total_price: "$219", currency: "USD" },
        provider: "F9",
      },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const quote = await liveGoogleFlightQuote({
    fromAirport: "SFO",
    toAirport: "LAX",
    departDate: "2027-01-16",
    sourceUrl: "https://www.google.com/travel/flights/booking?tfs=example",
  });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 219);
  assert.equal(quote.provider, "F9");
  assert.equal(quote.snapshotId, "s_ready123");
  assert.equal(quote.collectionState, "ready");
  assert.match(quote.bookingUrl ?? "", /google\.com\/travel\/flights\/booking/);
  assert.equal(quote.via, "Bright Data Google Flights scraper");
});

test("non-Google source URLs are never fetched", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  let triggerBody = "";
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/trigger?")) {
      triggerBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ snapshot_id: "s_private123" }), { status: 200 });
    }
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([{ pricing: { price: "$144" } }]), { status: 200 });
  });
  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "LAX", departDate: "2027-01-16", sourceUrl: "https://example.com/private" });
  assert.match(quote.sourceUrl, /^https:\/\/www\.google\.com\/travel\/flights\?/);
  assert.doesNotMatch(triggerBody, /example\.com/);
  assert.match(triggerBody, /google\.com\/travel\/flights/);
  assert.ok(Array.isArray(JSON.parse(triggerBody)));
});

test("opaque booking URLs cannot silently replace the route being checked", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_opaque123" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([{ pricing: { price: "$144" } }]), { status: 200 });
  });
  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", sourceUrl: "https://www.google.com/travel/flights/booking?tfs=opaque-other-trip" });
  const url = new URL(quote.sourceUrl);
  assert.equal(url.pathname, "/travel/flights");
  assert.match(url.searchParams.get("q") ?? "", /SFO to DEN on 2027-01-16/);
});

test("a pending live collection is resumed with the same snapshot", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  let triggers = 0;
  let ready = false;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) {
      triggers += 1;
      return new Response(JSON.stringify({ snapshot_id: "s_pending123" }), { status: 200 });
    }
    if (url.includes("/progress/")) {
      return new Response(JSON.stringify({ status: ready ? "ready" : "running" }), { status: 200 });
    }
    return new Response(JSON.stringify([{ pricing: { total_price: "$188" }, provider: "Google Flights" }]), { status: 200 });
  });

  const first = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", timeoutMs: 3_000 });
  assert.equal(first.status, "timeout");
  assert.equal(first.snapshotId, "s_pending123");
  assert.equal(first.collectionState, "running");
  ready = true;
  const second = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", snapshotId: first.snapshotId, timeoutMs: 3_000 });
  assert.equal(second.status, "ok");
  assert.equal(second.amountUsd, 188);
  assert.equal(triggers, 1);
});
