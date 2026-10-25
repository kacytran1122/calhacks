import { appendAudit } from "../hyphenate/audit";
import { discoverCall, discoverEvents, findListing, type DiscoverOptions, type DiscoverResult } from "./agents/discover";

export { findListing };
import { heatCall, heatMapAround, type HeatMap } from "./agents/heat";
import { checkFlightPrice, estimatePrices, flightPriceCall, pricingCall, type FlightPriceCheck, type PriceEstimate } from "./agents/pricing";
import { runAgent } from "./agents/run";
import type { EventListing } from "./eventStore";
import { stateCodeFromLabel } from "./integrations/geo";
import { fmt } from "./money";
import { post } from "./agents/board";
import { brainsOn } from "./agents/brain";
import { runBoard, type BoardRun, type TeamDeps } from "./agents/team";
import { tick } from "./orchestrator";
import { loadState, newId, withState, type State } from "./store";
import type { Actor, HackEvent, Trip } from "./types";

/**
 * Wakes the team on a timer so S'mile acts without being asked. Each job is a sensor: it re-checks
 * predicted prices, venue heat and event listings for upcoming trips, records what it saw as
 * evidence, and posts what changed to the board for the agent who owns it (pricing, heat,
 * discover), then runs the board until the team is done. The reconcile job hands the backlog to
 * the reconciler. Network work happens without holding the books; writes are short transactions.
 * Nothing here or downstream changes an amount or approves anything.
 */

export type JobId = "reconcile" | "price_watch" | "weather_watch" | "event_watch";

export const JOBS: Record<JobId, { everyMinutes: number; what: string }> = {
  reconcile: { everyMinutes: 15, what: "Re-run the reimbursement backlog" },
  price_watch: { everyMinutes: 360, what: "Re-check live Google Flights fares and trained forecasts" },
  weather_watch: { everyMinutes: 180, what: "Re-check heat at the venue for trips in the next 3 days" },
  event_watch: { everyMinutes: 720, what: "Re-read event listings and flag date or venue changes" },
};

export const PRICE_MOVE_PCT = 15;
const PENDING_PRICE_RECHECK_MINUTES = 5;
const PRICE_DAYS = 120;
const HEAT_DAYS = 3;
const EVENT_DAYS = 120;
const HEAT_ALERT_BANDS = ["Caution", "Extreme caution", "Danger", "Extreme danger"];

const scheduler: Actor = { kind: "agent", id: "scheduler" };
const DAY = 86_400_000;

export interface SchedulerDeps extends TeamDeps {
  now?: Date;
  prices?: (args: { from: Point; to: Point; startsAt: string; fromState?: string; toState?: string }) => Promise<PriceEstimate>;
  flightPrices?: (args: { from: Point; to: Point; startsAt: string; fromState?: string; toState?: string; snapshotId?: string; timeoutMs?: number }) => Promise<FlightPriceCheck | null>;
  heat?: (args: { lat: number; lon: number; at: string }) => Promise<HeatMap>;
  discover?: (opts: DiscoverOptions) => Promise<DiscoverResult>;
}

type Point = { lat: number; lon: number };

export interface JobResult {
  job: JobId;
  checked: number;
  notices: number;
  summary: string;
  team?: BoardRun;
}

/** What a job saw, before the team acts on it: `describe` writes the summary once notices are counted. */
interface Sensed {
  checked: number;
  describe: (notices: number) => string;
}

/** The traveler was already told about this. */
const told = (state: State, trip: Trip, topic: string) => state.inbox.some((i) => i.kind === "notice" && i.tripId === trip.id && i.meta.topic === topic);

const ACTIVE: Trip["state"][] = ["planned", "pre_approved", "booked"];

function upcoming(state: State, now: Date, days: number) {
  return state.trips.flatMap((trip) => {
    const event = state.events.find((e) => e.id === trip.eventId);
    if (!trip.id.startsWith("TR-L") || !ACTIVE.includes(trip.state) || !event) return [];
    const t = new Date(event.startsAt).getTime();
    return t > now.getTime() && t <= now.getTime() + days * DAY ? [{ trip, event }] : [];
  });
}

