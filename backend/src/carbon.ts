import { haversineMiles } from "./integrations/geo";
import { airportsNear } from "./ml/price";
import type { State } from "./store";
import type { Trip } from "./types";

/**
 * Estimated greenhouse-gas emissions per traveler, in kg CO₂e, for each way to reach an event.
 * Distance-based method: published emission factor × distance. Factors are the U.S. EPA's, except
 * ride-hailing, where California measured the real fleet, including the miles driven empty
 * between rides. No model or AI produces these numbers.
 */

type Point = { lat: number; lon: number };

export const CARBON_SOURCES = {
  epa: {
    name: "U.S. EPA GHG Emission Factors Hub (January 2025), Table 10: business travel",
    url: "https://www.epa.gov/climateleadership/ghg-emission-factors-hub",
  },
  carb: {
    name: "California Air Resources Board, Clean Miles Standard 2018 base-year emissions inventory (December 2019)",
    url: "https://ww2.arb.ca.gov/our-work/programs/clean-miles-standard",
  },
} as const;

/** IPCC AR5 100-year global warming potentials, the ones the EPA hub uses (its Table 11). */
const GWP = { ch4: 28, n2o: 265 };

export interface EmissionFactor {
  id: string;
  label: string;
  kgPerUnit: number; // kg CO₂e
  unit: "vehicle-mile" | "passenger-mile";
  source: keyof typeof CARBON_SOURCES;
  note?: string;
}

/** EPA Table 10 gives kg CO₂, g CH₄ and g N₂O per unit; combine them into kg CO₂e. */
function epa(id: string, label: string, co2Kg: number, ch4G: number, n2oG: number, unit: EmissionFactor["unit"]): EmissionFactor {
  return { id, label, kgPerUnit: Math.round((co2Kg + (ch4G * GWP.ch4 + n2oG * GWP.n2o) / 1000) * 10_000) / 10_000, unit, source: "epa" };
}

export const FACTORS = {
  car: epa("car", "Passenger car", 0.297, 0.0059, 0.0053, "vehicle-mile"),
  commuterRail: epa("commuter_rail", "Commuter rail", 0.133, 0.0105, 0.0026, "passenger-mile"),
  intercityRailNec: epa("intercity_rail_nec", "Intercity rail, Northeast Corridor", 0.023, 0.001, 0.0001, "passenger-mile"),
  intercityRail: epa("intercity_rail", "Intercity rail, other routes", 0.149, 0.012, 0.004, "passenger-mile"),
  bus: epa("bus", "Bus", 0.066, 0.0046, 0.0019, "passenger-mile"),
  airShort: epa("air_short", "Air travel, short haul (< 300 mi)", 0.207, 0.0064, 0.0066, "passenger-mile"),
  airMedium: epa("air_medium", "Air travel, medium haul (300–2,300 mi)", 0.129, 0.0006, 0.0041, "passenger-mile"),
  airLong: epa("air_long", "Air travel, long haul (≥ 2,300 mi)", 0.163, 0.0006, 0.0052, "passenger-mile"),
  rideshare: {
    id: "rideshare",
    label: "Ride-hailing (Uber, Lyft) fleet average",
    kgPerUnit: 0.301,
    unit: "passenger-mile",
    source: "carb",
    note: "Measured from 1.4 billion California trips in 2018, counting the 38.5% of miles driven with no passenger. CO₂ only.",
  } satisfies EmissionFactor,
};

export type CarbonMode = Trip["mode"] | "carpool";

export interface CarbonEstimate {
  mode: CarbonMode;
  kg: number; // per traveler
  miles: number;
  factor: EmissionFactor;
  formula: string;
  basis: string; // where the distance came from
  riders?: number;
  hypothetical?: boolean; // carpool with no matched riders yet
}

export interface CarbonContext {
  straightMiles: number;
  roadMiles?: number; // live road route; otherwise straight line × ROAD_DETOUR
  from?: Point;
  to?: Point;
  carpool?: { people: number; detourMiles: number; hypothetical: boolean };
}

/** Roads are longer than a straight line; used only when no live road route was available. */
export const ROAD_DETOUR = 1.2;
/** Commuter rail below this distance, intercity rail above it. */
const COMMUTER_RAIL_MAX_MILES = 75;

const round1 = (v: number) => Math.round(v * 10) / 10;
const kgText = (v: number) => `${round1(v).toLocaleString("en-US")} kg`;
const factorText = (f: EmissionFactor) => `${f.kgPerUnit} kg CO₂e per ${f.unit}`;

