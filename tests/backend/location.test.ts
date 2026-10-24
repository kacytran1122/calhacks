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
