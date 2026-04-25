"""HTTP frame ingest.

The iOS Responder app (or any client) POSTs JPEG frames here, one per
request. Frames are stored under frames/<session_id>/ with a filename
that preserves capture order so demo.py's --image_folder mode loads them
in the right sequence.

Kept deliberately small — no auth, no DB, no queue. The inference runner
watches the filesystem.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import time

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from . import cloud_export, config, sessions

app = FastAPI(title="lingbot_bridge ingest")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_SESSION_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def _validate_session_id(session_id: str) -> None:
    if not _SESSION_RE.match(session_id):
        raise HTTPException(400, "invalid session_id (alnum, _, -, ≤64 chars)")


@app.on_event("startup")
def _startup() -> None:
    config.ensure_dirs()


@app.get("/health")
def health() -> dict:
    gpu = False
    try:
        import torch  # type: ignore

        gpu = torch.cuda.is_available()
    except Exception:
        pass
    return {"ok": True, "gpu": gpu, "inference_disabled": config.DISABLE_INFERENCE}


@app.post("/sessions/{session_id}/frames")
async def upload_frame(session_id: str, file: UploadFile = File(...)) -> dict:
    _validate_session_id(session_id)

    state = sessions.get_or_create(session_id)
    if state.status not in ("recording",):
        raise HTTPException(409, f"session is {state.status}, not accepting frames")

    body = await file.read()
    if not body:
        raise HTTPException(400, "empty upload")

    frame_dir = config.session_frames_dir(session_id)
    frame_dir.mkdir(parents=True, exist_ok=True)

    seq = state.frames
    # Lexicographic order = capture order. Pad seq so demo.py's sorted
    # glob loads them in the right sequence even past 10k frames.
    name = f"{seq:08d}.jpg"
    path = frame_dir / name
    path.write_bytes(body)

    state.frames = seq + 1
    state.last_frame_at = time.time()
    sessions.save(state)

    return {"ok": True, "path": str(path.relative_to(config.ROOT)), "seq": seq}


@app.post("/sessions/{session_id}/video")
async def upload_video(
    session_id: str,
    file: UploadFile = File(...),
    fps: float = 5.0,
) -> dict:
    """One-shot video upload: streams an MP4 to disk, ffmpeg-decodes into
    `frames/<sid>/00000000.jpg…` so the rest of the pipeline (which only
    knows about per-frame uploads) doesn't need to change. Auto-marks the
    session 'queued' since one video == one capture.
    """
    _validate_session_id(session_id)
    state = sessions.get_or_create(session_id)
    if state.status != "recording":
        raise HTTPException(409, f"session is {state.status}, not accepting video")

    frame_dir = config.session_frames_dir(session_id)
    frame_dir.mkdir(parents=True, exist_ok=True)
    seq_start = state.frames

    # Stream to a temp file rather than reading the whole MP4 into memory.
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp_path = tmp.name
    try:
        cmd = [
            "ffmpeg", "-y", "-i", tmp_path,
            "-vf", f"fps={fps}",
            "-qscale:v", "2",
            "-an",
            "-start_number", str(seq_start),
            str(frame_dir / "%08d.jpg"),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise HTTPException(500, f"ffmpeg failed: {proc.stderr[-500:]}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    state.frames = len(list(frame_dir.glob("*.jpg")))
    state.last_frame_at = time.time()
    state.status = "queued"
    state.closed_at = time.time()
    sessions.save(state)
    return {"ok": True, "frames": state.frames, "status": state.status}


@app.post("/sessions/{session_id}/close")
def close_session(session_id: str) -> dict:
    _validate_session_id(session_id)
    state = sessions.load(session_id)
    if state is None:
        raise HTTPException(404, "no such session")
    if state.status == "recording":
        state.status = "queued"
        state.closed_at = time.time()
        sessions.save(state)
    return {"ok": True, "status": state.status, "frames": state.frames}


@app.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    _validate_session_id(session_id)
    state = sessions.load(session_id)
    if state is None:
        raise HTTPException(404, "no such session")
    out = state.__dict__.copy()
    out_dir = config.session_output_dir(session_id)
    out["output_dir"] = str(out_dir.relative_to(config.ROOT)) if out_dir.exists() else None
    return out


@app.get("/sessions")
def list_sessions() -> list[dict]:
    return [s.__dict__ for s in sessions.list_all()]


@app.get("/sessions/{session_id}/cloud")
def get_cloud(
    session_id: str,
    conf: float = 1.0,
    downsample: int = 10,
) -> Response:
    """Binary point cloud for browser rendering — mirrors upstream defaults
    (vis_threshold=1.0, downsample_factor=10). See cloud_export for format.
    """
    _validate_session_id(session_id)
    state = sessions.load(session_id)
    if state is None:
        raise HTTPException(404, "no such session")
    if state.status != "done":
        raise HTTPException(409, f"session is {state.status}, not done")

    try:
        blob = cloud_export.get_or_build_cloud(
            config.session_output_dir(session_id),
            conf_threshold=conf,
            downsample=downsample,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))

    return Response(content=blob, media_type="application/octet-stream")


@app.get("/sessions/{session_id}/frustums")
def get_frustums(session_id: str) -> Response:
    """Binary camera-pose blob for rendering frustum pyramids alongside the
    point cloud. See cloud_export.export_frustums for format.
    """
    _validate_session_id(session_id)
    state = sessions.load(session_id)
    if state is None:
        raise HTTPException(404, "no such session")
    if state.status != "done":
        raise HTTPException(409, f"session is {state.status}, not done")
    try:
        blob = cloud_export.get_or_build_frustums(
            config.session_output_dir(session_id),
        )
    except (FileNotFoundError, ValueError) as e:
        raise HTTPException(404, str(e))
    return Response(content=blob, media_type="application/octet-stream")
