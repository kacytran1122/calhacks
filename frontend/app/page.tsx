import { Cta, Footer } from "@/components/landing/Closing";
import { Faq } from "@/components/landing/Faq";
import { Header } from "@/components/landing/Header";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LensDemo } from "@/components/landing/LensDemo";
import { RevealObserver } from "@/components/landing/Reveal";
import { Why } from "@/components/landing/Why";

export default function Landing() {
  return (
    <>
      <Header />
      <Hero />
      <Why />
      <HowItWorks />
      <LensDemo />
      <Faq />
      <Cta />
      <Footer />
      <RevealObserver />
    </>
  );
}
