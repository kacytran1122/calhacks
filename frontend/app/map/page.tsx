import type { Metadata } from "next";
import { MapClient } from "./MapClient";

export const metadata: Metadata = {
  title: "Route guidance",
  description: "GPS route guidance with walking, transit, driving, airport, and flight legs.",
  alternates: { canonical: "/map" },
};

export default function MapPage() {
  return (
    <>
      <link rel="stylesheet" href="/map-assets/leaflet.css" />
      <link rel="stylesheet" href="/map-assets/map.css?v=5" />
      <MapClient />
    </>
  );
}
