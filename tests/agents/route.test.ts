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

test("no-self-drive retains distinct priced train and bus itineraries with their own travel times", () => {
  const routes = compareRoutes(buildSeed().state, {
    miles: 80,
    includeSelfDrive: false,
    fares: [
      { mode: "train", routeTitle: "Train via Central", amountUsd: 20 },
      { mode: "train", routeTitle: "Train via Central", amountUsd: 22 },
      { mode: "train", routeTitle: "Train via West Station", amountUsd: 20 },
      { mode: "bus", routeTitle: "Express bus", amountUsd: 14 },
    ],
    context: {
      minutes: { train: { minutes: 60, source: "live transit" }, bus: { minutes: 110, source: "live transit" }, drive: { minutes: 30, source: "stale road result" } },
      itineraries: { "Train via Central": { minutes: 60, source: "live transit" }, "Train via West Station": { minutes: 95, source: "live transit" }, "Express bus": { minutes: 110, source: "live transit" } },
    },
  });
  assert.equal(routes.options.length, 3);
  assert.deepEqual(routes.options.filter(option => option.mode === "train").map(option => [option.routeTitle, option.minutes, option.costCents]), [["Train via Central", 60, 2000], ["Train via West Station", 95, 2000]]);
  assert.ok(routes.options.every(option => option.mode !== "drive"));
  assert.equal(routes.fastest, "train");
});

test("unsupported and invalid fares cannot become a train alternative", () => {
  const routes = compareRoutes(buildSeed().state, { miles: 80, includeSelfDrive: false, fares: [{ mode: "drive", amountUsd: 8 }, { mode: "unknown", amountUsd: 4 }, { mode: "bus", amountUsd: NaN }, { mode: "train", amountUsd: -1 }] });
  assert.deepEqual(routes.options, []);
  assert.equal(routes.blockReason, "NO_VERIFIED_FARE");
});

test("an unbound fare never inherits another itinerary's fastest travel time", () => {
  const routes = compareRoutes(buildSeed().state, { miles: 80, includeSelfDrive: false, fares: [{ mode: "train", amountUsd: 15 }], context: { minutes: { train: { minutes: 60, source: "fastest train" } }, itineraries: { "Express train": { minutes: 60, source: "live timetable" } } } });
  assert.equal(routes.options[0]?.minutes, undefined);
  assert.equal(routes.fastest, "train");
});

test("self-drive retains its live road timing alongside named transit alternatives", () => {
  const routes = compareRoutes(buildSeed().state, { miles: 80, fares: [{ mode: "train", amountUsd: 15, routeTitle: "Express train" }], context: { minutes: { drive: { minutes: 90, source: "live road route" } }, itineraries: { "Express train": { minutes: 60, source: "live timetable" } } } });
  assert.equal(routes.options.find(option => option.mode === "drive")?.minutes, 90);
});
