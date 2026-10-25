import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { FindClient } from "../../frontend/app/find/FindClient";
import { TripInsights } from "../../frontend/app/find/TripInsights";

const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) } as Response);

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

test("shows a live Google Flights observation beside the trained forecast", async () => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("live-flight-price")) return response({
      live: { status: "ok", amountUsd: 219, currency: "USD", fromAirport: "SFO", toAirport: "LAX", departDate: "2027-01-16", observedAt: "2026-10-24T19:00:00Z", sourceUrl: "https://www.google.com/travel/flights?q=SFO+LAX", via: "Bright Data Google Flights scraper", scope: "Lowest USD fare returned for this airport pair and date" },
      prediction: { range: { p10: 180, p50: 230, p90: 310 } },
      signal: "within_prediction",
      differencePct: -5,
    });
    if (url.includes("price-estimate")) return response({
      scope: { eligible: true, fromState: "CA", toState: "NV", reason: "Domestic interstate trip from CA to NV." },
      rideshare: null,
      airfare: { from: { code: "SFO", city: "San Francisco" }, to: { code: "LAX", city: "Los Angeles" }, miles: 340, range: { p10: 180, p50: 230, p90: 310 }, byHour: [], cheapestHour: null, caveat: "Forecast only." },
      drive: { status: "ok", source: "test", miles: 380, minutes: 360 },
      models: { rideshare: { metrics: {}, data: {} }, airfare: { metrics: {}, data: {} } },
    });
    return response({ status: "empty", basis: "forecast", center: { lat: 34, lon: -118 }, radiusMiles: 5, cells: [], hotspots: [], regionMedianF: null, band: "Unavailable", summary: "", method: [], sources: [] });
  }));
  render(<TripInsights from={{ lat: 37.6, lon: -122.3 }} to={{ lat: 34.1, lon: -118.2 }} startsAt="2027-01-17T17:00:00Z" fromState="CA" toState="NV" />);
  expect(await screen.findByText("$219")).toBeVisible();
  expect(screen.getByText(/forecast midpoint \$230/)).toBeVisible();
  expect(screen.getByRole("link", { name: /Open Google Flights/ })).toHaveAttribute("href", expect.stringContaining("google.com/travel/flights"));
});

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
    if (url.startsWith("/api/location/resolve")) return response({ zip: "61401", label: "Galesburg, IL", lat: 40.9478, lon: -90.3712 });
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

test("resolves a place label to precise coordinates before discovering events", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "90095", label: "UCLA", lat: 34.0709, lon: -118.4469 });
    return response({ ...result, origin: { zip: "90095", label: "UCLA" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="90095" initialOrigin="UCLA" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));

  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/location/resolve");
  expect(String(fetcher.mock.calls[1]?.[0])).toContain("zip=90095");
  expect(String(fetcher.mock.calls[1]?.[0])).toContain("lat=34.0709");
  expect(String(fetcher.mock.calls[1]?.[0])).toContain("lon=-118.4469");
});

