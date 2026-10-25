import { compareCarbon, estimateCarbon, type CarbonComparison, type CarbonContext } from "../carbon";
import { fmt } from "../money";
import { capFor, POLICY } from "../../hyphenate/policy";
import type { State } from "../store";
import type { Cents, Trip } from "../types";

export interface RouteOption {
  mode: Trip["mode"];
  costCents: Cents;
  costSource: string;
  pMiss: number;
  history: { trips: number; late: number };
  withinCap: boolean;
  withinBudget: boolean;
  co2eKg?: number; // per traveler
  co2eFormula?: string;
  minutes?: number; // door-to-door, when a live route gave one
  minutesSource?: string;
}

export type RouteBlockReason = "TRAVELER_BUDGET" | "ORGANIZER_CAP" | "MAX_DISTANCE" | "NO_VERIFIED_FARE";

export interface RouteContext extends Omit<CarbonContext, "straightMiles"> {
  minutes?: Partial<Record<Trip["mode"], { minutes: number; source: string }>>;
}

export function missRate(state: State, mode: Trip["mode"]) {
  const hist = state.trips.filter((t) => t.mode === mode && t.arrivalMarginMin !== undefined);
  const late = hist.filter((t) => (t.arrivalMarginMin ?? 0) < 0).length;
  return { p: (late + 1) / (hist.length + 2), trips: hist.length, late };
}

const LOW_CARBON_MODES: Trip["mode"][] = ["train", "bus"];

/**
 * R13: swap the cheapest pick for a train or bus when the extra cost and time are small and it is
 * about as reliable. Both travel times must be known; an unknown time is never assumed short.
 */
function lowCarbonSwap(pick: RouteOption, ok: RouteOption[]): { option: RouteOption; reason: string } | null {
  if (LOW_CARBON_MODES.includes(pick.mode) || pick.co2eKg === undefined || pick.minutes === undefined) return null;
  const L = POLICY.lowCarbon;
  const fits = ok.filter(
    (o) =>
      LOW_CARBON_MODES.includes(o.mode) &&
      o.co2eKg !== undefined &&
      o.co2eKg < pick.co2eKg! &&
      o.minutes !== undefined &&
      o.costCents - pick.costCents <= Math.max(L.extraCents, pick.costCents * L.extraPct) &&
      o.minutes - pick.minutes! <= Math.max(L.extraMinutes, pick.minutes! * L.extraTimePct) &&
      o.pMiss <= pick.pMiss + L.extraMissRisk,
  );
  const best = fits.sort((a, b) => a.co2eKg! - b.co2eKg! || a.costCents - b.costCents)[0];
  if (!best) return null;
  const extra = best.costCents - pick.costCents;
  const slower = best.minutes! - pick.minutes!;
  return {
    option: best,
    reason: `R13: the ${best.mode} ${extra > 0 ? `costs ${fmt(extra)} more` : extra < 0 ? `costs ${fmt(-extra)} less` : "costs the same"} and ${slower > 0 ? `takes ${slower} min longer` : slower < 0 ? `is ${-slower} min faster` : "takes as long"} than ${pick.mode === "drive" ? "driving" : `the ${pick.mode}`}, and emits ${Math.round((pick.co2eKg! - best.co2eKg!) * 10) / 10} kg less CO₂e per traveler.`,
  };
}

