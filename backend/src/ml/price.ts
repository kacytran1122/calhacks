/**
 * Price estimates for transport whose price moves around (rideshare, flights).
 *
 * Models are trained in backend/ml/notebooks/smile_price_models.ipynb and exported as
 * plain JSON trees. They return a range (p10 / p50 / p90), never a single "exact" price:
 * an estimate is evidence for planning, and S'mile still requires a live quote before a
 * traveler approves an exact amount.
 */
import rideshareJson from "../../ml/models/rideshare_fare.json";
import airfareJson from "../../ml/models/airfare.json";
import { haversineMiles } from "../integrations/geo";
import { predictTrees, type CompactModel } from "./gbdt";

export interface PriceModelFile {
  name: string;
  version: string;
  features: string[];
  quantiles: { p10: CompactModel; p50: CompactModel; p90: CompactModel };
  metrics: Record<string, number>;
  data: Record<string, unknown>;
  golden: { X: number[][]; p10: number[]; p50: number[]; p90: number[] };
  parity_max_abs_diff: number;
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

export interface PriceRange {
  p10: number;
  p50: number;
  p90: number;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Run the three quantile models and keep the range ordered (quantile models can cross). */
export function predictRange(model: PriceModelFile, row: number[]): PriceRange {
  const v = [predictTrees(model.quantiles.p10, row), predictTrees(model.quantiles.p50, row), predictTrees(model.quantiles.p90, row)].map((x) => Math.max(0, x)).sort((a, b) => a - b);
  return { p10: round2(v[0]!), p50: round2(v[1]!), p90: round2(v[2]!) };
}

/** Local wall-clock parts in a time zone (pandas dayofweek: Monday = 0). */
function localParts(iso: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short", month: "numeric" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dow = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { hour: Number(get("hour")), dow, month: Number(get("month")) };
}

export interface RideshareEstimate {
  uber: PriceRange;
  lyft: PriceRange;
  miles: number;
  minutes: number;
  departAt: string;
  caveat: string;
}

/**
 * Fare for leaving `minutes` before `arriveBy`. `airport` marks trips to or from an airport,
 * which the training data prices differently.
 */
export function estimateRideshare(args: { miles: number; minutes: number; arriveBy: string; timeZone?: string; airport?: boolean }): RideshareEstimate {
  const departAt = new Date(new Date(args.arriveBy).getTime() - args.minutes * 60_000).toISOString();
  const { hour, dow, month } = localParts(departAt, args.timeZone ?? "America/Los_Angeles");
  const row = (lyft: number) => [args.miles, args.minutes, hour, dow, month, args.airport ? 1 : 0, 0, lyft];
  return {
    uber: predictRange(RIDESHARE, row(0)),
    lyft: predictRange(RIDESHARE, row(1)),
    miles: round2(args.miles),
    minutes: Math.round(args.minutes),
    departAt,
    caveat: "Base fare before tax, tolls, booking fees and tip, learned from New York City Uber and Lyft trips. Prices elsewhere can differ.",
  };
}

export interface AirfareEstimate {
  from: Airport;
  to: Airport;
  miles: number;
  range: PriceRange;
  groundMiles: number; // home -> departure airport + arrival airport -> venue
  caveat: string;
}

/** Ground travel to and from the airports is priced at the IRS mileage rate the travel policy already uses. */
const GROUND_USD_PER_MILE = 0.7;

/** The busiest commercial airports within `withinMiles` of a point, nearest first. */
export function airportsNear(point: { lat: number; lon: number }, withinMiles = 80, limit = 3): (Airport & { miles: number })[] {
  return AIRFARE.airports
    .map((a) => ({ ...a, miles: haversineMiles(point, a) }))
    .filter((a) => a.miles <= withinMiles && a.log_pax >= 8) // ~3,000 passengers per quarter: real scheduled service
    .sort((a, b) => a.miles - b.miles)
    .slice(0, limit);
}

/** Cheapest predicted airport pair between two points, or null when flying doesn't make sense. */
export function estimateAirfare(args: { from: { lat: number; lon: number }; to: { lat: number; lon: number }; when: string }): AirfareEstimate | null {
  if (haversineMiles(args.from, args.to) < 150) return null;
  const when = new Date(args.when);
  const quarter = Math.floor(when.getUTCMonth() / 3) + 1;
  const year = Math.min(when.getUTCFullYear(), AIRFARE.latest_year); // trees can't see past their last training year
  let best: AirfareEstimate | null = null;
  let bestCost = Infinity;
  for (const o of airportsNear(args.from))
    for (const d of airportsNear(args.to)) {
      if (o.code === d.code) continue;
      const miles = Math.round(haversineMiles(o, d));
      if (miles < 100) continue;
      const range = predictRange(AIRFARE, [miles, quarter, year, o.log_pax, d.log_pax, o.fpm, d.fpm]);
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
          caveat: "Average fare for this airport pair and season, learned from U.S. DOT airfare reports. Live ticket prices vary by day and seat.",
        };
      }
    }
  return best;
}

export function modelCard() {
  const card = (m: PriceModelFile) => ({ name: m.name, version: m.version, metrics: m.metrics, data: m.data, parity: m.parity_max_abs_diff });
  return { rideshare: card(RIDESHARE), airfare: card(AIRFARE) };
}
