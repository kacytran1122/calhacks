import { auditorChallenge, defend, loadState } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { ensureState, fail } from "@/lib/server";

export const maxDuration = 180;

/** Claude plays the external auditor: picks the decision it trusts least and questions it. */
export async function POST() {
  const user = await requireUser(["controller", "organizer"]);
  if (isResponse(user)) return user;
  ensureState();
  try {
    const s = loadState();
    const challenge = await auditorChallenge(s);
    if (!challenge) return NextResponse.json({ error: "Auditor needs ANTHROPIC_API_KEY and at least one decision (run the pass first)." }, { status: 400 });
    const defense = await defend(s, challenge.tripId, challenge.question);
    return NextResponse.json({ challenge, defense });
  } catch (e) {
    return fail(e);
  }
}
