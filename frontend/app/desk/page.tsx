import type { Metadata } from "next";
import { DeskClient } from "./DeskClient";
import "./desk.css";

export const metadata: Metadata = { title: "S’mile Desk · Golden Gate Hack travel grants" };
export const dynamic = "force-dynamic";

export default async function Desk({ searchParams }: { searchParams: Promise<{ zip?: string }> }) {
  const { zip } = await searchParams;
  return <DeskClient initialZip={zip && /^\d{5}$/.test(zip) ? zip : ""} />;
}
