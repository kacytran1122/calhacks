import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { RideCheckoutDialog } from "../../frontend/app/map/MapClient";
import { mountRideCheckout } from "../../frontend/public/map-assets/ride-checkout.js";

const leg = { legId: "journey1:bus1", mode: "bus", service: "Metro 720", from: "Westwood Boulevard", to: "Wilshire / Vermont", preview: true };
const receipt = { id: "demo_receipt_1", ...leg, amountCents: 250, currency: "USD", paidAt: "2026-10-25T12:00:00.000Z", provenance: "simulated", captured: false, provider: "visa_simulation", amountSource: "traveler_entered_demo" };
const response = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
const sessionExpired = () => Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "Demo receipt session expired.", code: "ride_demo_session_expired" }) } as Response);

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } });
});

async function openCheckout(fetcher = vi.fn(() => response({ receipts: [] })), overrides = {}) {
  vi.stubGlobal("fetch", fetcher);
  render(<RideCheckoutDialog />);
  const controller = mountRideCheckout();
  const onContinue = vi.fn();
  const onDismiss = vi.fn();
  controller.open({ ...leg, onContinue, onDismiss, ...overrides });
  await waitFor(() => expect(screen.getByLabelText("Yes, I have left this bus.")).not.toBeDisabled());
  return { controller, onContinue, onDismiss, fetcher };
}

async function completeDemoForm(user: ReturnType<typeof userEvent.setup>, value = "2.50") {
  await user.click(screen.getByLabelText("Yes, I have left this bus."));
  await user.type(screen.getByRole("textbox", { name: "Demo amount (USD)" }), value);
  await user.click(screen.getByLabelText("I understand this creates a demo record and moves no funds."));
}

test("requires explicit exit, consent, and a positive USD demo amount before any POST", async () => {
  const { fetcher, onContinue } = await openCheckout();
  const user = userEvent.setup();
  const pay = screen.getByRole("button", { name: "Pay with Visa (simulation)" });
  expect(pay).toBeDisabled();
  expect(screen.getByText(/GPS proximity is not proof/)).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("/api/map/ride-payments");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  await user.type(screen.getByRole("textbox", { name: "Demo amount (USD)" }), "2.50");
  await user.click(screen.getByLabelText("I understand this creates a demo record and moves no funds."));
  expect(pay).toBeDisabled();
  await user.click(screen.getByLabelText("Yes, I have left this bus."));
  expect(pay).toBeEnabled();
  const amount = screen.getByRole("textbox", { name: "Demo amount (USD)" });
  await user.clear(amount);
  await user.type(amount, "1000.01");
  expect(pay).toBeDisabled();
  expect(amount).toHaveAttribute("aria-invalid", "true");
  await user.clear(amount);
  await user.type(amount, "0");
  expect(pay).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(onContinue).not.toHaveBeenCalled();
});

