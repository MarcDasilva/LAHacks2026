"use client";

import { useEffect, useRef, useState } from "react";

const CLOUD_MAGIC = 0x4c424d50; // "LBMP"
const FRUSTUM_MAGIC = 0x4c424653; // "LBFS"

interface Props {
  url?: string;
  bridgeUrl?: string;
  sessionId?: string;
  /** Ratio of point size to scene extent. Tune for visual density. */
  pointSizeFactor?: number;
  /** depth_conf threshold passed to the bridge (upstream default 1.0). Higher values trim sky/noise. */
  conf?: number;
  /** Per-frame stride downsample passed to the bridge (upstream default 10). */
  downsample?: number;
}

// 8-stop viridis approximation. Good enough for frustum coloring.
const VIRIDIS: Array<[number, number, number]> = [
  [0.267, 0.005, 0.329],
  [0.282, 0.140, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
];

function viridis(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(0.9999, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

export function PointCloudViewer({
  url,
  bridgeUrl,
  sessionId,
  pointSizeFactor = 0.0015,
  conf,
  downsample,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pointCount, setPointCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cloudUrl = url;
    let frustumUrl: string | null = null;
    if (!cloudUrl && bridgeUrl && sessionId) {
      const base = `${bridgeUrl.replace(/\/$/, "")}/sessions/${sessionId}`;
      const qs: string[] = [];
      if (conf !== undefined) qs.push(`conf=${conf}`);
      if (downsample !== undefined) qs.push(`downsample=${downsample}`);
      cloudUrl = `${base}/cloud${qs.length ? `?${qs.join("&")}` : ""}`;
      frustumUrl = `${base}/frustums`;
    }
    if (!cloudUrl) {
      setStatus("error");
      setError("no url");
      return;
    }
    if (!containerRef.current) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    (async () => {
      const THREE = await import("three");

      const [cloudRes, frustumRes] = await Promise.all([
        fetch(cloudUrl!),
        frustumUrl ? fetch(frustumUrl).catch(() => null) : Promise.resolve(null),
      ]);
      if (!cloudRes.ok) {
        if (!disposed) {
          setStatus("error");
          setError(`http ${cloudRes.status}`);
        }
        return;
      }
      const cloudBuf = await cloudRes.arrayBuffer();
      if (disposed) return;

      const dv = new DataView(cloudBuf);
      if (dv.getUint32(0, true) !== CLOUD_MAGIC) {
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

      const hasColor = version === 2 && stride === 24;
      const floats = new Float32Array(cloudBuf, 16);
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

      // Optional frustums.
      let extrinsics: Float32Array | null = null; // (numFrames * 12), row-major 3x4 world-to-camera
      let numFrames = 0;
      if (frustumRes && frustumRes.ok) {
        const fbuf = await frustumRes.arrayBuffer();
        if (!disposed) {
          const fdv = new DataView(fbuf);
          if (fdv.getUint32(0, true) === FRUSTUM_MAGIC) {
            numFrames = fdv.getUint32(8, true);
            extrinsics = new Float32Array(fbuf, 16, numFrames * 12);
          }
        }
      }

      // Camera centers in world space: for a world-to-camera [R|t], center = -R^T t.
      // Also note our cloud_export inverts the same way before unprojecting depth, so
      // this is consistent with the cloud's world frame.
      const camCenters = new Float32Array(numFrames * 3);
      for (let i = 0; i < numFrames; i++) {
        const o = i * 12;
        const R = extrinsics!;
        // R is row-major 3x4: rows [R|t]. Inverse rotation = transpose; center = -R^T @ t.
        const r00 = R[o + 0], r01 = R[o + 1], r02 = R[o + 2], tx = R[o + 3];
        const r10 = R[o + 4], r11 = R[o + 5], r12 = R[o + 6], ty = R[o + 7];
        const r20 = R[o + 8], r21 = R[o + 9], r22 = R[o + 10], tz = R[o + 11];
        camCenters[i * 3] = -(r00 * tx + r10 * ty + r20 * tz);
        camCenters[i * 3 + 1] = -(r01 * tx + r11 * ty + r21 * tz);
        camCenters[i * 3 + 2] = -(r02 * tx + r12 * ty + r22 * tz);
      }

      const container = containerRef.current!;
      const w = container.clientWidth;
      const h = container.clientHeight;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b0a0d);

      // Frame the cloud: median + max extent (NOT bbox diagonal — corner outliers blow that up).
      let cx = 0, cy = 0, cz = 0;
      for (let i = 0; i < n; i++) {
        cx += positions[i * 3];
        cy += positions[i * 3 + 1];
        cz += positions[i * 3 + 2];
      }
      cx /= n; cy /= n; cz /= n;

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

      // Recover "up": for an arc-style camera trajectory, the orbit-plane normal is up.
      // Cheap proxy: cross product of (first - centroid) and (mid - centroid). Falls back
      // to world-Y if we don't have enough cameras.
      let up = new THREE.Vector3(0, 1, 0);
      if (numFrames >= 3) {
        let ccx = 0, ccy = 0, ccz = 0;
        for (let i = 0; i < numFrames; i++) {
          ccx += camCenters[i * 3];
          ccy += camCenters[i * 3 + 1];
          ccz += camCenters[i * 3 + 2];
        }
        ccx /= numFrames; ccy /= numFrames; ccz /= numFrames;
        const mid = Math.floor(numFrames / 2);
        const a = new THREE.Vector3(
          camCenters[0] - ccx,
          camCenters[1] - ccy,
          camCenters[2] - ccz,
        );
        const b = new THREE.Vector3(
          camCenters[mid * 3] - ccx,
          camCenters[mid * 3 + 1] - ccy,
          camCenters[mid * 3 + 2] - ccz,
        );
        const normal = new THREE.Vector3().crossVectors(a, b);
        if (normal.lengthSq() > 1e-8) up = normal.normalize();
      }

      const camera = new THREE.PerspectiveCamera(55, w / h, maxExtent * 0.01, maxExtent * 10);
      camera.up.copy(up);

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

      // Frustum pyramids: 5 verts per frame (apex + 4 base corners), 8 line segments.
      let frustumGroup: any = null;
      if (extrinsics && numFrames > 0) {
        const s = maxExtent * 0.04; // pyramid scale
        const fpos = new Float32Array(numFrames * 8 * 2 * 3); // 8 segments × 2 verts × 3 coords
        const fcol = new Float32Array(numFrames * 8 * 2 * 3);
        // Edges (pairs of corner indices, 0=apex, 1..4=base corners CCW):
        const edges = [
          [0, 1], [0, 2], [0, 3], [0, 4],
          [1, 2], [2, 3], [3, 4], [4, 1],
        ];
        const corners = [
          [0, 0, 0],
          [-s, -s, s],
          [s, -s, s],
          [s, s, s],
          [-s, s, s],
        ];
        let wo = 0;
        for (let i = 0; i < numFrames; i++) {
          const o = i * 12;
          const r00 = extrinsics![o + 0], r01 = extrinsics![o + 1], r02 = extrinsics![o + 2];
          const r10 = extrinsics![o + 4], r11 = extrinsics![o + 5], r12 = extrinsics![o + 6];
          const r20 = extrinsics![o + 8], r21 = extrinsics![o + 9], r22 = extrinsics![o + 10];
          const tcx = camCenters[i * 3];
          const tcy = camCenters[i * 3 + 1];
          const tcz = camCenters[i * 3 + 2];
          // World corner = R^T @ cam_corner + cam_center.
          const worldCorners = corners.map(([x, y, z]) => [
            r00 * x + r10 * y + r20 * z + tcx,
            r01 * x + r11 * y + r21 * z + tcy,
            r02 * x + r12 * y + r22 * z + tcz,
          ]);
          const [cr, cg, cb] = viridis(numFrames > 1 ? i / (numFrames - 1) : 0);
          for (const [a, b] of edges) {
            const pa = worldCorners[a];
            const pb = worldCorners[b];
            fpos[wo + 0] = pa[0]; fpos[wo + 1] = pa[1]; fpos[wo + 2] = pa[2];
            fpos[wo + 3] = pb[0]; fpos[wo + 4] = pb[1]; fpos[wo + 5] = pb[2];
            fcol[wo + 0] = cr; fcol[wo + 1] = cg; fcol[wo + 2] = cb;
            fcol[wo + 3] = cr; fcol[wo + 4] = cg; fcol[wo + 5] = cb;
            wo += 6;
          }
        }
        const fgeom = new THREE.BufferGeometry();
        fgeom.setAttribute("position", new THREE.BufferAttribute(fpos, 3));
        fgeom.setAttribute("color", new THREE.BufferAttribute(fcol, 3));
        const fmat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
        frustumGroup = new THREE.LineSegments(fgeom, fmat);
        scene.add(frustumGroup);
      }

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(w, h);
      container.appendChild(renderer.domElement);

      // Orbit around `up`. Build an orthonormal basis (right, up, fwd) and parameterize.
      const right = new THREE.Vector3();
      const fwd = new THREE.Vector3();
      const helper = new THREE.Vector3(1, 0, 0);
      if (Math.abs(helper.dot(up)) > 0.95) helper.set(0, 1, 0);
      right.crossVectors(helper, up).normalize();
      fwd.crossVectors(up, right).normalize();

      let azimuth = 0;
      let elevation = 0.15; // shallow tilt above orbit plane
      let dist = radius;
      let dragging = false;
      let lastX = 0;
      let lastY = 0;

      const updateCamera = () => {
        const cosE = Math.cos(elevation);
        const sinE = Math.sin(elevation);
        // position = center + dist * (cosE * (cosA*fwd + sinA*right) + sinE * up)
        const cosA = Math.cos(azimuth);
        const sinA = Math.sin(azimuth);
        camera.position.set(
          center.x + dist * (cosE * (cosA * fwd.x + sinA * right.x) + sinE * up.x),
          center.y + dist * (cosE * (cosA * fwd.y + sinA * right.y) + sinE * up.y),
          center.z + dist * (cosE * (cosA * fwd.z + sinA * right.z) + sinE * up.z),
        );
        camera.up.copy(up);
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
      const onUp = () => { dragging = false; };
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
        if (frustumGroup) {
          frustumGroup.geometry.dispose();
          frustumGroup.material.dispose();
        }
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
  }, [url, bridgeUrl, sessionId, pointSizeFactor, conf, downsample]);

  return (
    <div ref={containerRef} className="absolute inset-0 rounded-[14px] overflow-hidden">
      <div className="absolute bottom-3 right-3 z-10 text-[10px] text-[var(--muted-foreground)] font-mono">
        {status === "loading" && "loading…"}
        {status === "ready" && `${pointCount.toLocaleString()} pts · drag · scroll`}
        {status === "error" && `error: ${error ?? "unknown"}`}
      </div>
    </div>
  );
}
