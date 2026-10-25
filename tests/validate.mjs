import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const required = ["dist/index.html", "dist/map/index.html", "dist/assets/map.css", "dist/assets/map.js", "dist/manifest.webmanifest", "dist/service-worker.js"];
for (const file of required) assert.ok(existsSync(file), `${file} must exist`);
const html = readFileSync("dist/map/index.html", "utf8");
const script = readFileSync("dist/assets/map.js", "utf8");
assert.match(html, /id="map"/, "map canvas exists");
assert.match(html, /id="navigation-panel"/, "navigation UI exists");
assert.match(script, /watchPosition/, "continuous GPS is used");
assert.match(script, /router\.project-osrm\.org/, "road routing is configured");
assert.match(script, /nominatim\.openstreetmap\.org/, "OpenStreetMap place search is configured");
assert.match(script, /alternatives=3/, "alternative routes are requested");
assert.match(script, /nearestRoutePoint/, "route progress follows GPS position");
assert.doesNotMatch(`${html}\n${script}`, /S[’']?mile|calhacks|James West|UCLA/i, "no inherited project branding is visible");
console.log("Static navigation checks passed.");
