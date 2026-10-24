import { loadState, traceFor } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { canSeeTrip, ensureState, fail } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ tripId: string }> }) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  ensureState();
  try {
    const s = loadState();
    const { tripId } = await ctx.params;
    if (!canSeeTrip(s, user, tripId)) return NextResponse.json({ error: "not your trip" }, { status: 403 });
    return NextResponse.json(traceFor(s, tripId));
  } catch (e) {
    return fail(e);
  }
}