// Boston to Washington, D.C.: Amtrak's electrified Northeast Corridor.
const inNortheastCorridor = (p: Point) => p.lat >= 38.7 && p.lat <= 42.5 && p.lon >= -77.3 && p.lon <= -70.8;

function roadOf(ctx: CarbonContext) {
  return ctx.roadMiles !== undefined
    ? { miles: round1(ctx.roadMiles), basis: "live road route distance (OSRM, OpenStreetMap)" }
    : { miles: round1(ctx.straightMiles * ROAD_DETOUR), basis: `straight-line distance × ${ROAD_DETOUR} (no live road route available)` };
}

function railFactor(ctx: CarbonContext, miles: number): EmissionFactor {
  if (miles <= COMMUTER_RAIL_MAX_MILES) return FACTORS.commuterRail;
  return ctx.from && ctx.to && inNortheastCorridor(ctx.from) && inNortheastCorridor(ctx.to) ? FACTORS.intercityRailNec : FACTORS.intercityRail;
}

function airFactor(miles: number): EmissionFactor {
  return miles < 300 ? FACTORS.airShort : miles < 2300 ? FACTORS.airMedium : FACTORS.airLong;
}

function simple(mode: CarbonMode, factor: EmissionFactor, miles: number, basis: string): CarbonEstimate {
  const kg = factor.kgPerUnit * miles;
  return { mode, kg: round1(kg), miles, factor, basis, formula: `${factorText(factor)} × ${miles} mi = ${kgText(kg)}` };
}

export function estimateCarbon(mode: CarbonMode, ctx: CarbonContext): CarbonEstimate | null {
  const road = roadOf(ctx);
  switch (mode) {
    case "drive":
      return simple("drive", FACTORS.car, road.miles, `${road.basis}; one person in the car`);
    case "rideshare":
      return simple("rideshare", FACTORS.rideshare, road.miles, road.basis);
    case "bus":
      return simple("bus", FACTORS.bus, road.miles, `${road.basis}, standing in for the bus route`);
    case "train": {
      const f = railFactor(ctx, road.miles);
      return simple("train", f, road.miles, `${road.basis}, standing in for the rail route`);
    }
    case "carpool": {
      const c = ctx.carpool ?? { people: 2, detourMiles: 0, hypothetical: true };
      const people = Math.max(2, c.people);
      const miles = round1(road.miles + c.detourMiles);
      const kg = (FACTORS.car.kgPerUnit * miles) / people;
      return {
        mode: "carpool",
        kg: round1(kg),
        miles,
        factor: FACTORS.car,
        riders: people,
        hypothetical: c.hypothetical,
        basis: `${road.basis}${c.detourMiles ? ` + ${c.detourMiles} mi of pickups` : ""}; one car shared by ${people} travelers`,
        formula: `${factorText(FACTORS.car)} × ${miles} mi ÷ ${people} travelers = ${kgText(kg)} each`,
      };
    }
    case "flight": {
      if (!ctx.from || !ctx.to) {
        if (ctx.straightMiles < 100) return null;
        return simple("flight", airFactor(ctx.straightMiles), round1(ctx.straightMiles), "straight-line distance; airports unknown, so rides to and from them are not included");
      }
      const a = airportsNear(ctx.from, 80, 1)[0];
      const b = airportsNear(ctx.to, 80, 1)[0];
      if (!a || !b || a.code === b.code) return null;
      const airMiles = round1(haversineMiles(a, b));
      if (airMiles < 100) return null;
      const groundMiles = round1((a.miles + b.miles) * ROAD_DETOUR);
      const f = airFactor(airMiles);
      const kg = f.kgPerUnit * airMiles + FACTORS.rideshare.kgPerUnit * groundMiles;
      return {
        mode: "flight",
        kg: round1(kg),
        miles: round1(airMiles + groundMiles),
        factor: f,
        basis: `${a.code} to ${b.code} great-circle distance, plus rides to and from the nearest airports (straight line × ${ROAD_DETOUR})`,
        formula: `${factorText(f)} × ${airMiles} mi flown + ${factorText(FACTORS.rideshare)} × ${groundMiles} mi of airport rides = ${kgText(kg)}`,
      };
    }
  }
}

