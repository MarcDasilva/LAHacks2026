import Link from "next/link";

export default function Home() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-center overflow-hidden">

      {/* Background blobs */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--lavender)]/[0.07] blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] translate-x-1/2 translate-y-1/2 rounded-full bg-[oklch(0.65_0.20_350)]/[0.05] blur-[100px]" />
      </div>
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      {/* Hero content */}
      <div className="relative z-10 flex flex-col items-center text-center px-6 max-w-3xl">

        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--muted-foreground)] mb-6">
          First Responder Intelligence
        </p>

        <h1 className="text-[clamp(3rem,8vw,6rem)] font-bold leading-[1.02] tracking-[-0.03em] text-[var(--foreground)]">
          See everything.<br />Miss nothing.
        </h1>

        <p className="mt-6 text-base text-[var(--muted-foreground)] leading-[1.7] max-w-lg">
          Vigil gives paramedics and first responders a live AI layer on top of body cam footage — real-time alerts, spatial awareness, and instant scene reconstruction.
        </p>

        <div className="mt-10 flex items-center gap-4">
          <Link
            href="/alerts"
            className="px-7 py-3 bg-[var(--foreground)] text-[var(--background)] text-sm font-semibold rounded-[10px] hover:opacity-90 transition-opacity"
          >
            Open Dashboard
          </Link>
          <Link
            href="/dashboard"
            className="px-7 py-3 bg-[var(--muted)] text-[var(--foreground)] text-sm font-semibold rounded-[10px] hover:brightness-110 transition-all"
          >
            Live View
          </Link>
        </div>

      </div>
    </div>
  );
}
