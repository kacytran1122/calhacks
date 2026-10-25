import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { ChatClient } from "../../frontend/app/chat/ChatClient";

beforeEach(() => {
  window.history.replaceState(null, "", "/chat");
  vi.unstubAllGlobals();
});

test("does not create a Photon handoff without a trip-scoped link", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  render(<ChatClient />);
  expect(await screen.findByRole("heading", { name: "Plan a trip first" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Find an event and plan my trip" })).toHaveAttribute("href", "/finding-events");
  expect(fetcher).not.toHaveBeenCalled();
});

test("creates a prefilled Photon-line Messages QR without collecting a phone number or email", async () => {
  window.history.replaceState(null, "", "/chat#trip=TR-L-test&token=private-trip-token");
  const starterMessage = "@smile open my route SMILE-2345-6789-ABCD-EFGH";
  const messageUrl = `sms:+14155550199?&body=${encodeURIComponent(starterMessage)}`;
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ messageUrl, starterMessage, expiresAt: "2026-10-25T12:15:00.000Z" }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<ChatClient />);
  expect(window.location.pathname).toBe("/chat");
  expect(window.location.hash).toBe("");
  expect(await screen.findByRole("heading", { name: "Create your Messages QR" })).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Create Messages QR" }));

  expect(await screen.findByRole("heading", { name: "Scan, then send the message." })).toBeVisible();
  const qr = screen.getByLabelText("QR code that opens a private @smile conversation in Messages").querySelector("svg");
  expect(qr).not.toBeNull();
  expect(qr?.querySelector("title")).toHaveTextContent("Open @smile in Messages with the route request filled in");
  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", messageUrl);
  expect(screen.getByText(starterMessage)).toBeVisible();
  expect(screen.getByText(/cannot be opened automatically after an iMessage/i)).toBeVisible();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body))).toEqual({ tripId: "TR-L-test", tripToken: "private-trip-token" });
});

test("keeps a contact-free retry available when QR creation fails", async () => {
  window.history.replaceState(null, "", "/chat#trip=TR-L-test&token=private-trip-token");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "A Photon iMessage line has not been configured yet." }) })));
  const user = userEvent.setup();
  render(<ChatClient />);
  await user.click(await screen.findByRole("button", { name: "Create Messages QR" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A Photon iMessage line has not been configured yet.");
  expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
});