export const CARBON_METHOD = [
  "Emissions = published emission factor × distance, per traveler, in kg CO₂e.",
  "Factors: U.S. EPA GHG Emission Factors Hub 2025 (car, bus, rail, air); CARB's measured ride-hailing fleet average for Uber and Lyft.",
  "EPA factors count tailpipe and power-plant combustion only, not fuel production. Flight factors leave out contrails and other high-altitude effects, so flights are a lower bound.",
  `Distance is the live road route when one is available; otherwise the straight line × ${ROAD_DETOUR}. Rail and bus use the road distance as a stand-in for the route.`,
  `Rail uses EPA's commuter-rail factor up to ${COMMUTER_RAIL_MAX_MILES} mi and its intercity factor beyond that (the Northeast Corridor factor when both ends are between Boston and Washington).`,
  "Carpool splits one car's emissions, including pickup detours, evenly among the travelers in it.",
];

export interface CarbonComparison {
  estimates: CarbonEstimate[];
  lowest: CarbonMode | null;
  driveAloneKg: number;
  method: string[];
  sources: { name: string; url: string }[];
}

export function compareCarbon(ctx: CarbonContext): CarbonComparison {
  const modes: CarbonMode[] = ["train", "bus", "carpool", "drive", "rideshare", "flight"];
  const estimates = modes.map((m) => estimateCarbon(m, ctx)).filter((e): e is CarbonEstimate => e !== null);
  const lowest = estimates.reduce<CarbonEstimate | null>((a, b) => (!a || b.kg < a.kg ? b : a), null);
  return {
    estimates: estimates.sort((a, b) => a.kg - b.kg),
    lowest: lowest?.mode ?? null,
    driveAloneKg: estimates.find((e) => e.mode === "drive")?.kg ?? 0,
    method: CARBON_METHOD,
    sources: Object.values(CARBON_SOURCES),
  };
}

/** Emissions for one booked trip, from what planning stored or, for older trips, from mode × distance. */
export function tripCarbon(trip: Trip): { kg: number; driveAloneKg: number } {
  if (trip.co2eKg !== undefined && trip.co2eDriveAloneKg !== undefined) return { kg: trip.co2eKg, driveAloneKg: trip.co2eDriveAloneKg };
  const ctx = { straightMiles: trip.distanceMiles };
  return { kg: estimateCarbon(trip.mode, ctx)?.kg ?? 0, driveAloneKg: estimateCarbon("drive", ctx)?.kg ?? 0 };
}

export interface OrganizerCarbon {
  trips: number;
  chosenKg: number;
  driveAloneKg: number;
  avoidedKg: number;
  avoidedPct: number;
  byMode: { mode: string; trips: number; kg: number }[];
  byEvent: { eventId: string; name: string; trips: number; chosenKg: number; avoidedKg: number }[];
  method: string[];
  sources: { name: string; url: string }[];
}

/** Across every attendee trip: what the chosen modes emit versus everyone driving alone. */
export function organizerCarbon(state: State): OrganizerCarbon {
  const trips = state.trips.filter((t) => (t.id.startsWith("TR-F") || t.id.startsWith("TR-L")) && t.distanceMiles > 0 && !["planned", "denied"].includes(t.state));
  const byMode = new Map<string, { mode: string; trips: number; kg: number }>();
  const byEvent = new Map<string, { eventId: string; name: string; trips: number; chosenKg: number; avoidedKg: number }>();
  let chosen = 0;
  let alone = 0;
  for (const t of trips) {
    const c = tripCarbon(t);
    chosen += c.kg;
    alone += c.driveAloneKg;
    const m = byMode.get(t.mode) ?? { mode: t.mode, trips: 0, kg: 0 };
    m.trips++;
    m.kg = round1(m.kg + c.kg);
    byMode.set(t.mode, m);
    const e = byEvent.get(t.eventId) ?? { eventId: t.eventId, name: state.events.find((x) => x.id === t.eventId)?.name ?? t.eventId, trips: 0, chosenKg: 0, avoidedKg: 0 };
    e.trips++;
    e.chosenKg = round1(e.chosenKg + c.kg);
    e.avoidedKg = round1(e.avoidedKg + c.driveAloneKg - c.kg);
    byEvent.set(t.eventId, e);
  }
  return {
    trips: trips.length,
    chosenKg: round1(chosen),
    driveAloneKg: round1(alone),
    avoidedKg: round1(alone - chosen),
    avoidedPct: alone > 0 ? Math.round(((alone - chosen) / alone) * 100) : 0,
    byMode: [...byMode.values()].sort((a, b) => b.trips - a.trips),
    byEvent: [...byEvent.values()].sort((a, b) => b.trips - a.trips),
    method: [
      "Each trip that was approved or later counts once: its chosen mode versus the same trip driven alone.",
      "Trips planned before emissions were recorded use straight-line distance × 1.2 for the road distance.",
      ...CARBON_METHOD.slice(1, 3),
    ],
    sources: Object.values(CARBON_SOURCES),
  };
}
