import { login, TooManyAttempts } from "@smile/core";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST(req: Request) {
  const { id, password } = (await req.json().catch(() => ({}))) as { id?: string; password?: string };
  if (!id || !password) return NextResponse.json({ error: "sign-in name and password required" }, { status: 400 });
  try {
    const r = login(id, password);
    if (!r) return NextResponse.json({ error: "wrong sign-in name or password" }, { status: 401 });
    const res = NextResponse.json({ user: r.user });
    res.cookies.set(SESSION_COOKIE, r.token, { httpOnly: true, sameSite: "lax", path: "/", secure: process.env.NODE_ENV === "production", expires: new Date(r.expiresAt) });
    return res;
  } catch (e) {
    if (e instanceof TooManyAttempts) return NextResponse.json({ error: e.message }, { status: 429 });
    throw e;
  }
}
