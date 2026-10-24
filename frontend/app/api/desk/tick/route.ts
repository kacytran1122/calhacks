import { appendAudit, tick, withState } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { ensureState, fail } from "@/lib/server";

export const maxDuration = 300;

export async function POST(req: Request) {
  const user = await requireUser(["controller", "organizer"]);
  if (isResponse(user)) return user;
  ensureState();
  const { explainWithClaude = false } = (await req.json().catch(() => ({}))) as { explainWithClaude?: boolean };
  try {
    const done = await withState(async (s) => {
      appendAudit(s, { actor: { kind: "human", id: user.personId, role: user.role }, action: "tick.requested", subject: "backlog", reason: `${user.name} started a pass` });
      return tick(s, { explainWithClaude });
    });
    return NextResponse.json({ done });
  } catch (e) {
    return fail(e);
  }
}
