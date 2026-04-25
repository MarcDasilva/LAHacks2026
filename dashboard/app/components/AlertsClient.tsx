"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { MapRef } from "@/app/components/ui/map";

const Map = dynamic(() => import("@/app/components/ui/map"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 rounded-[16px]" />,
});

const ALERTS = [
  {
    id: "INC-0041",
    officer: "CAM_03",
    time: "14:32:08",
    severity: "critical",
    title: "Suspect fleeing on foot",
    location: "Block 400, Main St",
    status: "new",
    coords: [-118.2437, 34.0522] as [number, number],
  },
  {
    id: "INC-0040",
    officer: "CAM_01",
    time: "14:29:55",
    severity: "high",
    title: "Physical altercation detected",
    location: "Alley — 5th & Grand",
    status: "reviewing",
    coords: [-118.2500, 34.0480] as [number, number],
  },
  {
    id: "INC-0039",
    officer: "CAM_07",
    time: "14:21:14",
    severity: "medium",
    title: "Unattended vehicle flagged",
    location: "Parking lot C",
    status: "reviewing",
    coords: [-118.2380, 34.0560] as [number, number],
  },
];

const SEVERITY = {
  critical: { dot: "bg-[oklch(0.78_0.09_15)]", badge: "text-[oklch(0.78_0.09_15)] bg-[oklch(0.78_0.09_15)]/10" },
  high:     { dot: "bg-[oklch(0.82_0.09_55)]", badge: "text-[oklch(0.82_0.09_55)] bg-[oklch(0.82_0.09_55)]/10" },
  medium:   { dot: "bg-[oklch(0.86_0.09_90)]", badge: "text-[oklch(0.86_0.09_90)] bg-[oklch(0.86_0.09_90)]/10" },
} as const;

const STATUS: Record<string, string> = {
  new:       "text-[var(--foreground)] bg-[var(--muted)]",
  reviewing: "text-[oklch(0.86_0.09_90)] bg-[oklch(0.86_0.09_90)]/10",
};

export default function AlertsClient() {
  const mapRef = useRef<MapRef>(null);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Gradient mesh */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-[var(--lavender)]/[0.06] blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[350px] h-[350px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.04] blur-[80px]" />
      </div>
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <div className="relative z-10 h-full grid grid-cols-[1fr_1.6fr] gap-3 p-4">

        {/* Left: alerts feed */}
        <div className="flex flex-col gap-3 min-h-0 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between shrink-0">
            <div>
              <h1 className="text-xl font-bold tracking-[-0.02em] text-[var(--foreground)]">Alerts</h1>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] bg-[var(--muted)]">
              <span className="w-1.5 h-1.5 rounded-full bg-white/60 animate-pulse" />
              <span className="text-[11px] font-mono text-[var(--muted-foreground)] uppercase tracking-widest">live</span>
            </div>
          </div>

          {/* Cards */}
          <div className="flex flex-col gap-2">
            {ALERTS.map((alert) => {
              const sev = SEVERITY[alert.severity as keyof typeof SEVERITY];
              return (
                <div
                  key={alert.id}
                  onClick={() => mapRef.current?.easeTo({ center: alert.coords, zoom: 16, duration: 800 })}
                  className="group flex items-center gap-4 px-5 py-4 bg-[var(--card)] rounded-[12px] hover:brightness-110 transition-all cursor-pointer"
                >
                  <span className={`shrink-0 w-2 h-2 rounded-full ${sev.dot} ${alert.status === "new" ? "animate-pulse" : ""}`} />

                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold text-[var(--foreground)] tracking-[-0.01em] truncate block">{alert.title}</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-[11px] text-[var(--muted-foreground)] font-mono">{alert.officer}</span>
                      <span className="text-[var(--border)]">·</span>
                      <span className="text-[11px] text-[var(--muted-foreground)] truncate">{alert.location}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-[6px] ${sev.badge}`}>
                      {alert.severity}
                    </span>
                    <span className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-[6px] ${STATUS[alert.status]}`}>
                      {alert.status}
                    </span>
                    <span className="text-[11px] text-[var(--muted-foreground)] font-mono">{alert.time}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: map */}
        <div className="relative h-full bg-[var(--card)] rounded-[16px] overflow-hidden">
          <Map
            ref={mapRef}
            center={[-118.2437, 34.0522]}
            zoom={14}
          />
        </div>

      </div>
    </div>
  );
}
