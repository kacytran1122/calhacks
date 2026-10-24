import assert from "node:assert/strict";
import test from "node:test";
import { mergeLumaSources } from "../../backend/src/agents/discover";
import type { LumaEvent, SourceResult } from "../../backend/src/integrations/sources";

const source = (status: SourceResult<LumaEvent>["status"], items: LumaEvent[], via: SourceResult<LumaEvent>["via"] = "direct"): SourceResult<LumaEvent> => ({
  source: "luma",
  status,
  via,
  items,
  ms: 10,
});

test("combined Luma status reflects events found by a nearby hub", () => {
  const event: LumaEvent = { id: "luma:event", name: "AI meetup", startsAt: "2026-11-01T18:00:00Z", url: "https://lu.ma/event", online: false };
  const result = mergeLumaSources([source("empty", []), source("ok", [event], "bright-data")], ["Chicago"]);

  assert.equal(result.status, "ok");
  assert.equal(result.via, "bright-data");
  assert.deepEqual(result.items, [event]);
  assert.equal(result.note, "also searched from Chicago");
});
