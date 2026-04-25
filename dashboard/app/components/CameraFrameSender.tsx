"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CameraFrameSenderProps = {
  roomId?: string;
  serverUrl?: string;
  fps?: number;
  jpegQuality?: number;
};

function getDefaultServerUrl() {
  if (typeof window === "undefined") return "ws://localhost:8787";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8787`;
}

export default function CameraFrameSender({
  roomId = "main-camera",
  serverUrl,
  fps = 10,
  jpegQuality = 0.7,
}: CameraFrameSenderProps) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("idle");
  const [framesSent, setFramesSent] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const isEncodingRef = useRef(false);
  const stoppingRef = useRef(false);

  const resolvedServerUrl = useMemo(
    () => serverUrl ?? process.env.NEXT_PUBLIC_FRAME_STREAM_WS_URL ?? getDefaultServerUrl(),
    [serverUrl],
  );

  const stopStreaming = useCallback(() => {
    stoppingRef.current = true;

    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setIsStreaming(false);
    setStatus("idle");
  }, []);

  const startStreaming = useCallback(async () => {
    try {
      stoppingRef.current = false;
      setError(null);
      setFramesSent(0);
      setStatus("requesting camera");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;

      if (!videoRef.current) throw new Error("Video preview not available.");
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      const ws = new WebSocket(resolvedServerUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "sender", roomId }));
        setStatus("live");
        setIsStreaming(true);
      };

      ws.onclose = () => {
        if (!stoppingRef.current) {
          setIsStreaming(false);
          setStatus("disconnected");
        }
      };

      ws.onerror = () => {
        setStatus("socket error");
      };

      const frameIntervalMs = Math.max(33, Math.floor(1000 / Math.max(1, fps)));
      timerRef.current = window.setInterval(() => {
        const socket = wsRef.current;
        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!socket || !video || !canvas || socket.readyState !== WebSocket.OPEN) return;
        if (video.videoWidth === 0 || video.videoHeight === 0 || isEncodingRef.current) return;

        isEncodingRef.current = true;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        const context = canvas.getContext("2d");
        if (!context) {
          isEncodingRef.current = false;
          return;
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          async (blob) => {
            if (!blob) {
              isEncodingRef.current = false;
              return;
            }
            const payload = await blob.arrayBuffer();
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(payload);
              setFramesSent((value) => value + 1);
            }
            isEncodingRef.current = false;
          },
          "image/jpeg",
          jpegQuality,
        );
      }, frameIntervalMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to start camera stream.";
      setError(message);
      stopStreaming();
    }
  }, [fps, jpegQuality, resolvedServerUrl, roomId, stopStreaming]);

  useEffect(() => {
    return () => {
      stopStreaming();
    };
  }, [stopStreaming]);

  return (
    <div className="h-full w-full flex flex-col gap-4">
      <div className="relative h-[360px] rounded-[14px] overflow-hidden bg-[var(--hero)] border border-[var(--border)]">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        {!isStreaming && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-sm text-[var(--muted-foreground)] font-mono uppercase tracking-widest">
              camera preview
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {!isStreaming ? (
          <button
            onClick={startStreaming}
            className="px-4 py-2 text-sm font-semibold rounded-[8px] bg-[var(--muted)] hover:bg-[var(--border)] transition-colors"
          >
            Start Frame Stream
          </button>
        ) : (
          <button
            onClick={stopStreaming}
            className="px-4 py-2 text-sm font-semibold rounded-[8px] bg-[oklch(0.78_0.09_15)]/20 text-[oklch(0.78_0.09_15)] hover:bg-[oklch(0.78_0.09_15)]/30 transition-colors"
          >
            Stop Stream
          </button>
        )}
      </div>

      <div className="rounded-[12px] bg-[var(--card)] border border-[var(--border)] p-3">
        <div className="text-xs text-[var(--muted-foreground)] font-mono">status: {status}</div>
        <div className="text-xs text-[var(--muted-foreground)] font-mono">server: {resolvedServerUrl}</div>
        <div className="text-xs text-[var(--muted-foreground)] font-mono">room: {roomId}</div>
        <div className="text-xs text-[var(--muted-foreground)] font-mono">fps: {fps}</div>
        <div className="text-xs text-[var(--muted-foreground)] font-mono">frames sent: {framesSent}</div>
        {error && <div className="text-xs text-[oklch(0.78_0.09_15)] mt-1">{error}</div>}
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