test("uses precise browser coordinates and replaces the placeholder with the nearby city", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "92697", label: "Irvine, CA", lat: 33.6405, lon: -117.8443 });
    return response({ ...result, origin: { zip: "92697", label: "Irvine, CA" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" initialOrigin="Current location" initialLat={33.6405} initialLon={-117.8443} />);

  await waitFor(() => expect(screen.getByLabelText("Starting ZIP, city, or state")).toHaveValue("Irvine, CA"));
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));

  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/location/resolve?lat=33.6405&lon=-117.8443&fallbackZip=61401");
  const request = String(fetcher.mock.calls[1]?.[0]);
  expect(request).toContain("zip=92697");
  expect(request).toContain("lat=33.6405");
  expect(request).toContain("lon=-117.8443");
  expect(request).toContain("originLabel=Irvine%2C+CA");
  expect(await screen.findByText(/events within 200 mi of Irvine, CA/)).toBeVisible();
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
  expect(screen.getByRole("link", { name: "Immerse in a 3D tour" })).toHaveAttribute("href", "/venue");
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

test("constraint review asks one follow-up when a requirement is unclear", async () => {
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

test("keeps earlier clarification answers and opens an empty field for each new question", async () => {
  const event = {
    key: "uci",
    source: "luma",
    name: "UCI Build Night",
    startsAt: "2026-10-25T17:00:00Z",
    city: "Irvine, CA",
    locationPrecision: "exact",
    url: "https://lu.ma/uci",
    kind: "tech",
    distanceMiles: 4,
    fetchedAt: "2026-10-24T00:00:00Z",
    via: "direct",
  };
  const constraintBodies: string[] = [];
  const questions = [
    "Which UCI building should S’mile use?",
    "What date should you arrive?",
    "Which time zone should S’mile use?",
  ];
  const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "/api/constraints") {
      constraintBodies.push(String(init?.body));
      const question = questions[constraintBodies.length - 1];
      return response({ status: "needs_clarification", summary: "Need arrival details", destination: null, arriveBy: null, departAfter: null, timezone: null, followUpQuestion: question, parsedBy: "claude" });
    }
    return response({ ...result, events: [event] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="92697" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "100");
  await user.type(screen.getByLabelText("Travel timing and destination requirements"), "I need to be at UCI by 10");
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));

  const answer = await screen.findByLabelText("Answer the travel requirement question");
  await user.type(answer, "Donald Bren Hall");
  await user.click(screen.getByRole("button", { name: "Answer and compare routes" }));

  expect(await screen.findByText("What date should you arrive?")).toBeVisible();
  expect(screen.getByText("Donald Bren Hall")).toBeVisible();
  expect(screen.getByLabelText("Answer the travel requirement question")).toHaveValue("");
  await user.type(screen.getByLabelText("Answer the travel requirement question"), "October 25 at 10 AM");
  await user.click(screen.getByRole("button", { name: "Answer and compare routes" }));

  expect(await screen.findByText("Which time zone should S’mile use?")).toBeVisible();
  expect(screen.getByText("Donald Bren Hall")).toBeVisible();
  expect(screen.getByText("October 25 at 10 AM")).toBeVisible();
  expect(screen.getByLabelText("Answer the travel requirement question")).toHaveValue("");
  expect(constraintBodies[1]).toContain("Which UCI building should S’mile use?");
  expect(constraintBodies[1]).toContain("Donald Bren Hall");
  expect(constraintBodies[2]).toContain("Donald Bren Hall");
  expect(constraintBodies[2]).toContain("October 25 at 10 AM");
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
      { id: "guide", kind: "route_guide", source: "Live routing", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { options: [{ mode: "bus", title: "Bus to LAX", durationText: "55 minutes", durationMinutes: 55, sourceUrl: "https://example.com/route", fareUrl: "https://example.com/fare", sourceQuote: "Take the airport bus to LAX", steps: [{ instruction: "Walk to the UCLA transit stop.", detail: "Use the Westwood entrance." }, { instruction: "Take the airport bus to LAX.", detail: "Confirm the live departure before leaving." }] }, { mode: "flight", title: "Combined trip via LAX → SFO", durationText: "About 4 hr door to door", durationMinutes: 240, sourceUrl: "https://www.google.com/travel/flights/", fareUrl: "https://www.google.com/travel/flights/", sourceQuote: "Estimated door-to-door flight time; verify the current itinerary.", steps: [{ instruction: "Take the ground connection to LAX.", detail: "Allow time for security." }, { instruction: "Fly to SFO, then take the final ground connection.", detail: "Check Google Flights and the destination transit route." }] }] } },
    ],
    routes: {
      options: [
        { mode: "bus", costCents: 1075, costSource: "fare", pMiss: 0.1, history: { trips: 12, late: 1 }, withinCap: true, withinBudget: true },
        { mode: "rideshare", costCents: 3400, costSource: "fare", pMiss: 0.2, history: { trips: 5, late: 1 }, withinCap: true, withinBudget: true },
      ],
      pick: { mode: "bus" },
      fastest: "bus",
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
    if (url === "/api/chat/photon/join") {
      const starterMessage = "@smile open my route SMILE-2345-6789-ABCD-EFGH";
      return response({
        messageUrl: `sms:+14155550199?&body=${encodeURIComponent(starterMessage)}`,
        starterMessage,
        expiresAt: "2026-10-25T12:15:00.000Z",
      });
    }
    return response({ ...result, origin: { zip: "90095", label: "UCLA" }, events: [event] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="90095" initialOrigin="UCLA" />);

  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "100");
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));

  const bestHeading = await screen.findByText("Best route");
  expect(bestHeading).toBeVisible();
  expect(screen.getByText("Walk to the UCLA transit stop.")).toBeVisible();
  expect(screen.getByText("$10.75 total fare", { exact: false })).toBeVisible();
  expect(screen.getByText("Fastest available itinerary")).toBeVisible();
  expect(screen.getByText("Fastest route")).toBeVisible();
  expect(screen.getByText("Other ways to get there")).toBeVisible();
  expect(screen.getAllByText("Rideshare").length).toBeGreaterThan(0);
  const bestRoute = bestHeading.closest("section")!;
  const routeButton = within(bestRoute).getByRole("button", { name: /Open step-by-step route/ });
  const fareLink = within(bestRoute).getByRole("link", { name: /Check Fare/ });
  expect(fareLink).toHaveAttribute("href", "https://example.com/fare");
  expect(routeButton.parentElement).toBe(fareLink.parentElement);
  expect(screen.queryByText(/live directions?/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Route data sources/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Open data source/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/This route remains visible for comparison/i)).not.toBeInTheDocument();
  const flightRoute = Array.from(document.querySelectorAll("details.fd-route-card")).find((card) => card.textContent?.includes("Combined trip via LAX → SFO"))!;
  expect(within(flightRoute).getByRole("button", { name: /Open step-by-step route/, hidden: true })).toBeInTheDocument();
  expect(within(flightRoute).getByRole("link", { name: /Check Fare/, hidden: true })).toHaveAttribute("href", "https://www.google.com/travel/flights/");
  const beforeHref = window.location.href;
  expect(screen.queryByRole("link", { name: /Open step-by-step route/ })).not.toBeInTheDocument();
  await user.click(routeButton);
  const photonDialog = await screen.findByRole("dialog", { name: "Scan, then send the message" });
  expect(photonDialog).toBeVisible();
  expect(within(photonDialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(within(photonDialog).queryByRole("checkbox")).not.toBeInTheDocument();
  expect(window.location.href).toBe(beforeHref);
  expect(document.body.innerHTML).not.toContain("token");
});

test("keeps detailed transit visible while its fare is being verified", async () => {
  const event = {
    key: "irvine-event", source: "luma", name: "Irvine Build Night", startsAt: "2026-10-25T17:00:00Z", city: "Irvine, CA", venue: "UCI", locationPrecision: "exact" as const, url: "https://lu.ma/irvine", kind: "tech" as const, distanceMiles: 45, fetchedAt: "2026-10-24T00:00:00Z", via: "direct",
  };
  const plan = {
    approvalToken: "token",
    trip: { id: "TR-2", mode: "train", quoteCents: 0, distanceMiles: 45, travelerId: "T-2" },
    event: { name: event.name, startsAt: event.startsAt },
    evidence: [
      { id: "fare", kind: "fare", source: "Official fares", status: "timeout", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", note: "Bright Data did not respond within 6 seconds", data: { fares: [] } },
      { id: "stop", kind: "stop", source: "Live search", status: "timeout", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", note: "Bright Data did not respond within 6 seconds", data: { results: [] } },
      { id: "guide", kind: "route_guide", source: "Transitous", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { options: [{ mode: "train", title: "Metro + Metrolink to Irvine", durationText: "2 hrs 20 min", sourceUrl: "https://transitous.org/sources/", fareUrl: "https://metrolinktrains.com/ticketsOverview/", sourceQuote: "Live GTFS itinerary.", steps: [{ instruction: "Take Metro from UCLA to Union Station.", detail: "Check the current platform." }, { instruction: "Take Metrolink to Tustin.", detail: "Transfer to the final local bus." }] }] } },
    ],
    routes: { options: [], cap: 4000, travelerBudgetCents: 10000 },
    inbox: null,
    buddies: [],
  };
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "90095", label: "UCLA", lat: 34.0709, lon: -118.4469 });
    if (url === "/api/plan") return response(plan);
    return response({ ...result, origin: { zip: "90095", label: "UCLA" }, events: [event] });
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="90095" initialOrigin="UCLA" />);
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "100");
  await user.click(screen.getByLabelText("Include self-drive"));
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));
  const bestHeading = await screen.findByText("Best route");
  expect(bestHeading).toBeVisible();
  expect(screen.getByText("Take Metro from UCLA to Union Station.")).toBeVisible();
  const bestRoute = bestHeading.closest("section")!;
  expect(within(bestRoute).getByRole("button", { name: /Open step-by-step route/ })).toBeVisible();
  expect(within(bestRoute).getByRole("link", { name: /Check Fare/ })).toHaveAttribute("href", "https://metrolinktrains.com/ticketsOverview/");
  expect(screen.queryByText(/live directions?/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Route data sources/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/fare verification needed/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/This route remains visible for comparison/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/A verified live fare is not available/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Bright Data did not respond/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "A stop on the way" })).not.toBeInTheDocument();
  expect(screen.queryByText(/No route fits organizer policy/i)).not.toBeInTheDocument();
});

