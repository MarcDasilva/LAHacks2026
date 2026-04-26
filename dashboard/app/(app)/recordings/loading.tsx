export default function RecordingsLoading() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="grid h-full grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="rounded-[16px] border border-[var(--border)]">
            <div className="aspect-video rounded-t-[16px] bg-[var(--muted)]" />
            <div className="flex flex-col gap-2 p-3">
              <div className="h-4 w-3/5 rounded-[4px] bg-[var(--muted)]" />
              <div className="h-3 w-2/5 rounded-[4px] bg-[var(--muted)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
