"""Export a downsampled, colored point cloud from a session's predictions.pt.

predictions.pt is ~1 GB of dense per-pixel tensors. The browser viewer
only needs ~100k points with color, so we:
  1. filter by confidence
  2. drop 3D outliers using median-absolute-deviation (robust to corner
     outliers that per-axis percentile trim misses)
  3. random downsample to target_points
  4. assign each point a color from a viridis-like ramp keyed off the Y
     (height) axis — gives the viewer visible structure even with no
     image-derived RGB

The downsampled binary is cached at outputs/<session>/cloud.<key>.bin so
subsequent requests don't pay the torch.load cost.

File format (little-endian, version 2):
    [0:4]   uint32  magic   = 0x4c424d50  ("LBMP")
    [4:8]   uint32  version = 2
    [8:12]  uint32  num_points
    [12:16] uint32  stride_bytes (24 = xyz fp32 + rgb fp32)
    [16:N]  Float32Array of length num_points * 6  (interleaved x,y,z,r,g,b)
"""
from __future__ import annotations

import logging
import struct
from pathlib import Path
from typing import Final

log = logging.getLogger("cloud_export")

MAGIC: Final = 0x4C424D50
VERSION: Final = 2
HEADER_SIZE: Final = 16
STRIDE_BYTES: Final = 24  # xyz + rgb, all fp32


def _viridis(t):
    """Cheap viridis-ish ramp: t in [0,1] → (r,g,b) in [0,1]. Vectorized."""
    import numpy as np

    t = np.clip(t, 0.0, 1.0)
    # 4-stop gradient: dark purple → teal → green → yellow.
    stops = np.array(
        [
            [0.267, 0.005, 0.329],
            [0.190, 0.408, 0.557],
            [0.208, 0.718, 0.473],
            [0.992, 0.906, 0.144],
        ]
    )
    n = len(stops) - 1
    pos = t * n
    i = np.clip(pos.astype(np.int32), 0, n - 1)
    f = (pos - i).reshape(-1, 1)
    return stops[i] * (1 - f) + stops[i + 1] * f


def export_cloud(
    predictions_path: Path,
    target_points: int = 150_000,
    conf_threshold: float = 0.5,
    mad_factor: float = 6.0,
) -> bytes:
    """Load predictions.pt → confidence + MAD outlier filter → color → pack."""
    import numpy as np
    import torch

    log.info("loading %s", predictions_path)
    preds = torch.load(predictions_path, map_location="cpu", weights_only=False)

    world_points = preds["world_points"]  # (N, H, W, 3) or (M, 3)
    conf = preds.get("world_points_conf")

    pts = world_points.reshape(-1, 3).numpy().astype(np.float32, copy=False)
    initial = len(pts)

    if conf is not None:
        c = conf.reshape(-1).numpy()
        pts = pts[c > conf_threshold]
        log.info("after conf>%.2f: %d / %d", conf_threshold, len(pts), initial)

    # Robust 3D outlier rejection: drop points more than `mad_factor` MADs
    # from the per-axis median. MAD is robust to the long-tail noise points
    # that lingbot-map's depth head produces in low-texture regions.
    if mad_factor > 0 and len(pts) > 1000:
        med = np.median(pts, axis=0)
        mad = np.median(np.abs(pts - med), axis=0) + 1e-6
        before = len(pts)
        keep = np.all(np.abs(pts - med) < mad_factor * mad, axis=1)
        pts = pts[keep]
        log.info("after %.1f-MAD trim: %d / %d", mad_factor, len(pts), before)

    if len(pts) == 0:
        log.warning("no points survived filtering — relax thresholds")
        header = struct.pack("<IIII", MAGIC, VERSION, 0, STRIDE_BYTES)
        return header

    if len(pts) > target_points:
        idx = np.random.default_rng(seed=0).choice(len(pts), target_points, replace=False)
        pts = pts[idx]

    # Color by height (Y axis) using a viridis-ish ramp. Visible structure
    # without needing per-pixel image colors.
    y = pts[:, 1]
    y_norm = (y - y.min()) / max(y.max() - y.min(), 1e-6)
    rgb = _viridis(y_norm).astype(np.float32, copy=False)

    interleaved = np.concatenate([pts, rgb], axis=1).astype(np.float32, copy=False)
    interleaved = np.ascontiguousarray(interleaved)
    n = len(interleaved)
    log.info("exporting %d points (xyz+rgb fp32)", n)

    header = struct.pack("<IIII", MAGIC, VERSION, n, STRIDE_BYTES)
    return header + interleaved.tobytes()


def get_or_build_cloud(
    session_output_dir: Path,
    target_points: int = 150_000,
    conf_threshold: float = 0.5,
    mad_factor: float = 6.0,
) -> bytes:
    """Return cached cloud.<key>.bin if present, else build + cache."""
    suffix = f"v{VERSION}_p{target_points}_c{conf_threshold:.2f}_m{mad_factor:.1f}"
    cache = session_output_dir / f"cloud.{suffix}.bin"
    preds = session_output_dir / "predictions.pt"

    if cache.exists() and cache.stat().st_mtime >= preds.stat().st_mtime:
        return cache.read_bytes()

    if not preds.exists():
        raise FileNotFoundError(f"no predictions.pt at {preds}")

    blob = export_cloud(
        preds,
        target_points=target_points,
        conf_threshold=conf_threshold,
        mad_factor=mad_factor,
    )
    cache.write_bytes(blob)
    return blob
