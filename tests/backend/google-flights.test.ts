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
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([
    {
      timestamp: "2026-10-24T19:00:00Z",
      url: "https://www.google.com/travel/flights/booking?tfs=example",
      pricing: { total_price: "$219", currency: "USD" },
      provider: "F9",
    },
  ]), { status: 200, headers: { "Content-Type": "application/json" } }));

  const quote = await liveGoogleFlightQuote({
    fromAirport: "SFO",
    toAirport: "LAX",
    departDate: "2027-01-16",
    sourceUrl: "https://www.google.com/travel/flights/booking?tfs=example",
  });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 219);
  assert.equal(quote.provider, "F9");
  assert.match(quote.bookingUrl ?? "", /google\.com\/travel\/flights\/booking/);
  assert.equal(quote.via, "Bright Data Google Flights scraper");
});

test("non-Google source URLs are never fetched", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  let requested = "";
  t.mock.method(globalThis, "fetch", async (_input) => {
    requested = String(_input);
    return new Response(JSON.stringify([{ pricing: { price: "$144" } }]), { status: 200 });
  });
  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "LAX", departDate: "2027-01-16", sourceUrl: "https://example.com/private" });
  assert.match(quote.sourceUrl, /^https:\/\/www\.google\.com\/travel\/flights\?/);
  assert.match(requested, /^https:\/\/api\.brightdata\.com\/datasets\/v3\/scrape/);
});

test("opaque booking URLs cannot silently replace the route being checked", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify([{ pricing: { price: "$144" } }]), { status: 200 }));
  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", sourceUrl: "https://www.google.com/travel/flights/booking?tfs=opaque-other-trip" });
  const url = new URL(quote.sourceUrl);
  assert.equal(url.pathname, "/travel/flights");
  assert.match(url.searchParams.get("q") ?? "", /SFO to DEN on 2027-01-16/);
});
