"use client";

import {
  ChangeEvent,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CameraFrameViewer from "@/app/components/CameraFrameViewer";
import { PointCloudViewer } from "@/app/components/ui/PointCloudViewer";
import { GaussianSplatViewer } from "@/app/components/ui/GaussianSplatViewer";
import GlassSurface from "@/components/GlassSurface";
import Grainient from "@/components/Grainient";
import { Activity, ChevronRight, Search } from "lucide-react";

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

// ── Splat manifest + shared video selection ───────────────────────────────
//
// Every video that's been processed for sparse-splat reconstruction has
// an entry in /clouds/splats/manifest.json mapping a stable videoId to
// its splat artifacts. Both LandscapeCameraFeed and SparseSplatPanel
// read this through the SelectedVideoContext: when the user switches
// footage, the splat panel swaps in the matching point cloud.

type SplatStatus = "ready" | "processing" | "failed";

type SplatRecord = {
  videoId: string;
  videoUrl: string;
  videoLocalPath?: string;
  lbmpPath?: string;
  pathPath?: string;
  status: SplatStatus;
  label?: string;
  points?: number;
  error?: string;
  splatStatus?: "pending" | "training" | "ready" | "failed";
  splatJobId?: string;
  splatPath?: string;
  splatError?: string;
  indexStatus?: "pending" | "ready" | "failed";
  indexError?: string;
};

type SplatManifest = {
  version: number;
  videos: Record<string, SplatRecord>;
};

type SelectedVideo = {
  videoId: string;
  source: "cloudinary" | "user" | "local" | "stream";
};

type ActiveClip = {
  videoId: string;
  startSec: number;
  endSec: number;
  caption: string;
} | null;

type SelectedVideoCtx = {
  selected: SelectedVideo | null;
  setSelected: (v: SelectedVideo | null) => void;
  manifest: SplatManifest | null;
  refreshManifest: () => Promise<void>;
  activeClip: ActiveClip;
  setActiveClip: (c: ActiveClip) => void;
};

const SelectedVideoContext = createContext<SelectedVideoCtx | null>(null);

function useSelectedVideo(): SelectedVideoCtx {
  const ctx = useContext(SelectedVideoContext);
  if (!ctx) throw new Error("SelectedVideoContext is missing");
  return ctx;
}

const DEFAULT_VIDEO_ID = "impulse__sparse_source";

function publicIdToVideoId(publicId: string): string {
  return publicId.replace(/[\/\\]/g, "__");
}

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
  const [worldOpen, setWorldOpen] = useState(false);
  // Default mode is "stream": the dashboard waits for an iPhone sender as
  // before. Switching to "upload" replaces the left column with the upload
  // picker — the streaming pipeline keeps polling /rooms either way.
  const [mode, setMode] = useState<"stream" | "upload">("stream");
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
    let timeoutId: number | null = null;
    let consecutiveFailures = 0;
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
        consecutiveFailures = 0;
      } catch {
        if (cancelled) return;
        setFetchState("error");
        consecutiveFailures += 1;
      } finally {
        if (cancelled) return;
        // Healthy: poll fast. After three failures back off to 30s so the
        // browser console isn't flooded with ERR_CONNECTION_REFUSED when
        // the relay isn't running locally.
        const delay = consecutiveFailures >= 3 ? 30_000 : 1500;
        timeoutId = window.setTimeout(loadRooms, delay);
      }
    };

    loadRooms();

    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
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

  // ── Splat manifest + shared video selection ─────────────────────────
  const [manifest, setManifest] = useState<SplatManifest | null>(null);
  // Default: nothing selected. The right column (splat + search) only
  // appears once the user picks a video; until then the camera preview
  // shows "no video footage selected" with the picker.
  const [selected, setSelected] = useState<SelectedVideo | null>(null);
  const [activeClip, setActiveClip] = useState<ActiveClip>(null);

  const refreshManifest = useCallback(async () => {
    // /api/splat-poll drains any finished Modal jobs (writing scene.splat
    // to disk + updating the manifest) and returns the manifest in the
    // same request, so polling does both at once. Falls back to the
    // static manifest if MODAL_SPLAT_URL isn't configured.
    try {
      const res = await fetch("/api/splat-poll", { cache: "no-store" });
      if (!res.ok) throw new Error(`splat-poll ${res.status}`);
      const payload = (await res.json()) as SplatManifest;
      setManifest(payload);
      return;
    } catch {
      /* fall through to static manifest */
    }
    try {
      const res = await fetch("/clouds/splats/manifest.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      const payload = (await res.json()) as SplatManifest;
      setManifest(payload);
    } catch {
      setManifest({ version: 1, videos: {} });
    }
  }, []);

  useEffect(() => {
    refreshManifest();
  }, [refreshManifest]);

  // When the selected video changes, drop any active clip from a previous
  // search session — its time range belongs to a different video.
  useEffect(() => {
    setActiveClip(null);
  }, [selected?.videoId]);

  // While any splat in the manifest is still processing, poll periodically
  // so the UI flips from 'processing…' → 'ready' without a manual reload.
  useEffect(() => {
    if (!manifest) return;
    const anyProcessing = Object.values(manifest.videos).some(
      (v) =>
        v.status === "processing" ||
        v.splatStatus === "pending" ||
        v.splatStatus === "training" ||
        v.indexStatus === "pending"
    );
    if (!anyProcessing) return;
    const id = window.setInterval(refreshManifest, 4000);
    return () => window.clearInterval(id);
  }, [manifest, refreshManifest]);

  const selectionCtx = useMemo<SelectedVideoCtx>(
    () => ({ selected, setSelected, manifest, refreshManifest, activeClip, setActiveClip }),
    [selected, manifest, refreshManifest, activeClip]
  );

  return (
    <SelectedVideoContext.Provider value={selectionCtx}>
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
        <div className="relative h-full w-full">
          <Grainient
            color1="#ffffff"
            color2="#5f5f5f"
            color3="#fafafa"
            timeSpeed={0.25}
            colorBalance={0}
            warpStrength={1}
            warpFrequency={5}
            warpSpeed={2}
            warpAmplitude={50}
            blendAngle={0}
            blendSoftness={0.05}
            rotationAmount={500}
            noiseScale={2}
            grainAmount={0.1}
            grainScale={2}
            grainAnimated={false}
            contrast={1.5}
            gamma={1}
            saturation={1}
            centerX={0}
            centerY={0}
            zoom={0.9}
            className="h-full w-full"
          />
        </div>
        <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.14),rgba(255,255,255,0.04)_38%,rgba(17,17,17,0.08))]" />
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
            <section className="pointer-events-auto min-h-0 flex-1 overflow-hidden">
              <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
                <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto lg:w-1/2 lg:flex-1">
                  {mode === "upload" ? (
                    <UploadCameraPanel
                      mode={mode}
                      onChangeMode={setMode}
                      worldOpen={worldOpen}
                      onToggleWorld={() => setWorldOpen((value) => !value)}
                    />
                  ) : activeRooms.length > 0 ? (
                    selectedRoom ? (
                      <SelectedCameraPanel
                        room={selectedRoom}
                        worldOpen={worldOpen}
                        onToggleWorld={() => setWorldOpen((value) => !value)}
                        mode={mode}
                        onChangeMode={setMode}
                      />
                    ) : null
                  ) : (
                    <EmptyCameraPreview
                      title={fetchState === "error" ? "Signal relay unavailable" : "No connected cameras"}
                      description={
                        fetchState === "error"
                          ? "The dashboard could not reach the frame relay server."
                          : "As soon as the iPhone app starts streaming camera frames, they will appear here."
                      }
                      worldOpen={worldOpen}
                      onToggleWorld={() => setWorldOpen((value) => !value)}
                      mode={mode}
                      onChangeMode={setMode}
                    />
                  )}
                </div>

                <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto lg:w-1/2 lg:flex-1">
                  <SparseSplatPanel onNavigateToFootage={() => setMode("upload")} />
                </div>
              </div>
            </section>
          </div>
        </main>
      </div>
    </div>
    </SelectedVideoContext.Provider>
  );
}

