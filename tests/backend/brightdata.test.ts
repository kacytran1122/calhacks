import assert from "node:assert/strict";
import test from "node:test";
import { selectActiveZone } from "../../backend/src/integrations/brightdata";

const zones = [
  { name: "smile_browser", type: "browser_api" },
  { name: "smile_public_web", type: "unblocker" },
  { name: "smile_search", type: "serp" },
];

test("Bright Data selects the API that matches each request", () => {
  assert.equal(selectActiveZone(zones, "unblocker"), "smile_public_web");
  assert.equal(selectActiveZone(zones, "serp"), "smile_search");
});

test("Bright Data does not send SERP traffic through a browser zone", () => {
  assert.equal(selectActiveZone(zones.slice(0, 1), "serp"), undefined);
});
