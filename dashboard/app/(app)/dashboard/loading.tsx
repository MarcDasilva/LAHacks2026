export default function DashboardLoading() {
  return (
    <div className="h-full w-full p-3 grid grid-cols-[1fr_2fr] gap-2">
      <div className="row-span-full rounded-[16px]" />
      <div className="grid grid-rows-[1fr_auto_180px] gap-2 h-full min-h-0">
        <div className="border border-[var(--border)] rounded-[16px]" />
        <div className="border border-[var(--border)] rounded-[16px] p-3 flex gap-2">
          <div className="flex-1 h-9 rounded-[8px]" />
          <div className="w-20 h-9 rounded-[8px]" />
        </div>
        <div className="border border-[var(--border)] rounded-[16px] p-3 flex gap-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="shrink-0 w-36 h-full rounded-[12px]" />
          ))}
        </div>
      </div>
    </div>
  );
}
