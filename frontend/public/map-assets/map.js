import { assignRideLegIds, decodePolyline, distanceMeters, greatCirclePoints, itineraryDurationSeconds, onwardTransitTime, partialPath, prepareSegment, projectOnPath, rideCompletionDescriptor, rideNearArrival, ridePaymentMode, taxiJourneySegment, transitRoutePattern, usableTransitItineraries, userMapInteraction } from "./route-utils.js?v=6";
import { mountRideCheckout } from "./ride-checkout.js?v=2";
import { mountTripReceipt } from "./trip-receipt.js?v=1";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const TRANSIT_ENDPOINTS = location.hostname.endsWith("chatgpt.site")
  ? ["https://api.transitous.org/api/v6/plan"]
  : ["/api/transit", "https://api.transitous.org/api/v6/plan"];

const ui = {
  planner: $("#planner-form"), plannerBody: $("#planner-body"), plannerSummary: $("#planner-summary"),
  plannerTitle: $("#planner-title"), summaryText: $("#summary-text"), togglePlanner: $("#toggle-planner"), editRoute: $("#edit-route"),
  startInput: $("#start-input"), destinationInput: $("#destination-input"), waypointFields: $("#waypoint-fields"),
  addStop: $("#add-stop"), useLiveStart: $("#use-live-start"), departure: $("#departure-time"), plan: $("#plan-route"),
  results: $("#search-results"), hint: $("#search-hint"), permission: $("#permission-card"), permissionButton: $("#location-permission"),
  recenter: $("#recenter"), orientation: $("#orientation"), setup: $("#route-setup"), closeRoute: $("#close-route"),
  routeKicker: $("#route-kicker"), destinationName: $("#destination-name"), destinationAddress: $("#destination-address"),
  status: $("#route-status"), options: $("#route-options"), legList: $("#leg-list"), start: $("#start-navigation"),
  routeSource: $("#route-source"), navigation: $("#navigation-panel"), end: $("#end-navigation"),
  stepDistance: $("#step-distance"), stepInstruction: $("#step-instruction"), maneuver: $("#maneuver-icon"),
  remaining: $("#remaining-distance"), arrival: $("#arrival-time"), accuracy: $("#gps-accuracy"),
  currentStreet: $("#current-street"), progressPercent: $("#progress-percent"), destinationLabel: $("#route-destination"),
  overallProgress: $("#overall-progress-fill"), activeLegSummary: $("#active-leg-summary"),
  previousLeg: $("#previous-leg"), nextLeg: $("#next-leg"), toast: $("#toast"),
};

const state = {
  user: null,
  watchId: null,
  startLive: true,
  start: null,
  destination: null,
  waypoints: [],
  activeField: { type: "destination" },
  nextWaypointId: 1,
  mode: "transit",
  includeSelfDrive: true,
  routes: [],
  selectedRoute: 0,
  routeLayers: [],
  progressLayers: [],
  pointMarkers: [],
  transferMarkers: [],
  userMarker: null,
  accuracyCircle: null,
  navigating: false,
  activeLeg: 0,
  legProgress: 0,
  legProjection: null,
  offRouteUpdates: 0,
  rerouting: false,
  rerouteAfter: 0,
  rideLegIds: new Map(),
  completedRideLegs: new Set(),
  completedRideDescriptors: new Map(),
  ridePromptCooldowns: new Map(),
  paymentSession: crypto.randomUUID(),
  journeyFrom: null,
  journeyTo: null,
  hasPaymentAttempt: false,
  receiptSessionLost: false,
  journeyFinalized: false,
  follow: true,
  followHeading: false,
  lastHeading: null,
  searchAbort: null,
  routeAbort: null,
};
const rideCheckout = mountRideCheckout();
const tripReceipt = mountTripReceipt();

