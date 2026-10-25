import assert from "node:assert/strict";
import test from "node:test";
import { googleFlightsUrl, liveGoogleFlightQuote, quoteContainsUsdAmount } from "../../backend/src/integrations/googleFlights";
import { checkFlightPrice } from "../../backend/src/agents/pricing";
import { AIRFARE, estimateAirfare } from "../../backend/src/ml/price";

test("Google Flights URL fixes route, date, currency, and locale", () => {
  const url = new URL(googleFlightsUrl("sfo", "lax", "2027-01-16"));
  assert.equal(url.hostname, "www.google.com");
  assert.equal(url.pathname, "/travel/flights/search");
  const encoded = url.searchParams.get("tfs") ?? "";
  const decoded = Buffer.from(encoded, "base64url");
  assert.ok(decoded.includes(Buffer.from("SFO")));
  assert.ok(decoded.includes(Buffer.from("LAX")));
  assert.ok(decoded.includes(Buffer.from("2027-01-16")));
  assert.equal(url.searchParams.get("tfu"), "EgYIABABGAA");
  assert.equal(url.searchParams.get("curr"), "USD");
  assert.equal(url.searchParams.get("gl"), "US");
});

test("live fare accepts nested USD price values from the scraper", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_nested123" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([
      {
        pricing: { price: { value: 219, currency: "USD" } },
        provider: "Google Flights",
      },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16" });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 219);
});

test("live fare rejects nested values in another currency", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_currency123" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([
      { pricing: { price: { value: 219, currency: "EUR" } } },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16" });
  assert.equal(quote.status, "empty");
  assert.equal(quote.amountUsd, undefined);
});

