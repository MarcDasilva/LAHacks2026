"""Modal app: video URL -> trained 3D Gaussian Splat (.splat) URL.

Pipeline (target: <10 min wall-clock on a warm A100):
  1. download video via requests
  2. ffmpeg samples up to MAX_FRAMES frames (≤1280px long edge)
  3. COLMAP: feature_extractor (GPU SIFT) + sequential_matcher + mapper
  4. gsplat simple_trainer trains ~MAX_STEPS iters, exports .ply
  5. .ply -> antimatter15 .splat format, returned as bytes

Deploy:
    modal deploy modal_app/splat.py

The dashboard hits the spawned `train_splat` via its FastAPI web endpoints:
    POST /spawn   {"video_url": "..."} -> {"call_id": "..."}
    GET  /result/{call_id}             -> 202 (running) | 200 binary | 5xx
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import modal

# Tunables — keep total budget under ~10 min on a warm A100.
MAX_FRAMES = 80
MAX_IMAGE_EDGE = 1280
MAX_STEPS = 7000
SH_DEGREE = 2

GSPLAT_VERSION = "1.4.0"

image = (
    modal.Image.from_registry(
        "nvidia/cuda:12.1.1-devel-ubuntu22.04",
        add_python="3.10",
    )
    .apt_install(
        "git",
        "wget",
        "curl",
        "ffmpeg",
        "colmap",
        "build-essential",
        "libgl1",
        "libglib2.0-0",
    )
    .pip_install(
        "torch==2.3.1",
        "torchvision==0.18.1",
        index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        f"gsplat=={GSPLAT_VERSION}",
        "numpy<2",
        "opencv-python-headless",
        "Pillow",
        "plyfile",
        "tqdm",
        "imageio",
        "imageio-ffmpeg",
        "scipy",
        "tensorboard",
        "tyro",
        "viser",
        "nerfview",
        "matplotlib",
        "splines",
        "jaxtyping",
        "trimesh",
        "splines",
        "pyyaml",
        "requests",
        "fastapi[standard]",
    )
    # Vendor gsplat examples (simple_trainer + COLMAP dataloader) and install
    # their full requirements file so we don't keep playing whack-a-mole with
    # missing transitive deps from nerfview/etc.
    .run_commands(
        "git clone --depth 1 --branch v" + GSPLAT_VERSION + " https://github.com/nerfstudio-project/gsplat /opt/gsplat",
        # gsplat's COLMAP dataloader expects rmbrualla's pycolmap fork
        # (provides `from pycolmap import SceneManager`), not the
        # colmap-project bindings package of the same name.
        "pip install git+https://github.com/rmbrualla/pycolmap.git",
    )
)

app = modal.App("impulse-splat", image=image)


# ── Helpers ────────────────────────────────────────────────────────────────

def _run(cmd: list[str], cwd: str | None = None) -> None:
    print(f"\n$ {' '.join(cmd)}", flush=True)
    env = os.environ.copy()
    # COLMAP unconditionally initializes Qt; force the offscreen platform
    # plugin so it doesn't try to connect to an X display.
    env.setdefault("QT_QPA_PLATFORM", "offscreen")
    # Capture stdout/stderr so failed runs surface the real traceback through
    # the FastAPI /result endpoint instead of just a generic exit code.
    proc = subprocess.run(
        cmd, cwd=cwd, env=env, capture_output=True, text=True
    )
    if proc.stdout:
        print(proc.stdout, flush=True)
    if proc.stderr:
        print(proc.stderr, flush=True)
    if proc.returncode != 0:
        tail = "\n".join((proc.stdout + proc.stderr).splitlines()[-40:])
        raise RuntimeError(
            f"{cmd[0]} exit {proc.returncode}; last 40 lines:\n{tail}"
        )


def _download(url: str, dest: Path) -> None:
    import requests

    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        with open(dest, "wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)


def _extract_frames(video: Path, images_dir: Path) -> int:
    images_dir.mkdir(parents=True, exist_ok=True)
    # Probe duration with ffprobe.
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1", str(video),
        ]
    ).decode().strip()
    duration = float(out) if out else 30.0
    fps = max(1.0, MAX_FRAMES / max(duration, 1.0))
    fps = min(fps, 4.0)  # never sample more than 4 fps
    _run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-vf", f"fps={fps},scale='min({MAX_IMAGE_EDGE},iw)':-2",
        "-q:v", "2",
        str(images_dir / "frame_%04d.jpg"),
    ])
    frames = sorted(images_dir.glob("frame_*.jpg"))
    # If we still ended up with too many, decimate.
    if len(frames) > MAX_FRAMES:
        keep_every = len(frames) / MAX_FRAMES
        kept = []
        for i, f in enumerate(frames):
            if int(i / keep_every) != int((i - 1) / keep_every) or i == 0:
                kept.append(f)
            else:
                f.unlink()
        frames = kept
    print(f"extracted {len(frames)} frames @ ~{fps:.2f} fps", flush=True)
    return len(frames)


def _run_colmap(workspace: Path) -> None:
    images_dir = workspace / "images"
    sparse_dir = workspace / "sparse"
    db = workspace / "database.db"
    sparse_dir.mkdir(parents=True, exist_ok=True)

    # GPU SIFT in COLMAP needs an OpenGL/EGL surface that headless Modal
    # containers don't provide (the container has CUDA but no display) — it
    # crashes with SIGABRT. CPU SIFT is ~2× slower but reliable; on ≤80
    # frames at 1280px it still fits comfortably in the budget.
    _run([
        "colmap", "feature_extractor",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--ImageReader.single_camera", "1",
        "--ImageReader.camera_model", "SIMPLE_PINHOLE",
        "--SiftExtraction.use_gpu", "0",
        "--SiftExtraction.max_image_size", str(MAX_IMAGE_EDGE),
    ])
    _run([
        "colmap", "sequential_matcher",
        "--database_path", str(db),
        "--SiftMatching.use_gpu", "0",
    ])
    _run([
        "colmap", "mapper",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir),
        "--Mapper.ba_global_function_tolerance", "0.000001",
    ])
    # gsplat dataloader expects sparse/0/cameras.bin etc — already produced.
    if not (sparse_dir / "0").exists():
        raise RuntimeError("COLMAP failed to produce sparse/0/")


def _colmap_points_to_splat(workspace: Path) -> bytes:
    """Read COLMAP's sparse/<best>/points3D.bin and emit antimatter15 .splat
    bytes (32 bytes per gaussian). Each sparse point becomes a small
    isotropic gaussian — not photoreal like a trained 3DGS, but renders fine
    in the splat viewer and avoids the gsplat training pipeline entirely."""
    import struct as _struct

    import numpy as np

    sparse_dir = workspace / "sparse"
    candidates = [p / "points3D.bin" for p in sorted(sparse_dir.iterdir()) if p.is_dir()]
    candidates = [p for p in candidates if p.exists()]
    if not candidates:
        raise RuntimeError("no points3D.bin found in COLMAP sparse output")
    points_path = max(candidates, key=lambda p: p.stat().st_size)

    pts: list[tuple[float, float, float]] = []
    rgbs: list[tuple[int, int, int]] = []
    with points_path.open("rb") as f:
        (num_points,) = _struct.unpack("<Q", f.read(8))
        for _ in range(num_points):
            f.read(8)  # point3D_id (u64)
            x, y, z = _struct.unpack("<3d", f.read(24))
            r, g, b = _struct.unpack("<3B", f.read(3))
            f.read(8)  # error (f64)
            (track_len,) = _struct.unpack("<Q", f.read(8))
            f.read(track_len * 8)  # tracks
            pts.append((x, y, z))
            rgbs.append((r, g, b))

    if not pts:
        raise RuntimeError("COLMAP reconstructed zero points")

    xyz = np.array(pts, dtype=np.float32)
    rgb = np.array(rgbs, dtype=np.uint8)

    centroid = np.median(xyz, axis=0)
    extent = float(np.median(np.linalg.norm(xyz - centroid, axis=1))) or 1.0
    splat_size = extent * 0.004

    n = xyz.shape[0]
    scales = np.full((n, 3), splat_size, dtype=np.float32)
    alpha = np.full((n, 1), 255, dtype=np.uint8)
    rgba_u8 = np.concatenate([rgb, alpha], axis=1)
    # Identity quaternion (w=1, xyz=0). .splat stores rot as
    # uint8(rot * 128 + 128); identity → (255, 128, 128, 128).
    rot_u8 = np.tile(np.array([255, 128, 128, 128], dtype=np.uint8), (n, 1))

    buf = io.BytesIO()
    for i in range(n):
        buf.write(xyz[i].tobytes())
        buf.write(scales[i].tobytes())
        buf.write(rgba_u8[i].tobytes())
        buf.write(rot_u8[i].tobytes())
    print(f"wrote {n} points as .splat ({buf.tell()} bytes)", flush=True)
    return buf.getvalue()


# ── Modal function ────────────────────────────────────────────────────────

@app.function(
    # No GPU — we dropped 3DGS training; the COLMAP step uses CPU SIFT.
    timeout=900,
    min_containers=0,
)
def train_splat(video_url: str) -> bytes:
    """Download video → COLMAP → gsplat → .splat bytes."""
    print("train_splat code v7 (CPU SIFT, QT_QPA_PLATFORM=offscreen)", flush=True)
    workdir = Path(tempfile.mkdtemp(prefix="splat_"))
    try:
        video_path = workdir / "input.mp4"
        print(f"downloading {video_url} → {video_path}", flush=True)
        _download(video_url, video_path)

        n = _extract_frames(video_path, workdir / "images")
        if n < 8:
            raise RuntimeError(f"only {n} frames extracted; need ≥8")

        _run_colmap(workdir)
        return _colmap_points_to_splat(workdir)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


# ── Web endpoints (FastAPI) ───────────────────────────────────────────────

@app.function()
@modal.asgi_app()
def web():
    # Imports kept inside the function so the local Modal CLI (which doesn't
    # have pydantic/fastapi installed) can still parse this file.
    from typing import Annotated, Any, Dict, Optional

    from fastapi import Body, FastAPI, Header, HTTPException
    from fastapi.responses import JSONResponse, Response

    print("impulse-splat web v6 booting", flush=True)
    api = FastAPI(title="impulse-splat", version="6")

    def _check_auth(authorization: Optional[str]) -> None:
        expected = os.environ.get("IMPULSE_SPLAT_TOKEN")
        if not expected:
            return
        got = (authorization or "").removeprefix("Bearer ").strip()
        if got != expected:
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/health")
    async def health():
        return {"ok": True, "version": 6}

    @api.post("/spawn")
    async def spawn(
        video_url: str = Body(..., embed=True),
        authorization: Optional[str] = Header(default=None),
    ):
        _check_auth(authorization)
        if not video_url:
            raise HTTPException(status_code=400, detail="video_url required")
        call = train_splat.spawn(video_url)
        return JSONResponse({"call_id": call.object_id})

    @api.get("/result/{call_id}")
    async def result(
        call_id: str,
        authorization: Optional[str] = Header(default=None),
    ):
        _check_auth(authorization)
        fc = modal.FunctionCall.from_id(call_id)
        try:
            data: bytes = fc.get(timeout=0)
        except modal.exception.OutputExpiredError:
            raise HTTPException(status_code=410, detail="output expired")
        except TimeoutError:
            return Response(status_code=202)
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
        return Response(content=data, media_type="application/octet-stream")

    return api
