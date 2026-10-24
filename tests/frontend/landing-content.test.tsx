import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { Footer } from "../../frontend/components/landing/Closing";
import { HowItWorks } from "../../frontend/components/landing/HowItWorks";
import { Why } from "../../frontend/components/landing/Why";

describe("landing story", () => {
  test("shows the supplied travel research inside both picture frames", () => {
    render(<Why />);
    expect(screen.getByAltText("Screenshot: Claude / Google Flights search")).toHaveAttribute("src", "/why-flights.png");
    expect(screen.getByAltText("Screenshot: Gemini in Chrome giving a guide")).toHaveAttribute("src", "/why-gemini.png");
  });

  test("uses the clearer workflow headline", () => {
    render(<HowItWorks />);
    expect(screen.getByRole("heading", { name: "Every moving part.One clear plan." })).toBeVisible();
  });

  test("keeps the landing footer focused on travelers", () => {
    render(<Footer />);
    expect(screen.queryByRole("link", { name: /organizer desk/i })).not.toBeInTheDocument();
  });
});
