import { capFor, POLICY } from "../policy";
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
}

export type RouteBlockReason = "TRAVELER_BUDGET" | "ORGANIZER_CAP" | "MAX_DISTANCE";

export function missRate(state: State, mode: Trip["mode"]) {
  const hist = state.trips.filter((t) => t.mode === mode && t.arrivalMarginMin !== undefined);
  const late = hist.filter((t) => (t.arrivalMarginMin ?? 0) < 0).length;
  return { p: (late + 1) / (hist.length + 2), trips: hist.length, late };
}

export function compareRoutes(
  state: State,
  args: { miles: number; fares: { mode: string; amountUsd: number }[]; fareEvidenceId?: string; travelerBudgetCents?: Cents; maxDistanceMiles?: number; includeSelfDrive?: boolean; deadlineCritical?: boolean },
): { options: RouteOption[]; pick?: RouteOption; cap: Cents; travelerBudgetCents?: Cents; maxDistanceMiles?: number; blockReason?: RouteBlockReason } {
  const cap = capFor(args.miles);
  const withinBudget = (costCents: Cents) => args.travelerBudgetCents === undefined || costCents <= args.travelerBudgetCents;
  const options: RouteOption[] = [];
  const seen = new Set<string>();
  for (const f of [...args.fares].sort((a, b) => a.amountUsd - b.amountUsd)) {
    const mode = (["train", "bus", "rideshare", "flight"].includes(f.mode) ? f.mode : "train") as Trip["mode"];
    if (seen.has(mode)) continue;
    seen.add(mode);
    const m = missRate(state, mode);
    const costCents = Math.round(f.amountUsd * 100);
    options.push({ mode, costCents, costSource: args.fareEvidenceId ?? "web", pMiss: m.p, history: { trips: m.trips, late: m.late }, withinCap: costCents <= cap, withinBudget: withinBudget(costCents) });
  }
  if (args.includeSelfDrive !== false) {
    const drive = missRate(state, "drive");
    const driveCost = Math.round(args.miles * POLICY.irsMileageCentsPerMile);
    options.push({ mode: "drive", costCents: driveCost, costSource: "IRS mileage rate × distance", pMiss: drive.p, history: { trips: drive.trips, late: drive.late }, withinCap: driveCost <= cap, withinBudget: withinBudget(driveCost) });
  }

  const overDistance = args.maxDistanceMiles !== undefined && args.miles > args.maxDistanceMiles;
  const ok = overDistance ? [] : options.filter((o) => o.withinCap && o.withinBudget);
  const pick = args.deadlineCritical
    ? ok.sort((a, b) => a.pMiss - b.pMiss || a.costCents - b.costCents)[0]
    : ok.filter((o) => o.pMiss <= 0.25).sort((a, b) => a.costCents - b.costCents)[0] ?? ok.sort((a, b) => a.pMiss - b.pMiss)[0];
  const blockReason = pick
    ? undefined
    : overDistance
      ? "MAX_DISTANCE"
      : options.some((o) => o.withinCap && !o.withinBudget)
        ? "TRAVELER_BUDGET"
        : "ORGANIZER_CAP";
  return { options, pick, cap, travelerBudgetCents: args.travelerBudgetCents, maxDistanceMiles: args.maxDistanceMiles, blockReason };
}
