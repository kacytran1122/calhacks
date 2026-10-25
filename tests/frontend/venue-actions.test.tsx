import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { VenueTourAction } from "../../frontend/app/find/VenueTourAction";
import { ContributionForm } from "../../frontend/app/tours/contribute/ContributionForm";
import { FindClient } from "../../frontend/app/find/FindClient";
import { contributionUrl, venueTourFor } from "../../frontend/lib/venueTours";

test("only identifies LA Hacks and Cal Hacks as available model families", () => {
  expect(venueTourFor({ name: "LA Hacks 2027", url: "https://lahacks.com" })?.href).toBe("/tour");
  expect(venueTourFor({ name: "CalHacks 13.0", url: "https://calhacks.io/" })?.href).toBe("/venue");
  expect(venueTourFor({ name: "LAHacks", url: "https://2027.lahacks.com/" })?.href).toBe("/tour");
  for (const event of [
    { name: "HackTX 26", url: "https://hacktx.com" },
    { name: "Local Hacks", url: "https://example.org" },
    { name: "Not Cal Hacks", url: "https://not-calhacks.io" },
    { name: "A meetup", url: "https://calhacks.io.example.org" },
    { name: "Cal Hacks 13", url: "https://lahacks.com" },
    { name: "LA Hacks", url: "javascript:alert(1)" },
  ]) expect(venueTourFor(event)).toBeNull();
});

test("routes Cal Hacks to its walkthrough instead of requesting photos", () => {
  render(<VenueTourAction event={{ name: "Cal Hacks 13.0", url: "https://calhacks.io" }} />);
  expect(screen.getByRole("link", { name: "Immerse in a 3D tour" })).toHaveAttribute("href", "/venue");
  expect(screen.queryByRole("link", { name: "Contribute venue photos" })).not.toBeInTheDocument();
});

test("routes LA Hacks to its original GLB tour", () => {
  render(<VenueTourAction event={{ name: "LA Hacks", url: "https://lahacks.com" }} />);
  expect(screen.getByRole("link", { name: "Immerse in a 3D tour" })).toHaveAttribute("href", "/tour");
});

test("gives other events a contribution form with the chosen event identity", () => {
  const event = { name: "HackTX 26", url: "https://hacktx.com/?a=1&b=2", city: "Austin, TX", venue: "Campus" };
  render(<VenueTourAction event={event} />);
  expect(screen.queryByRole("link", { name: "Immerse in a 3D tour" })).not.toBeInTheDocument();
  const href = screen.getByRole("link", { name: "Contribute venue photos" }).getAttribute("href")!;
  expect(href).toBe(contributionUrl(event));
  const query = new URL(href, "https://smilefromhereto.work").searchParams;
  expect(query.get("event")).toBe("HackTX 26");
  expect(query.get("url")).toBe(event.url);
  expect(query.get("location")).toBe("Campus, Austin, TX");
});

test("event discovery only shows two available tour buttons", async () => {
  const events = [
    { name: "LA Hacks", url: "https://lahacks.com/" },
    { name: "Cal Hacks 13.0", url: "https://calhacks.io/" },
    { name: "HackTX 26", url: "https://hacktx.com/" },
    { name: "SBUHacks", url: "https://sbuhacks.org/" },
  ].map((event, i) => ({ ...event, key: String(i), source: "mlh", city: "Event city", locationPrecision: "city", kind: "hackathon", distanceMiles: 50, fetchedAt: "2026-10-25T00:00:00Z", via: "direct" }));
  const body = { origin: { zip: "61401" }, radiusMiles: 200, events, unplaced: [], sources: [], store: "local", classifiedBy: "keywords" };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(body) })));
  const user = userEvent.setup();
  render(<FindClient initialZip="61401" />);
  await user.click(screen.getByRole("button", { name: "Update nearby events" }));
  expect(await screen.findAllByRole("link", { name: "Immerse in a 3D tour" })).toHaveLength(2);
  expect(screen.getAllByRole("link", { name: "Contribute venue photos" })).toHaveLength(2);
});

function previewUrls() {
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => "blob:test-venue-photo");
    static revokeObjectURL = vi.fn();
  });
}

