import { z } from "zod";
import { appendAudit } from "../../hyphenate/audit";
import { defend, traceFor } from "../../hyphenate/agents/auditor";
import { decide } from "../../hyphenate/agents/reconciler";
import { capFor, POLICY, RULES } from "../../hyphenate/policy";
import { postBotMessage } from "../chatStore";
import { stateCodeFromLabel } from "../integrations/geo";
import { MODELS } from "../llm";
import { fmt } from "../money";
import { applyDecision, notify, tick } from "../orchestrator";
import { loadState, withState, type State } from "../store";
import type { AgentId, BoardMessage, Trip } from "../types";
import { canMessage, claimNext, close, post } from "./board";
import { brainsOn, nullable, schema, think, ToolError, type CreateFn, type Tool } from "./brain";
import { discoverCall, discoverEvents, findListing, type DiscoverOptions, type DiscoverResult } from "./discover";
import { searchFares } from "./evidence";
import { checkFlightPrice, flightPriceCall } from "./pricing";
import { runAgent } from "./run";
import { scoutEvent } from "./scout";

/**
 * The team: every agent that thinks, what it's for, the tools it thinks with, and what code does
 * in its place when Claude isn't available. runBoard() wakes agents for the notes left for them
 * until the board is quiet.
 *
 * Two agents stay plain code on purpose: the scheduler is a clock (it starts the work), and
 * payments moves money only on an approval a person gave. Both still post findings to the board.
 */

export interface TeamDeps {
  create?: CreateFn;
  now?: Date;
  flightPrices?: typeof checkFlightPrice;
  discover?: (opts: DiscoverOptions) => Promise<DiscoverResult>;
  scout?: typeof scoutEvent;
  searchFares?: typeof searchFares;
  chat?: (room: string, text: string) => Promise<void>;
}

interface Ctx {
  me: AgentId;
  msg: BoardMessage;
  deps: TeamDeps;
  /** Trips this handler decided (reconciler), so the auditor reviews every one. */
  decided: string[];
}

const DAY = 86_400_000;
const cents = (usd: number | undefined) => (usd === undefined ? null : fmt(Math.round(usd * 100)));

function tripOf(s: State, tripId: string): Trip {
  const trip = s.trips.find((t) => t.id === tripId);
  if (!trip) throw new ToolError(`no trip ${tripId}`);
  return trip;
}

const latest = (s: State, tripId: string, kind: string) => [...s.evidence].reverse().find((e) => e.tripId === tripId && e.kind === kind);

/** Everything an agent usually needs to know about a trip, with amounts already written out by code. */
export function tripFacts(s: State, tripId: string, now = new Date()) {
  const trip = tripOf(s, tripId);
  const event = s.events.find((e) => e.id === trip.eventId);
  const price = latest(s, trip.id, "price_watch")?.data;
  const heat = latest(s, trip.id, "heat_watch")?.data;
  const moved = latest(s, trip.id, "event_change")?.data;
  return {
    trip_id: trip.id,
    traveler: s.travelers.find((t) => t.id === trip.travelerId)?.initials ?? "?",
    mode: trip.mode,
    status: trip.state,
    planned_price: trip.quoteCents ? fmt(trip.quoteCents) : null,
    organizer_cap: trip.organizerCapCents ? fmt(trip.organizerCapCents) : null,
    traveler_requirements: trip.travelConstraintSummary ?? null,
    event: event && { id: event.id, name: event.name, starts_at: event.startsAt, venue: event.venue, city: event.city, days_until: Math.round((new Date(event.startsAt).getTime() - now.getTime()) / DAY) },
    latest_price_check: price && {
      forecast: typeof price.predictedCents === "number" ? fmt(price.predictedCents) : null,
      forecast_range: price.range ?? null,
      live_fare: typeof price.liveCents === "number" ? fmt(price.liveCents) : null,
      live_status: price.liveStatus ?? null,
      move_pct: price.movePct ?? null,
    },
    latest_heat_check: heat && { band: heat.band, feels_like_up_to_f: heat.hottestF, basis: heat.basis },
    latest_event_change: moved && { before: moved.before, after: moved.after, source: moved.url },
    open_notices: s.inbox.filter((i) => i.tripId === trip.id && i.status === "open").map((i) => ({ kind: i.kind, asked_of: i.askedOf, topic: i.meta.topic ?? null })),
    planned_in_group_chat: Boolean(trip.chatRoom),
  };
}

