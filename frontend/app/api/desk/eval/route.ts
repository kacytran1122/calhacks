import { runEval } from "@smile/core";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await runEval());
}
