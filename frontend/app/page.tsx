import { Cta, Footer } from "@/components/landing/Closing";
import { Faq } from "@/components/landing/Faq";
import { Header } from "@/components/landing/Header";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LensDemo } from "@/components/landing/LensDemo";
import { RevealObserver } from "@/components/landing/Reveal";
import { Why } from "@/components/landing/Why";
import { TravelHome } from "@/components/travel/TravelHome";
import type { Metadata } from "next";
import "./desk/desk.css";
import "./find/find.css";

export const metadata: Metadata = { alternates: { canonical: "/" } };

export default function Landing() {
  return (
    <TravelHome>
      <Header />
      <Hero />
      <Why />
      <HowItWorks />
      <LensDemo />
      <Faq />
      <Cta />
      <Footer />
      <RevealObserver />
    </TravelHome>
  );
}
