import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { HeroView } from "../../frontend/components/landing/HeroView";

const push = vi.fn();

describe("landing origin picker", () => {
  beforeEach(() => push.mockReset());

  test("asks for location access after a valid ZIP and can continue without GPS", async () => {
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.type(screen.getByLabelText("Home ZIP code"), "61401");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    expect(screen.getByRole("dialog", { name: "Allow location access?" })).toBeVisible();
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use 61401 instead" }));
    expect(push).toHaveBeenCalledWith("/find?zip=61401&origin=61401");
  });

  test("shows an inline error for an incomplete ZIP", async () => {
    render(<HeroView onNavigate={push} />);
    fireEvent.change(screen.getByLabelText("Home ZIP code"), { target: { value: "614" } });
    fireEvent.submit(screen.getByRole("button", { name: /find trips/i }).closest("form")!);
    expect(await screen.findByText("Enter a 5-digit ZIP code.")).toBeVisible();
    expect(push).not.toHaveBeenCalled();
  });

  test("resolves a city before asking for location access", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ zip: "61401", label: "Galesburg, IL" }), { status: 200 })));
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.click(screen.getByRole("button", { name: "City or state" }));
    await user.type(screen.getByLabelText("Home city or state"), "Galesburg, IL");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    expect(await screen.findByRole("dialog", { name: "Allow location access?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Use Galesburg, IL instead" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401&origin=Galesburg%2C%20IL"));
  });

  test("accepts a city without requiring a state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ zip: "61401", label: "Galesburg, IL" }), { status: 200 })));
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.click(screen.getByRole("button", { name: "City or state" }));
    await user.type(screen.getByLabelText("Home city or state"), "Galesburg");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    expect(await screen.findByRole("dialog", { name: "Allow location access?" })).toBeVisible();
  });

  test("uses the browser location only after the user allows it", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 40.95, longitude: -90.37 } } as GeolocationPosition));
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ zip: "61401", label: "Galesburg, IL" }), { status: 200 })));
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.type(screen.getByLabelText("Home ZIP code"), "60601");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Allow location" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401&origin=Galesburg%2C%20IL&gps=1&lat=40.95&lon=-90.37"));
  });

  test("falls back to the entered location when browser permission is denied", async () => {
    const getCurrentPosition = vi.fn((_success: PositionCallback, error: PositionErrorCallback) => error({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError));
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.type(screen.getByLabelText("Home ZIP code"), "61401");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    await user.click(screen.getByRole("button", { name: "Allow location" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401&origin=61401"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("keeps precise coordinates when reverse geocoding is unavailable", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 33.6405, longitude: -117.8443 } } as GeolocationPosition));
    vi.stubGlobal("navigator", { ...navigator, geolocation: { getCurrentPosition } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "lookup unavailable" }), { status: 502 })));
    const user = userEvent.setup();
    render(<HeroView onNavigate={push} />);
    await user.type(screen.getByLabelText("Home ZIP code"), "61401");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    await user.click(screen.getByRole("button", { name: "Allow location" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401&origin=Current%20location&gps=1&lat=33.6405&lon=-117.8443"));
  });
});
