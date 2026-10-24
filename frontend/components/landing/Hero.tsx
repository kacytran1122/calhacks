"use client";

import { useRouter } from "next/navigation";
import { HeroView } from "./HeroView";

export function Hero() {
  const router = useRouter();
  return <HeroView onNavigate={(href) => router.push(href)} />;
}