test("binds an official fare to the exact live itinerary it covers", async () => {
  const event = {
    key: "irvine-priced", source: "luma", name: "Irvine Tech Day", startsAt: "2026-10-25T17:00:00Z", city: "Irvine, CA", venue: "UCI", locationPrecision: "exact" as const, url: "https://lu.ma/irvine-priced", kind: "tech" as const, distanceMiles: 45, fetchedAt: "2026-10-24T00:00:00Z", via: "direct",
  };
  const coveredTitle = "Public transit via Metro + OC Line";
  const plan = {
    approvalToken: "token",
    trip: { id: "TR-3", mode: "train", quoteCents: 1200, distanceMiles: 45, travelerId: "T-3", reimbursementEligibleCents: 1200 },
    event: { name: event.name, startsAt: event.startsAt },
    evidence: [
      { id: "fare", kind: "fare", source: "Official fares", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { fares: [{ mode: "train", amountUsd: 12, link: "https://metrolinktrains.com", quote: "Metrolink weekend pass is $12.", routeTitle: coveredTitle }] } },
      { id: "guide", kind: "route_guide", source: "Transitous", status: "ok", provenance: "live", fetchedAt: "2026-10-24T00:00:00Z", data: { options: [
        { mode: "train", title: "Public transit via Amtrak", durationText: "2 hrs", sourceUrl: "https://transitous.org/sources/", sourceQuote: "Live GTFS itinerary.", steps: [{ instruction: "Take Amtrak.", detail: "This fare is separate." }] },
        { mode: "train", title: coveredTitle, durationText: "2 hrs 30 min", sourceUrl: "https://transitous.org/sources/", sourceQuote: "Live GTFS itinerary.", steps: [{ instruction: "Take Metrolink OC Line.", detail: "The pass covers this itinerary." }] },
      ] } },
    ],
    routes: { options: [{ mode: "train", costCents: 1200, costSource: "fare", pMiss: 0.1, history: { trips: 0, late: 0 }, withinCap: true, withinBudget: true }], pick: { mode: "train" }, cap: 5000, travelerBudgetCents: 10000 },
    inbox: null,
    buddies: [],
  };
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/plan" ? response(plan) : response({ ...result, origin: { zip: "90024", label: "UCLA" }, events: [event] })));
  const user = userEvent.setup();
  const { container } = render(<FindClient initialZip="90024" initialOrigin="UCLA" initialLat={34.0711778} initialLon={-118.4511766} />);
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  await user.click(await screen.findByRole("button", { name: "Plan my trip" }));
  await user.type(screen.getByLabelText("Your maximum travel budget in dollars"), "100");
  await user.click(screen.getByRole("button", { name: "Compare ways to get there" }));
  expect(await screen.findByText("Best route")).toBeVisible();
  expect(container.querySelector(".fd-route-card.best")?.textContent).toContain("Take Metrolink OC Line.");
  expect(container.querySelector(".fd-route-card.best")?.textContent).not.toContain("Take Amtrak.");
});