export function compareRoutes(
  state: State,
  args: { miles: number; fares: { mode: string; amountUsd: number }[]; fareEvidenceId?: string; travelerBudgetCents?: Cents; maxDistanceMiles?: number; includeSelfDrive?: boolean; deadlineCritical?: boolean; context?: RouteContext },
): { options: RouteOption[]; pick?: RouteOption; pickReason?: string; fastest?: Trip["mode"]; lowestCarbon?: Trip["mode"]; carbon: CarbonComparison; cap: Cents; travelerBudgetCents?: Cents; maxDistanceMiles?: number; blockReason?: RouteBlockReason } {
  const cap = capFor(args.miles);
  const ctx: CarbonContext = { straightMiles: args.miles, ...args.context };
  const withinBudget = (costCents: Cents) => args.travelerBudgetCents === undefined || costCents <= args.travelerBudgetCents;
  const extras = (mode: Trip["mode"]) => {
    const c = estimateCarbon(mode, ctx);
    const t = args.context?.minutes?.[mode];
    return { co2eKg: c?.kg, co2eFormula: c?.formula, minutes: t?.minutes, minutesSource: t?.source };
  };
  const options: RouteOption[] = [];
  const seen = new Set<string>();
  for (const f of [...args.fares].sort((a, b) => a.amountUsd - b.amountUsd)) {
    const mode = (["train", "bus", "rideshare", "flight"].includes(f.mode) ? f.mode : "train") as Trip["mode"];
    if (seen.has(mode)) continue;
    seen.add(mode);
    const m = missRate(state, mode);
    const costCents = Math.round(f.amountUsd * 100);
    options.push({ mode, costCents, costSource: args.fareEvidenceId ?? "web", pMiss: m.p, history: { trips: m.trips, late: m.late }, withinCap: costCents <= cap, withinBudget: withinBudget(costCents), ...extras(mode) });
  }
  if (args.includeSelfDrive !== false) {
    const drive = missRate(state, "drive");
    const driveCost = Math.round(args.miles * POLICY.irsMileageCentsPerMile);
    options.push({ mode: "drive", costCents: driveCost, costSource: "IRS mileage rate × distance", pMiss: drive.p, history: { trips: drive.trips, late: drive.late }, withinCap: driveCost <= cap, withinBudget: withinBudget(driveCost), ...extras("drive") });
  }

  const overDistance = args.maxDistanceMiles !== undefined && args.miles > args.maxDistanceMiles;
  const ok = overDistance ? [] : options.filter((o) => o.withinCap && o.withinBudget);
  let pick = args.deadlineCritical
    ? [...ok].sort((a, b) => a.pMiss - b.pMiss || a.costCents - b.costCents)[0]
    : [...ok].filter((o) => o.pMiss <= 0.25).sort((a, b) => a.costCents - b.costCents)[0] ?? [...ok].sort((a, b) => a.pMiss - b.pMiss)[0];
  let pickReason = pick
    ? args.deadlineCritical
      ? "Lowest chance of missing your arrival time, then lowest cost."
      : pick.pMiss <= 0.25
        ? "Cheapest option within the organizer cap and your budget with at most a 25% late risk."
        : "Most reliable option within the organizer cap and your budget."
    : undefined;
  // A deadline outranks emissions: R13 only applies when the traveler has no arrival constraint.
  const swap = pick && !args.deadlineCritical ? lowCarbonSwap(pick, ok) : null;
  if (swap) {
    pick = swap.option;
    pickReason = swap.reason;
  }
  // "Fastest" compares every grounded route, including a flight whose live fare is
  // still pending. Price verification controls approval, not whether an alternative
  // may be shown to the traveler.
  const timed = Object.entries(args.context?.minutes ?? {})
    .filter((entry): entry is [Trip["mode"], { minutes: number; source: string }] => Number.isFinite(entry[1]?.minutes))
    .map(([mode, timing]) => ({ mode, ...timing }));
  const fastest = timed.length > 1 ? timed.sort((a, b) => a.minutes - b.minutes)[0]?.mode : undefined;
  const rated = options.filter((o) => o.co2eKg !== undefined);
  const lowestCarbon = rated.length > 1 ? rated.sort((a, b) => a.co2eKg! - b.co2eKg!)[0]?.mode : undefined;
  const blockReason = pick
    ? undefined
    : overDistance
      ? "MAX_DISTANCE"
      : options.length === 0
        ? "NO_VERIFIED_FARE"
      : options.some((o) => o.withinCap && !o.withinBudget)
        ? "TRAVELER_BUDGET"
        : "ORGANIZER_CAP";
  return { options, pick, pickReason, fastest, lowestCarbon, carbon: compareCarbon(ctx), cap, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, blockReason };
}
