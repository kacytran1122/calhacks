import { haversineMiles } from "../integrations/geo";
import { planDrivingRoutes } from "../integrations/osrm";
import { estimateAirfare, estimateRideshare, modelCard, type AirfareEstimate, type RideshareEstimate } from "../ml/price";
import type { Actor } from "../types";
import type { AgentCall } from "./run";

type Point = { lat: number; lon: number };

export interface PriceEstimate {
  rideshare: RideshareEstimate | null;
  airfare: AirfareEstimate | null;
  drive: { status: string; source: string; miles: number; minutes: number };
  models: ReturnType<typeof modelCard>;
}

/**
 * Predicted price ranges for fluctuating transport (rideshare, flights). Estimates only:
 * the approvable trip price still comes from a live, quoted fare.
 */
export async function estimatePrices(args: { from: Point; to: Point; startsAt: string; timeZone?: string }): Promise<PriceEstimate> {
  // Rideshare is priced on the real road distance and time (live OSRM), not a straight line.
  const drive = await planDrivingRoutes({ from: args.from, to: args.to });
  const road = drive.routes[0];
  const miles = road?.distanceMiles ?? Math.round(haversineMiles(args.from, args.to) * 1.3 * 10) / 10;
  const minutes = road?.durationMinutes ?? Math.round((miles / 35) * 60);
  return {
    rideshare: miles <= 150 ? estimateRideshare({ miles, minutes, arriveBy: args.startsAt, timeZone: args.timeZone }) : null,
    airfare: estimateAirfare({ from: args.from, to: args.to, when: args.startsAt }),
    drive: { status: drive.status, source: road ? "OSRM live road route" : "straight-line distance × 1.3 (road route unavailable)", miles, minutes },
    models: modelCard(),
  };
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
        `${p.drive.miles} mi by road`,
        p.rideshare ? `rideshare p50 ${usd(Math.min(p.rideshare.uber.p50, p.rideshare.lyft.p50))}` : "no rideshare estimate",
        p.airfare ? `flight ${p.airfare.from.code}→${p.airfare.to.code} p50 ${usd(p.airfare.range.p50)}` : "no flight estimate",
      ].join("; "),
  };
}
