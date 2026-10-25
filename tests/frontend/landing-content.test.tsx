import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { Footer } from "../../frontend/components/landing/Closing";
import { Faq } from "../../frontend/components/landing/Faq";
import { HowItWorks } from "../../frontend/components/landing/HowItWorks";
import { LensDemo } from "../../frontend/components/landing/LensDemo";
import { Why } from "../../frontend/components/landing/Why";

describe("landing story", () => {
  test("shows the supplied travel research inside both picture frames", () => {
    render(<Why />);
    expect(screen.getByAltText("Screenshot: Claude / Google Flights search")).toHaveAttribute("src", "/why-flights.png");
    expect(screen.getByAltText("Screenshot: Gemini in Chrome giving a guide")).toHaveAttribute("src", "/why-gemini.png");
  });

  test("uses the clearer workflow headline", () => {
    render(<HowItWorks />);
    expect(screen.getByRole("heading", { name: "You choose the event.We’ll help you get there." })).toBeVisible();
  });

  test("keeps the landing footer focused on travelers", () => {
    render(<Footer />);
    expect(screen.queryByRole("link", { name: /organizer desk/i })).not.toBeInTheDocument();
  });

  test("carries the selected event into the illustrated extension planner", async () => {
    const user = userEvent.setup();
    const { container } = render(<LensDemo />);
    expect(screen.getByRole("tab", { name: "MLH event list" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Preview trip planner for HackTX 26" }));
    expect(screen.getByRole("tab", { name: "Trip planner" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByLabelText("Illustrated trip planner")).toHaveTextContent("HackTX 26");
    expect(screen.getByLabelText("Illustrated trip planner")).toHaveTextContent("Austin, TX");
    await user.click(screen.getByRole("button", { name: /no self-drive/i }));
    expect(screen.getByRole("button", { name: /no self-drive/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /yes, include driving/i })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: "Plan your trip" })).toHaveAttribute("href", "/find");
    expect(container.querySelector("img")).toBeNull();
  });

  test("connects each FAQ question to its answer and opens one at a time", async () => {
    const user = userEvent.setup();
    render(<Faq />);
    const first = screen.getByRole("button", { name: "How do I find an event and plan my trip?" });
    const prices = screen.getByRole("button", { name: "Are the prices live or predicted?" });
    expect(first).toHaveAttribute("aria-expanded", "true");
    await user.click(prices);
    expect(first).toHaveAttribute("aria-expanded", "false");
    expect(prices).toHaveAttribute("aria-expanded", "true");
    const answer = document.getElementById(prices.getAttribute("aria-controls")!);
    expect(answer).toHaveAttribute("aria-labelledby", prices.id);
    expect(answer).toHaveTextContent("historical data");
    expect(answer).toHaveTextContent("different U.S. states");
  });
});
