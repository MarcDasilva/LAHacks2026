"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CameraFrameSenderProps = {
  roomId?: string;
  serverUrl?: string;
  maxWidth?: number;
  maxHeight?: number;
  maxFps?: number;
};

type SignalPayload = {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

function getDefaultServerUrl() {
  if (typeof window === "undefined") return "ws://localhost:8787";
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.hostname}:8787`;
}

function createPeerConnection() {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });
}

export default function CameraFrameSender({
  roomId = "main-camera",
  serverUrl,
  maxWidth = 1280,
  maxHeight = 720,
  maxFps = 24,
}: CameraFrameSenderProps) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("idle");
  const [viewerCount, setViewerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const stoppingRef = useRef(false);

  const resolvedServerUrl = useMemo(
    () => serverUrl ?? process.env.NEXT_PUBLIC_FRAME_STREAM_WS_URL ?? getDefaultServerUrl(),
    [serverUrl],
  );

  const removeViewerPeer = useCallback((viewerId: string) => {
    const pc = peerConnectionsRef.current.get(viewerId);
    if (pc) {
      pc.close();
      peerConnectionsRef.current.delete(viewerId);
      pendingIceCandidatesRef.current.delete(viewerId);
      setViewerCount(peerConnectionsRef.current.size);
    }
  }, []);

  const sendSignal = useCallback((targetId: string, data: SignalPayload) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "signal", targetId, data }));
  }, []);

  const setupPeerForViewer = useCallback(async (viewerId: string) => {
    if (!streamRef.current) return;
    if (peerConnectionsRef.current.has(viewerId)) return;

    const pc = createPeerConnection();
    peerConnectionsRef.current.set(viewerId, pc);
    setViewerCount(peerConnectionsRef.current.size);

    for (const track of streamRef.current.getTracks()) {
      pc.addTrack(track, streamRef.current);
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(viewerId, { candidate: event.candidate.toJSON() });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed" || state === "closed" || state === "disconnected") {
        removeViewerPeer(viewerId);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(viewerId, { description: offer });
  }, [removeViewerPeer, sendSignal]);

  const stopStreaming = useCallback(() => {
    stoppingRef.current = true;

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    for (const pc of peerConnectionsRef.current.values()) {
      pc.close();
    }
    peerConnectionsRef.current.clear();
    pendingIceCandidatesRef.current.clear();
    setViewerCount(0);

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
      setStatus("requesting camera");

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: maxWidth },
          height: { ideal: maxHeight },
          frameRate: { ideal: maxFps },
        },
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

      ws.onmessage = async (event) => {
        if (typeof event.data !== "string") return;

        let payload: {
          type?: string;
          viewerId?: string;
          fromId?: string;
          data?: SignalPayload;
        };
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type === "viewer-joined" && payload.viewerId) {
          await setupPeerForViewer(payload.viewerId);
          return;
        }

        if (payload.type === "viewer-left" && payload.viewerId) {
          removeViewerPeer(payload.viewerId);
          return;
        }

        if (payload.type === "signal" && payload.fromId && payload.data) {
          const pc = peerConnectionsRef.current.get(payload.fromId);
          if (!pc) return;

          if (payload.data.description) {
            await pc.setRemoteDescription(payload.data.description);
            const queued = pendingIceCandidatesRef.current.get(payload.fromId);
            if (queued && queued.length > 0) {
              for (const candidate of queued) {
                try {
                  await pc.addIceCandidate(candidate);
                } catch {
                  // Ignore stale ICE candidates after reconnect.
                }
              }
              pendingIceCandidatesRef.current.delete(payload.fromId);
            }
          }

          if (payload.data.candidate) {
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(payload.data.candidate);
              } catch {
                // Ignore stale ICE candidates after disconnect.
              }
            } else {
              const queue = pendingIceCandidatesRef.current.get(payload.fromId) ?? [];
              queue.push(payload.data.candidate);
              pendingIceCandidatesRef.current.set(payload.fromId, queue);
            }
          }
        }
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to start camera stream.";
      setError(message);
      stopStreaming();
    }
  }, [maxFps, maxHeight, maxWidth, resolvedServerUrl, roomId, setupPeerForViewer, removeViewerPeer, stopStreaming]);

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
            Start WebRTC Stream
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
        <div className="text-xs text-[var(--muted-foreground)] font-mono">max capture: {maxWidth}x{maxHeight}@{maxFps}</div>
        <div className="text-xs text-[var(--muted-foreground)] font-mono">connected viewers: {viewerCount}</div>
        {error && <div className="text-xs text-[oklch(0.78_0.09_15)] mt-1">{error}</div>}
      </div>
    </div>
  );
}
