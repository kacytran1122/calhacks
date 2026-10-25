import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { TripReceiptDialog } from "../../frontend/app/map/MapClient";
import { mountTripReceipt } from "../../frontend/public/map-assets/trip-receipt.js";

const bus = { legId: "journey1:bus1", mode: "bus", service: "Metro 720", from: "Westwood Boulevard", to: "Wilshire / Vermont", expectedReceiptId: "ride_1" };
const train = { legId: "journey1:train1", mode: "train", service: "Metro B Line", from: "Wilshire / Vermont", to: "Union Station" };
const context = { journeyId: "journey1", from: "Westwood", to: "Union Station", legs: [bus, train], hasPaymentAttempt: true };
const ride = { id: "ride_1", journeyId: context.journeyId, legId: bus.legId };
const receipt = {
  id: "trip_demo_1", journeyId: context.journeyId, from: context.from, to: context.to, createdAt: "2026-10-25T14:00:00.000Z", currency: "USD", totalRecordedCents: 275,
  legs: [
    { legId: bus.legId, mode: bus.mode, service: bus.service, from: bus.from, to: bus.to, status: "demo_receipt_recorded", receiptId: "ride_1", amountCents: 275 },
    { ...train, status: "no_payment_recorded", amountCents: null },
  ],
  provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "owned_demo_receipts",
};
const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
const expired = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "Receipt session expired.", code: "ride_demo_session_expired" }) } as Response);

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});

function openSummary(fetcher: ReturnType<typeof vi.fn>, overrides = {}) {
  vi.stubGlobal("fetch", fetcher);
  render(<TripReceiptDialog />);
  const controller = mountTripReceipt();
  const onContinue = vi.fn();
  const onDismiss = vi.fn();
  controller.open({ ...context, onContinue, onDismiss, ...overrides });
  return { controller, onContinue, onDismiss, fetcher };
}

test("consolidates only server-recorded demo payments and downloads their references without another charge", async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => url.endsWith("/trip") && init?.method === "POST" ? response({ receipt, replayed: false }) : response({ receipts: [ride] }));
  const createUrl = vi.fn(() => "blob:trip-receipt");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  let filename = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { filename = this.download; });
  const { controller, onContinue } = openSummary(fetcher);
  await screen.findByRole("region", { name: "Consolidated demo receipt" });
  expect(screen.getByText("$2.75")).toBeVisible();
  expect(screen.getByText("No payment recorded")).toBeVisible();
  expect(screen.getByText("Receipt ride_1")).toBeVisible();
  expect(fetcher.mock.calls[0][0]).toBe("/api/map/ride-payments?recover=1");
  const posted = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(posted).toEqual({ journeyId: context.journeyId, from: context.from, to: context.to, legs: context.legs, completed: true });
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => call[0])).toEqual(["/api/map/ride-payments/trip"]);
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(controller.isOpen()).toBe(true);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Download trip receipt (.txt)" }));
  expect(filename).toBe("smile-trip-demo-receipt-trip_demo_1.txt");
  const blob = createUrl.mock.calls[0][0] as Blob;
  const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
  expect(text).toContain("Recorded demo total: $2.75 USD");
  expect(text).toContain("Receipt ride_1");
  expect(text).toContain("No payment recorded");
  expect(text).toContain("not valid for reimbursement");
  expect(text).toContain("No real Visa API was used");
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(onContinue).toHaveBeenCalledWith({ receipt: expect.objectContaining({ id: receipt.id }) });
});

test("labels a walk-only zero total as no simulated payments rather than a free journey", async () => {
  const walk = { journeyId: "walk1", from: "Library", to: "Campus", legs: [], hasPaymentAttempt: false };
  const empty = { ...receipt, id: "walk_summary", ...walk, totalRecordedCents: 0, legs: [] };
  const fetcher = vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? response({ receipt: empty, replayed: false }) : response({ receipts: [] }));
  openSummary(fetcher, walk);
  await screen.findByRole("region", { name: "Consolidated demo receipt" });
  expect(screen.getByText("$0.00")).toBeVisible();
  expect(screen.getByText("No simulated payments recorded. This is not the actual cost of your journey.")).toBeVisible();
  expect(fetcher.mock.calls[0][0]).toBe("/api/map/ride-payments");
  expect(document.querySelectorAll(".trip-receipt-leg")).toHaveLength(0);
});

test.each([
  { totalRecordedCents: 999 },
  { captured: true },
  { amountSource: "traveler_entered_demo" },
  { legs: [{ ...receipt.legs[0], status: "no_payment_recorded", amountCents: null, receiptId: undefined }, receipt.legs[1]], totalRecordedCents: 0 },
])("rejects an inconsistent consolidated receipt %j", async (change) => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return response({ receipt: { ...receipt, ...change }, replayed: false });
    return response({ receipts: url.endsWith("/trip") ? [] : [ride] });
  });
  const { onContinue } = openSummary(fetcher);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("response could not be verified"));
  expect(screen.queryByRole("button", { name: "Download trip receipt (.txt)" })).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Consolidated demo receipt" })).not.toBeInTheDocument();
  expect(onContinue).not.toHaveBeenCalled();
});