const homeOf = (state: State, tripId: string): (Point & { state?: string }) | undefined => {
  const g = state.evidence.find((e) => e.tripId === tripId && e.kind === "geocode" && e.status === "ok")?.data as { lat?: number; lon?: number; label?: string } | undefined;
  return g?.lat !== undefined && g.lon !== undefined ? { lat: g.lat, lon: g.lon, state: stateCodeFromLabel(g.label) } : undefined;
};
const venueOf = (e: HackEvent): Point | undefined => (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined);

function evidence(state: State, tripId: string, kind: "price_watch" | "heat_watch" | "event_change", source: string, data: Record<string, unknown>) {
  state.evidence.push({ id: newId(`EV-${kind}`), tripId, kind, source, fetchedAt: new Date().toISOString(), status: "ok", provenance: "live", data });
}

// ── price_watch ────────────────────────────────────────────────────────────
/** Only modes whose price moves: train and bus fares are published, driving is the IRS rate. */
export function priceWatchTargets(state: State, now: Date) {
  return upcoming(state, now, PRICE_DAYS).flatMap(({ trip, event }) => {
    const from = homeOf(state, trip.id);
    const to = venueOf(event);
    const latest = [...state.evidence].reverse().find((item) => item.tripId === trip.id && item.kind === "price_watch");
    const snapshotId = latest?.data.liveStatus === "timeout" && typeof latest.data.liveSnapshotId === "string" && latest.data.liveCollectionState !== "ready"
      ? latest.data.liveSnapshotId
      : undefined;
    return (trip.mode === "rideshare" || trip.mode === "flight") && from && to && trip.quoteCents > 0 ? [{ trip, event, from, to, snapshotId }] : [];
  });
}

/** Predicted price for the trip's own mode, in cents, or null when the model has no estimate. */
export function predictedCents(mode: Trip["mode"], p: PriceEstimate): { cents: number; range: string } | null {
  if (mode === "rideshare" && p.rideshare) {
    const r = p.rideshare.uber.p50 <= p.rideshare.lyft.p50 ? p.rideshare.uber : p.rideshare.lyft;
    return { cents: Math.round(r.p50 * 100), range: `${fmt(Math.round(r.p10 * 100))}–${fmt(Math.round(r.p90 * 100))}` };
  }
  if (mode === "flight" && p.airfare) return { cents: Math.round(p.airfare.range.p50 * 100), range: `${fmt(Math.round(p.airfare.range.p10 * 100))}–${fmt(Math.round(p.airfare.range.p90 * 100))}` };
  return null;
}

