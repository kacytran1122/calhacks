import { NextResponse } from "next/server";
import { handleMessage, resetRoom, view } from "@/lib/chat";
import { fail } from "@/lib/server";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const chatIdOf = (v: string | null | undefined) => (v && /^[\w-]{1,40}$/.test(v) ? v : "davis-gg-hack");

export async function GET(req: Request) {
  return NextResponse.json(view(chatIdOf(new URL(req.url).searchParams.get("chatId"))));
}

export async function POST(req: Request) {
  const b = (await req.json()) as { chatId?: string; from?: string; text?: string };
  if (!b.text?.trim()) return NextResponse.json({ error: "empty message" }, { status: 400 });
  try {
    const chatId = chatIdOf(b.chatId);
    const { approvals } = await handleMessage(chatId, b.from ?? "Guest", b.text);
    return NextResponse.json({ ...view(chatId), approvals });
  } catch (e) {
    return fail(e);
  }
}

export async function DELETE(req: Request) {
  const chatId = chatIdOf(new URL(req.url).searchParams.get("chatId"));
  resetRoom(chatId);
  return NextResponse.json(view(chatId));
}