test("a completed collection without a fare inspects the same live Google Flights page", async (t) => {
  const token = process.env.BRIGHTDATA_API_TOKEN;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  const anthropic = process.env.ANTHROPIC_API_KEY;
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "test-unlocker";
  delete process.env.ANTHROPIC_API_KEY;
  t.after(() => {
    if (token === undefined) delete process.env.BRIGHTDATA_API_TOKEN;
    else process.env.BRIGHTDATA_API_TOKEN = token;
    if (zone === undefined) delete process.env.BRIGHTDATA_UNLOCKER_ZONE;
    else process.env.BRIGHTDATA_UNLOCKER_ZONE = zone;
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropic;
  });
  let unlockedUrl = "";
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    if (url.includes("/snapshot/")) return new Response(JSON.stringify([{ route: "SFO-DEN", currency: "USD" }]), { status: 200 });
    if (url.endsWith("/request")) {
      const body = JSON.parse(String(init?.body)) as { url?: string };
      unlockedUrl = body.url ?? "";
      return new Response("Google Flights SFO to DEN on January 16, 2027. Current lowest fare $109. ".repeat(4), { status: 200 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", snapshotId: "s_empty123", timeoutMs: 3_000 });
  assert.equal(quote.status, "empty");
  assert.equal(quote.snapshotId, "s_empty123");
  assert.equal(quote.collectionState, "ready");
  assert.equal(unlockedUrl, quote.sourceUrl);
  assert.match(quote.via, /Web Unlocker fallback/);
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
  assert.match(quote.sourceUrl, /^https:\/\/www\.google\.com\/travel\/flights\/search\?/);
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
  assert.equal(url.pathname, "/travel/flights/search");
  const decoded = Buffer.from(url.searchParams.get("tfs") ?? "", "base64url");
  assert.ok(decoded.includes(Buffer.from("SFO")));
  assert.ok(decoded.includes(Buffer.from("DEN")));
  assert.ok(decoded.includes(Buffer.from("2027-01-16")));
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

test("resuming a running collection checks once instead of holding the request open", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  let progressChecks = 0;
  t.mock.method(globalThis, "fetch", async () => {
    progressChecks += 1;
    return new Response(JSON.stringify({ status: "running" }), { status: 200 });
  });
  const started = Date.now();
  const quote = await liveGoogleFlightQuote({ fromAirport: "SFO", toAirport: "DEN", departDate: "2027-01-16", snapshotId: "s_running123", timeoutMs: 3_000 });
  assert.equal(quote.status, "timeout");
  assert.equal(quote.snapshotId, "s_running123");
  assert.equal(progressChecks, 1);
  assert.ok(Date.now() - started < 500);
});

test("airport and calendar validation prevents invalid searches before a collector request", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; throw new Error("Unexpected collection"); });
  for (const [fromAirport, toAirport, departDate] of [["SFO", "SFO", "2027-01-16"], ["SFO", "LAX", "2027-02-30"], ["SFO", "LAX", "2027-02-29"], ["SFO", "LAX", "2027-13-01"], ["SFO", "LAX", "January 16"]]) {
    assert.throws(() => googleFlightsUrl(fromAirport!, toAirport!, departDate!));
    const quote = await liveGoogleFlightQuote({ fromAirport: fromAirport!, toAirport: toAirport!, departDate: departDate! });
    assert.equal(quote.status, "error");
    assert.equal(quote.via, "validation");
  }
  assert.doesNotThrow(() => googleFlightsUrl("ORD", "SEA", "2028-02-29"));
  assert.equal(requests, 0);
});

test("grounded fare evidence requires the complete USD amount", () => {
  assert.equal(quoteContainsUsdAmount("Current fare $109", 109), true);
  assert.equal(quoteContainsUsdAmount("Current fare $109.", 109), true);
  assert.equal(quoteContainsUsdAmount("Current fare USD 1,099.20", 1099.2), true);
  assert.equal(quoteContainsUsdAmount("Current fare US$ 109.20", 109.2), true);
  assert.equal(quoteContainsUsdAmount("Current fare $1090", 109), false);
  assert.equal(quoteContainsUsdAmount("Current fare $109.20", 109), false);
  assert.equal(quoteContainsUsdAmount("Current fare $109.201", 109.2), false);
  assert.equal(quoteContainsUsdAmount("Current fare C$109", 109), false);
});

test("flight collection and matching model comparison work across varied airport pairs and travel seasons", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  const cases = [
    { fromAirport: "ORD", toAirport: "SEA", fromState: "IL", toState: "WA", departDate: "2027-01-16", fare: 157 },
    { fromAirport: "JFK", toAirport: "MIA", fromState: "NY", toState: "FL", departDate: "2027-05-12", fare: 213.4 },
    { fromAirport: "ATL", toAirport: "DFW", fromState: "GA", toState: "TX", departDate: "2027-09-06", fare: 89 },
  ];
  let active = cases[0]!;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/trigger?")) {
      const body = JSON.parse(String(init?.body)) as { url: string }[];
      const decoded = Buffer.from(new URL(body[0]!.url).searchParams.get("tfs")!, "base64url");
      for (const expected of [active.fromAirport, active.toAirport, active.departDate]) assert.ok(decoded.includes(Buffer.from(expected)));
      return new Response(JSON.stringify({ snapshot_id: `s_multi${active.fromAirport}${active.toAirport}` }), { status: 200 });
    }
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([{ url: googleFlightsUrl(active.fromAirport, active.toAirport, active.departDate), totalPrice: active.fare, currencyCode: "USD" }]), { status: 200 });
  });
  for (const example of cases) {
    active = example;
    const from = AIRFARE.airports.find((a) => a.code === example.fromAirport)!;
    const to = AIRFARE.airports.find((a) => a.code === example.toAirport)!;
    const check = await checkFlightPrice({ ...example, from, to, startsAt: "2027-10-01T17:00:00Z" });
    assert.equal(check?.live.status, "ok");
    assert.equal(check?.live.amountUsd, example.fare);
    assert.equal(check?.live.departDate, example.departDate);
    assert.equal(check?.prediction.from.code, example.fromAirport);
    assert.equal(check?.prediction.to.code, example.toAirport);
    const expected = estimateAirfare({ from, to, fromAirport: example.fromAirport, toAirport: example.toAirport, when: `${example.departDate}T12:00:00Z` });
    assert.deepEqual(check?.prediction.range, expected?.range);
  }
});

test("non-ticket charges and nested non-USD currencies never become the live fare", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_chargeguards" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([{
      baggage: { total_price: "$25" },
      checkedBagFee: { price: "$30" },
      typical_price: "$75",
      pricing: { currency: "EUR", price: { value: 80 } },
      itinerary: { totalPrice: "$219.50", currencyCode: "USD" },
    }]), { status: 200 });
  });
  const quote = await liveGoogleFlightQuote({ fromAirport: "JFK", toAirport: "MIA", departDate: "2027-05-12" });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 219.5);
});