test("submits real files and consent and displays a server receipt", async () => {
  previewUrls();
  const fetcher = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ receiptId: "venue-test-receipt", eventName: "HackTX 26", photoCount: 1 }) }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ContributionForm initialEvent="HackTX 26" initialUrl="https://hacktx.com" initialLocation="Austin, TX" />);
  const photo = new File(["photo bytes"], "venue.png", { type: "image/png" });
  await user.upload(screen.getByLabelText(/Give us a look around/), photo);
  expect(screen.getByRole("img", { name: "Selected venue photo 1" })).toBeVisible();
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Send venue photos" }));
  expect(await screen.findByText("Thank you for the new perspective.")).toBeVisible();
  expect(screen.getByText("venue-test-receipt")).toBeVisible();
  expect(screen.getByText(/Nothing has been published/)).toBeVisible();
  const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(request[0]).toBe("/api/tours/contributions");
  const data = request[1].body as FormData;
  expect(data.get("eventName")).toBe("HackTX 26");
  expect(data.get("consent")).toBe("true");
  expect(data.getAll("photos")).toHaveLength(1);
  expect((data.get("photos") as File).name).toBe("venue.png");
  await user.click(screen.getByRole("button", { name: "Contribute another batch" }));
  expect(screen.getByRole("button", { name: "Send venue photos" })).toBeVisible();
});

test("rejects oversized selections without making an upload request", async () => {
  previewUrls();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ContributionForm initialEvent="HackTX" initialUrl="https://hacktx.com" />);
  await user.upload(screen.getByLabelText(/Give us a look around/), new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.jpg", { type: "image/jpeg" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("within 3 MB in total");
  expect(fetcher).not.toHaveBeenCalled();
});

test("keeps selected material available when the upload fails", async () => {
  previewUrls();
  const fetcher = vi.fn(() => Promise.resolve({ ok: false, status: 503, json: async () => ({ error: "Photo storage is temporarily unavailable." }) }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ContributionForm initialEvent="HackTX" initialUrl="https://hacktx.com" />);
  await user.upload(screen.getByLabelText(/Give us a look around/), new File(["photo"], "room.jpg", { type: "image/jpeg" }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Send venue photos" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Photo storage is temporarily unavailable.");
  expect(screen.getByRole("img", { name: "Selected venue photo 1" })).toBeVisible();
  await waitFor(() => expect(screen.getByRole("button", { name: "Send venue photos" })).toBeEnabled());
});

test("does not accept more than six photos", async () => {
  previewUrls();
  render(<ContributionForm />);
  const input = screen.getByLabelText(/Give us a look around/);
  fireEvent.change(input, { target: { files: Array.from({ length: 7 }, (_, i) => new File(["photo"], `${i}.png`, { type: "image/png" })) } });
  expect(await screen.findByRole("alert")).toHaveTextContent("up to six photos");
});

test("preserves edited event details when contributing another batch", async () => {
  previewUrls();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ receiptId: "venue-corrected", eventName: "HackTX corrected", photoCount: 1 }) })));
  const user = userEvent.setup();
  render(<ContributionForm initialEvent="Old event" initialUrl="https://old.example.org" initialLocation="Old building" />);
  await user.clear(screen.getByLabelText("Event name"));
  await user.type(screen.getByLabelText("Event name"), "HackTX corrected");
  await user.clear(screen.getByLabelText("Official event website"));
  await user.type(screen.getByLabelText("Official event website"), "https://hacktx.com");
  await user.clear(screen.getByLabelText(/Building or venue location/));
  await user.type(screen.getByLabelText(/Building or venue location/), "Correct building");
  await user.upload(screen.getByLabelText(/Give us a look around/), new File(["photo"], "venue.png", { type: "image/png" }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Send venue photos" }));
  await user.click(await screen.findByRole("button", { name: "Contribute another batch" }));
  expect(screen.getByLabelText("Event name")).toHaveValue("HackTX corrected");
  expect(screen.getByLabelText("Official event website")).toHaveValue("https://hacktx.com");
  expect(screen.getByLabelText(/Building or venue location/)).toHaveValue("Correct building");
  expect(screen.getByRole("checkbox")).not.toBeChecked();
});