function SelectedCameraPanel({
  room,
  worldOpen,
  onToggleWorld,
  mode,
  onChangeMode,
}: {
  room: RoomSummary;
  worldOpen: boolean;
  onToggleWorld: () => void;
  mode: "stream" | "upload";
  onChangeMode: (m: "stream" | "upload") => void;
}) {
  const yoloPayload = room.modelOutputs?.yolo ?? null;
  const yamnetPayload = room.modelOutputs?.yamnet ?? null;
  const sttPayload = room.modelOutputs?.stt ?? null;

  return (
    <GlassSurface
      width="100%"
      height="100%"
      borderRadius={16}
      saturation={1.18}
      backgroundOpacity={0.1}
      blur={4}
      className="alerts-glass flex min-h-[min(78vh,820px)] w-full min-w-0 flex-1 flex-col overflow-hidden transition-[width,transform,box-shadow] duration-300 ease-out"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              {room.roomId}
            </p>
            <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Sender {room.senderId ?? "unknown"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill label="live" />
            <ModeToggle mode={mode} onChange={onChangeMode} />
            <WorldButton active={worldOpen} onClick={onToggleWorld} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
      </div>
    </GlassSurface>
  );
}

function AdditionalCamerasPanel({
  rooms,
  onSelectRoom,
}: {
  rooms: RoomSummary[];
  onSelectRoom: (roomId: string) => void;
}) {
  return (
    <GlassSurface
      width="100%"
      height="100%"
      borderRadius={16}
      saturation={1.18}
      backgroundOpacity={0.1}
      blur={4}
      className="alerts-glass flex min-h-[min(78vh,820px)] min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--primary)]/55 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              additional_cameras
            </p>
            <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              {rooms.length > 0 ? "Other live iPhone feeds" : "No extra live feeds yet"}
            </p>
          </div>
          <StatusPill label={rooms.length > 0 ? `${rooms.length} live` : "idle"} />
        </div>

        {rooms.length > 0 ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
            {rooms.map((room) => (
              <CameraPreviewThumb
                key={room.roomId}
                room={room}
                stacked
                onSelect={() => onSelectRoom(room.roomId)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-sm rounded-[14px] border border-dashed border-[var(--primary)]/45 bg-white/18 px-4 py-4 text-center">
              <p className="text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                Waiting for more camera streams
              </p>
              <p className="mt-2 text-[12px] font-semibold text-[var(--muted-foreground)]">
                When another iPhone joins the relay, it will appear here until you open World.
              </p>
            </div>
          </div>
        )}
      </div>
    </GlassSurface>
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

type CloudinaryFootage = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  durationSec: number | null;
  createdAt: string | null;
  source?: "local" | "cloudinary";
};

type FeedSource =
  | { kind: "local"; src: string }
  | { kind: "cloudinary"; src: string; label: string }
  | { kind: "stream"; src: string }
  | { kind: "user"; src: string; name: string };

function LandscapeCameraFeed() {
  const { setSelected, refreshManifest } = useSelectedVideo();
  const [feed, setFeed] = useState<FeedSource | null>(null);
  const [library, setLibrary] = useState<CloudinaryFootage[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<"idle" | "uploading" | "error">("idle");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const userObjectUrlRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // No auto-default feed: the user must explicitly pick footage from the
  // dropdown (or upload one) before any panel is populated.
  useEffect(() => {
    return () => {
      if (userObjectUrlRef.current) URL.revokeObjectURL(userObjectUrlRef.current);
    };
  }, []);

  // Load the Cloudinary footage library when the picker opens (lazy so we
  // don't hit the admin API on every dashboard mount).
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/footage", { cache: "no-store" });
        const payload = (await res.json()) as {
          videos?: CloudinaryFootage[];
          error?: string;
        };
        if (cancelled) return;
        setLibrary(payload.videos ?? []);
        setLibraryError(payload.error ?? null);
      } catch (e) {
        if (!cancelled) setLibraryError(e instanceof Error ? e.message : "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  // Click-outside to dismiss the picker.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [pickerOpen]);

  const onUploadPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Show local playback immediately while the server uploads to
    // Cloudinary and starts COLMAP — gives the user instant feedback.
    if (userObjectUrlRef.current) URL.revokeObjectURL(userObjectUrlRef.current);
    const localUrl = URL.createObjectURL(file);
    userObjectUrlRef.current = localUrl;
    setFeed({ kind: "user", src: localUrl, name: file.name });
    setPickerOpen(false);

    setUploadStatus("uploading");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/upload-video", { method: "POST", body: form });
      if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
      const payload = (await res.json()) as { videoId?: string; videoUrl?: string };
      if (payload.videoUrl) {
        if (userObjectUrlRef.current) {
          URL.revokeObjectURL(userObjectUrlRef.current);
          userObjectUrlRef.current = null;
        }
        setFeed({ kind: "local", src: payload.videoUrl });
      }
      if (payload.videoId) {
        setSelected({ videoId: payload.videoId, source: "user" });
        await refreshManifest();
      }
      setUploadStatus("idle");
    } catch {
      setUploadStatus("error");
    }
    e.target.value = "";
  };

  const pickStreamUrl = () => {
    const value = window.prompt(
      "Paste a video stream URL (mp4, hls, dash):",
      "https://"
    );
    if (!value) return;
    setFeed({ kind: "stream", src: value });
    setPickerOpen(false);
  };

  const sourceLabel =
    feed?.kind === "user"
      ? uploadStatus === "uploading"
        ? `uploading · ${feed.name}`
        : uploadStatus === "error"
          ? `upload failed · ${feed.name}`
          : `uploaded · ${feed.name}`
      : feed?.kind === "cloudinary"
        ? `cloudinary · ${feed.label}`
        : feed?.kind === "stream"
          ? "stream"
          : feed?.kind === "local"
            ? "local"
            : "idle";

  return (
    <div ref={containerRef} className="relative flex-1 min-h-[420px] overflow-hidden border-b border-[var(--primary)]/70 bg-black">
      {feed ? (
        <video
          key={feed.src}
          src={feed.src}
          autoPlay
          loop
          muted
          playsInline
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.04))]">
          <div className="rounded-[12px] border border-[var(--primary)]/60 bg-white/32 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--foreground)]">
            Landscape camera feed
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
        <span className="truncate max-w-[220px] rounded-[9px] border border-[var(--primary)]/60 bg-black/45 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
          {sourceLabel}
        </span>
      </div>

      <div className="absolute right-3 top-3 z-10">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="rounded-[10px] border border-[var(--primary)]/70 bg-white/85 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--foreground)] shadow-[0_1px_0_rgba(255,255,255,0.4)_inset] transition hover:bg-white"
        >
          Choose footage
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={onUploadPick}
        />

        {pickerOpen ? (
          <div className="absolute right-0 mt-2 w-[280px] overflow-hidden rounded-[14px] border border-[var(--primary)] bg-white/96 shadow-[0_18px_48px_rgba(15,15,15,0.18)] backdrop-blur">
            <div className="border-b border-[var(--primary)]/40 px-3 py-2">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                Library
              </p>
            </div>
            <div className="max-h-[220px] overflow-y-auto">
              {library.length === 0 ? (
                <p className="px-3 py-3 text-[12px] font-semibold text-[var(--muted-foreground)]">
                  {libraryError ?? "loading…"}
                </p>
              ) : (
                library.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => {
                      if (v.source === "local") {
                        setFeed({ kind: "local", src: v.url });
                        // Manifest stores uploads under
                        // `impulse__uploads__<basename-without-ext>` — match
                        // that here so the splat panel finds the record.
                        const base = v.name.replace(/\.[^.]+$/, "");
                        setSelected({
                          videoId: `impulse__uploads__${base}`,
                          source: "local",
                        });
                      } else {
                        setFeed({ kind: "cloudinary", src: v.url, label: v.name });
                        setSelected({ videoId: publicIdToVideoId(v.id), source: "cloudinary" });
                      }
                      setPickerOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-[var(--primary)]/8"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                        {v.name}
                      </p>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="border-t border-[var(--primary)]/40">
              <button
                type="button"
                onClick={pickStreamUrl}
                className="block w-full px-3 py-2 text-left text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)] transition hover:bg-[var(--primary)]/8"
              >
                Paste stream URL…
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="block w-full px-3 py-2 text-left text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)] transition hover:bg-[var(--primary)]/8"
              >
                Upload from device…
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type SearchResult = {
  videoId: string;
  videoUrl: string;
  startSec: number;
  endSec: number;
  caption: string;
  score: number;
};

type ManifestRecordExt = SplatRecord & { videoLocalUrl?: string };

function manifestPlaybackSource(rec: ManifestRecordExt | null | undefined): SelectedVideo["source"] {
  if (!rec) return "local";
  const url = rec.videoLocalUrl ?? rec.videoUrl ?? "";
  if (/cloudinary\.com|video\/upload|image\/upload/i.test(url)) return "cloudinary";
  return "local";
}

function selectedSourceForSearchHit(hit: SearchResult, manifest: SplatManifest | null): SelectedVideo["source"] {
  const rec = manifest?.videos[hit.videoId] as ManifestRecordExt | undefined;
  if (rec) return manifestPlaybackSource(rec);
  if (/cloudinary\.com/i.test(hit.videoUrl)) return "cloudinary";
  return "local";
}

function SearchHitClipPreview({
  src,
  startSec,
  endSec,
  className = "",
}: {
  src: string;
  startSec: number;
  endSec: number;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !src) return;

    const syncStart = () => {
      try {
        if (v.readyState >= 1) {
          v.currentTime = startSec;
          void v.play();
        }
      } catch {
        /* seek can fail before media is ready */
      }
    };

    const onTime = () => {
      if (v.currentTime >= endSec - 0.06 || v.currentTime < startSec - 0.2) {
        v.currentTime = startSec;
        void v.play();
      }
    };

    v.addEventListener("loadeddata", syncStart);
    v.addEventListener("loadedmetadata", syncStart);
    v.addEventListener("canplay", syncStart);
    v.addEventListener("timeupdate", onTime);
    syncStart();

    return () => {
      v.removeEventListener("loadeddata", syncStart);
      v.removeEventListener("loadedmetadata", syncStart);
      v.removeEventListener("canplay", syncStart);
      v.removeEventListener("timeupdate", onTime);
    };
  }, [src, startSec, endSec]);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      playsInline
      preload="metadata"
      className={className}
      aria-hidden
    />
  );
}

function SparseSplatPanel({ onNavigateToFootage }: { onNavigateToFootage?: () => void }) {
  const { selected, manifest, activeClip, setActiveClip, setSelected } = useSelectedVideo();
  const record = selected ? manifest?.videos[selected.videoId] ?? null : null;
  const status: SplatStatus | "unknown" = record?.status ?? (manifest ? "unknown" : "processing");

  const lbmpUrl = record?.lbmpPath ?? null;
  const pathUrl = record?.pathPath ?? null;
  // Prefer the Modal-trained Gaussian splat once it's ready; otherwise fall
  // back to the local COLMAP sparse cloud (.lbmp).
  const splatStatus = record?.splatStatus;
  const splatUrl = splatStatus === "ready" ? record?.splatPath ?? null : null;
  const localSparseReady = !splatUrl && status === "ready" && Boolean(lbmpUrl);

  const statusLabel =
    splatStatus === "ready"
      ? "splat ready"
      : splatStatus === "training" || splatStatus === "pending"
        ? "training…"
        : splatStatus === "failed"
          ? "splat failed"
          : status === "ready"
            ? "ready"
            : status === "processing"
              ? "processing…"
              : status === "failed"
                ? "failed"
                : "no splat";

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchUiStatus, setSearchUiStatus] = useState<"idle" | "searching" | "error" | "empty">("idle");
  const [searchErrorMsg, setSearchErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setSearchResults([]);
    setSearchUiStatus("idle");
    setSearchErrorMsg(null);
  }, [selected?.videoId]);

  const selectedLabel = selected
    ? manifest?.videos[selected.videoId]?.label ?? selected.videoId
    : null;
  const selectedRecord = selected ? manifest?.videos[selected.videoId] ?? null : null;
  const indexStatus = selectedRecord?.indexStatus;
  const indexBlocked = indexStatus === "pending" || indexStatus === "failed";

  const goToSearchHit = useCallback(
    (hit: SearchResult) => {
      onNavigateToFootage?.();
      setSelected({ videoId: hit.videoId, source: selectedSourceForSearchHit(hit, manifest) });
      setActiveClip({
        videoId: hit.videoId,
        startSec: hit.startSec,
        endSec: hit.endSec,
        caption: hit.caption,
      });
    },
    [manifest, onNavigateToFootage, setActiveClip, setSelected]
  );

  const submitSearch = async () => {
    const q = query.trim();
    if (!q) return;
    if (!selected?.videoId) {
      setSearchUiStatus("error");
      setSearchErrorMsg("pick a video first");
      return;
    }
    setSearchUiStatus("searching");
    setSearchErrorMsg(null);
    try {
      const params = new URLSearchParams({
        q,
        limit: "6",
        video: selected.videoId,
      });
      const res = await fetch(`/api/search?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await res.json()) as {
        results?: SearchResult[];
        error?: string;
      };
      if (payload.error) {
        setSearchUiStatus("error");
        setSearchErrorMsg(payload.error);
        setSearchResults([]);
        return;
      }
      const list = payload.results ?? [];
      setSearchResults(list);
      const top = list[0];
      if (top) goToSearchHit(top);
      setSearchUiStatus(list.length === 0 ? "empty" : "idle");
    } catch (e) {
      setSearchUiStatus("error");
      setSearchErrorMsg(e instanceof Error ? e.message : "request failed");
    }
  };

  return (
    <GlassSurface
      width="100%"
      height="100%"
      borderRadius={16}
      saturation={1.18}
      backgroundOpacity={0.1}
      blur={4}
      className="alerts-glass flex min-h-[min(72vh,760px)] min-w-0 flex-none flex-col overflow-hidden transition-[width,transform,box-shadow] duration-300 ease-out"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--primary)]/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              sparse_splat
            </p>
            <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              {record?.label ?? selected?.videoId ?? "no video selected"}
            </p>
          </div>
          <StatusPill label={statusLabel} />
        </div>

        <div className="shrink-0 bg-black/8 p-3 transition-[padding] duration-300">
          <div className="relative aspect-video overflow-hidden rounded-[14px] border border-[var(--primary)]/55 bg-black/12 shadow-[0_1px_0_rgba(255,255,255,0.16)_inset] transition-[height] duration-300">
            {splatUrl ? (
              <GaussianSplatViewer
                key={selected?.videoId ?? "none"}
                url={splatUrl}
                flipUp
              />
            ) : splatStatus === "failed" ? (
              <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]">
                <div className="rounded-[12px] border border-[var(--primary)]/45 bg-black/45 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/85">
                  {`Splat failed: ${record?.splatError ?? record?.error ?? "unknown"}`}
                </div>
              </div>
            ) : splatStatus === "pending" || splatStatus === "training" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))] text-white">
                <Spinner size={24} className="text-white" />
                <div className="rounded-[12px] border border-[var(--primary)]/45 bg-black/55 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/90">
                  Training Gaussian splat… (~5–10 min)
                </div>
              </div>
            ) : lbmpUrl && localSparseReady ? (
              <PointCloudViewer
                key={selected?.videoId ?? "none"}
                url={lbmpUrl}
                pointSizeFactor={0.0014}
                pathUrl={pathUrl ?? undefined}
                lockElevation
                flipUp
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]">
                <div className="rounded-[12px] border border-[var(--primary)]/45 bg-black/45 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/85">
                  {status === "processing"
                    ? "Building sparse splat…"
                    : status === "failed"
                      ? `Splat failed: ${record?.error ?? "unknown"}`
                      : "No splat for this video yet"}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)]/55 bg-black/6">
          <div className="flex min-h-0 flex-1 flex-col p-3">
            <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[var(--border)]/60 bg-white/14 shadow-[0_1px_0_rgba(255,255,255,0.06)_inset]">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)]/60 px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2.5">
                  <Search
                    size={14}
                    className="mt-0.5 shrink-0 text-[var(--foreground)] opacity-[0.72]"
                    strokeWidth={2.25}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                      sentry_search
                    </p>
                    <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                      {selectedLabel ? "Natural-language clips" : "Clip retrieval"}
                    </p>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <p
                    className={`text-[10px] font-semibold uppercase tracking-[0.14em] font-display ${
                      indexStatus === "pending"
                        ? "text-[var(--foreground)] animate-pulse"
                        : indexStatus === "failed"
                          ? "text-[var(--destructive)]"
                          : "text-[var(--muted-foreground)]"
                    }`}
                  >
                    {indexStatus === "pending"
                      ? "indexing"
                      : indexStatus === "failed"
                        ? "index failed"
                        : "index ready"}
                  </p>
                  {selectedLabel ? (
                    <p className="mt-1 max-w-[140px] truncate text-[11px] font-semibold text-[var(--foreground)]/78">
                      {selectedLabel}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 flex-wrap items-stretch gap-2 border-b border-[var(--border)]/60 px-3 py-3">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitSearch();
                  }}
                  placeholder={
                    indexStatus === "pending"
                      ? "Indexing — search unlocks when ready…"
                      : "e.g. someone walking through a doorway"
                  }
                  disabled={indexBlocked}
                  className="min-h-[40px] min-w-0 flex-1 rounded-[10px] border border-[var(--border)]/55 bg-white/24 px-3 py-2 text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)] placeholder:font-semibold placeholder:text-[var(--muted-foreground)]/65 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]/30 disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={submitSearch}
                  disabled={searchUiStatus === "searching" || indexBlocked}
                  className="flex min-h-[40px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-[var(--primary)]/70 bg-black/45 px-4 py-2 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-white shadow-[0_1px_0_rgba(255,255,255,0.14)_inset] transition hover:bg-black/60 disabled:opacity-50"
                >
                  {searchUiStatus === "searching" ? (
                    <>
                      <Spinner size={10} className="text-white" />
                      Searching
                    </>
                  ) : (
                    "Search"
                  )}
                </button>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
                {indexStatus === "pending" ? (
                  <LoadingBlock
                    title="Indexing video for Sentry Search"
                    subtitle="Captioning frames and generating embeddings. This usually takes a minute or two — searching unlocks the moment indexing finishes."
                    variant="primary"
                  />
                ) : indexStatus === "failed" ? (
                  <div className="flex flex-col gap-3 rounded-[12px] border border-[var(--destructive)]/35 bg-[var(--destructive)]/8 px-4 py-4 text-center">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--destructive)]">
                      indexing failed
                    </p>
                    <p className="text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                      Couldn&apos;t index this video for search
                    </p>
                    <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
                      {selectedRecord?.indexError ?? "Check the indexer log under /tmp/impulse_upload_*/index.log."}
                    </p>
                  </div>
                ) : searchUiStatus === "searching" ? (
                  <LoadingBlock
                    title="Running Sentry Search"
                    subtitle={`Embedding query · ranking ${selectedLabel ? `clips in ${selectedLabel}` : "indexed clips"}…`}
                    variant="primary"
                  />
                ) : searchUiStatus === "error" ? (
                  <p className="rounded-[10px] border border-[var(--destructive)]/35 bg-[var(--destructive)]/8 px-3 py-2.5 text-[13px] font-semibold text-[var(--destructive)]">
                    {searchErrorMsg ?? "search failed"}
                  </p>
                ) : searchUiStatus === "empty" ? (
                  <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
                    No matching clips. Try a different query or run the indexer.
                  </p>
                ) : searchResults.length === 0 ? (
                  <p className="text-[13px] font-semibold text-[var(--muted-foreground)]">
                    Describe a moment in{" "}
                    <span className="font-mono text-[12px] font-bold text-[var(--foreground)]/88">
                      {selectedLabel ?? "the selected video"}
                    </span>{" "}
                    to find it.
                  </p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {searchResults.map((r, i) => {
                      const isActive =
                        activeClip &&
                        activeClip.videoId === r.videoId &&
                        activeClip.startSec === r.startSec;
                      const clipSrc = r.videoUrl?.trim() ?? "";
                      const duration = Math.max(0.1, r.endSec - r.startSec);
                      return (
                        <button
                          key={`${r.videoId}-${r.startSec}-${i}`}
                          type="button"
                          onClick={() => goToSearchHit(r)}
                          aria-label={`Play clip ${r.startSec.toFixed(1)} to ${r.endSec.toFixed(1)} seconds, match strength ${(r.score * 100).toFixed(0)} percent`}
                          className={`group w-full overflow-hidden rounded-[12px] border text-left transition ${
                            isActive
                              ? "border-[var(--primary)]/50 bg-white/28 ring-2 ring-[var(--ring)]/25"
                              : "border-[var(--border)]/55 bg-white/24 hover:bg-white/30"
                          }`}
                        >
                          <div className="relative aspect-video w-full overflow-hidden bg-black/40">
                            {clipSrc ? (
                              <SearchHitClipPreview
                                src={clipSrc}
                                startSec={r.startSec}
                                endSec={r.endSec}
                                className="pointer-events-none h-full w-full object-cover"
                              />
                            ) : (
                              <div className="flex h-full min-h-[120px] items-center justify-center px-3 text-center text-[11px] font-semibold text-[var(--muted-foreground)]">
                                No preview URL for this hit
                              </div>
                            )}
                            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.72))] px-2.5 pb-2 pt-6">
                              <div className="flex items-end justify-between gap-2">
                                <span className="truncate font-mono text-[10px] font-bold tabular-nums text-white/92">
                                  {r.startSec.toFixed(1)}s – {r.endSec.toFixed(1)}s · {duration.toFixed(1)}s clip
                                </span>
                                <span className="shrink-0 rounded-[6px] border border-white/25 bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/90">
                                  {(r.score * 100).toFixed(0)}%
                                </span>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        <div className="shrink-0 border-t border-[var(--border)]/55 px-3 py-2.5">
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            <span className="text-[var(--muted-foreground)]/55">/</span>
            <span className="truncate">
              {record?.points ? `${record.points.toLocaleString()} pts` : statusLabel}
            </span>
          </div>
        </div>
      </div>
    </GlassSurface>
  );
}

function CameraPreviewThumb({
  room,
  onSelect,
  stacked = false,
}: {
  room: RoomSummary;
  onSelect: () => void;
  stacked?: boolean;
}) {
  return (
    <GlassSurface
      width="100%"
      height="auto"
      borderRadius={16}
      saturation={1.12}
      backgroundOpacity={0.08}
      blur={4}
      className={`alerts-glass alerts-glass-press group overflow-hidden ${
        stacked ? "w-full" : "w-[400px] shrink-0 lg:w-[400px]"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left"
      >
        <div className="relative aspect-video overflow-hidden rounded-[15px] bg-black/12">
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
    </GlassSurface>
  );
}

function WorldButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <GlassSurface
      width="auto"
      height={34}
      borderRadius={10}
      saturation={1.12}
      backgroundOpacity={0.08}
      blur={4}
      className="alerts-glass alerts-glass-press"
    >
      <button
        type="button"
        onClick={onClick}
        className={`h-full w-full px-3 text-[10px] font-bold uppercase tracking-[0.14em] transition ${
          active
            ? "text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        }`}
      >
        World
      </button>
    </GlassSurface>
  );
}

function UploadCameraPanel({
  mode,
  onChangeMode,
  worldOpen,
  onToggleWorld,
}: {
  mode: "stream" | "upload";
  onChangeMode: (m: "stream" | "upload") => void;
  worldOpen: boolean;
  onToggleWorld: () => void;
}) {
  const { selected, setSelected, manifest, refreshManifest, activeClip, setActiveClip } =
    useSelectedVideo();
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "uploading" | "uploaded" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  // Local object URL we can play immediately while the server processes
  // the upload — gives the user instant feedback before the API responds.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // Server-served URL (the ffmpeg-normalised preview under /api/local-video/…),
  // returned by /api/upload-video. Once we have it we swap to it so the
  // looping playback survives a manifest refresh.
  const [serverVideoUrl, setServerVideoUrl] = useState<string | null>(null);
  const previewObjectUrlRef = useRef<string | null>(null);
  const [library, setLibrary] = useState<CloudinaryFootage[]>([]);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    return () => {
      if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
    };
  }, []);

  // Resolve playback URL: prefer the just-uploaded server URL, fall back
  // to the local object URL while the upload is mid-flight, then to the
  // manifest's videoLocalUrl/videoUrl for videos picked from the library.
  const manifestRecord = selected ? manifest?.videos[selected.videoId] ?? null : null;
  const playbackUrl =
    serverVideoUrl ??
    previewUrl ??
    (manifestRecord as ManifestRecordExt | null)?.videoLocalUrl ??
    manifestRecord?.videoUrl ??
    null;

  // When the user jumps to another indexed clip (e.g. Sentry Search), drop
  // upload-local URLs so manifest playback for the new videoId wins.
  useEffect(() => {
    const id = selected?.videoId;
    if (!id) return;
    const rec = manifest?.videos[id] as ManifestRecordExt | undefined;
    const canonical = rec?.videoLocalUrl ?? rec?.videoUrl ?? null;
    if (!canonical) return;
    if (serverVideoUrl && serverVideoUrl !== canonical) {
      setServerVideoUrl(null);
    }
    if (previewUrl) {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = null;
      }
      setPreviewUrl(null);
    }
  }, [selected?.videoId, manifest, serverVideoUrl, previewUrl]);

  // Loop within the active search clip when one is set; otherwise the
  // <video loop> attribute handles full-video looping.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !activeClip || !playbackUrl) return;
    const onTime = () => {
      if (v.currentTime >= activeClip.endSec - 0.05 || v.currentTime < activeClip.startSec - 0.5) {
        v.currentTime = activeClip.startSec;
        v.play().catch(() => {});
      }
    };
    try {
      v.currentTime = activeClip.startSec;
    } catch {
      /* readyState may still be 0; the timeupdate handler will catch up */
    }
    v.play().catch(() => {});
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [activeClip, playbackUrl, selected]);

  // Lazy-load the cloudinary library only when the picker opens — same
  // pattern LandscapeCameraFeed uses.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/footage", { cache: "no-store" });
        const payload = (await res.json()) as {
          videos?: CloudinaryFootage[];
          error?: string;
        };
        if (cancelled) return;
        setLibrary(payload.videos ?? []);
        setLibraryError(payload.error ?? null);
      } catch (e) {
        if (!cancelled) setLibraryError(e instanceof Error ? e.message : "load failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pickerOpen]);

  const submitFile = useCallback(
    async (file: File) => {
      setUploadStatus("uploading");
      setUploadError(null);
      setUploadName(file.name);
      setServerVideoUrl(null);
      // Show the picked file immediately as a looping preview while the
      // server uploads + transcodes. The object URL is revoked once the
      // server preview takes over (or on unmount).
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
      }
      const localUrl = URL.createObjectURL(file);
      previewObjectUrlRef.current = localUrl;
      setPreviewUrl(localUrl);

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/upload-video", { method: "POST", body: form });
        if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text()}`);
        const payload = (await res.json()) as {
          videoId?: string;
          videoUrl?: string;
          videoLocalUrl?: string;
          videoOriginalLocalUrl?: string;
        };
        const playable =
          payload.videoLocalUrl ?? payload.videoOriginalLocalUrl ?? payload.videoUrl ?? null;
        if (playable) setServerVideoUrl(playable);
        if (payload.videoId) {
          setSelected({ videoId: payload.videoId, source: "user" });
          await refreshManifest();
        }
        setUploadStatus("uploaded");
      } catch (e) {
        setUploadStatus("error");
        setUploadError(e instanceof Error ? e.message : "upload failed");
      }
    },
    [setSelected, refreshManifest]
  );

  const onUploadPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await submitFile(file);
  };

  const onDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await submitFile(file);
  };

  const pickedRecord = selected ? manifest?.videos[selected.videoId] ?? null : null;
  const indexStatus = pickedRecord?.indexStatus;
  const showIndexLoader =
    uploadStatus !== "uploading" && indexStatus === "pending";
  const statusLabel =
    uploadStatus === "uploading"
      ? "uploading"
      : uploadStatus === "error"
        ? "upload failed"
        : indexStatus === "pending"
          ? "indexing"
          : indexStatus === "failed"
            ? "index failed"
            : uploadStatus === "uploaded"
              ? "uploaded"
              : "ready";

  return (
    <GlassSurface
      width="100%"
      height="100%"
      borderRadius={16}
      saturation={1.18}
      backgroundOpacity={0.1}
      blur={4}
      className="alerts-glass flex min-h-[min(78vh,820px)] w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              upload_video
            </p>
            <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              {uploadName ?? pickedRecord?.label ?? "Drop or pick a video"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill label={statusLabel} />
            <ModeToggle mode={mode} onChange={onChangeMode} />
            <WorldButton active={worldOpen} onClick={onToggleWorld} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div
            ref={dragRef}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={`relative aspect-video overflow-hidden border-b border-[var(--border)]/70 bg-black/12 transition ${
              dragOver ? "bg-[var(--primary)]/10" : ""
            }`}
          >
            {playbackUrl ? (
              <video
                key={playbackUrl}
                ref={videoRef}
                src={playbackUrl}
                autoPlay
                loop={!activeClip}
                muted
                playsInline
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <>
                <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.04))]" />
                <div
                  className={`absolute inset-3 rounded-[14px] border border-dashed bg-white/10 transition ${
                    dragOver ? "border-[var(--primary)]" : "border-[var(--border)]/55"
                  }`}
                />
              </>
            )}
            {showIndexLoader ? (
              <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex items-center gap-2 rounded-[10px] border border-[var(--primary)]/60 bg-black/60 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-white">
                <Spinner size={12} className="text-white" />
                indexing for sentry search…
              </div>
            ) : null}
            {activeClip ? (
              <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[80%] flex-col items-start gap-1.5">
                <span className="rounded-[9px] border border-[var(--primary)]/60 bg-black/55 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                  {activeClip.startSec.toFixed(1)}s – {activeClip.endSec.toFixed(1)}s · sentry hit
                </span>
                <span className="line-clamp-2 rounded-[8px] bg-black/45 px-2 py-1 text-[11px] font-semibold text-white/92">
                  {activeClip.caption}
                </span>
              </div>
            ) : null}
            {activeClip ? (
              <button
                type="button"
                onClick={() => setActiveClip(null)}
                className="absolute right-3 top-3 z-10 rounded-[9px] border border-[var(--primary)]/60 bg-black/55 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white transition hover:bg-black/75"
              >
                clear clip
              </button>
            ) : null}
            {playbackUrl ? null : (
              <div
                className={`absolute inset-0 flex flex-col items-center justify-center gap-3 ${
                  uploadStatus === "uploading" ? "bg-black/15" : ""
                }`}
              >
                {uploadStatus === "uploading" ? (
                  <div className="flex items-center gap-2 text-[var(--foreground)]">
                    <Spinner size={18} />
                    <span className="text-[11px] font-bold uppercase tracking-[0.14em] font-display">
                      uploading…
                    </span>
                  </div>
                ) : null}
                <div className="rounded-[12px] border border-[var(--border)]/60 bg-white/32 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--foreground)]">
                  {uploadStatus === "uploading"
                    ? `uploading · ${uploadName ?? "video"}`
                    : uploadStatus === "error"
                      ? "upload failed"
                      : "drop a video or use the picker"}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadStatus === "uploading"}
                    className="rounded-[10px] border border-[var(--primary)]/70 bg-[var(--primary)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--primary-foreground)] shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] transition hover:opacity-90 disabled:opacity-50"
                  >
                    Upload from device
                  </button>
                  <button
                    type="button"
                    onClick={() => setPickerOpen((v) => !v)}
                    className="rounded-[10px] border border-[var(--primary)]/70 bg-white/85 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--foreground)] transition hover:bg-white"
                  >
                    Library
                  </button>
                </div>
              </div>
            )}

            {/* Persistent corner controls: once a video is loaded, the
                Library + Upload buttons live in the bottom-right corner of
                the video card so the user can swap clips without losing
                the playback view. */}
            {playbackUrl ? (
              <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadStatus === "uploading"}
                  className="rounded-[10px] border border-[var(--primary)]/70 bg-black/55 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-white shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] transition hover:bg-black/75 disabled:opacity-50"
                >
                  {uploadStatus === "uploading" ? (
                    <span className="flex items-center gap-1.5">
                      <Spinner size={10} className="text-white" />
                      uploading
                    </span>
                  ) : (
                    "Upload"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setPickerOpen((v) => !v)}
                  className="rounded-[10px] border border-[var(--primary)]/70 bg-white/90 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--foreground)] transition hover:bg-white"
                >
                  Library
                </button>
              </div>
            ) : null}

            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={onUploadPick}
            />

            {pickerOpen ? (
              <div className="absolute bottom-14 right-3 z-20 w-[280px] overflow-hidden rounded-[14px] border border-[var(--primary)] bg-white/96 shadow-[0_18px_48px_rgba(15,15,15,0.18)] backdrop-blur">
                <div className="border-b border-[var(--primary)]/40 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                    Library
                  </p>
                </div>
                <div className="max-h-[220px] overflow-y-auto">
                  {library.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] font-semibold text-[var(--muted-foreground)]">
                      {libraryError ?? "loading…"}
                    </p>
                  ) : (
                    library.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => {
                          if (v.source === "local") {
                            const base = v.name.replace(/\.[^.]+$/, "");
                            setSelected({
                              videoId: `impulse__uploads__${base}`,
                              source: "local",
                            });
                          } else {
                            setSelected({ videoId: publicIdToVideoId(v.id), source: "cloudinary" });
                          }
                          setPickerOpen(false);
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-[var(--primary)]/8"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                            {v.name}
                          </p>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : null}
          </div>

          <div className="px-3 py-3">
            <div className="rounded-[14px] border border-dashed border-[var(--border)]/55 bg-white/10 px-3 py-3">
              <p className="text-[14px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                {uploadStatus === "uploaded"
                  ? "Processing pipeline started"
                  : uploadStatus === "error"
                    ? "Upload failed"
                    : "Upload a clip to build a splat + index it for search"}
              </p>
              <p className="mt-2 text-[13px] font-semibold text-[var(--muted-foreground)]">
                {uploadStatus === "error"
                  ? uploadError ?? "Try again or check the server logs."
                  : uploadStatus === "uploaded"
                    ? "Gaussian splat training and Sentry Search indexing are running. Watch the right column for progress."
                    : "Switch to Stream to wait for an iPhone sender instead."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </GlassSurface>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: "stream" | "upload";
  onChange: (m: "stream" | "upload") => void;
}) {
  return (
    <GlassSurface
      width="auto"
      height={34}
      borderRadius={10}
      saturation={1.12}
      backgroundOpacity={0.08}
      blur={4}
      className="alerts-glass alerts-glass-press"
    >
      <div className="flex h-full items-stretch">
        {(["stream", "upload"] as const).map((m) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              className={`px-3 text-[10px] font-bold uppercase tracking-[0.14em] transition ${
                active
                  ? "text-[var(--foreground)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              }`}
            >
              {m}
            </button>
          );
        })}
      </div>
    </GlassSurface>
  );
}

