import type { Metadata } from "next";
import { VenueClient } from "./VenueClient";
import "./venue.css";

export const metadata: Metadata = {
  title: "Cal Hacks 13.0 venue walk-through · S’mile",
  description: "Walk the Palace of Fine Arts main floor at eye level and get walked to any sponsor booth, stage or service.",
};

export default function Venue() {
  return <VenueClient />;
}
