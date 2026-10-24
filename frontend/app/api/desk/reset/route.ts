import { buildSeed, saveState } from "@smile/core";
import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";

export async function POST() {
  const user = await requireUser(["controller"]);
  if (isResponse(user)) return user;
  saveState(buildSeed().state);
  return NextResponse.json({ ok: true });
}
