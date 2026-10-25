"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { FindClient } from "@/app/find/FindClient";
import { expireTravelMemory, legacyTravelOrigin, rememberTravelOrigin, restoreTravelSession, setTravelViewActive, type TravelOrigin, type TravelSession } from "@/lib/travelSession";

const TravelNavigation = createContext<((origin: TravelOrigin) => void) | null>(null);
const replaceRootDocument = (href: string) => window.location.replace(href);
const LANDING_PATH = "/landing";
const FINDING_EVENTS_PATH = "/finding-events";

export type TravelView = "landing" | "events";

export function useTravelNavigation() {
  const navigate = useContext(TravelNavigation);
  if (!navigate) throw new Error("The trip planner is unavailable. Please reload this page.");
  return navigate;
}

export function TravelHome({ children, initialView = "landing", onLegacyRootRedirect = replaceRootDocument }: { children: ReactNode; initialView?: TravelView; onLegacyRootRedirect?: (href: string) => void }) {
  const [session, setSession] = useState<TravelSession | null>(null);
  const [migrationTarget, setMigrationTarget] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const landingAnchor = window.location.hash;
    if (["zip", "origin", "gps", "lat", "lon"].some((key) => params.has(key))) {
      const imported = legacyTravelOrigin(params);
      if (imported) rememberTravelOrigin(imported);
      expireTravelMemory();
      if (landingAnchor) setTravelViewActive(false);
      const destination = landingAnchor ? `${LANDING_PATH}${landingAnchor}` : imported ? FINDING_EVENTS_PATH : LANDING_PATH;
      setMigrationTarget(destination);
      onLegacyRootRedirect(destination);
      return;
    }

    if (initialView === "events" && !landingAnchor) {
      const restored = restoreTravelSession();
      if (!restored) {
        setTravelViewActive(false);
        setMigrationTarget(LANDING_PATH);
        onLegacyRootRedirect(LANDING_PATH);
        return;
      }
      setSession(restored);
      window.history.replaceState({ ...window.history.state, smileView: "events" }, "", FINDING_EVENTS_PATH);
    } else {
      setTravelViewActive(false);
      setSession(null);
      window.history.replaceState({ ...window.history.state, smileView: "landing" }, "", `${LANDING_PATH}${landingAnchor}`);
    }

    const onPopState = () => {
      const active = !window.location.hash && window.location.pathname === FINDING_EVENTS_PATH;
      setTravelViewActive(active);
      const restored = active ? restoreTravelSession() : null;
      if (active && !restored) {
        setMigrationTarget(LANDING_PATH);
        onLegacyRootRedirect(LANDING_PATH);
        return;
      }
      setSession(restored);
    };
    const onHashChange = () => {
      if (!window.location.hash) return;
      setSession(null);
      setTravelViewActive(false);
      window.history.replaceState({ ...window.history.state, smileView: "landing" }, "", `${LANDING_PATH}${window.location.hash}`);
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [initialView, onLegacyRootRedirect]);

  const beginTrip = useCallback((origin: TravelOrigin) => {
    rememberTravelOrigin(origin);
    setSession({ origin, locationExpired: false });
    window.history.pushState({ ...window.history.state, smileView: "events" }, "", FINDING_EVENTS_PATH);
    window.scrollTo?.({ top: 0 });
  }, []);

  const onHome = () => {
    setSession(null);
    setTravelViewActive(false);
    window.history.pushState({ ...window.history.state, smileView: "landing" }, "", LANDING_PATH);
    window.scrollTo?.({ top: 0 });
  };

  if (migrationTarget) return <main className="dk"><p role="status">Opening your trip planner at its new address…</p><a href={migrationTarget}>Continue to S’mile</a></main>;

  return (
    <TravelNavigation.Provider value={beginTrip}>
      {session ? (
        <FindClient
          key={`${session.origin.zip}:${session.origin.label}`}
          initialZip={session.origin.zip}
          initialOrigin={session.origin.label}
          initialLat={session.origin.coordinates?.lat}
          initialLon={session.origin.coordinates?.lon}
          initialEnteredOrigin={session.origin.enteredOrigin}
          initialNotice={session.locationExpired ? "Your precise location is not kept after a refresh. We’re using the starting location you entered instead." : undefined}
          onHome={onHome}
          onOriginChange={rememberTravelOrigin}
        />
      ) : children}
    </TravelNavigation.Provider>
  );
}
