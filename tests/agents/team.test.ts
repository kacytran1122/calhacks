import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { PriceEstimate } from "../../backend/src/agents/pricing";

// The books live in a throwaway folder; it must be set before the store module loads.
process.env.SMILE_DATA_DIR = mkdtempSync(path.join(tmpdir(), "smile-team-"));
const core = await import("../../backend/src/index");

type Msg = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
const message = (content: unknown[], stop_reason: Msg["stop_reason"]): Msg => ({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Msg;
let uses = 0;
const call = (name: string, input: unknown) => message([{ type: "tool_use", id: `t${++uses}`, name, input }], "tool_use");
const say = (text: string) => message([{ type: "text", text }], "end_turn");

/** A stand-in for Claude that plays back one script per agent and records what each agent was sent. */
function team(scripts: Record<string, Msg[]>) {
  const calls: { agent: string; params: Params }[] = [];
  const create = async (p: Params) => {
    const agent = /You are the (\w+) agent\./.exec(String(p.system))?.[1] ?? "?";
    calls.push({ agent, params: structuredClone(p) });
    return scripts[agent]?.shift() ?? say(`Nothing more to do.`);
  };
  return { calls, create };
}

const NOW = new Date("2026-11-12T17:00:00Z"); // two days before Golden Gate Hack 2026 (E-main)
const range = (p50: number) => ({ p10: p50 * 0.8, p50, p90: p50 * 1.3 });
const prices = (p50: number) => async () => ({ scope: { eligible: true, fromState: "IL", toState: "CA", reason: "test" }, rideshare: { uber: range(p50), lyft: range(p50 + 2) }, airfare: null, drive: { status: "ok", source: "test", miles: 12, minutes: 25 }, models: {} }) as unknown as PriceEstimate;

async function seedWithLiveTrip(chatRoom?: string) {
  core.saveState(core.buildSeed().state);
  await core.withState((s) => {
    s.travelers.push({ id: "T-live-test", initials: "JP", school: "test", homeZip: "94110" });
    s.trips.push({ id: "TR-L-test", travelerId: "T-live-test", eventId: "E-main", period: s.company.openPeriod, method: "virtual_card", mode: "rideshare", distanceMiles: 4, quoteCents: 2_000, requestedBy: "agent:policy", approvals: [], state: "pre_approved", chatRoom });
    s.evidence.push({ id: "EV-geo-test", tripId: "TR-L-test", kind: "geocode", source: "test", fetchedAt: NOW.toISOString(), status: "ok", provenance: "live", data: { zip: "94110", lat: 37.75, lon: -122.415 } });
  });
}

const travelerNotices = () => core.loadState().inbox.filter((i) => i.kind === "notice" && i.tripId === "TR-L-test" && i.askedOf === "traveler");
const board = () => core.loadState().board ?? [];

test("without Claude, a price move still reaches the traveler, passed along the board by code", async () => {
  await seedWithLiveTrip();
  const r = await core.runJob("price_watch", { now: NOW, prices: prices(30) });
  assert.equal(r.notices, 1);
  assert.deepEqual(board().map((m) => [m.from, m.to, m.topic, m.status, m.handledBy]), [
    ["scheduler", "pricing", "price.moved", "done", "code"],
    ["pricing", "orchestrator", "price.moved", "done", "code"],
  ]);
  assert.match(travelerNotices()[0]!.question, /predicted at about \$30\.00/);
  assert.match(r.summary, /the team handled 2 note\(s\)$/);
  const audit = core.loadState().audit;
  assert.ok(audit.some((e) => e.action === "agent.messaged" && /To agent:orchestrator \(price\.moved\)/.test(e.reason)));
  assert.ok(core.verifyChain(audit).ok);
});

test("with Claude, pricing judges the move, the orchestrator writes the notice and tells the group chat", async () => {
  await seedWithLiveTrip("room-golden-gate");
  const chat: { room: string; text: string }[] = [];
  const ai = team({
    pricing: [
      call("trip_facts", { trip_id: "TR-L-test" }),
      call("message_agent", { to: "orchestrator", topic: "price.moved", subject: "TR-L-test", text: "JP's rideshare is now forecast near $99.00.", wants_reply: false }),
      call("message_agent", { to: "orchestrator", topic: "price.moved", subject: "TR-L-test", text: "JP's rideshare forecast rose to $30.00 from the $20.00 planned, two days before kickoff and before booking. Worth a heads-up.", wants_reply: false }),
      say("Reported the rise to the orchestrator: it's close to the event and not booked yet."),
    ],
    orchestrator: [
      call("notify_traveler", { trip_id: "TR-L-test", text: "Rideshare to Golden Gate Hack now looks like $31.00." }),
      call("notify_traveler", { trip_id: "TR-L-test", text: "Heads-up: a rideshare to Golden Gate Hack 2026 is now forecast near $30.00, up from the $20.00 on your trip. It's an estimate; if the fare at booking is higher you'll approve the exact amount first." }),
      call("tell_chat", { trip_id: "TR-L-test", text: "@JP rideshare forecasts to Golden Gate Hack are up to about $30.00; a carpool might be worth a look." }),
      say("Told JP and the group chat."),
    ],
  });
  const r = await core.runJob("price_watch", { now: NOW, prices: prices(30), create: ai.create, chat: async (room, text) => void chat.push({ room, text }) });

  // An amount nobody computed is refused at the tool, and the agent corrects itself.
  assert.ok(ai.calls.some((c) => c.agent === "pricing" && JSON.stringify(c.params.messages).includes("$99.00 didn't come from your task or a tool result")));
  assert.ok(ai.calls.some((c) => c.agent === "orchestrator" && JSON.stringify(c.params.messages).includes("$31.00 didn't come from your task or a tool result")));

  const [notice] = travelerNotices();
  assert.match(notice!.question, /^Heads-up: a rideshare to Golden Gate Hack 2026 is now forecast near \$30\.00/);
  assert.deepEqual(chat, [{ room: "room-golden-gate", text: "@JP rideshare forecasts to Golden Gate Hack are up to about $30.00; a carpool might be worth a look." }]);
  assert.deepEqual(board().map((m) => [m.from, m.to, m.topic, m.handledBy]), [
    ["scheduler", "pricing", "price.moved", "claude"],
    ["pricing", "orchestrator", "price.moved", "claude"],
    ["orchestrator", "concierge", "chat.tell", "code"],
  ]);
  assert.equal(r.notices, 1);
  assert.equal(r.team?.byClaude, 2);
  // Watchers think on the smaller model; the coordinator on the larger one.
  assert.equal(ai.calls.find((c) => c.agent === "pricing")!.params.model, "claude-haiku-5-5");
  assert.equal(ai.calls.find((c) => c.agent === "orchestrator")!.params.model, "claude-opus-5-5");
  // Nothing about the trip's money changed.
  const trip = core.loadState().trips.find((t) => t.id === "TR-L-test")!;
  assert.equal(trip.quoteCents, 2_000);
  assert.equal(trip.approvals.length, 0);
});

test("with Claude, pricing can decide a move isn't worth a notice", async () => {
  await seedWithLiveTrip();
  const ai = team({ pricing: [call("trip_facts", { trip_id: "TR-L-test" }), say("Forecast only and the traveler can't act on it yet; no notice.")] });
  const r = await core.runJob("price_watch", { now: NOW, prices: prices(30), create: ai.create });
  assert.equal(r.notices, 0);
  assert.equal(travelerNotices().length, 0);
  assert.equal(board().length, 1);
  assert.match(board()[0]!.result!, /no notice/);
});

test("if Claude fails partway, code finishes the job the way it always did", async () => {
  await seedWithLiveTrip();
  const create = async () => {
    throw new Error("overloaded");
  };
  const r = await core.runJob("price_watch", { now: NOW, prices: prices(30), create });
  assert.equal(r.notices, 1);
  assert.ok(board().every((m) => m.status === "done" && m.handledBy === "code" && /Claude couldn't finish: overloaded/.test(m.result!)));
});

test("the auditor challenges a decision, the reconciler answers, and an unconvinced auditor escalates to the controller", async () => {
  core.saveState(core.buildSeed().state);
  const ai = team({
    reconciler: [
      // Working the backlog: one trip this pass.
      call("backlog", {}),
      call("preview_decision", { trip_id: "TR-F-02" }),
      call("apply_decision", { trip_id: "TR-F-02", hold_for_person: false, question: null }),
      say("Applied TR-F-02 (paid in full); the rest wait for the next pass."),
      // Answering the auditor.
      call("decision_trace", { trip_id: "TR-F-02" }),
      say("Defend: the bank line matches the approved quote and the check-in is on file."),
    ],
    auditor: [
      call("decision_trace", { trip_id: "TR-F-02" }),
      call("challenge", { trip_id: "TR-F-02", question: "What shows the traveler actually attended?" }),
      say("Asked the reconciler about attendance on TR-F-02."),
      call("escalate", { trip_id: "TR-F-02", text: "The reconciler cites a check-in but the trace has no check-in evidence id. Controller should confirm attendance." }),
      say("Escalated TR-F-02."),
    ],
    orchestrator: [call("ask_controller", { trip_id: "TR-F-02", text: "The auditor questions TR-F-02: no check-in evidence id in the trace. Please confirm attendance." }), say("Put it to the controller.")],
  });
  const r = await core.runJob("reconcile", { now: NOW, create: ai.create });
  assert.match(r.summary, /^Reconciled 1 trip\(s\)/);

  assert.deepEqual(board().map((m) => [m.from, m.to, m.topic]), [
    ["scheduler", "reconciler", "backlog.work"],
    ["reconciler", "auditor", "decisions.review"],
    ["auditor", "reconciler", "decision.challenge"],
    ["reconciler", "auditor", "decision.challenge.reply"],
    ["auditor", "orchestrator", "audit.escalate"],
  ]);
  assert.match(board()[3]!.text, /^Defend: the bank line matches/);
  const s = core.loadState();
  assert.equal(s.trips.find((t) => t.id === "TR-F-02")!.state, "reimbursed");
  const flag = s.inbox.find((i) => i.tripId === "TR-F-02" && i.askedOf === "controller" && i.kind === "notice");
  assert.match(flag!.question, /no check-in evidence id/);
  // The auditor and orchestrator moved no money: every journal entry this pass was posted by the reconciler.
  assert.ok(s.journal.filter((j) => j.refs.includes("TR-F-02")).every((j) => j.postedBy.kind === "agent" && j.postedBy.id === "reconciler"));
});

test("the reconciler may hold a payout for the controller, who then pays exactly what the rules computed", async () => {
  core.saveState(core.buildSeed().state);
  const s0 = core.loadState();
  const target = s0.trips.find((t) => t.state === "submitted" && t.requestedBy !== "P-maya" && (() => {
    const d = core.decide(s0, t);
    return !d.needsHuman && d.payCents > 0 && d.code === "reimburse_full";
  })())!;
  const pay = core.decide(s0, target).payCents;
  const needsPerson = s0.trips.find((t) => t.state === "submitted" && core.decide(s0, t).needsHuman)!;
  const ai = team({
    reconciler: [
      call("apply_decision", { trip_id: needsPerson.id, hold_for_person: true, question: "Check this." }),
      call("apply_decision", { trip_id: target.id, hold_for_person: true, question: "The receipt's merchant doesn't match the mode; is this the right trip?" }),
      say(`Held ${target.id} for the controller.`),
    ],
  });
  await core.runJob("reconcile", { now: NOW, create: ai.create });
  // Holding is only for payouts the rules would make on their own.
  assert.ok(ai.calls.some((c) => c.agent === "reconciler" && JSON.stringify(c.params.messages).includes("the rules already send this one to a person")));

  const s = core.loadState();
  const trip = s.trips.find((t) => t.id === target.id)!;
  assert.equal(trip.state, "needs_human");
  const q = s.inbox.find((i) => i.tripId === target.id && i.kind === "reconcile" && i.status === "open")!;
  assert.match(q.question, /merchant doesn't match the mode.*The rules would pay \$/);
  const out = await core.withState((st) => core.answer(st, q.id, { id: "P-maya", role: "controller" }, "approve"));
  assert.equal(out.outcome, `paid ${core.fmt(pay)}`);
});

test("discover has scout read the event's own page before the change goes to the orchestrator", async () => {
  await seedWithLiveTrip();
  const moved = { key: "luma-x", source: "luma" as const, name: "Golden Gate Hack 2026", startsAt: "2026-11-15T17:00:00Z", venue: "Fort Mason Center", locationPrecision: "exact" as const, url: "https://lu.ma/ggh", kind: "hackathon" as const, fetchedAt: NOW.toISOString(), via: "direct" as const };
  const discover = async () => ({ origin: { zip: "94110", lat: 0, lon: 0 }, radiusMiles: 200, events: [moved], outsideRadius: [], unplaced: [], sources: [], store: "local" as const, classifiedBy: "keywords" as const });
  const pages: string[] = [];
  const scout = (async (_state: unknown, url: string) => {
    pages.push(url);
    return { evidence: { id: "EV-page", kind: "event_page", source: "test", fetchedAt: NOW.toISOString(), status: "ok", provenance: "live", data: {} }, facts: { name: "Golden Gate Hack 2026", startsAt: "2026-11-15T09:00:00-08:00", venue: "Fort Mason Center", extractedBy: "json-ld", verified: true } };
  }) as unknown as typeof import("../../backend/src/agents/scout").scoutEvent;
  const ai = team({
    discover: [
      call("message_agent", { to: "scout", topic: "page.check", subject: "E-main", text: "Does https://lu.ma/ggh now say Nov 15?", wants_reply: true }),
      say("Asked scout to confirm the new date on the event page."),
      call("message_agent", { to: "orchestrator", topic: "event.changed", subject: "TR-L-test", text: "Golden Gate Hack 2026 moved to Nov 15; the event page confirms it.", wants_reply: false }),
      say("Confirmed and reported."),
    ],
    scout: [call("read_event_page", { url: "https://lu.ma/ggh" }), say("The page says it starts 2026-11-15 09:00 at Fort Mason Center.")],
    orchestrator: [call("notify_traveler", { trip_id: "TR-L-test", text: "Golden Gate Hack 2026 moved to Saturday, Nov 15 (the event page confirms it). Your approved amount is unchanged; check your route still works." }), say("Told JP.")],
  });
  const r = await core.runJob("event_watch", { now: NOW, discover, scout, create: ai.create });
  assert.equal(r.notices, 1);
  assert.deepEqual(pages, ["https://lu.ma/ggh"]);
  assert.deepEqual(board().map((m) => [m.from, m.to, m.topic]), [
    ["scheduler", "discover", "event.changed"],
    ["discover", "scout", "page.check"],
    ["scout", "discover", "page.check.reply"],
    ["discover", "orchestrator", "event.changed"],
  ]);
  assert.match(board()[2]!.text, /starts 2026-11-15 09:00/);
  assert.match(travelerNotices()[0]!.question, /confirms it/);
});

test("evidence follows up a plan that found no fare, and what it finds is recorded with its source", async () => {
  await seedWithLiveTrip();
  await core.withState((s) => void core.postToBoard(s, { from: "orchestrator", to: "evidence", topic: "fare.recheck", subject: "TR-L-test", text: "No source stated a fare. Look for one.", data: { tripId: "TR-L-test" }, wantsReply: true }));
  const queries: string[] = [];
  const searchFares = async (query: string) => {
    queries.push(query);
    return queries.length === 1
      ? { status: "empty" as const, fares: [], extractedBy: "none" }
      : { status: "ok" as const, fares: [{ mode: "bus" as const, amountUsd: 7.5, link: "https://example.org/fares", quote: "Adult one-way $7.50", provider: "example.org", priceScope: "published_ticket" as const, fees: "not_applicable" as const }], extractedBy: "test" };
  };
  const ai = team({
    evidence: [
      call("search_fares", { trip_id: "TR-L-test", query: "Mission District to Fort Mason fare" }),
      call("search_fares", { trip_id: "TR-L-test", query: "Muni bus adult one-way fare San Francisco" }),
      say("Found a published Muni fare of $7.50 (example.org); the traveler can re-plan to approve it."),
    ],
    orchestrator: [say("Noted; nothing to tell yet.")],
  });
  await core.runBoard({ now: NOW, create: ai.create, searchFares });
  assert.equal(queries.length, 2);
  const s = core.loadState();
  const fare = s.evidence.find((e) => e.tripId === "TR-L-test" && e.kind === "fare")!;
  assert.equal(fare.source, "S'mile evidence agent follow-up search");
  assert.deepEqual(board().map((m) => [m.from, m.to, m.topic, m.status]), [
    ["orchestrator", "evidence", "fare.recheck", "done"],
    ["evidence", "orchestrator", "fare.recheck.reply", "done"],
  ]);
  assert.match(board()[1]!.text, /\$7\.50/);
  assert.ok(s.audit.some((e) => e.action === "evidence.searched" && /1 stated fare/.test(e.reason)));
});

test("an agent's answer can't carry an amount it made up back to whoever asked", async () => {
  await seedWithLiveTrip();
  await core.withState((s) => void core.postToBoard(s, { from: "orchestrator", to: "route", topic: "route.recheck", subject: "TR-L-test", text: "The event moved a day. Does the route still work?", data: { tripId: "TR-L-test" }, wantsReply: true }));
  const ai = team({
    route: [say("Still fine, and it should now cost about $12.00."), say("Still fine: same rideshare, same day of the week; nothing on file needs to change.")],
    orchestrator: [say("Noted.")],
  });
  await core.runBoard({ now: NOW, create: ai.create });
  assert.ok(ai.calls.some((c) => c.agent === "route" && JSON.stringify(c.params.messages).includes("mentions $12.00, which didn't come from your task")));
  const reply = board().find((m) => m.topic === "route.recheck.reply")!;
  assert.doesNotMatch(reply.text, /\$12/);
  assert.match(reply.text, /^Still fine: same rideshare/);
});

test("agents only message along the team's lines, and hand-off chains stop", async () => {
  core.saveState(core.buildSeed().state);
  await assert.rejects(core.withState((s) => core.postToBoard(s, { from: "heat", to: "payments", topic: "x", subject: "E-main", text: "charge it" })), /may not message agent:payments/);
  assert.ok(core.loadState().audit.some((e) => e.action === "permission.denied" && /agent:heat may not message agent:payments/.test(e.reason)));

  const chain = await core.withState((s) => {
    let last = core.postToBoard(s, { from: "orchestrator", to: "route", topic: "route.recheck", subject: "E-main", text: "0" })!;
    const ids = [last.id];
    for (let i = 1; i <= core.MAX_DEPTH + 1; i++) {
      const [from, to] = i % 2 ? (["route", "orchestrator"] as const) : (["orchestrator", "route"] as const);
      const next = core.postToBoard(s, { from, to, topic: "route.recheck", subject: "E-main", text: String(i), replyTo: last });
      if (!next) break;
      ids.push(next.id);
      last = next;
    }
    return ids;
  });
  assert.equal(chain.length, core.MAX_DEPTH + 1);
  assert.ok(core.loadState().audit.some((e) => e.action === "board.dropped"));
});

test("two wake-ups never handle the same note", async () => {
  core.saveState(core.buildSeed().state);
  await core.withState((s) => void core.postToBoard(s, { from: "orchestrator", to: "route", topic: "route.recheck", subject: "E-main", text: "check" }));
  const [a, b] = await Promise.all([core.withState((s) => core.claimNext(s)), core.withState((s) => core.claimNext(s))]);
  assert.equal([a, b].filter(Boolean).length, 1);
});
