import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Nunito } from "next/font/google";
import "./landing.css";

const heading = Bricolage_Grotesque({ subsets: ["latin", "latin-ext", "vietnamese"], weight: ["400", "600", "700", "800"], variable: "--nf-heading" });
const body = Nunito({ subsets: ["latin", "latin-ext", "vietnamese"], weight: ["400", "500", "600", "700", "800"], variable: "--nf-body" });

const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%232B1B3D'/%3E%3Ccircle cx='32' cy='29' r='19' fill='%23FFD84D'/%3E%3Cellipse cx='25' cy='25' rx='3' ry='3.8' fill='%232B1B3D'/%3E%3Cellipse cx='39' cy='25' rx='3' ry='3.8' fill='%232B1B3D'/%3E%3Cpath d='M22 33 Q32 42 42 33' fill='none' stroke='%232B1B3D' stroke-width='4' stroke-linecap='round'/%3E%3Cpath d='M43 46 Q42 54 34 58' fill='none' stroke='%23FF6B5B' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E";

export const metadata: Metadata = {
  title: "S’mile · Every mile ends in a smile.",
  description: "AI travel companion for events — and the autonomous travel desk that keeps its books.",
  icons: { icon: ICON, apple: ICON },
};

export const viewport: Viewport = { themeColor: "#2B1B3D", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${heading.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
