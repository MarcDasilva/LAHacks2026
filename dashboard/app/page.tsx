import type { CSSProperties } from "react";
import { Navigation } from "@/components/landing/navigation";
import { HeroSection } from "@/components/landing/hero-section";
import { FooterSection } from "@/components/landing/footer-section";
import DitherBackground from "@/components/DitherBackground";

export default function Home() {
  return (
    <main
      className="relative min-h-screen overflow-x-hidden noise-overlay"
      style={
        {
          "--foreground": "oklch(0.12 0.01 60)",
          "--muted-foreground": "oklch(0.35 0.01 60)",
        } as CSSProperties
      }
    >
      <DitherBackground />

      <div className="relative z-10">
        <Navigation />
        <HeroSection />
        <FooterSection />
      </div>
    </main>
  );
}
