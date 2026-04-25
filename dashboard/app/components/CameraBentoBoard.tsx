"use client";

import { useMemo, useState } from "react";
import CameraFrameViewer from "@/app/components/CameraFrameViewer";

const DEFAULT_ROOMS = ["main-camera", "cam-02", "cam-03", "cam-04"];

type CameraBentoBoardProps = {
  rooms?: string[];
};

export default function CameraBentoBoard({ rooms }: CameraBentoBoardProps) {
  const [mode, setMode] = useState<"single" | "bento">("single");

  const roomList = useMemo(() => {
    if (rooms && rooms.length > 0) return dedupeRooms(rooms);
    const envRooms = process.env.NEXT_PUBLIC_CAMERA_FEED_ROOMS;
    if (!envRooms) return DEFAULT_ROOMS;
    const parsed = dedupeRooms(envRooms.split(",").map((value) => value.trim()));
    return parsed.length > 0 ? parsed : DEFAULT_ROOMS;
  }, [rooms]);

  const [primaryRoom, setPrimaryRoom] = useState(roomList[0] ?? "main-camera");

  return (
    <div className="relative h-full w-full p-2">
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-[10px] bg-black/45 p-1 backdrop-blur-sm">
        <ModeButton label="Single" active={mode === "single"} onClick={() => setMode("single")} />
        <ModeButton label="Bento" active={mode === "bento"} onClick={() => setMode("bento")} />
      </div>

      {mode === "single" ? (
        <div className="h-full w-full rounded-[12px] overflow-hidden border border-[var(--border)]/80 relative">
          <CameraFrameViewer roomId={primaryRoom} />
          <FeedBadge roomId={primaryRoom} />
        </div>
      ) : (
        <div className="h-full w-full overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
          {roomList.map((roomId, index) => {
            const isPrimary = roomId === primaryRoom || (index === 0 && !roomList.includes(primaryRoom));

            return (
              <button
                key={roomId}
                onClick={() => setPrimaryRoom(roomId)}
                className="relative w-full overflow-hidden rounded-[12px] border border-[var(--border)]/80 text-left aspect-video shrink-0"
                title={`Focus ${roomId}`}
                type="button"
              >
                <CameraFrameViewer roomId={roomId} />
                <FeedBadge roomId={roomId} highlighted={isPrimary} />
              </button>
            );
          })}
          </div>
        </div>
      )}
    </div>
  );
}

function dedupeRooms(values: string[]) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

function ModeButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-[8px] px-2.5 py-1 text-[10px] uppercase tracking-wider font-semibold font-mono transition-colors ${
        active
          ? "bg-[oklch(0.82_0.09_160)]/30 text-white"
          : "bg-transparent text-white/70 hover:text-white hover:bg-white/10"
      }`}
      type="button"
    >
      {label}
    </button>
  );
}

function FeedBadge({ roomId, highlighted = false }: { roomId: string; highlighted?: boolean }) {
  return (
    <div className={`absolute left-2 top-2 z-20 rounded-[8px] px-2 py-1 text-[10px] font-mono uppercase tracking-widest backdrop-blur-sm ${
      highlighted ? "bg-[oklch(0.82_0.09_160)]/35 text-white" : "bg-black/45 text-white/90"
    }`}>
      {roomId}
    </div>
  );
}
