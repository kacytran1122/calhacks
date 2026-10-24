import type { Metadata } from "next";
import { FindClient } from "./FindClient";
import "../desk/desk.css";
import "./find.css";

export const metadata: Metadata = { title: "Find events · S’mile" };
export const dynamic = "force-dynamic";

export default async function Find({ searchParams }: { searchParams: Promise<{ zip?: string }> }) {
  const { zip } = await searchParams;
  return <FindClient initialZip={zip && /^\d{5}$/.test(zip) ? zip : ""} />;
}
