import { AIRFARE, checkFlightPrice, flightPriceCall, runAgent } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState, fail } from "@/lib/server";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

type Point = { lat: number; lon: number };
const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null && Number.isFinite((p as Point).lat) && Number.isFinite((p as Point).lon) && Math.abs((p as Point).lat) <= 90 && Math.abs((p as Point).lon) <= 180;

export async function POST(req: Request) {
  const payload = await req.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return NextResponse.json({ error: "A JSON object is required" }, { status: 400 });
  const b = payload as { from?: unknown; to?: unknown; startsAt?: string; fromState?: string; toState?: string; fromAirport?: string; toAirport?: string; departDate?: string; sourceUrl?: string; snapshotId?: string };
  if (!isPoint(b.from) || !isPoint(b.to)) return NextResponse.json({ error: "from and to need lat and lon" }, { status: 400 });
  if (typeof b.startsAt !== "string" || !b.startsAt || Number.isNaN(new Date(b.startsAt).getTime())) return NextResponse.json({ error: "startsAt must be a date" }, { status: 400 });
  if ((b.fromState !== undefined && typeof b.fromState !== "string") || (b.toState !== undefined && typeof b.toState !== "string")) return NextResponse.json({ error: "State codes must be strings" }, { status: 400 });
  if (b.departDate !== undefined) {
    const parsed = new Date(`${b.departDate}T12:00:00Z`);
    if (typeof b.departDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.departDate) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== b.departDate) return NextResponse.json({ error: "departDate must be a valid calendar date in YYYY-MM-DD format" }, { status: 400 });
  }
  const fromAirport = typeof b.fromAirport === "string" ? b.fromAirport.trim().toUpperCase() : undefined;
  const toAirport = typeof b.toAirport === "string" ? b.toAirport.trim().toUpperCase() : undefined;
  if ((b.fromAirport !== undefined || b.toAirport !== undefined) && (!fromAirport || !toAirport || fromAirport === toAirport || !AIRFARE.airports.some((a) => a.code === fromAirport) || !AIRFARE.airports.some((a) => a.code === toAirport))) return NextResponse.json({ error: "fromAirport and toAirport must be distinct IATA airport codes supported by the U.S. fare model" }, { status: 400 });
  let sourceUrl: string | undefined;
  if (b.sourceUrl) {
    try {
      const parsed = new URL(b.sourceUrl);
      if (!/(^|\.)google\.com$/.test(parsed.hostname) || !parsed.pathname.startsWith("/travel/flights")) throw new Error();
      sourceUrl = parsed.toString();
    } catch {
      return NextResponse.json({ error: "sourceUrl must be a Google Flights URL" }, { status: 400 });
    }
  }
  if (b.snapshotId && !/^s(?:d)?_[A-Za-z0-9]+$/.test(b.snapshotId)) return NextResponse.json({ error: "snapshotId is invalid" }, { status: 400 });
  ensureState();
  try {
    const args = { from: b.from, to: b.to, startsAt: b.startsAt, fromState: b.fromState, toState: b.toState, fromAirport, toAirport, departDate: b.departDate, sourceUrl, snapshotId: b.snapshotId, timeoutMs: b.snapshotId ? 30_000 : 4_500 };
    const result = await runAgent(flightPriceCall(`flight:${b.from.lat.toFixed(1)},${b.from.lon.toFixed(1)}:${b.to.lat.toFixed(1)},${b.to.lon.toFixed(1)}`), () => checkFlightPrice(args));
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
