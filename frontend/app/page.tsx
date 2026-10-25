import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = { alternates: { canonical: "/landing" } };

const LEGACY_LOCATION_KEYS = ["zip", "origin", "gps", "lat", "lon"] as const;

export default async function RootRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const incoming = await searchParams;
  const legacyLocation = new URLSearchParams();
  for (const key of LEGACY_LOCATION_KEYS) {
    const value = incoming[key];
    if (typeof value === "string") legacyLocation.set(key, value);
  }
  const query = legacyLocation.toString();
  redirect(query ? `/landing?${query}` : "/landing");
}
