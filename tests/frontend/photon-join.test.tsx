import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatClient } from "../../frontend/app/chat/ChatClient";

beforeEach(() => window.history.replaceState(null, "", "/chat"));

test("does not provision a Photon seat without a trip-scoped link", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<ChatClient />);
  expect(await screen.findByRole("heading", { name: "Plan a trip first" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Find an event and plan my trip" })).toHaveAttribute("href", "/find");
  expect(fetcher).not.toHaveBeenCalled();
});

test("creates a visitor-specific Messages QR instead of a simulated group chat", async () => {
  window.history.replaceState(null, "", "/chat#trip=TR-L-test&token=private-trip-token");
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      assignedPhoneNumber: "+14155550199",
      messageUrl: "sms:+14155550199",
      starterMessage: "@smile I’m planning a trip. My home ZIP is _____ and the event link is _____.",
      reused: false,
    }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ChatClient />);
  await user.type(await screen.findByLabelText("iMessage phone or Apple Account email"), "(415) 555-0123");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Create my private Messages link" }));

  expect(await screen.findByRole("heading", { name: "Scan, then send first." })).toBeVisible();
  const qr = screen.getByLabelText("QR code that opens your assigned S’mile conversation in Messages").querySelector("svg");
  expect(qr).not.toBeNull();
  expect(qr?.querySelector("title")).toHaveTextContent("Open your private S’mile conversation in Messages");
  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", "sms:+14155550199");
  expect(screen.getByText(/^@smile I’m planning/)).toBeVisible();
  expect(screen.queryByText(/Group chat · web preview/i)).not.toBeInTheDocument();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body))).toEqual({
    handle: "(415) 555-0123",
    consent: true,
    tripId: "TR-L-test",
    tripToken: "private-trip-token",
  });
});

test("keeps the form available when Photon cannot assign a line", async () => {
  window.history.replaceState(null, "", "/chat#trip=TR-L-test&token=private-trip-token");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "All shared iMessage seats are in use." }) })));
  const user = userEvent.setup();
  render(<ChatClient />);
  await user.type(await screen.findByLabelText("iMessage phone or Apple Account email"), "person@icloud.com");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Create my private Messages link" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("All shared iMessage seats are in use.");
  expect(screen.getByLabelText("iMessage phone or Apple Account email")).toHaveValue("person@icloud.com");
});
