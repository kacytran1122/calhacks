import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "James West Alumni Center · 3D Tour",
  description:
    "A labeled, person-free 3D walkthrough of the James West Alumni Center event layout.",
};

export default function TourPage() {
  return (
    <main
      style={{
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        background: "#0d2440",
      }}
    >
      <iframe
        src="/3d-tour/index.html"
        title="James West Alumni Center interactive 3D tour"
        allow="fullscreen"
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
      />
    </main>
  );
}
