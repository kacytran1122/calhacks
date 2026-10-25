/**
 * Price estimates for transport whose price changes with the time of day (rideshare, flights).
 *
 * Models are trained in backend/ml/notebooks/smile_price_models.ipynb and exported as plain
 * JSON trees. They return a range (p10 / p50 / p90), never a single "exact" price: an estimate
 * is evidence for planning, and S'mile still requires a live quote before a traveler approves
 * an exact amount.
 *
 *  - Rideshare: fare from road distance and the time of the request (hour, weekday, day period).
 *  - Flights: U.S. route-level fare for the season, times a departure-hour factor learned from
 *    fares that record each flight's departure time.
 */
import rideshareJson from "../../ml/models/rideshare_fare.json";
import airfareJson from "../../ml/models/airfare.json";
import flightTimeJson from "../../ml/models/flight_time_of_day.json";
import { haversineMiles } from "../integrations/geo";
import { predictTrees, type CompactModel } from "./gbdt";

export interface DayPeriod {
  name: string;
  from_hour: number;
  to_hour: number;
}

export interface PriceModelFile {
  name: string;
  version: string;
  features: string[];
  quantiles: { p10: CompactModel; p50: CompactModel; p90: CompactModel };
  metrics: Record<string, number>;
  data: Record<string, unknown>;
  golden: { X: number[][]; p10: number[]; p50: number[]; p90: number[] };
  parity_max_abs_diff: number;
  periods?: DayPeriod[];
  by_period?: Record<string, Record<string, number>>;
}

export interface Airport {
  code: string;
  city: string;
  lat: number;
  lon: number;
  log_pax: number;
  fpm: number;
}

type AirfareFile = PriceModelFile & { airports: Airport[]; airport_defaults: { log_pax: number; fpm: number }; latest_year: number };

export const RIDESHARE = rideshareJson as unknown as PriceModelFile;
export const AIRFARE = airfareJson as unknown as AirfareFile;
export const FLIGHT_TIME = flightTimeJson as unknown as PriceModelFile;

export const PERIODS: DayPeriod[] = RIDESHARE.periods ?? [];

export function periodOf(hour: number): { index: number; name: string } {
  const index = PERIODS.findIndex((p) => hour >= p.from_hour && hour < p.to_hour);
  return { index, name: PERIODS[index]?.name ?? "" };
}

export interface PriceRange {
  p10: number;
  p50: number;
  p90: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Build the model's input row by feature name, so the app can't feed columns in the wrong order. */
function rowFor(model: PriceModelFile, values: Record<string, number>): number[] {
  return model.features.map((f) => {
    const v = values[f];
    if (v === undefined) throw new Error(`${model.name}: missing feature ${f}`);
    return v;
  });
}

/** Run the three quantile models and keep the range ordered (quantile models can cross). */
export function predictRange(model: PriceModelFile, row: number[]): PriceRange {
  const v = [predictTrees(model.quantiles.p10, row), predictTrees(model.quantiles.p50, row), predictTrees(model.quantiles.p90, row)].map((x) => Math.max(0, x)).sort((a, b) => a - b);
  return { p10: round2(v[0]!), p50: round2(v[1]!), p90: round2(v[2]!) };
}

/** Local wall-clock parts in a time zone (weekday: Monday = 0, as in pandas). */
export function localParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short", month: "numeric" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { hour: Number(get("hour")), minute: Number(get("minute")), dow, month: Number(get("month")) };
}

function timeFeatures(hour: number, dow: number) {
  return { hour, dow, hour_of_week: dow * 24 + hour, period: periodOf(hour).index, weekend: dow >= 5 ? 1 : 0 };
}

// ── Rideshare ───────────────────────────────────────────────────────────────
const EARLIEST_HOURS_BEFORE = 3;
export interface HourPrice {
  hour: number; // local departure hour, 0-23
  period: string;
  uber: PriceRange;
  lyft: PriceRange;
}

export interface RideshareEstimate {
  uber: PriceRange;
  lyft: PriceRange;
  miles: number;
  minutes: number;
  departAt: string;
  departHour: number;
  period: string;
  byHour: HourPrice[]; // the same ride requested at every hour of that day
  cheapestOnTime: HourPrice | null; // cheapest hour that still arrives before the event starts
  caveat: string;
}

function rideshareAt(miles: number, hour: number, dow: number, month: number, airport: boolean) {
  const values = (lyft: number) => ({ miles, ...timeFeatures(hour, dow), month, airport: airport ? 1 : 0, shared: 0, lyft });
  return { uber: predictRange(RIDESHARE, rowFor(RIDESHARE, values(0))), lyft: predictRange(RIDESHARE, rowFor(RIDESHARE, values(1))) };
}

/**
 * Fare for leaving `minutes` before `arriveBy`, plus the same ride at every hour of that day.
 * `minutes` (free-flow drive time) only sets the departure time; the price comes from distance
 * and time of day, because traffic and surge at each hour are what the model learned.
 */
