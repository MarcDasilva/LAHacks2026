"use client";

import { useEffect, useRef, useState } from "react";

const MAGIC = 0x4c424d50; // "LBMP" — must match bridge/cloud_export.py

interface Props {
  /**
   * Full URL to the bridge cloud endpoint, e.g.
   *   https://6v8yblgimbpc77-8888.proxy.runpod.net/sessions/church-test/cloud
   * Or set NEXT_PUBLIC_BRIDGE_URL + sessionId.
   */
  url?: string;
  bridgeUrl?: string;
  sessionId?: string;
  pointSize?: number;
  /** Random color tint for points (hex int). Default: warm white. */
  color?: number;
}

export function PointCloudViewer({
  url,
  bridgeUrl,
  sessionId,
  pointSize = 2,
  color = 0xeae0d5,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pointCount, setPointCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let resolvedUrl = url;
    if (!resolvedUrl && bridgeUrl && sessionId) {
      resolvedUrl = `${bridgeUrl.replace(/\/$/, "")}/sessions/${sessionId}/cloud`;
    }
    if (!resolvedUrl) {
      setStatus("error");
      setError("no url");
      return;
    }
    if (!containerRef.current) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const THREE = await import("three");

      const res = await fetch(resolvedUrl!);
      if (!res.ok) {
        if (!disposed) {
          setStatus("error");
          setError(`http ${res.status}`);
        }
        return;
      }
      const buf = await res.arrayBuffer();
      if (disposed) return;

      const dv = new DataView(buf);
      if (dv.getUint32(0, true) !== MAGIC) {
        setStatus("error");
        setError("bad magic");
        return;
      }
      const version = dv.getUint32(4, true);
      const n = dv.getUint32(8, true);
      const stride = dv.getUint32(12, true);
      if (version !== 1 || stride !== 12) {
        setStatus("error");
        setError(`unsupported v${version}/stride${stride}`);
        return;
      }
      const positions = new Float32Array(buf, 16, n * 3);

      const container = containerRef.current!;
      const w = container.clientWidth;
      const h = container.clientHeight;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0a0d);

      const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 1000);

      // Compute centroid + extent so we frame the cloud nicely.
      const bbox = new THREE.Box3();
      const tmp = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        bbox.expandByPoint(tmp);
      }
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3()).length();
      camera.position.set(center.x, center.y, center.z + size * 0.9);
      camera.lookAt(center);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

      const mat = new THREE.PointsMaterial({
        size: pointSize,
        color,
        sizeAttenuation: false,
      });
      const cloud = new THREE.Points(geom, mat);
      scene.add(cloud);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      container.appendChild(renderer.domElement);

      // Minimal orbit: drag to rotate. Avoids pulling in OrbitControls dep.
      let azimuth = 0;
      let elevation = 0;
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const radius = size * 0.9;

      const updateCamera = () => {
        const x = center.x + radius * Math.cos(elevation) * Math.sin(azimuth);
        const y = center.y + radius * Math.sin(elevation);
        const z = center.z + radius * Math.cos(elevation) * Math.cos(azimuth);
        camera.position.set(x, y, z);
        camera.lookAt(center);
      };

      const onDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        (e.target as Element).setPointerCapture?.(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        azimuth -= (e.clientX - lastX) * 0.005;
        elevation = Math.max(-1.4, Math.min(1.4, elevation + (e.clientY - lastY) * 0.005));
        lastX = e.clientX;
        lastY = e.clientY;
        updateCamera();
      };
      const onUp = () => {
        dragging = false;
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointercancel", onUp);

      // Slow auto-rotate so a static screenshot still looks alive.
      let rafId = 0;
      let last = performance.now();
      const tick = (now: number) => {
        const dt = (now - last) / 1000;
        last = now;
        if (!dragging) {
          azimuth += dt * 0.12;
          updateCamera();
        }
        renderer.render(scene, camera);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);

      const onResize = () => {
        const nw = container.clientWidth;
        const nh = container.clientHeight;
        camera.aspect = nw / nh;
        camera.updateProjectionMatrix();
        renderer.setSize(nw, nh);
      };
      const ro = new ResizeObserver(onResize);
      ro.observe(container);

      setPointCount(n);
      setStatus("ready");

      cleanup = () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointercancel", onUp);
        renderer.dispose();
        geom.dispose();
        mat.dispose();
        if (renderer.domElement.parentElement === container) {
          container.removeChild(renderer.domElement);
        }
      };
    })().catch((e) => {
      if (!disposed) {
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [url, bridgeUrl, sessionId, pointSize, color]);

  return (
    <div ref={containerRef} className="absolute inset-0 rounded-[14px] overflow-hidden">
      <div className="absolute bottom-3 right-3 z-10 text-[10px] text-[var(--muted-foreground)] font-mono">
        {status === "loading" && "loading…"}
        {status === "ready" && `${pointCount.toLocaleString()} pts · drag to rotate`}
        {status === "error" && `error: ${error ?? "unknown"}`}
      </div>
    </div>
  );
}
