import { checkFlightPrice, flightPriceCall, runAgent } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState, fail } from "@/lib/server";

export const dynamic = "force-dynamic";

type Point = { lat: number; lon: number };
const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null && Number.isFinite((p as Point).lat) && Number.isFinite((p as Point).lon) && Math.abs((p as Point).lat) <= 90 && Math.abs((p as Point).lon) <= 180;

export async function POST(req: Request) {
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; startsAt?: string; fromState?: string; toState?: string; sourceUrl?: string; snapshotId?: string };
  if (!isPoint(b.from) || !isPoint(b.to)) return NextResponse.json({ error: "from and to need lat and lon" }, { status: 400 });
  if (!b.startsAt || Number.isNaN(new Date(b.startsAt).getTime())) return NextResponse.json({ error: "startsAt must be a date" }, { status: 400 });
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
    const args = { from: b.from, to: b.to, startsAt: b.startsAt, fromState: b.fromState, toState: b.toState, sourceUrl, snapshotId: b.snapshotId, timeoutMs: 4_500 };
    const result = await runAgent(flightPriceCall(`flight:${b.from.lat.toFixed(1)},${b.from.lon.toFixed(1)}→${b.to.lat.toFixed(1)},${b.to.lon.toFixed(1)}`), () => checkFlightPrice(args));
    return NextResponse.json(result);
  } catch (e) {
    return fail(e);
  }
}
