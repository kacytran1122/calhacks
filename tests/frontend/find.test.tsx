import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FindClient } from "../../frontend/app/find/FindClient";

const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);

const result = {
  origin: { zip: "61401", label: "Galesburg, IL" },
  radiusMiles: 200,
  events: [],
  outsideRadius: [],
  unplaced: [],
  sources: [],
  store: "local",
  classifiedBy: "keywords",
};

test("shows branded event type icons without the old header description", () => {
  vi.stubGlobal("fetch", vi.fn(() => response(result)));
  render(<FindClient initialZip="" />);

  expect(screen.getByRole("button", { name: /MLH events/ }).querySelector('img[src="/mlh-logo.png"]')).not.toBeNull();
  expect(screen.getByRole("button", { name: /Tech events/ }).querySelector('img[src="/tech-events-icon.png"]')).not.toBeNull();
  expect(screen.queryByText("Official MLH hackathons and local tech events, clearly separated.")).not.toBeInTheDocument();
});

test("resolves a typed city and places event search below the result count", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "61401", label: "Galesburg, IL" });
    return response(result);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="" />);

  await user.type(screen.getByLabelText("Starting ZIP, city, or state"), "Galesburg");
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));

  const count = await screen.findByText(/events within 200 mi of Galesburg, IL/);
  const eventSearch = screen.getByLabelText("Search events by name or topic");
  expect(count.compareDocumentPosition(eventSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("waits for confirmation before loading nearby events", async () => {
  const fetcher = vi.fn(() => response(result));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);

  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Search events by name or topic")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  expect(await screen.findByLabelText("Search events by name or topic")).toBeVisible();
});

test("keeps the resolved ZIP when the displayed origin is a place label", async () => {
  const fetcher = vi.fn(() => response({ ...result, origin: { zip: "90095", label: "UCLA" } }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="90095" initialOrigin="UCLA" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("zip=90095");
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain("/api/location/resolve");
});

test("switches between miles and kilometers without changing the search radius", async () => {
  vi.stubGlobal("fetch", vi.fn(() => response(result)));
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);

  expect(screen.getByLabelText("Maximum route distance in miles")).toHaveValue(200);
  await user.click(screen.getByRole("button", { name: "km" }));
  expect(screen.getByLabelText("Maximum route distance in kilometers")).toHaveValue(322);
});

test("explains when a named event is beyond the selected distance", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("q=Cal+Hacks")) {
      return response({
        ...result,
        outsideRadius: [{ key: "calhacks", source: "mlh", name: "Cal Hacks 13.0", city: "San Francisco, CA", locationPrecision: "city", url: "https://calhacks.io/", kind: "hackathon", distanceMiles: 1850, fetchedAt: "2026-10-24T00:00:00Z", via: "direct" }],
      });
    }
    return response(result);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  const search = await screen.findByLabelText("Search events by name or topic");
  fireEvent.change(search, { target: { value: "Cal Hacks" } });
  fireEvent.submit(search.closest("form")!);

  expect(await screen.findByText("Cal Hacks 13.0 is outside your 200 mi travel area.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand to 1,850 mi" })).toBeVisible();
});

test("shows each event thumbnail and asks for travel requirements below the budget", async () => {
  const event = {
    key: "calhacks",
    source: "mlh",
    name: "Cal Hacks 13.0",
    startsAt: "2026-10-25T17:00:00Z",
    city: "San Francisco, CA",
    locationPrecision: "city",
    url: "https://calhacks.io/",
    thumbnailUrl: "https://example.com/calhacks.png",
    kind: "hackathon",
    distanceMiles: 1850,
    fetchedAt: "2026-10-24T00:00:00Z",
    via: "direct",
  };
  vi.stubGlobal("fetch", vi.fn(() => response({ ...result, events: [event] })));
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  const card = (await screen.findByText("Cal Hacks 13.0")).closest("article")!;
  expect(card.querySelector('img[src="https://example.com/calhacks.png"]')).not.toBeNull();
  await user.click(screen.getByRole("button", { name: "Plan my trip" }));

  const budget = screen.getByLabelText("Your maximum travel budget in dollars");
  const requirements = screen.getByLabelText("Travel timing and destination requirements");
  expect(budget.compareDocumentPosition(requirements) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText(/Claude will turn clear details into route constraints/)).not.toBeInTheDocument();
  expect(requirements).toHaveAttribute("placeholder", expect.stringContaining("UCI"));
});