test("creates one receipt, locks its amount, and waits for acknowledgement to continue", async () => {
  let resolvePayment: ((value: Response) => void) | undefined;
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => init?.method === "POST"
    ? new Promise<Response>((resolve) => { resolvePayment = resolve; })
    : response({ receipts: [] }));
  const { controller, onContinue } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  expect(screen.getByRole("button", { name: "Creating demo receipt…" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Demo amount (USD)" })).toBeDisabled();
  fireEvent.submit(document.querySelector("#ride-checkout-form")!);
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  const posted = JSON.parse(String(fetcher.mock.calls[1][1]?.body));
  expect(posted).toEqual({ legId: leg.legId, mode: "bus", service: leg.service, from: leg.from, to: leg.to, amountCents: 250, completed: true, consent: true });
  resolvePayment!({ ok: true, json: () => Promise.resolve({ receipt, replayed: false }) } as Response);
  await waitFor(() => expect(screen.getByText("Your demo receipt")).toBeVisible());
  expect(screen.getByText("$2.50")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Pay with Visa (simulation)" })).not.toBeInTheDocument();
  expect(onContinue).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(controller.isOpen()).toBe(true);
  expect(screen.getByText(/Your demo receipt is still here/)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Continue trip" }));
  expect(controller.isOpen()).toBe(false);
  expect(onContinue).toHaveBeenCalledOnce();
});

test("recovers a saved receipt without offering another payment and downloads a real text file", async () => {
  const fetcher = vi.fn(() => response({ receipts: [receipt] }));
  vi.stubGlobal("fetch", fetcher);
  const createUrl = vi.fn(() => "blob:demo-receipt");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  let filename = "";
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () { filename = this.download; });
  render(<RideCheckoutDialog />);
  const controller = mountRideCheckout();
  const onContinue = vi.fn();
  controller.open({ ...leg, onContinue });
  await waitFor(() => expect(screen.getByText("Your demo receipt")).toBeVisible());
  expect(screen.getByText(/original amount is unchanged/)).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Download demo receipt (.txt)" }));
  expect(filename).toBe("smile-demo-receipt-demo_receipt_1.txt");
  const blob = createUrl.mock.calls[0][0] as Blob;
  expect(blob.type).toBe("text/plain;charset=utf-8");
  const text = await new Promise<string>((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob); });
  expect(text).toContain("SIMULATION ONLY — NO FUNDS MOVED");
  expect(text).toContain("not valid for reimbursement");
  expect(text).toContain("No real Visa API was used");
  expect(text).toContain("Planned boarding point: Westwood Boulevard");
  expect(text).toContain("GPS and operator proof were not collected");
  expect(onContinue).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each([
  { captured: true, provenance: "live" },
  { amountCents: 333 },
  { service: "A different operator" },
  { currency: "EUR" },
])("rejects changed payment response fields %j instead of marking the ride paid", async (change) => {
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => response(init?.method === "POST"
    ? { receipt: { ...receipt, ...change }, replayed: false }
    : { receipts: [] }));
  const { onContinue } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("response could not be verified"));
  expect(screen.getByText("Your demo receipt")).not.toBeVisible();
  expect(screen.getByRole("textbox", { name: "Demo amount (USD)" })).toHaveAttribute("readonly");
  expect(onContinue).not.toHaveBeenCalled();
});

test("recovers a saved receipt after a lost POST response without sending a duplicate payment", async () => {
  let posted = false;
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted = true;
      return Promise.reject(new Error("Connection ended before the response arrived."));
    }
    return response({ receipts: posted ? [receipt] : [] });
  });
  const { onContinue } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByText("Your demo receipt")).toBeVisible());
  expect(screen.getByText(/original amount is unchanged/)).toBeVisible();
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  expect(fetcher.mock.calls.filter((call) => !call[1]?.method)).toHaveLength(2);
  expect(fetcher.mock.calls[2][0]).toBe("/api/map/ride-payments?recover=1");
  expect(onContinue).not.toHaveBeenCalled();
});

test("locks a ride after POST session loss without creating a new owner, including after reopening", async () => {
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => init?.method === "POST" ? sessionExpired() : response({ receipts: [] }));
  const { controller, onContinue, onDismiss } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed"));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Pay with Visa (simulation)" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Check saved receipts again" })).not.toBeInTheDocument();
  fireEvent.submit(document.querySelector("#ride-checkout-form")!);
  expect(fetcher).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Still on board, return to route" }));
  controller.open({ ...leg, onContinue, onDismiss });
  expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed");
  expect(screen.getByRole("textbox", { name: "Demo amount (USD)" })).toHaveValue("2.50");
  expect(screen.getByRole("button", { name: "Pay with Visa (simulation)" })).toBeDisabled();
  expect(fetcher).toHaveBeenCalledTimes(2);
  await user.click(screen.getByLabelText("Yes, I have left this bus."));
  await user.click(screen.getByRole("button", { name: "Continue without another payment attempt" }));
  expect(onContinue).toHaveBeenCalledOnce();
  controller.open({ ...leg, legId: "journey1:bus2", onContinue, onDismiss });
  await waitFor(() => expect(screen.getByLabelText("Yes, I have left this bus.")).not.toBeDisabled());
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toBe("/api/map/ride-payments");
});

test("locks a ride when recovery after a lost POST response finds no receipt session", async () => {
  let posted = false;
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posted = true; return Promise.reject(new Error("Response lost.")); }
    return posted ? sessionExpired() : response({ receipts: [] });
  });
  const { onContinue } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed"));
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(fetcher.mock.calls[2][0]).toBe("/api/map/ride-payments?recover=1");
  expect(screen.getByRole("button", { name: "Pay with Visa (simulation)" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Check saved receipts again" })).not.toBeInTheDocument();
  expect(screen.getByText("Your demo receipt")).not.toBeVisible();
  expect(onContinue).not.toHaveBeenCalled();
});

test("reopens an unresolved attempt only through recovery without changing its demo amount", async () => {
  let posted = false;
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posted = true; return Promise.reject(new Error("Response lost.")); }
    return posted ? Promise.reject(new Error("Receipt check is unavailable.")) : response({ receipts: [] });
  });
  const { controller, onContinue, onDismiss } = await openCheckout(fetcher);
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Receipt check is unavailable"));
  await user.click(screen.getByRole("button", { name: "Still on board, return to route" }));
  controller.open({ ...leg, onContinue, onDismiss });
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Receipt check is unavailable"));
  expect(fetcher.mock.calls[3][0]).toBe("/api/map/ride-payments?recover=1");
  expect(screen.getByRole("textbox", { name: "Demo amount (USD)" })).toHaveValue("2.50");
  expect(screen.getByRole("textbox", { name: "Demo amount (USD)" })).toHaveAttribute("readonly");
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
});

