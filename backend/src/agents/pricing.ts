import { haversineMiles } from "../integrations/geo";
import { planDrivingRoutes } from "../integrations/osrm";
import { dayBefore, liveGoogleFlightQuote, type LiveFlightQuote } from "../integrations/googleFlights";
import { estimateAirfare, estimateRideshare, modelCard, type AirfareEstimate, type RideshareEstimate } from "../ml/price";
import type { Actor } from "../types";
import type { AgentCall } from "./run";

type Point = { lat: number; lon: number };

export interface PriceEstimate {
  scope: { eligible: boolean; fromState: string | null; toState: string | null; reason: string };
  rideshare: RideshareEstimate | null;
  airfare: AirfareEstimate | null;
  drive: { status: string; source: string; miles: number; minutes: number };
  models: ReturnType<typeof modelCard>;
}

export interface FlightPriceCheck {
  live: LiveFlightQuote;
  prediction: AirfareEstimate;
  signal: "below_prediction" | "within_prediction" | "above_prediction" | "unavailable";
  differencePct: number | null;
}

/**
 * Predicted price ranges for fluctuating transport (rideshare, flights). Estimates only:
 * the approvable trip price still comes from a live, quoted fare.
 */
export async function estimatePrices(args: { from: Point; to: Point; startsAt: string; timeZone?: string; fromState?: string; toState?: string }): Promise<PriceEstimate> {
  const fromState = args.fromState?.trim().toUpperCase() ?? null;
  const toState = args.toState?.trim().toUpperCase() ?? null;
  const eligible = Boolean(fromState && toState && /^[A-Z]{2}$/.test(fromState) && /^[A-Z]{2}$/.test(toState) && fromState !== toState);
  const scope = {
    eligible,
    fromState,
    toState,
    reason: eligible
      ? `Domestic interstate trip from ${fromState} to ${toState}.`
      : fromState && toState && fromState === toState
        ? `Price forecasting is not shown because this trip stays within ${fromState}.`
        : "Price forecasting is not shown because both U.S. states could not be verified.",
  };
  if (!eligible) return { scope, rideshare: null, airfare: null, drive: { status: "not_run", source: "interstate-only price policy", miles: 0, minutes: 0 }, models: modelCard() };
  // Rideshare is priced on the real road distance and time (live OSRM), not a straight line.
  const drive = await planDrivingRoutes({ from: args.from, to: args.to });
  const road = drive.routes[0];
  const miles = road?.distanceMiles ?? Math.round(haversineMiles(args.from, args.to) * 1.3 * 10) / 10;
  const minutes = road?.durationMinutes ?? Math.round((miles / 35) * 60);
  return {
    scope,
    rideshare: miles <= 150 ? estimateRideshare({ miles, minutes, arriveBy: args.startsAt, timeZone: args.timeZone }) : null,
    airfare: estimateAirfare({ from: args.from, to: args.to, when: args.startsAt }),
    drive: { status: drive.status, source: road ? "OSRM live road route" : "straight-line distance × 1.3 (road route unavailable)", miles, minutes },
    models: modelCard(),
  };
}

export async function checkFlightPrice(args: { from: Point; to: Point; startsAt: string; fromState?: string; toState?: string; sourceUrl?: string; timeoutMs?: number }): Promise<FlightPriceCheck | null> {
  const fromState = args.fromState?.trim().toUpperCase();
  const toState = args.toState?.trim().toUpperCase();
  if (!fromState || !toState || fromState === toState || !/^[A-Z]{2}$/.test(fromState) || !/^[A-Z]{2}$/.test(toState)) return null;
  const prediction = estimateAirfare({ from: args.from, to: args.to, when: args.startsAt });
  if (!prediction) return null;
  const live = await liveGoogleFlightQuote({
    fromAirport: prediction.from.code,
    toAirport: prediction.to.code,
    departDate: dayBefore(args.startsAt),
    sourceUrl: args.sourceUrl,
    timeoutMs: args.timeoutMs,
  });
  if (live.status !== "ok" || live.amountUsd === undefined) return { live, prediction, signal: "unavailable", differencePct: null };
  const differencePct = Math.round(((live.amountUsd - prediction.range.p50) / prediction.range.p50) * 100);
  const signal = live.amountUsd < prediction.range.p10 ? "below_prediction" : live.amountUsd > prediction.range.p90 ? "above_prediction" : "within_prediction";
  return { live, prediction, signal, differencePct };
}

const usd = (v: number) => `$${v.toFixed(2)}`;

/** The registered call: pricing reads the road network and runs the trained models. */
export function pricingCall(subject: string, on?: { actor: Actor; cap: "price.estimate" }): AgentCall<PriceEstimate> {
  return {
    agent: "pricing",
    needs: ["feeds.read", "model.predict"],
    action: "pricing.estimated",
    subject,
    on,
    summarize: (p) =>
      [
        p.scope.eligible ? `${p.drive.miles} mi by road` : p.scope.reason,
        p.rideshare ? `rideshare p50 ${usd(Math.min(p.rideshare.uber.p50, p.rideshare.lyft.p50))}` : "no rideshare estimate",
        p.airfare ? `flight ${p.airfare.from.code}→${p.airfare.to.code} p50 ${usd(p.airfare.range.p50)}` : "no flight estimate",
      ].join("; "),
  };
}

export function flightPriceCall(subject: string, on?: { actor: Actor; cap: "price.estimate" }): AgentCall<FlightPriceCheck | null> {
  return {
    agent: "pricing",
    needs: ["web.read", "feeds.read", "model.predict"],
    action: "pricing.flight.checked",
    subject,
    on,
    summarize: (out) => !out ? "flight comparison outside scope" : out.live.amountUsd === undefined ? `Google Flights ${out.live.status}; trained forecast ${usd(out.prediction.range.p50)}` : `Google Flights ${usd(out.live.amountUsd)}; trained forecast ${usd(out.prediction.range.p50)}; ${out.signal.replace(/_/g, " ")}`,
    refs: (out) => out ? [out.live.sourceUrl] : [],
  };
}