const say = async (ctx: Ctx, p: { to: AgentId; topic: string; subject: string; text: string; data?: Record<string, unknown>; wantsReply?: boolean }) =>
  withState((s) => post(s, { from: ctx.me, ...p, replyTo: ctx.msg }));

// ── tools every brain may get ────────────────────────────────────────────────

const tripTool = (ctx: Ctx): Tool<{ trip_id: string }> => ({
  name: "trip_facts",
  description: "Facts about one trip: mode, status, planned price, organizer cap, the event and how many days away it is, the latest price, heat and event checks, notices still open, and whether it was planned in a group chat.",
  schema: schema({ trip_id: { type: "string" } }),
  input: z.object({ trip_id: z.string() }),
  run: async ({ trip_id }) => tripFacts(loadState(), trip_id, ctx.deps.now),
});

function messageTool(ctx: Ctx, to: AgentId[]): Tool<{ to: AgentId; topic: string; subject: string; text: string; wants_reply: boolean }> {
  return {
    name: "message_agent",
    description: `Leave a note on the team board for: ${to.join(", ")}. Say what you found or what you need. Set wants_reply when you need their answer; it comes back to you as a new note.`,
    schema: schema({
      to: { type: "string", enum: to },
      topic: { type: "string", description: "short dotted topic, e.g. price.moved, route.recheck, page.check" },
      subject: { type: "string", description: "the trip or event id this is about" },
      text: { type: "string" },
      wants_reply: { type: "boolean" },
    }),
    input: z.object({ to: z.enum(to as [AgentId, ...AgentId[]]), topic: z.string().min(1).max(60), subject: z.string().min(1).max(80), text: z.string().min(1).max(1_500), wants_reply: z.boolean() }),
    speaks: (i) => i.text,
    run: async (i) => {
      const tripId = loadState().trips.some((t) => t.id === i.subject) ? i.subject : ctx.msg.data.tripId;
      const m = await say(ctx, { to: i.to, topic: i.topic, subject: i.subject, text: i.text, wantsReply: i.wants_reply, data: tripId ? { tripId } : {} });
      return m ? { sent: true, note_id: m.id } : { sent: false, why: "an identical note is already open, or this chain of hand-offs is already long enough" };
    },
  };
}

const traceTool: Tool<{ trip_id: string }> = {
  name: "decision_trace",
  description: "The reconciler's decision for a trip with everything behind it: evidence, rules cited, approvals, ledger entries and audit history.",
  schema: schema({ trip_id: { type: "string" } }),
  input: z.object({ trip_id: z.string() }),
  run: async ({ trip_id }) => {
    const t = traceFor(loadState(), trip_id);
    const text = JSON.stringify(t);
    return text.length > 12_000 ? { ...t, note: "trace shortened", evidence: (t as { evidence?: unknown[] }).evidence?.slice(0, 12) } : t;
  },
};

/** The topic a traveler notice is filed under, so the same news never reaches them twice. */
const noticeTopic = (ctx: Ctx) => String(ctx.msg.data.topic ?? `${ctx.msg.topic}:${ctx.msg.subject}`);

function notifyTool(ctx: Ctx): Tool<{ trip_id: string; text: string }> {
  return {
    name: "notify_traveler",
    description: "Send the traveler one short notice about this news (shown in their S'mile inbox). It approves and changes nothing. A second notice on the same news is skipped.",
    schema: schema({ trip_id: { type: "string" }, text: { type: "string", description: "what changed, why it matters, and what they can do; amounts exactly as given" } }),
    input: z.object({ trip_id: z.string(), text: z.string().min(1).max(800) }),
    speaks: (i) => i.text,
    run: ({ trip_id, text }) =>
      withState((s) => {
        const n = notify(s, tripOf(s, trip_id), "traveler", noticeTopic(ctx), text);
        return n ? { sent: true } : { sent: false, why: "the traveler already has a notice about this" };
      }),
  };
}

function controllerTool(ctx: Ctx): Tool<{ trip_id: string; text: string }> {
  return {
    name: "ask_controller",
    description: "Put a question or a flag in front of the controller on the Desk. It's a notice: answering it approves nothing and moves no money.",
    schema: schema({ trip_id: { type: "string" }, text: { type: "string", description: "the question, with the rule and the amounts it turns on" } }),
    input: z.object({ trip_id: z.string(), text: z.string().min(1).max(1_200) }),
    speaks: (i) => i.text,
    run: ({ trip_id, text }) =>
      withState((s) => {
        const n = notify(s, tripOf(s, trip_id), "controller", `${ctx.me}:${ctx.msg.id}`, text);
        return n ? { sent: true } : { sent: false, why: "already asked" };
      }),
  };
}

