import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const runtime = readFileSync(path.join(root, "frontend/public/map-assets/map.js"), "utf8");
const page = readFileSync(path.join(root, "frontend/app/map/MapClient.tsx"), "utf8");

describe("route guidance map", () => {
  it("uses GPS, OpenStreetMap routing fallbacks, and multimodal transit", () => {
    expect(runtime).toMatch(/watchPosition/);
    expect(runtime).toMatch(/nominatim\.openstreetmap\.org/);
    expect(runtime).toMatch(/router\.project-osrm\.org/);
    expect(runtime).toMatch(/TRANSIT_ENDPOINTS/);
    expect(runtime).toMatch(/OpenStreetMap walking fallback/);
    expect(page).toMatch(/data-mode="flight"/);
    expect(page).toMatch(/data-mode="transit"/);
  });

  it("turns road maneuvers into numbered progress steps", () => {
    expect(runtime).toMatch(/function roadInstruction/);
    expect(runtime).toMatch(/leg\.steps/);
    expect(runtime).toMatch(/Step \$\{state\.activeLeg \+ 1\} of \$\{route\.segments\.length\}/);
    expect(runtime).toMatch(/projectOnPath/);
    expect(page).toMatch(/Previous step/);
    expect(page).toMatch(/Next step/);
  });

  it("exchanges an opaque Photon handoff for a clean map bootstrap", () => {
    expect(page).toMatch(/\/api\/map\/handoff\?token=/);
    expect(page).toMatch(/searchParams\.delete\("handoff"\)/);
    expect(page).not.toMatch(/tripToken/);
  });

  it("keeps the map surface free of inherited project branding", () => {
    expect(`${page}\n${runtime}`).not.toMatch(/CalHacks|James West|UCLA/i);
  });
});
