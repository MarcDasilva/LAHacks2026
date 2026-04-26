"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  viserUrl: string;
  sessionId: string;
  /** Bridge HTTP base. We POST /sessions/{id}/replay here whenever the
   *  selected session changes so the viser scene swaps to that session's
   *  points (and clears anything else that was loaded). */
  bridgeUrl: string;
}

/**
 * Embeds the viser web client in an iframe.
 *
 * The viser server is a singleton hosted in the ingest_server process. The
 * scene contains every session under `/sessions/{id}/...`, but we keep only
 * one session's subtree at a time by triggering a replay on session change
 * — replay clears all other sessions before pushing the selected one.
 */
export function ViserEmbed({ viserUrl, sessionId, bridgeUrl }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [reachable, setReachable] = useState<"checking" | "ok" | "down">("checking");
  const [replay, setReplay] = useState<"idle" | "queued" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
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

  // Whenever the user picks a session, kick off a server-side replay. This
  // is what makes "select church" actually load the church reconstruction
  // (and only that one). 409 means the session isn't 'done' yet, which we
  // treat as a no-op — its points will land in viser when inference finishes.
  useEffect(() => {
    let cancelled = false;
    const url = `${bridgeUrl.replace(/\/$/, "")}/sessions/${encodeURIComponent(sessionId)}/replay`;
    setReplay("queued");
    fetch(url, { method: "POST" })
      .then((r) => {
        if (cancelled) return;
        if (r.ok) setReplay("idle");
        else if (r.status === 409) setReplay("idle");
        else setReplay("error");
      })
      .catch(() => {
        if (!cancelled) setReplay("error");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, bridgeUrl]);

  const src = `${viserUrl.replace(/\/$/, "")}/`;

  if (reachable === "down") {
    return (
      <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted-foreground)] font-mono">
        viser unreachable at {viserUrl}
      </div>
    );
  }

  return (
    <>
      <iframe
        ref={iframeRef}
        src={src}
        className="absolute inset-0 w-full h-full border-0 bg-[#0b0a0d]"
        allow="fullscreen"
        title="viser streaming viewer"
      />
      {replay === "error" && (
        <div className="absolute bottom-3 right-3 z-10 text-[10px] text-[var(--muted-foreground)] font-mono bg-black/60 px-2 py-1 rounded">
          replay failed — check bridge
        </div>
      )}
    </>
  );
}
