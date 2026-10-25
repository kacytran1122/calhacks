import { reviewTravelConstraints } from "@smile/core";
import { NextResponse } from "next/server";

export const maxDuration = 30;

export async function POST(req: Request) {
  const body = (await req.json()) as { text?: string; origin?: string; eventName?: string; eventCity?: string; eventStartsAt?: string };
  const text = body.text?.trim() ?? "";
  if (!text || text.length > 5_000) return NextResponse.json({ error: "Travel requirements must be between 1 and 5,000 characters." }, { status: 400 });
  return NextResponse.json(await reviewTravelConstraints({ ...body, text }));
}
