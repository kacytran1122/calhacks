import { buildSeed, saveState } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";

/** Demo-only: replace the books with the seed. Controller only. */
export async function POST() {
  const user = await requireUser(["controller"]);
  if (isResponse(user)) return user;
  saveState(buildSeed().state);
  return NextResponse.json({ ok: true });
}
