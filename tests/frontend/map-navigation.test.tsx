import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { assignRideLegIds, prepareSegment, projectOnPath, rideCompletionDescriptor, rideNearArrival, ridePaymentMode, taxiJourneySegment, userMapInteraction } from "../../frontend/public/map-assets/route-utils.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = readFileSync(path.resolve(here, "../../frontend/public/map-assets/map.js"), "utf8");
const start = { name: "Origin Station", lat: 41.88, lng: -87.64 };
const end = { name: "Venue Station", lat: 41.89, lng: -87.62 };
const vehicle = (mode = "bus") => prepareSegment({ mode, label: "Regional service", from: start, to: end, points: [start, end], duration: 600, rideLegId: "ride-stable", live: false });

function navigation(segment = vehicle(), otherSegments = [prepareSegment({ mode: "walk", points: [end, { ...end, lat: end.lat + .001 }], from: end, to: end, duration: 60 })]) {
  const state = { routes: [{ segments: [segment, ...otherSegments] }], selectedRoute: 0, activeLeg: 0, legProgress: 0, legProjection: null, offRouteUpdates: 0, rerouting: false, rerouteAfter: 0, startLive: false, navigating: true, follow: true, paymentSession: "session", rideLegIds: new Map(), completedRideLegs: new Set<string>(), completedRideDescriptors: new Map(), ridePromptCooldowns: new Map<string, number>(), journeyFrom: start.name, journeyTo: end.name, hasPaymentAttempt: false, receiptSessionLost: false, journeyFinalized: false, user: null };
  const ui = Object.fromEntries(["setup", "navigation", "recenter", "stepDistance", "stepInstruction", "maneuver", "remaining", "arrival", "currentStreet", "progressPercent", "overallProgress", "activeLegSummary", "previousLeg", "nextLeg"].map((name) => [name, document.createElement("div")]));
  let opened = false;
  const checkout = { open: vi.fn((context) => { opened = true; return context; }), isOpen: () => opened };
  let finalOpened = false;
  const finalReceipt = { open: vi.fn((context) => { finalOpened = true; return context; }), isOpen: () => finalOpened };
  const setActiveLeg = vi.fn((index) => { state.activeLeg = index; state.legProgress = 0; });
  const loadRoutes = vi.fn(async () => {});
  const completionFetch = vi.fn(async () => new Response(JSON.stringify({ connected: true, needsHuman: true }), { status: 201, headers: { "content-type": "application/json" } }));
  const map = { setView: vi.fn(), panTo: vi.fn() };
  const snippet = runtime.slice(runtime.indexOf("function checkoutCompletedRide("), runtime.indexOf("function resetRoutes("));
  const dependencies = { state, ui, rideCheckout: checkout, tripReceipt: finalReceipt, assignRideLegIds, rideCompletionDescriptor, ridePaymentMode, rideNearArrival, projectOnPath, setActiveLeg, focusLeg: vi.fn(), loadRoutes, map, collapsePlanner: vi.fn(), showToast: vi.fn(), metersText: String, arrivalText: String, instructionFor: () => ({ icon: "B", text: "Ride to your stop" }), routeProgress: () => 0, renderLegList: vi.fn(), renderProgressOnMap: vi.fn(), clearProgressLayers: vi.fn(), renderRoutes: vi.fn(), fetch: completionFetch };
  const functions = new Function(...Object.keys(dependencies), `${snippet}\nreturn {completeNavigationStep,updateNavigation,startNavigation,endNavigation};`)(...Object.values(dependencies));
  return {
    state,
    checkout,
    finalReceipt,
    setActiveLeg,
    loadRoutes,
    map,
    completionFetch,
    ...functions,
    acknowledge: (outcome = {}) => { opened = false; checkout.open.mock.calls.at(-1)![0].onContinue(outcome); },
    dismiss: (outcome = {}) => { opened = false; checkout.open.mock.calls.at(-1)![0].onDismiss(outcome); },
    acknowledgeFinal: async () => {
      finalOpened = false;
      await finalReceipt.open.mock.calls.at(-1)![0].onContinue();
    },
    dismissFinal: (outcome = {}) => { finalOpened = false; finalReceipt.open.mock.calls.at(-1)![0].onDismiss(outcome); },
  };
}