export function estimateRideshare(args: { miles: number; minutes: number; arriveBy: string; timeZone?: string; airport?: boolean }): RideshareEstimate {
  const tz = args.timeZone ?? "America/Los_Angeles";
  const departAt = new Date(new Date(args.arriveBy).getTime() - args.minutes * 60_000).toISOString();
  const dep = localParts(departAt, tz);
  const arrive = localParts(args.arriveBy, tz);
  const now = rideshareAt(args.miles, dep.hour, dep.dow, dep.month, Boolean(args.airport));
  const byHour: HourPrice[] = Array.from({ length: 24 }, (_, hour) => ({ hour, period: periodOf(hour).name, ...rideshareAt(args.miles, hour, dep.dow, dep.month, Boolean(args.airport)) }));
  // Suggest only departures that still arrive on time and aren't absurdly early: up to 3 hours
  // before the planned departure, on the same calendar day.
  const latestHour = dep.dow === arrive.dow ? dep.hour : 23;
  const onTime = byHour.filter((h) => h.hour <= latestHour && h.hour >= latestHour - EARLIEST_HOURS_BEFORE);
  const cheapestOnTime = onTime.length ? onTime.reduce((a, b) => (b.uber.p50 < a.uber.p50 ? b : a)) : null;
  return {
    ...now,
    miles: round2(args.miles),
    minutes: Math.round(args.minutes),
    departAt,
    departHour: dep.hour,
    period: periodOf(dep.hour).name,
    byHour,
    cheapestOnTime,
    caveat: "Base fare before tax, tolls, booking fees and tip, learned from New York City Uber and Lyft trips. Prices elsewhere can differ.",
  };
}

// ── Flights ─────────────────────────────────────────────────────────────────
export interface FlightHour {
  hour: number;
  period: string;
  factor: number; // relative to the day's average departure on this route (average = 1.0)
  range: PriceRange;
}

export interface AirfareEstimate {
  from: Airport;
  to: Airport;
  miles: number;
  range: PriceRange; // route level for the season
  groundMiles: number; // home -> departure airport + arrival airport -> venue
  byHour: FlightHour[]; // nonstop departures across the travel day
  cheapestHour: FlightHour | null;
  caveat: string;
}

/** Ground travel to and from the airports is priced at the IRS mileage rate the travel policy already uses. */
const GROUND_USD_PER_MILE = 0.7;

/** The busiest commercial airports within `withinMiles` of a point, nearest first. */
export function airportsNear(point: { lat: number; lon: number }, withinMiles = 80, limit = 3): (Airport & { miles: number })[] {
  return AIRFARE.airports
    .map((a) => ({ ...a, miles: haversineMiles(point, a) }))
    .filter((a) => a.miles <= withinMiles && a.log_pax >= 8) // real scheduled service
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
}

/** Raw departure-hour price factor for a nonstop flight on a given weekday (relative to all itineraries that day). */
export function flightFactor(hour: number, dow: number): number {
  const v = predictTrees(FLIGHT_TIME.quantiles.p50, rowFor(FLIGHT_TIME, { dep_hour: hour, period: periodOf(Math.floor(hour)).index, dow, weekend: dow >= 5 ? 1 : 0, stops: 0, dur_ratio: 1 }));
  return Math.round(Math.max(0.3, v) * 1000) / 1000;
}

/** Cheapest predicted airport pair between two points, with prices by departure hour; null when flying doesn't make sense. */
export function estimateAirfare(args: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; when: string; timeZone?: string }): AirfareEstimate | null {
  if (haversineMiles(args.from, args.to) < 150) return null;
  const when = new Date(args.when);
  const quarter = Math.floor(when.getUTCMonth() / 3) + 1;
  const year = Math.min(when.getUTCFullYear(), AIRFARE.latest_year); // trees can't see past their last training year
  let best: Omit<AirfareEstimate, "byHour" | "cheapestHour"> | null = null;
  let bestCost = Infinity;
  for (const o of airportsNear(args.from))
    for (const d of airportsNear(args.to)) {
      if (o.code === d.code) continue;
      const miles = Math.round(haversineMiles(o, d));
      if (miles < 100) continue;
      const range = predictRange(AIRFARE, rowFor(AIRFARE, { nsmiles: miles, quarter, year, o_log_pax: o.log_pax, d_log_pax: d.log_pax, o_fpm: o.fpm, d_fpm: d.fpm }));
      // A cheaper fare from an airport 80 miles away isn't cheaper once you count getting there.
      const groundMiles = Math.round(o.miles + d.miles);
      const cost = range.p50 + groundMiles * GROUND_USD_PER_MILE;
      if (cost < bestCost) {
        bestCost = cost;
        best = {
          from: { code: o.code, city: o.city, lat: o.lat, lon: o.lon, log_pax: o.log_pax, fpm: o.fpm },
          to: { code: d.code, city: d.city, lat: d.lat, lon: d.lon, log_pax: d.log_pax, fpm: d.fpm },
          miles,
          range,
          groundMiles,
          caveat:
            "Season-level fare for this airport pair (U.S. DOT airfare reports), shaped by departure hour using Expedia fares that record each flight's time (New Zealand, 2019). Live ticket prices vary by day, seat and how early you book.",
        };
      }
    }
  if (!best) return null;
  const { dow } = localParts(args.when, args.timeZone ?? "America/Los_Angeles");
  // The model's factor is relative to all itineraries on a route that day (mostly pricier connections),
  // so only its shape across the day is used: scaled so the day's departures average 1.0 around the route fare.
  const hours = Array.from({ length: 18 }, (_, i) => i + 5);
  const raw = hours.map((h) => flightFactor(h, dow));
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const byHour: FlightHour[] = hours.map((hour, i) => {
    const factor = Math.round((raw[i]! / mean) * 1000) / 1000;
    return { hour, period: periodOf(hour).name, factor, range: { p10: round2(best.range.p10 * factor), p50: round2(best.range.p50 * factor), p90: round2(best.range.p90 * factor) } };
  });
  const cheapestHour = byHour.reduce<FlightHour | null>((a, b) => (!a || b.range.p50 < a.range.p50 ? b : a), null);
  return { ...best, byHour, cheapestHour };
}

export function modelCard() {
  const card = (m: PriceModelFile) => ({ name: m.name, version: m.version, metrics: m.metrics, data: m.data, parity: m.parity_max_abs_diff, by_period: m.by_period });
  return { rideshare: card(RIDESHARE), airfare: card(AIRFARE), flightTimeOfDay: card(FLIGHT_TIME) };
}
