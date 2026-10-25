import assert from "node:assert/strict";
import test from "node:test";
import { fallbackTravelConstraints, reviewTravelConstraints } from "../../backend/src/agents/constraints";

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

test("travel constraints stop an airport requirement that conflicts with the selected event", async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const result = await reviewTravelConstraints({
      text: "Leave 61401 after 5 PM CT and arrive at SFO by 3 PM PT on October 25.",
      eventName: "DuQuantum",
      eventCity: "Durham, NC",
      eventLat: 35.994,
      eventLon: -78.899,
    });
    assert.equal(result.status, "needs_clarification");
    assert.match(result.followUpQuestion ?? "", /DuQuantum is in Durham, NC/i);
    assert.match(result.followUpQuestion ?? "", /SFO/i);
  } finally {
    if (key) process.env.ANTHROPIC_API_KEY = key;
    if (token) process.env.ANTHROPIC_AUTH_TOKEN = token;
  }
});

test("travel constraints allow an airport close to the selected event", async () => {
  const key = process.env.ANTHROPIC_API_KEY;
  const token = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const result = await reviewTravelConstraints({
      text: "Arrive at SFO by 3 PM PT on October 25.",
      eventName: "CalHacks",
      eventCity: "San Francisco, CA",
      eventLat: 37.7749,
      eventLon: -122.4194,
    });
    assert.equal(result.status, "ready");
  } finally {
    if (key) process.env.ANTHROPIC_API_KEY = key;
    if (token) process.env.ANTHROPIC_AUTH_TOKEN = token;
  }
});