test("only bus, rail, train, and taxi vehicle legs can request checkout", () => {
  for (const [mode, payment] of [["bus", "bus"], ["rail", "train"], ["train", "train"], ["taxi", "taxi"]]) expect(ridePaymentMode({ mode })).toBe(payment);
  for (const mode of ["walk", "bike", "drive", "ferry", "flight", "airport"]) expect(ridePaymentMode({ mode })).toBeUndefined();
});

test("manual Next pauses a preview vehicle leg until its explicit checkout acknowledgement", () => {
  const app = navigation();
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  expect(app.checkout.open.mock.calls[0][0]).toMatchObject({ journeyId: "session", legId: "ride-stable", mode: "bus", preview: true, from: start.name, to: end.name });
  expect(app.state.activeLeg).toBe(0);
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  app.acknowledge();
  expect(app.state.activeLeg).toBe(1);
  app.checkout.open.mock.calls[0][0].onContinue();
  expect(app.setActiveLeg).toHaveBeenCalledTimes(1);
  app.state.activeLeg = 0;
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  expect(app.state.activeLeg).toBe(1);
});

test("GPS near the vehicle stop only opens confirmation and never advances or charges on its own", () => {
  const app = navigation();
  const position = { ...end, accuracy: 10 };
  app.state.startLive = true;
  app.updateNavigation(position);
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  expect(app.state.activeLeg).toBe(0);
  expect(app.state.completedRideLegs.size).toBe(0);
  app.updateNavigation(position);
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  app.acknowledge();
  expect(app.state.activeLeg).toBe(1);
  expect(app.state.completedRideLegs.has("ride-stable")).toBe(true);
});

test("poor or distant GPS cannot infer that a traveler left a vehicle", () => {
  expect(rideNearArrival(vehicle(), { ...end, accuracy: 500 }, 1)).toBe(false);
  expect(rideNearArrival(vehicle(), { ...start, accuracy: 10 }, 1)).toBe(false);
  expect(rideNearArrival(vehicle(), { ...end, accuracy: 10 }, .5)).toBe(false);
  expect(rideNearArrival(vehicle("drive"), { ...end, accuracy: 10 }, 1)).toBe(false);
});

test("still on board returns to the same ride without payment or advancement and cools down GPS prompts", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const app = navigation();
  const position = { ...end, accuracy: 10 };
  app.state.startLive = true;
  app.state.user = position;
  app.updateNavigation(position);
  const first = app.checkout.open.mock.calls[0][0];
  app.dismiss();
  expect(app.state.activeLeg).toBe(0);
  expect(app.state.navigating).toBe(true);
  expect(app.state.completedRideLegs.size).toBe(0);
  expect(app.state.ridePromptCooldowns.get("ride-stable")).toBe(61_000);
  app.updateNavigation(position);
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  first.onContinue();
  expect(app.state.activeLeg).toBe(0);
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(2);
  app.dismiss();
  now.mockReturnValue(61_001);
  app.updateNavigation(position);
  expect(app.checkout.open).toHaveBeenCalledTimes(3);
  expect(app.state.completedRideLegs.size).toBe(0);
});

test("Finish requires vehicle confirmation, while walking finishes without checkout", async () => {
  const ride = navigation(vehicle("rail"), []);
  ride.completeNavigationStep();
  expect(ride.state.navigating).toBe(true);
  expect(ride.checkout.open.mock.calls[0][0].mode).toBe("train");
  ride.acknowledge();
  expect(ride.state.navigating).toBe(true);
  expect(ride.finalReceipt.open).toHaveBeenCalledTimes(1);
  await ride.acknowledgeFinal();
  expect(ride.state.navigating).toBe(false);
  expect(ride.completionFetch).toHaveBeenCalledTimes(1);
  expect(ride.completionFetch).toHaveBeenCalledWith("/api/map/trip-completion", expect.objectContaining({ method: "POST", credentials: "same-origin", keepalive: true }));
  const walk = navigation(vehicle("walk"), []);
  walk.completeNavigationStep();
  expect(walk.checkout.open).not.toHaveBeenCalled();
  expect(walk.finalReceipt.open).toHaveBeenCalledTimes(1);
  await walk.acknowledgeFinal();
  expect(walk.state.navigating).toBe(false);
  expect(walk.completionFetch).toHaveBeenCalledTimes(1);
});

