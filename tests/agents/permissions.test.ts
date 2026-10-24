import assert from "node:assert/strict";
import test from "node:test";
import { authorize, PermissionDenied } from "../../backend/src/permissions";
import { buildSeed } from "../../backend/src/seed/trips";

test("least privilege prevents an evidence agent from posting", () => {
  const { state } = buildSeed();
  assert.throws(
    () => authorize(state, { kind: "agent", id: "evidence" }, "ledger.post", "JE-test"),
    PermissionDenied,
  );
  assert.equal(state.audit.at(-1)?.action, "permission.denied");
});

test("auditor is read-only", () => {
  const { state } = buildSeed();
  assert.doesNotThrow(() => authorize(state, { kind: "agent", id: "auditor" }, "ledger.read", "books"));
  assert.throws(() => authorize(state, { kind: "agent", id: "auditor" }, "ledger.post", "books"), PermissionDenied);
});
