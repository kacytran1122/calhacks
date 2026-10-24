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
