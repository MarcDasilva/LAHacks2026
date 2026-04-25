"""Export a downsampled point cloud from a session's predictions.pt.

predictions.pt is ~1 GB of dense per-pixel tensors. The browser viewer
only needs ~50–200k XYZ points, so we filter by confidence, stride
pixels, and pack the result as a flat Float32Array (x,y,z per point).

The downsampled binary is cached at outputs/<session>/cloud.bin so
subsequent requests don't pay the torch.load cost.

File format (little-endian):
    [0:4]   uint32  magic   = 0x4c424d50  ("LBMP")
    [4:8]   uint32  version = 1
    [8:12]  uint32  num_points
    [12:16] uint32  stride_bytes (12 = xyz only, 24 = xyzrgb fp32)
    [16:N]  Float32Array of length num_points * (stride_bytes/4)
"""
from __future__ import annotations

import logging
import struct
from pathlib import Path
from typing import Final

log = logging.getLogger("cloud_export")

MAGIC: Final = 0x4C424D50
VERSION: Final = 1
HEADER_SIZE: Final = 16


def export_cloud(
    predictions_path: Path,
    target_points: int = 100_000,
    conf_threshold: float = 0.5,
) -> bytes:
    """Load predictions.pt → downsample → pack as bytes."""
    import numpy as np
    import torch

    log.info("loading %s", predictions_path)
    preds = torch.load(predictions_path, map_location="cpu", weights_only=False)

    world_points = preds["world_points"]  # (N, H, W, 3) or (N*H*W, 3)
    conf = preds.get("world_points_conf")  # (N, H, W) or None

    pts = world_points.reshape(-1, 3).numpy()
    if conf is not None:
        c = conf.reshape(-1).numpy()
        mask = c > conf_threshold
        pts = pts[mask]
        log.info("after conf>%.2f filter: %d / %d points", conf_threshold, len(pts), mask.size)

    if len(pts) > target_points:
        idx = np.random.default_rng(seed=0).choice(len(pts), target_points, replace=False)
        pts = pts[idx]

    pts = np.ascontiguousarray(pts, dtype=np.float32)
    n = len(pts)
    log.info("exporting %d points", n)

    header = struct.pack("<IIII", MAGIC, VERSION, n, 12)
    return header + pts.tobytes()


def get_or_build_cloud(
    session_output_dir: Path,
    target_points: int = 100_000,
    conf_threshold: float = 0.5,
) -> bytes:
    """Return cached cloud.bin if present, else build + cache."""
    cache = session_output_dir / "cloud.bin"
    preds = session_output_dir / "predictions.pt"

    if cache.exists() and cache.stat().st_mtime >= preds.stat().st_mtime:
        return cache.read_bytes()

    if not preds.exists():
        raise FileNotFoundError(f"no predictions.pt at {preds}")

    blob = export_cloud(preds, target_points=target_points, conf_threshold=conf_threshold)
    cache.write_bytes(blob)
    return blob
