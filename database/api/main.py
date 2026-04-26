"""FastAPI search service.

  POST /search
    body: { q, k?, since?, until?, labels?, camera_id? }
    -> top-k chunks ranked by cosine similarity to the query embedding,
       with optional time-range, label, and camera filters.

  GET  /chunks/{chunk_id}        full row (incl. raw_json) for a hit
  POST /ingest/events            merge live yolo/stt/yamnet events into DB
  GET  /clips/<camera>/clip-*.mp4    static-served 5s mp4s (range-aware)

CORS is wide-open; tighten via CORS_ORIGINS env var (comma-sep) if needed.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from ingest.config import CLIPS_DIR, clip_relative_path
from ingest.db import default_dsn
from ingest.embed import embed
from ingest.store import ingest_record

DSN = default_dsn()
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",")]


class SearchRequest(BaseModel):
    q: str = Field(..., min_length=1)
    k: int = Field(5, ge=1, le=50)
    since: datetime | None = None
    until: datetime | None = None
    labels: list[str] | None = None  # any-of: chunk must contain at least one
    camera_id: str | None = None


class SearchHit(BaseModel):
    chunk_id: int
    camera_id: str
    session_id: str | None
    started_at: datetime
    ended_at: datetime
    video_url: str | None
    labels: list[str]
    yolo_text: str
    stt_text: str
    yamnet_text: str
    score: float


pool: ConnectionPool | None = None


def _configure(conn: psycopg.Connection) -> None:
    register_vector(conn)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pool
    pool = ConnectionPool(DSN, min_size=1, max_size=4, configure=_configure)
    try:
        yield
    finally:
        if pool is not None:
            pool.close()


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

CLIPS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/clips", StaticFiles(directory=str(CLIPS_DIR)), name="clips")


def _resolve_video_url(stored_uri: str | None, started_at: datetime, camera_id: str) -> str | None:
    """Always re-derive the path from the timestamp, in case the recorder
    wrote the file after ingest. Falls back to whatever was stored."""
    candidate = CLIPS_DIR / clip_relative_path(started_at, camera_id)
    if candidate.exists():
        return f"/clips/{clip_relative_path(started_at, camera_id).as_posix()}"
    return stored_uri


@app.post("/search", response_model=list[SearchHit])
def search(req: SearchRequest) -> list[SearchHit]:
    vec = embed(req.q)
    label_filter = req.labels or None  # None disables the filter
    camera_filter = req.camera_id or None

    sql = """
        SELECT id, camera_id, session_id, started_at, ended_at, video_uri, labels,
               yolo_text, stt_text, yamnet_text,
               1 - (embedding <=> %s) AS score
        FROM chunks
        WHERE (%s::timestamptz IS NULL OR started_at >= %s)
          AND (%s::timestamptz IS NULL OR ended_at   <= %s)
          AND (%s::text[]      IS NULL OR labels && %s::text[])
          AND (%s::text        IS NULL OR camera_id = %s::text)
        ORDER BY embedding <=> %s
        LIMIT %s
    """

    if pool is None:
        raise HTTPException(status_code=503, detail="db pool not ready")
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            sql,
            (
                vec,
                req.since, req.since,
                req.until, req.until,
                label_filter, label_filter,
                camera_filter, camera_filter,
                vec,
                req.k,
            ),
        )
        rows = cur.fetchall()

    return [
        SearchHit(
            chunk_id=r[0],
            camera_id=r[1],
            session_id=r[2],
            started_at=r[3],
            ended_at=r[4],
            video_url=_resolve_video_url(r[5], r[3], r[1]),
            labels=list(r[6] or []),
            yolo_text=r[7] or "",
            stt_text=r[8] or "",
            yamnet_text=r[9] or "",
            score=float(r[10]),
        )
        for r in rows
    ]


@app.get("/chunks/{chunk_id}")
def get_chunk(chunk_id: int) -> dict:
    if pool is None:
        raise HTTPException(status_code=503, detail="db pool not ready")
    with pool.connection() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, camera_id, session_id, started_at, ended_at, video_uri, labels,
                   yolo_text, stt_text, yamnet_text, raw_json
            FROM chunks WHERE id = %s
            """,
            (chunk_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="chunk not found")
    return {
        "chunk_id": row[0],
        "camera_id": row[1],
        "session_id": row[2],
        "started_at": row[3],
        "ended_at": row[4],
        "video_url": _resolve_video_url(row[5], row[3], row[1]),
        "labels": list(row[6] or []),
        "yolo_text": row[7] or "",
        "stt_text": row[8] or "",
        "yamnet_text": row[9] or "",
        "raw_json": row[10],
    }


@app.post("/ingest/events")
def ingest_events(payload: dict[str, Any] | list[dict[str, Any]]) -> dict:
    records = payload if isinstance(payload, list) else [payload]
    if not records:
        raise HTTPException(status_code=400, detail="payload must include at least one event")
    if pool is None:
        raise HTTPException(status_code=503, detail="db pool not ready")

    processed: list[dict[str, Any]] = []
    with pool.connection() as conn, conn.cursor() as cur:
        for record in records:
            try:
                chunk = ingest_record(cur, record)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            processed.append(
                {
                    "camera_id": chunk["camera_id"],
                    "session_id": chunk.get("session_id"),
                    "started_at": chunk["started_at"],
                    "ended_at": chunk["ended_at"],
                    "video_url": _resolve_video_url(chunk.get("video_uri"), chunk["started_at"], chunk["camera_id"]),
                    "labels": chunk.get("labels", []),
                }
            )
        conn.commit()

    return {"ok": True, "processed": processed}


@app.get("/health")
def health() -> dict:
    return {"ok": True, "clips_dir": str(CLIPS_DIR)}
