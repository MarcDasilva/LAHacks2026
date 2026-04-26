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
  modelOutputs?: {
    yolo?: ModelOutputPayload | null;
    yamnet?: ModelOutputPayload | null;
    stt?: ModelOutputPayload | null;
  };
  updatedAt: string;
};

type ModelOutputPayload = {
  sessionID: string;
  emittedAt: string;
  chunk: {
    chunkID: string;
    startedAt: string;
    endedAt: string;
    frameCount: number;
  };
  model: {
    provider: string;
    name: string;
    version: number | null;
    mode: string;
    latencyMS: number;
  };
  output: {
    text: string;
    confidence: number;
    tensorCount: number;
  };
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
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

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

  const effectiveSelectedRoomId = useMemo(() => {
    if (selectedRoomId && activeRooms.some((room) => room.roomId === selectedRoomId)) {
      return selectedRoomId;
    }
    return activeRooms[0]?.roomId ?? null;
  }, [activeRooms, selectedRoomId]);

  const selectedRoom = useMemo(
    () => activeRooms.find((room) => room.roomId === effectiveSelectedRoomId) ?? null,
    [activeRooms, effectiveSelectedRoomId]
  );

  const previewRooms = useMemo(
    () => activeRooms.filter((room) => room.roomId !== effectiveSelectedRoomId),
    [activeRooms, effectiveSelectedRoomId]
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
                <div className="flex min-h-full flex-col gap-3 lg:flex-row">
                  {selectedRoom ? (
                    <SelectedCameraPanel room={selectedRoom} />
                  ) : null}

                  {previewRooms.length > 0 ? (
                    <div className="flex min-h-0 w-full shrink-0 gap-3 overflow-x-auto lg:flex-1 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
                      {previewRooms.map((room) => (
                        <CameraPreviewThumb
                          key={room.roomId}
                          room={room}
                          onSelect={() => setSelectedRoomId(room.roomId)}
                        />
                      ))}
                    </div>
                  ) : null}
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

function SelectedCameraPanel({ room }: { room: RoomSummary }) {
  const yoloPayload = room.modelOutputs?.yolo ?? null;
  const yamnetPayload = room.modelOutputs?.yamnet ?? null;
  const sttPayload = room.modelOutputs?.stt ?? null;

  return (
    <div className="min-h-[min(76vh,760px)] min-w-0 overflow-hidden rounded-[16px] border border-[var(--foreground)]/28 bg-white/22 shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_18px_48px_rgba(15,15,15,0.08)] transition-[width,transform,box-shadow] duration-300 ease-out lg:w-[min(50vw,760px)] lg:min-w-[min(50vw,760px)]">
      <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            {room.roomId}
          </p>
          <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
            Sender {room.senderId ?? "unknown"}
          </p>
        </div>
        <StatusPill label="live" />
      </div>

      <div className="bg-black/8 p-3 transition-[padding] duration-300">
        <div className="relative aspect-video overflow-hidden rounded-[14px] border border-[var(--border)]/55 bg-black/12 shadow-[0_1px_0_rgba(255,255,255,0.16)_inset] transition-[height] duration-300">
          <CameraFrameViewer roomId={room.roomId} />
        </div>
      </div>

      <div className="overflow-hidden transition-[max-height,opacity,transform] duration-300 ease-out max-h-[420px] opacity-100">
        <div className="flex items-center justify-between border-y border-[var(--border)]/70 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-[var(--foreground)]" />
            <p className="text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Output body
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            <span>{room.viewerCount} viewers</span>
            <span className="text-[var(--muted-foreground)]/55">/</span>
            <span>{room.lastFrameAt ? "live payloads" : "awaiting payloads"}</span>
          </div>
        </div>

        <div className="grid gap-3 px-3 py-3 lg:grid-cols-3">
          <ModelOutputSection kind="YOLO" payload={yoloPayload} emptyLabel="Waiting for detections from the phone." />
          <ModelOutputSection kind="YAMNet" payload={yamnetPayload} emptyLabel="Waiting for audio classification from the phone." />
          <ModelOutputSection kind="STT" payload={sttPayload} emptyLabel="Waiting for transcript text from the phone." />
        </div>
      </div>
    </div>
  );
}

function ModelOutputSection({
  kind,
  payload,
  emptyLabel,
}: {
  kind: "YOLO" | "YAMNet" | "STT";
  payload: ModelOutputPayload | null;
  emptyLabel: string;
}) {
  const parsedEntries = useMemo(() => parseOutputEntries(payload?.output.text ?? ""), [payload?.output.text]);
  const emittedAtLabel = payload?.emittedAt ? formatTimestamp(payload.emittedAt) : null;
  const heading =
    kind === "YOLO" ? "Vision events" : kind === "YAMNet" ? "Audio events" : "Speech transcript";
  const summaryLabel =
    kind !== "STT" && parsedEntries.length > 0
      ? parsedEntries.length === 1
        ? `1 signal`
        : `${parsedEntries.length} signals`
      : payload?.output.text?.trim()
        ? "text payload"
        : "idle";

  return (
    <section className="rounded-[14px] border border-[var(--border)]/60 bg-white/14">
      <div className="flex items-center justify-between border-b border-[var(--border)]/60 px-3 py-2.5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            {kind}
          </p>
          <p className="mt-1 text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">{heading}</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            {summaryLabel}
          </p>
          {emittedAtLabel ? (
            <p className="mt-1 text-[11px] font-semibold text-[var(--foreground)]/78">{emittedAtLabel}</p>
          ) : null}
        </div>
      </div>

      <div className="space-y-3 px-3 py-3">
        {payload ? (
          <>
            {parsedEntries.length > 0 ? (
              <div className="flex flex-col gap-2">
                {parsedEntries.map((entry, index) => (
                  <div
                    key={`${kind}-${entry.label}-${entry.confidence}-${index}`}
                    className="flex items-center justify-between gap-3 rounded-[10px] border border-[var(--border)]/55 bg-white/24 px-3 py-2"
                  >
                    <p className="min-w-0 text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                      {entry.label}
                    </p>
                    <p className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                      {entry.confidence}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] font-semibold text-[var(--foreground)]/88">
                {payload.output.text.trim() || emptyLabel}
              </p>
            )}

            <details className="rounded-[12px] border border-[var(--border)]/50 bg-white/18">
              <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--foreground)]">
                Expanded console
              </summary>
              <pre className="max-h-[220px] overflow-auto border-t border-[var(--border)]/50 px-3 py-3 font-mono text-[11px] font-semibold leading-5 text-[var(--foreground)]">
                {JSON.stringify(payload, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">{emptyLabel}</p>
        )}
      </div>
    </section>
  );
}

function CameraPreviewThumb({
  room,
  onSelect,
}: {
  room: RoomSummary;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative w-[400px] shrink-0 overflow-hidden rounded-[16px] text-left transition-transform duration-300 hover:-translate-y-0.5 lg:w-[400px]"
    >
      <div className="relative aspect-video overflow-hidden rounded-[16px] bg-black/12">
        <CameraFrameViewer roomId={room.roomId} />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.58))] px-3 py-2.5">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/72">
            {room.roomId}
          </p>
          <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-white">
            Sender {room.senderId ?? "unknown"}
          </p>
        </div>
      </div>
    </button>
  );
}

function StatusPill({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <span
      className={`rounded-[9px] border border-[oklch(0.78_0.09_15)]/70 bg-[oklch(0.78_0.09_15)]/18 font-bold uppercase tracking-[0.14em] text-black transition-[padding,font-size] duration-300 ${
        compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]"
      }`}
    >
      {label}
    </span>
  );
}

function parseOutputEntries(text: string) {
  return text
    .split(",")
    .map((part) => part.trim())
    .map((part) => {
      const match = part.match(/^(.*)\s+(\d+(?:\.\d+)?)%$/);
      if (!match) return null;
      return {
        label: match[1].trim(),
        confidence: `${match[2]}%`,
      };
    })
    .filter((entry): entry is { label: string; confidence: string } => Boolean(entry))
    .slice(0, 4);
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
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
