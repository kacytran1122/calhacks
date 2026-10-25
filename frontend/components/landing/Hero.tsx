"use client";

import { useTravelNavigation } from "@/components/travel/TravelHome";
import { HeroView } from "./HeroView";

export function Hero() {
  const navigate = useTravelNavigation();
  return <HeroView onNavigate={navigate} />;
}
