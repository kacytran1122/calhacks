import { estimateAirfare, estimateRideshare, haversineMiles, modelCard, planDrivingRoutes } from "@smile/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Point = { lat: number; lon: number };
const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null && Number.isFinite((p as Point).lat) && Number.isFinite((p as Point).lon) && Math.abs((p as Point).lat) <= 90 && Math.abs((p as Point).lon) <= 180;

/**
 * Predicted price ranges for fluctuating transport (rideshare, flights). Estimates only:
 * the approvable trip price still comes from a live, quoted fare.
 */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; startsAt?: string; timeZone?: string };
  if (!isPoint(b.from) || !isPoint(b.to)) return NextResponse.json({ error: "from and to need lat and lon" }, { status: 400 });
  if (!b.startsAt || Number.isNaN(new Date(b.startsAt).getTime())) return NextResponse.json({ error: "startsAt must be a date" }, { status: 400 });
  const timeZone = b.timeZone && /^[A-Za-z_]+\/[A-Za-z_\/]+$/.test(b.timeZone) ? b.timeZone : undefined;

  // Rideshare is priced on the real road distance and time (live OSRM), not a straight line.
  const drive = await planDrivingRoutes({ from: b.from, to: b.to });
  const road = drive.routes[0];
  const miles = road?.distanceMiles ?? Math.round(haversineMiles(b.from, b.to) * 1.3 * 10) / 10;
  const minutes = road?.durationMinutes ?? Math.round((miles / 35) * 60);
  const rideshare = miles <= 150 ? estimateRideshare({ miles, minutes, arriveBy: b.startsAt, timeZone }) : null;
  const airfare = estimateAirfare({ from: b.from, to: b.to, when: b.startsAt });

  return NextResponse.json({
    rideshare,
    airfare,
    drive: { status: drive.status, source: road ? "OSRM live road route" : "straight-line distance × 1.3 (road route unavailable)", miles, minutes },
    models: modelCard(),
  });
}