test("the lowest complete offer wins across provider formats while base fares and extras are excluded", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_lowestoffer" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([
      { provider: "Higher-priced airline", pricing: { total_price: "$319", base_fare: "$59", price: "$79" } },
      { provider: "Lowest-priced airline", price: "$109", extras: { price: "$9" }, seatSelection: { price: "$12" }, providerData: { statistics: { total: { value: 5 } } } },
    ]), { status: 200 });
  });
  const quote = await liveGoogleFlightQuote({ fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16" });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 109);
  assert.equal(quote.provider, "Lowest-priced airline");
});

test("a resumed snapshot requires matching airport and date metadata", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "test-unlocker";
  let records: unknown = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    if (url.includes("/snapshot/")) return new Response(JSON.stringify(records), { status: 200 });
    return new Response("", { status: 403 });
  });
  for (const [id, record] of [
    ["s_wrongairports", { url: googleFlightsUrl("ORD", "SEA", "2027-05-12"), price: "$1" }],
    ["s_wrongdate", { from_airport: "JFK", to_airport: "MIA", departure_date: "2027-05-13", price: "$1" }],
    ["s_nocontext", { price: "$1" }],
    ["s_conflicting", { url: googleFlightsUrl("ORD", "SEA", "2027-05-12"), from_airport: "JFK", to_airport: "MIA", departure_date: "2027-05-12", price: "$1" }],
  ] as const) {
    records = [record];
    const quote = await liveGoogleFlightQuote({ fromAirport: "JFK", toAirport: "MIA", departDate: "2027-05-12", snapshotId: id });
    assert.notEqual(quote.status, "ok");
    assert.equal(quote.amountUsd, undefined);
  }
  records = [{ url: googleFlightsUrl("JFK", "MIA", "2027-05-12"), pricing: { total_price: "$198.90" } }];
  const quote = await liveGoogleFlightQuote({ fromAirport: "JFK", toAirport: "MIA", departDate: "2027-05-12", snapshotId: "s_matchedcontext" });
  assert.equal(quote.status, "ok");
  assert.equal(quote.amountUsd, 198.9);
});

