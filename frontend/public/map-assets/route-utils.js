export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const p1 = a.lat * rad;
  const p2 = b.lat * rad;
  const dp = (b.lat - a.lat) * rad;
  const dl = (b.lng - a.lng) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function decodePolyline(encoded, precision = 5) {
  if (!encoded) return [];
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= encoded.length);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

export function prepareSegment(segment) {
  const points = (segment.points || []).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + distanceMeters(points[index - 1], points[index]));
  const geometryDistance = cumulative.at(-1) || 0;
  return { ...segment, points, cumulative, geometryDistance, distance: Number.isFinite(segment.distance) && segment.distance > 0 ? segment.distance : geometryDistance };
}

export function itineraryDurationSeconds(route) {
  const elapsed = (Date.parse(route.endTime || "") - Date.parse(route.startTime || "")) / 1000;
  if (Number.isFinite(elapsed) && elapsed > 0) return elapsed;
  if (Number.isFinite(route.duration) && route.duration > 0) return route.duration;
  return (route.segments || []).reduce((sum, segment) => sum + (Number.isFinite(segment.duration) && segment.duration > 0 ? segment.duration : 0), 0);
}

export function onwardTransitTime(route, previousDeparture, dwellSeconds = 300) {
  const arrival = Date.parse(route.endTime || "");
  const fallback = new Date(previousDeparture).getTime() + itineraryDurationSeconds(route) * 1000;
  return new Date((Number.isFinite(arrival) ? arrival : fallback) + dwellSeconds * 1000);
}

export function transitRoutePattern(itinerary) {
  return JSON.stringify((itinerary.legs || []).filter((leg) => !["WALK", "BIKE"].includes(leg.mode)).map((leg) => [leg.mode, leg.agencyName, leg.displayName || leg.routeShortName || leg.routeLongName, leg.from?.stopId || leg.from?.name, leg.to?.stopId || leg.to?.name]));
}

export function usableTransitItineraries(itineraries) {
  const seen = new Set();
  const candidates = (Array.isArray(itineraries) ? itineraries : []).filter((itinerary) => {
    if (!itinerary || !Array.isArray(itinerary.legs) || !itinerary.legs.length) return false;
    if (itinerary.legs.some((leg) => !leg?.from || !leg?.to || !leg.mode || leg.cancelled || leg.from.cancelled || leg.to.cancelled || /^(?:CAR(?:_.*)?|HGV)$/.test(leg.mode))) return false;
    if (!itinerary.legs.some((leg) => !["WALK", "BIKE"].includes(leg.mode)) || itineraryDurationSeconds(itinerary) <= 0) return false;
    const key = JSON.stringify([itinerary.startTime, itinerary.endTime, itinerary.legs.map((leg) => [leg.mode, leg.from.stopId || leg.from.name, leg.to.stopId || leg.to.name, leg.startTime, leg.endTime, leg.displayName || leg.routeShortName || leg.routeLongName, leg.agencyName, leg.tripId, leg.routeId])]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => itineraryDurationSeconds(a) - itineraryDurationSeconds(b));
  const patterns = new Set();
  const varied = candidates.filter((itinerary) => {
    const pattern = transitRoutePattern(itinerary);
    if (patterns.has(pattern)) return false;
    patterns.add(pattern);
    return true;
  });
  return [...varied, ...candidates.filter((itinerary) => !varied.includes(itinerary))].slice(0, 4).sort((a, b) => itineraryDurationSeconds(a) - itineraryDurationSeconds(b));
}

function projectToSegment(point, start, end) {
  const scale = Math.cos(((start.lat + end.lat + point.lat) / 3) * Math.PI / 180);
  const ax = start.lng * scale;
  const ay = start.lat;
  const bx = end.lng * scale;
  const by = end.lat;
  const px = point.lng * scale;
  const py = point.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  const projected = { lat: start.lat + (end.lat - start.lat) * t, lng: start.lng + (end.lng - start.lng) * t };
  return { projected, t, distance: distanceMeters(point, projected) };
}

export function projectOnPath(points, cumulative, point) {
  if (!points?.length) return { index: 0, t: 0, projected: point, distance: Infinity, traveled: 0, progress: 0 };
  if (points.length === 1) return { index: 0, t: 0, projected: points[0], distance: distanceMeters(point, points[0]), traveled: 0, progress: 0 };
  let best = null;
  for (let index = 0; index < points.length - 1; index += 1) {
    const candidate = projectToSegment(point, points[index], points[index + 1]);
    if (!best || candidate.distance < best.distance) best = { ...candidate, index };
  }
  const segmentLength = (cumulative[best.index + 1] || 0) - (cumulative[best.index] || 0);
  const traveled = (cumulative[best.index] || 0) + segmentLength * best.t;
  const total = cumulative.at(-1) || 0;
  return { ...best, traveled, progress: total ? Math.max(0, Math.min(1, traveled / total)) : 0 };
}

export function partialPath(points, projection) {
  if (!points?.length) return [];
  const completed = points.slice(0, Math.min(points.length, projection.index + 1));
  const last = completed.at(-1);
  if (!last || last.lat !== projection.projected.lat || last.lng !== projection.projected.lng) completed.push(projection.projected);
  return completed;
}

export function greatCirclePoints(from, to, count = 48) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const a = [from.lat * rad, from.lng * rad];
  const b = [to.lat * rad, to.lng * rad];
  const angle = 2 * Math.asin(Math.sqrt(Math.sin((b[0] - a[0]) / 2) ** 2 + Math.cos(a[0]) * Math.cos(b[0]) * Math.sin((b[1] - a[1]) / 2) ** 2));
  if (!angle) return [from, to];
  return Array.from({ length: count + 1 }, (_, index) => {
    const fraction = index / count;
    const left = Math.sin((1 - fraction) * angle) / Math.sin(angle);
    const right = Math.sin(fraction * angle) / Math.sin(angle);
    const x = left * Math.cos(a[0]) * Math.cos(a[1]) + right * Math.cos(b[0]) * Math.cos(b[1]);
    const y = left * Math.cos(a[0]) * Math.sin(a[1]) + right * Math.cos(b[0]) * Math.sin(b[1]);
    const z = left * Math.sin(a[0]) + right * Math.sin(b[0]);
    return { lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * deg, lng: Math.atan2(y, x) * deg };
  });
}
