"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  url: string;
  /** Rotate 180° around X to match COLMAP's Y-down frame to viewer up. */
  flipUp?: boolean;
}

// Renders a 3D Gaussian Splat (.splat / antimatter15 format) using
// @mkkellogg/gaussian-splats-3d. Loaded dynamically so it never ships in
// the SSR bundle (the lib expects a DOM + WebGL2).
export function GaussianSplatViewer({ url, flipUp = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let viewer: { dispose: () => void; setRenderMode: (m: number) => void } | null =
      null;

    (async () => {
      try {
        const mod = await import("@mkkellogg/gaussian-splats-3d");
        if (disposed) return;
        const Viewer = (mod as { Viewer: new (opts: object) => unknown }).Viewer;
        const v = new Viewer({
          rootElement: container,
          selfDrivenMode: true,
          useBuiltInControls: true,
          sharedMemoryForWorkers: false,
          // Faster initial render at the cost of some visual fidelity.
          gpuAcceleratedSort: true,
          halfPrecisionCovariancesOnGPU: true,
          dynamicScene: false,
          initialCameraPosition: [0, 0, 4],
          initialCameraLookAt: [0, 0, 0],
          ...(flipUp ? { sceneRevealMode: 1 } : {}),
        }) as {
          addSplatScene: (
            url: string,
            opts: object
          ) => Promise<void>;
          start: () => void;
          dispose: () => void;
          setRenderMode: (m: number) => void;
        };
        await v.addSplatScene(url, {
          rotation: flipUp ? [1, 0, 0, 0] : [0, 0, 0, 1],
          showLoadingUI: false,
          progressiveLoad: true,
        });
        if (disposed) {
          v.dispose();
          return;
        }
        v.start();
        viewer = v;
        setStatus("ready");
      } catch (e) {
        if (disposed) return;
        setError(e instanceof Error ? e.message : "splat load failed");
        setStatus("error");
      }
    })();

    return () => {
      disposed = true;
      try {
        viewer?.dispose();
      } catch {
        /* ignore */
      }
    };
  }, [url, flipUp]);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="absolute inset-0" />
      {status !== "ready" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
          <div className="rounded-[12px] border border-[var(--primary)]/45 bg-black/45 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] font-display text-white/85">
            {status === "loading" ? "Loading splat…" : `Splat error: ${error ?? "?"}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