const map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([37.7749, -122.4194], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  referrerPolicy: "strict-origin",
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const userIcon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [24, 24], iconAnchor: [12, 12] });
const startIcon = L.divIcon({ className: "", html: '<div class="start-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
const destinationIcon = L.divIcon({ className: "", html: '<div class="destination-marker">●</div>', iconSize: [28, 36], iconAnchor: [14, 36] });
const waypointIcon = (number) => L.divIcon({ className: "", html: `<div class="waypoint-marker">${number}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
const transferIcon = (text) => L.divIcon({ className: "", html: `<div class="transfer-marker">${text}</div>`, iconSize: [34, 30], iconAnchor: [17, 15] });

const AIRPORTS = [
  ["ATL", "Hartsfield–Jackson Atlanta", 33.6407, -84.4277], ["AUS", "Austin–Bergstrom", 30.1975, -97.6664],
  ["BOS", "Boston Logan", 42.3656, -71.0096], ["BWI", "Baltimore/Washington", 39.1774, -76.6684],
  ["CLT", "Charlotte Douglas", 35.2144, -80.9473], ["DCA", "Reagan National", 38.8512, -77.0402],
  ["DEN", "Denver International", 39.8561, -104.6737], ["DFW", "Dallas/Fort Worth", 32.8998, -97.0403],
  ["EWR", "Newark Liberty", 40.6895, -74.1745], ["HNL", "Daniel K. Inouye", 21.3187, -157.9225],
  ["IAD", "Washington Dulles", 38.9531, -77.4565], ["IAH", "George Bush Intercontinental", 29.9902, -95.3368],
  ["JFK", "John F. Kennedy", 40.6413, -73.7781], ["LAS", "Harry Reid", 36.084, -115.1537],
  ["LAX", "Los Angeles International", 33.9416, -118.4085], ["MCO", "Orlando International", 28.4312, -81.3081],
  ["MDW", "Chicago Midway", 41.7868, -87.7522], ["MIA", "Miami International", 25.7959, -80.287],
  ["MSP", "Minneapolis–Saint Paul", 44.8848, -93.2223], ["OAK", "Oakland International", 37.7126, -122.2197],
  ["ORD", "Chicago O'Hare", 41.9742, -87.9073], ["PDX", "Portland International", 45.5898, -122.5951],
  ["PHL", "Philadelphia International", 39.8744, -75.2424], ["PHX", "Phoenix Sky Harbor", 33.4352, -112.0101],
  ["SAN", "San Diego International", 32.7338, -117.1933], ["SEA", "Seattle–Tacoma", 47.4502, -122.3088],
  ["SFO", "San Francisco International", 37.6213, -122.379], ["SJC", "San José Mineta", 37.3639, -121.9289],
  ["SLC", "Salt Lake City International", 40.7899, -111.9791], ["STL", "St. Louis Lambert", 38.7487, -90.37],
];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function showToast(message, timeout = 3600) {
  ui.toast.textContent = message;
  ui.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => ui.toast.classList.add("hidden"), timeout);
}

function metersText(meters) {
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.max(1, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

function durationText(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

function arrivalText(seconds, absolute) {
  const when = absolute ? new Date(absolute) : new Date(Date.now() + Math.max(0, seconds) * 1000);
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function localDateTime(date = new Date(Date.now() + 10 * 60_000)) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function collapsePlanner(collapsed = true) {
  ui.planner.classList.toggle("collapsed", collapsed);
  ui.togglePlanner.setAttribute("aria-expanded", String(!collapsed));
  ui.togglePlanner.setAttribute("aria-label", collapsed ? "Expand route planner" : "Collapse route planner");
  ui.togglePlanner.textContent = collapsed ? "Show" : "Hide";
  ui.plannerSummary.classList.toggle("hidden", !collapsed || !state.destination);
}

function effectiveStart() {
  if (state.startLive && state.user) return { lat: state.user.lat, lng: state.user.lng, name: "My live location", address: "Current GPS position" };
  return state.start;
}

function tripPoints() {
  const start = effectiveStart();
  const stops = state.waypoints.map((item) => item.place).filter(Boolean);
  return start && state.destination ? [start, ...stops, state.destination] : [];
}

function updatePlannerState() {
  const start = effectiveStart();
  const ready = Boolean(start && state.destination && state.waypoints.every((item) => item.place));
  ui.plan.disabled = !ready;
  ui.plannerTitle.textContent = state.destination ? `${start?.name || "Choose start"} to ${state.destination.name}` : "Choose start and destination";
  ui.summaryText.textContent = state.destination
    ? `${start?.name || "Start"} to ${state.destination.name}${state.waypoints.length ? ` · ${state.waypoints.length} stop${state.waypoints.length > 1 ? "s" : ""}` : ""}`
    : "";
}

function fieldInput(field = state.activeField) {
  if (field.type === "start") return ui.startInput;
  if (field.type === "destination") return ui.destinationInput;
  return document.querySelector(`[data-waypoint-id="${field.id}"] input`);
}

function setActiveField(field) {
  state.activeField = field;
  $$(".point-row").forEach((row) => row.classList.toggle("active-field",
    row.dataset.field === field.type || (field.type === "waypoint" && row.dataset.waypointId === String(field.id))));
}

function renderWaypoints() {
  ui.waypointFields.innerHTML = state.waypoints.map((waypoint, index) => `
    <div class="point-row" data-field="waypoint" data-waypoint-id="${waypoint.id}">
      <span class="point-node waypoint-node" aria-hidden="true"></span>
      <label><small>Stop ${index + 1}</small><input autocomplete="off" enterkeyhint="search" value="${escapeHtml(waypoint.place?.name || "")}" placeholder="Search stop" aria-label="Stop ${index + 1}" /></label>
      <span class="waypoint-actions">
        <button type="button" data-action="up" aria-label="Move stop ${index + 1} earlier">Earlier</button>
        <button type="button" data-action="remove" aria-label="Remove stop ${index + 1}">×</button>
      </span>
    </div>`).join("");
  ui.waypointFields.querySelectorAll(".point-row").forEach((row) => {
    const id = Number(row.dataset.waypointId);
    const input = row.querySelector("input");
    input.addEventListener("focus", () => setActiveField({ type: "waypoint", id }));
    input.addEventListener("input", () => {
      const waypoint = state.waypoints.find((item) => item.id === id);
      if (waypoint && input.value !== waypoint.place?.name) waypoint.place = null;
      updatePlannerState();
    });
    row.querySelector('[data-action="remove"]').addEventListener("click", () => {
      state.waypoints = state.waypoints.filter((item) => item.id !== id);
      renderWaypoints();
      updatePointMarkers();
      updatePlannerState();
    });
    row.querySelector('[data-action="up"]').addEventListener("click", () => {
      const index = state.waypoints.findIndex((item) => item.id === id);
      if (index > 0) [state.waypoints[index - 1], state.waypoints[index]] = [state.waypoints[index], state.waypoints[index - 1]];
      renderWaypoints();
      updatePointMarkers();
    });
  });
}

function clearRouteLayers() {
  [...state.routeLayers, ...state.progressLayers, ...state.transferMarkers].forEach((layer) => layer.remove());
  state.routeLayers = [];
  state.progressLayers = [];
  state.transferMarkers = [];
}

function updatePointMarkers() {
  state.pointMarkers.forEach((marker) => marker.remove());
  state.pointMarkers = [];
  const start = effectiveStart();
  if (start) state.pointMarkers.push(L.marker([start.lat, start.lng], { icon: startIcon, zIndexOffset: 700, title: "Start" }).addTo(map));
  state.waypoints.forEach((waypoint, index) => {
    if (waypoint.place) state.pointMarkers.push(L.marker([waypoint.place.lat, waypoint.place.lng], { icon: waypointIcon(index + 1), zIndexOffset: 750, title: `Stop ${index + 1}: ${waypoint.place.name}` }).addTo(map));
  });
  if (state.destination) state.pointMarkers.push(L.marker([state.destination.lat, state.destination.lng], { icon: destinationIcon, zIndexOffset: 800, title: state.destination.name }).addTo(map));
}

function requestLocation() {
  if (!navigator.geolocation) {
    ui.permission.querySelector("span").textContent = "This browser does not provide device location.";
    ui.permissionButton.disabled = true;
    return;
  }
  ui.permissionButton.disabled = true;
  ui.permissionButton.textContent = "Finding you…";
  state.watchId = navigator.geolocation.watchPosition(onPosition, onLocationError, {
    enableHighAccuracy: true,
    maximumAge: 1200,
    timeout: 15000,
  });
}

function onPosition(position) {
  const next = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: position.coords.accuracy,
    heading: Number.isFinite(position.coords.heading) ? position.coords.heading : null,
    speed: Number.isFinite(position.coords.speed) ? position.coords.speed : null,
    timestamp: position.timestamp,
  };
  state.user = next;
  ui.permission.classList.add("hidden");
  ui.useLiveStart.classList.add("active");
  ui.accuracy.textContent = `±${Math.round(next.accuracy)} m`;
  if (!state.userMarker) {
    state.userMarker = L.marker([next.lat, next.lng], { icon: userIcon, zIndexOffset: 1200, title: "Live location" }).addTo(map);
    state.accuracyCircle = L.circle([next.lat, next.lng], { radius: next.accuracy, color: "#1f9e72", fillColor: "#7fd8b4", fillOpacity: 0.16, weight: 2 }).addTo(map);
    map.setView([next.lat, next.lng], 16);
  } else {
    state.userMarker.setLatLng([next.lat, next.lng]);
    state.accuracyCircle.setLatLng([next.lat, next.lng]).setRadius(next.accuracy);
  }
  if (next.heading !== null) state.lastHeading = next.heading;
  const marker = state.userMarker.getElement()?.querySelector(".user-marker");
  if (marker) marker.style.transform = `rotate(${state.followHeading && state.lastHeading !== null ? state.lastHeading : 0}deg)`;
  if (state.startLive) {
    ui.startInput.value = "My live location";
    updatePlannerState();
    updatePointMarkers();
  }
  if (state.follow && state.navigating) map.panTo([next.lat, next.lng], { animate: true, duration: 0.35 });
  if (state.navigating) updateNavigation(next);
}

function onLocationError(error) {
  ui.permission.classList.remove("hidden");
  ui.permissionButton.disabled = false;
  ui.permissionButton.textContent = "Try GPS again";
  const messages = {
    1: "Location access is blocked. Allow it in browser settings, then try again.",
    2: "Your device could not determine its position. Enable device location and try again.",
    3: "Location took too long. Try again with a clearer GPS signal.",
  };
  ui.permission.querySelector("span").textContent = messages[error.code] || "Your live position is currently unavailable.";
}

async function searchPlaces(query) {
  if (!query || query.length < 2) return;
  state.searchAbort?.abort();
  state.searchAbort = new AbortController();
  ui.results.classList.remove("hidden");
  ui.results.innerHTML = '<div class="route-status">Searching OpenStreetMap…</div>';
  try {
    const bounds = map.getBounds();
    const params = new URLSearchParams({
      format: "jsonv2",
      q: query,
      limit: "5",
      addressdetails: "1",
      viewbox: `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`,
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      signal: state.searchAbort.signal,
      headers: { "Accept-Language": navigator.language || "en" },
    });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    const places = await response.json();
    if (!places.length) {
      ui.results.innerHTML = '<div class="route-status">No matching place. Try a full street address.</div>';
      return;
    }
    ui.results.innerHTML = places.map((place, index) => {
      const name = place.name || place.display_name.split(",")[0];
      return `<button class="search-result" type="button" data-index="${index}"><span class="result-pin">●</span><div><b>${escapeHtml(name)}</b><span>${escapeHtml(place.display_name)}</span></div></button>`;
    }).join("");
    $$(".search-result").forEach((button) => button.addEventListener("click", () => {
      const result = places[Number(button.dataset.index)];
      setPoint(state.activeField, {
        lat: Number(result.lat),
        lng: Number(result.lon),
        name: result.name || result.display_name.split(",")[0],
        address: result.display_name,
      });
    }));
  } catch (error) {
    if (error.name !== "AbortError") ui.results.innerHTML = '<div class="route-status">Search is temporarily unavailable. Press and hold the map to place this point.</div>';
  }
}

async function reversePlace(lat, lng) {
  try {
    const params = new URLSearchParams({ format: "jsonv2", lat: String(lat), lon: String(lng), zoom: "18", addressdetails: "1" });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, { headers: { "Accept-Language": navigator.language || "en" } });
    if (!response.ok) throw new Error("Reverse lookup failed");
    const place = await response.json();
    return { name: place.name || place.address?.road || "Dropped pin", address: place.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  } catch {
    return { name: "Dropped pin", address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  }
}

function setPoint(field, place) {
  if (field.type === "start") {
    state.startLive = false;
    state.start = place;
    ui.startInput.value = place.name;
    ui.useLiveStart.classList.remove("active");
  } else if (field.type === "destination") {
    state.destination = place;
    ui.destinationInput.value = place.name;
  } else {
    const waypoint = state.waypoints.find((item) => item.id === field.id);
    if (waypoint) waypoint.place = place;
    renderWaypoints();
  }
  ui.results.classList.add("hidden");
  updatePointMarkers();
  updatePlannerState();
  ui.hint.textContent = "Add another stop or show route options";
  const points = tripPoints();
  if (points.length > 1) map.fitBounds(L.latLngBounds(points.map((point) => [point.lat, point.lng])), { padding: [70, 70], maxZoom: 16 });
}

function routeEndpoints(mode) {
  if (mode === "walk") return ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"];
  if (mode === "bike") return ["https://routing.openstreetmap.de/routed-bike/route/v1/driving"];
  return ["https://router.project-osrm.org/route/v1/driving", "https://routing.openstreetmap.de/routed-car/route/v1/driving"];
}

function modeMeta(rawMode, agency, line) {
  const raw = String(rawMode || "").toUpperCase();
  if (raw === "WALK") return { mode: "walk", icon: "●", name: "Walk" };
  if (raw === "BIKE") return { mode: "bike", icon: "◆", name: "Bike" };
  if (raw === "CAR") return { mode: "drive", icon: "D", name: "Drive" };
  if (raw === "TAXI" || raw === "RIDESHARE") return { mode: "taxi", icon: "T", name: "Taxi" };
  if (raw === "BUS" || raw === "COACH") return { mode: "bus", icon: "▣", name: line ? `Bus ${line}` : "Bus" };
  if (raw === "SUBWAY" && /Bay Area Rapid Transit/i.test(agency || "")) return { mode: "rail", icon: "B", name: line ? `BART ${line}` : "BART" };
  if (/SUBWAY|RAIL|TRAIN|LONG_DISTANCE|HIGH_SPEED|REGIONAL|SUBURBAN|MONORAIL/.test(raw)) return { mode: "rail", icon: "▤", name: line || "Train" };
  if (raw === "TRAM") return { mode: "rail", icon: "▤", name: line ? `Tram ${line}` : "Tram" };
  if (raw === "FERRY") return { mode: "ferry", icon: "≈", name: line || "Ferry" };
  if (raw === "FLIGHT" || raw === "AIRPLANE") return { mode: "flight", icon: "✈", name: line || "Flight" };
  if (raw === "AIRPORT") return { mode: "airport", icon: "⌂", name: line || "Airport" };
  return { mode: "transit", icon: "▣", name: line || "Transit" };
}

function roadInstruction(step, mode) {
  const maneuver = step?.maneuver || {};
  const street = String(step?.name || step?.ref || "the route").trim();
  const modifier = String(maneuver.modifier || "").replaceAll("_", " ");
  const turn = modifier ? ` ${modifier}` : "";
  const destination = street === "the route" ? "" : ` onto ${street}`;
  const type = String(maneuver.type || "continue");
  if (type === "depart") return `${mode === "walk" ? "Walk" : mode === "bike" ? "Ride" : "Head"}${turn}${destination}`;
  if (type === "arrive") return `Arrive at ${street === "the route" ? "your destination" : street}`;
  if (type === "turn") return `Turn${turn}${destination}`;
  if (type === "new name") return `Continue${destination}`;
  if (type === "merge") return `Merge${turn}${destination}`;
  if (type === "fork") return `Keep${turn}${destination}`;
  if (type === "on ramp" || type === "off ramp") return `Take the ${type}${turn}${destination}`;
  if (type === "roundabout" || type === "rotary") {
    const exit = Number.isFinite(maneuver.exit) ? ` and take exit ${maneuver.exit}` : "";
    return `Enter the roundabout${exit}${destination}`;
  }
  return `Continue${turn}${destination}`;
}

async function fetchRoadRoutes(points, mode, alternatives = true) {
  const coordinates = points.map((point) => `${point.lng},${point.lat}`).join(";");
  let body;
  let lastError;
  for (const endpoint of routeEndpoints(mode)) {
    const url = `${endpoint}/${coordinates}?alternatives=${alternatives ? 3 : "false"}&steps=true&geometries=geojson&overview=full`;
    try {
      const response = await fetch(url, { signal: state.routeAbort?.signal });
      if (!response.ok) throw new Error(`Road routing returned ${response.status}`);
      body = await response.json();
      if (body.code === "Ok" && body.routes?.length) break;
      throw new Error(body.message || "No route found");
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
    }
  }
  if (!body?.routes?.length) throw lastError || new Error("OpenStreetMap routing is unavailable");
  if (body.code !== "Ok" || !body.routes?.length) throw new Error(body.message || "No route found");
  return body.routes.map((route, routeIndex) => {
    if (mode === "taxi") return prepareItinerary({
      title: routeIndex === 0 ? "Taxi road-route estimate" : `Taxi alternative ${routeIndex}`,
      segments: [taxiJourneySegment(route, points, (step) => roadInstruction(step, "taxi"))],
      source: "OpenStreetMap + OSRM road-route estimate only · not a booked taxi ride or a verified fare",
      sourceUrl: "https://www.openstreetmap.org/copyright",
    });
    const segments = route.legs.flatMap((leg, legIndex) => {
      const meta = modeMeta(mode === "walk" ? "WALK" : mode === "bike" ? "BIKE" : "CAR");
      const steps = (leg.steps || []).filter((step) => step.geometry?.coordinates?.length);
      if (!steps.length) {
        return [prepareSegment({
          ...meta,
          label: `${meta.name} · Step 1`,
          from: points[legIndex],
          to: points[legIndex + 1],
          points: [points[legIndex], points[legIndex + 1]],
          duration: leg.duration,
          distance: leg.distance,
          instruction: `${meta.name} to ${points[legIndex + 1].name}`,
          live: true,
          stepNumber: 1,
        })];
      }
      return steps.map((step, stepIndex) => {
        const coordinates = [];
        for (const [lng, lat] of step.geometry.coordinates) {
          const last = coordinates.at(-1);
          if (!last || last.lat !== lat || last.lng !== lng) coordinates.push({ lat, lng });
        }
        const first = coordinates[0] || points[legIndex];
        const last = coordinates.at(-1) || points[legIndex + 1];
        const finalStep = stepIndex === steps.length - 1;
        const street = String(step.name || step.ref || "Route").trim();
        return prepareSegment({
          ...meta,
          label: `Step ${stepIndex + 1} · ${street}`,
          from: { ...first, name: stepIndex === 0 ? points[legIndex].name : street },
          to: { ...last, name: finalStep ? points[legIndex + 1].name : street },
          points: coordinates.length > 1 ? coordinates : [first, last],
          duration: step.duration,
          distance: step.distance,
          instruction: roadInstruction(step, mode),
          live: true,
          stepNumber: stepIndex + 1,
          maneuver: step.maneuver,
        });
      });
    });
    return prepareItinerary({
      title: routeIndex === 0 ? "Fastest route" : `Alternative ${routeIndex}`,
      segments,
      source: "OpenStreetMap road data · OSRM routing",
      sourceUrl: "https://www.openstreetmap.org/copyright",
    });
  });
}

async function fetchTransitRoutes(from, to, time) {
  let body;
  let lastError;
  let attempts = 0;
  const controller = new AbortController();
  const parentSignal = state.routeAbort?.signal;
  const cancel = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) cancel();
  else parentSignal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Transit routing reached its time limit.", "TimeoutError")), 11_000);
  try {
    for (const endpoint of TRANSIT_ENDPOINTS) {
      if (attempts >= 2) break;
      const direct = endpoint.startsWith("https://api.transitous.org");
      const params = new URLSearchParams(direct ? {
        fromPlace: `${from.lat},${from.lng}`, toPlace: `${to.lat},${to.lng}`, time: time.toISOString(),
        arriveBy: "false", withFares: "false", numItineraries: "6", maxTransfers: "5", detailedTransfers: "true", realtimeMode: "REALTIME",
        timetableView: "true", transitModes: "TRANSIT", directModes: "", preTransitModes: "WALK", postTransitModes: "WALK",
      } : { from: `${from.lat},${from.lng}`, to: `${to.lat},${to.lng}`, time: time.toISOString() });
      try {
        attempts += 1;
        const response = await fetch(`${endpoint}?${params}`, { signal: controller.signal, headers: { Accept: "application/json" } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || `Transit routing returned ${response.status}`);
        body = { ...payload, itineraries: usableTransitItineraries(payload.itineraries) };
        if (direct && attempts < 2 && new Set(body.itineraries.map(transitRoutePattern)).size < 2) {
          const alternativeParams = new URLSearchParams(params);
          alternativeParams.set("transitModes", "BUS,COACH");
          attempts += 1;
          const alternative = await fetch(`${endpoint}?${alternativeParams}`, { signal: controller.signal, headers: { Accept: "application/json" } });
          if (alternative.ok) {
            const additional = await alternative.json();
            body.itineraries = usableTransitItineraries([...body.itineraries, ...(Array.isArray(additional.itineraries) ? additional.itineraries : [])]);
          }
        }
        break;
      } catch (error) {
        if (parentSignal?.aborted) throw error;
        if (body?.itineraries?.length) break;
        if (controller.signal.aborted) throw error;
        lastError = error;
      }
    }
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", cancel);
  }
  if (!body) throw lastError || new Error("Transit routing failed");
  if (body.note) showToast(body.note);
  return usableTransitItineraries(body.itineraries).map((itinerary, itineraryIndex) => {
    const segments = itinerary.legs.map((leg) => {
      const line = leg.displayName || leg.routeShortName || leg.routeLongName;
      const meta = modeMeta(leg.mode, leg.agencyName, line);
      const geometry = leg.geometry || leg.legGeometry;
      const points = decodePolyline(geometry?.points, geometry?.precision || 6);
      if (!points.length && Number.isFinite(leg.from?.lat) && Number.isFinite(leg.to?.lat)) {
        points.push({ lat: leg.from.lat, lng: leg.from.lon }, { lat: leg.to.lat, lng: leg.to.lon });
      }
      const fromPlace = { lat: leg.from?.lat ?? from.lat, lng: leg.from?.lon ?? from.lng, name: leg.from?.name === "START" ? from.name : (leg.from?.name || from.name) };
      const toPlace = { lat: leg.to?.lat ?? to.lat, lng: leg.to?.lon ?? to.lng, name: leg.to?.name === "END" ? to.name : (leg.to?.name || to.name) };
      const toward = leg.headsign ? ` toward ${leg.headsign}` : "";
      const instruction = meta.mode === "walk" ? `Walk to ${toPlace.name}` : `Take ${meta.name}${toward} to ${toPlace.name}`;
      return prepareSegment({
        ...meta,
        label: meta.name,
        from: fromPlace,
        to: toPlace,
        points,
        duration: leg.duration,
        distance: leg.distance,
        instruction,
        live: leg.realTime,
        agency: leg.agencyName,
        serviceId: leg.tripId || leg.routeId,
        headsign: leg.headsign,
        startTime: leg.startTime,
        endTime: leg.endTime,
      });
    });
    return prepareItinerary({
      title: itineraryIndex === 0 ? "Fastest transit" : itineraryIndex === 1 ? "Transit alternative" : `Option ${itineraryIndex + 1}`,
      segments,
      transfers: itinerary.transfers,
      startTime: itinerary.startTime,
      endTime: itinerary.endTime,
      source: "Transitous public GTFS and GTFS-Realtime",
      sourceUrl: "https://transitous.org/sources/",
    });
  }).filter((route) => route.segments.length);
}

function nearestAirport(point) {
  return AIRPORTS.map(([code, name, lat, lng]) => ({ code, name, lat, lng, miles: distanceMeters(point, { lat, lng }) / 1609.344 }))
    .sort((a, b) => a.miles - b.miles)[0];
}

async function groundTransfer(from, to, time) {
  try {
    const transit = await fetchTransitRoutes(from, to, time);
    if (transit.length) return transit[0].segments;
  } catch (error) {
    if (error.name === "AbortError") throw error;
  }
  if (!state.includeSelfDrive) throw new Error(`No public-transit airport transfer was verified from ${from.name} to ${to.name}. Driving is excluded; please choose a different connection or departure time.`);
  return (await fetchRoadRoutes([from, to], "drive", false))[0].segments;
}

async function flightRoute(from, to, time) {
  const departure = nearestAirport(from);
  const arrival = nearestAirport(to);
  const airDistance = distanceMeters(departure, arrival);
  if (!departure || !arrival || departure.code === arrival.code || airDistance < 160000) {
    throw new Error("These locations are too close for a useful flight itinerary. Choose Transit or Drive.");
  }
  const groundOut = await groundTransfer(from, { ...departure, address: departure.name }, time);
  const groundInTime = new Date(time.getTime() + groundOut.reduce((sum, leg) => sum + (leg.duration || 0), 0) * 1000 + 4 * 60 * 60_000);
  const groundIn = await groundTransfer({ ...arrival, address: arrival.name }, to, groundInTime);
  const airport = prepareSegment({
    ...modeMeta("AIRPORT", null, `Check in at ${departure.code}`),
    label: `Check in · ${departure.code}`,
    from: departure,
    to: departure,
    points: [{ lat: departure.lat, lng: departure.lng }],
    duration: 90 * 60,
    distance: 0,
    instruction: `Check in and go to your gate at ${departure.name}. Follow terminal signs; indoor turn-by-turn guidance is not available.`,
    live: false,
  });
  const flight = prepareSegment({
    ...modeMeta("FLIGHT", null, `${departure.code} to ${arrival.code}`),
    label: `Flight ${departure.code} to ${arrival.code}`,
    from: departure,
    to: arrival,
    points: greatCirclePoints(departure, arrival),
    duration: Math.max(45 * 60, Math.round(airDistance / 225)),
    distance: airDistance,
    instruction: `Fly from ${departure.code} to ${arrival.code}. Verify the actual terminal and schedule with your airline.`,
    live: false,
  });
  const date = (ui.departure.value || new Date().toISOString()).slice(0, 10);
  return prepareItinerary({
    title: `Fly ${departure.code} to ${arrival.code}`,
    segments: [...groundOut, airport, flight, ...groundIn],
    source: "Ground routes: live transit with OpenStreetMap fallback · Flight path and duration: great-circle estimate",
    sourceUrl: `https://www.google.com/travel/flights?hl=en&curr=USD&q=Flights%20from%20${departure.code}%20to%20${arrival.code}%20on%20${date}`,
  });
}

function prepareItinerary(route) {
  route = { ...route, segments: assignRideLegIds(route.segments, state.rideLegIds) };
  const duration = itineraryDurationSeconds(route);
  const distance = route.segments.reduce((sum, segment) => sum + (segment.distance || 0), 0);
  const summary = route.segments
    .map((segment) => segment.stepNumber ? segment.name : segment.label)
    .filter((label, index, labels) => label && (index === 0 || label !== labels[index - 1]))
    .join(" then ");
  const liveLegs = route.segments.filter((segment) => segment.live).length;
  return { ...route, duration, distance, summary, liveLegs };
}

async function sequentialTransit(points, time) {
  const groups = [];
  let cursorTime = new Date(time);
  for (let index = 0; index < points.length - 1; index += 1) {
    const routes = await fetchTransitRoutes(points[index], points[index + 1], cursorTime);
    if (!routes.length) throw new Error(`No transit itinerary was found from ${points[index].name} to ${points[index + 1].name}.`);
    groups.push(routes);
    cursorTime = onwardTransitTime(routes[0], cursorTime);
  }
  const count = points.length > 2 ? 1 : Math.min(3, ...groups.map((group) => group.length));
  return Array.from({ length: Math.max(1, count) }, (_, index) => {
    const picked = groups.map((group) => group[index] || group[0]);
    return prepareItinerary({
      title: index === 0 ? "Fastest transit" : `Transit alternative ${index}`,
      segments: picked.flatMap((route) => route.segments),
      transfers: picked.reduce((sum, route) => sum + (route.transfers || 0), 0),
      startTime: picked[0].startTime,
      endTime: picked.at(-1).endTime,
      source: "Transitous public GTFS and GTFS-Realtime",
      sourceUrl: "https://transitous.org/sources/",
    });
  });
}

async function loadRoutes(options = {}) {
  const points = tripPoints();
  if (points.length < 2 || rideCheckout.isOpen() || tripReceipt.isOpen()) return;
  const resumeNavigation = state.navigating && options.newJourney !== true;
  const previous = resumeNavigation ? { routes: state.routes, selectedRoute: state.selectedRoute, activeLeg: state.activeLeg, legProgress: state.legProgress, legProjection: state.legProjection } : null;
  if (!resumeNavigation) {
    state.rideLegIds.clear();
    state.completedRideLegs.clear();
    state.completedRideDescriptors.clear();
    state.ridePromptCooldowns.clear();
    state.paymentSession = crypto.randomUUID();
    state.journeyFrom = points[0].name;
    state.journeyTo = points.at(-1).name;
    state.hasPaymentAttempt = false;
    state.receiptSessionLost = false;
    state.journeyFinalized = false;
  }
  state.routeAbort?.abort();
  state.routeAbort = new AbortController();
  if (!resumeNavigation) state.routes = [];
  state.selectedRoute = 0;
  state.navigating = resumeNavigation;
  clearRouteLayers();
  ui.setup.classList.toggle("hidden", resumeNavigation);
  ui.navigation.classList.toggle("hidden", !resumeNavigation);
  ui.status.textContent = state.mode === "transit" ? "Checking public schedules and live feeds…" : state.mode === "flight" ? "Building airport transfers and flight path…" : "Calculating street routes…";
  ui.options.innerHTML = "";
  ui.legList.innerHTML = "";
  ui.start.disabled = true;
  ui.destinationName.textContent = `${points[0].name} to ${points.at(-1).name}`;
  ui.destinationAddress.textContent = state.waypoints.length ? `${state.waypoints.length} planned stop${state.waypoints.length > 1 ? "s" : ""}` : points.at(-1).address || "";
  ui.destinationLabel.textContent = points.at(-1).name;
  ui.routeKicker.textContent = state.mode === "transit" ? "Multimodal transit" : state.mode === "flight" ? "Airport journey" : "Route options";
  try {
    const requestedTime = ui.departure.value ? new Date(ui.departure.value) : new Date();
    if (state.mode === "transit") state.routes = await sequentialTransit(points, requestedTime);
    else if (state.mode === "flight") {
      const routes = [];
      for (let index = 0; index < points.length - 1; index += 1) routes.push(await flightRoute(points[index], points[index + 1], requestedTime));
      state.routes = [prepareItinerary({ title: routes.length > 1 ? "Multi-flight journey" : routes[0].title, segments: routes.flatMap((route) => route.segments), source: routes[0].source, sourceUrl: routes[0].sourceUrl })];
    } else state.routes = await fetchRoadRoutes(points, state.mode, true);
    if (!state.routes.length) throw new Error("No route was returned for these locations and departure time.");
    state.routes.sort((a, b) => a.duration - b.duration);
    if (resumeNavigation) state.journeyTo = points.at(-1).name;
    renderRoutes();
    collapsePlanner(true);
    if (resumeNavigation) startNavigation();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (state.mode === "transit") {
      ui.status.textContent = "Live transit is unavailable. Loading an OpenStreetMap walking fallback…";
      try {
        state.routes = (await fetchRoadRoutes(points, "walk", true)).map((route, index) => ({
          ...route,
          title: index === 0 ? "OpenStreetMap fallback" : `Walking fallback ${index + 1}`,
          fallback: true,
        }));
        if (resumeNavigation) state.journeyTo = points.at(-1).name;
        renderRoutes();
        collapsePlanner(true);
        if (resumeNavigation) startNavigation();
        showToast("Live transit was unavailable, so an OpenStreetMap walking route is shown.");
        return;
      } catch (fallbackError) {
        if (fallbackError.name === "AbortError") return;
      }
    }
    ui.status.textContent = error.message || "Route planning is temporarily unavailable.";
    ui.routeSource.textContent = "OpenStreetMap routing is also unavailable. Try again or place a nearby point.";
    showToast(ui.status.textContent);
    if (previous) {
      Object.assign(state, previous);
      state.navigating = true;
      ui.setup.classList.add("hidden");
      ui.navigation.classList.remove("hidden");
      renderRoutes();
    }
  }
}

function lineStyle(segment, selected, alternative = false) {
  const dashed = segment.mode === "flight" ? "10 12" : segment.mode === "walk" ? "3 8" : undefined;
  return {
    color: alternative ? "#b9a6ff" : selected ? "#6d4cff" : "#b9a6ff",
    weight: alternative ? 5 : 9,
    opacity: alternative ? 0.48 : 0.96,
    dashArray: dashed,
    lineCap: "round",
    lineJoin: "round",
  };
}

function clearProgressLayers() {
  state.progressLayers.forEach((layer) => layer.remove());
  state.progressLayers = [];
}

function markerForSegment(segment) {
  return segment.icon || modeMeta(segment.mode).icon;
}

function renderRoutes() {
  clearRouteLayers();
  const selected = state.routes[state.selectedRoute];
  state.routes.slice().reverse().forEach((route) => {
    const active = route === selected;
    route.segments.forEach((segment) => {
      if (segment.points.length < 2) return;
      const casing = L.polyline(segment.points.map((point) => [point.lat, point.lng]), { color: "#2b1b3d", weight: active ? 13 : 8, opacity: active ? .86 : .42, lineCap: "round" }).addTo(map);
      const line = L.polyline(segment.points.map((point) => [point.lat, point.lng]), lineStyle(segment, active, !active)).addTo(map);
      line.on("click", () => selectRoute(state.routes.indexOf(route)));
      state.routeLayers.push(casing, line);
    });
  });
  selected.segments.slice(1).forEach((segment, index) => {
    const previous = selected.segments[index];
    if (segment.stepNumber && previous?.mode === segment.mode) return;
    const point = segment.points[0] || segment.from;
    if (!point) return;
    const marker = L.marker([point.lat, point.lng], { icon: transferIcon(markerForSegment(segment)), zIndexOffset: 900, title: segment.label }).addTo(map);
    marker.on("click", () => focusLeg(index + 1));
    state.transferMarkers.push(marker);
  });
  ui.status.textContent = `${state.routes.length} route${state.routes.length > 1 ? "s" : ""} · tap a route or journey leg to focus it`;
  ui.options.innerHTML = state.routes.map((route, index) => {
    const end = route.endTime ? arrivalText(0, route.endTime) : arrivalText(route.duration);
    const roadSteps = route.segments.filter((segment) => segment.stepNumber).length;
    const detail = roadSteps === route.segments.length
      ? `${roadSteps} numbered step${roadSteps === 1 ? "" : "s"} · ${metersText(route.distance)}`
      : state.mode === "transit"
        ? `${route.transfers || 0} transfer${route.transfers === 1 ? "" : "s"} · ${route.liveLegs} current leg${route.liveLegs === 1 ? "" : "s"}`
        : metersText(route.distance);
    return `<button class="route-option ${index === state.selectedRoute ? "selected" : ""}" data-route="${index}" type="button"><b>${escapeHtml(route.title)}</b><strong>${durationText(route.duration)}</strong><span>Arrive ${end} · ${detail}</span><em>${escapeHtml(route.summary)}</em></button>`;
  }).join("");
  $$(".route-option").forEach((button) => button.addEventListener("click", () => selectRoute(Number(button.dataset.route))));
  renderLegList();
  ui.routeSource.innerHTML = `${escapeHtml(selected.source)} · <a href="${escapeHtml(selected.sourceUrl)}" target="_blank" rel="noreferrer">source</a>`;
  ui.start.disabled = false;
  ui.start.textContent = `Start trip · ${durationText(selected.duration)}`;
  const allPoints = selected.segments.flatMap((segment) => segment.points);
  if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints.map((point) => [point.lat, point.lng])), { paddingTopLeft: [50, 90], paddingBottomRight: [50, window.innerWidth < 760 ? 420 : 90], maxZoom: 17 });
}

