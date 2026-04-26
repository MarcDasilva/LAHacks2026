"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type { MapRef } from "@/app/components/ui/map";
import GlassSurface from "@/components/GlassSurface";
import {
  Ambulance,
  Car,
  Layers3,
  LocateFixed,
  MapPinned,
  Minus,
  Navigation,
  Plus,
  Radar,
  Route,
  Search,
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
    title: "Cardiac arrest - CPR in progress",
    location: "Block 400, Main St",
    status: "reviewing",
    coords: [-118.446775, 34.070211] as [number, number],
  },
  {
    id: "INC-0040",
    officer: "CAM_01",
    time: "14:29:55",
    severity: "high",
    title: "Multi-vehicle collision reported",
    location: "Alley - 5th & Grand",
    status: "reviewing",
    coords: [-118.446775, 34.070211] as [number, number],
  },
  {
    id: "INC-0039",
    officer: "CAM_07",
    time: "14:21:14",
    severity: "medium",
    title: "Structure fire - units responding",
    location: "Parking lot C",
    status: "reviewing",
    coords: [-118.446775, 34.070211] as [number, number],
  },
];

const WESTWOOD_ALERT: AlertItem = {
  id: "INC-0042",
  officer: "CAM_03",
  time: "14:34:12",
  severity: "critical",
  title: "Mass casualty incident - triage needed",
  location: "301 Westwood Plaza, Los Angeles, CA 90095",
  status: "new",
  coords: [-118.446775, 34.070211],
};

const SEVERITY = {
  critical: {
    dot: "bg-[oklch(0.78_0.09_15)]",
    badge: "text-black bg-[oklch(0.78_0.09_15)]/12 border border-[oklch(0.78_0.09_15)]/45",
  },
  high: {
    dot: "bg-[oklch(0.82_0.09_55)]",
    badge: "text-black bg-[oklch(0.82_0.09_55)]/12 border border-[oklch(0.82_0.09_55)]/45",
  },
  medium: {
    dot: "bg-[oklch(0.86_0.09_90)]",
    badge: "text-black bg-[oklch(0.86_0.09_90)]/12 border border-[oklch(0.86_0.09_90)]/45",
  },
} as const;

