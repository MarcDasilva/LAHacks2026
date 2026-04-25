export default function Dashboard() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Gradient mesh */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-[var(--lavender)]/[0.08] blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.06] blur-[80px]" />
      </div>
      {/* Dot grid */}
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <main className="relative z-10 h-full w-full p-3 flex items-start justify-center overflow-hidden">
        <div className="w-full h-full grid grid-cols-[1fr_2fr] gap-2">

          {/* ── Left: live body cam feed ── */}
          <Panel className="row-span-full flex flex-col min-h-0">
            <div className="flex-1 overflow-hidden relative min-h-0 rounded-[14px]">
              <StreamPanel />
            </div>
          </Panel>

          {/* ── Right column ── */}
          <div className="grid grid-rows-[1fr_auto_180px] gap-2 h-full min-h-0">

            {/* Top: 3D splatting render */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex-1 overflow-hidden relative min-h-0 rounded-[14px]">
                <RenderPanel />
              </div>
            </Panel>

            {/* Middle: query input */}
            <Panel className="flex flex-col gap-2 p-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Describe what you're looking for..."
                  className="flex-1 bg-[var(--muted)] border border-[var(--border)] rounded-[8px] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-all"
                />
                <button className="px-5 py-2 bg-[var(--muted)] border border-[var(--border)] text-[var(--foreground)] text-sm font-semibold rounded-[8px] hover:bg-[var(--border)] transition-colors">
                  Query
                </button>
              </div>
            </Panel>

            {/* Bottom: video chunks */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex gap-2 overflow-x-auto flex-1 min-h-0 p-3">
                {[...Array(6)].map((_, i) => (
                  <VideoChunk key={i} index={i} />
                ))}
              </div>
            </Panel>

          </div>
        </div>
      </main>
    </div>
  );
}

/* ── Primitives ── */

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[var(--card)] border border-[var(--border)] rounded-[16px] overflow-hidden shadow-[0_4px_24px_-4px_rgba(0,0,0,0.3)] ${className}`}>
      {children}
    </div>
  );
}

function PanelHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2.5 border-b border-[var(--border)] shrink-0">
      <span className="text-[10px] uppercase tracking-widest text-[var(--muted-foreground)] font-semibold font-mono">
        {children}
      </span>
    </div>
  );
}

function StreamPanel() {
  const ready = false; // swap to true when stream is connected
  if (!ready) return (
    <div className="absolute inset-0 border border-[var(--border)] rounded-[14px] flex flex-col items-end justify-end p-3 gap-1">
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-[oklch(0.78_0.09_15)] animate-pulse" />
        <span className="text-[10px] text-[var(--muted-foreground)] font-mono uppercase tracking-widest">live</span>
      </div>
      <span className="text-[10px] text-[var(--muted-foreground)] font-mono">cam_01</span>
    </div>
  );
  return null; // replace with <video> when ready
}

function RenderPanel() {
  const ready = false; // swap to true when splat data arrives
  if (!ready) return (
    <div className="absolute inset-0 border border-[var(--border)] rounded-[14px] flex items-end justify-end p-3">
      <span className="text-[10px] text-[var(--muted-foreground)] font-mono">no data</span>
    </div>
  );
  return null;
}

function VideoChunk({ index }: { index: number }) {
  return (
    <div className="shrink-0 w-36 h-full border border-[var(--border)] rounded-[12px] flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:border-[var(--lavender)]/40 transition-all">
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-[var(--muted-foreground)]">
        <polygon points="5,3 19,12 5,21" fill="currentColor" />
      </svg>
      <span className="text-[9px] text-[var(--muted-foreground)] font-mono">
        clip_{String(index + 1).padStart(2, "0")}
      </span>
    </div>
  );
}
