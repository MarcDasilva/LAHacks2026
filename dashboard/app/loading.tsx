export default function AlertsLoading() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="h-full grid grid-cols-[1fr_1.6fr] gap-3 p-4">

        {/* Left: alerts */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between shrink-0">
            <div className="flex flex-col gap-2">
              <div className="h-5 w-20 rounded-[6px] border border-[var(--border)]" />
              <div className="h-3 w-12 rounded-[6px] border border-[var(--border)]" />
            </div>
            <div className="h-8 w-16 rounded-[8px] border border-[var(--border)]" />
          </div>
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4 border border-[var(--border)] rounded-[12px]">
              <div className="shrink-0 w-2 h-2 rounded-full border border-[var(--border)]" />
              <div className="flex-1 flex flex-col gap-2">
                <div className="h-3.5 w-3/4 rounded-[4px] border border-[var(--border)]" />
                <div className="h-2.5 w-1/2 rounded-[4px] border border-[var(--border)]" />
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="h-5 w-14 rounded-[6px] border border-[var(--border)]" />
                <div className="h-5 w-14 rounded-[6px] border border-[var(--border)]" />
                <div className="h-3 w-12 rounded-[4px] border border-[var(--border)]" />
              </div>
            </div>
          ))}
        </div>

        {/* Right: map */}
        <div className="border border-[var(--border)] rounded-[16px]" />

      </div>
    </div>
  );
}
