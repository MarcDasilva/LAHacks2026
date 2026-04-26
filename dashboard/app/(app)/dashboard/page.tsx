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
};

type SplatManifest = {
  version: number;
  videos: Record<string, SplatRecord>;
};

type SelectedVideo = {
  videoId: string;
  source: "cloudinary" | "user" | "local" | "stream";
};

type SelectedVideoCtx = {
  selected: SelectedVideo | null;
  setSelected: (v: SelectedVideo | null) => void;
  manifest: SplatManifest | null;
  refreshManifest: () => Promise<void>;
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
  const [selected, setSelected] = useState<SelectedVideo | null>({
    videoId: DEFAULT_VIDEO_ID,
    source: "local",
  });

  const refreshManifest = useCallback(async () => {
    // /api/splat-poll drains any finished Modal jobs (writing scene.splat to
    // disk + updating the manifest) and returns the manifest in the same
    // request, so polling does both at once.
    try {
      const res = await fetch("/api/splat-poll", { cache: "no-store" });
      if (!res.ok) throw new Error(`splat-poll ${res.status}`);
      const payload = (await res.json()) as SplatManifest;
      setManifest(payload);
    } catch {
      // Fallback to the static manifest if the poll route isn't available
      // (e.g., MODAL_SPLAT_URL not configured yet).
      try {
        const res = await fetch("/clouds/splats/manifest.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`manifest ${res.status}`);
        const payload = (await res.json()) as SplatManifest;
        setManifest(payload);
      } catch {
        setManifest({ version: 1, videos: {} });
      }
    }
  }, []);

  useEffect(() => {
    refreshManifest();
  }, [refreshManifest]);

  // While any splat in the manifest is still processing, poll periodically
  // so the UI flips from 'processing…' → 'ready' without a manual reload.
  useEffect(() => {
    if (!manifest) return;
    const anyProcessing = Object.values(manifest.videos).some(
      (v) =>
        v.status === "processing" ||
        v.splatStatus === "pending" ||
        v.splatStatus === "training"
    );
    if (!anyProcessing) return;
    const id = window.setInterval(refreshManifest, 4000);
    return () => window.clearInterval(id);
  }, [manifest, refreshManifest]);

  const selectionCtx = useMemo<SelectedVideoCtx>(
    () => ({ selected, setSelected, manifest, refreshManifest }),
    [selected, manifest, refreshManifest]
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
              <div className="flex min-h-full flex-col gap-3 lg:flex-row">
                <div className="flex min-w-0 flex-col gap-3 lg:w-1/2 lg:flex-1">
                  {activeRooms.length > 0 ? (
                    selectedRoom ? <SelectedCameraPanel room={selectedRoom} /> : null
                  ) : (
                    <EmptyCameraPreview />
                  )}

                  {previewRooms.length > 0 ? (
                    <div className="flex min-h-0 w-full shrink-0 gap-3 overflow-x-auto lg:overflow-y-auto lg:overflow-x-hidden">
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

                <div className="flex min-w-0 flex-col gap-3 lg:w-1/2 lg:flex-1">
                  <SparseSplatPanel />
                  <VideoSearchPanel />
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

function SelectedCameraPanel({ room }: { room: RoomSummary }) {
  const yoloPayload = room.modelOutputs?.yolo ?? null;
  const yamnetPayload = room.modelOutputs?.yamnet ?? null;
  const sttPayload = room.modelOutputs?.stt ?? null;

  return (
    <div className="flex min-h-[min(78vh,820px)] w-full min-w-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-[var(--foreground)]/28 bg-white/22 shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_18px_48px_rgba(15,15,15,0.08)] transition-[width,transform,box-shadow] duration-300 ease-out">
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

type CloudinaryFootage = {
  id: string;
  name: string;
  url: string;
  bytes: number;
  durationSec: number | null;
  createdAt: string | null;
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

  // Resolve the default feed: prefer the local mp4, fall back to cloudinary
  // pointer JSON. User picks below override this. The default video also
  // becomes the initial SelectedVideoContext target so the splat panel
  // shows its sparse cloud out of the box.
  useEffect(() => {
    let cancelled = false;
    const localUrl = "/clouds/video.mp4";
    (async () => {
      try {
        const head = await fetch(localUrl, { method: "HEAD", cache: "no-store" });
        if (!cancelled && head.ok) {
          setFeed({ kind: "local", src: localUrl });
          return;
        }
      } catch {
        /* fall through */
      }
      try {
        const res = await fetch("/clouds/video.url.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`pointer ${res.status}`);
        const payload = (await res.json()) as { url?: string };
        if (!cancelled && payload?.url) {
          setFeed({ kind: "cloudinary", src: payload.url, label: "video.url.json" });
        }
      } catch {
        /* leave feed null — placeholder shown */
      }
    })();
    return () => {
      cancelled = true;
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
                Cloudinary library
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
                      setFeed({ kind: "cloudinary", src: v.url, label: v.name });
                      setSelected({ videoId: publicIdToVideoId(v.id), source: "cloudinary" });
                      setPickerOpen(false);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-[var(--primary)]/8"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                        {v.name}
                      </p>
                      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                        {(v.bytes / 1_048_576).toFixed(1)} MB
                        {v.durationSec ? ` · ${v.durationSec.toFixed(1)}s` : ""}
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

function SparseSplatPanel() {
  const { selected, manifest } = useSelectedVideo();
  const record = selected ? manifest?.videos[selected.videoId] ?? null : null;
  const status: SplatStatus | "unknown" = record?.status ?? (manifest ? "unknown" : "processing");

  const lbmpUrl = record?.lbmpPath ?? null;
  const pathUrl = record?.pathPath ?? null;
  // Prefer the Modal-trained Gaussian splat once it's ready. While it's
  // training we show a loading state (no sparse preview, per design choice).
  const splatUrl = record?.splatStatus === "ready" ? record.splatPath ?? null : null;
  const splatStatus = record?.splatStatus;

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

  return (
    <div className="flex min-h-[min(60vh,640px)] min-w-0 flex-1 flex-col overflow-hidden rounded-[16px] border border-[var(--primary)] bg-white/22 shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_18px_48px_rgba(15,15,15,0.08)] transition-[width,transform,box-shadow] duration-300 ease-out">
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

      <div className="bg-black/8 p-3 transition-[padding] duration-300">
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
            <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))]">
              <div className="rounded-[12px] border border-[var(--primary)]/45 bg-black/45 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/85">
                Training Gaussian splat… (~5–10 min)
              </div>
            </div>
          ) : lbmpUrl && status === "ready" ? (
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

      <div className="border-t border-[var(--primary)]/70 px-3 py-2.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
          <span>colmap · sparse · path</span>
          <span className="text-[var(--muted-foreground)]/55">/</span>
          <span className="truncate">
            {record?.points ? `${record.points.toLocaleString()} pts` : statusLabel}
          </span>
        </div>
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

function VideoSearchPanel() {
  const { selected, manifest } = useSelectedVideo();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "error" | "empty">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [active, setActive] = useState<SearchResult | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Wipe results when the selected video changes — they were ranked
  // against the previous video's segments, not the new one.
  useEffect(() => {
    setResults([]);
    setActive(null);
    setStatus("idle");
    setErrorMsg(null);
  }, [selected?.videoId]);

  const selectedLabel = selected
    ? manifest?.videos[selected.videoId]?.label ?? selected.videoId
    : null;

  const submit = async () => {
    const q = query.trim();
    if (!q) return;
    if (!selected?.videoId) {
      setStatus("error");
      setErrorMsg("pick a video first");
      return;
    }
    setStatus("searching");
    setErrorMsg(null);
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
        setStatus("error");
        setErrorMsg(payload.error);
        setResults([]);
        return;
      }
      setResults(payload.results ?? []);
      setActive((payload.results ?? [])[0] ?? null);
      setStatus((payload.results ?? []).length === 0 ? "empty" : "idle");
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "request failed");
    }
  };

  // Loop the active clip's segment via media-fragment seek-back.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !active) return;
    const onTime = () => {
      if (v.currentTime >= active.endSec - 0.05) {
        v.currentTime = active.startSec;
        v.play().catch(() => {});
      }
    };
    v.currentTime = active.startSec;
    v.play().catch(() => {});
    v.addEventListener("timeupdate", onTime);
    return () => v.removeEventListener("timeupdate", onTime);
  }, [active]);

  return (
    <div className="min-w-0 overflow-hidden rounded-[16px] border border-[var(--primary)] bg-white/22 shadow-[0_1px_0_rgba(255,255,255,0.22)_inset,0_18px_48px_rgba(15,15,15,0.08)]">
      <div className="flex items-center justify-between border-b border-[var(--primary)]/70 px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
            video_search
          </p>
          <p className="mt-1 truncate text-[13px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
            {selectedLabel ? `Search · ${selectedLabel}` : "Natural-language clip retrieval"}
          </p>
        </div>
        <span className="rounded-[9px] border border-[var(--primary)]/60 bg-white/20 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--foreground)]">
          GEMMA
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-[var(--primary)]/40 px-3 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="e.g. someone walking through a doorway"
          className="min-w-0 flex-1 rounded-[10px] border border-[var(--primary)]/55 bg-white/85 px-3 py-1.5 text-[12px] font-semibold tracking-[-0.01em] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]/70 focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/35"
        />
        <button
          type="button"
          onClick={submit}
          disabled={status === "searching"}
          className="rounded-[10px] border border-[var(--primary)]/70 bg-[var(--primary)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] font-display text-[var(--primary-foreground)] shadow-[0_1px_0_rgba(255,255,255,0.18)_inset] transition hover:opacity-90 disabled:opacity-50"
        >
          {status === "searching" ? "Searching…" : "Search"}
        </button>
      </div>

      {active ? (
        <div className="bg-black/8 p-3">
          <div className="relative aspect-video overflow-hidden rounded-[14px] border border-[var(--primary)]/55 bg-black">
            <video
              key={`${active.videoId}-${active.startSec}`}
              ref={videoRef}
              src={`${active.videoUrl}#t=${active.startSec},${active.endSec}`}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute left-3 top-3 z-10">
              <span className="rounded-[9px] border border-[var(--primary)]/60 bg-black/55 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white">
                {active.startSec.toFixed(1)}s – {active.endSec.toFixed(1)}s
              </span>
            </div>
          </div>
          <p className="mt-2 line-clamp-2 text-[12px] font-semibold tracking-[-0.01em] text-[var(--foreground)]">
            {active.caption}
          </p>
        </div>
      ) : null}

      <div className="max-h-[260px] overflow-y-auto">
        {status === "error" ? (
          <p className="px-3 py-3 text-[12px] font-semibold text-[oklch(0.55_0.18_25)]">
            {errorMsg ?? "search failed"}
          </p>
        ) : status === "empty" ? (
          <p className="px-3 py-3 text-[12px] font-semibold text-[var(--muted-foreground)]">
            no matching clips. try a different query or run the indexer.
          </p>
        ) : results.length === 0 ? (
          <p className="px-3 py-3 text-[12px] font-semibold text-[var(--muted-foreground)]">
            describe a moment in <span className="font-mono">{selectedLabel ?? "the selected video"}</span> to find it.
          </p>
        ) : (
          results.map((r, i) => {
            const selected = active && active.videoId === r.videoId && active.startSec === r.startSec;
            return (
              <button
                key={`${r.videoId}-${r.startSec}-${i}`}
                type="button"
                onClick={() => setActive(r)}
                className={`flex w-full items-start justify-between gap-3 border-b border-[var(--primary)]/15 px-3 py-2 text-left transition ${
                  selected ? "bg-[var(--primary)]/8" : "hover:bg-[var(--primary)]/6"
                }`}
              >
                <div className="min-w-0">
                  <p className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-[var(--muted-foreground)]">
                    {r.videoId.split("/").pop()} · {r.startSec.toFixed(1)}s
                  </p>
                  <p className="mt-1 line-clamp-2 text-[12px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                    {r.caption}
                  </p>
                </div>
                <span className="shrink-0 rounded-[8px] border border-[var(--primary)]/55 bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-[-0.01em] text-[var(--foreground)]">
                  {(r.score * 100).toFixed(0)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
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

function EmptyCameraPreview() {
  return (
    <div className="flex min-h-[min(78vh,820px)] w-full flex-1 pt-2">
      <div className="flex w-full flex-1 flex-col overflow-hidden rounded-[16px] border border-[var(--border)]/70 bg-white/14 shadow-[0_1px_0_rgba(255,255,255,0.2)_inset]">
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

        <LandscapeCameraFeed />
      </div>
    </div>
  );
}
