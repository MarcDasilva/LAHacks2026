"""Shared config for ingest + api + recorder.

The recorder writes 5s mp4 segments to CLIPS_DIR with filenames keyed by
the unix-epoch start of the segment (clock-aligned via FFmpeg). The ingest
worker computes the same key from the window's started_at and stamps that
path as `video_uri`. The API serves files from CLIPS_DIR over HTTP.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

_DEFAULT_CLIPS_DIR = Path(__file__).resolve().parent.parent / "data" / "clips"
CLIPS_DIR = Path(os.environ.get("CLIPS_DIR", _DEFAULT_CLIPS_DIR))
CLIP_PREFIX = "clip-"
CLIP_SUFFIX = ".mp4"


def clip_filename(started_at: datetime) -> str:
    return f"{CLIP_PREFIX}{int(started_at.timestamp())}{CLIP_SUFFIX}"


def clip_path(started_at: datetime) -> Path:
    return CLIPS_DIR / clip_filename(started_at)


def clip_uri(started_at: datetime) -> str | None:
    """Return a public URI the API will serve for this clip, or None if the
    file isn't on disk yet (e.g. ingest is running ahead of the recorder,
    or we're processing JSON without recorded video)."""
    p = clip_path(started_at)
    if not p.exists():
        return None
    return f"/clips/{clip_filename(started_at)}"