test("does not generate a summary if a known paid leg cannot be recovered", async () => {
  const fetcher = vi.fn(() => response({ receipts: [] }));
  openSummary(fetcher);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("previously recorded demo receipt could not be recovered"));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("region", { name: "Consolidated demo receipt" })).not.toBeInTheDocument();
});

test("recovers a consolidated receipt after a lost POST response without another POST", async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.reject(new Error("Response lost."));
    return response({ receipts: url.endsWith("/trip") ? [receipt] : [ride] });
  });
  openSummary(fetcher);
  await screen.findByRole("region", { name: "Consolidated demo receipt" });
  expect(screen.getByRole("status")).toHaveTextContent("saved trip summary");
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  expect(fetcher.mock.calls[2][0]).toBe("/api/map/ride-payments/trip");
});

test("locks a journey after summary session loss and retains that lock when reopened", async () => {
  const fetcher = vi.fn((_url: string, init?: RequestInit) => init?.method === "POST" ? expired() : response({ receipts: [ride] }));
  const { controller, onContinue, onDismiss } = openSummary(fetcher);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("original receipt session is unavailable"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Try generating the summary again" })).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Return to route" }));
  expect(onDismiss).toHaveBeenCalledWith({ attempted: true, sessionLost: true });
  controller.open({ ...context, onContinue, onDismiss });
  expect(screen.getByRole("status")).toHaveTextContent("original receipt session is unavailable");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(onContinue).not.toHaveBeenCalled();
});

test("refuses to create a final receipt when a prior vehicle lost its receipt session", async () => {
  const fetcher = vi.fn(() => response({ receipts: [] }));
  const { controller, onContinue, onDismiss } = openSummary(fetcher, { sessionLost: true, legs: [train], hasPaymentAttempt: true });
  expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed");
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Return to route" }));
  controller.open({ ...context, legs: [train], sessionLost: false, hasPaymentAttempt: false, onContinue, onDismiss });
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Consolidated demo receipt" })).not.toBeInTheDocument();
});

test("returns to the route on an error without marking the trip finished and safely renders source text", async () => {
  const fetcher = vi.fn(() => Promise.reject(new Error("Summary service is unavailable.")));
  const from = '<img src=x onerror="alert(1)">';
  const { controller, onContinue, onDismiss } = openSummary(fetcher, { from });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Summary service is unavailable"));
  expect(screen.getByText(`${from} to ${context.to}`)).toBeVisible();
  expect(document.querySelector("#trip-receipt-journey img")).toBeNull();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(controller.isOpen()).toBe(false);
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(onContinue).not.toHaveBeenCalled();
});

test("allows corrected journey details after an initial lookup failed before any summary POST", async () => {
  let failed = false;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (!failed) { failed = true; return Promise.reject(new Error("Initial lookup unavailable.")); }
    return init?.method === "POST" ? response({ receipt: { ...receipt, to: "Campus entrance" }, replayed: false }) : response({ receipts: [ride] });
  });
  const { controller, onContinue, onDismiss } = openSummary(fetcher);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Initial lookup unavailable"));
  await userEvent.setup().click(screen.getByRole("button", { name: "Return to route" }));
  controller.open({ ...context, to: "Campus entrance", onContinue, onDismiss });
  await screen.findByRole("region", { name: "Consolidated demo receipt" });
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
});

test.each([
  { status: 400, code: "ride_demo_invalid_input" },
  { status: 409, code: "ride_demo_trip_unverifiable" },
])("allows a corrected context after a definitive non-writing rejection %j", async ({ status, code }) => {
  let posts = 0;
  const fetcher = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return posts === 1
        ? Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error: "Journey details need correction.", code }) } as Response)
        : response({ receipt, replayed: false });
    }
    return response({ receipts: [ride] });
  });
  const { controller, onContinue, onDismiss } = openSummary(fetcher, { legs: [], hasPaymentAttempt: false });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Journey details need correction"));
  await userEvent.setup().click(screen.getByRole("button", { name: "Return to route" }));
  controller.open({ ...context, onContinue, onDismiss });
  await screen.findByRole("region", { name: "Consolidated demo receipt" });
  expect(posts).toBe(2);
  expect(fetcher.mock.calls[2][0]).toBe("/api/map/ride-payments?recover=1");
  expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body)).legs).toEqual(context.legs);
});

test("keeps the summary context frozen after an uncertain POST result", async () => {
  const fetcher = vi.fn((url: string, init?: RequestInit) => init?.method === "POST"
    ? Promise.reject(new Error("Summary response lost."))
    : response({ receipts: url.endsWith("/trip") ? [] : [ride] }));
  const { controller, onContinue, onDismiss } = openSummary(fetcher);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Summary response lost"));
  await userEvent.setup().click(screen.getByRole("button", { name: "Return to route" }));
  const previousCalls = fetcher.mock.calls.length;
  controller.open({ ...context, to: "Another destination", onContinue, onDismiss });
  expect(screen.getByRole("status")).toHaveTextContent("summary attempt with different details");
  expect(fetcher).toHaveBeenCalledTimes(previousCalls);
  expect(screen.queryByRole("region", { name: "Consolidated demo receipt" })).not.toBeInTheDocument();
});
