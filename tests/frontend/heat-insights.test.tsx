import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { TripInsights } from "../../frontend/app/find/TripInsights";

vi.mock("leaflet", () => {
  const layer = () => ({
    addTo() { return this; },
    bindTooltip() { return this; },
  });
  return {
    default: {
      map: () => ({ setView() { return this; }, remove() {} }),
      tileLayer: layer,
      rectangle: layer,
      circleMarker: layer,
    },
  };
});

const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

test("shows venue heat in Celsius as the primary display unit", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("price-estimate")) return response({
      scope: { eligible: false, fromState: "CA", toState: "CA", reason: "Same-state trip." },
      rideshare: null,
      airfare: null,
      drive: { status: "ok", source: "test", miles: 4, minutes: 12 },
      models: { rideshare: { metrics: {}, data: {} }, airfare: { metrics: {}, data: {} } },
    });
    if (url.includes("live-flight-price")) return response(null);
    return response({
      status: "ok",
      basis: "forecast",
      at: "2026-10-23T17:00:00Z",
      center: { lat: 37.802, lon: -122.448 },
      radiusMiles: 3,
      cells: [
        { lat: 37.8, lon: -122.45, feelsLikeF: 68, airTempF: 67, anomalyF: -0.4, modelSpreadF: 1, severity: 0, confidence: 0.9, rank: 0 },
        { lat: 37.81, lon: -122.44, feelsLikeF: 71.6, airTempF: 70, anomalyF: 3.6, modelSpreadF: 1, severity: 0.04, confidence: 0.9, rank: 0.036 },
      ],
      hotspots: [{ lat: 37.81, lon: -122.44, feelsLikeF: 71.6, airTempF: 70, anomalyF: 3.6, modelSpreadF: 1, severity: 0.04, confidence: 0.9, rank: 0.036 }],
      regionMedianF: 69.8,
      band: "Warm",
      summary: "Internal Fahrenheit summary",
      method: [],
      sources: [],
    });
  }));

  render(<TripInsights from={{ lat: 37.79, lon: -122.42 }} to={{ lat: 37.802, lon: -122.448 }} startsAt="2026-10-23T17:00:00Z" fromState="CA" toState="CA" />);

  expect(await screen.findByText(/Feels like 20–22°C around the venue/)).toBeVisible();
  expect(screen.getByText("27–31°C caution")).toBeVisible();
  expect(screen.getByText(/Feels 22.0°C \(\+2.0°C vs area\)/)).toBeVisible();
  expect(screen.queryByText(/°F/)).not.toBeInTheDocument();
});
