import type { Metadata } from "next";
import { TourClient } from "./TourClient";

export const metadata: Metadata = {
  title: "LA Hacks · 3D concept tour",
  description: "Explore a James West Alumni Center concept for LA Hacks. This approximate visualization is not a verified current venue layout.",
};

export default function TourPage() {
  return <TourClient />;
}
