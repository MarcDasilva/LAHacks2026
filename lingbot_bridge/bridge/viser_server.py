"""Streaming 3D viewer.

A long-lived viser.ViserServer that the inference runner pushes points
into as each frame's depth gets unprojected. The dashboard embeds the
viser web client in an iframe so the user sees the cloud build up live
instead of waiting for the full export.

One ViserServer per process (started from inference_runner.main). Per-
session scenes live under /sessions/{id}/... so multiple sessions can
coexist without stepping on each other.

Falls back to a no-op stub if `viser` isn't importable, so the bridge
still runs in environments where the dep is missing — the existing LBMP
HTTP path (cloud_export.get_or_build_cloud) keeps working.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from . import config

log = logging.getLogger("viser_server")

_server: Any = None
_lock = threading.Lock()
# session_id -> {"frames": {idx: handle}, "frustums": {idx: handle}}
_sessions: dict[str, dict[str, dict[int, Any]]] = {}


def start() -> None:
    """Idempotently boot the viser server. Safe to call multiple times."""
    global _server
    if not config.VISER_ENABLED:
        log.info("viser disabled (INGEST_VISER_ENABLED=0)")
        return
    with _lock:
        if _server is not None:
            return
        try:
            import viser  # type: ignore
        except ImportError:
            log.warning("viser not installed — streaming viewer disabled")
            return
        try:
            _server = viser.ViserServer(host="0.0.0.0", port=config.VISER_PORT)
            log.info("viser up on :%d", config.VISER_PORT)
        except Exception:
            log.exception("failed to start viser server")
            _server = None


def is_running() -> bool:
    return _server is not None


def _session_state(session_id: str) -> dict[str, dict[int, Any]]:
    s = _sessions.get(session_id)
    if s is None:
        s = {"frames": {}, "frustums": {}}
        _sessions[session_id] = s
    return s


def clear_session(session_id: str) -> None:
    """Remove all scene nodes for a session. Call before re-running inference
    on a session whose stream is still in viser memory from a prior run."""
    if _server is None:
        return
    state = _sessions.pop(session_id, None)
    if state is None:
        return
    with _lock:
        for handle in list(state["frames"].values()) + list(state["frustums"].values()):
            try:
                handle.remove()
            except Exception:
                log.debug("viser handle.remove failed (already gone?)", exc_info=True)


def add_frame_points(
    session_id: str,
    frame_idx: int,
    xyz,
    rgb,
    point_size: float = 0.01,
) -> None:
    """Append one frame's points to the viser scene. xyz/rgb are (M,3) numpy
    arrays (float32 xyz; rgb in [0,1] float)."""
    if _server is None:
        return
    if len(xyz) == 0:
        return
    name = f"/sessions/{session_id}/frames/{frame_idx:04d}"
    try:
        # viser expects rgb as uint8 in [0,255].
        import numpy as np  # type: ignore

        colors_u8 = (np.clip(rgb, 0.0, 1.0) * 255.0).astype(np.uint8)
        with _lock:
            handle = _server.scene.add_point_cloud(
                name=name,
                points=xyz,
                colors=colors_u8,
                point_size=point_size,
                point_shape="circle",
            )
            _session_state(session_id)["frames"][frame_idx] = handle
    except Exception:
        log.exception("viser add_point_cloud failed for %s", name)


def add_camera_frustum(
    session_id: str,
    frame_idx: int,
    extrinsic,
    intrinsic,
    image_aspect: float = 1.0,
    scale: float = 0.05,
) -> None:
    """Add a camera-pose frustum at the given frame. extrinsic is (3,4) world-
    to-camera; we invert to get camera-to-world for viser's pose convention."""
    if _server is None:
        return
    try:
        import numpy as np  # type: ignore

        from .cloud_export import _closed_form_inverse_se3

        cam_to_world = _closed_form_inverse_se3(np.asarray(extrinsic))
        R = cam_to_world[:3, :3]
        t = cam_to_world[:3, 3]
        # viser uses wxyz quaternion; derive from R via a small helper.
        wxyz = _rotation_matrix_to_wxyz(R)
        intr = np.asarray(intrinsic)
        fy = float(intr[1, 1])
        # Approximate vertical FOV from intrinsic. height ≈ 2*cy is a safe proxy.
        cy = float(intr[1, 2])
        fov = 2.0 * np.arctan2(cy, fy)
        name = f"/sessions/{session_id}/cameras/{frame_idx:04d}"
        with _lock:
            handle = _server.scene.add_camera_frustum(
                name=name,
                fov=float(fov),
                aspect=float(image_aspect),
                scale=float(scale),
                wxyz=wxyz,
                position=tuple(float(x) for x in t),
                color=(0x39, 0xFF, 0x14),
            )
            _session_state(session_id)["frustums"][frame_idx] = handle
    except Exception:
        log.exception("viser add_camera_frustum failed")


def _rotation_matrix_to_wxyz(R):
    """Standard 3x3 → quaternion (w,x,y,z). Numerically stable branchy form."""
    import numpy as np  # type: ignore

    m00, m01, m02 = R[0, 0], R[0, 1], R[0, 2]
    m10, m11, m12 = R[1, 0], R[1, 1], R[1, 2]
    m20, m21, m22 = R[2, 0], R[2, 1], R[2, 2]
    tr = m00 + m11 + m22
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m21 - m12) / s
        y = (m02 - m20) / s
        z = (m10 - m01) / s
    elif (m00 > m11) and (m00 > m22):
        s = np.sqrt(1.0 + m00 - m11 - m22) * 2
        w = (m21 - m12) / s
        x = 0.25 * s
        y = (m01 + m10) / s
        z = (m02 + m20) / s
    elif m11 > m22:
        s = np.sqrt(1.0 + m11 - m00 - m22) * 2
        w = (m02 - m20) / s
        x = (m01 + m10) / s
        y = 0.25 * s
        z = (m12 + m21) / s
    else:
        s = np.sqrt(1.0 + m22 - m00 - m11) * 2
        w = (m10 - m01) / s
        x = (m02 + m20) / s
        y = (m12 + m21) / s
        z = 0.25 * s
    return (float(w), float(x), float(y), float(z))
