import { logout } from "@smile/core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  logout((await cookies()).get(SESSION_COOKIE)?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