test("End guidance cancels navigation without claiming vehicle completion or opening checkout", () => {
  const app = navigation(vehicle("rail"), []);
  const endButton = document.createElement("button");
  const binding = runtime.match(/ui\.end\.addEventListener\("click",[^;]*;/)?.[0];
  expect(binding).toBeTruthy();
  new Function("ui", "endNavigation", binding!)({ end: endButton }, app.endNavigation);
  endButton.click();
  expect(app.state.navigating).toBe(false);
  expect(app.state.activeLeg).toBe(0);
  expect(app.state.completedRideLegs.size).toBe(0);
  expect(app.checkout.open).not.toHaveBeenCalled();
  expect(app.finalReceipt.open).not.toHaveBeenCalled();
  expect(app.completionFetch).not.toHaveBeenCalled();
  const page = readFileSync(path.resolve(here, "../../frontend/app/map/MapClient.tsx"), "utf8");
  expect(page).toMatch(/id="end-navigation"[^>]*>End guidance</);
});

test("Finish trip summarizes confirmed rides in journey order, including an unpaid train but no unused alternative", async () => {
  const train = { ...vehicle("rail"), rideLegId: "train-confirmed", label: "Blue Line" };
  const walk = vehicle("walk");
  const app = navigation(vehicle(), [train, walk]);
  app.state.routes.push({ segments: [{ ...vehicle("taxi"), rideLegId: "unused-alternative" }] });
  app.completeNavigationStep();
  app.acknowledge({ receipt: { id: "ride_sim_paid-bus" }, attempted: true });
  expect(app.state.activeLeg).toBe(1);
  expect(app.finalReceipt.open).not.toHaveBeenCalled();
  app.completeNavigationStep();
  expect(app.checkout.open.mock.calls[1][0]).toMatchObject({ journeyId: "session", legId: "train-confirmed", mode: "train" });
  app.acknowledge({ skipped: true, attempted: false });
  expect(app.state.activeLeg).toBe(2);
  expect(app.finalReceipt.open).not.toHaveBeenCalled();
  app.completeNavigationStep();
  const final = app.finalReceipt.open.mock.calls[0][0];
  expect(final).toMatchObject({ journeyId: "session", from: start.name, to: end.name, hasPaymentAttempt: true });
  expect(final.legs).toEqual([
    { legId: "ride-stable", mode: "bus", service: "Regional service", from: start.name, to: end.name, expectedReceiptId: "ride_sim_paid-bus" },
    { legId: "train-confirmed", mode: "train", service: "Blue Line", from: start.name, to: end.name },
  ]);
  expect(app.state.navigating).toBe(true);
  await app.acknowledgeFinal();
  expect(app.state.navigating).toBe(false);
});

test("a walking-only trip reaches a final summary with no vehicle charges", async () => {
  const app = navigation(vehicle("walk"), []);
  app.completeNavigationStep();
  expect(app.checkout.open).not.toHaveBeenCalled();
  expect(app.finalReceipt.open.mock.calls[0][0]).toMatchObject({ journeyId: "session", legs: [], hasPaymentAttempt: false });
  app.state.startLive = true;
  app.updateNavigation({ ...end, accuracy: 10 });
  expect(app.finalReceipt.open).toHaveBeenCalledTimes(1);
  expect(app.state.navigating).toBe(true);
  await app.acknowledgeFinal();
  expect(app.state.navigating).toBe(false);
});

test("returning from a final-summary error keeps navigation and permits an explicit Finish trip retry", async () => {
  const app = navigation(vehicle("walk"), []);
  app.completeNavigationStep();
  const first = app.finalReceipt.open.mock.calls[0][0];
  app.dismissFinal();
  expect(app.state.navigating).toBe(true);
  expect(app.state.completedRideLegs.size).toBe(0);
  first.onContinue();
  expect(app.state.navigating).toBe(true);
  app.completeNavigationStep();
  expect(app.finalReceipt.open).toHaveBeenCalledTimes(2);
  await app.acknowledgeFinal();
  expect(app.state.navigating).toBe(false);
});

test("a failed post-trip save keeps guidance retryable until completion is recorded", async () => {
  const app = navigation(vehicle("walk"), []);
  app.completionFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
  app.completeNavigationStep();
  expect(app.finalReceipt.open).toHaveBeenCalledTimes(1);
  await app.acknowledgeFinal();
  expect(app.completionFetch).toHaveBeenCalledTimes(1);
  expect(app.state.navigating).toBe(true);
  expect(app.state.journeyFinalized).toBe(false);

  app.completeNavigationStep();
  expect(app.finalReceipt.open).toHaveBeenCalledTimes(2);
  await app.acknowledgeFinal();
  expect(app.completionFetch).toHaveBeenCalledTimes(2);
  expect(app.state.navigating).toBe(false);
  expect(app.state.journeyFinalized).toBe(true);
});

test("an ambiguous final-summary dismissal preserves lost ownership and attempt flags for retry", () => {
  const app = navigation(vehicle("walk"), []);
  app.completeNavigationStep();
  app.dismissFinal({ attempted: true, sessionLost: true });
  expect(app.state.navigating).toBe(true);
  expect(app.state.paymentSession).toBe("session");
  expect(app.state.hasPaymentAttempt).toBe(true);
  expect(app.state.receiptSessionLost).toBe(true);
  app.completeNavigationStep();
  expect(app.finalReceipt.open.mock.calls[1][0]).toMatchObject({ journeyId: "session", hasPaymentAttempt: true, sessionLost: true });
});

test("an uncertain payment dismissal stays remembered without falsely confirming the vehicle leg", () => {
  const app = navigation(vehicle(), []);
  app.completeNavigationStep();
  app.dismiss({ attempted: true, sessionLost: true });
  expect(app.state.hasPaymentAttempt).toBe(true);
  expect(app.state.receiptSessionLost).toBe(true);
  expect(app.state.completedRideDescriptors.size).toBe(0);
  expect(app.state.completedRideLegs.size).toBe(0);
  expect(app.finalReceipt.open).not.toHaveBeenCalled();
  app.completeNavigationStep();
  app.acknowledge({ skipped: true, attempted: false });
  expect(app.finalReceipt.open.mock.calls[0][0]).toMatchObject({ hasPaymentAttempt: true, legs: [{ legId: "ride-stable" }] });
  expect(app.finalReceipt.open.mock.calls[0][0].sessionLost).toBe(true);
  expect(app.finalReceipt.open.mock.calls[0][0].legs[0].expectedReceiptId).toBeUndefined();
});

test("a lost receipt session remains sticky when the journey reaches its next train leg", () => {
  const train = { ...vehicle("rail"), rideLegId: "next-train" };
  const app = navigation(vehicle(), [train]);
  app.completeNavigationStep();
  expect(app.checkout.open.mock.calls[0][0]).toMatchObject({ hasPaymentAttempt: false, sessionLost: false });
  app.dismiss({ attempted: true, sessionLost: true });
  app.completeNavigationStep();
  expect(app.checkout.open.mock.calls[1][0]).toMatchObject({ hasPaymentAttempt: true, sessionLost: true });
  app.acknowledge({ skipped: true, attempted: false, sessionLost: false });
  app.completeNavigationStep();
  expect(app.checkout.open.mock.calls[2][0]).toMatchObject({ journeyId: "session", legId: "next-train", hasPaymentAttempt: true, sessionLost: true });
  app.acknowledge({ skipped: true, attempted: false, sessionLost: false });
  expect(app.finalReceipt.open.mock.calls[0][0]).toMatchObject({ hasPaymentAttempt: true, sessionLost: true });
});

test("End guidance and resuming the same journey retain confirmed receipts and original endpoints", () => {
  const app = navigation();
  app.completeNavigationStep();
  app.acknowledge({ receipt: { id: "ride_sim_preserved" }, attempted: true });
  app.endNavigation();
  expect(app.finalReceipt.open).not.toHaveBeenCalled();
  expect(app.state.completedRideDescriptors.size).toBe(1);
  app.startNavigation();
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  app.completeNavigationStep();
  expect(app.finalReceipt.open.mock.calls[0][0]).toMatchObject({ journeyId: "session", from: start.name, to: end.name, legs: [{ expectedReceiptId: "ride_sim_preserved" }] });
});

test("starting again after a verified final receipt creates a fresh journey and payable leg IDs", async () => {
  const app = navigation(vehicle(), []);
  app.completeNavigationStep();
  app.acknowledge({ receipt: { id: "ride_sim_first-journey" }, attempted: true });
  await app.acknowledgeFinal();
  expect(app.state.journeyFinalized).toBe(true);
  app.startNavigation();
  expect(app.state.paymentSession).not.toBe("session");
  expect(app.state.journeyFinalized).toBe(false);
  expect(app.state.completedRideDescriptors.size).toBe(0);
  expect(app.state.completedRideLegs.size).toBe(0);
  expect(app.state.hasPaymentAttempt).toBe(false);
  expect(app.state.receiptSessionLost).toBe(false);
  expect(app.state.routes[0].segments[0].rideLegId).not.toBe("ride-stable");
  app.completeNavigationStep();
  expect(app.checkout.open).toHaveBeenCalledTimes(2);
  expect(app.checkout.open.mock.calls[1][0].journeyId).toBe(app.state.paymentSession);
  expect(app.checkout.open.mock.calls[1][0].legId).toBe(app.state.routes[0].segments[0].rideLegId);
});

test("ride IDs survive going back and alternative taxi paths retain one ID", () => {
  const ids = new Map();
  let created = 0;
  const createId = () => `leg-${++created}`;
  const first = assignRideLegIds([vehicle()], ids, createId)[0];
  const repeated = assignRideLegIds([{ ...vehicle(), duration: 650 }], ids, createId)[0];
  expect(first.rideLegId).toBe(repeated.rideLegId);
  expect(created).toBe(1);
  const taxi = vehicle("taxi");
  const alternatives = [taxi, { ...taxi, points: [start, { ...end, lat: end.lat + .002 }, end], duration: 700 }];
  const taxiIds = alternatives.map((segment) => assignRideLegIds([segment], ids, createId)[0].rideLegId);
  expect(taxiIds[0]).toBe(taxiIds[1]);
  const departures = ["2027-01-16T17:00:00Z", "2027-01-16T18:00:00Z"].map((startTime) => assignRideLegIds([{ ...vehicle(), serviceId: "regional-route", startTime }], ids, createId)[0].rideLegId);
  expect(departures[0]).not.toBe(departures[1]);
});

test("a twenty-turn taxi journey with intermediate waypoints creates one payable vehicle leg", async () => {
  const middle = { name: "Intermediate stop", lat: 41.885, lng: -87.63 };
  const turns = Array.from({ length: 20 }, (_, index) => ({ name: `Street ${index}`, duration: 30, distance: 80, geometry: { coordinates: [[start.lng + index * .001, start.lat], [start.lng + (index + 1) * .001, start.lat]] } }));
  const route = { duration: 600, distance: 1600, geometry: { coordinates: turns.flatMap((step) => step.geometry.coordinates) }, legs: [{ duration: 300, distance: 800, steps: turns.slice(0, 10) }, { duration: 300, distance: 800, steps: turns.slice(10) }] };
  const segment = taxiJourneySegment(route, [start, middle, end]);
  expect(segment.mode).toBe("taxi");
  expect(segment.waypointLegs).toHaveLength(2);
  expect(segment.waypointLegs.flatMap((leg) => leg.turns)).toHaveLength(20);
  expect(segment.points.length).toBeGreaterThan(20);
  expect(segment.live).toBe(false);
  expect(segment.instruction).toMatch(/not a booked ride or a verified taxi fare/);
  const app = navigation({ ...segment, rideLegId: "taxi-one-ride" }, []);
  app.completeNavigationStep(true);
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
  app.acknowledge();
  expect(app.finalReceipt.open).toHaveBeenCalledTimes(1);
  await app.acknowledgeFinal();
  expect(app.state.navigating).toBe(false);
  app.completeNavigationStep(true);
  expect(app.checkout.open).toHaveBeenCalledTimes(1);
});

test("only actual map interactions disable follow, not programmatic zoom events", () => {
  expect(userMapInteraction("zoomstart", {})).toBe(false);
  expect(userMapInteraction("wheel", {})).toBe(true);
  expect(userMapInteraction("dragstart", {})).toBe(true);
  expect(userMapInteraction("touchstart", { touches: [{}] })).toBe(false);
  expect(userMapInteraction("touchstart", { touches: [{}, {}] })).toBe(true);
  expect(userMapInteraction("keydown", { key: "+" })).toBe(true);
  expect(userMapInteraction("keydown", { key: "a" })).toBe(false);
  expect(runtime).not.toMatch(/map\.on\("dragstart zoomstart"/);
  const app = navigation();
  app.state.user = { ...start, accuracy: 10 };
  app.state.follow = false;
  app.startNavigation();
  expect(app.state.follow).toBe(true);
  expect(app.map.setView).toHaveBeenCalledWith([start.lat, start.lng], 17, { animate: true });
});

test("off-route vehicle GPS preserves the original ride instead of inventing a new payable leg", () => {
  const app = navigation();
  app.state.startLive = true;
  for (let i = 0; i < 4; i += 1) app.updateNavigation({ lat: 42, lng: -87, accuracy: 10 });
  expect(app.loadRoutes).not.toHaveBeenCalled();
  expect(app.checkout.open).not.toHaveBeenCalled();
  expect(app.state.routes[0].segments[0].rideLegId).toBe("ride-stable");
  expect(app.state.navigating).toBe(true);
});

test("off-route walking requests a continuous replan instead of leaving navigation", async () => {
  const app = navigation(vehicle("walk"));
  app.state.startLive = true;
  for (let i = 0; i < 4; i += 1) app.updateNavigation({ lat: 42, lng: -87, accuracy: 10 });
  expect(app.loadRoutes).toHaveBeenCalledWith({ resumeNavigation: true });
  await Promise.resolve();
  expect(app.state.navigating).toBe(true);
  expect(app.checkout.open).not.toHaveBeenCalled();
});

function routeLoader(fail = false) {
  const original = { title: "Original walk", segments: [vehicle("walk"), vehicle("walk")], duration: 600 };
  const updated = { title: "Updated walk", segments: [vehicle("walk")], duration: 500 };
  const state = { mode: "walk", routes: [original], selectedRoute: 0, activeLeg: 1, legProgress: .5, legProjection: { progress: .5 }, navigating: true, rideLegIds: new Map([["prior", "ride-stable"]]), completedRideLegs: new Set(["ride-stable"]), completedRideDescriptors: new Map([["ride-stable", { legId: "ride-stable", mode: "bus", service: "Previous bus", from: start.name, to: end.name }]]), ridePromptCooldowns: new Map(), paymentSession: "same-session", journeyFrom: "Original starting point", journeyTo: end.name, hasPaymentAttempt: true, receiptSessionLost: true, journeyFinalized: false, waypoints: [], routeAbort: null };
  const ui = Object.fromEntries(["setup", "navigation", "status", "options", "legList", "start", "destinationName", "destinationAddress", "destinationLabel", "routeKicker", "routeSource"].map((name) => [name, document.createElement("div")]));
  ui.departure = document.createElement("input");
  const startNavigation = vi.fn();
  const fetchRoadRoutes = vi.fn(async () => { if (fail) throw new Error("Unavailable"); return [updated]; });
  let requestedPoints = [start, end];
  const dependencies = { state, ui, rideCheckout: { isOpen: () => false }, tripReceipt: { isOpen: () => false }, tripPoints: () => requestedPoints, clearRouteLayers: vi.fn(), fetchRoadRoutes, renderRoutes: vi.fn(), collapsePlanner: vi.fn(), startNavigation, showToast: vi.fn(), sequentialTransit: vi.fn(), flightRoute: vi.fn(), prepareItinerary: vi.fn() };
  const snippet = runtime.slice(runtime.indexOf("async function loadRoutes("), runtime.indexOf("function lineStyle("));
  const loadRoutes = new Function(...Object.keys(dependencies), `${snippet}\nreturn loadRoutes;`)(...Object.values(dependencies));
  return { state, original, updated, startNavigation, loadRoutes, setDestination: (name: string) => { requestedPoints = [start, { ...end, name }]; } };
}

test("successful automatic rerouting resumes navigation and preserves completed ride IDs", async () => {
  const app = routeLoader();
  await app.loadRoutes({ resumeNavigation: true });
  expect(app.state.navigating).toBe(true);
  expect(app.startNavigation).toHaveBeenCalledTimes(1);
  expect(app.state.routes).toEqual([app.updated]);
  expect(app.state.paymentSession).toBe("same-session");
  expect(app.state.completedRideLegs.has("ride-stable")).toBe(true);
  expect(app.state.completedRideDescriptors.get("ride-stable")?.service).toBe("Previous bus");
  expect(app.state.journeyFrom).toBe("Original starting point");
  expect(app.state.journeyTo).toBe(end.name);
  expect(app.state.hasPaymentAttempt).toBe(true);
});

test("a failed automatic replan retains the previous navigation route instead of silently stopping", async () => {
  const app = routeLoader(true);
  app.setDestination("Unreachable new venue");
  await app.loadRoutes({ resumeNavigation: true });
  expect(app.state.navigating).toBe(true);
  expect(app.state.routes).toEqual([app.original]);
  expect(app.state.activeLeg).toBe(1);
  expect(app.state.legProgress).toBe(.5);
  expect(app.state.paymentSession).toBe("same-session");
  expect(app.state.journeyTo).toBe(end.name);
});

test("a manual mode or destination update during guidance preserves receipts and the original starting point", async () => {
  const app = routeLoader();
  app.state.mode = "taxi";
  app.setDestination("New requested venue");
  await app.loadRoutes(new Event("click"));
  expect(app.state.navigating).toBe(true);
  expect(app.state.paymentSession).toBe("same-session");
  expect(app.state.completedRideDescriptors.get("ride-stable")?.service).toBe("Previous bus");
  expect(app.state.completedRideLegs.has("ride-stable")).toBe(true);
  expect(app.state.hasPaymentAttempt).toBe(true);
  expect(app.state.receiptSessionLost).toBe(true);
  expect(app.state.journeyFrom).toBe("Original starting point");
  expect(app.state.journeyTo).toBe("New requested venue");
  expect(app.startNavigation).toHaveBeenCalledTimes(1);
});

test("an explicit new search starts a separate journey without carrying old payment claims", async () => {
  const app = routeLoader();
  app.state.navigating = false;
  await app.loadRoutes();
  expect(app.state.paymentSession).not.toBe("same-session");
  expect(app.state.completedRideDescriptors.size).toBe(0);
  expect(app.state.completedRideLegs.size).toBe(0);
  expect(app.state.hasPaymentAttempt).toBe(false);
  expect(app.state.receiptSessionLost).toBe(false);
  expect(app.state.journeyFrom).toBe(start.name);
  expect(app.state.journeyTo).toBe(end.name);
  expect(app.state.journeyFinalized).toBe(false);
});

test("only an explicit new-journey action can replace an active journey's receipt state", async () => {
  const app = routeLoader();
  await app.loadRoutes({ newJourney: true });
  expect(app.state.paymentSession).not.toBe("same-session");
  expect(app.state.completedRideDescriptors.size).toBe(0);
  expect(app.state.hasPaymentAttempt).toBe(false);
  expect(app.state.receiptSessionLost).toBe(false);
});
