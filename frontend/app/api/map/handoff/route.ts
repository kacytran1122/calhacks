import { loadState, PhotonHandoffStorageUnavailable, resolvePhotonMapHandoff } from "@smile/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "private, no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
};

const unavailable = () => NextResponse.json(
  { error: "This secure map link is invalid or expired." },
  { status: 404, headers },
);

/**
 * Validated bootstrap for `/map?handoff=<opaque>`.
 * The opaque bearer is exchanged for only the route fields the map needs;
 * traveler IDs and the original trip token never reach the browser.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const tokens = url.searchParams.getAll("token");
  if (tokens.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "token")) return unavailable();

  try {
    const handoff = resolvePhotonMapHandoff(tokens[0]);
    if (!handoff) return unavailable();
    const state = loadState();
    const trip = state.trips.find((candidate) => candidate.id === handoff.tripId && candidate.travelerId === handoff.travelerId);
    const traveler = trip && state.travelers.find((candidate) => candidate.id === trip.travelerId);
    const event = trip && state.events.find((candidate) => candidate.id === trip.eventId);
    if (!trip || !traveler || !event) return unavailable();

    const destinationQuery = [event.venue, event.city].filter(Boolean).join(", ");
    return NextResponse.json({
      tripId: trip.id,
      mode: trip.mode,
      origin: {
        query: traveler.homeZip,
        label: `ZIP ${traveler.homeZip}`,
      },
      destination: {
        query: destinationQuery,
        label: event.name,
        venue: event.venue,
        city: event.city,
        ...(Number.isFinite(event.lat) && Number.isFinite(event.lon) ? { lat: event.lat, lon: event.lon } : {}),
      },
      event: {
        id: event.id,
        name: event.name,
        startsAt: event.startsAt,
      },
      expiresAt: handoff.expiresAt,
    }, { headers });
  } catch (error) {
    if (error instanceof PhotonHandoffStorageUnavailable) {
      return NextResponse.json({ error: "Secure map access is temporarily unavailable." }, { status: 503, headers: { ...headers, "Retry-After": "5" } });
    }
    return NextResponse.json({ error: "Secure map access is temporarily unavailable." }, { status: 503, headers });
  }
}
