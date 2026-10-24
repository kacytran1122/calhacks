import { defend, loadState } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { canSeeTrip, ensureState, fail } from "@/lib/server";

export const maxDuration = 120;

export async function POST(req: Request) {
  const user = await requireUser();
  if (isResponse(user)) return user;
  ensureState();
  const { tripId, question } = (await req.json()) as { tripId: string; question: string };
  try {
    const s = loadState();
    if (!canSeeTrip(s, user, tripId)) return NextResponse.json({ error: "not your trip" }, { status: 403 });
    return NextResponse.json(await defend(s, tripId, question));
  } catch (e) {
    return fail(e);
  }
}
