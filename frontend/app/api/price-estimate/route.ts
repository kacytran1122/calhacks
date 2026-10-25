import { estimatePrices, pricingCall, runAgent } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState, fail } from "@/lib/server";

export const dynamic = "force-dynamic";

type Point = { lat: number; lon: number };
const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null && Number.isFinite((p as Point).lat) && Number.isFinite((p as Point).lon) && Math.abs((p as Point).lat) <= 90 && Math.abs((p as Point).lon) <= 180;

/** Predicted price ranges for rideshare and flights, from the Pricing agent. Estimates only. */
export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; startsAt?: string; timeZone?: string; fromState?: string; toState?: string };
  if (!isPoint(b.from) || !isPoint(b.to)) return NextResponse.json({ error: "from and to need lat and lon" }, { status: 400 });
  if (!b.startsAt || Number.isNaN(new Date(b.startsAt).getTime())) return NextResponse.json({ error: "startsAt must be a date" }, { status: 400 });
  const timeZone = b.timeZone && /^[A-Za-z_]+\/[A-Za-z_\/]+$/.test(b.timeZone) ? b.timeZone : undefined;
  const args = { from: b.from, to: b.to, startsAt: b.startsAt, timeZone, fromState: b.fromState, toState: b.toState };
  ensureState();
  try {
    // The subject is rounded to about a kilometer so the audit trail doesn't keep a precise home location.
    return NextResponse.json(await runAgent(pricingCall(`route:${b.from.lat.toFixed(2)},${b.from.lon.toFixed(2)}→${b.to.lat.toFixed(3)},${b.to.lon.toFixed(3)}`), () => estimatePrices(args)));
  } catch (e) {
    return fail(e);
  }
}
