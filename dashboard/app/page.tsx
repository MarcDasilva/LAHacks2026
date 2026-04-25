export default function Dashboard() {
  return (
    <main className="min-h-screen w-full p-4 flex items-start justify-center">
      <div className="w-full max-w-6xl h-[calc(100vh-2rem)] grid grid-cols-[1fr_2fr] gap-3">

        {/* ── Left column: phone-ratio vertical card ── */}
        <BentoCard className="row-span-full flex flex-col justify-between">
          <CardLabel>overview</CardLabel>
          <div className="flex-1 flex flex-col gap-3 mt-4">
            <div className="h-2 w-2/3 rounded-full bg-[var(--muted)]" />
            <div className="h-2 w-1/2 rounded-full bg-[var(--muted)]" />
            <div className="h-2 w-3/4 rounded-full bg-[var(--muted)]" />
          </div>
          <Stat value="—" label="status" />
        </BentoCard>

        {/* ── Right column: 3-row grid ── */}
        <div className="grid grid-rows-[2fr_1fr_1.5fr] gap-3 h-full">

          {/* Top — wide horizontal */}
          <BentoCard className="flex flex-col justify-between">
            <CardLabel>activity</CardLabel>
            <div className="flex-1 flex items-end gap-1 pb-1">
              {[40, 65, 30, 80, 55, 70, 45, 90, 60, 75, 50, 85].map((h, i) => (
                <div
                  key={i}
                  className="flex-1 rounded-sm bg-[var(--muted)] opacity-80"
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
          </BentoCard>

          {/* Middle — small horizontal */}
          <BentoCard className="flex flex-row items-center justify-between gap-6">
            <div className="flex flex-col gap-1">
              <CardLabel>metrics</CardLabel>
              <p className="text-xs text-[var(--muted-fg)] mt-1">real-time</p>
            </div>
            <div className="flex gap-6">
              <Stat value="—" label="total" />
              <Stat value="—" label="active" />
              <Stat value="—" label="pending" />
            </div>
          </BentoCard>

          {/* Bottom — horizontal */}
          <BentoCard className="flex flex-col justify-between">
            <CardLabel>feed</CardLabel>
            <div className="flex flex-col gap-2 mt-3 flex-1 overflow-hidden">
              {[...Array(4)].map((_, i) => (
                <FeedRow key={i} />
              ))}
            </div>
          </BentoCard>

        </div>
      </div>
    </main>
  );
}

/* ── Primitives ── */

function BentoCard({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-[var(--border)] bg-[var(--card)] p-5 overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

function CardLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-widest text-[var(--muted-fg)] font-medium font-mono">
      {children}
    </span>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-light tabular-nums">{value}</span>
      <span className="text-[10px] text-[var(--muted-fg)] uppercase tracking-wider font-mono">
        {label}
      </span>
    </div>
  );
}

function FeedRow() {
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 w-1.5 rounded-full bg-[var(--muted)] shrink-0" />
      <div className="h-2 flex-1 rounded-full bg-[var(--muted)]" />
      <div className="h-2 w-12 rounded-full bg-[var(--muted)] opacity-50" />
    </div>
  );
}
