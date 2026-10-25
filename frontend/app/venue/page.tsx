import type { Metadata } from "next";
import { VenueClient } from "./VenueClient";
import "./venue.css";
export const metadata: Metadata = {
    title: "Cal Hacks 3D tour · S’mile",
    description: "Explore a conceptual 3D preview of the Palace of Fine Arts main floor for Cal Hacks 13.0, with searchable places and guided virtual walks.",
};
export default function Venue() {
    return <VenueClient />;
}