/** Records each check as evidence and posts each move worth a look to the pricing agent. Returns findings posted. */
export function applyPriceWatch(state: State, results: { tripId: string; estimate: PriceEstimate; flight?: FlightPriceCheck | null }[]): number {
  let sent = 0;
  for (const { tripId, estimate, flight } of results) {
    const trip = state.trips.find((t) => t.id === tripId);
    const event = trip && state.events.find((e) => e.id === trip.eventId);
    const predicted = trip && predictedCents(trip.mode, estimate);
    if (!trip || !event || !predicted) continue;
    const previousLive = [...state.evidence].reverse().find((e) => e.tripId === tripId && e.kind === "price_watch" && typeof e.data.liveCents === "number");
    const liveCents = flight?.live.amountUsd === undefined ? undefined : Math.round(flight.live.amountUsd * 100);
    const baselineCents = Number(previousLive?.data.liveCents ?? trip.quoteCents);
    const comparisonCents = liveCents ?? predicted.cents;
    const movePct = Math.round(((comparisonCents - baselineCents) / baselineCents) * 100);
    const source = liveCents === undefined ? "S'mile Pricing agent (live fare unavailable; trained forecast retained)" : "Bright Data Google Flights scraper + S'mile trained forecast";
    evidence(state, trip.id, "price_watch", source, {
      mode: trip.mode,
      quoteCents: trip.quoteCents,
      baselineCents,
      liveCents,
      liveStatus: flight?.live.status,
      observedAt: flight?.live.observedAt,
      sourceUrl: flight?.live.sourceUrl,
      bookingUrl: flight?.live.bookingUrl,
      liveSnapshotId: flight?.live.snapshotId,
      liveCollectionState: flight?.live.collectionState,
      predictedCents: predicted.cents,
      range: predicted.range,
      signal: flight?.signal,
      movePct,
    });
    if (Math.abs(movePct) < PRICE_MOVE_PCT) continue;
    const dir = movePct > 0 ? "above" : "below";
    const message = trip.mode !== "flight"
      ? `Price check for ${event.name}: the ${trip.mode} is now predicted at about ${fmt(predicted.cents)} (likely ${predicted.range}), ${Math.abs(movePct)}% ${dir} the ${fmt(trip.quoteCents)} on your trip. This is a model estimate, not a fare. ${movePct > 0 ? "If the fare at booking is higher, you'll be asked to approve the exact new amount (R7)." : "Nothing changes unless you re-plan."}`
      : liveCents === undefined
      ? `Price check for ${event.name}: no exact live fare was verified, while the trained flight forecast is about ${fmt(predicted.cents)} (likely ${predicted.range}), ${Math.abs(movePct)}% ${dir} the ${fmt(baselineCents)} reference. This is a model estimate, not a fare. Nothing changes unless you re-plan.`
      : `Live Google Flights check for ${event.name}: ${fmt(liveCents)} was observed for ${flight!.live.fromAirport}→${flight!.live.toAirport} on ${flight!.live.departDate}, ${Math.abs(movePct)}% ${dir} the previous ${fmt(baselineCents)} reference. The trained forecast is ${predicted.range}. The observed fare can change; open the source and approve the exact current amount before booking.`;
    const topic = `${liveCents === undefined ? "forecast" : "live-flight"}:${Math.sign(movePct)}:${Math.floor(Math.abs(movePct) / PRICE_MOVE_PCT)}`;
    if (told(state, trip, topic)) continue;
    const n = post(state, {
      from: "scheduler",
      to: "pricing",
      topic: "price.moved",
      subject: trip.id,
      text: message,
      data: { tripId: trip.id, topic, mode: trip.mode, movePct, quote: fmt(trip.quoteCents), baseline: fmt(baselineCents), forecast: fmt(predicted.cents), range: predicted.range, liveFare: liveCents === undefined ? null : fmt(liveCents), liveStatus: flight?.live.status ?? null },
    });
    if (n) sent++;
  }
  return sent;
}

// ── weather_watch ──────────────────────────────────────────────────────────
export function weatherWatchTargets(state: State, now: Date) {
  const byEvent = new Map<string, { event: HackEvent; at: Point; trips: Trip[] }>();
  for (const { trip, event } of upcoming(state, now, HEAT_DAYS)) {
    const at = venueOf(event);
    if (!at) continue;
    const g = byEvent.get(event.id) ?? { event, at, trips: [] };
    g.trips.push(trip);
    byEvent.set(event.id, g);
  }
  return [...byEvent.values()];
}

