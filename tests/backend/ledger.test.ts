import assert from "node:assert/strict";
import test from "node:test";
import { trialBalance } from "../../backend/hyphenate/ledger";
import { buildSeed } from "../../backend/src/seed/trips";

test("seeded double-entry books balance", () => {
  const { state } = buildSeed();
  const net = trialBalance(state).reduce((sum, row) => sum + row.balance, 0);
  assert.equal(net, 0);
  assert.ok(state.journal.every((entry) => entry.refs.length > 0));
});

test("the seeded dataset is deterministic", () => {
  const first = buildSeed();
  const second = buildSeed();
  assert.equal(first.state.trips.length, 64);
  assert.deepEqual(first.answerKey, second.answerKey);
});
