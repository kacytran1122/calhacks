import { TravelExperience } from "@/components/travel/TravelExperience";
import type { Metadata } from "next";
import "../desk/desk.css";
import "../find/find.css";

export const metadata: Metadata = { alternates: { canonical: "/landing" } };

export default function LandingPage() {
  return <TravelExperience initialView="landing" />;
}
