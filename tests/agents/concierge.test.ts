import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { HeatMap } from "../../backend/src/agents/heat";
import type { FlightPriceCheck } from "../../backend/src/agents/pricing";
import type { EventListing } from "../../backend/src/eventStore";
import { prepareChatTravel, updateChatTravelMemory, type ChatTravelMemory } from "../../backend/src/agents/chatTravel";
import type { ConciergeDeps, ConciergeInput } from "../../backend/src/agents/concierge";

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
  const ai = scripted(toolUse("t1", "plan_trip", { zip: "90210", event_key: null, event_url: "https://lu.ma/ggh", includeSelfDrive: null, travelerBudgetCents: null, maxDistanceMiles: null, travel_requirements: null }), say("@JP what's your home ZIP?"));
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

const planInput = (request: ConciergeInput) => {
  const memory = updateChatTravelMemory(request.memory, request.text);
  return { zip: memory.zip, event_key: event.key, event_url: null, includeSelfDrive: memory.includeSelfDrive ?? null, travelerBudgetCents: memory.travelerBudgetCents ?? null, maxDistanceMiles: memory.maxDistanceMiles ?? null, travel_requirements: memory.requirements ?? null };
};

const planRecorder = (withFare = false) => {
  const calls: Parameters<NonNullable<ConciergeDeps["plan"]>>[1][] = [];
  const plan: ConciergeDeps["plan"] = async (state, args) => {
    calls.push(args);
    return { trip: { id: "TR-chat-test", travelerId: "T-chat-test" }, event: { id: event.key, name: event.name, startsAt: event.startsAt!, venue: event.venue!, city: event.city!, lat: event.lat, lon: event.lon, url: event.url }, evidence: [], routes: withFare ? { options: [], pick: { mode: "train", costCents: 10920, pMiss: 0, history: { trips: 0 } }, cap: 40_000, carbon: { estimates: [] } } : null, carpool: null, inbox: null } as Awaited<ReturnType<NonNullable<ConciergeDeps["plan"]>>>;
  };
  return { calls, plan };
};

test("the chat planner receives no-drive, budget, distance, timing, and a stable message receipt key", async () => {
  const request: ConciergeInput = { ...input("@smile plan from 95616 to this event with no self-drive, my budget is $400, within 200 miles. Arrive at Fort Mason by 9 AM PST on November 14, 2026."), requestId: "photon:group:message42" };
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  let reviewed: unknown;
  const ai = scripted(toolUse("p1", "plan_trip", planInput(request)), say("@JP I checked your requirements."));
  const out = await core.converse(request, {
    create: ai.create,
    plan: recorder.plan,
    reviewConstraints: async (args) => {
      reviewed = args;
      return { status: "ready", summary: "Arrive at Fort Mason by 9 AM PST on November 14, 2026.", destination: "Fort Mason", arriveBy: "2026-11-14 09:00 PST", departAfter: null, timezone: "America/Los_Angeles", followUpQuestion: null, parsedBy: "claude" };
    },
  });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0]!.includeSelfDrive, false);
  assert.equal(recorder.calls[0]!.travelerBudgetCents, 40_000);
  assert.equal(recorder.calls[0]!.maxDistanceMiles, 200);
  assert.equal(recorder.calls[0]!.requestKey, request.requestId);
  assert.equal(recorder.calls[0]!.travelConstraints?.arriveBy, "2026-11-14 09:00 PST");
  assert.match(recorder.calls[0]!.travelConstraints!.raw, /no self-drive/);
  assert.equal((reviewed as { eventName: string }).eventName, event.name);
  assert.equal(out.memory.includeSelfDrive, false);
  assert.equal(out.memory.travelerBudgetCents, 40_000);
});

