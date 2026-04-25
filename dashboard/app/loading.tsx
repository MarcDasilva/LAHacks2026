export default function AlertsLoading() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="h-full grid grid-cols-[1fr_1.6fr] gap-3 p-4">

        {/* Left: alerts skeleton */}
        <div className="flex flex-col gap-3">
          {/* Header */}
          <div className="flex items-center justify-between shrink-0">
            <div className="flex flex-col gap-2">
              <div className="skeleton h-5 w-20 rounded-[6px]" />
              <div className="skeleton h-3 w-12 rounded-[6px]" />
            </div>
            <div className="skeleton h-8 w-16 rounded-[8px]" />
          </div>

          {/* Cards */}
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-5 py-4 bg-[var(--card)] border border-[var(--border)] rounded-[12px]"
            >
              <div className="skeleton shrink-0 w-2 h-2 rounded-full" />
              <div className="flex-1 flex flex-col gap-2">
                <div className="skeleton h-3.5 w-3/4 rounded-[4px]" />
                <div className="skeleton h-2.5 w-1/2 rounded-[4px]" />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="skeleton h-5 w-14 rounded-[6px]" />
                <div className="skeleton h-5 w-14 rounded-[6px]" />
                <div className="skeleton h-3 w-12 rounded-[4px]" />
              </div>
            </div>
          ))}
        </div>

        {/* Right: map skeleton */}
        <div className="skeleton rounded-[16px]" />

      </div>
    </div>
  );
}