function renderLegList(activeIndex = -1) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  ui.legList.innerHTML = route.segments.map((segment, index) => `
    <button class="leg-chip ${index === activeIndex ? "active" : ""}" data-leg="${index}" type="button">
      <span>${segment.icon} ${escapeHtml(segment.stepNumber ? `Step ${segment.stepNumber}` : segment.label)}</span>
      <b>${escapeHtml(segment.to?.name || "Next point")}</b>
      <small>${durationText(segment.duration)} · ${segment.live ? "live" : "scheduled/estimated"}</small>
    </button>`).join("");
  $$(".leg-chip").forEach((button) => button.addEventListener("click", () => focusLeg(Number(button.dataset.leg))));
}

function selectRoute(index) {
  state.selectedRoute = index;
  state.activeLeg = 0;
  state.legProgress = 0;
  state.legProjection = null;
  renderRoutes();
}

function focusLeg(index) {
  const segment = state.routes[state.selectedRoute]?.segments[index];
  if (!segment) return;
  renderLegList(index);
  if (segment.points.length > 1) map.fitBounds(L.latLngBounds(segment.points.map((point) => [point.lat, point.lng])), { padding: [90, 90], maxZoom: 17 });
  else if (segment.from) map.setView([segment.from.lat, segment.from.lng], 17);
}

