"""Tiny on-disk session state.

A session is just a directory of frames plus a JSON sidecar tracking
status. Using files (not a DB) keeps the bridge self-contained and lets
the inference runner and the ingest server be separate processes that
don't need an IPC channel beyond the filesystem.
"""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Literal

from . import config

Status = Literal["recording", "queued", "reconstructing", "done", "failed"]


@dataclass
class SessionState:
    session_id: str
    status: Status = "recording"
    frames: int = 0
    last_frame_at: float = 0.0
    started_at: float = field(default_factory=time.time)
    closed_at: float | None = None
    error: str | None = None


def load(session_id: str) -> SessionState | None:
    path = config.session_state_path(session_id)
    if not path.exists():
        return None
    return SessionState(**json.loads(path.read_text()))


def save(state: SessionState) -> None:
    path = config.session_state_path(state.session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(state)))
    tmp.replace(path)


def get_or_create(session_id: str) -> SessionState:
    s = load(session_id)
    if s is None:
        s = SessionState(session_id=session_id)
        save(s)
    return s


def list_all() -> list[SessionState]:
    if not config.SESSIONS_DIR.exists():
        return []
    out = []
    for p in sorted(config.SESSIONS_DIR.glob("*.json")):
        try:
            out.append(SessionState(**json.loads(p.read_text())))
        except Exception:
            continue
    return out
