"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type { MapRef } from "@/app/components/ui/map";
import {
  Ambulance,
  Car,
  Layers3,
  LocateFixed,
  MapPinned,
  Navigation,
  Plus,
  Minus,
  Radar,
  Route,
  ShieldAlert,
} from "lucide-react";

const Map = dynamic(() => import("@/app/components/ui/map"), {
  ssr: false,
  loading: () => <div className="absolute inset-0" />,
});

type AlertItem = {
  id: string;
  officer: string;
  time: string;
  severity: "critical" | "high" | "medium";
  title: string;
  location: string;
  status: "new" | "reviewing";
  coords: [number, number];
};

const ALERTS: AlertItem[] = [
  {
    id: "INC-0041",
    officer: "CAM_03",
    time: "14:32:08",
    severity: "critical",
    title: "Suspect fleeing on foot",
    location: "Block 400, Main St",
    status: "reviewing",
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

const WESTWOOD_ALERT: AlertItem = {
  id: "INC-0042",
  officer: "CAM_03",
  time: "14:34:12",
  severity: "critical",
  title: "Suspicious activity detected",
  location: "301 Westwood Plaza, Los Angeles, CA 90095",
  status: "new",
  coords: [-118.446775, 34.070211],
};

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
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldBoot = searchParams.get("boot") === "1";
  const [bootPhase, setBootPhase] = useState<"hidden" | "visible" | "fading">(
    shouldBoot ? "visible" : "hidden"
  );
  const [contentVisible, setContentVisible] = useState(!shouldBoot);
  const [alerts, setAlerts] = useState<AlertItem[]>(ALERTS);
  const [newAlertId, setNewAlertId] = useState<string | null>(null);
  const [newAlertActive, setNewAlertActive] = useState(false);
  const [mapZoom, setMapZoom] = useState(16.2);
  const [is3D, setIs3D] = useState(true);
  const mapRef = useRef<MapRef>(null);
  const defaultCenter: [number, number] = [-118.0267, 34.0522];

  useEffect(() => {
    if (!shouldBoot) return;

    const holdTimer = window.setTimeout(() => {
      setBootPhase("fading");
      setContentVisible(true);
    }, 1000);

    const doneTimer = window.setTimeout(() => {
      setBootPhase("hidden");
      router.replace("/alerts");
    }, 1450);

    return () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(doneTimer);
    };
  }, [shouldBoot, router]);

  useEffect(() => {
    const navEntry = window.performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const isReload = navEntry?.type === "reload";
    if (!isReload) return;

    const delayMs = shouldBoot ? 3650 : 2550;
    const timer = window.setTimeout(() => {
      setAlerts((current) => {
        return [WESTWOOD_ALERT, ...current.filter((alert) => alert.id !== WESTWOOD_ALERT.id)];
      });
      setNewAlertId(WESTWOOD_ALERT.id);
      setNewAlertActive(false);
      window.requestAnimationFrame(() => {
        setNewAlertActive(true);
      });
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [shouldBoot]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {bootPhase !== "hidden" && (
        <div
          className={`absolute inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[var(--background)] transition-opacity duration-450 ${
            bootPhase === "fading" ? "opacity-0" : "opacity-100"
          }`}
        >
          <div className="flex items-end gap-2">
            <span className="font-display tracking-tight text-4xl">IMPULSE</span>
            <span className="text-[var(--muted-foreground)] font-display text-sm mb-1">OS</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 bg-[var(--foreground)] animate-pulse" />
            <span
              className="h-2 w-2 bg-[var(--foreground)] animate-pulse"
              style={{ animationDelay: "150ms" }}
            />
            <span
              className="h-2 w-2 bg-[var(--foreground)] animate-pulse"
              style={{ animationDelay: "300ms" }}
            />
          </div>
        </div>
      )}

      {/* Gradient mesh */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-[var(--lavender)]/[0.06] blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[350px] h-[350px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.04] blur-[80px]" />
      </div>
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <div
        className={`relative z-10 h-full w-full transition-opacity duration-500 ${
          contentVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-0">
          <Map
            ref={mapRef}
            center={defaultCenter}
            zoom={mapZoom}
            pitch={is3D ? 58 : 0}
            bearing={-22}
          />
        </div>

        <div className="pointer-events-none absolute right-3 top-3 z-20 flex flex-col gap-2">
          <div className="pointer-events-auto border border-[var(--border)] bg-[var(--background)]/80 backdrop-blur-xl">
            <div className="flex">
              <MapToolbarButton
                title="Zoom in"
                onClick={() => {
                  const next = Math.min(20, mapZoom + 0.6);
                  setMapZoom(next);
                  mapRef.current?.easeTo({ zoom: next, duration: 350 });
                }}
                icon={<Plus size={15} />}
              />
              <MapToolbarButton
                title="Zoom out"
                onClick={() => {
                  const next = Math.max(10, mapZoom - 0.6);
                  setMapZoom(next);
                  mapRef.current?.easeTo({ zoom: next, duration: 350 });
                }}
                icon={<Minus size={15} />}
              />
            </div>
            <div className="flex border-t border-[var(--border)]">
              <MapToolbarButton
                title={is3D ? "Switch to 2D" : "Switch to 3D"}
                onClick={() => {
                  const next3D = !is3D;
                  setIs3D(next3D);
                  mapRef.current?.easeTo({
                    pitch: next3D ? 58 : 0,
                    bearing: next3D ? -22 : 0,
                    duration: 450,
                  });
                }}
                icon={<Layers3 size={15} />}
              />
              <MapToolbarButton
                title="Reset view"
                onClick={() => {
                  setMapZoom(16.2);
                  setIs3D(true);
                  mapRef.current?.easeTo({
                    center: defaultCenter,
                    zoom: 16.2,
                    pitch: 58,
                    bearing: -22,
                    duration: 700,
                  });
                }}
                icon={<LocateFixed size={15} />}
              />
            </div>
            <div className="flex border-t border-[var(--border)]">
              <MapToolbarButton
                title="Center all alerts"
                onClick={() => {
                  mapRef.current?.easeTo({
                    center: [-118.2437, 34.0522],
                    zoom: 14.2,
                    pitch: 46,
                    bearing: -18,
                    duration: 800,
                  });
                }}
                icon={<Radar size={15} />}
              />
              <MapToolbarButton
                title="Go to Westwood incident"
                onClick={() => {
                  mapRef.current?.easeTo({
                    center: [-118.446775, 34.070211],
                    zoom: 17.3,
                    pitch: 62,
                    bearing: -30,
                    duration: 900,
                  });
                }}
                icon={<MapPinned size={15} />}
              />
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-3">
          <MapChip icon={<Navigation size={16} />} label="3D Navigation" />
          <MapChip icon={<Route size={16} />} label="Routes" />
          <MapChip icon={<ShieldAlert size={16} />} label="Incident Zone" />
        </div>

        <div className="pointer-events-none absolute inset-0 p-3 flex items-start">
          <div className="pointer-events-auto absolute top-3 left-[calc(3px+420px+12px)] w-[360px] max-w-[calc(100vw-460px)]">
            <input
              type="text"
              placeholder="Search address..."
              className="w-full h-10 px-3 border border-[var(--border)] bg-[var(--background)]/82 backdrop-blur-xl text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
          </div>
          <div className="pointer-events-auto w-full max-w-[420px] border border-[var(--border)] bg-[var(--background)]/78 backdrop-blur-xl max-h-[calc(100%-1.5rem)] overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)]">
              <h1 className="text-lg font-bold tracking-[-0.02em] text-[var(--foreground)]">Alerts</h1>
            </div>

            <div className="px-2.5 pt-2.5 pb-0">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  className="h-11 border border-[var(--border)] bg-[var(--muted)] text-[var(--foreground)] text-sm font-semibold tracking-[-0.01em] flex items-center justify-center gap-2 hover:bg-[var(--border)] transition-colors"
                >
                  <Car size={16} />
                  <span>Dispatch Car</span>
                </button>
                <button
                  type="button"
                  className="h-11 border border-[oklch(0.78_0.09_15)]/70 bg-[oklch(0.78_0.09_15)]/14 text-[oklch(0.78_0.09_15)] text-sm font-semibold tracking-[-0.01em] flex items-center justify-center gap-2 hover:bg-[oklch(0.78_0.09_15)]/24 transition-colors"
                >
                  <Ambulance size={16} />
                  <span>Dispatch Ambulance</span>
                </button>
              </div>
            </div>

            <div className="p-2.5 pt-2 flex flex-col gap-1.5 overflow-y-auto max-h-[calc(100vh-11rem)]">
              {alerts.map((alert) => {
                const sev = SEVERITY[alert.severity as keyof typeof SEVERITY];
                return (
                  <div
                    key={alert.id}
                    onClick={() =>
                      {
                        mapRef.current?.easeTo({
                          center: alert.coords,
                          zoom: alert.id === WESTWOOD_ALERT.id ? 17.3 : 16.8,
                          pitch: 62,
                          bearing: -30,
                          duration: 900,
                        });
                        window.setTimeout(() => {
                          mapRef.current?.highlightBuildingAt(alert.coords);
                        }, 700);
                      }
                    }
                    className={`group flex items-center gap-3 px-3 py-2 bg-[var(--card)] hover:brightness-110 transition-all cursor-pointer border border-[var(--border)] ${
                      alert.id === newAlertId
                        ? (newAlertActive
                            ? "opacity-100 translate-y-0 scale-100 duration-500 ease-out new-alert-outline"
                            : "opacity-0 -translate-y-2 scale-[0.98]")
                        : ""
                    } ${
                      alert.id === WESTWOOD_ALERT.id
                        ? "border-[oklch(0.78_0.09_15)]/70 bg-[oklch(0.78_0.09_15)]/8"
                        : ""
                    }`}
                  >
                    <span className={`shrink-0 w-2 h-2 ${sev.dot} ${alert.status === "new" ? "animate-pulse" : ""}`} />

                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] font-semibold text-[var(--foreground)] tracking-[-0.01em] truncate block">{alert.title}</span>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px] text-[var(--muted-foreground)] font-display">{alert.officer}</span>
                        <span className="text-[var(--border)]">·</span>
                        <span className="text-[10px] text-[var(--muted-foreground)] truncate">{alert.location}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 ${sev.badge}`}>
                        {alert.severity}
                      </span>
                      <span className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 ${STATUS[alert.status]}`}>
                        {alert.status}
                      </span>
                      <span className="text-[10px] text-[var(--muted-foreground)] font-display">{alert.time}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MapToolbarButton({
  icon,
  title,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className="h-9 w-9 flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
    >
      {icon}
    </button>
  );
}

function MapChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="border border-[var(--border)] bg-[var(--background)]/82 backdrop-blur-xl px-4 py-2.5 text-[12px] font-display uppercase tracking-widest text-[var(--muted-foreground)] flex items-center gap-2">
      {icon}
      <span>{label}</span>
    </div>
  );
}