// ── each agent's brain ───────────────────────────────────────────────────────

interface Brain {
  model: keyof typeof MODELS;
  goal: string;
  tools: (ctx: Ctx) => Tool[];
}

const homeOf = (s: State, tripId: string) => {
  const g = latest(s, tripId, "geocode")?.data as { lat?: number; lon?: number; label?: string; zip?: string } | undefined;
  return g?.lat !== undefined && g.lon !== undefined ? { lat: g.lat, lon: g.lon, state: stateCodeFromLabel(g.label), label: g.label ?? g.zip ?? "home" } : undefined;
};

const BRAINS: Partial<Record<AgentId, Brain>> = {
  orchestrator: {
    model: "reason",
    goal: "You coordinate the team. Findings about trips come to you, and you decide what reaches a person and who else should look. Tell a traveler only what helps them act, once. When the trip was planned in a group chat and the news helps the group, also tell the chat. Ask route to re-check a trip whose event moved or changed venue; ask evidence to find a fare when a plan is waiting for one; ask policy when a price now looks over the organizer cap. Pass the auditor's escalations to the controller. Replies from other agents come back to you as notes; act on them or let them rest.",
    tools: (ctx) => [
      tripTool(ctx),
      notifyTool(ctx),
      controllerTool(ctx),
      {
        name: "tell_chat",
        description: "Post a short update in the group chat the trip was planned in, through @smile. Mention the traveler by initials.",
        schema: schema({ trip_id: { type: "string" }, text: { type: "string" } }),
        input: z.object({ trip_id: z.string(), text: z.string().min(1).max(600) }),
        speaks: (i: { text: string }) => i.text,
        run: async ({ trip_id, text }: { trip_id: string; text: string }) => {
          const trip = tripOf(loadState(), trip_id);
          if (!trip.chatRoom) return { sent: false, why: "this trip wasn't planned in a group chat" };
          const m = await say(ctx, { to: "concierge", topic: "chat.tell", subject: trip_id, text, data: { tripId: trip_id } });
          return { sent: Boolean(m) };
        },
      } as Tool,
      messageTool(ctx, ["route", "evidence", "policy", "scout", "pricing"]),
    ],
  },

  pricing: {
    model: "watch",
    goal: "You watch prices for planned trips. A finding says a trip's forecast or live fare moved. Decide whether it matters to the traveler: it matters most before they book and when the event is close; a forecast-only move months out, or on a trip already booked, usually doesn't. For a flight you may re-check the live fare once. Report what matters to the orchestrator with the facts and a suggested notice; drop the rest and say why.",
    tools: (ctx) => [
      tripTool(ctx),
      {
        name: "price_checks",
        description: "This trip's recent price checks, newest first: forecast and range, live fare when one was observed, and the move against the planned price.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) =>
          loadState().evidence.filter((e) => e.tripId === trip_id && e.kind === "price_watch").reverse().slice(0, 6).map((e) => ({
            at: e.fetchedAt,
            forecast: typeof e.data.predictedCents === "number" ? fmt(e.data.predictedCents) : null,
            range: e.data.range ?? null,
            live_fare: typeof e.data.liveCents === "number" ? fmt(e.data.liveCents) : null,
            live_status: e.data.liveStatus ?? null,
            move_pct: e.data.movePct ?? null,
          })),
      } as Tool,
      {
        name: "recheck_live_fare",
        description: "Flights only: look up the current Google Flights fare for this trip's route and date again, next to the trained forecast.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => {
          const s = loadState();
          const trip = tripOf(s, trip_id);
          if (trip.mode !== "flight") throw new ToolError("only flights have a live fare to re-check");
          const event = s.events.find((e) => e.id === trip.eventId);
          const from = homeOf(s, trip.id);
          if (!event || event.lat === undefined || event.lon === undefined || !from) throw new ToolError("this trip has no home or venue location on file");
          const args = { from, to: { lat: event.lat, lon: event.lon }, startsAt: event.startsAt, fromState: from.state, toState: stateCodeFromLabel(event.city), timeoutMs: 30_000 };
          const out = await runAgent(flightPriceCall(trip.id), () => (ctx.deps.flightPrices ?? checkFlightPrice)(args));
          if (!out) return { status: "outside_scope" };
          return { status: out.live.status, fare: out.live.status === "ok" ? cents(out.live.amountUsd) : null, route: `${out.live.fromAirport}→${out.live.toAirport}`, depart_date: out.live.departDate, forecast: cents(out.prediction.range.p50), forecast_range: `${cents(out.prediction.range.p10)}–${cents(out.prediction.range.p90)}`, source: out.live.sourceUrl };
        },
      } as Tool,
      messageTool(ctx, ["orchestrator"]),
    ],
  },

  heat: {
    model: "watch",
    goal: "You watch heat at venues. A finding gives the heat band around an event and the trips going there. For each trip decide whether to warn and what to suggest for how they travel: walking to a stop or waiting outside matters more than arriving by car. Report each warning to the orchestrator as its own note about that trip.",
    tools: (ctx) => [
      tripTool(ctx),
      {
        name: "heat_check",
        description: "The latest heat check for a trip's venue: band, hottest feels-like temperature, basis, and summary.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => latest(loadState(), trip_id, "heat_watch")?.data ?? { status: "no heat check on file" },
      } as Tool,
      messageTool(ctx, ["orchestrator"]),
    ],
  },

  discover: {
    model: "watch",
    goal: "You read public event listings. A finding says an event's date or venue changed in a listing. Make sure before anyone is told: look the event up again, and ask scout to read the event's own page when the listings disagree or look thin. Then report the change to the orchestrator once for each trip, or say why you didn't.",
    tools: (ctx) => [
      tripTool(ctx),
      {
        name: "recheck_listing",
        description: "Search public listings near the traveler again and return the current listing for this event: name, start, venue and link.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => {
          const s = loadState();
          const trip = tripOf(s, trip_id);
          const event = s.events.find((e) => e.id === trip.eventId)!;
          const zip = s.travelers.find((t) => t.id === trip.travelerId)?.homeZip;
          if (!zip || !/^\d{5}$/.test(zip)) throw new ToolError("no home ZIP on file for this trip");
          const radiusMiles = Math.min(3_000, Math.max(150, Math.ceil(trip.distanceMiles * 1.25)));
          const r = await runAgent(discoverCall(`event:${event.id}`), () => (ctx.deps.discover ?? discoverEvents)({ zip, radiusMiles, days: 150, now: ctx.deps.now }));
          const l = findListing(event, [...r.events, ...r.outsideRadius, ...r.unplaced]);
          return l ? { found: true, name: l.name, starts_at: l.startsAt, venue: l.venue ?? null, url: l.url, source: l.source } : { found: false, on_file: { starts_at: event.startsAt, venue: event.venue } };
        },
      } as Tool,
      messageTool(ctx, ["orchestrator", "scout"]),
    ],
  },

  scout: {
    model: "watch",
    goal: "You read event pages. When asked, read the page and answer with the date, start time and venue the page itself states. Say plainly when the page couldn't be read or doesn't say.",
    tools: (ctx) => [
      {
        name: "read_event_page",
        description: "Fetch a public event page and pull out its name, start time and venue (from its structured data when it has some).",
        schema: schema({ url: { type: "string" } }),
        input: z.object({ url: z.string().url() }),
        run: async ({ url }: { url: string }) => readPage(ctx, url),
      } as Tool,
    ],
  },

  route: {
    model: "watch",
    goal: "You compare ways to travel. When asked to re-check a trip, look at the route on file and what changed since, and say whether the planned route still makes sense. You can't change it: a different route means the traveler re-plans and approves a new amount. Ask evidence for a fare or schedule you're missing.",
    tools: (ctx) => [
      tripTool(ctx),
      {
        name: "route_on_file",
        description: "The route chosen when this trip was planned: mode and price, why it was picked, the fastest and lowest-carbon options, and the organizer cap.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => {
          const q = latest(loadState(), trip_id, "quote")?.data;
          if (!q) return { status: "no route on file" };
          return { mode: q.mode, price: typeof q.amountCents === "number" ? fmt(q.amountCents) : null, why: q.pickReason ?? null, late_risk: q.pMiss ?? null, co2e_kg: q.co2eKg ?? null, fastest: q.fastest ?? null, lowest_carbon: q.lowestCarbon ?? null, organizer_cap: typeof q.organizerCapCents === "number" ? fmt(q.organizerCapCents) : null };
        },
      } as Tool,
      messageTool(ctx, ["orchestrator", "evidence"]),
    ],
  },

  evidence: {
    model: "watch",
    goal: "You find public, source-linked evidence. When a plan is waiting for a fare, search for one with your own queries (three tries at most), keep only fares a source states, and report what you found with links. Found fares don't change any plan: the traveler re-plans to approve one.",
    tools: (ctx) => [
      tripTool(ctx),
      {
        name: "search_fares",
        description: "Search the web for a published fare for this trip and keep only amounts a result's own snippet states, with its link. Each call is a paid search.",
        schema: schema({ trip_id: { type: "string" }, query: { type: "string", description: "e.g. 'Davis to San Francisco Amtrak adult one-way fare November 14'" } }),
        input: z.object({ trip_id: z.string(), query: z.string().min(5).max(200) }),
        run: async ({ trip_id, query }: { trip_id: string; query: string }) => {
          const s = loadState();
          const trip = tripOf(s, trip_id);
          const event = s.events.find((e) => e.id === trip.eventId);
          const from = homeOf(s, trip.id)?.label ?? s.travelers.find((t) => t.id === trip.travelerId)?.homeZip ?? "";
          const r = await runAgent({ agent: "evidence", needs: ["web.read"], action: "evidence.searched", subject: trip.id, summarize: (x: Awaited<ReturnType<typeof searchFares>>) => `${x.fares.length} stated fare(s) for "${query}"` }, () => (ctx.deps.searchFares ?? searchFares)(query, from, [event?.venue, event?.city].filter(Boolean).join(", ")));
          if (r.fares.length)
            await withState((st) => {
              st.evidence.push({ id: `EV-${trip.id}-fare-${Date.now()}`, tripId: trip.id, kind: "fare", source: "S'mile evidence agent follow-up search", fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data: { query, fares: r.fares, extractedBy: r.extractedBy } });
            });
          return { status: r.status, fares: r.fares.map((f) => ({ mode: f.mode, fare: cents(f.amountUsd), provider: f.provider, link: f.link, quote: f.quote })) };
        },
      } as Tool,
      messageTool(ctx, ["orchestrator", "route"]),
    ],
  },

  policy: {
    model: "reason",
    goal: "You apply the travel policy. When asked about an exception or a price over the cap, check the trip's numbers against the rules and either put one clear question to the controller (naming the rule and the amounts) or explain why no exception is needed. You never approve anything.",
    tools: (ctx) => [
      {
        name: "trip_money",
        description: "A trip's planned price, organizer cap for its distance, amount eligible for reimbursement, the controller sign-off threshold, and what's left in the season budget.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => {
          const s = loadState();
          const trip = tripOf(s, trip_id);
          const spent = s.journal.reduce((a, j) => a + j.lines.filter((l) => l.account === "5100").reduce((x, l) => x + l.debit - l.credit, 0), 0);
          return { planned_price: fmt(trip.quoteCents), organizer_cap: fmt(capFor(trip.distanceMiles)), distance_miles: trip.distanceMiles, eligible: trip.reimbursementEligibleCents !== undefined ? fmt(trip.reimbursementEligibleCents) : null, controller_signoff_over: fmt(POLICY.controllerThresholdCents), season_budget_left: fmt(POLICY.seasonBudgetCents - spent) };
        },
      } as Tool,
      { name: "policy_rules", description: "The travel policy's rules, R1 onward.", schema: schema({}), input: z.object({}), run: async () => RULES } as Tool,
      controllerTool(ctx),
      messageTool(ctx, ["orchestrator"]),
    ],
  },

  reconciler: {
    model: "reason",
    goal: "You work the reimbursement backlog. For each trip, preview the decision the rules give and apply it. When a payout looks off to you (a missing check-in, a receipt that doesn't fit the trip, an amount far from the quote), hold it for the controller with one specific question instead: you can hold a payout, never raise or loosen one. When the auditor questions a decision, read its trace and defend it, or concede plainly and say what should happen.",
    tools: (ctx) => [
      {
        name: "backlog",
        description: "Trips waiting for a reimbursement decision, oldest first.",
        schema: schema({}),
        input: z.object({}),
        run: async () => backlogOf(loadState()).map((t) => ({ trip_id: t.id, mode: t.mode, planned_price: fmt(t.quoteCents), submitted_at: t.submittedAt ?? null, state: t.state })),
      } as Tool,
      {
        name: "preview_decision",
        description: "What the rules decide for a trip, without applying it: outcome code, payout, reasons, rules cited, and whether a person must look.",
        schema: schema({ trip_id: { type: "string" } }),
        input: z.object({ trip_id: z.string() }),
        run: async ({ trip_id }: { trip_id: string }) => {
          const s = loadState();
          const d = decide(s, tripOf(s, trip_id));
          return { code: d.code, payout: fmt(d.payCents), needs_person: d.needsHuman, asked_of: d.askedOf ?? null, question: d.question ?? null, reasons: d.reasons, rules: d.refs };
        },
      } as Tool,
      {
        name: "apply_decision",
        description: "Apply the rules' decision for a trip in the backlog. Set hold_for_person to send a payout to the controller with your question instead of paying it automatically.",
        schema: schema({ trip_id: { type: "string" }, hold_for_person: { type: "boolean" }, question: nullable({ type: "string", description: "required when holding: what the controller should check" }) }),
        input: z.object({ trip_id: z.string(), hold_for_person: z.boolean(), question: z.string().max(600).nullable() }),
        speaks: (i: { question: string | null }) => i.question ?? "",
        run: ({ trip_id, hold_for_person, question }: { trip_id: string; hold_for_person: boolean; question: string | null }) =>
          withState((s) => {
            const trip = tripOf(s, trip_id);
            if (!backlogOf(s).some((t) => t.id === trip.id)) throw new ToolError("that trip isn't waiting for a decision");
            let d = decide(s, trip);
            let held = false;
            if (hold_for_person) {
              if (d.needsHuman) throw new ToolError("the rules already send this one to a person; apply it without holding");
              if (d.code === "recover_refund" || d.payCents <= 0) throw new ToolError("only a payout can be held");
              if (!question) throw new ToolError("say what the controller should check");
              d = { ...d, needsHuman: true, askedOf: "controller", question: `${question} (The rules would pay ${fmt(d.payCents)}: ${d.code.replace(/_/g, " ")}.)`, options: [{ id: "approve", label: `Pay ${fmt(d.payCents)}` }, { id: "reject", label: "Don't pay" }] };
              held = true;
            }
            applyDecision(s, trip, d);
            if (held) appendAudit(s, { actor: { kind: "agent", id: "reconciler" }, action: "decision.held", subject: trip.id, reason: `Held ${fmt(d.payCents)} for the controller: ${question}`, refs: d.refs });
            ctx.decided.push(trip.id);
            return { trip_id: trip.id, code: d.code, payout: fmt(d.payCents), held_for_person: held || d.needsHuman, trip_state: trip.state };
          }),
      } as Tool,
      traceTool,
    ],
  },

  auditor: {
    model: "reason",
    goal: "You review the reconciler's decisions the way an external auditor would. Read each trace. When one looks wrong or thinly supported, challenge the reconciler with one pointed question; its answer comes back to you as a note. If the answer doesn't hold up, escalate to the controller through the orchestrator. Accept the rest. You change nothing yourself.",
    tools: (ctx) => [
      traceTool,
      {
        name: "challenge",
        description: "Ask the reconciler one pointed question about a decision. Its answer comes back to you.",
        schema: schema({ trip_id: { type: "string" }, question: { type: "string" } }),
        input: z.object({ trip_id: z.string(), question: z.string().min(5).max(600) }),
        speaks: (i: { question: string }) => i.question,
        run: async ({ trip_id, question }: { trip_id: string; question: string }) => {
          const m = await say(ctx, { to: "reconciler", topic: "decision.challenge", subject: trip_id, text: question, data: { tripId: trip_id }, wantsReply: true });
          return { sent: Boolean(m) };
        },
      } as Tool,
      {
        name: "escalate",
        description: "Send a decision you don't accept to the controller, through the orchestrator, with what's wrong and what should be checked.",
        schema: schema({ trip_id: { type: "string" }, text: { type: "string" } }),
        input: z.object({ trip_id: z.string(), text: z.string().min(5).max(1_000) }),
        speaks: (i: { text: string }) => i.text,
        run: async ({ trip_id, text }: { trip_id: string; text: string }) => {
          const m = await say(ctx, { to: "orchestrator", topic: "audit.escalate", subject: trip_id, text, data: { tripId: trip_id } });
          return { sent: Boolean(m) };
        },
      } as Tool,
    ],
  },
};

