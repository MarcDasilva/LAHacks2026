"""Export a colored point cloud from a session — 1:1 match of the upstream
lingbot_map viser viewer pipeline.

Mirrors `lingbot_map/vis/point_cloud_viewer.py::parse_pc_data`:

    For each frame i in 0..N-1:
        pts   = world_points[i].reshape(-1, 3)        # (H*W, 3)
        col   = images[i].permute(H, W, C).reshape(-1, 3)  # RGB float [0,1]
        conf  = world_points_conf[i].reshape(-1)
        pts, col, conf = pts[isfinite(pts)]            # NaN/Inf strip
        if any(isnan(col)): col = blue                 # upstream fallback
        keep  = conf > vis_threshold                   # default 1.0
        pts, col = pts[keep], col[keep]
        if downsample > 1: every Nth point             # default stride 10

    Concatenate across frames → render.

Outputs the v2 binary format:
    [0:4]   uint32  magic   = 0x4c424d50  ("LBMP")
    [4:8]   uint32  version = 2
    [8:12]  uint32  num_points
    [12:16] uint32  stride_bytes (24 = xyz fp32 + rgb fp32)
    [16:N]  Float32Array of length num_points * 6  (interleaved x,y,z,r,g,b)

The dashboard `PointCloudViewer.tsx` reads this directly.
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
STRIDE_BYTES: Final = 24


def export_cloud(
    predictions_path: Path,
    images_path: Path,
    conf_threshold: float = 1.0,
    downsample: int = 10,
) -> bytes:
    """Mirror of lingbot_map.vis.point_cloud_viewer.parse_pc_data, packed as bytes."""
    import numpy as np
    import torch

    log.info("loading %s", predictions_path)
    preds = torch.load(predictions_path, map_location="cpu", weights_only=False)
    log.info("loading %s", images_path)
    images_t = torch.load(images_path, map_location="cpu", weights_only=False)

    world_points = preds["world_points"]      # (N, H, W, 3)
    conf_all = preds["world_points_conf"]     # (N, H, W)

    # Upstream: images are (N, 3, H, W) float in [0, 1] RGB. Permute to HWC.
    if images_t.ndim != 4 or images_t.shape[1] != 3:
        raise ValueError(f"images.pt has unexpected shape {tuple(images_t.shape)}")
    colors_all = images_t.permute(0, 2, 3, 1).contiguous()  # (N, H, W, 3)

    n_frames = world_points.shape[0]
    if colors_all.shape[0] != n_frames or conf_all.shape[0] != n_frames:
        raise ValueError(
            f"frame-count mismatch: world_points={n_frames}, "
            f"images={colors_all.shape[0]}, conf={conf_all.shape[0]}"
        )

    xyz_chunks: list = []
    rgb_chunks: list = []
    total_initial = 0
    total_kept = 0

    for i in range(n_frames):
        pts = world_points[i].reshape(-1, 3).numpy()
        col = colors_all[i].reshape(-1, 3).numpy()
        c = conf_all[i].reshape(-1).numpy()
        total_initial += len(pts)

        # Drop NaN/Inf points (upstream parse_pc_data step).
        valid = np.isfinite(pts).all(axis=1)
        if not valid.all():
            pts = pts[valid]
            col = col[valid]
            c = c[valid]

        # NaN colors → blue (upstream fallback).
        if np.isnan(col).any():
            col = np.zeros_like(col)
            col[:, 2] = 1.0

        # Confidence filter — strict `>`, matches upstream.
        mask = c > conf_threshold
        pts = pts[mask]
        col = col[mask]

        # Stride downsample — keep every Nth point (upstream default 10).
        if downsample > 1 and len(pts) > 0:
            idx = np.arange(0, len(pts), downsample)
            pts = pts[idx]
            col = col[idx]

        if len(pts) > 0:
            xyz_chunks.append(pts.astype(np.float32, copy=False))
            rgb_chunks.append(col.astype(np.float32, copy=False))
            total_kept += len(pts)

    log.info(
        "frames=%d, initial=%d, kept=%d (conf>%.2f, stride=%d)",
        n_frames, total_initial, total_kept, conf_threshold, downsample,
    )

    if total_kept == 0:
        log.warning("no points survived filtering — relax conf_threshold or downsample")
        return struct.pack("<IIII", MAGIC, VERSION, 0, STRIDE_BYTES)

    xyz = np.concatenate(xyz_chunks, axis=0)
    rgb = np.concatenate(rgb_chunks, axis=0)
    interleaved = np.ascontiguousarray(
        np.concatenate([xyz, rgb], axis=1).astype(np.float32, copy=False)
    )
    n = len(interleaved)
    header = struct.pack("<IIII", MAGIC, VERSION, n, STRIDE_BYTES)
    return header + interleaved.tobytes()


def get_or_build_cloud(
    session_output_dir: Path,
    conf_threshold: float = 1.0,
    downsample: int = 10,
) -> bytes:
    """Return cached cloud.<key>.bin if present, else build + cache."""
    suffix = f"v{VERSION}_c{conf_threshold:.2f}_d{downsample}"
    cache = session_output_dir / f"cloud.{suffix}.bin"
    preds = session_output_dir / "predictions.pt"
    images = session_output_dir / "images.pt"

    if cache.exists():
        cache_mtime = cache.stat().st_mtime
        if (
            cache_mtime >= preds.stat().st_mtime
            and (not images.exists() or cache_mtime >= images.stat().st_mtime)
        ):
            return cache.read_bytes()

    if not preds.exists():
        raise FileNotFoundError(f"no predictions.pt at {preds}")
    if not images.exists():
        raise FileNotFoundError(
            f"no images.pt at {images} — re-run inference with the updated patch_demo.py"
        )

    blob = export_cloud(
        preds, images, conf_threshold=conf_threshold, downsample=downsample,
    )
    cache.write_bytes(blob)
    return blob
