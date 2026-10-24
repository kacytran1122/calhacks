import type { Metadata } from "next";
import { FindClient } from "./FindClient";
import "../desk/desk.css";
import "./find.css";

export const metadata: Metadata = { title: "Find events · S’mile" };
export const dynamic = "force-dynamic";

export default async function Find({ searchParams }: { searchParams: Promise<{ zip?: string; origin?: string; lat?: string; lon?: string }> }) {
  const { zip, origin, lat, lon } = await searchParams;
  const initialLat = lat === undefined ? undefined : Number(lat);
  const initialLon = lon === undefined ? undefined : Number(lon);
  return <FindClient initialZip={zip && /^\d{5}$/.test(zip) ? zip : ""} initialOrigin={origin?.slice(0, 120)} initialLat={Number.isFinite(initialLat) ? initialLat : undefined} initialLon={Number.isFinite(initialLon) ? initialLon : undefined} />;
}
