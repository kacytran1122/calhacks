import { Cta, Footer } from "@/components/landing/Closing";
import { Faq } from "@/components/landing/Faq";
import { Header } from "@/components/landing/Header";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LensDemo } from "@/components/landing/LensDemo";
import { RevealObserver } from "@/components/landing/Reveal";
import { Why } from "@/components/landing/Why";
import { TravelHome, type TravelView } from "@/components/travel/TravelHome";

export function TravelExperience({ initialView }: { initialView: TravelView }) {
  return (
    <TravelHome initialView={initialView}>
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