function instructionFor(segment) {
  if (!segment) return { icon: "●", text: "You have arrived" };
  return { icon: segment.stepNumber ? String(segment.stepNumber) : segment.icon || "•", text: segment.instruction || `${segment.label} to ${segment.to?.name || "the next stop"}` };
}

function routeProgress(route) {
  const total = route.segments.reduce((sum, segment) => sum + Math.max(1, segment.duration || 0), 0);
  const complete = route.segments.slice(0, state.activeLeg).reduce((sum, segment) => sum + Math.max(1, segment.duration || 0), 0);
  const active = route.segments[state.activeLeg];
  return total ? Math.min(1, (complete + Math.max(1, active?.duration || 0) * state.legProgress) / total) : 0;
}

function renderProgressOnMap(projection) {
  clearProgressLayers();
  const route = state.routes[state.selectedRoute];
  route.segments.forEach((segment, index) => {
    if (segment.points.length < 2 || index > state.activeLeg) return;
    const points = index < state.activeLeg ? segment.points : partialPath(segment.points, projection);
    if (points.length < 2) return;
    const casing = L.polyline(points.map((point) => [point.lat, point.lng]), { color: "#2b1b3d", weight: 11, opacity: .96, lineCap: "round" }).addTo(map);
    const line = L.polyline(points.map((point) => [point.lat, point.lng]), { color: "#ffd84d", weight: 7, opacity: 1, lineCap: "round", dashArray: segment.mode === "flight" ? "10 12" : undefined }).addTo(map);
    state.progressLayers.push(casing, line);
  });
}

