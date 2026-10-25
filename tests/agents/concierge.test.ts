import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { HeatMap } from "../../backend/src/agents/heat";
import type { FlightPriceCheck } from "../../backend/src/agents/pricing";
import type { EventListing } from "../../backend/src/eventStore";

process.env.SMILE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "smile-concierge-"));
const core = await import("../../backend/src/index");
core.saveState(core.buildSeed().state);

type Msg = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
const message = (content: unknown[], stop_reason: Msg["stop_reason"]): Msg => ({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Msg;
const toolUse = (id: string, name: string, input: unknown) => message([{ type: "tool_use", id, name, input }], "tool_use");
const say = (text: string) => message([{ type: "text", text }], "end_turn");

/** A stand-in for Claude that plays back a script and records what it was sent. */
function scripted(...turns: Msg[]) {
  const calls: Params[] = [];
  return { calls, create: async (p: Params) => (calls.push(structuredClone(p)), turns.shift() ?? say("@JP done.")) };
}

const event: EventListing = { key: "luma-ggh", source: "luma", name: "Golden Gate Hack 2026", startsAt: "2026-11-14T17:00:00Z", venue: "Fort Mason Center", city: "San Francisco, CA", lat: 37.8063, lon: -122.4306, locationPrecision: "exact", url: "https://lu.ma/ggh", kind: "hackathon", distanceMiles: 60, fetchedAt: "2026-10-24T00:00:00Z", via: "direct" };
const deps = {
  discover: async () => ({ origin: { zip: "95616", label: "Davis, CA", lat: 38.54, lon: -121.74 }, radiusMiles: 150, events: [event], outsideRadius: [], unplaced: [], sources: [], store: "local" as const, classifiedBy: "keywords" as const }),
  heat: async () => ({ status: "ok", basis: "forecast", band: "Comfortable", summary: "Feels like 58–61°F around the venue at kickoff.", cells: [], hotspots: [] }) as unknown as HeatMap,
};
const input = (text: string) => ({ room: "test", text, sender: { name: "JP", initials: "JP" }, memory: {}, transcript: [], listings: new Map<string, EventListing>(), now: new Date("2026-10-24T12:00:00Z") });

test("Claude picks the tools; each runs as a registered agent under the concierge's permissions", async () => {
  const ai = scripted(
    toolUse("t1", "find_events", { zip: "95616", radius_miles: null, query: null }),
    toolUse("t2", "heat_at_venue", { event_key: "luma-ggh" }),
    say("@JP Golden Gate Hack 2026 is Saturday, Nov 14 at Fort Mason; heat looks comfortable."),
  );
  const out = await core.converse(input("@smile 95616 anything near me? will it be hot?"), { ...deps, create: ai.create });
  assert.equal(out.by, "claude");
  assert.deepEqual(out.tools, [{ name: "find_events", ok: true }, { name: "heat_at_venue", ok: true }]);
  assert.match(out.reply, /^@JP Golden Gate Hack/);

  // Strict tools, no forced tool choice, the model's own turns sent back unchanged, results in one user turn.
  const first = ai.calls[0]!;
  assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.tool_choice, undefined);
  assert.ok(first.tools!.every((t) => "strict" in t && t.strict === true));
  const last = ai.calls[2]!.messages;
  assert.equal(last.at(-2)?.role, "assistant");
  assert.equal((last.at(-1)!.content as { type: string }[])[0]?.type, "tool_result");

  const audit = core.loadState().audit;
  assert.ok(audit.some((e) => e.action === "discover.searched" && /asked by agent:concierge/.test(e.reason)));
  assert.ok(audit.some((e) => e.action === "heat.mapped" && /asked by agent:concierge/.test(e.reason)));
  assert.equal(audit.at(-1)?.action, "concierge.replied");
});

test("a reply with a dollar amount no tool computed is replaced by a code-written one", async () => {
  const ai = scripted(say("@JP a rideshare there is about $25."));
  const out = await core.converse(input("@smile how much is an uber to the hackathon?"), { ...deps, create: ai.create });
  assert.equal(out.by, "code");
  assert.match(out.note ?? "", /\$25\.00 did not come from a tool/);
  assert.doesNotMatch(out.reply, /\$25/);
});

test("amounts that a tool returned may be repeated exactly", () => {
  assert.equal(core.amountsGrounded("@JP the train is $12.40, under the $40.00 cap.", ['{"price":"$12.40","organizer_cap":"$40.00"}']).ok, true);
  assert.deepEqual(core.amountsGrounded("@JP about $13", ['{"price":"$12.40"}']).stray, [1300]);
});

test("the concierge resumes its flight worker and grounds the observed fare", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ places: [{ latitude: "47.24", longitude: "-122.44", "place name": "Tacoma", "state abbreviation": "WA" }] }), { status: 200 }));
  const ai = scripted(
    toolUse("f1", "find_events", { zip: "98402", radius_miles: 1500, query: null }),
    toolUse("f2", "check_flight_price", { zip: "98402", event_key: event.key, snapshot_id: null }),
    toolUse("f3", "check_flight_price", { zip: "98402", event_key: event.key, snapshot_id: null }),
    say("@JP the current flight fare is $109.00; the historical midpoint is $175.81."),
  );
  const snapshots: (string | undefined)[] = [];
  const out = await core.converse(input("@smile 98402 what is the current flight price to this event?"), {
    ...deps,
    create: ai.create,
    flightPrices: async (args) => {
      snapshots.push(args.snapshotId);
      return {
        live: { status: args.snapshotId ? "ok" : "timeout", amountUsd: args.snapshotId ? 109 : undefined, fromAirport: "SEA", toAirport: "SFO", departDate: "2026-11-13", observedAt: "2026-10-25T07:33:19Z", sourceUrl: "https://www.google.com/travel/flights", snapshotId: "sd_chat123", provider: "Airline", currency: "USD", via: "Bright Data", ms: 200 },
        prediction: { range: { p10: 161.89, p50: 175.81, p90: 195.57 } },
        signal: args.snapshotId ? "below_prediction" : "unavailable",
        differencePct: args.snapshotId ? -38 : null,
      } as FlightPriceCheck;
    },
  });
  assert.deepEqual(snapshots, [undefined, "sd_chat123"]);
  assert.equal(out.by, "claude");
  assert.match(out.reply, /current flight fare is \$109.00/);
  const pending = JSON.parse((ai.calls[2]!.messages.at(-1)!.content as { content: string }[])[0]!.content);
  assert.equal(pending.current_fare, null);
  assert.equal(pending.observed_at, null);
  assert.ok(core.loadState().audit.some((entry) => entry.action === "pricing.flight.checked" && /asked by agent:concierge/.test(entry.reason)));
});