test("sender preferences and earlier follow-up answers remain present on the next mention", async () => {
  const remembered: ChatTravelMemory = updateChatTravelMemory({}, "@smile 95616 no self-drive and a $250 budget. I need to arrive by 9 AM.");
  remembered.clarificationQuestion = "Which date and time zone should I use?";
  const request: ConciergeInput = { ...input("@smile November 14, 2026, Pacific time, at Fort Mason."), memory: remembered };
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  const ai = scripted(toolUse("p1", "plan_trip", planInput(request)), say("@JP I kept your earlier choices."));
  let raw = "";
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan, reviewConstraints: async (args) => {
    raw = args.text;
    return { status: "ready", summary: "Arrive at Fort Mason by 9 AM Pacific on November 14, 2026.", destination: "Fort Mason", arriveBy: "2026-11-14 09:00 Pacific", departAfter: null, timezone: "America/Los_Angeles", followUpQuestion: null, parsedBy: "claude" };
  } });
  assert.equal(recorder.calls[0]!.includeSelfDrive, false);
  assert.equal(recorder.calls[0]!.travelerBudgetCents, 25_000);
  assert.match(raw, /arrive by 9 AM/);
  assert.match(raw, /November 14, 2026, Pacific time/);
  assert.equal(out.memory.ownMessages?.length, 2);
  assert.equal(out.memory.clarificationQuestion, undefined);
});

test("an ambiguous time asks its follow-up and never creates a trip even if the model says otherwise", async () => {
  const request = input("@smile 95616 get me there by 9");
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  const ai = scripted(toolUse("p1", "plan_trip", planInput(request)), say("@JP your plan is ready."));
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan, reviewConstraints: async () => ({ status: "needs_clarification", summary: "Time is ambiguous.", destination: null, arriveBy: null, departAfter: null, timezone: null, followUpQuestion: "Is 9 AM or PM, and on which date and time zone?", parsedBy: "claude" }) });
  assert.equal(recorder.calls.length, 0);
  assert.match(out.reply, /Is 9 AM or PM/);
  assert.doesNotMatch(out.reply, /plan is ready/);
  assert.equal(out.memory.clarificationQuestion, "Is 9 AM or PM, and on which date and time zone?");
});

test("another conversation cannot change the sender's saved driving preference or budget", async () => {
  const request: ConciergeInput = { ...input("@smile plan my trip please"), memory: updateChatTravelMemory({}, "@smile 95616 no self-drive and my budget is $300"), transcript: [{ from: "AB", text: "@smile I can drive and my budget is $800" }] };
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  const ai = scripted(toolUse("p1", "plan_trip", { ...planInput(request), includeSelfDrive: true, travelerBudgetCents: 80_000 }), say("@JP I will keep your own preferences."));
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan });
  assert.equal(recorder.calls.length, 0);
  assert.equal(out.memory.includeSelfDrive, false);
  assert.equal(out.memory.travelerBudgetCents, 30_000);
  assert.equal(out.tools[0]!.ok, false);
  assert.match((ai.calls[1]!.messages.at(-1)!.content as { content: string }[])[0]!.content, /do not infer it from another member/);
});

test("the model cannot drop a known personal budget or add an invented distance limit", async () => {
  const request: ConciergeInput = { ...input("@smile plan it"), memory: updateChatTravelMemory({}, "@smile 95616 a $400 budget") };
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  const ai = scripted(toolUse("p1", "plan_trip", { ...planInput(request), travelerBudgetCents: null }), toolUse("p2", "plan_trip", { ...planInput(request), maxDistanceMiles: 150 }), say("@JP please confirm your travel choices."));
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan });
  assert.equal(recorder.calls.length, 0);
  assert.ok(out.tools.every((tool) => !tool.ok));
});

test("multiple plan tool calls in the same message create only one trip", async () => {
  const request = input("@smile 95616 plan my trip");
  request.listings.set(event.key, event);
  const recorder = planRecorder();
  const ai = scripted(toolUse("p1", "plan_trip", planInput(request)), toolUse("p2", "plan_trip", planInput(request)), say("@JP I checked the trip once."));
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan });
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(out.tools.map((tool) => tool.ok), [true, false]);
});

test("the deterministic fallback preserves preferences but asks rather than dropping an unparsed timing requirement", async () => {
  const raw = "@smile 95616 no self-drive, a $400 budget, within 200 miles. Arrive at SFO by 9 AM PST on November 14, 2026.";
  const prepared = await prepareChatTravel({}, raw, {}, async ({ text }) => ({ status: "ready", summary: text, destination: null, arriveBy: null, departAfter: null, timezone: null, followUpQuestion: null, parsedBy: "rules" }));
  assert.equal(prepared.preferences.includeSelfDrive, false);
  assert.equal(prepared.preferences.travelerBudgetCents, 40_000);
  assert.equal(prepared.preferences.maxDistanceMiles, 200);
  assert.match(prepared.clarification ?? "", /could not safely read/);
  assert.equal(prepared.preferences.travelConstraints, undefined);
});

