"""Shared paths + tunables for the bridge.

Single source of truth so the ingest server and the inference runner agree
on where frames land, where outputs go, and how to call demo.py.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FRAMES_DIR = Path(os.environ.get("FRAMES_DIR", ROOT / "frames"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", ROOT / "outputs"))
SESSIONS_DIR = Path(os.environ.get("SESSIONS_DIR", ROOT / "state" / "sessions"))

LINGBOT_REPO = Path(os.environ.get("LINGBOT_REPO_PATH", "/opt/lingbot-map"))
LINGBOT_MODEL_PATH = Path(
    os.environ.get("LINGBOT_MODEL_PATH", ROOT / "models" / "lingbot-map.pt")
)
LINGBOT_MODE = os.environ.get("LINGBOT_MODE", "streaming")  # streaming | windowed
LINGBOT_FPS = int(os.environ.get("LINGBOT_FPS", "10"))
LINGBOT_WINDOW_SIZE = int(os.environ.get("LINGBOT_WINDOW_SIZE", "64"))

MASK_SKY = os.environ.get("MASK_SKY", "0") == "1"
USE_SDPA = os.environ.get("USE_SDPA", "0") == "1"

INGEST_PORT = int(os.environ.get("INGEST_PORT", "8001"))
DISABLE_INFERENCE = os.environ.get("INGEST_DISABLE_INFERENCE", "0") == "1"

# Streaming viser viewer. The dashboard embeds this in an iframe so users see
# the cloud build up frame-by-frame instead of waiting for the full export.
VISER_PORT = int(os.environ.get("INGEST_VISER_PORT", "8890"))
VISER_ENABLED = os.environ.get("INGEST_VISER_ENABLED", "1") == "1"

# Session is considered "closed" by the runner if no new frames arrived
# in this many seconds AND the client hasn't explicitly POSTed /close.
SESSION_IDLE_SECONDS = int(os.environ.get("SESSION_IDLE_SECONDS", "30"))


def session_frames_dir(session_id: str) -> Path:
    return FRAMES_DIR / session_id


def session_output_dir(session_id: str) -> Path:
    return OUTPUTS_DIR / session_id


def session_state_path(session_id: str) -> Path:
    return SESSIONS_DIR / f"{session_id}.json"


def ensure_dirs() -> None:
    for d in (FRAMES_DIR, OUTPUTS_DIR, SESSIONS_DIR):
        d.mkdir(parents=True, exist_ok=True)
