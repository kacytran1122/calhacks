import "server-only";
import { userForSession, type HumanRole, type User } from "@smile/core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

export const SESSION_COOKIE = "smile_session";

export async function currentUser(): Promise<User | null> {
  return userForSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(roles?: HumanRole[]): Promise<User | NextResponse> {
  const u = await currentUser();
  if (!u) return NextResponse.json({ error: "sign in first" }, { status: 401 });
  if (roles && !roles.includes(u.role)) return NextResponse.json({ error: `this needs the ${roles.join(" or ")} role; you are signed in as ${u.role}` }, { status: 403 });
  return u;
}

export const isResponse = (x: unknown): x is NextResponse => x instanceof NextResponse;
