import { Navigation } from "@/components/landing/navigation";
import { HeroSection } from "@/components/landing/hero-section";
import { FooterSection } from "@/components/landing/footer-section";
import DitherBackground from "@/components/DitherBackground";

export default function Home() {
  return (
    <main className="relative min-h-screen overflow-x-hidden noise-overlay">
      <DitherBackground />

      <div className="relative z-10">
        <Navigation />
        <HeroSection />
        <FooterSection />
      </div>
    </main>
  );
}
