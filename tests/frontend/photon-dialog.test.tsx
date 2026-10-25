import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { PhotonJoinDialog } from "../../frontend/app/find/PhotonJoinDialog";

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

test("opens an accessible in-page QR dialog without exposing the trip token or asking for contact details", async () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  const trigger = screen.getByRole("button", { name: /Message @smile privately in iMessage/ });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Creating your secure QR…" });
  expect(dialog).toBeVisible();
  expect(dialog).toHaveAttribute("aria-modal", "true");
  await waitFor(() => expect(screen.getByRole("heading", { name: "Creating your secure QR…" })).toHaveFocus());
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(window.location.href).toBe("http://localhost:3000/");
  expect(document.body.innerHTML).not.toContain("private-trip-token");

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("creates the prefilled dedicated-line QR immediately and sends no contact data", async () => {
  const starterMessage = "@smile open my route SMILE-2345-6789-ABCD-EFGH";
  const messageUrl = `sms:+14155550199?&body=${encodeURIComponent(starterMessage)}`;
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({ messageUrl, starterMessage, expiresAt: "2026-10-25T12:15:00.000Z" }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  await user.click(screen.getByRole("button", { name: /Message @smile privately in iMessage/ }));

  expect(await screen.findByRole("heading", { name: "Scan, then send the message" })).toHaveFocus();
  const qr = screen.getByLabelText("QR code that opens the dedicated @smile conversation in Messages").querySelector("svg");
  expect(qr).not.toBeNull();
  expect(qr?.querySelector("title")).toHaveTextContent("Open @smile in Messages with the route request filled in");
  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", messageUrl);
  expect(screen.getByText(starterMessage)).toBeVisible();
  expect(screen.getByText(/iMessage cannot open a website tab automatically/i)).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body))).toEqual({ tripId: "TR-L-test", tripToken: "private-trip-token" });

  await user.click(screen.getByRole("button", { name: "Copy message" }));
  expect(screen.getByRole("button", { name: "Message copied" })).toBeVisible();
});

test("keeps the popup open with a retry when the dedicated line is unavailable", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "A dedicated Photon iMessage line has not been configured yet." }) })
    .mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Still unavailable." }) });
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  await user.click(screen.getByRole("button", { name: /Message @smile privately in iMessage/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("A dedicated Photon iMessage line has not been configured yet.");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Still unavailable.");
  expect(fetcher).toHaveBeenCalledTimes(2);
});
