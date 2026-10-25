import { appendAudit } from "../hyphenate/audit";
import { discoverCall, discoverEvents, type DiscoverOptions, type DiscoverResult } from "./agents/discover";
import { heatCall, heatMapAround, type HeatMap } from "./agents/heat";
import { checkFlightPrice, estimatePrices, flightPriceCall, pricingCall, type FlightPriceCheck, type PriceEstimate } from "./agents/pricing";
import { runAgent } from "./agents/run";
import type { EventListing } from "./eventStore";
import { stateCodeFromLabel } from "./integrations/geo";
import { fmt } from "./money";
import { notify, tick } from "./orchestrator";
import { authorize } from "./permissions";
import { loadState, newId, withState, type State } from "./store";
import type { Actor, HackEvent, Trip } from "./types";

/**
 * Wakes the agents on a timer so S'mile acts without being asked: it re-runs the reimbursement
 * backlog, re-checks predicted prices and venue heat before trips, and flags event date changes.
 * Each job reads the books, does its network work without holding them, then writes evidence and
 * notices in one short transaction. Notices never change an amount or approve anything.
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

export interface SchedulerDeps {
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
}

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

export function applyPriceWatch(state: State, results: { tripId: string; estimate: PriceEstimate; flight?: FlightPriceCheck | null }[]): number {
  authorize(state, scheduler, "inbox.ask", "price_watch");
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
      ? `Price forecast for ${event.name}: about ${fmt(predicted.cents)} (likely ${predicted.range}), ${Math.abs(movePct)}% ${dir} the ${fmt(baselineCents)} reference. Open Google Flights to check the current fare.`
      : `Google Flights price check for ${event.name}: ${fmt(liveCents)} was observed for ${flight!.live.fromAirport}→${flight!.live.toAirport} on ${flight!.live.departDate}, ${Math.abs(movePct)}% ${dir} the previous ${fmt(baselineCents)} reference. The trained forecast is ${predicted.range}. Open Google Flights to confirm the fare before booking.`;
    const n = notify(
      state,
      trip,
      "traveler",
      `${liveCents === undefined ? "forecast" : "live-flight"}:${Math.sign(movePct)}:${Math.floor(Math.abs(movePct) / PRICE_MOVE_PCT)}`,
      message,
    );
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

export function applyWeatherWatch(state: State, results: { eventId: string; tripIds: string[]; map: HeatMap }[]): number {
  authorize(state, scheduler, "inbox.ask", "weather_watch");
  let sent = 0;
  for (const { eventId, tripIds, map } of results) {
    const event = state.events.find((e) => e.id === eventId);
    if (!event || map.status !== "ok") continue;
    const hottest = Math.round(Math.max(...map.cells.map((c) => c.feelsLikeF)));
    for (const tripId of tripIds) {
      const trip = state.trips.find((t) => t.id === tripId);
      if (!trip) continue;
      evidence(state, trip.id, "heat_watch", "S'mile Heat agent (Open-Meteo GFS + ECMWF)", { band: map.band, hottestF: hottest, basis: map.basis, summary: map.summary, hotspots: map.hotspots.length });
      if (!HEAT_ALERT_BANDS.includes(map.band)) continue;
      const n = notify(state, trip, "traveler", `heat:${map.band}`, `Heat check for ${event.name}: feels like up to ${hottest}°F around the venue at kickoff (${map.band}, NWS heat-index bands; ${map.basis}). Bring water and plan shade for any walk or wait outside.`);
      if (n) sent++;
    }
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

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The same event in a fresh listing: same key, or the same name. */
export function findListing(event: HackEvent, listings: EventListing[]): EventListing | undefined {
  return listings.find((l) => l.key === event.id) ?? listings.find((l) => norm(l.name) === norm(event.name));
}

export function applyEventWatch(state: State, results: { eventId: string; tripIds: string[]; listing: EventListing | undefined }[]): number {
  authorize(state, scheduler, "inbox.ask", "event_watch");
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
    for (const tripId of tripIds) {
      const trip = state.trips.find((t) => t.id === tripId);
      if (!trip) continue;
      evidence(state, trip.id, "event_change", `${listing.source} public listing`, { before, after: { startsAt: event.startsAt, venue: event.venue }, url: listing.url });
      const n = notify(state, trip, "traveler", `event:${event.startsAt}:${event.venue}`, `${event.name} ${what}. Check that your route still works; your approved amount is unchanged. Source: ${listing.url}`);
      if (n) sent++;
    }
  }
  return sent;
}

// ── running ────────────────────────────────────────────────────────────────
async function reconcileJob(): Promise<Omit<JobResult, "job">> {
  const done = await withState((s) => tick(s));
  return { checked: done.length, notices: done.filter((d) => d.needsHuman).length, summary: `Reconciled ${done.length} trip(s); ${done.filter((d) => d.needsHuman).length} need a person` };
}

async function priceWatchJob(deps: SchedulerDeps, now: Date): Promise<Omit<JobResult, "job">> {
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
  const notices = await withState((s) => applyPriceWatch(s, results));
  return { checked: results.length, notices, summary: `Checked live fares and forecasts for ${results.length} of ${targets.length} upcoming rideshare or flight trip(s); ${notices} price notice(s)` };
}

async function weatherWatchJob(deps: SchedulerDeps, now: Date): Promise<Omit<JobResult, "job">> {
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
  const notices = await withState((s) => applyWeatherWatch(s, results));
  return { checked: results.length, notices, summary: `Checked heat for ${results.length} event(s) in the next ${HEAT_DAYS} days; ${notices} heat notice(s)` };
}

async function eventWatchJob(deps: SchedulerDeps, now: Date): Promise<Omit<JobResult, "job">> {
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
  const notices = await withState((s) => applyEventWatch(s, results));
  const found = results.filter((r) => r.listing).length;
  return { checked: results.length, notices, summary: `Re-read ${results.length} event(s), found ${found} in current listings; ${notices} change notice(s)` };
}

export async function runJob(job: JobId, deps: SchedulerDeps = {}): Promise<JobResult> {
  const now = deps.now ?? new Date();
  const out = await runAgent({ agent: "scheduler", needs: ["schedule.run"], action: `scheduler.${job}`, subject: job, summarize: (r: Omit<JobResult, "job">) => r.summary }, () =>
    job === "reconcile" ? reconcileJob() : job === "price_watch" ? priceWatchJob(deps, now) : job === "weather_watch" ? weatherWatchJob(deps, now) : eventWatchJob(deps, now),
  );
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