test("uncertain budget and self-drive answers require clarification instead of guessed preferences", async () => {
  const budget = await prepareChatTravel({}, "@smile my budget is $300 or $500");
  assert.equal(budget.preferences.travelerBudgetCents, undefined);
  assert.match(budget.clarification ?? "", /one amount/);
  const drive = await prepareChatTravel({}, "@smile maybe driving is an option");
  assert.equal(drive.preferences.includeSelfDrive, undefined);
  assert.match(drive.clarification ?? "", /Should driving/);
  const answered = await prepareChatTravel(drive.memory, "@smile no");
  assert.equal(answered.preferences.includeSelfDrive, false);
  assert.equal(answered.clarification, undefined);
});

test("common no-driving phrases exclude self-drive and unclear car wishes ask instead of enabling it", async () => {
  for (const phrase of ["I won’t be driving", "no driving", "I don’t have a car", "I don't own a car", "I won’t drive myself", "I cannot self-drive"]) {
    const prepared = await prepareChatTravel({}, `@smile 95616 ${phrase}`);
    assert.equal(prepared.preferences.includeSelfDrive, false, phrase);
    assert.equal(prepared.clarification, undefined, phrase);
  }
  for (const phrase of ["I could possibly borrow a car", "not sure about driving", "do I need a car?"]) {
    const prepared = await prepareChatTravel({}, `@smile 95616 ${phrase}`);
    assert.equal(prepared.preferences.includeSelfDrive, undefined, phrase);
    assert.match(prepared.clarification ?? "", /Should driving/, phrase);
  }
});

test("natural maximum spending requests are remembered and unparsed affordability needs clarification", async () => {
  for (const phrase of ["$400 is the most I can afford", "I cannot spend more than $400", "I can spend no more than $400"]) {
    const prepared = await prepareChatTravel({}, `@smile 95616 ${phrase}`);
    assert.equal(prepared.preferences.travelerBudgetCents, 40_000, phrase);
    assert.equal(prepared.clarification, undefined, phrase);
  }
  const unclear = await prepareChatTravel({}, "@smile I could afford around $400");
  assert.equal(unclear.preferences.travelerBudgetCents, undefined);
  assert.match(unclear.clarification ?? "", /maximum total travel budget/);
});

test("a clear budget does not erase an unresolved driving question in the same message", async () => {
  const first = await prepareChatTravel({}, "@smile 95616 maybe I can borrow a car and my budget is $400");
  assert.equal(first.preferences.travelerBudgetCents, 40_000);
  assert.match(first.clarification ?? "", /Should driving/);
  const next = await prepareChatTravel(first.memory, "@smile no");
  assert.equal(next.preferences.includeSelfDrive, false);
  assert.equal(next.preferences.travelerBudgetCents, 40_000);
  assert.equal(next.clarification, undefined);
});

test("forwarded timing is never presented as a verified arrival guarantee", async () => {
  const request = input("@smile 95616 arrive at Fort Mason by 9 AM PST on November 14, 2026");
  request.listings.set(event.key, event);
  const recorder = planRecorder(true);
  const ai = scripted(toolUse("p1", "plan_trip", planInput(request)), say("@JP your arrival by 9 AM is guaranteed."));
  const out = await core.converse(request, { create: ai.create, plan: recorder.plan, reviewConstraints: async () => ({ status: "ready", summary: "Arrive at Fort Mason by 9 AM PST on November 14, 2026.", destination: "Fort Mason", arriveBy: "2026-11-14 09:00 PST", departAfter: null, timezone: "America/Los_Angeles", followUpQuestion: null, parsedBy: "claude" }) });
  const result = JSON.parse((ai.calls[1]!.messages.at(-1)!.content as { content: string }[])[0]!.content);
  assert.equal(result.travel_requirements.status, "schedule_confirmation_required");
  assert.equal(out.plans[0]!.timingNeedsConfirmation, true);
  assert.match(out.reply, /deadline has not been verified/);
  assert.doesNotMatch(out.reply, /guaranteed/);
});
