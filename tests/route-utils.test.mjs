import test from "node:test";
import assert from "node:assert/strict";
import { decodePolyline, prepareSegment, projectOnPath } from "../dist/assets/route-utils.js";

test("decodes route geometry", () => {
  assert.deepEqual(decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@"), [
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 },
  ]);
});

test("projects GPS between vertices for smooth on-map progress", () => {
  const segment = prepareSegment({ points: [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }] });
  const projection = projectOnPath(segment.points, segment.cumulative, { lat: 0.01, lng: 0.5 });
  assert.ok(projection.progress > 0.49 && projection.progress < 0.51);
  assert.ok(projection.distance > 1000 && projection.distance < 1200);
});