function setActiveLeg(index, progress = 0) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  state.activeLeg = Math.max(0, Math.min(route.segments.length - 1, index));
  state.legProgress = Math.max(0, Math.min(1, progress));
  state.legProjection = null;
  state.offRouteUpdates = 0;
  renderLegList(state.activeLeg);
  updateNavigation(state.user);
}

function checkoutCompletedRide(segment, onContinue) {
  const descriptor = rideCompletionDescriptor(segment);
  if (!descriptor || state.completedRideLegs.has(segment.rideLegId)) return false;
  if (rideCheckout.isOpen() || tripReceipt.isOpen()) return true;
  const session = state.paymentSession;
  let resolved = false;
  rideCheckout.open({
    ...descriptor,
    journeyId: session,
    hasPaymentAttempt: state.hasPaymentAttempt,
    sessionLost: state.receiptSessionLost,
    preview: !state.startLive || !state.user || descriptor.mode === "taxi",
    onContinue: (outcome = {}) => {
      if (resolved || state.paymentSession !== session) return;
      resolved = true;
      state.hasPaymentAttempt ||= Boolean(outcome.attempted || outcome.receipt || outcome.sessionLost);
      state.receiptSessionLost ||= Boolean(outcome.sessionLost);
      state.completedRideLegs.add(segment.rideLegId);
      const expectedReceiptId = typeof outcome.receipt?.id === "string" && outcome.receipt.id.length < 200 ? outcome.receipt.id : undefined;
      state.completedRideDescriptors.set(segment.rideLegId, { ...descriptor, ...(expectedReceiptId ? { expectedReceiptId } : {}) });
      onContinue();
    },
    onDismiss: (outcome = {}) => {
      if (resolved || state.paymentSession !== session) return;
      resolved = true;
      state.hasPaymentAttempt ||= Boolean(outcome.attempted || outcome.sessionLost);
      state.receiptSessionLost ||= Boolean(outcome.sessionLost);
      state.ridePromptCooldowns.set(segment.rideLegId, Date.now() + 60_000);
      updateNavigation(state.user);
    },
  });
  return true;
}

