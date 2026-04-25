"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  viserUrl: string;
  sessionId: string;
}

/**
 * Embeds the viser web client in an iframe, scoped to a single session via
 * the `initialSceneNodeFilter` query param so we only see this session's
 * subtree.
 *
 * The viser server is a sibling of the bridge HTTP server — see
 * lingbot_bridge/bridge/viser_server.py. On RunPod each port has its own
 * proxy hostname, so VISER_URL is configured separately from BRIDGE_URL.
 */
export function ViserEmbed({ viserUrl, sessionId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reachable, setReachable] = useState<"checking" | "ok" | "down">("checking");

  useEffect(() => {
    let cancelled = false;
    // Cheap reachability ping. viser serves its client over HTTP on the
    // same port; a HEAD on `/` is enough to tell us if the proxy is up.
    fetch(viserUrl, { method: "HEAD", mode: "no-cors" })
      .then(() => {
        if (!cancelled) setReachable("ok");
      })
      .catch(() => {
        if (!cancelled) setReachable("down");
      });
    return () => {
      cancelled = true;
    };
  }, [viserUrl]);

  const src = `${viserUrl.replace(/\/$/, "")}/?initialSceneNodeFilter=${encodeURIComponent(`/sessions/${sessionId}`)}`;

  if (reachable === "down") {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted-foreground)] font-mono">
        viser unreachable at {viserUrl}
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      key={sessionId}
      src={src}
      className="absolute inset-0 w-full h-full border-0 bg-[#0b0a0d]"
      allow="fullscreen"
      title="viser streaming viewer"
    />
  );
}
