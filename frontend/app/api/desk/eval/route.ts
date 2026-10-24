import { runEval } from "@smile/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Runs on a fresh in-memory copy of the seed; the live books are untouched. */
export async function GET() {
  return NextResponse.json(await runEval());
}
