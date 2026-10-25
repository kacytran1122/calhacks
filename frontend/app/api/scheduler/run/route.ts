import { timingSafeEqual } from "node:crypto";
import { appendAudit, JOBS, runDue, withState, type JobId } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { ensureState, fail } from "@/lib/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** A cron service can wake the scheduler with `Authorization: Bearer $CRON_SECRET`. */
function fromCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || secret.length < 16 || got.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(secret));
}

async function run(only?: JobId[]) {
  return NextResponse.json({ results: await runDue({}, only) });
}

/** Cron wake-up: run whatever is due. */
export async function GET(req: Request) {
  if (!fromCron(req)) return NextResponse.json({ error: "cron secret required" }, { status: 401 });
  ensureState();
  try {
    return await run();
  } catch (e) {
    return fail(e);
  }
}

/** Staff wake-up from the Desk: run the named jobs now, or whatever is due. */
export async function POST(req: Request) {
  const cron = fromCron(req);
  const user = cron ? null : await requireUser(["controller", "organizer"]);
  if (isResponse(user)) return user;
  ensureState();
  const { jobs } = (await req.json().catch(() => ({}))) as { jobs?: unknown };
  const only = Array.isArray(jobs) ? jobs.filter((j): j is JobId => typeof j === "string" && j in JOBS) : undefined;
  try {
    if (user) await withState((s) => void appendAudit(s, { actor: { kind: "human", id: user.personId, role: user.role }, action: "scheduler.requested", subject: "scheduler", reason: `${user.name} woke the scheduler${only?.length ? ` for ${only.join(", ")}` : ""}` }));
    return await run(only?.length ? only : undefined);
  } catch (e) {
    return fail(e);
  }
}
