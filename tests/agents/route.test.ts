import assert from "node:assert/strict";
import test from "node:test";
import { compareRoutes } from "../../backend/src/agents/route";
import { buildSeed } from "../../backend/src/seed/trips";

test("self-drive follows the traveler preference", () => {
  const state = buildSeed().state;
  const fares = [{ mode: "train", amountUsd: 42 }];
  const withDrive = compareRoutes(state, { miles: 100, fares });
  const withoutDrive = compareRoutes(state, { miles: 100, fares, includeSelfDrive: false });

  assert.ok(withDrive.options.some((option) => option.mode === "drive"));
  assert.ok(withoutDrive.options.every((option) => option.mode !== "drive"));
  assert.deepEqual(withoutDrive.options.map((option) => option.mode), ["train"]);
});

test("a live route without an auditable fare waits for fare verification", () => {
  const routes = compareRoutes(buildSeed().state, {
    miles: 30,
    fares: [],
    includeSelfDrive: false,
    context: { minutes: { train: { minutes: 74, source: "live timetable" }, bus: { minutes: 91, source: "live timetable" } } },
  });
  assert.equal(routes.options.length, 0);
  assert.equal(routes.blockReason, "NO_VERIFIED_FARE");
  assert.equal(routes.fastest, "train");
});

test("an unpriced domestic flight can still be labeled fastest", () => {
  const routes = compareRoutes(buildSeed().state, {
    miles: 1_700,
    fares: [{ mode: "bus", amountUsd: 120 }],
    includeSelfDrive: true,
    context: {
      minutes: {
        bus: { minutes: 2_100, source: "live transit" },
        drive: { minutes: 1_560, source: "live road route" },
        flight: { minutes: 360, source: "door-to-door flight estimate" },
      },
    },
  });
  assert.equal(routes.fastest, "flight");
  assert.ok(routes.options.every((option) => option.mode !== "flight"));
});
