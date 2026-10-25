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
        { name: "Campus Drive", distance: 800, duration: 100, maneuver: { type: "depart", bearing_after: 180 } },
        { name: "I-5 South", distance: 93000, duration: 3400, destinations: "San Diego", maneuver: { type: "merge", modifier: "right" } },
        { name: "", distance: 10, duration: 2, maneuver: { type: "arrive" } },
      ] }],
    }],
  };
  const routes = driveRoutesFrom(payload, "https://www.openstreetmap.org/directions", { fromLabel: "UCLA", toLabel: "HackTX" });
  assert.equal(routes[0].durationMinutes, 61);
  assert.equal(routes[0].distanceMiles, 60);
  assert.match(routes[0].steps[0].instruction, /Leave UCLA via Campus Drive heading south/);
  assert.match(routes[0].steps[1].instruction, /join I-5 South/);
  assert.match(routes[0].steps[1].instruction, /signs for San Diego/);
  assert.match(routes[0].steps.at(-1)?.instruction ?? "", /reach HackTX/);
  assert.ok(routes[0].steps.every((step) => step.instruction !== "Continue."));
  assert.equal("amountUsd" in routes[0], false);
});
