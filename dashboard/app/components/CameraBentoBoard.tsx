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

  const [roomOrder, setRoomOrder] = useState<string[]>(roomList);
  const [primaryRoom, setPrimaryRoom] = useState(roomList[0] ?? "main-camera");
  const [draggingRoom, setDraggingRoom] = useState<string | null>(null);
  const [dragOverRoom, setDragOverRoom] = useState<string | null>(null);
  const effectiveRoomOrder = useMemo(() => {
    const allowed = new Set(roomList);
    const kept = roomOrder.filter((roomId) => allowed.has(roomId));
    const missing = roomList.filter((roomId) => !kept.includes(roomId));
    return [...kept, ...missing];
  }, [roomList, roomOrder]);
  const activePrimaryRoom = effectiveRoomOrder.includes(primaryRoom)
    ? primaryRoom
    : (effectiveRoomOrder[0] ?? "main-camera");

  const handleDrop = (targetRoomId: string) => {
    if (!draggingRoom || draggingRoom === targetRoomId) {
      setDraggingRoom(null);
      setDragOverRoom(null);
      return;
    }

    setRoomOrder((current) => reorderList(current, draggingRoom, targetRoomId));
    setDraggingRoom(null);
    setDragOverRoom(null);
  };

  return (
    <div className="relative h-full w-full p-2">
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-[12px] border border-black/15 bg-white/38 p-1 backdrop-blur-md shadow-[0_1px_0_rgba(255,255,255,0.35)_inset]">
        <ModeButton label="Single" active={mode === "single"} onClick={() => setMode("single")} />
        <ModeButton label="Bento" active={mode === "bento"} onClick={() => setMode("bento")} />
      </div>

      {mode === "single" ? (
        <div className="relative h-full w-full overflow-hidden rounded-[14px] border border-[var(--border)]/70 bg-white/10">
          <CameraFrameViewer roomId={activePrimaryRoom} />
          <FeedBadge roomId={activePrimaryRoom} />
        </div>
      ) : (
        <div className="h-full w-full overflow-y-auto pr-1">
          <div className="flex flex-col gap-2">
          {effectiveRoomOrder.map((roomId, index) => {
            const isPrimary = roomId === activePrimaryRoom || (index === 0 && !effectiveRoomOrder.includes(activePrimaryRoom));

            return (
              <button
                key={roomId}
                onClick={() => setPrimaryRoom(roomId)}
                className={`relative aspect-video w-full shrink-0 overflow-hidden rounded-[14px] border border-[var(--border)]/70 bg-white/10 text-left transition-opacity ${
                  draggingRoom === roomId ? "opacity-60" : "opacity-100"
                } ${
                  dragOverRoom === roomId && draggingRoom !== roomId ? "brightness-125" : ""
                }`}
                title={`Focus ${roomId}`}
                type="button"
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData("text/plain", roomId);
                  event.dataTransfer.effectAllowed = "move";
                  setDraggingRoom(roomId);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDragOverRoom(roomId);
                }}
                onDragLeave={() => {
                  if (dragOverRoom === roomId) setDragOverRoom(null);
                }}
                onDrop={() => handleDrop(roomId)}
                onDragEnd={() => {
                  setDraggingRoom(null);
                  setDragOverRoom(null);
                }}
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

function reorderList(list: string[], activeId: string, targetId: string) {
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
      className={`rounded-[10px] border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider font-display transition-colors ${
        active
          ? "border-black/25 bg-white/82 text-black shadow-[0_1px_0_rgba(255,255,255,0.25)_inset]"
          : "border-black/12 bg-white/24 text-black/70 hover:bg-white/42 hover:text-black"
      }`}
      type="button"
    >
      {label}
    </button>
  );
}

function FeedBadge({ roomId, highlighted = false }: { roomId: string; highlighted?: boolean }) {
  return (
    <div className={`absolute left-2 top-2 z-20 rounded-[10px] border px-2 py-1 text-[10px] font-display uppercase tracking-widest backdrop-blur-md ${
      highlighted
        ? "border-black/18 bg-white/78 text-black/88"
        : "border-black/12 bg-white/50 text-black/65"
    }`}>
      {roomId}
    </div>
  );
}
