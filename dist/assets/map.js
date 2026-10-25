const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ui = {
  form: $("#search-form"), input: $("#destination-input"), results: $("#search-results"), hint: $("#search-hint"),
  clear: $("#clear-search"), back: $("#back-button"), permission: $("#permission-card"), permissionButton: $("#location-permission"),
  recenter: $("#recenter"), orientation: $("#orientation"), setup: $("#route-setup"), closeRoute: $("#close-route"),
  destinationName: $("#destination-name"), destinationAddress: $("#destination-address"), status: $("#route-status"),
  options: $("#route-options"), start: $("#start-navigation"), navigation: $("#navigation-panel"), end: $("#end-navigation"),
  stepDistance: $("#step-distance"), stepInstruction: $("#step-instruction"), maneuver: $("#maneuver-icon"),
  remaining: $("#remaining-distance"), arrival: $("#arrival-time"), accuracy: $("#gps-accuracy"), currentStreet: $("#current-street"),
  progressPercent: $("#progress-percent"), destinationLabel: $("#route-destination"), roadProgress: $("#road-progress"), progressDot: $("#progress-dot"),
  toast: $("#toast"),
};

const state = {
  user: null, destination: null, watchId: null, mode: "drive", routes: [], selectedRoute: 0,
  routeLayers: [], userMarker: null, accuracyCircle: null, destinationMarker: null, progressLayer: null,
  navigating: false, follow: true, followHeading: false, lastHeading: null, searchAbort: null, routeAbort: null,
  lastRerouteAt: 0, lastReverseAt: 0,
};

