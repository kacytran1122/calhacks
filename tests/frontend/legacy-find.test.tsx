import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { clearTravelSession, restoreTravelSession } from "../../frontend/lib/travelSession";

import { LegacyFindMigration } from "../../frontend/components/travel/LegacyFindRedirect";

const replace = vi.fn();

afterEach(() => { clearTravelSession(); replace.mockReset(); window.history.replaceState(null, "", "/landing"); });

test("legacy event links retain their starting point and replace to the canonical event route", () => {
  window.history.replaceState(null, "", "/find?zip=61401&origin=Galesburg%2C%20IL");
  render(<LegacyFindMigration onNavigate={replace} />);
  expect(replace).toHaveBeenCalledWith("/finding-events");
  expect(window.location.search).toBe("");
  expect(restoreTravelSession()?.origin).toEqual({ zip: "61401", label: "Galesburg, IL" });
  expect(screen.getByRole("link", { name: "Continue to S’mile" })).toHaveAttribute("href", "/finding-events");
});

test("legacy GPS is transferred in memory only and removed from the old address immediately", () => {
  window.history.replaceState(null, "", "/find?zip=61401&origin=Current+location&lat=33.6405&lon=-117.8443");
  render(<LegacyFindMigration onNavigate={replace} />);
  expect(replace).toHaveBeenCalledWith("/finding-events");
  expect(window.location.pathname + window.location.search).toBe("/find");
  expect(restoreTravelSession()?.origin.coordinates).toEqual({ lat: 33.6405, lon: -117.8443 });
  expect(window.sessionStorage.getItem("smile.travel-origin.v1")).not.toMatch(/33\.6405|117\.8443/);
});

test("a legacy find URL without a valid origin returns to the landing page", () => {
  window.history.replaceState(null, "", "/find");
  render(<LegacyFindMigration onNavigate={replace} />);
  expect(replace).toHaveBeenCalledWith("/landing");
  expect(screen.getByRole("link", { name: "Continue to S’mile" })).toHaveAttribute("href", "/landing");
});

test("a landing section hash takes precedence over a legacy saved origin", () => {
  window.history.replaceState(null, "", "/find?zip=61401&origin=Galesburg#faq");
  render(<LegacyFindMigration onNavigate={replace} />);
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/find#faq");
  expect(replace).toHaveBeenCalledWith("/landing#faq");
});
