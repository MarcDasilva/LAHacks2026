"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type CameraFrameViewerProps = {
  roomId?: string;
  serverUrl?: string;
};

type ConnectionState = "connecting" | "connected" | "disconnected";

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

export default function CameraFrameViewer({
  roomId = "main-camera",
  serverUrl,
}: CameraFrameViewerProps) {
  const [displayMode, setDisplayMode] = useState<"none" | "webrtc" | "jpeg">("none");
  const [lastFrameAtLabel, setLastFrameAtLabel] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [senderOnline, setSenderOnline] = useState(false);
  const hasStreamRef = useRef(false);
  const displayModeRef = useRef<"none" | "webrtc" | "jpeg">("none");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const senderIdRef = useRef<string | null>(null);
  const activePeerSenderIdRef = useRef<string | null>(null);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const previousFrameUrlRef = useRef<string | null>(null);
  const latestFrameTimestampRef = useRef<number | null>(null);

  const resolvedServerUrl = useMemo(
    () => serverUrl ?? process.env.NEXT_PUBLIC_FRAME_STREAM_WS_URL ?? getDefaultServerUrl(),
    [serverUrl],
  );

  useEffect(() => {
    let cancelled = false;

    const sendSignal = (targetId: string, data: SignalPayload) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "signal", targetId, data }));
    };

    const resetPeerConnection = () => {
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      activePeerSenderIdRef.current = null;
      pendingIceCandidatesRef.current = [];
      remoteStreamRef.current = null;
      setDisplayMode("none");
      displayModeRef.current = "none";
      hasStreamRef.current = false;
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (imageRef.current) {
        imageRef.current.src = "";
      }
    };

    const ensurePeer = (senderId: string) => {
      if (activePeerSenderIdRef.current && activePeerSenderIdRef.current !== senderId) {
        resetPeerConnection();
      }

      const existing = pcRef.current;
      if (existing) return existing;

      const pc = createPeerConnection();
      pcRef.current = pc;
      activePeerSenderIdRef.current = senderId;

      pc.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendSignal(senderId, { candidate: event.candidate.toJSON() });
      };

      pc.ontrack = (event) => {
        if (!videoRef.current) return;
        const stream = event.streams[0] ?? (() => {
          if (!remoteStreamRef.current) remoteStreamRef.current = new MediaStream();
          remoteStreamRef.current.addTrack(event.track);
          return remoteStreamRef.current;
        })();
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {
          // Autoplay can fail in some browser policies; keep stream attached.
        });
        if (previousFrameUrlRef.current) {
          URL.revokeObjectURL(previousFrameUrlRef.current);
          previousFrameUrlRef.current = null;
        }
        setDisplayMode("webrtc");
        displayModeRef.current = "webrtc";
        hasStreamRef.current = true;

        const [videoTrack] = stream.getVideoTracks();
        if (videoTrack) {
          videoTrack.onunmute = () => {
            latestFrameTimestampRef.current = Date.now();
          };
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === "failed" || state === "closed" || state === "disconnected") {
          if (displayModeRef.current === "webrtc") {
            setDisplayMode("none");
            displayModeRef.current = "none";
          }
          hasStreamRef.current = false;
        }
      };

      return pc;
    };

    const connect = () => {
      if (cancelled) return;

      setConnectionState("connecting");
      const ws = new WebSocket(resolvedServerUrl);
      ws.binaryType = "blob";
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "join", role: "viewer", roomId }));
        setConnectionState("connected");
      };

      ws.onmessage = async (event) => {
        if (typeof event.data !== "string") {
          const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: "image/jpeg" });
          const nextUrl = URL.createObjectURL(blob);
          const previous = previousFrameUrlRef.current;
          previousFrameUrlRef.current = nextUrl;
          latestFrameTimestampRef.current = Date.now();
          if (videoRef.current) {
            videoRef.current.srcObject = null;
          }
          hasStreamRef.current = false;
          if (imageRef.current) {
            imageRef.current.src = nextUrl;
          }
          if (displayModeRef.current !== "jpeg") {
            setDisplayMode("jpeg");
            displayModeRef.current = "jpeg";
          }
          if (previous && previous !== nextUrl) {
            URL.revokeObjectURL(previous);
          }
          return;
        }

        let payload: {
          type?: string;
          senderOnline?: boolean;
          senderId?: string | null;
          fromId?: string;
          data?: SignalPayload;
        };
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }

        if (payload.type === "stream-state") {
          setSenderOnline(Boolean(payload.senderOnline));
          senderIdRef.current = payload.senderId ?? null;
          if (!payload.senderOnline) {
            resetPeerConnection();
            return;
          }
          if (payload.senderId && activePeerSenderIdRef.current && activePeerSenderIdRef.current !== payload.senderId) {
            resetPeerConnection();
          }
          return;
        }

        if (payload.type === "signal" && payload.fromId && payload.data) {
          senderIdRef.current = payload.fromId;
          const pc = ensurePeer(payload.fromId);

          if (payload.data.description) {
            await pc.setRemoteDescription(payload.data.description);
            if (pendingIceCandidatesRef.current.length > 0) {
              for (const candidate of pendingIceCandidatesRef.current) {
                try {
                  await pc.addIceCandidate(candidate);
                } catch {
                  // Ignore stale ICE candidates after reconnect.
                }
              }
              pendingIceCandidatesRef.current = [];
            }

            if (payload.data.description.type === "offer") {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              sendSignal(payload.fromId, { description: answer });
            }
          }

          if (payload.data.candidate) {
            if (pc.remoteDescription) {
              try {
                await pc.addIceCandidate(payload.data.candidate);
              } catch {
                // Ignore stale ICE candidates after reconnect.
              }
            } else {
              pendingIceCandidatesRef.current.push(payload.data.candidate);
            }
          }
        }
      };

      ws.onclose = () => {
        setConnectionState("disconnected");
        setSenderOnline(false);
        if (!cancelled) {
          window.setTimeout(connect, 1000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    const timer = window.setInterval(() => {
      if (videoRef.current && hasStreamRef.current) {
        latestFrameTimestampRef.current = Date.now();
      }
      const ts = latestFrameTimestampRef.current;
      setLastFrameAtLabel(ts ? new Date(ts).toLocaleTimeString() : null);
    }, 500);

    const mountedVideoElement = videoRef.current;

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      wsRef.current?.close();
      wsRef.current = null;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      senderIdRef.current = null;
      activePeerSenderIdRef.current = null;
      pendingIceCandidatesRef.current = [];
      remoteStreamRef.current = null;
      if (previousFrameUrlRef.current) {
        URL.revokeObjectURL(previousFrameUrlRef.current);
        previousFrameUrlRef.current = null;
      }
      if (mountedVideoElement) {
        mountedVideoElement.srcObject = null;
      }
    };
  }, [resolvedServerUrl, roomId]);

  const statusLabel = connectionState === "connecting"
    ? "connecting"
    : senderOnline
      ? "live"
      : "waiting";

  return (
    <div className="absolute inset-0 bg-[var(--hero)]">
      <video
        ref={videoRef}
        className={`h-full w-full object-cover ${displayMode === "webrtc" ? "opacity-100" : "opacity-0"}`}
        autoPlay
        playsInline
        muted
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={imageRef}
        alt="Live camera stream"
        className={`absolute inset-0 h-full w-full object-cover ${displayMode === "jpeg" ? "opacity-100" : "opacity-0"}`}
      />
      {displayMode === "none" && (
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
          {lastFrameAtLabel ? `last frame ${lastFrameAtLabel}` : `room ${roomId}`}
        </span>
      </div>
    </div>
  );
}
