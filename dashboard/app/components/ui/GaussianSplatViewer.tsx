"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  url: string;
  /** Rotate 180° around X to match COLMAP's Y-down frame to viewer up. */
  flipUp?: boolean;
}

// .splat layout (antimatter15): 32 bytes per gaussian
//   pos:    3 × float32  (12 bytes)
//   scale:  3 × float32  (12 bytes)
//   rgba:   4 × uint8    (4 bytes)
//   rot:    4 × uint8    (4 bytes)
const SPLAT_STRIDE = 32;

// Reads the position component of every gaussian to compute scene bounds.
// COLMAP scenes have arbitrary world coordinates; without this the default
// camera at [0,0,4] points at empty space.
function computeSceneFraming(buf: ArrayBuffer): {
  center: [number, number, number];
  radius: number;
} {
  const n = Math.floor(buf.byteLength / SPLAT_STRIDE);
  if (n === 0) return { center: [0, 0, 0], radius: 1 };
  const view = new DataView(buf);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const o = i * SPLAT_STRIDE;
    cx += view.getFloat32(o, true);
    cy += view.getFloat32(o + 4, true);
    cz += view.getFloat32(o + 8, true);
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let maxD2 = 0;
  for (let i = 0; i < n; i++) {
    const o = i * SPLAT_STRIDE;
    const dx = view.getFloat32(o, true) - cx;
    const dy = view.getFloat32(o + 4, true) - cy;
    const dz = view.getFloat32(o + 8, true) - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > maxD2) maxD2 = d2;
  }
  return { center: [cx, cy, cz], radius: Math.sqrt(maxD2) || 1 };
}

export function GaussianSplatViewer({ url, flipUp = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let viewer: { dispose: () => void } | null = null;

    (async () => {
      try {
        // Fetch the splat ourselves first so we can frame the camera before
        // mount. The viewer can load from a Uint8Array via addSplatScene's
        // FileBufferType branch.
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`splat ${res.status}`);
        const buf = await res.arrayBuffer();
        if (disposed) return;
        const { center, radius } = computeSceneFraming(buf);
        // Sit ~2.2× the bounding radius back along Z so the cloud fills the
        // viewport. The viewer's OrbitControls handle zoom/rotate from here.
        const dist = Math.max(radius * 2.2, 0.5);
        const camPos: [number, number, number] = [
          center[0],
          center[1],
          center[2] + dist,
        ];

        const mod = await import("@mkkellogg/gaussian-splats-3d");
        if (disposed) return;
        const Viewer = (mod as { Viewer: new (opts: object) => unknown }).Viewer;
        const v = new Viewer({
          rootElement: container,
          selfDrivenMode: true,
          useBuiltInControls: true,
          sharedMemoryForWorkers: false,
          gpuAcceleratedSort: true,
          halfPrecisionCovariancesOnGPU: true,
          dynamicScene: false,
          initialCameraPosition: camPos,
          initialCameraLookAt: center,
        }) as {
          addSplatScene: (url: string | Uint8Array, opts: object) => Promise<void>;
          start: () => void;
          dispose: () => void;
        };
        await v.addSplatScene(new Uint8Array(buf), {
          format: 0, // 0 = .splat (antimatter15)
          rotation: flipUp ? [1, 0, 0, 0] : [0, 0, 0, 1],
          showLoadingUI: false,
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