/** Agents that think with Claude: the team's brains, plus the concierge, which thinks in the group chat (concierge.ts). */
export const THINKING = [...Object.keys(BRAINS), "concierge"] as AgentId[];

function backlogOf(s: State) {
  return s.trips
    .filter((t) => t.state === "submitted" || (t.state === "reimbursed" && s.evidence.some((e) => e.tripId === t.id && e.kind === "refund" && e.data.processed === false)))
    .sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
}

async function readPage(ctx: Ctx, url: string) {
  // scoutEvent records its own evidence; read on a copy, then keep that evidence in the books.
  const scratch = loadState();
  const r = await (ctx.deps.scout ?? scoutEvent)(scratch, url);
  await withState((s) => void s.evidence.push(r.evidence));
  const f = r.facts;
  return f ? { status: r.evidence.status, name: f.name ?? null, starts_at: f.startsAt ?? null, venue: f.venue ?? null, address: f.address ?? null, read_by: f.extractedBy } : { status: r.evidence.status, note: r.evidence.note ?? "nothing usable on the page" };
}

// ── what code does when no one is thinking ─────────────────────────────────

/** Findings pass along to the orchestrator unchanged, one per trip; it sends the code-written notice. */
async function forwardPerTrip(ctx: Ctx): Promise<string> {
  const ids = (ctx.msg.data.tripIds as string[] | undefined) ?? [String(ctx.msg.data.tripId ?? ctx.msg.subject)];
  let n = 0;
  for (const tripId of ids) if (await say(ctx, { to: "orchestrator", topic: ctx.msg.topic, subject: tripId, text: ctx.msg.text, data: { ...ctx.msg.data, tripId, tripIds: undefined } })) n++;
  return `Passed to the orchestrator for ${n} trip(s).`;
}