function Spinner({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

function LoadingBlock({
  title,
  subtitle,
  variant = "primary",
}: {
  title: string;
  subtitle?: string;
  variant?: "primary" | "muted";
}) {
  const accent =
    variant === "primary"
      ? "text-[var(--primary)]"
      : "text-[var(--muted-foreground)]";
  return (
    <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <div className={`flex items-center gap-2 ${accent}`}>
        <Spinner size={20} />
        <span className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
            style={{ animationDelay: "150ms" }}
          />
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-current"
            style={{ animationDelay: "300ms" }}
          />
        </span>
      </div>
      <p className="text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
        {title}
      </p>
      {subtitle ? (
        <p className="max-w-[320px] text-[12px] font-semibold text-[var(--muted-foreground)]">
          {subtitle}
        </p>
      ) : null}
    </div>
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

function EmptyCameraPreview({
  title,
  description,
  worldOpen,
  onToggleWorld,
  mode,
  onChangeMode,
}: {
  title: string;
  description: string;
  worldOpen: boolean;
  onToggleWorld: () => void;
  mode: "stream" | "upload";
  onChangeMode: (m: "stream" | "upload") => void;
}) {
  return (
    <GlassSurface
      width="100%"
      height="100%"
      borderRadius={16}
      saturation={1.18}
      backgroundOpacity={0.1}
      blur={4}
      className="alerts-glass flex min-h-[min(78vh,820px)] w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--border)]/70 px-3 py-2.5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
              live_camera_feed
            </p>
            <p className="mt-1 text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
              Sender pending
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ModeToggle mode={mode} onChange={onChangeMode} />
            <WorldButton active={worldOpen} onClick={onToggleWorld} />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="relative aspect-video overflow-hidden border-b border-[var(--border)]/70 bg-white/10">
            <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.04))]" />
            <div className="absolute inset-3 rounded-[14px] border border-dashed border-[var(--border)]/55 bg-white/10" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-[12px] border border-[var(--border)]/60 bg-white/32 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--foreground)]">
                Live iPhone camera feed
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
  "roomId": "live_camera_feed",
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
    </GlassSurface>
  );
}