test("allows a manual fresh session check after an initial unauthorized GET without a payment attempt", async () => {
  let reads = 0;
  const fetcher = vi.fn(() => ++reads === 1 ? sessionExpired() : response({ receipts: [] }));
  await openCheckout(fetcher);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Check saved receipts again" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("choose a demo amount"));
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(["/api/map/ride-payments", "/api/map/ride-payments"]);
  await completeDemoForm(user);
  expect(screen.getByRole("button", { name: "Pay with Visa (simulation)" })).toBeEnabled();
});

test("returns to the route without advancing when still on board, including Escape", async () => {
  const { controller, onContinue, onDismiss, fetcher } = await openCheckout();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Still on board, return to route" }));
  expect(controller.isOpen()).toBe(false);
  expect(onDismiss).toHaveBeenCalledOnce();
  expect(onContinue).not.toHaveBeenCalled();
  controller.open({ ...leg, onContinue, onDismiss });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(controller.isOpen()).toBe(false);
  expect(onDismiss).toHaveBeenCalledTimes(2);
  expect(onContinue).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
});

test("allows an explicit unpaid skip only after confirming exit and safely renders place text", async () => {
  const service = '<img src=x onerror="alert(1)">';
  const { controller, onContinue, fetcher } = await openCheckout(undefined, { service });
  const user = userEvent.setup();
  expect(screen.getByText(service)).toBeVisible();
  expect(document.querySelector("#ride-checkout-service img")).toBeNull();
  const skip = screen.getByRole("button", { name: "Skip without payment and continue" });
  expect(skip).toBeDisabled();
  await user.click(screen.getByLabelText("Yes, I have left this bus."));
  expect(skip).toBeEnabled();
  screen.getByLabelText("Yes, I have left this bus.").focus();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
  expect(screen.getByRole("button", { name: "Still on board, return to route" })).toHaveFocus();
  await user.click(skip);
  expect(controller.isOpen()).toBe(false);
  expect(onContinue).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
});

test("keeps journey association on a per-ride receipt and reports its saved reference to navigation", async () => {
  const journeyId = "shared_journey";
  const saved = { ...receipt, journeyId };
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => init?.method === "POST" ? response({ receipt: saved, replayed: false }) : response({ receipts: [] }));
  const { onContinue } = await openCheckout(fetcher, { journeyId });
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByText("Your demo receipt")).toBeVisible());
  expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).journeyId).toBe(journeyId);
  await user.click(screen.getByRole("button", { name: "Continue trip" }));
  expect(onContinue).toHaveBeenCalledWith({ receipt: expect.objectContaining({ id: receipt.id, journeyId }), attempted: true, sessionLost: false });
});

test("never starts a new receipt owner for a second vehicle after the journey session was lost", async () => {
  let posted = false;
  const fetcher = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.method === "POST") { posted = true; return Promise.reject(new Error("Bus receipt response lost.")); }
    return posted ? sessionExpired() : response({ receipts: [] });
  });
  const journeyId = "journey_lost_session";
  const { controller, onContinue, onDismiss } = await openCheckout(fetcher, { journeyId });
  const user = userEvent.setup();
  await completeDemoForm(user);
  await user.click(screen.getByRole("button", { name: "Pay with Visa (simulation)" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed"));
  await user.click(screen.getByRole("button", { name: "Continue without another payment attempt" }));
  expect(onContinue).toHaveBeenCalledWith({ receipt: null, skipped: true, attempted: true, sessionLost: true });
  const before = fetcher.mock.calls.length;
  controller.open({ ...leg, journeyId, legId: "journey_lost_session:train2", mode: "train", service: "Metro B Line", hasPaymentAttempt: true, sessionLost: true, onContinue, onDismiss });
  expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed");
  expect(fetcher).toHaveBeenCalledTimes(before);
  expect(screen.getByRole("button", { name: "Pay with Visa (simulation)" })).toBeDisabled();
});

test("uses recovery for a new vehicle when this journey already had a payment attempt", async () => {
  const fetcher = vi.fn(() => sessionExpired());
  await openCheckout(fetcher, { journeyId: "journey_prior_attempt", hasPaymentAttempt: true });
  expect(fetcher.mock.calls[0][0]).toBe("/api/map/ride-payments?recover=1");
  expect(screen.getByRole("status")).toHaveTextContent("amounts cannot be confirmed");
  expect(screen.queryByRole("button", { name: "Check saved receipts again" })).not.toBeInTheDocument();
});
