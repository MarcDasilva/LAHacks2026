"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import CameraBentoBoard from "@/app/components/CameraBentoBoard";
import { PointCloudViewer } from "../../components/ui/PointCloudViewer";

const BRIDGE_URL =
  process.env.NEXT_PUBLIC_BRIDGE_URL ?? "https://6v8yblgimbpc77-8888.proxy.runpod.net";
const DEMO_SESSION = process.env.NEXT_PUBLIC_DEMO_SESSION ?? "church4";

export default function Dashboard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const shouldBoot = searchParams.get("boot") === "1";
  const [bootPhase, setBootPhase] = useState<"hidden" | "visible" | "fading">(
    shouldBoot ? "visible" : "hidden"
  );
  const [contentVisible, setContentVisible] = useState(!shouldBoot);
  const [clipOrder, setClipOrder] = useState<number[]>(() =>
    Array.from({ length: 6 }, (_, i) => i)
  );
  const [draggingClip, setDraggingClip] = useState<number | null>(null);
  const [dragOverClip, setDragOverClip] = useState<number | null>(null);

  const handleClipDrop = (targetClip: number) => {
    if (draggingClip === null || draggingClip === targetClip) {
      setDraggingClip(null);
      setDragOverClip(null);
      return;
    }

    setClipOrder((current) => reorderNumberList(current, draggingClip, targetClip));
    setDraggingClip(null);
    setDragOverClip(null);
  };

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
        <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-[var(--lavender)]/[0.08] blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.06] blur-[80px]" />
      </div>
      {/* Dot grid */}
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <main
        className={`relative z-10 h-full w-full p-3 flex items-start justify-center overflow-hidden transition-opacity duration-500 ${
          contentVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        <div className="w-full h-full grid grid-cols-[1fr_2fr] gap-2">

          {/* ── Left: live body cam feed ── */}
          <Panel className="row-span-full flex flex-col min-h-0">
            <div className="flex-1 overflow-hidden relative min-h-0">
              <CameraBentoBoard />
            </div>
          </Panel>

          {/* ── Right column ── */}
          <div className="grid grid-rows-[1fr_auto_180px] gap-2 h-full min-h-0">

            {/* Top: 3D splatting render */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex-1 overflow-hidden relative min-h-0">
                <RenderPanel />
              </div>
            </Panel>

            {/* Middle: query input */}
            <Panel className="flex flex-col gap-2 p-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Describe what you're looking for..."
                  className="flex-1 bg-[var(--muted)] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-all"
                />
                <button className="mac-btn mac-btn-primary px-5 py-2 text-[var(--foreground)] text-sm font-semibold">
                  Query
                </button>
              </div>
            </Panel>

            {/* Bottom: video chunks */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex gap-2 overflow-x-auto flex-1 min-h-0 p-3">
                {clipOrder.map((clipIndex) => (
                  <VideoChunk
                    key={clipIndex}
                    index={clipIndex}
                    draggable
                    isDragging={draggingClip === clipIndex}
                    isDragOver={dragOverClip === clipIndex && draggingClip !== clipIndex}
                    onDragStart={() => setDraggingClip(clipIndex)}
                    onDragOver={() => setDragOverClip(clipIndex)}
                    onDragLeave={() => {
                      if (dragOverClip === clipIndex) setDragOverClip(null);
                    }}
                    onDrop={() => handleClipDrop(clipIndex)}
                    onDragEnd={() => {
                      setDraggingClip(null);
                      setDragOverClip(null);
                    }}
                  />
                ))}
              </div>
            </Panel>

          </div>
        </div>
      </main>
    </div>
  );
}

/* ── Primitives ── */

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[var(--card)] overflow-hidden shadow-[0_4px_24px_-4px_rgba(0,0,0,0.3)] ${className}`}>
      {children}
    </div>
  );
}

function RenderPanel() {
  return <PointCloudViewer bridgeUrl={BRIDGE_URL} sessionId={DEMO_SESSION} />;
}

type VideoChunkProps = {
  index: number;
  draggable?: boolean;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: () => void;
  onDragOver?: () => void;
  onDragLeave?: () => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
};

function VideoChunk({
  index,
  draggable = false,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}: VideoChunkProps) {
  return (
    <div
      className={`shrink-0 w-36 h-full bg-[var(--hero)] flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:brightness-110 transition-all ${
        isDragging ? "opacity-60" : "opacity-100"
      } ${isDragOver ? "brightness-125" : ""}`}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
        onDragStart?.();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragOver?.();
      }}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        event.preventDefault();
        onDrop?.();
      }}
      onDragEnd={onDragEnd}
    >
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-[var(--muted-foreground)]">
        <polygon points="5,3 19,12 5,21" fill="currentColor" />
      </svg>
      <span className="text-[9px] text-[var(--muted-foreground)] font-display">
        clip_{String(index + 1).padStart(2, "0")}
      </span>
    </div>
  );
}

function reorderNumberList(list: number[], activeId: number, targetId: number) {
  const fromIndex = list.indexOf(activeId);
  const toIndex = list.indexOf(targetId);

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return list;
  }

  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
