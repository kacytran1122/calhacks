import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "LA Hacks · 3D concept tour",
  description: "Explore a James West Alumni Center concept for LA Hacks. This approximate visualization is not a verified current venue layout.",
};

export default function TourPage() {
  return (
    <main style={{ width: "100%", height: "100dvh", overflow: "hidden", background: "#0d2440" }}>
      <iframe
        src="/3d-tour/index.html"
        title="LA Hacks James West Alumni Center interactive 3D concept tour"
        allow="fullscreen"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: 0, display: "block" }}
      />
    </main>
  );
}
