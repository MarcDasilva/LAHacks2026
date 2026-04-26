"use client";

import { useState } from "react";
import CameraBentoBoard from "@/app/components/CameraBentoBoard";
import { PointCloudViewer } from "../../components/ui/PointCloudViewer";
import { ViserEmbed } from "../../components/ui/ViserEmbed";
import { UploadButton } from "../../components/ui/UploadButton";
import { SessionSwitcher } from "../../components/ui/SessionSwitcher";

const BRIDGE_URL = process.env.NEXT_PUBLIC_BRIDGE_URL ?? "/bridge";
const VISER_URL = process.env.NEXT_PUBLIC_VISER_URL ?? "";
const USE_VISER = process.env.NEXT_PUBLIC_USE_VISER === "1" && VISER_URL !== "";

type Mode = "stream" | "church" | "oxford";

const MODES: Array<{ id: Mode; label: string; videoSrc?: string }> = [
  { id: "stream", label: "Stream" },
  { id: "church", label: "Church", videoSrc: "/demos/church.mp4" },
  { id: "oxford", label: "Oxford", videoSrc: "/demos/oxford.mp4" },
];

export default function Dashboard() {
  const [mode, setMode] = useState<Mode>("stream");
  const [streamSessionId, setStreamSessionId] = useState<string>("");

  const sessionId = mode === "stream" ? streamSessionId : mode;
  const videoSrc = MODES.find(m => m.id === mode)?.videoSrc;

  const handleStreamSessionChange = (sid: string) => {
    setMode("stream");
    setStreamSessionId(sid);
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Gradient mesh */}
      <div className="pointer-events-none absolute inset-0 z-0">
        <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-[var(--lavender)]/[0.08] blur-[100px]" />
        <div className="absolute bottom-0 right-0 w-[400px] h-[400px] rounded-full bg-[oklch(0.65_0.20_350)]/[0.06] blur-[80px]" />
      </div>
      {/* Dot grid */}
      <div className="pointer-events-none absolute inset-0 z-0 dot-grid" />

      <main className="relative z-10 h-full w-full p-3 flex items-start justify-center overflow-hidden">
        <div className="w-full h-full grid grid-cols-[1fr_2fr] gap-2">

          {/* ── Left: live body cam feed OR demo video ── */}
          <Panel className="row-span-full flex flex-col min-h-0">
            <div className="flex-1 overflow-hidden relative min-h-0 rounded-[14px]">
              {mode === "stream" ? (
                <CameraBentoBoard />
              ) : (
                <DemoVideo key={mode} src={videoSrc!} label={mode} />
              )}
            </div>
          </Panel>

          {/* ── Right column ── */}
          <div className="grid grid-rows-[1fr_auto_180px] gap-2 h-full min-h-0">

            {/* Top: 3D splatting render */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex-1 overflow-hidden relative min-h-0 rounded-[14px]">
                <RenderPanel
                  mode={mode}
                  setMode={setMode}
                  sessionId={sessionId}
                  onStreamSessionChange={handleStreamSessionChange}
                />
              </div>
            </Panel>

            {/* Middle: query input */}
            <Panel className="flex flex-col gap-2 p-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Describe what you're looking for..."
                  className="flex-1 bg-[var(--muted)] rounded-[8px] px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--ring)] transition-all"
                />
                <button className="px-5 py-2 bg-[var(--muted)] text-[var(--foreground)] text-sm font-semibold rounded-[8px] hover:bg-[var(--border)] transition-colors">
                  Query
                </button>
              </div>
            </Panel>

            {/* Bottom: video chunks */}
            <Panel className="flex flex-col min-h-0">
              <div className="flex gap-2 overflow-x-auto flex-1 min-h-0 p-3">
                {[...Array(6)].map((_, i) => (
                  <VideoChunk key={i} index={i} />
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
    <div className={`bg-[var(--card)] rounded-[16px] overflow-hidden shadow-[0_4px_24px_-4px_rgba(0,0,0,0.3)] ${className}`}>
      {children}
    </div>
  );
}

function RenderPanel({
  mode,
  setMode,
  sessionId,
  onStreamSessionChange,
}: {
  mode: Mode;
  setMode: (m: Mode) => void;
  sessionId: string;
  onStreamSessionChange: (sid: string) => void;
}) {
  const hasSession = sessionId.length > 0;
  return (
    <div className="relative h-full w-full">
      {hasSession ? (
        USE_VISER ? (
          // viser stays mounted across session switches — the scene swap
          // is server-side via /sessions/{id}/replay (clears every other
          // session, then pushes this one). Avoids WS flicker.
          <ViserEmbed
            viserUrl={VISER_URL}
            sessionId={sessionId}
            bridgeUrl={BRIDGE_URL}
          />
        ) : (
          <PointCloudViewer
            key={sessionId}
            bridgeUrl={BRIDGE_URL}
            sessionId={sessionId}
            conf={2.0}
            downsample={5}
          />
        )
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted-foreground)] font-mono">
          waiting for stream — upload a clip or pick a session
        </div>
      )}
      <div className="absolute top-3 left-3 z-10 flex items-center gap-2">
        <div className="flex gap-1 bg-[var(--muted)] rounded-[8px] p-1">
          {MODES.map(m => {
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`px-3 py-1 text-xs font-mono rounded-[6px] transition-colors ${
                  active
                    ? "bg-[var(--foreground)] text-[var(--background)]"
                    : "text-[var(--foreground)] hover:bg-[var(--border)]"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
        <UploadButton bridgeUrl={BRIDGE_URL} onReady={onStreamSessionChange} />
        <SessionSwitcher
          bridgeUrl={BRIDGE_URL}
          current={sessionId}
          onSelect={onStreamSessionChange}
        />
      </div>
    </div>
  );
}

function DemoVideo({ src, label }: { src: string; label: string }) {
  return (
    <div className="relative h-full w-full bg-black">
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={src}
        autoPlay
        loop
        muted
        controls
        playsInline
      />
      <div className="absolute left-3 top-3 z-10 rounded-[8px] bg-black/45 px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-white/90 backdrop-blur-sm">
        {label}
      </div>
    </div>
  );
}

function VideoChunk({ index }: { index: number }) {
  return (
    <div className="shrink-0 w-36 h-full bg-[var(--hero)] rounded-[12px] flex flex-col items-center justify-center gap-1.5 cursor-pointer hover:brightness-110 transition-all">
      <svg viewBox="0 0 24 24" fill="none" className="w-4 h-4 text-[var(--muted-foreground)]">
        <polygon points="5,3 19,12 5,21" fill="currentColor" />
      </svg>
      <span className="text-[9px] text-[var(--muted-foreground)] font-mono">
        clip_{String(index + 1).padStart(2, "0")}
      </span>
    </div>
  );
}
