import assert from "node:assert/strict";
import test from "node:test";
import { cityToPoint, placeToPoint, zipToPoint } from "../../backend/src/integrations/geo";

test("location inputs fail closed before making a network request", async () => {
  const city = await cityToPoint("x");
  const zip = await zipToPoint("6140");
  assert.equal(city.status, "empty");
  assert.match(city.error ?? "", /too short/i);
  assert.equal(zip.status, "error");
  assert.match(zip.error ?? "", /5 digits/i);
});

test("place lookup keeps an exact landmark coordinate", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify([{ lat: "34.0708777", lon: "-118.4468503", display_name: "University of California, Los Angeles", address: { postcode: "90077", country_code: "us" } }]));
  const result = await placeToPoint("UCLA");
  assert.equal(result.status, "ok");
  assert.equal(result.lat, 34.0708777);
  assert.equal(result.lon, -118.4468503);
});

test("place lookup falls back to ArcGIS when OpenStreetMap is unavailable", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => String(input).includes("nominatim")
    ? new Response("rate limited", { status: 429 })
    : new Response(JSON.stringify({ candidates: [{ address: "UCLA", score: 100, location: { x: -118.4511766, y: 34.0711778 }, attributes: { Postal: "90024", CountryCode: "USA" } }] }));
  const result = await placeToPoint("UCLA Westwood campus");
  assert.equal(result.status, "ok");
  assert.equal(result.source, "ArcGIS World Geocoding service");
  assert.equal(result.postalCode, "90024");
  assert.equal(result.lat, 34.0711778);
  assert.equal(result.lon, -118.4511766);
});

test("city resolver preserves a landmark coordinate through the fallback", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => String(input).includes("nominatim")
    ? new Response("rate limited", { status: 429 })
    : new Response(JSON.stringify({ candidates: [{ address: "UCI", score: 100, location: { x: -117.8443, y: 33.6405 }, attributes: { Postal: "92697", CountryCode: "USA" } }] }));
  const result = await cityToPoint("UCI Irvine campus");
  assert.equal(result.status, "ok");
  assert.equal(result.postalCode, "92697");
  assert.equal(result.lat, 33.6405);
  assert.equal(result.lon, -117.8443);
});
