"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const MAGIC = 0x4c424d50; // "LBMP" — must match bridge/cloud_export.py

interface Props {
  url?: string;
  bridgeUrl?: string;
  sessionId?: string;
  /** Ratio of point size to scene extent. Tune for visual density. */
  pointSizeFactor?: number;
  /** Optional camera-trajectory JSON: { points: [[x,y,z], ...] } */
  pathUrl?: string;
  /** If true, drag only rotates around the vertical axis (azimuth). */
  lockElevation?: boolean;
  /** Rotate 180° around X so COLMAP's image-style Y-down frame reads up. */
  flipUp?: boolean;
}

export function PointCloudViewer({
  url,
  bridgeUrl,
  sessionId,
  pointSizeFactor = 0.0025,
  pathUrl,
  lockElevation = false,
  flipUp = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pointCount, setPointCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const resolvedUrl = useMemo(() => {
    if (url) return url;
    if (bridgeUrl && sessionId) {
      return `${bridgeUrl.replace(/\/$/, "")}/sessions/${sessionId}/cloud`;
    }
    return null;
  }, [url, bridgeUrl, sessionId]);
  const effectiveStatus = resolvedUrl ? status : "error";
  const effectiveError = resolvedUrl ? error : "no url";

  useEffect(() => {
    if (!resolvedUrl) return;
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
      // Closer initial framing — sit just outside the cloud rather than
      // 1.6× away, so the environment fills the viewport on first paint.
      const radius = maxExtent * 0.85;

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
      // Group hosting the cloud + path overlays. Rotated 180° around X when
      // flipUp is set so COLMAP's image-style frame (Y-down) reads with
      // gravity in the viewer.
      const sceneGroup = new THREE.Group();
      if (flipUp) sceneGroup.rotation.x = Math.PI;
      scene.add(sceneGroup);

      const cloud = new THREE.Points(geom, mat);
      sceneGroup.add(cloud);

      // Optional camera-trajectory polyline. Fetched lazily so a missing
      // path file doesn't block the cloud render. Coloured as a vertex
      // gradient (early frames cool → late frames warm) so the direction
      // of travel is readable at a glance.
      const disposables: Array<{ dispose: () => void }> = [];
      if (pathUrl) {
        try {
          const pathRes = await fetch(pathUrl, { cache: "no-store" });
          if (pathRes.ok) {
            const payload = (await pathRes.json()) as { points?: number[][] };
            const pts = Array.isArray(payload.points) ? payload.points : [];
            if (pts.length >= 2 && !disposed) {
              const pp = new Float32Array(pts.length * 3);
              const pc = new Float32Array(pts.length * 3);
              for (let i = 0; i < pts.length; i++) {
                pp[i * 3] = pts[i][0];
                pp[i * 3 + 1] = pts[i][1];
                pp[i * 3 + 2] = pts[i][2];
                const t = i / Math.max(1, pts.length - 1);
                // cool → warm gradient
                pc[i * 3] = 0.35 + 0.55 * t;        // r
                pc[i * 3 + 1] = 0.55 + 0.15 * (1 - t); // g
                pc[i * 3 + 2] = 0.95 - 0.55 * t;    // b
              }
              // WebGL ignores Line linewidth on most drivers, so draw the
              // trajectory as a TubeGeometry along a Catmull-Rom curve —
              // gives a real, controllable thickness in 3D.
              const curvePts: import("three").Vector3[] = [];
              for (let i = 0; i < pts.length; i++) {
                curvePts.push(new THREE.Vector3(pp[i * 3], pp[i * 3 + 1], pp[i * 3 + 2]));
              }
              const curve = new THREE.CatmullRomCurve3(curvePts, false, "catmullrom", 0.5);
              const tubeGeom = new THREE.TubeGeometry(
                curve,
                Math.max(64, pts.length * 4),
                maxExtent * 0.004,
                10,
                false
              );
              const tubeMat = new THREE.MeshBasicMaterial({
                color: 0xff7a45,
                transparent: true,
                opacity: 0.95,
                depthWrite: false,
              });
              sceneGroup.add(new THREE.Mesh(tubeGeom, tubeMat));
              disposables.push(tubeGeom, tubeMat);

              // Thin bright underline so the path remains crisp at any zoom.
              const pathGeom = new THREE.BufferGeometry();
              pathGeom.setAttribute("position", new THREE.BufferAttribute(pp, 3));
              pathGeom.setAttribute("color", new THREE.BufferAttribute(pc, 3));
              const pathMat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent: true,
                opacity: 0.85,
              });
              sceneGroup.add(new THREE.Line(pathGeom, pathMat));
              disposables.push(pathGeom, pathMat);

              // Endpoint dots so the start/end of the trajectory pop.
              const endsGeom = new THREE.BufferGeometry();
              endsGeom.setAttribute(
                "position",
                new THREE.BufferAttribute(
                  new Float32Array([pp[0], pp[1], pp[2], pp[pp.length - 3], pp[pp.length - 2], pp[pp.length - 1]]),
                  3
                )
              );
              endsGeom.setAttribute(
                "color",
                new THREE.BufferAttribute(
                  new Float32Array([0.35, 0.7, 0.95, 0.9, 0.55, 0.4]),
                  3
                )
              );
              const endsMat = new THREE.PointsMaterial({
                size: maxExtent * pointSizeFactor * 8,
                vertexColors: true,
                sizeAttenuation: true,
                transparent: true,
                opacity: 1.0,
              });
              sceneGroup.add(new THREE.Points(endsGeom, endsMat));
              disposables.push(endsGeom, endsMat);
            }
          }
        } catch {
          // Path overlay is optional — never fail the whole render on it.
        }
      }

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
        if (!lockElevation) {
          elevation = Math.max(-1.4, Math.min(1.4, elevation + (e.clientY - lastY) * 0.005));
        }
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
        for (const d of disposables) d.dispose();
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
  }, [resolvedUrl, pointSizeFactor]);

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute bottom-3 right-3 z-10 rounded-[10px] border border-black/15 bg-white/55 px-2.5 py-1 text-[10px] font-display text-[var(--muted-foreground)] backdrop-blur-md">
        {effectiveStatus === "loading" && "loading..."}
        {effectiveStatus === "ready" && `${pointCount.toLocaleString()} pts · drag · scroll`}
        {effectiveStatus === "error" && `error: ${effectiveError ?? "unknown"}`}
      </div>
    </div>
  );
}