async function recordPostTripCompletion() {
  try {
    const response = await fetch("/api/map/trip-completion", { method: "POST", credentials: "same-origin", keepalive: true, headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      showToast(body.error || "Post-trip review could not be saved. Finish the route again when connected.", 6500);
      return false;
    }
    if (body.connected) {
      showToast(body.needsHuman
        ? "Trip completion was recorded. An organizer will verify attendance before reimbursement review."
        : "Trip completion was recorded for post-trip review.", 6500);
    }
    return true;
  } catch {
    showToast("Post-trip review could not be saved. Finish the route again when connected.", 6500);
    return false;
  }
}

function finishJourney() {
  if (rideCheckout.isOpen() || tripReceipt.isOpen()) return;
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  const session = state.paymentSession;
  let resolved = false;
  tripReceipt.open({
    journeyId: session,
    from: state.journeyFrom || route.segments[0]?.from?.name || "Your starting point",
    to: state.journeyTo || route.segments.at(-1)?.to?.name || "Your destination",
    legs: [...state.completedRideDescriptors.values()].map((leg) => ({ ...leg })),
    hasPaymentAttempt: state.hasPaymentAttempt,
    sessionLost: state.receiptSessionLost,
    onContinue: async () => {
      if (resolved || state.paymentSession !== session) return;
      resolved = true;
      const recorded = await recordPostTripCompletion();
      if (!recorded || state.paymentSession !== session) return;
      state.journeyFinalized = true;
      endNavigation();
    },
    onDismiss: (outcome = {}) => {
      if (resolved || state.paymentSession !== session) return;
      resolved = true;
      state.hasPaymentAttempt ||= Boolean(outcome.attempted || outcome.sessionLost);
      state.receiptSessionLost ||= Boolean(outcome.sessionLost);
    },
  });
}

function advanceNavigationStep(finish = false) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  if (finish || state.activeLeg >= route.segments.length - 1) return finishJourney();
  setActiveLeg(state.activeLeg + 1, 0);
  focusLeg(state.activeLeg);
}

