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
    expect(push).toHaveBeenCalledWith("/find?zip=61401");
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
    await user.click(screen.getByRole("button", { name: "City" }));
    await user.type(screen.getByLabelText("Home city and state"), "Galesburg, IL");
    await user.click(screen.getByRole("button", { name: /find trips/i }));
    expect(await screen.findByRole("dialog", { name: "Allow location access?" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Use Galesburg, IL instead" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401"));
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
    await waitFor(() => expect(push).toHaveBeenCalledWith("/find?zip=61401"));
  });
});
