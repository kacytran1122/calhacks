import assert from "node:assert/strict";
import test from "node:test";
import { cityToPoint, zipToPoint } from "../../backend/src/integrations/geo";

test("location inputs fail closed before making a network request", async () => {
  const city = await cityToPoint("Galesburg");
  const zip = await zipToPoint("6140");
  assert.equal(city.status, "empty");
  assert.match(city.error ?? "", /city, state/i);
  assert.equal(zip.status, "error");
  assert.match(zip.error ?? "", /5 digits/i);
});
