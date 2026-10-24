import assert from "node:assert/strict";
import test from "node:test";
import { isMlhEvent, matchesEventGroups, mergeLumaSources } from "../../backend/src/agents/discover";
import { resolveMlhEventUrl, type LumaEvent, type SourceResult } from "../../backend/src/integrations/sources";

const source = (status: SourceResult<LumaEvent>["status"], items: LumaEvent[], via: SourceResult<LumaEvent>["via"] = "direct"): SourceResult<LumaEvent> => ({
  source: "luma",
  status,
  via,
  items,
  ms: 10,
});

test("MLH events use the hackathon's own website", () => {
  assert.equal(resolveMlhEventUrl({ slug: "cal-hacks-13-0", url: "/events/cal-hacks-13-0/prizes", websiteUrl: "https://calhacks.io/" }), "https://calhacks.io/");
  assert.equal(resolveMlhEventUrl({ slug: "fallback", url: "/events/fallback/prizes" }), "https://www.mlh.com/events/fallback/prizes");
});

test("event groups distinguish official MLH events from general tech listings", () => {
  const mlh = { source: "luma" as const, alsoOn: ["mlh"], kind: "hackathon" as const };
  const tech = { source: "luma" as const, kind: "tech" as const };
  const devpost = { source: "devpost" as const, kind: "hackathon" as const };
  assert.equal(isMlhEvent(mlh), true);
  assert.equal(matchesEventGroups(mlh, ["mlh"]), true);
  assert.equal(matchesEventGroups(tech, ["tech"]), true);
  assert.equal(matchesEventGroups(devpost, ["mlh"]), false);
});

test("combined Luma status reflects events found by a nearby hub", () => {
  const event: LumaEvent = { id: "luma:event", name: "AI meetup", startsAt: "2026-11-01T18:00:00Z", url: "https://lu.ma/event", online: false };
  const result = mergeLumaSources([source("empty", []), source("ok", [event], "bright-data")], ["Chicago"]);

  assert.equal(result.status, "ok");
  assert.equal(result.via, "bright-data");
  assert.deepEqual(result.items, [event]);
  assert.equal(result.note, "also searched from Chicago");
});
