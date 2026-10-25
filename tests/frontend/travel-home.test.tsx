import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Hero } from "../../frontend/components/landing/Hero";
import { TravelHome } from "../../frontend/components/travel/TravelHome";
import { clearTravelSession, rememberTravelOrigin, restoreTravelSession, setTravelViewActive } from "../../frontend/lib/travelSession";

const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response);
const result = { origin: { zip: "61401", label: "Galesburg, IL" }, radiusMiles: 200, events: [], outsideRadius: [], unplaced: [], sources: [], store: "local", classifiedBy: "keywords" };

beforeEach(() => {
  clearTravelSession();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => clearTravelSession());

test("starts at the landing page and keeps the event planner and updates at the clean root URL", async () => {
  const fetcher = vi.fn(() => response(result));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<TravelHome><Hero /></TravelHome>);
  await user.type(screen.getByLabelText("Home ZIP code"), "61401");
  await user.click(screen.getByRole("button", { name: /find trips/i }));
  await user.click(screen.getByRole("button", { name: "Use 61401 instead" }));
  expect(await screen.findByLabelText("Starting ZIP, city, or state")).toHaveValue("61401");
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  expect(await screen.findByLabelText("Search events by name or topic")).toBeVisible();
  expect(window.location.pathname + window.location.search + window.location.hash).toBe("/");
  expect(JSON.stringify(window.history.state)).not.toContain("61401");
});

test("keeps exact GPS in memory but never in browser history or tab storage", async () => {
  const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 33.6405, longitude: -117.8443 } } as GeolocationPosition));
  vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
  vi.stubGlobal("fetch", vi.fn(() => response({ zip: "92697", label: "Irvine, CA" })));
  const user = userEvent.setup();
  render(<TravelHome><Hero /></TravelHome>);
  await user.type(screen.getByLabelText("Home ZIP code"), "61401");
  await user.click(screen.getByRole("button", { name: /find trips/i }));
  await user.click(screen.getByRole("button", { name: "Allow location" }));
  await waitFor(() => expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("Irvine, CA"));
  const stored = window.sessionStorage.getItem("smile.travel-origin.v1")!;
  expect(stored).toContain("61401");
  expect(stored).not.toContain("33.6405");
  expect(stored).not.toContain("117.8443");
  expect(stored).not.toContain("Irvine");
  expect(window.localStorage.length).toBe(0);
  expect(JSON.stringify(window.history.state)).not.toMatch(/33\.6405|117\.8443|61401|Irvine/);
  expect(window.location.href).not.toMatch(/lat=|lon=|zip=|origin=/);
  expect(restoreTravelSession()?.origin.coordinates).toEqual({ lat: 33.6405, lon: -117.8443 });
});

test("restores only the entered location after a fresh page load and explains that GPS was not kept", () => {
  window.sessionStorage.setItem("smile.travel-origin.v1", JSON.stringify({ version: 1, active: true, zip: "61401", label: "61401", usedDeviceLocation: true }));
  render(<TravelHome><Hero /></TravelHome>);
  expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("61401");
  expect(screen.getByRole("status")).toHaveTextContent("Your precise location is not kept after a refresh");
  expect(restoreTravelSession()?.origin.coordinates).toBeUndefined();
});

test("home and browser navigation switch views without adding personal information to the URL", async () => {
  rememberTravelOrigin({ zip: "61401", label: "Galesburg, IL" });
  const user = userEvent.setup();
  render(<TravelHome><Hero /></TravelHome>);
  expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("Galesburg, IL");
  await user.click(screen.getByRole("link", { name: "S’mile home" }));
  expect(screen.getByLabelText("Home ZIP code")).toBeVisible();
  expect(restoreTravelSession()).toBeNull();
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { smileView: "events" } })));
  expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("Galesburg, IL");
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { smileView: "landing" } })));
  expect(screen.getByLabelText("Home ZIP code")).toBeVisible();
  expect(window.location.pathname + window.location.search).toBe("/");
});