const FALLBACK: Partial<Record<AgentId, (ctx: Ctx) => Promise<string>>> = {
  pricing: forwardPerTrip,
  heat: forwardPerTrip,
  discover: forwardPerTrip,
  async orchestrator(ctx) {
    const tripId = String(ctx.msg.data.tripId ?? ctx.msg.subject);
    if (["price.moved", "heat.alert", "event.changed"].includes(ctx.msg.topic)) {
      const sent = await withState((s) => notify(s, tripOf(s, tripId), "traveler", noticeTopic(ctx), ctx.msg.text));
      return sent ? "Sent the traveler the notice." : "The traveler already had this notice.";
    }
    if (ctx.msg.topic === "audit.escalate") {
      await withState((s) => notify(s, tripOf(s, tripId), "controller", `auditor:${ctx.msg.id}`, `The auditor flagged this decision: ${ctx.msg.text}`));
      return "Put the auditor's flag in front of the controller.";
    }
    return "Noted.";
  },
  async scout(ctx) {
    const url = String(ctx.msg.data.url ?? ctx.msg.text.match(/https?:\/\/\S+/)?.[0] ?? "");
    if (!url) return "No page link to read.";
    return JSON.stringify(await readPage(ctx, url));
  },
  async route(ctx) {
    const q = latest(loadState(), String(ctx.msg.data.tripId ?? ctx.msg.subject), "quote")?.data;
    return q ? `On file: ${q.mode} for ${typeof q.amountCents === "number" ? fmt(q.amountCents) : "an unknown amount"}. Re-planning is up to the traveler.` : "No route on file.";
  },
  async evidence() {
    return "Left as is: a follow-up fare search needs the evidence agent's judgment.";
  },
  async policy(ctx) {
    const tripId = String(ctx.msg.data.tripId ?? ctx.msg.subject);
    await withState((s) => notify(s, tripOf(s, tripId), "controller", `policy:${ctx.msg.id}`, ctx.msg.text));
    return "Put the question in front of the controller.";
  },
  async reconciler(ctx) {
    if (ctx.msg.topic === "decision.challenge") {
      const d = await defend(loadState(), String(ctx.msg.data.tripId ?? ctx.msg.subject), ctx.msg.text);
      return `${d.stance}: ${d.answer}`;
    }
    const before = new Set(backlogOf(loadState()).map((t) => t.id));
    const done = await withState((s) => tick(s));
    ctx.decided.push(...done.map((d) => d.tripId).filter((id) => before.has(id)));
    return `Reconciled ${done.length} trip(s); ${done.filter((d) => d.needsHuman).length} need a person.`;
  },
  async auditor() {
    return "No review without Claude; the decisions are on the Desk.";
  },
  async concierge(ctx) {
    const trip = tripOf(loadState(), String(ctx.msg.data.tripId ?? ctx.msg.subject));
    if (!trip.chatRoom) return "That trip wasn't planned in a group chat.";
    await (ctx.deps.chat ?? postBotMessage)(trip.chatRoom, ctx.msg.text);
    return "Posted in the group chat.";
  },
};

