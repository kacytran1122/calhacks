import type { Metadata } from "next";
import { PublicPlanner } from "../DeskClient";
import "../desk.css";

export const metadata: Metadata = { title: "Plan a trip · S’mile" };
export const dynamic = "force-dynamic";

export default async function Plan({ searchParams }: { searchParams: Promise<{ zip?: string }> }) {
  const { zip } = await searchParams;
  return <PublicPlanner initialZip={zip && /^\d{5}$/.test(zip) ? zip : ""} />;
}