test("replaces legacy root query documents and expires GPS instead of retaining personal router history", () => {
  window.history.replaceState(null, "", "/?zip=61401&origin=61401&lat=33.6405&lon=-117.8443");
  const redirect = vi.fn();
  render(<TravelHome onLegacyRootRedirect={redirect}><Hero /></TravelHome>);
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/");
  expect(screen.getByRole("status")).toHaveTextContent("Opening your trip planner at its new address");
  expect(restoreTravelSession()).toEqual({ origin: { zip: "61401", label: "61401" }, locationExpired: true });
  expect(window.sessionStorage.getItem("smile.travel-origin.v1")).not.toMatch(/33\.6405|117\.8443/);
});

test.each(["lens", "faq"])("an explicit %s landing link takes precedence over an active event session", (section) => {
  rememberTravelOrigin({ zip: "61401", label: "Galesburg, IL" });
  window.history.replaceState(null, "", `/#${section}`);
  render(<TravelHome><Hero /><section id={section}>{section} section</section></TravelHome>);
  expect(screen.getByLabelText("Home ZIP code")).toBeVisible();
  expect(screen.getByText(`${section} section`)).toBeVisible();
  expect(screen.queryByLabelText("Starting ZIP, city, or state")).not.toBeInTheDocument();
  expect(window.location.pathname + window.location.hash).toBe(`/#${section}`);
  expect(restoreTravelSession()).toBeNull();
});

test("a later landing anchor leaves the planner without losing the requested section", () => {
  rememberTravelOrigin({ zip: "61401", label: "61401" });
  render(<TravelHome><Hero /><section id="lens">Extension section</section></TravelHome>);
  expect(screen.getByLabelText("Starting ZIP, city, or state")).toBeVisible();
  window.history.replaceState(window.history.state, "", "/#lens");
  act(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
  expect(screen.getByText("Extension section")).toBeVisible();
  expect(screen.getByLabelText("Home ZIP code")).toBeVisible();
  expect(window.location.hash).toBe("#lens");
});

test("a legacy root query preserves an explicit landing section during document replacement", () => {
  window.history.replaceState(null, "", "/?zip=61401&origin=61401#faq");
  const redirect = vi.fn();
  render(<TravelHome onLegacyRootRedirect={redirect}><Hero /></TravelHome>);
  expect(redirect).toHaveBeenCalledExactlyOnceWith("/#faq");
  expect(restoreTravelSession()).toBeNull();
});

test("changing a GPS starting point to a typed place replaces the saved fallback", async () => {
  rememberTravelOrigin({ zip: "61401", label: "Current location", coordinates: { lat: 33.6405, lon: -117.8443 }, enteredOrigin: { zip: "61401", label: "61401" } });
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve?lat=")) return response({ zip: "92697", label: "Irvine, CA" });
    if (url.startsWith("/api/location/resolve?city=")) return response({ zip: "90095", label: "UCLA", lat: 34.0709, lon: -118.4469 });
    return response({ ...result, origin: { zip: "90095", label: "UCLA" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<TravelHome><Hero /></TravelHome>);
  await waitFor(() => expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("Irvine, CA"));
  fireEvent.change(screen.getByLabelText("Starting ZIP, city, or state"), { target: { value: "UCLA" } });
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await screen.findByLabelText("Search events by name or topic");
  const saved = JSON.parse(window.sessionStorage.getItem("smile.travel-origin.v1")!);
  expect(saved).toMatchObject({ zip: "90095", label: "UCLA", usedDeviceLocation: false });
  expect(JSON.stringify(saved)).not.toMatch(/34\.0709|118\.4469|33\.6405|117\.8443/);
});

test("an inactive tab session leaves the landing page visible", () => {
  rememberTravelOrigin({ zip: "61401", label: "61401" });
  setTravelViewActive(false);
  render(<TravelHome><Hero /></TravelHome>);
  expect(screen.getByLabelText("Home ZIP code")).toBeVisible();
  expect(screen.queryByLabelText("Starting ZIP, city, or state")).not.toBeInTheDocument();
});