const map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true }).setView([34.0522, -118.2437], 11);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const userIcon = L.divIcon({ className: "", html: '<div class="user-marker"></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
const destinationIcon = L.divIcon({ className: "", html: '<div class="destination-marker">●</div>', iconSize: [28, 36], iconAnchor: [14, 36] });

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function showToast(message, timeout = 3500) {
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
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} hr ${mins % 60 ? `${mins % 60} min` : ""}`.trim();
}

function arrivalText(seconds) {
  const when = new Date(Date.now() + Math.max(0, seconds) * 1000);
  return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const p1 = a.lat * rad;
  const p2 = b.lat * rad;
  const dp = (b.lat - a.lat) * rad;
  const dl = (b.lng - a.lng) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function routeEndpoint(mode) {
  if (mode === "walk") return "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
  if (mode === "bike") return "https://routing.openstreetmap.de/routed-bike/route/v1/driving";
  return "https://router.project-osrm.org/route/v1/driving";
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
    maximumAge: 1500,
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
  ui.accuracy.textContent = `±${Math.round(next.accuracy)} m`;
  if (!state.userMarker) {
    state.userMarker = L.marker([next.lat, next.lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
    state.accuracyCircle = L.circle([next.lat, next.lng], { radius: next.accuracy, color: "#75a9ff", fillColor: "#5f9dff", fillOpacity: 0.12, weight: 1 }).addTo(map);
    map.setView([next.lat, next.lng], 16);
  } else {
    state.userMarker.setLatLng([next.lat, next.lng]);
    state.accuracyCircle.setLatLng([next.lat, next.lng]).setRadius(next.accuracy);
  }
  if (next.heading !== null) state.lastHeading = next.heading;
  const marker = state.userMarker.getElement()?.querySelector(".user-marker");
  if (marker) marker.style.transform = `rotate(${state.followHeading && state.lastHeading !== null ? state.lastHeading - 45 : -45}deg)`;
  if (state.follow) map.panTo([next.lat, next.lng], { animate: true, duration: 0.45 });
  if (state.destination && !state.routes.length) loadRoutes();
  if (state.navigating) updateNavigation(next);
}

function onLocationError(error) {
  ui.permission.classList.remove("hidden");
  ui.permissionButton.disabled = false;
  ui.permissionButton.textContent = "Try GPS again";
  const messages = {
    1: "Location access is blocked. Allow it in your browser settings, then try again.",
    2: "Your device could not determine its position. Move near a window or enable device location.",
    3: "Location took too long. Try again in an area with a clearer GPS signal.",
  };
  ui.permission.querySelector("span").textContent = messages[error.code] || "Your live position is currently unavailable.";
}

async function searchPlaces(query) {
  state.searchAbort?.abort();
  state.searchAbort = new AbortController();
  ui.results.classList.remove("hidden");
  ui.results.innerHTML = '<div class="route-status">Searching OpenStreetMap…</div>';
  try {
    const viewbox = map.getBounds();
    const params = new URLSearchParams({
      format: "jsonv2", q: query, limit: "5", addressdetails: "1",
      viewbox: `${viewbox.getWest()},${viewbox.getNorth()},${viewbox.getEast()},${viewbox.getSouth()}`,
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal: state.searchAbort.signal, headers: { "Accept-Language": navigator.language || "en" } });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    const places = await response.json();
    if (!places.length) {
      ui.results.innerHTML = '<div class="route-status">No matching places. Try a full street address.</div>';
      return;
    }
    ui.results.innerHTML = places.map((place, index) => {
      const shortName = place.name || place.display_name.split(",")[0];
      return `<button class="search-result" type="button" data-index="${index}"><span class="result-pin">↗</span><div><b>${escapeHtml(shortName)}</b><span>${escapeHtml(place.display_name)}</span></div></button>`;
    }).join("");
    $$(".search-result").forEach((button) => button.addEventListener("click", () => chooseDestination({
      lat: Number(places[Number(button.dataset.index)].lat), lng: Number(places[Number(button.dataset.index)].lon),
      name: places[Number(button.dataset.index)].name || places[Number(button.dataset.index)].display_name.split(",")[0],
      address: places[Number(button.dataset.index)].display_name,
    })));
  } catch (error) {
    if (error.name !== "AbortError") ui.results.innerHTML = '<div class="route-status">Search is temporarily unavailable. You can press and hold the map to set the destination.</div>';
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

async function chooseDestination(destination) {
  state.destination = destination;
  state.routes = [];
  state.selectedRoute = 0;
  state.navigating = false;
  clearRouteLayers();
  if (state.destinationMarker) state.destinationMarker.remove();
  state.destinationMarker = L.marker([destination.lat, destination.lng], { icon: destinationIcon, zIndexOffset: 900 }).addTo(map);
  ui.destinationName.textContent = destination.name;
  ui.destinationAddress.textContent = destination.address;
  ui.destinationLabel.textContent = destination.name;
  ui.input.value = destination.name;
  ui.clear.classList.remove("hidden");
  ui.back.classList.remove("hidden");
  ui.results.classList.add("hidden");
  ui.hint.classList.add("hidden");
  ui.navigation.classList.add("hidden");
  ui.setup.classList.remove("hidden");
  ui.start.disabled = true;
  if (state.user) loadRoutes();
  else ui.status.textContent = "Enable GPS to calculate routes from your live position.";
}

function clearRouteLayers() {
  state.routeLayers.forEach((layer) => layer.remove());
  state.routeLayers = [];
  if (state.progressLayer) state.progressLayer.remove();
  state.progressLayer = null;
}

async function loadRoutes() {
  if (!state.user || !state.destination) return;
  state.routeAbort?.abort();
  state.routeAbort = new AbortController();
  ui.status.textContent = "Calculating live routes…";
  ui.options.innerHTML = "";
  ui.start.disabled = true;
  clearRouteLayers();
  const from = `${state.user.lng},${state.user.lat}`;
  const to = `${state.destination.lng},${state.destination.lat}`;
  const url = `${routeEndpoint(state.mode)}/${from};${to}?alternatives=3&steps=true&geometries=geojson&overview=full&annotations=false`;
  try {
    const response = await fetch(url, { signal: state.routeAbort.signal });
    if (!response.ok) throw new Error(`Routing returned ${response.status}`);
    const body = await response.json();
    if (body.code !== "Ok" || !body.routes?.length) throw new Error(body.message || "No route found");
    state.routes = body.routes.map(prepareRoute);
    state.selectedRoute = 0;
    renderRoutes();
  } catch (error) {
    if (error.name === "AbortError") return;
    ui.status.textContent = "A route could not be calculated. Try another mode or move the destination pin closer to a mapped road.";
    showToast(error.message || "Route unavailable");
  }
}

function prepareRoute(route) {
  const points = route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) cumulative.push(cumulative[i - 1] + distanceMeters(points[i - 1], points[i]));
  const steps = route.legs.flatMap((leg) => leg.steps).map((step) => ({
    ...step,
    point: { lat: step.maneuver.location[1], lng: step.maneuver.location[0] },
  }));
  return { ...route, points, cumulative, steps };
}

function renderRoutes() {
  clearRouteLayers();
  const selected = state.routes[state.selectedRoute];
  state.routes.slice().reverse().forEach((route) => {
    const originalIndex = state.routes.indexOf(route);
    const layer = L.geoJSON(route.geometry, {
      style: { color: originalIndex === state.selectedRoute ? "#dfff82" : "#788078", weight: originalIndex === state.selectedRoute ? 7 : 5, opacity: originalIndex === state.selectedRoute ? 1 : .75 },
    }).addTo(map);
    layer.on("click", () => selectRoute(originalIndex));
    state.routeLayers.push(layer);
  });
  ui.status.textContent = `${state.routes.length} ${state.routes.length === 1 ? "route" : "routes"} available · tap a line or option to compare`;
  ui.options.innerHTML = state.routes.map((route, index) => {
    const difference = index === 0 ? "Recommended" : `${Math.max(1, Math.round((route.duration - state.routes[0].duration) / 60))} min slower`;
    return `<button class="route-option ${index === state.selectedRoute ? "selected" : ""}" data-route="${index}" type="button"><b>${index === 0 ? "Fastest route" : `Alternative ${index}`}</b><strong>${durationText(route.duration)}</strong><span>${metersText(route.distance)} · ${difference}</span></button>`;
  }).join("");
  $$(".route-option").forEach((button) => button.addEventListener("click", () => selectRoute(Number(button.dataset.route))));
  ui.start.disabled = false;
  ui.start.textContent = `Start · ${durationText(selected.duration)}`;
  if (!state.navigating) {
    const bounds = L.latLngBounds(selected.points.map((point) => [point.lat, point.lng]));
    map.fitBounds(bounds, { paddingTopLeft: [40, 100], paddingBottomRight: [40, window.innerWidth < 760 ? 360 : 80], maxZoom: 17 });
  }
}

function selectRoute(index) {
  state.selectedRoute = index;
  renderRoutes();
}

function nearestRoutePoint(route, position) {
  let index = 0;
  let distance = Infinity;
  route.points.forEach((point, pointIndex) => {
    const candidate = distanceMeters(position, point);
    if (candidate < distance) { distance = candidate; index = pointIndex; }
  });
  return { index, distance, traveled: route.cumulative[index], progress: Math.min(1, route.cumulative[index] / route.cumulative.at(-1)) };
}

function nearestStep(route, traveled) {
  let selected = route.steps.at(-1);
  for (const step of route.steps) {
    const near = nearestRoutePoint(route, step.point);
    if (route.cumulative[near.index] + 18 >= traveled) { selected = step; break; }
  }
  return selected;
}

function instructionFor(step) {
  if (!step) return { icon: "↑", text: "Continue to the destination" };
  const type = step.maneuver.type;
  const modifier = step.maneuver.modifier || "straight";
  const icons = { left: "←", right: "→", "sharp left": "↙", "sharp right": "↘", "slight left": "↖", "slight right": "↗", straight: "↑", uturn: "↶" };
  if (type === "arrive") return { icon: "●", text: "Arrive at the destination" };
  if (type === "roundabout" || type === "rotary") return { icon: "↻", text: `Enter the roundabout${step.maneuver.exit ? ` and take exit ${step.maneuver.exit}` : ""}` };
  const action = type === "depart" ? "Head" : type === "merge" ? "Merge" : type === "fork" ? "Keep" : "Turn";
  const street = step.name ? ` onto ${step.name}` : "";
  return { icon: icons[modifier] || "↑", text: `${action} ${modifier}${street}`.replace("Head straight", "Continue straight") };
}

function updateProgressGraphic(progress) {
  const percentage = Math.round(progress * 100);
  ui.roadProgress.style.strokeDashoffset = String(100 - percentage);
  ui.progressPercent.textContent = `${percentage}%`;
  const path = ui.roadProgress;
  const point = path.getPointAtLength(path.getTotalLength() * progress);
  ui.progressDot.setAttribute("cx", point.x);
  ui.progressDot.setAttribute("cy", point.y);
}

function updateNavigation(position) {
  const route = state.routes[state.selectedRoute];
  if (!route) return;
  const nearest = nearestRoutePoint(route, position);
  const remainingDistance = Math.max(0, route.distance * (1 - nearest.progress));
  const remainingSeconds = Math.max(0, route.duration * (1 - nearest.progress));
  const step = nearestStep(route, nearest.traveled);
  const instruction = instructionFor(step);
  const stepDistance = step ? distanceMeters(position, step.point) : remainingDistance;
  ui.stepDistance.textContent = step?.maneuver.type === "arrive" ? "Destination ahead" : `In ${metersText(stepDistance)}`;
  ui.stepInstruction.textContent = instruction.text;
  ui.maneuver.textContent = instruction.icon;
  ui.remaining.textContent = metersText(remainingDistance);
  ui.arrival.textContent = arrivalText(remainingSeconds);
  ui.currentStreet.textContent = step?.name || "Current position";
  updateProgressGraphic(nearest.progress);
  if (state.progressLayer) state.progressLayer.remove();
  const traveledPoints = route.points.slice(0, Math.max(2, nearest.index + 1));
  state.progressLayer = L.polyline(traveledPoints.map((point) => [point.lat, point.lng]), { color: "#ffffff", weight: 7, opacity: .85 }).addTo(map);
  if (nearest.distance > Math.max(65, position.accuracy * 1.4) && Date.now() - state.lastRerouteAt > 15000) {
    state.lastRerouteAt = Date.now();
    ui.stepDistance.textContent = "Updating route";
    loadRoutes().then(() => { if (state.routes.length) startNavigation(false); });
  }
  if (remainingDistance < 25) {
    ui.stepDistance.textContent = "You have arrived";
    ui.stepInstruction.textContent = state.destination.name;
    ui.maneuver.textContent = "●";
  }
}

function startNavigation(fit = true) {
  const route = state.routes[state.selectedRoute];
  if (!route || !state.user) return;
  state.navigating = true;
  state.follow = true;
  ui.setup.classList.add("hidden");
  ui.navigation.classList.remove("hidden");
  ui.recenter.classList.add("active");
  if (fit) map.setView([state.user.lat, state.user.lng], 17, { animate: true });
  updateNavigation(state.user);
}

function endNavigation() {
  state.navigating = false;
  if (state.progressLayer) state.progressLayer.remove();
  state.progressLayer = null;
  ui.navigation.classList.add("hidden");
  ui.setup.classList.remove("hidden");
  ui.recenter.classList.remove("active");
  updateProgressGraphic(0);
  renderRoutes();
}

function resetDestination() {
  state.destination = null;
  state.routes = [];
  state.navigating = false;
  clearRouteLayers();
  state.destinationMarker?.remove();
  state.destinationMarker = null;
  ui.setup.classList.add("hidden");
  ui.navigation.classList.add("hidden");
  ui.results.classList.add("hidden");
  ui.input.value = "";
  ui.clear.classList.add("hidden");
  ui.back.classList.add("hidden");
  ui.hint.classList.remove("hidden");
  if (state.user) map.setView([state.user.lat, state.user.lng], 16);
}

ui.permissionButton.addEventListener("click", requestLocation);
ui.form.addEventListener("submit", (event) => { event.preventDefault(); const query = ui.input.value.trim(); if (query) searchPlaces(query); });
ui.input.addEventListener("input", () => {
  ui.clear.classList.toggle("hidden", !ui.input.value);
  clearTimeout(ui.input.searchTimer);
  if (ui.input.value.trim().length >= 3) ui.input.searchTimer = setTimeout(() => searchPlaces(ui.input.value.trim()), 450);
  else ui.results.classList.add("hidden");
});
ui.input.addEventListener("focus", () => { if (ui.input.value.trim().length >= 3 && !state.destination) searchPlaces(ui.input.value.trim()); });
ui.clear.addEventListener("click", () => { ui.input.value = ""; ui.clear.classList.add("hidden"); ui.results.classList.add("hidden"); ui.input.focus(); });
ui.back.addEventListener("click", resetDestination);
ui.closeRoute.addEventListener("click", resetDestination);
ui.start.addEventListener("click", () => startNavigation());
ui.end.addEventListener("click", endNavigation);
ui.recenter.addEventListener("click", () => {
  if (!state.user) return requestLocation();
  state.follow = true;
  ui.recenter.classList.add("active");
  map.setView([state.user.lat, state.user.lng], state.navigating ? 17 : Math.max(map.getZoom(), 15), { animate: true });
});
ui.orientation.addEventListener("click", () => {
  state.followHeading = !state.followHeading;
  ui.orientation.classList.toggle("active", state.followHeading);
  const marker = state.userMarker?.getElement()?.querySelector(".user-marker");
  if (marker) marker.style.transform = `rotate(${state.followHeading && state.lastHeading !== null ? state.lastHeading - 45 : -45}deg)`;
  if (state.followHeading && state.lastHeading === null) showToast("Move a short distance so your device can determine travel direction.");
});
$$('.mode-tab').forEach((button) => button.addEventListener("click", () => {
  state.mode = button.dataset.mode;
  $$('.mode-tab').forEach((item) => { item.classList.toggle("active", item === button); item.setAttribute("aria-selected", String(item === button)); });
  loadRoutes();
}));

map.on("dragstart zoomstart", () => { state.follow = false; ui.recenter.classList.remove("active"); });
let pressTimer;
map.on("mousedown touchstart", (event) => { pressTimer = setTimeout(async () => { const place = await reversePlace(event.latlng.lat, event.latlng.lng); chooseDestination({ lat: event.latlng.lat, lng: event.latlng.lng, ...place }); }, 650); });
map.on("mouseup touchend mousemove", () => clearTimeout(pressTimer));

const params = new URLSearchParams(location.search);
const destinationLat = params.has("lat") ? Number(params.get("lat")) : NaN;
const destinationLng = params.has("lng") ? Number(params.get("lng")) : NaN;
if (Number.isFinite(destinationLat) && Number.isFinite(destinationLng)) {
  reversePlace(destinationLat, destinationLng).then((place) => chooseDestination({ lat: destinationLat, lng: destinationLng, ...place }));
} else if (params.get("to")) {
  ui.input.value = params.get("to");
  searchPlaces(params.get("to"));
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