/** Records each heat check as evidence and posts heat worth a warning to the heat agent, one finding per event. Returns trips flagged. */
export function applyWeatherWatch(state: State, results: { eventId: string; tripIds: string[]; map: HeatMap }[]): number {
  let sent = 0;
  for (const { eventId, tripIds, map } of results) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event || map.status !== "ok") continue;
    const hottest = Math.round(Math.max(...map.cells.map((c) => c.feelsLikeF)));
    const topic = `heat:${map.band}`;
    const flagged: string[] = [];
    for (const tripId of tripIds) {
      const trip = state.trips.find((t) => t.id === tripId);
      if (!trip) continue;
      evidence(state, trip.id, "heat_watch", "S'mile Heat agent (Open-Meteo GFS + ECMWF)", { band: map.band, hottestF: hottest, basis: map.basis, summary: map.summary, hotspots: map.hotspots.length });
      if (HEAT_ALERT_BANDS.includes(map.band) && !told(state, trip, topic)) flagged.push(trip.id);
    }
    if (!flagged.length) continue;
    const n = post(state, {
      from: "scheduler",
      to: "heat",
      topic: "heat.alert",
      subject: event.id,
      text: `Heat check for ${event.name}: feels like up to ${hottest}°F around the venue at kickoff (${map.band}, NWS heat-index bands; ${map.basis}). Bring water and plan shade for any walk or wait outside.`,
      data: { eventId: event.id, tripIds: flagged, topic, band: map.band, hottestF: hottest, basis: map.basis, summary: map.summary },
    });
    if (n) sent += flagged.length;
  }
  return sent;
}

// ── event_watch ────────────────────────────────────────────────────────────
export function eventWatchTargets(state: State, now: Date) {
  const byEvent = new Map<string, { event: HackEvent; zip: string; miles: number; trips: Trip[] }>();
  for (const { trip, event } of upcoming(state, now, EVENT_DAYS)) {
    const zip = state.travelers.find((t) => t.id === trip.travelerId)?.homeZip;
    if (!zip || !/^\d{5}$/.test(zip)) continue;
    const g = byEvent.get(event.id) ?? { event, zip, miles: trip.distanceMiles, trips: [] };
    g.trips.push(trip);
    byEvent.set(event.id, g);
  }
  return [...byEvent.values()];
}

/** Applies a listing's new date or venue (with its source) and posts the change to the discover agent. Returns trips flagged. */
export function applyEventWatch(state: State, results: { eventId: string; tripIds: string[]; listing: EventListing | undefined }[]): number {
  let sent = 0;
  for (const { eventId, tripIds, listing } of results) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event || !listing?.startsAt) continue;
    const moved = Math.abs(new Date(listing.startsAt).getTime() - new Date(event.startsAt).getTime()) > 3_600_000;
    const venueChanged = Boolean(listing.venue && event.venue && listing.venue !== event.venue);
    if (!moved && !venueChanged) continue;
    const before = { startsAt: event.startsAt, venue: event.venue };
    if (moved) event.startsAt = listing.startsAt;
    if (venueChanged) event.venue = listing.venue!;
    const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles", timeZoneName: "short" });
    const what = [moved ? `now starts ${when(listing.startsAt)} (was ${when(before.startsAt)})` : "", venueChanged ? `moved to ${listing.venue} (was ${before.venue})` : ""].filter(Boolean).join(" and ");
    appendAudit(state, { actor: scheduler, action: "event.changed", subject: event.id, reason: `${event.name} ${what}, per ${listing.source} listing`, refs: [listing.url, ...tripIds] });
    const topic = `event:${event.startsAt}:${event.venue}`;
    const flagged: string[] = [];
    for (const tripId of tripIds) {
      const trip = state.trips.find((t) => t.id === tripId);
      if (!trip) continue;
      evidence(state, trip.id, "event_change", `${listing.source} public listing`, { before, after: { startsAt: event.startsAt, venue: event.venue }, url: listing.url });
      if (!told(state, trip, topic)) flagged.push(trip.id);
    }
    if (!flagged.length) continue;
    const n = post(state, {
      from: "scheduler",
      to: "discover",
      topic: "event.changed",
      subject: event.id,
      text: `${event.name} ${what}. Check that your route still works; your approved amount is unchanged. Source: ${listing.url}`,
      data: { eventId: event.id, tripIds: flagged, topic, url: listing.url, source: listing.source, before, after: { startsAt: event.startsAt, venue: event.venue } },
    });
    if (n) sent += flagged.length;
  }
  return sent;
}