function completeNavigationStep(finish = false) {
  if (rideCheckout.isOpen() || tripReceipt.isOpen()) return;
  const route = state.routes[state.selectedRoute];
  const segment = route?.segments[state.activeLeg];
  if (!route || !segment) return;
  const advance = () => advanceNavigationStep(finish);
  if (!checkoutCompletedRide(segment, advance)) advance();
}

function updateNavigation(position) {
  if (rideCheckout.isOpen() || tripReceipt.isOpen() || state.rerouting) return;
  const route = state.routes[state.selectedRoute];
  const segment = route?.segments[state.activeLeg];
  if (!route || !segment) return;
  let projection = { index: 0, t: 0, projected: segment.points[0] || segment.from, distance: Infinity, progress: state.legProgress };
  if (position && segment.points.length > 1) {
    const candidate = projectOnPath(segment.points, segment.cumulative, position);
    projection = candidate;
    const threshold = Math.max(80, (position.accuracy || 25) * 1.5);
    if (candidate.distance <= threshold && candidate.progress >= state.legProgress) {
      state.legProgress = candidate.progress;
      state.legProjection = candidate;
    } else if (state.legProjection) projection = state.legProjection;
    if (candidate.distance > Math.max(120, (position.accuracy || 25) * 2)) state.offRouteUpdates += 1;
    else state.offRouteUpdates = 0;
    if (state.offRouteUpdates >= 4 && state.startLive && Date.now() >= state.rerouteAfter) {
      state.rerouteAfter = Date.now() + 30_000;
      if (ridePaymentMode(segment) && !state.completedRideLegs.has(segment.rideLegId)) {
        state.offRouteUpdates = 0;
        showToast("Your position differs from this ride's planned route. Check with your driver or operator, and confirm when you have left the vehicle before continuing.", 6500);
      } else {
        state.rerouting = true;
        state.offRouteUpdates = 0;
        showToast("You are off route. Recalculating from your live position…");
        loadRoutes({ resumeNavigation: true }).finally(() => { state.rerouting = false; updateNavigation(state.user); });
        return;
      }
    }
    if (ridePaymentMode(segment)) {
      if (state.startLive && rideNearArrival(segment, position, state.legProgress) && !state.completedRideLegs.has(segment.rideLegId) && Date.now() >= (state.ridePromptCooldowns.get(segment.rideLegId) || 0)) {
        if (checkoutCompletedRide(segment, () => advanceNavigationStep())) return;
      }
      if (state.completedRideLegs.has(segment.rideLegId) && state.legProgress > .985 && state.activeLeg < route.segments.length - 1) return completeNavigationStep();
    } else if (state.legProgress > .985 && state.activeLeg < route.segments.length - 1) {
      return completeNavigationStep();
    }
    if (projection.distance > threshold) ui.stepDistance.textContent = `${metersText(projection.distance)} from route`;
  }
  projection.progress = state.legProgress;
  if (segment.points.length > 1) {
    const targetDistance = segment.distance * (1 - state.legProgress);
    ui.stepDistance.textContent = !position
      ? "Preview this step"
      : projection.distance > Math.max(80, (position.accuracy || 25) * 1.5)
        ? `${metersText(projection.distance)} from route`
        : `${metersText(targetDistance)} on this step`;
  } else ui.stepDistance.textContent = "Advance when complete";
  const instruction = instructionFor(segment);
  ui.stepInstruction.textContent = instruction.text;
  ui.maneuver.textContent = instruction.icon;
  const remainingDistance = route.segments.slice(state.activeLeg).reduce((sum, item, index) => sum + (item.distance || 0) * (index ? 1 : 1 - state.legProgress), 0);
  const remainingSeconds = route.segments.slice(state.activeLeg).reduce((sum, item, index) => sum + (item.duration || 0) * (index ? 1 : 1 - state.legProgress), 0);
  const overall = routeProgress(route);
  ui.remaining.textContent = metersText(remainingDistance);
  ui.arrival.textContent = arrivalText(remainingSeconds);
  ui.currentStreet.textContent = segment.label;
  ui.progressPercent.textContent = `${Math.round(overall * 100)}%`;
  ui.overallProgress.style.width = `${Math.round(overall * 100)}%`;
  ui.activeLegSummary.textContent = `Step ${state.activeLeg + 1} of ${route.segments.length} · ${segment.live ? "Live timing" : "Scheduled or estimated timing"} · ${segment.from?.name || "Start"} to ${segment.to?.name || "Next point"}`;
  ui.previousLeg.disabled = state.activeLeg === 0;
  ui.nextLeg.textContent = state.activeLeg === route.segments.length - 1 ? "Finish trip" : "Next step";
  renderLegList(state.activeLeg);
  renderProgressOnMap(projection);
}

