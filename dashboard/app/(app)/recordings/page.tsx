"use client";

import { useEffect, useState } from "react";
import { Download, Video as VideoIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

type RecordingEntry = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  createdAt: string;
  roomId: string | null;
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

export default function RecordingsPage() {
  const [entries, setEntries] = useState<RecordingEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/recordings", { cache: "no-store" });
        const json = await res.json();
        if (!cancelled) {
          setEntries(Array.isArray(json.recordings) ? json.recordings : []);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    };
    load();
    const t = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-y-auto">
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
              recordings
            </p>
            <h1 className="mt-1 text-[20px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Captured phone streams
            </h1>
          </div>
          <span className="font-display text-[11px] uppercase tracking-[0.14em] text-[var(--muted-foreground)]">
            {entries.length} {entries.length === 1 ? "clip" : "clips"}
          </span>
        </div>

        {loaded && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-[16px] border border-dashed border-[var(--border)] py-20 text-center">
            <VideoIcon size={28} strokeWidth={1.5} className="text-[var(--muted-foreground)]" />
            <p className="text-[14px] font-semibold text-[var(--foreground)]">No recordings yet</p>
            <p className="text-[12px] text-[var(--muted-foreground)]">
              Start one from the dashboard while a phone is connected.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col overflow-hidden rounded-[16px] border border-[var(--border)] bg-[var(--background)]/60"
              >
                <div className="aspect-video bg-black">
                  <video
                    src={entry.url}
                    controls
                    preload="metadata"
                    className="h-full w-full object-contain"
                  />
                </div>
                <div className="flex flex-col gap-1 px-3 py-3">
                  <p className="truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                    {entry.name}
                  </p>
                  <div className="flex items-center justify-between text-[11px] text-[var(--muted-foreground)]">
                    <span>{entry.roomId ?? "unknown room"}</span>
                    <span>{formatBytes(entry.bytes)}</span>
                  </div>
                  <p className="text-[11px] text-[var(--muted-foreground)]">{formatDate(entry.createdAt)}</p>
                  <a href={`${entry.url}?download=1`} download={entry.name} className="mt-2">
                    <Button size="sm" variant="outline" className="w-full">
                      <Download size={14} strokeWidth={1.75} />
                      Download
                    </Button>
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
