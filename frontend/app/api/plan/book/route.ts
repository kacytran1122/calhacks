import { bookTrip, travelerForTripToken, withState } from "@smile/core";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { ensureState, fail } from "@/lib/server";

export async function POST(req: Request) {
  ensureState();
  const { tripId, fareDeltaCents = 0, tripToken } = (await req.json()) as { tripId: string; fareDeltaCents?: number; tripToken?: string };
  const user = await currentUser();
  if (user?.role !== "controller" && !travelerForTripToken(tripToken, tripId)) return NextResponse.json({ error: "only this trip's traveler or the controller can book it" }, { status: 403 });
  try {
    return NextResponse.json(await withState((s) => bookTrip(s, tripId, fareDeltaCents)));
  } catch (e) {
    return fail(e);
  }
}