// ── running ────────────────────────────────────────────────────────────────
const backlogIds = (s: State) => new Set(s.trips.filter((t) => t.state === "submitted").map((t) => t.id));

/** With Claude on, the backlog goes to the reconciler agent (and its decisions to the auditor); otherwise the rules run it directly. */
async function reconcileJob(deps: SchedulerDeps): Promise<Sensed & { needsHuman: () => number }> {
  if (!brainsOn(deps.create)) {
    const done = await withState((s) => tick(s));
    const people = done.filter((d) => d.needsHuman).length;
    return { checked: done.length, needsHuman: () => people, describe: () => `Reconciled ${done.length} trip(s); ${people} need a person` };
  }
  const before = backlogIds(loadState());
  await withState((s) => {
    if (before.size) post(s, { from: "scheduler", to: "reconciler", topic: "backlog.work", subject: "backlog", text: `${before.size} trip(s) are waiting for a reimbursement decision.`, data: { tripIds: [...before] } });
  });
  // Counted after the team has run: trips that left the backlog, and those now waiting on a person.
  const decided = () => {
    const s = loadState();
    return s.trips.filter((t) => before.has(t.id) && t.state !== "submitted");
  };
  const needsHuman = () => decided().filter((t) => t.state === "needs_human").length;
  return { checked: before.size, needsHuman, describe: () => `Reconciled ${decided().length} trip(s); ${needsHuman()} need a person` };
}

async function priceWatchJob(deps: SchedulerDeps, now: Date): Promise<Sensed> {
  const targets = priceWatchTargets(loadState(), now);
  const results: { tripId: string; estimate: PriceEstimate; flight?: FlightPriceCheck | null }[] = [];
  for (const t of targets) {
    try {
      const args = { from: t.from, to: t.to, startsAt: t.event.startsAt, fromState: t.from.state, toState: stateCodeFromLabel(t.event.city) };
      const estimate = await runAgent(pricingCall(t.trip.id, { actor: scheduler, cap: "price.estimate" }), () => (deps.prices ?? estimatePrices)(args));
      const flight = t.trip.mode === "flight"
        ? await runAgent(flightPriceCall(t.trip.id, { actor: scheduler, cap: "price.estimate" }), () => (deps.flightPrices ?? checkFlightPrice)({ ...args, snapshotId: t.snapshotId, timeoutMs: 30_000 }))
        : undefined;
      results.push({ tripId: t.trip.id, estimate, flight });
    } catch {
      // recorded as pricing.estimated.failed; the next pass tries again
    }
  }
  await withState((s) => applyPriceWatch(s, results));
  return { checked: results.length, describe: (notices) => `Checked live fares and forecasts for ${results.length} of ${targets.length} upcoming rideshare or flight trip(s); ${notices} price notice(s)` };
}

async function weatherWatchJob(deps: SchedulerDeps, now: Date): Promise<Sensed> {
  const targets = weatherWatchTargets(loadState(), now);
  const results: { eventId: string; tripIds: string[]; map: HeatMap }[] = [];
  for (const t of targets) {
    try {
      const map = await runAgent(heatCall(t.event.id, { actor: scheduler, cap: "heat.read" }), () => (deps.heat ?? heatMapAround)({ ...t.at, at: t.event.startsAt }));
      results.push({ eventId: t.event.id, tripIds: t.trips.map((x) => x.id), map });
    } catch {
      // recorded as heat.mapped.failed
    }
  }
  await withState((s) => applyWeatherWatch(s, results));
  return { checked: results.length, describe: (notices) => `Checked heat for ${results.length} event(s) in the next ${HEAT_DAYS} days; ${notices} heat notice(s)` };
}

