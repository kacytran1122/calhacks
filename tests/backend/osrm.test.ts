import assert from "node:assert/strict";
import test from "node:test";
import { driveRoutesFrom, type OsrmPayload } from "../../backend/src/integrations/osrm";

test("OSRM routes become ranked driving instructions without prices", () => {
  const payload: OsrmPayload = {
    code: "Ok",
    routes: [{
      duration: 3660,
      distance: 96560,
      legs: [{ steps: [
        { name: "Campus Drive", distance: 800, duration: 100, maneuver: { type: "depart" } },
        { name: "I-5 South", distance: 93000, duration: 3400, maneuver: { type: "merge", modifier: "right" } },
        { name: "", distance: 10, duration: 2, maneuver: { type: "arrive" } },
      ] }],
    }],
  };
  const routes = driveRoutesFrom(payload, "https://www.openstreetmap.org/directions");
  assert.equal(routes[0].durationMinutes, 61);
  assert.equal(routes[0].distanceMiles, 60);
  assert.match(routes[0].steps[0].instruction, /Start on Campus Drive/);
  assert.match(routes[0].steps[1].instruction, /Merge right onto I-5 South/);
  assert.equal("amountUsd" in routes[0], false);
});
