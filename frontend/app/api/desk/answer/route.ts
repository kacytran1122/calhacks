import { answer, assertClaimMatches, PermissionDenied, travelerForTripToken, withState, type HumanRole } from "@smile/core";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { ensureState, fail } from "@/lib/server";

export async function POST(req: Request) {
  ensureState();
  const b = (await req.json()) as { itemId: string; option: string; note?: string; tripToken?: string; personId?: string; role?: HumanRole };
  const user = await currentUser();
  try {
    const out = await withState((s) => {
      const item = s.inbox.find((i) => i.id === b.itemId);
      if (!item) throw new Error("no such question");
      if (user) {
        assertClaimMatches(s, user, { personId: b.personId, role: b.role }, item.tripId);
        return answer(s, item.id, { id: user.personId, role: user.role }, b.option, b.note);
      }
      const traveler = travelerForTripToken(b.tripToken, item.tripId);
      if (!traveler || item.askedOf !== "traveler") throw new PermissionDenied("sign in first");
      return answer(s, item.id, { id: traveler, role: "traveler" }, b.option, b.note);
    });
    return NextResponse.json(out);
  } catch (e) {
    return fail(e);
  }
}
