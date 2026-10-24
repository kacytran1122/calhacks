import assert from "node:assert/strict";
import test from "node:test";
import { capFor, isImmaterial, materialityFor } from "../../backend/src/policy";

test("distance caps stay on every policy boundary", () => {
  assert.equal(capFor(50), 4_000);
  assert.equal(capFor(50.01), 9_000);
  assert.equal(capFor(150), 9_000);
  assert.equal(capFor(150.01), 20_000);
  assert.equal(capFor(400), 20_000);
  assert.equal(capFor(400.01), 40_000);
});

test("materiality uses the larger of one dollar or three percent", () => {
  assert.equal(materialityFor(2_000), 100);
  assert.equal(materialityFor(10_000), 300);
  assert.equal(isImmaterial(10_000, 10_300, 10_000), true);
  assert.equal(isImmaterial(10_000, 10_301, 10_000), false);
});