const STATUS: Record<AlertItem["status"], string> = {
  new: "text-[var(--foreground)] bg-[var(--muted)] border border-[var(--border)]",
  reviewing: "text-black bg-[oklch(0.86_0.09_90)]/12 border border-[oklch(0.86_0.09_90)]/45",
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

  const counts = useMemo(() => {
    return {
      critical: alerts.filter((a) => a.severity === "critical").length,
      high: alerts.filter((a) => a.severity === "high").length,
      medium: alerts.filter((a) => a.severity === "medium").length,
    };
  }, [alerts]);

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
    const navEntry = window.performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    const isReload = navEntry?.type === "reload";
    if (!isReload) return;

    const delayMs = shouldBoot ? 3650 : 2550;
    const timer = window.setTimeout(() => {
      setAlerts((current) => [WESTWOOD_ALERT, ...current.filter((a) => a.id !== WESTWOOD_ALERT.id)]);
      setNewAlertId(WESTWOOD_ALERT.id);
      setNewAlertActive(false);
      window.requestAnimationFrame(() => setNewAlertActive(true));
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [shouldBoot]);

  const focusAlert = (alert: AlertItem) => {
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
  };

  return (
    <div className="alerts-page relative h-full w-full overflow-hidden bg-[var(--background)]">
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
            <span className="h-2 w-2 bg-[var(--foreground)] animate-pulse" style={{ animationDelay: "150ms" }} />
            <span className="h-2 w-2 bg-[var(--foreground)] animate-pulse" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-28 -left-24 h-[460px] w-[460px] rounded-full bg-[var(--lavender)]/[0.08] blur-[72px]" />
        <div className="absolute bottom-0 right-0 h-[320px] w-[320px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.08] blur-[56px]" />
      </div>
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <div
        className={`relative z-10 h-full w-full transition-opacity duration-500 ${
          contentVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="absolute inset-0">
          <Map ref={mapRef} center={defaultCenter} zoom={mapZoom} pitch={is3D ? 58 : 0} bearing={-22} />
        </div>

        <div className="pointer-events-none absolute inset-0 p-3 md:p-4">
          <header className="pointer-events-auto flex items-center gap-3">
            <GlassSurface
              width="auto"
              height="auto"
              borderRadius={12}
              saturation={1.15}
              backgroundOpacity={0.08}
              blur={4}
              className="alerts-glass"
            >
              <div className="px-3 py-2">
                <div className="flex items-end gap-2">
                  <span className="font-display tracking-tight text-2xl text-[var(--foreground)]">IMPULSE</span>
                  <span className="text-[var(--muted-foreground)] font-display text-xs mb-1">&gt; DISPATCH</span>
                </div>
              </div>
            </GlassSurface>

            <div className="hidden md:block flex-1">
              <GlassSurface
                width="100%"
                height={52}
                borderRadius={12}
                saturation={1.15}
                backgroundOpacity={0.08}
                blur={4}
                className="alerts-glass"
              >
                <div className="flex h-full items-center gap-2 px-3">
                  <Search size={16} className="text-[var(--muted-foreground)]" />
                  <input
                    type="text"
                    placeholder="Search names, addresses, incidents..."
                    className="w-full bg-transparent text-sm font-semibold text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none"
                  />
                </div>
              </GlassSurface>
            </div>

            <div className="hidden lg:flex items-center gap-2">
              <MetricChip label="Critical" value={counts.critical} />
              <MetricChip label="High" value={counts.high} />
              <MetricChip label="Medium" value={counts.medium} />
            </div>
          </header>

          <div className="mt-3 flex h-[calc(100%-132px)] gap-3 md:gap-4">
            <section className="pointer-events-auto w-full max-w-[420px] h-full">
              <GlassSurface
                width="100%"
                height="100%"
                borderRadius={14}
                saturation={1.18}
                backgroundOpacity={0.1}
                blur={4}
                className="alerts-glass"
              >
                <div className="h-full flex flex-col overflow-hidden">
                  <div className="border-b border-[var(--border)]/70 p-3">
                    <div className="grid grid-cols-2 gap-2">
                      <GlassActionButton icon={<Car size={15} />} label="Dispatch Car" />
                      <GlassActionButton icon={<Ambulance size={15} />} label="Dispatch EMT" danger />
                    </div>
                  </div>

                  <div className="px-3 py-2 border-b border-[var(--border)]/70 flex items-center justify-between">
                    <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">Incident Queue</h2>
                    <span className="text-[12px] font-semibold text-[var(--muted-foreground)]">{alerts.length} active</span>
                  </div>

                  <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
                    {alerts.map((alert) => {
                      const sev = SEVERITY[alert.severity];
                      const isNewCritical = alert.status === "new" && alert.severity === "critical";
                      return (
                        <GlassSurface
                          key={alert.id}
                          width="100%"
                          height="auto"
                          borderRadius={12}
                          saturation={1.12}
                          backgroundOpacity={0.08}
                          blur={4}
                          className={`alerts-glass alerts-glass-press ${
                            alert.id === newAlertId
                              ? newAlertActive
                                ? "opacity-100 translate-y-0 scale-100 duration-500 ease-out new-alert-outline"
                                : "opacity-0 -translate-y-2 scale-[0.98]"
                              : ""
                          } ${isNewCritical ? "border-[oklch(0.78_0.09_15)]/92 bg-[oklch(0.78_0.09_15)]/20" : "border-[var(--border)]/70"}`}
                        >
                          <button type="button" onClick={() => focusAlert(alert)} className="w-full text-left px-3 py-2.5 hover:brightness-110 transition-all">
                            <div className="flex items-start gap-2.5">
                              <span className={`mt-1.5 h-2.5 w-2.5 rounded-full ${sev.dot} ${alert.status === "new" ? "animate-pulse" : ""}`} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">{alert.title}</p>
                                <p className="mt-1 truncate text-[11px] font-semibold text-[var(--muted-foreground)]">{alert.location}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  <Pill className={sev.badge}>{alert.severity}</Pill>
                                  <Pill className={STATUS[alert.status]}>{alert.status}</Pill>
                                  <span className="text-[10px] font-semibold text-[var(--muted-foreground)] font-display">{alert.time}</span>
                                  <span className="text-[10px] font-semibold text-[var(--muted-foreground)] font-display">{alert.officer}</span>
                                </div>
                              </div>
                            </div>
                          </button>
                        </GlassSurface>
                      );
                    })}
                  </div>
                </div>
              </GlassSurface>
            </section>

            <div className="flex-1" />

            <aside className="pointer-events-auto hidden md:flex w-[74px] flex-col gap-2 items-end">
              <ControlRailButton
                title="Zoom in"
                onClick={() => {
                  const next = Math.min(20, mapZoom + 0.6);
                  setMapZoom(next);
                  mapRef.current?.easeTo({ zoom: next, duration: 350 });
                }}
                icon={<Plus size={15} />}
              />
              <ControlRailButton
                title="Zoom out"
                onClick={() => {
                  const next = Math.max(10, mapZoom - 0.6);
                  setMapZoom(next);
                  mapRef.current?.easeTo({ zoom: next, duration: 350 });
                }}
                icon={<Minus size={15} />}
              />
              <ControlRailButton
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
              <ControlRailButton
                title="Reset"
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
              <ControlRailButton
                title="Center all"
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
              <ControlRailButton
                title="Westwood"
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
            </aside>
          </div>

          <GlassSurface
            width="100%"
            height="auto"
            borderRadius={12}
            saturation={1.14}
            backgroundOpacity={0.08}
            blur={4}
            className="alerts-glass pointer-events-auto mt-3"
          >
            <footer className="px-3 py-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                <span className="h-2 w-2 rounded-full bg-[oklch(0.78_0.09_15)] animate-pulse" />
                Live feed synchronized
              </div>
              <div className="flex items-center gap-2">
                <MapChip icon={<Navigation size={14} />} label="3D Nav" />
                <MapChip icon={<Route size={14} />} label="Routes" />
                <MapChip icon={<ShieldAlert size={14} />} label="Incident Zone" />
              </div>
            </footer>
          </GlassSurface>
        </div>
      </div>
    </div>
  );
}

function Pill({ className, children }: { className: string; children: ReactNode }) {
  return <span className={`rounded-[8px] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${className}`}>{children}</span>;
}

function MetricChip({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <GlassSurface width={84} height={58} borderRadius={11} saturation={1.12} backgroundOpacity={0.08} blur={4} className="alerts-glass">
      <div className="px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] font-display text-[var(--muted-foreground)]">{label}</p>
        <p className="text-[16px] font-bold tracking-[-0.02em] text-[var(--foreground)]">{value}</p>
      </div>
    </GlassSurface>
  );
}

function GlassActionButton({
  icon,
  label,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  danger?: boolean;
}) {
  return (
    <GlassSurface
      width="100%"
      height={44}
      borderRadius={11}
      saturation={1.12}
      backgroundOpacity={0.08}
      blur={4}
      className={`alerts-glass alerts-glass-press ${danger ? "border-[oklch(0.78_0.09_15)]/60" : ""}`}
    >
      <button
        type="button"
        className="h-full w-full px-2 text-sm font-semibold flex items-center justify-center gap-2 text-[var(--foreground)] transition-colors"
      >
        {icon}
        <span>{label}</span>
      </button>
    </GlassSurface>
  );
}

function ControlRailButton({
  icon,
  title,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <GlassSurface width={38} height={38} borderRadius={10} saturation={1.12} backgroundOpacity={0.08} blur={4} className="alerts-glass alerts-glass-press">
      <button type="button" title={title} aria-label={title} onClick={onClick} className="h-full w-full flex items-center justify-center text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
        {icon}
      </button>
    </GlassSurface>
  );
}

function MapChip({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <GlassSurface width="auto" height={34} borderRadius={10} saturation={1.1} backgroundOpacity={0.08} blur={4} className="alerts-glass">
      <div className="flex h-full items-center gap-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] font-display text-[var(--muted-foreground)]">
        {icon}
        <span>{label}</span>
      </div>
    </GlassSurface>
  );
}
