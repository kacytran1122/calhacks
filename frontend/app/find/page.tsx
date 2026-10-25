import type { Metadata } from "next";
import { LegacyFindRedirect } from "@/components/travel/LegacyFindRedirect";
import "../desk/desk.css";
import "./find.css";

export const metadata: Metadata = { title: "Find events · S’mile", alternates: { canonical: "/" } };
export const dynamic = "force-dynamic";

export default function Find() {
  return <LegacyFindRedirect />;
}
