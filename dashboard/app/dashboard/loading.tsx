export default function DashboardLoading() {
  return (
    <div className="h-full w-full p-3 grid grid-cols-[1fr_2fr] gap-2">

      {/* Left: live feed skeleton */}
      <div className="skeleton row-span-full rounded-[16px]" />

      {/* Right column */}
      <div className="grid grid-rows-[1fr_auto_180px] gap-2 h-full min-h-0">

        {/* 3D render */}
        <div className="skeleton rounded-[16px]" />

        {/* Query bar */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-[16px] p-3 flex gap-2">
          <div className="skeleton flex-1 h-9 rounded-[8px]" />
          <div className="skeleton w-20 h-9 rounded-[8px]" />
        </div>

        {/* Clips */}
        <div className="bg-[var(--card)] border border-[var(--border)] rounded-[16px] p-3 flex gap-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="skeleton shrink-0 w-36 h-full rounded-[12px]" />
          ))}
        </div>

      </div>
    </div>
  );
}
