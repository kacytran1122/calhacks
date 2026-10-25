import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const runtime = readFileSync(path.join(root, "frontend/public/map-assets/map.js"), "utf8");

test("the actual bundled Leaflet tile layer identifies only the site origin before loading tiles", () => {
  const bundle = readFileSync(path.join(root, "frontend/public/map-assets/leaflet.js"), "utf8");
  const exports = {};
  const previousLeaflet = window.L;
  const tileFactory = runtime.match(/L\.tileLayer\([\s\S]*?\)\.addTo\(map\);/)?.[0];
  expect(tileFactory).toBeTruthy();
  const originalSource = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const policiesAtSource: string[] = [];
  vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (this: HTMLImageElement, value: string) {
    policiesAtSource.push(this.referrerPolicy);
    originalSource?.call(this, value);
  });
  try {
    const leaflet = new Function("exports", "module", `${bundle}\nreturn exports;`)(exports, { exports });
    expect(leaflet.version).toBe("1.9.4");
    const expression = tileFactory!.replace(/\.addTo\(map\);$/, "");
    const layer = new Function("L", `return ${expression};`)(leaflet);
    layer._tileZoom = 3;
    const tile: HTMLImageElement = layer.createTile({ x: 1, y: 2, z: 3 }, () => {});
    expect(tile.tagName).toBe("IMG");
    expect(tile.referrerPolicy).toBe("strict-origin");
    expect(policiesAtSource).toEqual(["strict-origin"]);
    expect(tile.src).toBe("https://tile.openstreetmap.org/3/1/2.png");
    expect(new URL(tile.src).search).toBe("");
    expect(layer.options.attribution).toContain("https://www.openstreetmap.org/copyright");
    expect(tile.outerHTML).not.toMatch(/handoff|phm1_|tripToken|[?&](?:lat|lon|lng|to)=/);
  } finally {
    if (previousLeaflet === undefined) delete window.L;
    else window.L = previousLeaflet;
  }
});

test("tile identification does not relax private map document or handoff referrer policies", () => {
  const config = readFileSync(path.join(root, "frontend/next.config.ts"), "utf8");
  const handoff = readFileSync(path.join(root, "frontend/app/api/map/handoff/route.ts"), "utf8");
  const page = readFileSync(path.join(root, "frontend/app/map/MapClient.tsx"), "utf8");
  expect(config).toMatch(/source:\s*"\/map"[\s\S]*?key:\s*"Referrer-Policy",\s*value:\s*"no-referrer"/);
  expect(handoff).toMatch(/"Referrer-Policy":\s*"no-referrer"/);
  expect(handoff).toMatch(/"Cache-Control":\s*"private, no-store/);
  expect(page.indexOf('current.searchParams.delete("handoff")')).toBeGreaterThan(-1);
  expect(page.indexOf('current.searchParams.delete("handoff")')).toBeLessThan(page.indexOf("/map-assets/map.js"));
});
