"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CameraFrameViewer from "@/app/components/CameraFrameViewer";
import { Activity, ChevronRight } from "lucide-react";

type RoomSummary = {
  roomId: string;
  senderOnline: boolean;
  senderId: string | null;
  viewerCount: number;
  frameCount: number;
  lastFrameAt: string | null;
  lastFrameBytes: number;
  updatedAt: string;
};

function getDefaultFrameStreamHttpUrl() {
  if (typeof window === "undefined") {
    return "http://localhost:8787";
  }

  const configured = process.env.NEXT_PUBLIC_FRAME_STREAM_WS_URL;
  if (configured) {
    return configured.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  }

  const protocol = window.location.protocol === "https:" ? "https" : "http";
  return `${protocol}://${window.location.hostname}:8787`;
}

export default function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldBoot = searchParams.get("boot") === "1";

  const [bootPhase, setBootPhase] = useState<"hidden" | "visible" | "fading">(
    shouldBoot ? "visible" : "hidden"
  );
  const [contentVisible, setContentVisible] = useState(!shouldBoot);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [fetchState, setFetchState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!shouldBoot) return;

    const holdTimer = window.setTimeout(() => {
      setBootPhase("fading");
      setContentVisible(true);
    }, 1000);

    const doneTimer = window.setTimeout(() => {
      setBootPhase("hidden");
      router.replace("/dashboard");
    }, 1450);

    return () => {
      window.clearTimeout(holdTimer);
      window.clearTimeout(doneTimer);
    };
  }, [shouldBoot, router]);

  useEffect(() => {
    let cancelled = false;
    const baseUrl = getDefaultFrameStreamHttpUrl();

    const loadRooms = async () => {
      try {
        const response = await fetch(`${baseUrl}/rooms`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = (await response.json()) as { rooms?: RoomSummary[] };
        if (cancelled) return;

        setRooms(Array.isArray(payload.rooms) ? payload.rooms : []);
        setFetchState("ready");
      } catch {
        if (cancelled) return;
        setFetchState("error");
      }
    };

    loadRooms();
    const intervalId = window.setInterval(loadRooms, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  const activeRooms = useMemo(
    () => rooms.filter((room) => room.senderOnline).sort((a, b) => a.roomId.localeCompare(b.roomId)),
    [rooms]
  );

  return (
    <div className="alerts-page dashboard-page relative h-full w-full overflow-hidden bg-[var(--background)]">
      {bootPhase !== "hidden" && (
        <div
          className={`absolute inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-[var(--background)] transition-opacity duration-450 ${
            bootPhase === "fading" ? "opacity-0" : "opacity-100"
          }`}
        >
          <div className="flex items-end gap-2">
            <span className="font-display tracking-tight text-4xl">IMPULSE</span>
            <span className="mb-1 text-sm font-display text-[var(--muted-foreground)]">OS</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse bg-[var(--foreground)]" />
            <span className="h-2 w-2 animate-pulse bg-[var(--foreground)]" style={{ animationDelay: "150ms" }} />
            <span className="h-2 w-2 animate-pulse bg-[var(--foreground)]" style={{ animationDelay: "300ms" }} />
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-28 -left-24 h-[460px] w-[460px] rounded-full bg-[var(--lavender)]/[0.08] blur-[72px]" />
        <div className="absolute bottom-0 right-0 h-[340px] w-[340px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.08] blur-[60px]" />
      </div>
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <div
        className={`relative z-10 h-full w-full transition-opacity duration-500 ${
          contentVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <main className="pointer-events-none absolute inset-0 flex flex-col p-3 md:p-4">
          <div className="pointer-events-auto pl-1 pt-0.5">
            <p className="flex items-center text-[13px] font-semibold tracking-[-0.01em] text-[var(--foreground)]">
              <span className="text-[var(--muted-foreground)]">Impulse</span>
              <ChevronRight size={14} className="mx-1 text-[var(--muted-foreground)]/70" />
              <span>Dashboard</span>
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              <span>{activeRooms.length} connected</span>
              <span className="text-[var(--muted-foreground)]/60">/</span>
              <span>{fetchState === "error" ? "relay offline" : "relay live"}</span>
            </div>
          </div>

          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3">
            <section className="pointer-events-auto min-h-0 overflow-auto">
              {activeRooms.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
                  {activeRooms.map((room) => (
                    <ConnectedCameraCard key={room.roomId} room={room} />
                  ))}
                </div>
              ) : (
                <EmptyCameraPreview
                  title={fetchState === "error" ? "Signal relay unavailable" : "No connected cameras"}
                  description={
                    fetchState === "error"
                      ? "The dashboard could not reach the frame relay server."
                      : "As soon as a building connection has live camera senders, they will appear here."
                  }
                />
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  );
}

function ConnectedCameraCard({ room }: { room: RoomSummary }) {
  const payload = {
    roomId: room.roomId,
    senderOnline: room.senderOnline,
    senderId: room.senderId,
    viewerCount: room.viewerCount,
    frameCount: room.frameCount,
    lastFrameAt: room.lastFrameAt,
    lastFrameBytes: room.lastFrameBytes,
    relayUpdatedAt: room.updatedAt,
  };

  return (
    <div className="overflow-hidden rounded-[14px] border border-[var(--border)]/70 bg-white/16 shadow-[0_1px_0_rgba(255,255,255,0.2)_inset]">
      <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            {room.roomId}
          </p>
          <p className="mt-1 text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
            Sender {room.senderId ?? "unknown"}
          </p>
        </div>
        <StatusPill label="live" />
      </div>

      <div className="aspect-video bg-black/8 p-3">
        <div className="relative h-full w-full overflow-hidden rounded-[14px] border border-[var(--border)]/55 bg-black/12 shadow-[0_1px_0_rgba(255,255,255,0.16)_inset]">
          <CameraFrameViewer roomId={room.roomId} />
        </div>
      </div>

      <div className="flex items-center justify-between border-y border-[var(--border)]/70 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Activity size={14} className="text-[var(--foreground)]" />
          <p className="text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
            Output body
          </p>
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
          json
        </span>
      </div>

      <pre className="max-h-[240px] overflow-auto px-3 py-3 font-mono text-[11px] font-semibold leading-5 text-[var(--foreground)]">
        {JSON.stringify(payload, null, 2)}
      </pre>
    </div>
  );
}

function StatusPill({ label }: { label: string }) {
  return (
    <span className="rounded-[9px] border border-[oklch(0.78_0.09_15)]/70 bg-[oklch(0.78_0.09_15)]/18 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-black">
      {label}
    </span>
  );
}

function EmptyCameraPreview({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-h-[420px] w-full max-w-[min(50vw,760px)] pt-2">
      <div className="overflow-hidden rounded-[16px] border border-[var(--border)]/70 bg-white/14 shadow-[0_1px_0_rgba(255,255,255,0.2)_inset]">
        <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              camera_preview
            </p>
            <p className="mt-1 text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Sender pending
            </p>
          </div>
          <span className="rounded-[9px] border border-[var(--border)]/60 bg-white/20 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--foreground)]">
            idle
          </span>
        </div>

        <div className="relative aspect-video overflow-hidden border-b border-[var(--border)]/70 bg-white/10">
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.04))]" />
          <div className="absolute inset-3 rounded-[14px] border border-dashed border-[var(--border)]/55 bg-white/10" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="rounded-[12px] border border-[var(--border)]/60 bg-white/32 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--foreground)]">
              Landscape camera feed
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-[var(--foreground)]" />
            <p className="text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Output body
            </p>
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            json
          </span>
        </div>

        <div className="px-3 py-3">
          <div className="rounded-[14px] border border-dashed border-[var(--border)]/55 bg-white/10 px-3 py-3">
            <p className="text-[14px] font-bold tracking-[-0.01em] text-[var(--foreground)]">{title}</p>
            <p className="mt-2 text-[13px] font-semibold text-[var(--muted-foreground)]">{description}</p>
            <pre className="mt-3 overflow-x-auto rounded-[10px] border border-[var(--border)]/45 bg-white/18 px-3 py-3 font-mono text-[11px] font-semibold leading-5 text-[var(--foreground)]">
{`{
  "roomId": "camera_preview",
  "senderOnline": false,
  "senderId": null,
  "viewerCount": 0,
  "frameCount": 0,
  "lastFrameAt": null
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
