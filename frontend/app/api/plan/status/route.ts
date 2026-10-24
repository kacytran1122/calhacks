import { loadState, travelerForTripToken } from "@smile/core";
import { NextResponse } from "next/server";
import { ensureState } from "@/lib/server";

export const dynamic = "force-dynamic";

/** What an anonymous traveler can see with their trip token: their trip and the questions waiting for them. */
export async function POST(req: Request) {
  ensureState();
  const { tripId, tripToken } = (await req.json()) as { tripId: string; tripToken: string };
  if (!travelerForTripToken(tripToken, tripId)) return NextResponse.json({ error: "this approval link is invalid or expired" }, { status: 403 });
  const s = loadState();
  const trip = s.trips.find((t) => t.id === tripId);
  if (!trip) return NextResponse.json({ error: "no such trip" }, { status: 404 });
  return NextResponse.json({
    trip: { id: trip.id, state: trip.state, mode: trip.mode, quoteCents: trip.quoteCents, distanceMiles: trip.distanceMiles },
    event: s.events.find((e) => e.id === trip.eventId),
    questions: s.inbox.filter((i) => i.tripId === tripId && i.status === "open" && i.askedOf === "traveler"),
  });
}
