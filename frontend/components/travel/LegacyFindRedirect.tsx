"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { legacyTravelOrigin, rememberTravelOrigin } from "@/lib/travelSession";

export function LegacyFindRedirect() {
  const router = useRouter();
  return <LegacyFindMigration onNavigate={router.replace} />;
}

export function LegacyFindMigration({ onNavigate }: { onNavigate: (href: string) => void }) {
  useEffect(() => {
    const origin = legacyTravelOrigin(new URLSearchParams(window.location.search));
    if (origin) rememberTravelOrigin(origin);
    window.history.replaceState(window.history.state, "", "/find");
    onNavigate("/");
  }, [onNavigate]);
  return <main className="dk"><p role="status">Opening your trip planner…</p><a href="/">Continue to S’mile</a></main>;
}
