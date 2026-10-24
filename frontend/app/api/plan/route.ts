import { buddiesFor, issueTripToken, planTrip, TravelConstraintsPlanSchema, withState, type LensHints, type PickedEvent } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState, fail } from "@/lib/server";

export const maxDuration = 300;

export async function POST(req: Request) {
  ensureState();
  const b = (await req.json()) as { zip: string; originText?: string; originCoordinates?: { lat: number; lon: number }; eventUrl?: string; hints?: LensHints; initials?: string; event?: PickedEvent; travelerBudgetCents?: number; maxDistanceMiles?: number; includeSelfDrive?: boolean; travelConstraints?: unknown };
  if (!/^\d{5}$/.test(b.zip ?? "")) return NextResponse.json({ error: "ZIP must be 5 digits" }, { status: 400 });
  if (b.eventUrl && !/^https?:\/\//.test(b.eventUrl)) return NextResponse.json({ error: "event URL must be http(s)" }, { status: 400 });
  if (b.event && !(b.event.key && b.event.name && b.event.startsAt)) return NextResponse.json({ error: "picked event needs key, name and startsAt" }, { status: 400 });
  if (b.originText !== undefined && (typeof b.originText !== "string" || b.originText.trim().length < 2 || b.originText.length > 120)) return NextResponse.json({ error: "starting location must be between 2 and 120 characters" }, { status: 400 });
  if (b.originCoordinates !== undefined && (!Number.isFinite(b.originCoordinates.lat) || !Number.isFinite(b.originCoordinates.lon) || b.originCoordinates.lat < -90 || b.originCoordinates.lat > 90 || b.originCoordinates.lon < -180 || b.originCoordinates.lon > 180)) return NextResponse.json({ error: "starting coordinates are invalid" }, { status: 400 });
  if (b.travelerBudgetCents !== undefined && (!Number.isInteger(b.travelerBudgetCents) || b.travelerBudgetCents < 0 || b.travelerBudgetCents > 1_000_000)) return NextResponse.json({ error: "travel budget must be between $0 and $10,000" }, { status: 400 });
  if (b.maxDistanceMiles !== undefined && (!Number.isFinite(b.maxDistanceMiles) || b.maxDistanceMiles < 1 || b.maxDistanceMiles > 3_000)) return NextResponse.json({ error: "maximum distance must be between 1 and 3,000 miles" }, { status: 400 });
  if (b.includeSelfDrive !== undefined && typeof b.includeSelfDrive !== "boolean") return NextResponse.json({ error: "includeSelfDrive must be true or false" }, { status: 400 });
  const travelConstraints = b.travelConstraints === undefined ? undefined : TravelConstraintsPlanSchema.safeParse(b.travelConstraints);
  if (travelConstraints && !travelConstraints.success) return NextResponse.json({ error: "travel requirements were not understood" }, { status: 400 });
  const initials = b.initials?.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || undefined;
  try {
    const out = await withState(async (s) => {
      const r = await planTrip(s, { ...b, initials, travelConstraints: travelConstraints?.data });
      return { ...r, buddies: buddiesFor(s, r.trip.id) };
    });
    return NextResponse.json({ ...out, approvalToken: issueTripToken(out.trip.id, out.trip.travelerId) });
  } catch (e) {
    return fail(e);
  }
}
