"""Export a colored point cloud from a session — 1:1 match of the upstream
lingbot_map viser viewer pipeline (lingbot_map/vis/point_cloud_viewer.py).

The upstream viewer's `_process_pred_dict` does:

    images        = pred_dict["images"].permute(0,2,3,1)   # (S,H,W,3) RGB float
    depth_map     = pred_dict["depth"]                     # (S,H,W,1)
    depth_conf    = pred_dict["depth_conf"]                # (S,H,W)
    extrinsic     = pred_dict["extrinsic"]                 # (S,3,4) camera-to-world
    intrinsic     = pred_dict["intrinsic"]                 # (S,3,3)

    world_points  = unproject_depth_map_to_point_map(depth_map, extrinsic, intrinsic)

    # parse_pc_data per frame:
    pts  = world_points[i].reshape(-1,3)
    col  = images[i].reshape(-1,3)
    c    = depth_conf[i].reshape(-1)
    drop NaN/Inf points
    if any NaN colors: col[:] = blue
    keep where c > vis_threshold (default 1.0)
    stride downsample by N (default 10)

    concatenate across frames

We mirror this exactly. **Note we re-unproject depth — we do NOT use
`predictions["world_points"]`, which appears to be in per-frame camera
space and produces a blob when concatenated.**

Output is the v2 binary format the dashboard already reads:
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
STRIDE_BYTES: Final = 24

# "LBFS" — frustum (camera pose) binary, separate from cloud.
FRUSTUM_MAGIC: Final = 0x4C424653
FRUSTUM_VERSION: Final = 1
FRUSTUM_STRIDE: Final = 48  # 3x4 fp32 extrinsic = 12 floats


def _closed_form_inverse_se3(extrinsic):
    """Invert a (3,4) [R|t] camera matrix. R^T, -R^T t.

    The upstream code calls these "camera-to-world" but operates on them as
    if they need inverting before unprojecting — we replicate that exactly.
    """
    import numpy as np

    R = extrinsic[:3, :3]
    t = extrinsic[:3, 3]
    R_inv = R.T
    t_inv = -R_inv @ t
    inv = np.zeros((3, 4), dtype=np.float32)
    inv[:3, :3] = R_inv
    inv[:3, 3] = t_inv
    return inv


def _depth_to_world_points(depth_map, extrinsic, intrinsic):
    """Unproject (H,W) depth → (H,W,3) world points. Matches upstream's
    geometry.depth_to_world_coords_points.
    """
    import numpy as np

    H, W = depth_map.shape
    fu, fv = intrinsic[0, 0], intrinsic[1, 1]
    cu, cv = intrinsic[0, 2], intrinsic[1, 2]

    u = np.arange(W, dtype=np.float32)
    v = np.arange(H, dtype=np.float32)
    uu, vv = np.meshgrid(u, v)

    # Camera-frame coords.
    x_cam = (uu - cu) * depth_map / fu
    y_cam = (vv - cv) * depth_map / fv
    z_cam = depth_map
    cam = np.stack((x_cam, y_cam, z_cam), axis=-1).astype(np.float32)  # (H,W,3)

    # Upstream applies closed_form_inverse_se3 to extrinsic before transform.
    cam_to_world = _closed_form_inverse_se3(extrinsic)
    R = cam_to_world[:3, :3]
    t = cam_to_world[:3, 3]
    world = cam @ R.T + t  # (H,W,3)
    return world


def export_cloud(
    predictions_path: Path,
    images_path: Path,
    conf_threshold: float = 1.0,
    downsample: int = 10,
) -> bytes:
    """Mirror of lingbot_map.vis.point_cloud_viewer pipeline, packed as bytes."""
    import numpy as np
    import torch

    log.info("loading %s", predictions_path)
    preds = torch.load(predictions_path, map_location="cpu", weights_only=False)
    log.info("loading %s", images_path)
    images_t = torch.load(images_path, map_location="cpu", weights_only=False)

    if "depth" not in preds:
        raise ValueError("predictions missing 'depth' — cannot unproject")
    if "extrinsic" not in preds or "intrinsic" not in preds:
        raise ValueError("predictions missing extrinsic/intrinsic — cannot unproject")

    depth = preds["depth"]                      # (N, H, W, 1) or (N, H, W)
    depth_conf = preds.get("depth_conf")        # (N, H, W)
    extrinsic = preds["extrinsic"]              # (N, 3, 4)
    intrinsic = preds["intrinsic"]              # (N, 3, 3)

    # depth might be (N,H,W,1); squeeze last axis if so.
    if depth.ndim == 4 and depth.shape[-1] == 1:
        depth = depth.squeeze(-1)

    if images_t.ndim != 4 or images_t.shape[1] != 3:
        raise ValueError(f"images.pt has unexpected shape {tuple(images_t.shape)}")
    colors_all = images_t.permute(0, 2, 3, 1).contiguous()  # (N,H,W,3) RGB float

    n_frames = depth.shape[0]
    if colors_all.shape[0] != n_frames:
        raise ValueError(f"frame mismatch: depth={n_frames}, images={colors_all.shape[0]}")

    depth_np = depth.numpy() if hasattr(depth, "numpy") else np.asarray(depth)
    extr_np = extrinsic.numpy() if hasattr(extrinsic, "numpy") else np.asarray(extrinsic)
    intr_np = intrinsic.numpy() if hasattr(intrinsic, "numpy") else np.asarray(intrinsic)
    conf_np = (
        depth_conf.numpy() if depth_conf is not None and hasattr(depth_conf, "numpy")
        else (np.asarray(depth_conf) if depth_conf is not None else None)
    )

    xyz_chunks: list = []
    rgb_chunks: list = []
    total_initial = 0
    total_kept = 0

    for i in range(n_frames):
        # Unproject depth → world for this frame, matching upstream geometry.
        pts = _depth_to_world_points(depth_np[i], extr_np[i], intr_np[i]).reshape(-1, 3)
        col = colors_all[i].reshape(-1, 3).numpy()
        c = conf_np[i].reshape(-1) if conf_np is not None else None
        total_initial += len(pts)

        valid = np.isfinite(pts).all(axis=1)
        if not valid.all():
            pts = pts[valid]
            col = col[valid]
            if c is not None:
                c = c[valid]

        if np.isnan(col).any():
            col = np.zeros_like(col)
            col[:, 2] = 1.0  # blue fallback

        if c is not None:
            mask = c > conf_threshold
            pts = pts[mask]
            col = col[mask]

        if downsample > 1 and len(pts) > 0:
            idx = np.arange(0, len(pts), downsample)
            pts = pts[idx]
            col = col[idx]

        if len(pts) > 0:
            xyz_chunks.append(pts.astype(np.float32, copy=False))
            rgb_chunks.append(col.astype(np.float32, copy=False))
            total_kept += len(pts)

    log.info(
        "frames=%d, initial=%d, kept=%d (depth_conf>%.2f, stride=%d)",
        n_frames, total_initial, total_kept, conf_threshold, downsample,
    )

    if total_kept == 0:
        log.warning("no points survived filtering")
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
    suffix = f"v{VERSION}d_c{conf_threshold:.2f}_d{downsample}"  # `d` = depth-unproject path
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


def export_frustums(predictions_path: Path) -> bytes:
    """Pack the per-frame extrinsics from predictions.pt into a small binary
    so the dashboard can render camera-pose pyramids without loading torch.
    """
    import numpy as np
    import torch

    preds = torch.load(predictions_path, map_location="cpu", weights_only=False)
    if "extrinsic" not in preds:
        raise ValueError("predictions missing 'extrinsic'")
    extr = preds["extrinsic"]
    extr_np = extr.numpy() if hasattr(extr, "numpy") else np.asarray(extr)
    extr_np = np.ascontiguousarray(extr_np.astype(np.float32, copy=False))
    n = extr_np.shape[0]
    header = struct.pack(
        "<IIII", FRUSTUM_MAGIC, FRUSTUM_VERSION, n, FRUSTUM_STRIDE,
    )
    return header + extr_np.tobytes()


def get_or_build_frustums(session_output_dir: Path) -> bytes:
    cache = session_output_dir / "frustums.v1.bin"
    preds = session_output_dir / "predictions.pt"
    if cache.exists() and preds.exists():
        if cache.stat().st_mtime >= preds.stat().st_mtime:
            return cache.read_bytes()
    if not preds.exists():
        raise FileNotFoundError(f"no predictions.pt at {preds}")
    blob = export_frustums(preds)
    cache.write_bytes(blob)
    return blob
