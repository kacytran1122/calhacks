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

test("confirms a typed city before searching and places event search below the result count", async () => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/location/resolve")) return response({ zip: "61401", label: "Galesburg, IL" });
    return response(result);
  });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<FindClient initialZip="" />);

  await user.type(screen.getByLabelText("Starting city or ZIP code"), "Galesburg, IL");
  await user.click(screen.getByRole("button", { name: "Find nearby events" }));

  expect(screen.getByText("Is Galesburg, IL your current location?")).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "No, keep this place" }));

  const count = await screen.findByText(/events within 200 mi of Galesburg, IL/);
  const eventSearch = screen.getByLabelText("Search events by name or topic");
  expect(count.compareDocumentPosition(eventSearch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  render(<FindClient initialZip="61401" />);

  const search = await screen.findByLabelText("Search events by name or topic");
  fireEvent.change(search, { target: { value: "Cal Hacks" } });
  fireEvent.submit(search.closest("form")!);

  expect(await screen.findByText("Cal Hacks 13.0 is outside your 200-mile travel area.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Expand to 1,850 mi" })).toBeVisible();
});