test("the flight concierge rejects an unrelated snapshot before making a paid request", async () => {
  const ai = scripted(toolUse("f1", "check_flight_price", { zip: "98402", event_key: event.key, snapshot_id: "sd_someoneelse" }), say("@JP I need to start a fresh search for your trip."));
  const request = input("@smile 98402 check the flight");
  request.listings.set(event.key, event);
  let calls = 0;
  const out = await core.converse(request, { create: ai.create, flightPrices: async () => { calls += 1; return null; } });
  assert.equal(calls, 0);
  assert.deepEqual(out.tools, [{ name: "check_flight_price", ok: false }]);
});

test("the concierge can only plan for the sender's own ZIP", async () => {
  const ai = scripted(toolUse("t1", "plan_trip", { zip: "90210", event_key: null, event_url: "https://lu.ma/ggh" }), say("@JP what's your home ZIP?"));
  const out = await core.converse(input("@smile 95616 plan me for https://lu.ma/ggh"), { ...deps, create: ai.create });
  assert.deepEqual(out.tools, [{ name: "plan_trip", ok: false }]);
  assert.equal(out.plans.length, 0);
  const result = (ai.calls[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
  assert.equal(result.is_error, true);
  assert.match(result.content, /use the ZIP code the sender gave/);
});

test("an unknown event key is a tool error the model can recover from, not a crash", async () => {
  const ai = scripted(toolUse("t1", "heat_at_venue", { event_key: "made-up" }), say("@JP which event do you mean?"));
  const out = await core.converse(input("@smile is it hot there?"), { ...deps, create: ai.create });
  assert.equal(out.by, "claude");
  assert.match((ai.calls[1]!.messages.at(-1)!.content as { content: string }[])[0]!.content, /unknown event_key/);
});

test("if Claude can't be reached before any tool runs, the caller answers another way", async () => {
  await assert.rejects(core.converse(input("@smile 95616"), { ...deps, create: async () => { throw new Error("overloaded"); } }), /overloaded/);
});
