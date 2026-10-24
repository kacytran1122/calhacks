import type { HackEvent, Person } from "../types";

export const COMPANY = {
  name: "Golden Gate Hack",
  program: "Hacker Travel Grants",
  season: "2026",
  openPeriod: "2026-10",
  closedPeriods: ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"],
};

export const PEOPLE: Person[] = [
  { id: "P-maya", name: "Maya R.", role: "controller", title: "Finance lead (controller) — signs off the books" },
  { id: "P-dev", name: "Dev P.", role: "organizer", title: "Travel organizer — requests exceptions, confirms check-ins" },
];

export const EVENTS: HackEvent[] = [
  { id: "E-spring", name: "Golden Gate Hack · Spring", venue: "Fort Mason Center", city: "San Francisco, CA", startsAt: "2026-03-14T16:00:00Z", lat: 37.8063, lon: -122.4306 },
  { id: "E-summer", name: "Golden Gate Hack · Summer Build", venue: "Fort Mason Center", city: "San Francisco, CA", startsAt: "2026-06-20T16:00:00Z", lat: 37.8063, lon: -122.4306 },
  { id: "E-fall-night", name: "Golden Gate Hack · Fall Hack Night", venue: "Fort Mason Center", city: "San Francisco, CA", startsAt: "2026-10-17T01:00:00Z", lat: 37.8063, lon: -122.4306 },
  { id: "E-main", name: "Golden Gate Hack 2026", venue: "Fort Mason Center", city: "San Francisco, CA", startsAt: "2026-11-14T17:00:00Z", lat: 37.8063, lon: -122.4306 },
];

export const SCHOOLS = [
  { school: "UC Davis", zip: "95616", miles: 72, mode: "train", fare: 2400, merchant: "rail" },
  { school: "Sacramento State", zip: "95819", miles: 87, mode: "train", fare: 2900, merchant: "rail" },
  { school: "UC Santa Cruz", zip: "95064", miles: 58, mode: "bus", fare: 1650, merchant: "bus" },
  { school: "Stanford", zip: "94305", miles: 30, mode: "train", fare: 850, merchant: "rail" },
  { school: "UC Berkeley", zip: "94720", miles: 9, mode: "train", fare: 460, merchant: "rail" },
  { school: "San José State", zip: "95192", miles: 45, mode: "train", fare: 1025, merchant: "rail" },
  { school: "UC Merced", zip: "95343", miles: 112, mode: "train", fare: 3200, merchant: "rail" },
  { school: "Cal Poly SLO", zip: "93407", miles: 190, mode: "bus", fare: 4500, merchant: "bus" },
  { school: "UCLA", zip: "90095", miles: 347, mode: "flight", fare: 12900, merchant: "airline" },
  { school: "Univ. of Nevada, Reno", zip: "89557", miles: 185, mode: "bus", fare: 5200, merchant: "bus" },
] as const;

export type School = (typeof SCHOOLS)[number];