// ── running the board ──────────────────────────────────────────────────────

function taskFor(msg: BoardMessage, now: Date): string {
  return [
    `A note for you on the team board (${msg.id}).`,
    `From: agent:${msg.from}`,
    `Topic: ${msg.topic}`,
    `About: ${msg.subject}`,
    `<message>\n${msg.text}\n</message>`,
    Object.keys(msg.data).length ? `<facts_from_code>\n${JSON.stringify(msg.data)}\n</facts_from_code>` : "",
    msg.wantsReply ? "The sender wants your answer: your final reply goes back to them as a note." : "",
    `Today is ${now.toISOString().slice(0, 10)}.`,
  ].filter(Boolean).join("\n");
}

export interface BoardRun {
  handled: number;
  byClaude: number;
  failed: number;
}

/**
 * Wake agents for their notes, oldest first, until the board is quiet or `limit` notes are handled.
 * An agent with a brain thinks when Claude is on; otherwise, or if Claude fails, its code runs.
 * When a reconciler pass decides trips and Claude is on, the auditor always gets them to review.
 */
export async function runBoard(deps: TeamDeps = {}, limit = 40): Promise<BoardRun> {
  const on = brainsOn(deps.create);
  const run: BoardRun = { handled: 0, byClaude: 0, failed: 0 };
  while (run.handled < limit) {
    const msg = await withState((s) => claimNext(s));
    if (!msg) break;
    run.handled++;
    const ctx: Ctx = { me: msg.to, msg, deps, decided: [] };
    const brain = on ? BRAINS[msg.to] : undefined;
    let outcome: { ok: boolean; result: string; by: "claude" | "code" };
    try {
      const thought = brain ? await think({ agent: msg.to, model: brain.model, goal: brain.goal, task: taskFor(msg, deps.now ?? new Date()), tools: brain.tools(ctx), create: deps.create }) : null;
      if (thought?.summary) outcome = { ok: true, result: thought.summary, by: "claude" };
      else outcome = { ok: true, result: `${await (FALLBACK[msg.to] ?? (async () => "Nothing to do."))(ctx)}${thought?.note ? ` (Claude gave no answer: ${thought.note})` : ""}`, by: "code" };
    } catch (e) {
      try {
        outcome = { ok: true, result: `${await (FALLBACK[msg.to] ?? (async () => "Nothing to do."))(ctx)} (Claude couldn't finish: ${(e as Error).message})`, by: "code" };
      } catch (e2) {
        outcome = { ok: false, result: (e2 as Error).message, by: "code" };
      }
    }
    await withState((s) => {
      close(s, msg.id, outcome);
      if (outcome.ok && msg.wantsReply && canMessage(msg.to, msg.from))
        post(s, { from: msg.to, to: msg.from, topic: `${msg.topic}.reply`, subject: msg.subject, text: outcome.result, data: { tripId: msg.data.tripId }, replyTo: msg });
      if (on && msg.to === "reconciler" && ctx.decided.length) {
        const decided = ctx.decided.map((id) => s.trips.find((t) => t.id === id)!).filter(Boolean);
        post(s, { from: "reconciler", to: "auditor", topic: "decisions.review", subject: "backlog", text: `Decided ${decided.length} trip(s): ${decided.map((t) => `${t.id} ${t.decision?.code ?? t.state}${t.decision?.payCents ? ` ${fmt(t.decision.payCents)}` : ""}`).join("; ")}. Please review.`, data: { tripIds: ctx.decided }, replyTo: msg });
      }
    });
    if (outcome.by === "claude") run.byClaude++;
    if (!outcome.ok) run.failed++;
  }
  return run;
}
