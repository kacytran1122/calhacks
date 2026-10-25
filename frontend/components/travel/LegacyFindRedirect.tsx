"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { legacyTravelOrigin, rememberTravelOrigin } from "@/lib/travelSession";

export function LegacyFindRedirect() {
  const router = useRouter();
  return <LegacyFindMigration onNavigate={router.replace} />;
}

export function LegacyFindMigration({ onNavigate }: { onNavigate: (href: string) => void }) {
  const [destination, setDestination] = useState("/landing");

  useEffect(() => {
    const origin = legacyTravelOrigin(new URLSearchParams(window.location.search));
    if (origin) rememberTravelOrigin(origin);
    const landingAnchor = window.location.hash;
    const nextDestination = landingAnchor ? `/landing${landingAnchor}` : origin ? "/finding-events" : "/landing";
    setDestination(nextDestination);
    window.history.replaceState(window.history.state, "", `/find${landingAnchor}`);
    onNavigate(nextDestination);
  }, [onNavigate]);
  return <main className="dk"><p role="status">Opening your trip planner…</p><a href={destination}>Continue to S’mile</a></main>;
}
