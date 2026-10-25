import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test, vi } from "vitest";
import { PhotonJoinDialog } from "../../frontend/app/find/PhotonJoinDialog";

beforeEach(() => window.history.replaceState(null, "", "/"));

test("opens an accessible in-page setup dialog without putting the trip token in the URL or DOM", async () => {
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  const trigger = screen.getByRole("button", { name: /Message @smile privately in iMessage/ });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(trigger);

  const dialog = screen.getByRole("dialog", { name: "Open your S’mile chat" });
  expect(dialog).toBeVisible();
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(screen.getByLabelText("iMessage phone or Apple Account email")).toHaveFocus();
  expect(window.location.href).toBe("http://localhost:3000/");
  expect(document.body.innerHTML).not.toContain("private-trip-token");

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await waitFor(() => expect(trigger).toHaveFocus());
});

test("provisions the real Photon assignment in the dialog and renders its Messages QR", async () => {
  const fetcher = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      assignedPhoneNumber: "+14155550199",
      messageUrl: "sms:+14155550199",
      starterMessage: "@smile I’m planning a trip to Cal Hacks 13.0.",
      reused: false,
    }),
  }));
  vi.stubGlobal("fetch", fetcher);
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  await user.click(screen.getByRole("button", { name: /Message @smile privately in iMessage/ }));
  await user.type(screen.getByLabelText("iMessage phone or Apple Account email"), "(415) 555-0123");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Create QR code" }));

  expect(await screen.findByRole("heading", { name: "Scan, then send first" })).toHaveFocus();
  const qr = screen.getByLabelText("QR code that opens your assigned S’mile conversation in Messages").querySelector("svg");
  expect(qr).not.toBeNull();
  expect(qr?.querySelector("title")).toHaveTextContent("Open your private S’mile conversation in Messages");
  expect(screen.getByRole("link", { name: "Open Messages" })).toHaveAttribute("href", "sms:+14155550199");
  expect(screen.getByText("@smile I’m planning a trip to Cal Hacks 13.0.")).toBeVisible();
  expect(window.location.href).toBe("http://localhost:3000/");

  expect(fetcher).toHaveBeenCalledTimes(1);
  const [, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(request.body))).toEqual({
    handle: "(415) 555-0123",
    consent: true,
    tripId: "TR-L-test",
    tripToken: "private-trip-token",
  });

  await user.click(screen.getByRole("button", { name: "Copy starter message" }));
  expect(screen.getByRole("button", { name: "Message copied" })).toBeVisible();
});

test("keeps setup in the popup when Photon cannot assign a line", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "All shared iMessage seats are in use." }) })));
  const user = userEvent.setup();
  render(<PhotonJoinDialog tripId="TR-L-test" tripToken="private-trip-token" eventName="Cal Hacks 13.0" />);

  await user.click(screen.getByRole("button", { name: /Message @smile privately in iMessage/ }));
  await user.type(screen.getByLabelText("iMessage phone or Apple Account email"), "person@icloud.com");
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Create QR code" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("All shared iMessage seats are in use.");
  expect(screen.getByLabelText("iMessage phone or Apple Account email")).toHaveValue("person@icloud.com");
  expect(screen.getByRole("dialog")).toBeVisible();
});
