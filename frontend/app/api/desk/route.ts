import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { snapshot } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser();
  if (isResponse(user)) return user;
  return NextResponse.json(snapshot(user));
}
