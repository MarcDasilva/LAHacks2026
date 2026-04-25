"""HTTP frame ingest.

The iOS Responder app (or any client) POSTs JPEG frames here, one per
request. Frames are stored under frames/<session_id>/ with a filename
that preserves capture order so demo.py's --image_folder mode loads them
in the right sequence.

Kept deliberately small — no auth, no DB, no queue. The inference runner
watches the filesystem.
"""
from __future__ import annotations

import re
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
    points: int = 100_000,
    conf: float = 0.5,
    outlier_pct: float = 1.0,
) -> Response:
    """Binary point cloud for browser rendering. See cloud_export for format."""
    _validate_session_id(session_id)
    state = sessions.load(session_id)
    if state is None:
        raise HTTPException(404, "no such session")
    if state.status != "done":
        raise HTTPException(409, f"session is {state.status}, not done")

    try:
        blob = cloud_export.get_or_build_cloud(
            config.session_output_dir(session_id),
            target_points=points,
            conf_threshold=conf,
            outlier_percentile=outlier_pct,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e))

    return Response(content=blob, media_type="application/octet-stream")
