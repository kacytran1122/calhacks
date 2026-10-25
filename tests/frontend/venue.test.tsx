import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { ITEMS, radial, search, toWorld } from "../../frontend/app/venue/items";
import { FLOOR, PLACES, PX_PER_M, ROOMS, SPONSORS, TABLES, VIEWS, type Pt } from "../../frontend/app/venue/palace";
import { canStand, doorOf, inside, nearestOpen, route, seen, standFor, walkable } from "../../frontend/app/venue/walk";
import { VenueClient } from "../../frontend/app/venue/VenueClient";

const meters = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]) / PX_PER_M;

test("every table, booth and place from the floor plan is inside the building", () => {
  expect(TABLES).toHaveLength(263); // + 41 upstairs = the 304 hacker tables
  for (const t of TABLES) expect(inside(t, FLOOR), `table at ${t}`).toBe(true);
  for (const s of SPONSORS) expect(inside(s.at, FLOOR), `sponsor at ${s.at}`).toBe(true);
  for (const p of PLACES) expect(inside(p.at, FLOOR), p.name).toBe(p.name !== "Gate #3 / #4"); // the gate is outside, by the door
});

test("booths and hacker tables stand on open floor, not inside a closed area, room or the stairs", () => {
  for (const t of TABLES) expect(walkable(t), `table at ${t}`).toBe(true);
  for (const s of SPONSORS) expect(walkable(s.at), `booth ${s.number ?? s.at}`).toBe(true);
});

test("the plan's scale gives real table spacing: rows of 6-foot tables", () => {
  const near = TABLES.map((a) => Math.min(...TABLES.filter((b) => b !== a).map((b) => Math.hypot(toWorld(a).x - toWorld(b).x, toWorld(a).z - toWorld(b).z))));
  const median = near.sort((a, b) => a - b)[Math.floor(near.length / 2)]!;
  expect(median).toBeGreaterThan(1.5);
  expect(median).toBeLessThan(2.1); // meters; a 6 ft table is 1.83 m
});

test("rows run across the curved hall: straight up the plan in the middle, tilted toward the ends", () => {
  expect(Math.abs(radial([740, 300]).x)).toBeLessThan(0.05);
  expect(radial([270, 330]).x).toBeLessThan(-0.25);
  expect(radial([1400, 400]).x).toBeGreaterThan(0.25);
});

test("sponsor numbers are unique and names are only filled in where known", () => {
  const numbers = SPONSORS.flatMap((s) => (s.number ? [s.number] : []));
  expect(new Set(numbers).size).toBe(numbers.length);
  expect(SPONSORS.every((s) => (s.number === undefined) === (s.name === undefined))).toBe(true);
  expect(ITEMS.filter((i) => i.kind === "sponsor" && !i.number).every((i) => i.name === "Sponsor table")).toBe(true);
});

test("search finds sponsors by name or number, areas and views, and is honest about table numbers", () => {
  expect(search("")).toEqual([]);
  const anthropic = search("anthropic");
  expect(anthropic[0]).toMatchObject({ kind: "item", item: { name: "Anthropic", number: 13 } });
  expect(search("12")[0]).toMatchObject({ kind: "item", item: { name: "Annapurna" } });
  const broadway = search("broadway");
  expect(broadway.some((r) => r.kind === "view")).toBe(true);
  expect(broadway.filter((r) => r.kind === "item" && r.item.kind === "zone")).toHaveLength(2);
  const table = search("table 57");
  expect(table).toHaveLength(1);
  expect(table[0]).toMatchObject({ kind: "note" });
  expect(VIEWS[0]!.name).toBe("Entrance");
});

test("every spot to walk to is on open floor, a few steps from where it says", () => {
  for (const v of VIEWS) expect(meters(nearestOpen(v.at, true), v.at), v.name).toBeLessThan(4);
  expect(canStand(VIEWS[0]!.at)).toBe(true);
});

test("from the entrance, every destination can be walked to without going through a wall", () => {
  const start = VIEWS[0]!.at;
  for (const item of ITEMS) {
    const end = standFor(item);
    const path = route(start, end);
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(end);
    for (let k = 1; k < path.length; k++) {
      const [a, b] = [path[k - 1]!, path[k]!];
      const n = Math.ceil(meters(a, b) * 4);
      for (let i = 0; i <= n; i++) expect(canStand([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]), `${item.name}, leg ${k}`).toBe(true);
    }
  }
});

test("you end up in front of what you came to see: booths up close, rooms at their door", () => {
  for (const item of ITEMS.filter((i) => i.kind === "sponsor")) expect(meters(standFor(item), item.at), item.name).toBeLessThan(6);
  for (const item of ITEMS.filter((i) => i.kind === "place")) expect(meters(standFor(item), item.at), item.name).toBeLessThan(12);
  expect(standFor(ITEMS.find((i) => i.name === "Stage")!)[0]).toBeGreaterThan(140); // out in the hall, not backstage
  for (const r of ROOMS) expect(doorOf(r.poly), r.name).not.toBeNull();
  const restrooms = ITEMS.find((i) => i.name === "Restrooms")!;
  const door = doorOf(ROOMS.find((r) => r.name === "Restrooms")!.poly)!;
  expect(meters(standFor(restrooms), door.at)).toBeLessThan(4);
});

test("signs can't be seen through the closed-off parts of the building", () => {
  const entrance = VIEWS[0]!.at;
  expect(seen(entrance, PLACES.find((p) => p.name === "Box office")!.at)).toBe(true);
  expect(seen(entrance, PLACES.find((p) => p.name === "Green rooms")!.at)).toBe(false); // the far end, round the curve
});

test("the page explains when 3D isn't available, and search and details still work", async () => {
  render(<VenueClient />);
  expect(screen.getByText("Cal Hacks 13.0 venue")).toBeInTheDocument();
  expect(await screen.findByText(/can’t show the 3D view/)).toBeInTheDocument(); // jsdom has no WebGL
  await userEvent.type(screen.getByLabelText("Search the venue"), "bright");
  await userEvent.click(await screen.findByRole("button", { name: /20 · Bright Data/ }));
  expect(screen.getByRole("status")).toHaveTextContent("Sponsor booth");
  expect(screen.getByRole("status")).toHaveTextContent("Bright Data");
  expect(screen.queryByRole("button", { name: "Walk me there" })).toBeNull(); // nothing to walk in without 3D
  await userEvent.click(screen.getByRole("button", { name: "Browse" }));
  expect(screen.getByRole("button", { name: "Middle of the hall" })).toBeInTheDocument();
});
