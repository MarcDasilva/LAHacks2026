"use client";

import { useEffect, useRef, useState } from "react";

const MAGIC = 0x4c424d50; // "LBMP" — must match bridge/cloud_export.py

interface Props {
  url?: string;
  bridgeUrl?: string;
  sessionId?: string;
  /** Ratio of point size to scene extent. Tune for visual density. */
  pointSizeFactor?: number;
}

export function PointCloudViewer({
  url,
  bridgeUrl,
  sessionId,
  pointSizeFactor = 0.0025,
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

      // Parse the binary header.
      const dv = new DataView(buf);
      if (dv.getUint32(0, true) !== MAGIC) {
        setStatus("error");
        setError("bad magic");
        return;
      }
      const version = dv.getUint32(4, true);
      const n = dv.getUint32(8, true);
      const stride = dv.getUint32(12, true);

      if (version !== 1 && version !== 2) {
        setStatus("error");
        setError(`unsupported version ${version}`);
        return;
      }
      if (n === 0) {
        setStatus("error");
        setError("empty cloud");
        return;
      }

      // v1: stride 12 (xyz only). v2: stride 24 (xyz + rgb).
      const hasColor = version === 2 && stride === 24;
      const floats = new Float32Array(buf, 16);
      const positions = new Float32Array(n * 3);
      const colors = hasColor ? new Float32Array(n * 3) : null;

      if (hasColor) {
        for (let i = 0; i < n; i++) {
          const o = i * 6;
          positions[i * 3] = floats[o];
          positions[i * 3 + 1] = floats[o + 1];
          positions[i * 3 + 2] = floats[o + 2];
          colors![i * 3] = floats[o + 3];
          colors![i * 3 + 1] = floats[o + 4];
          colors![i * 3 + 2] = floats[o + 5];
        }
      } else {
        positions.set(floats.subarray(0, n * 3));
      }

      const container = containerRef.current!;
      const w = container.clientWidth;
      const h = container.clientHeight;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0a0d);

      // Frame the cloud: use median + max extent (NOT bbox diagonal — corner
      // outliers blow that up). Camera distance is tuned so the cloud
      // comfortably fills the viewport.
      let cx = 0,
        cy = 0,
        cz = 0;
      for (let i = 0; i < n; i++) {
        cx += positions[i * 3];
        cy += positions[i * 3 + 1];
        cz += positions[i * 3 + 2];
      }
      cx /= n;
      cy /= n;
      cz /= n;

      let maxExtent = 0;
      for (let i = 0; i < n; i++) {
        const dx = positions[i * 3] - cx;
        const dy = positions[i * 3 + 1] - cy;
        const dz = positions[i * 3 + 2] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > maxExtent) maxExtent = d;
      }
      const center = new THREE.Vector3(cx, cy, cz);
      const radius = maxExtent * 1.6;

      const camera = new THREE.PerspectiveCamera(55, w / h, maxExtent * 0.01, maxExtent * 10);

      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      if (colors) {
        geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      }

      const mat = new THREE.PointsMaterial({
        size: maxExtent * pointSizeFactor,
        vertexColors: !!colors,
        color: colors ? 0xffffff : 0xeae0d5,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
      });
      const cloud = new THREE.Points(geom, mat);
      scene.add(cloud);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      container.appendChild(renderer.domElement);

      // Orbit: drag to rotate, scroll to zoom.
      let azimuth = 0;
      let elevation = 0.3;
      let dist = radius;
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const updateCamera = () => {
        const x = center.x + dist * Math.cos(elevation) * Math.sin(azimuth);
        const y = center.y + dist * Math.sin(elevation);
        const z = center.z + dist * Math.cos(elevation) * Math.cos(azimuth);
        camera.position.set(x, y, z);
        camera.lookAt(center);
      };
      updateCamera();

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
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const factor = Math.exp(e.deltaY * 0.001);
        dist = Math.max(maxExtent * 0.2, Math.min(maxExtent * 6, dist * factor));
        updateCamera();
      };

      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointercancel", onUp);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

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
        renderer.domElement.removeEventListener("wheel", onWheel);
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
  }, [url, bridgeUrl, sessionId, pointSizeFactor]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute bottom-3 right-3 z-10 text-[10px] text-[var(--muted-foreground)] font-display">
        {status === "loading" && "loading…"}
        {status === "ready" && `${pointCount.toLocaleString()} pts · drag · scroll`}
        {status === "error" && `error: ${error ?? "unknown"}`}
      </div>
    </div>
  );
}