async function eventWatchJob(deps: SchedulerDeps, now: Date): Promise<Sensed> {
  const targets = eventWatchTargets(loadState(), now);
  const results: { eventId: string; tripIds: string[]; listing: EventListing | undefined }[] = [];
  // Events near the same ZIP share one search.
  const searches = new Map<string, Promise<DiscoverResult>>();
  for (const t of targets) {
    try {
      const radiusMiles = Math.min(3_000, Math.max(200, t.miles + 100));
      const key = `${t.zip}:${radiusMiles}`;
      if (!searches.has(key))
        searches.set(key, runAgent(discoverCall(`zip:${t.zip}`, { actor: scheduler, cap: "events.search" }), () => (deps.discover ?? discoverEvents)({ zip: t.zip, radiusMiles, days: EVENT_DAYS + 30, now })));
      const r = await searches.get(key)!;
      results.push({ eventId: t.event.id, tripIds: t.trips.map((x) => x.id), listing: findListing(t.event, [...r.events, ...r.outsideRadius, ...r.unplaced]) });
    } catch {
      // recorded as discover.searched.failed
    }
  }
  await withState((s) => applyEventWatch(s, results));
  const found = results.filter((r) => r.listing).length;
  return { checked: results.length, describe: (notices) => `Re-read ${results.length} event(s), found ${found} in current listings; ${notices} change notice(s)` };
}

const noticeIds = (s: State) => new Set(s.inbox.filter((i) => i.kind === "notice").map((i) => i.id));

/** Sense, then let the team act on what was sensed; notices are counted once the board is quiet. */
export async function runJob(job: JobId, deps: SchedulerDeps = {}): Promise<JobResult> {
  const now = deps.now ?? new Date();
  const out = await runAgent({ agent: "scheduler", needs: ["schedule.run"], action: `scheduler.${job}`, subject: job, summarize: (r: Omit<JobResult, "job">) => r.summary }, async () => {
    const before = noticeIds(loadState());
    let needsHuman: (() => number) | undefined;
    let sensed: Sensed;
    if (job === "reconcile") {
      const r = await reconcileJob(deps);
      needsHuman = r.needsHuman;
      sensed = r;
    } else sensed = await (job === "price_watch" ? priceWatchJob(deps, now) : job === "weather_watch" ? weatherWatchJob(deps, now) : eventWatchJob(deps, now));
    const team = await runBoard(deps);
    const notices = needsHuman ? needsHuman() : [...noticeIds(loadState())].filter((id) => !before.has(id)).length;
    const teamNote = team.handled ? `; the team handled ${team.handled} note(s)${team.byClaude ? `, ${team.byClaude} by Claude` : ""}` : "";
    return { checked: sensed.checked, notices, summary: `${sensed.describe(notices)}${teamNote}`, team };
  });
  await withState((s) => {
    s.scheduler = { lastRun: { ...s.scheduler?.lastRun, [job]: now.toISOString() } };
  });
  return { job, ...out };
}

export function dueJobs(state: State, now: Date): JobId[] {
  return (Object.keys(JOBS) as JobId[]).filter((job) => {
    const last = state.scheduler?.lastRun[job];
    if (!last) return true;
    const elapsed = now.getTime() - new Date(last).getTime();
    if (job === "price_watch" && elapsed >= PENDING_PRICE_RECHECK_MINUTES * 60_000 && priceWatchTargets(state, now).some((target) => target.snapshotId)) return true;
    return elapsed >= JOBS[job].everyMinutes * 60_000;
  });
}

/** One wake-up: every job whose interval has passed, in order. A failed job doesn't stop the rest. */
export async function runDue(deps: SchedulerDeps = {}, only?: JobId[]): Promise<(JobResult | { job: JobId; error: string })[]> {
  const now = deps.now ?? new Date();
  const jobs = only ?? dueJobs(loadState(), now);
  const out: (JobResult | { job: JobId; error: string })[] = [];
  for (const job of jobs) {
    try {
      out.push(await runJob(job, { ...deps, now }));
    } catch (e) {
      out.push({ job, error: (e as Error).message });
    }
  }
  return out;
}