function startNavigation() {
  let route = state.routes[state.selectedRoute];
  if (!route) return;
  if (state.journeyFinalized) {
    state.paymentSession = crypto.randomUUID();
    state.rideLegIds.clear();
    state.completedRideLegs.clear();
    state.completedRideDescriptors.clear();
    state.ridePromptCooldowns.clear();
    state.hasPaymentAttempt = false;
    state.receiptSessionLost = false;
    state.journeyFinalized = false;
    state.journeyFrom = route.segments[0]?.from?.name || "Your starting point";
    state.journeyTo = route.segments.at(-1)?.to?.name || "Your destination";
    state.routes = state.routes.map((option) => ({ ...option, segments: assignRideLegIds(option.segments, state.rideLegIds) }));
    route = state.routes[state.selectedRoute];
  }
  state.navigating = true;
  state.activeLeg = 0;
  state.legProgress = 0;
  state.legProjection = null;
  state.offRouteUpdates = 0;
  state.follow = true;
  ui.setup.classList.add("hidden");
  ui.navigation.classList.remove("hidden");
  ui.recenter.classList.add("active");
  collapsePlanner(true);
  if (state.user) map.setView([state.user.lat, state.user.lng], 17, { animate: true });
  else showToast("Guidance is in preview mode. Enable GPS for live on-map progress.");
  updateNavigation(state.user);
}

function endNavigation() {
  state.navigating = false;
  clearProgressLayers();
  ui.navigation.classList.add("hidden");
  ui.setup.classList.remove("hidden");
  ui.recenter.classList.remove("active");
  state.activeLeg = 0;
  state.legProgress = 0;
  state.legProjection = null;
  state.offRouteUpdates = 0;
  renderRoutes();
}

function resetRoutes() {
  state.routeAbort?.abort();
  state.routes = [];
  state.navigating = false;
  clearRouteLayers();
  ui.setup.classList.add("hidden");
  ui.navigation.classList.add("hidden");
  collapsePlanner(false);
}

ui.departure.value = localDateTime();
ui.permissionButton.addEventListener("click", requestLocation);
ui.useLiveStart.addEventListener("click", () => {
  state.startLive = true;
  state.start = null;
  ui.startInput.value = "My live location";
  ui.useLiveStart.classList.add("active");
  setActiveField({ type: "destination" });
  if (!state.user) requestLocation();
  updatePlannerState();
  updatePointMarkers();
});
ui.startInput.addEventListener("focus", () => setActiveField({ type: "start" }));
ui.startInput.addEventListener("input", () => {
  if (ui.startInput.value !== "My live location") {
    state.startLive = false;
    state.start = null;
    ui.useLiveStart.classList.remove("active");
  }
  updatePlannerState();
});
ui.destinationInput.addEventListener("focus", () => setActiveField({ type: "destination" }));
ui.destinationInput.addEventListener("input", () => {
  if (ui.destinationInput.value !== state.destination?.name) state.destination = null;
  updatePlannerState();
});
ui.planner.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = fieldInput();
  const query = input?.value.trim();
  if (query && !(state.activeField.type === "start" && state.startLive)) searchPlaces(query);
});
ui.addStop.addEventListener("click", () => {
  if (state.waypoints.length >= 4) return showToast("Up to four intermediate stops are supported.");
  const waypoint = { id: state.nextWaypointId++, place: null };
  state.waypoints.push(waypoint);
  renderWaypoints();
  setActiveField({ type: "waypoint", id: waypoint.id });
  fieldInput()?.focus();
  updatePlannerState();
});
ui.plan.addEventListener("click", loadRoutes);
ui.togglePlanner.addEventListener("click", () => collapsePlanner(!ui.planner.classList.contains("collapsed")));
ui.editRoute.addEventListener("click", () => collapsePlanner(false));
ui.closeRoute.addEventListener("click", resetRoutes);
ui.start.addEventListener("click", startNavigation);
ui.end.addEventListener("click", endNavigation);
ui.previousLeg.addEventListener("click", () => setActiveLeg(state.activeLeg - 1, 0));
ui.nextLeg.addEventListener("click", () => completeNavigationStep());
ui.recenter.addEventListener("click", () => {
  if (!state.user) return requestLocation();
  state.follow = true;
  ui.recenter.classList.add("active");
  map.setView([state.user.lat, state.user.lng], state.navigating ? 17 : Math.max(map.getZoom(), 15), { animate: true });
});
ui.orientation.addEventListener("click", () => {
  state.followHeading = !state.followHeading;
  ui.orientation.classList.toggle("active", state.followHeading);
  if (state.followHeading && state.lastHeading === null) showToast("Move a short distance so the device can determine your direction.");
});
$$(".mode-tab").forEach((button) => button.addEventListener("click", () => {
  state.mode = button.dataset.mode;
  if (state.mode === "drive") state.includeSelfDrive = true;
  $$(".mode-tab").forEach((item) => {
    item.classList.toggle("active", item === button);
    item.setAttribute("aria-selected", String(item === button));
  });
  if (tripPoints().length > 1) loadRoutes();
}));

const stopFollowingMap = () => {
  state.follow = false;
  ui.recenter.classList.remove("active");
};
map.on("dragstart boxzoomstart dblclick", stopFollowingMap);
for (const type of ["wheel", "touchstart", "keydown"]) map.getContainer().addEventListener(type, (event) => {
  if (userMapInteraction(type, event)) stopFollowingMap();
}, { passive: true });
let pressTimer;
map.on("mousedown touchstart", (event) => {
  pressTimer = setTimeout(async () => {
    const place = await reversePlace(event.latlng.lat, event.latlng.lng);
    setPoint(state.activeField, { lat: event.latlng.lat, lng: event.latlng.lng, ...place });
  }, 650);
});
map.on("mouseup touchend mousemove", () => clearTimeout(pressTimer));

const params = new URLSearchParams(location.search);
state.includeSelfDrive = params.get("includeSelfDrive") !== "false";
const requestedMode = params.get("mode");
const initialMode = requestedMode === "flight"
  ? "flight"
  : requestedMode === "taxi" || requestedMode === "rideshare"
    ? "taxi"
  : requestedMode === "drive"
    ? state.includeSelfDrive ? "drive" : "transit"
    : requestedMode === "walk"
      ? "walk"
      : requestedMode === "train" || requestedMode === "bus" || requestedMode === "transit"
        ? "transit"
        : null;
if (initialMode) {
  state.mode = initialMode;
  $$(".mode-tab").forEach((item) => {
    const active = item.dataset.mode === initialMode;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
}
const destinationLat = params.has("lat") ? Number(params.get("lat")) : NaN;
const destinationLng = params.has("lng") ? Number(params.get("lng")) : params.has("lon") ? Number(params.get("lon")) : NaN;
if (Number.isFinite(destinationLat) && Number.isFinite(destinationLng)) {
  const suppliedName = params.get("to")?.trim();
  reversePlace(destinationLat, destinationLng).then((place) => setPoint({ type: "destination" }, { lat: destinationLat, lng: destinationLng, ...place, ...(suppliedName ? { name: suppliedName } : {}) }));
} else if (params.get("to")) {
  ui.destinationInput.value = params.get("to");
  setActiveField({ type: "destination" });
}

renderWaypoints();
updatePlannerState();
