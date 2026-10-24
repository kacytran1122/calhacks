import assert from "node:assert/strict";
import test from "node:test";
import { fallbackTravelConstraints } from "../../backend/src/agents/constraints";

test("travel constraints request clarification for an ambiguous place", () => {
  const result = fallbackTravelConstraints("I need to be at the airport at 10 PM");
  assert.equal(result.status, "needs_clarification");
  assert.match(result.followUpQuestion ?? "", /exact airport/i);
});

test("travel constraints accept a specific place, time, date, and time zone", () => {
  const result = fallbackTravelConstraints("I need to arrive at SFO by 10:00 PM PT on October 25");
  assert.equal(result.status, "ready");
  assert.equal(result.followUpQuestion, null);
});
