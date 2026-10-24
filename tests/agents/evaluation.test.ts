import assert from "node:assert/strict";
import test from "node:test";
import { runEval } from "../../backend/src/eval";

test("all planted cases and adversarial controls pass", async () => {
  const result = await runEval();
  assert.equal(result.totals.cases, 40);
  assert.equal(result.totals.exact, 40);
  assert.equal(result.totals.plantedCaught, 12);
  assert.ok(result.controls.length >= 19);
  assert.ok(result.controls.every((control) => control.ok), result.controls.filter((control) => !control.ok).map((control) => control.name).join(", "));
});
