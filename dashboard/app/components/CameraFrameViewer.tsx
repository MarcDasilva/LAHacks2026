"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type CameraFrameViewerProps = {
  roomId?: string;
  serverUrl?: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected";

function getDefaultServerUrl() {
  if (typeof window === "undefined") return "ws://localhost:8787";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8787`;
}

export default function CameraFrameViewer({
  roomId = "main-camera",
  serverUrl,
}: CameraFrameViewerProps) {
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [lastFrameAt, setLastFrameAt] = useState<Date | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [senderOnline, setSenderOnline] = useState(false);
  const previousFrameUrlRef = useRef<string | null>(null);

  const resolvedServerUrl = useMemo(
    () => serverUrl ?? process.env.NEXT_PUBLIC_FRAME_STREAM_WS_URL ?? getDefaultServerUrl(),
    [serverUrl],
  );

  useEffect(() => {
    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = () => {
      if (cancelled) return;

      setConnectionState("connecting");
      ws = new WebSocket(resolvedServerUrl);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "join", role: "viewer", roomId }));
        setConnectionState("connected");
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const payload = JSON.parse(event.data) as { type?: string; senderOnline?: boolean };
            if (payload.type === "stream-state" && typeof payload.senderOnline === "boolean") {
              setSenderOnline(payload.senderOnline);
            }
          } catch {
            // Ignore non-JSON control messages.
          }
          return;
        }

        const blob = new Blob([event.data], { type: "image/jpeg" });
        const nextUrl = URL.createObjectURL(blob);
        setFrameUrl(nextUrl);
        setLastFrameAt(new Date());
      };

      ws.onclose = () => {
        setConnectionState("disconnected");
        setSenderOnline(false);
        if (!cancelled) {
          window.setTimeout(connect, 1000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [resolvedServerUrl, roomId]);

  useEffect(() => {
    const previous = previousFrameUrlRef.current;
    if (previous && previous !== frameUrl) {
      URL.revokeObjectURL(previous);
    }
    previousFrameUrlRef.current = frameUrl;
  }, [frameUrl]);

  useEffect(() => {
    return () => {
      if (previousFrameUrlRef.current) {
        URL.revokeObjectURL(previousFrameUrlRef.current);
      }
    };
  }, []);

  const statusLabel = connectionState === "connecting"
    ? "connecting"
    : senderOnline
      ? "live"
      : "waiting";

  return (
    <div className="absolute inset-0 bg-[var(--hero)]">
      {frameUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frameUrl} alt="Live camera stream" className="h-full w-full object-cover" />
      ) : (
        <div className="h-full w-full flex items-center justify-center">
          <span className="text-xs text-[var(--muted-foreground)] font-mono uppercase tracking-widest">
            no frame stream yet
          </span>
        </div>
      )}

      <div className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-[8px] bg-black/40 px-2 py-1 backdrop-blur-sm">
        <span className={`h-1.5 w-1.5 rounded-full ${senderOnline ? "bg-[oklch(0.82_0.09_160)]" : "bg-[oklch(0.78_0.09_15)]"} ${senderOnline ? "animate-pulse" : ""}`} />
        <span className="text-[10px] text-white font-mono uppercase tracking-widest">{statusLabel}</span>
      </div>

      <div className="absolute left-3 bottom-3 rounded-[8px] bg-black/40 px-2 py-1 backdrop-blur-sm">
        <span className="text-[10px] text-white/90 font-mono">
          {lastFrameAt ? `last frame ${lastFrameAt.toLocaleTimeString()}` : `room ${roomId}`}
        </span>
      </div>
    </div>
  );
}
