import { TravelExperience } from "@/components/travel/TravelExperience";
import type { Metadata } from "next";
import "../desk/desk.css";
import "../find/find.css";

export const metadata: Metadata = { title: "Find events · S’mile", alternates: { canonical: "/finding-events" } };
export const dynamic = "force-dynamic";

export default function FindingEventsPage() {
  return <TravelExperience initialView="events" />;
}