test("a known snapshot cannot be reused for another flight query", async (t) => {
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    requests += 1;
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_boundroute" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: "ready" }), { status: 200 });
    return new Response(JSON.stringify([{ price: "$129" }]), { status: 200 });
  });
  assert.equal((await liveGoogleFlightQuote({ fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16" })).status, "ok");
  const before = requests;
  const wrong = await liveGoogleFlightQuote({ fromAirport: "JFK", toAirport: "MIA", departDate: "2027-05-12", snapshotId: "s_boundroute" });
  assert.equal(wrong.status, "error");
  assert.equal(wrong.via, "validation");
  assert.equal(requests, before);
});

test("price checking retains the domestic interstate policy", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Out-of-scope collection"); });
  const from = { lat: 37.6, lon: -122.3 };
  const to = { lat: 33.9, lon: -118.4 };
  assert.equal(await checkFlightPrice({ from, to, startsAt: "2027-01-17T17:00:00Z", fromState: "CA", toState: "CA" }), null);
  assert.equal(await checkFlightPrice({ from, to, startsAt: "2027-01-17T17:00:00Z" }), null);
});

test("pending collections try the live page early once and throttle repeated polls after failure", async (t) => {
  const anthropic = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "test-unlocker";
  t.after(() => {
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropic;
  });
  let pageAttempts = 0;
  let unlockedUrl = "";
  let unboundReady = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_earlythrottle" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: unboundReady && url.includes("s_unknownpending") ? "ready" : "running" }), { status: 200 });
    if (url.includes("/snapshot/s_unknownpending")) return new Response(JSON.stringify([{ price: "$1" }, { url: googleFlightsUrl("JFK", "MIA", "2027-05-12"), price: "$2" }]), { status: 200 });
    if (url.endsWith("/request")) {
      pageAttempts += 1;
      unlockedUrl = (JSON.parse(String(init?.body)) as { url: string }).url;
      return new Response("", { status: 403 });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });
  const args = { fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16" };
  const first = await liveGoogleFlightQuote({ ...args, timeoutMs: 3_000 });
  assert.equal(first.status, "timeout");
  assert.equal(pageAttempts, 0);
  const resume = { ...args, snapshotId: first.snapshotId, timeoutMs: 30_000 };
  const attempted = await liveGoogleFlightQuote(resume);
  assert.equal(pageAttempts, 1);
  assert.equal(attempted.status, "timeout");
  assert.equal(attempted.collectionState, "running");
  assert.equal(attempted.snapshotId, first.snapshotId);
  assert.equal(attempted.amountUsd, undefined);
  const started = Date.now();
  const throttled = await liveGoogleFlightQuote(resume);
  assert.equal(throttled.status, "timeout");
  assert.equal(pageAttempts, 1);
  assert.ok(Date.now() - started < 500);
  const unbound = await liveGoogleFlightQuote({ ...resume, snapshotId: "s_unknownpending" });
  assert.equal(unbound.status, "timeout");
  assert.equal(pageAttempts, 2);
  assert.equal(unlockedUrl, googleFlightsUrl(args.fromAirport, args.toAirport, args.departDate));
  assert.equal((await liveGoogleFlightQuote({ ...resume, snapshotId: "s_unknownpending" })).status, "timeout");
  assert.equal(pageAttempts, 2);
  unboundReady = true;
  const unrelated = await liveGoogleFlightQuote({ ...resume, snapshotId: "s_unknownpending" });
  assert.notEqual(unrelated.status, "ok");
  assert.equal(unrelated.amountUsd, undefined);
  assert.match(unrelated.note ?? "", /without a verifiable USD fare/);
  assert.equal(pageAttempts, 3);
  const later = Date.now() + 300_001;
  t.mock.method(Date, "now", () => later);
  assert.equal((await liveGoogleFlightQuote(resume)).status, "timeout");
  assert.equal(pageAttempts, 4);
});

test("page extraction verifies the route, date, and complete quoted price before publishing a fare", async (t) => {
  const anthropic = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  process.env.BRIGHTDATA_API_TOKEN = "test-token";
  process.env.BRIGHTDATA_UNLOCKER_ZONE = "test-unlocker";
  t.after(() => {
    if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = anthropic;
  });
  let extracted = { amountUsd: 109, exactQuote: "$1090", fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16", provider: "Example airline", scope: "One adult one-way economy" };
  let state = "ready";
  let pageAttempts = 0;
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("/trigger?")) return new Response(JSON.stringify({ snapshot_id: "s_earlyverified" }), { status: 200 });
    if (url.includes("/progress/")) return new Response(JSON.stringify({ status: state }), { status: 200 });
    if (url.includes("/snapshot/")) return new Response("[]", { status: 200 });
    if (url.endsWith("/request")) {
      pageAttempts += 1;
      return new Response("Google Flights. ORD to SEA, January 16, 2027. One adult, economy, one-way. Lowest current bookable ticket $1090. Other flights $1990. ".repeat(3), { status: 200 });
    }
    if (url.includes("api.anthropic.com")) return new Response(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: JSON.stringify(extracted) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 100 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error(`Unexpected fetch ${url}`);
  });
  const args = { fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16", snapshotId: "s_groundedprice" };
  assert.equal((await liveGoogleFlightQuote(args)).amountUsd, undefined);
  extracted = { ...extracted, amountUsd: 1090, fromAirport: "JFK" };
  assert.equal((await liveGoogleFlightQuote(args)).amountUsd, undefined);
  extracted = { ...extracted, fromAirport: "ORD", departDate: "2027-01-17" };
  assert.equal((await liveGoogleFlightQuote(args)).amountUsd, undefined);
  extracted = { ...extracted, departDate: "2027-01-16" };
  const accepted = await liveGoogleFlightQuote(args);
  assert.equal(accepted.status, "ok");
  assert.equal(accepted.amountUsd, 1090);
  assert.match(accepted.via, /grounded extraction/);
  state = "running";
  const before = pageAttempts;
  const initial = await liveGoogleFlightQuote({ fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16", timeoutMs: 3_000 });
  assert.equal(initial.status, "timeout");
  assert.equal(pageAttempts, before);
  const early = await liveGoogleFlightQuote({ fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16", snapshotId: initial.snapshotId, timeoutMs: 30_000 });
  assert.equal(early.status, "ok");
  assert.equal(early.amountUsd, 1090);
  assert.equal(early.collectionState, "ready");
  assert.equal(early.snapshotId, initial.snapshotId);
  assert.equal(pageAttempts, before + 1);
  assert.equal(state, "running");
  const afterRestart = await liveGoogleFlightQuote({ fromAirport: "ORD", toAirport: "SEA", departDate: "2027-01-16", snapshotId: "s_afterrestartverified", timeoutMs: 30_000 });
  assert.equal(afterRestart.status, "ok");
  assert.equal(afterRestart.amountUsd, 1090);
  assert.equal(afterRestart.collectionState, "ready");
  assert.equal(pageAttempts, before + 2);
});