test("Claude constraint step asks one follow-up when a requirement is unclear", async () => {
  const event = {
    key: "knox",
    source: "luma",
    name: "Knox Build Night",
    startsAt: "2026-10-25T17:00:00Z",
    city: "Galesburg, IL",
    locationPrecision: "exact",
    url: "https://lu.ma/knox",
    kind: "tech",
    distanceMiles: 2,
    fetchedAt: "2026-10-24T00:00:00Z",
    via: "direct",
  };
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    if (String(input) === "/api/constraints") {
      return response({ status: "needs_clarification", summary: "Need to be at school at 10", destination: null, arriveBy: null, departAfter: null, timezone: null, followUpQuestion: "Which school, date, AM or PM, and time zone should S’mile use?", parsedBy: "claude" });
    }
    return response({ ...result, events: [event] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "120");
  await user.type(screen.getByLabelText("Travel timing and destination requirements"), "Need to be at school at 10");
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));

  expect(await screen.findByText("One detail before S’mile plans")).toBeVisible();
  expect(screen.getByText(/Which school, date, AM or PM/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Answer and compare routes" })).toBeDisabled();
});

test("shows the best route first with detailed steps, total cost, and alternatives", async () => {
  const event = {
    key: "lax-event",
    source: "luma",
    name: "LAX Build Night",
    startsAt: "2026-10-25T17:00:00Z",
    city: "Los Angeles, CA",
    venue: "LAX",
    locationPrecision: "exact",
    url: "https://lu.ma/lax",
    kind: "tech",
    distanceMiles: 12,
    fetchedAt: "2026-10-24T00:00:00Z",
    via: "direct",
  };
  const plan = {
    approvalToken: "token",
    trip: { id: "TR-1", mode: "bus", quoteCents: 1075, distanceMiles: 12, travelerId: "T-1", reimbursementEligibleCents: 1075 },
    event: { name: event.name, startsAt: event.startsAt },
    evidence: [
      { id: "fare", kind: "fare", source: "Bright Data", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { fares: [{ mode: "bus", amountUsd: 10.75, link: "https://example.com/fare", quote: "$10.75 total fare" }] } },
      { id: "guide", kind: "route_guide", source: "Bright Data → Claude", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { options: [{ mode: "bus", title: "Bus to LAX", durationText: "55 minutes", sourceUrl: "https://example.com/route", sourceQuote: "Take the airport bus to LAX", steps: [{ instruction: "Walk to the UCLA transit stop.", detail: "Use the Westwood entrance." }, { instruction: "Take the airport bus to LAX.", detail: "Confirm the live departure before leaving." }] }] } },
    ],
    routes: {
      options: [
        { mode: "bus", costCents: 1075, costSource: "fare", pMiss: 0.1, history: { trips: 12, late: 1 }, withinCap: true, withinBudget: true },
        { mode: "rideshare", costCents: 3400, costSource: "fare", pMiss: 0.2, history: { trips: 5, late: 1 }, withinCap: true, withinBudget: true },
      ],
      pick: { mode: "bus" },
      cap: 5000,
      travelerBudgetCents: 10000,
    },
    inbox: null,
    buddies: [],
  };
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "90095", label: "UCLA" });
    if (url === "/api/plan") return response(plan);
    return response({ ...result, origin: { zip: "90095", label: "UCLA" }, events: [event] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="90095" initialOrigin="UCLA" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "100");
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));

  expect(await screen.findByText("Best route")).toBeVisible();
  expect(screen.getByText("Walk to the UCLA transit stop.")).toBeVisible();
  expect(screen.getByText("$10.75 total fare", { exact: false })).toBeVisible();
  expect(screen.getByText("Other ways to get there")).toBeVisible();
  expect(screen.getAllByText("Rideshare").length).toBeGreaterThan(0);
});
