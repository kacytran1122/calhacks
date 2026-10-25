import assert from "node:assert/strict";
import test from "node:test";
import { heatCall } from "../../backend/src/agents/heat";
import { pricingCall } from "../../backend/src/agents/pricing";
import { runAgentIn } from "../../backend/src/agents/run";
import { AGENT_CAPS, AGENT_NEVER, authorize, PermissionDenied } from "../../backend/src/permissions";
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

test("the chat concierge and the scheduler hold no money capabilities", () => {
  const { state } = buildSeed();
  for (const id of ["concierge", "scheduler"] as const) {
    for (const cap of ["mandate.charge", "mandate.request", "approve", "ledger.post"] as const) {
      assert.throws(() => authorize(state, { kind: "agent", id }, cap, "T-test"), PermissionDenied, `${id} must not ${cap}`);
    }
  }
  assert.equal(state.audit.filter((e) => e.action === "permission.denied").length, 8);
});

test("discovery, heat and pricing are registered with only what their work needs", () => {
  assert.deepEqual([...AGENT_CAPS.discover].sort(), ["events.snapshot", "feeds.read", "web.read"]);
  assert.deepEqual([...AGENT_CAPS.heat], ["feeds.read"]);
  assert.deepEqual([...AGENT_CAPS.pricing].sort(), ["feeds.read", "model.predict", "web.read"]);
  for (const id of ["discover", "heat", "pricing", "scheduler", "concierge"] as const) assert.ok(AGENT_NEVER[id].length > 0);
});

test("an agent runs only with every capability, and each call is audited", async () => {
  const { state } = buildSeed();
  const before = state.audit.length;
  const out = await runAgentIn(state, { ...pricingCall("route:test", { actor: { kind: "agent", id: "concierge" }, cap: "price.estimate" }), summarize: () => "priced" }, async () => ({}) as never);
  assert.deepEqual(out, {});
  assert.equal(state.audit.length, before + 1);
  assert.equal(state.audit.at(-1)?.action, "pricing.estimated");
  assert.match(state.audit.at(-1)!.reason, /asked by agent:concierge/);

  // The auditor can read the books but may not ask the pricing agent for anything.
  let ran = false;
  await assert.rejects(
    runAgentIn(state, pricingCall("route:test", { actor: { kind: "agent", id: "auditor" }, cap: "price.estimate" }), async () => {
      ran = true;
      return {} as never;
    }),
    PermissionDenied,
  );
  assert.equal(ran, false);
  assert.equal(state.audit.at(-1)?.action, "permission.denied");
});

test("a failed agent call is audited as failed", async () => {
  const { state } = buildSeed();
  await assert.rejects(runAgentIn(state, heatCall("venue:test"), async () => { throw new Error("weather service down"); }), /weather service down/);
  assert.equal(state.audit.at(-1)?.action, "heat.mapped.failed");
});
