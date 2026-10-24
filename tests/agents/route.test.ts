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
