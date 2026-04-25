"""FastAPI search service.

  POST /search
    body: { q, k?, since?, until?, label? }
    -> top-k chunks ranked by cosine similarity to the query embedding,
       with optional time-range and label filters. Each hit includes a
       `video_url` the UI can plug straight into a <video> element.

  GET  /chunks/{chunk_id}        full row (incl. raw_json) for a hit
  GET  /clips/{filename}         static-served 5s mp4 (range-aware)

CORS is wide-open; tighten via CORS_ORIGINS env var (comma-sep) if needed.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import datetime

import psycopg
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pgvector.psycopg import register_vector
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from ingest.config import CLIPS_DIR, clip_filename
from ingest.embed import embed

DSN = os.environ.get(
    "PG_DSN",
    "host=127.0.0.1 port=5432 dbname=lingbot user=lingbot password=lingbot",
)
CORS_ORIGINS = [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",")]


class SearchRequest(BaseModel):
    q: str = Field(..., min_length=1)
    k: int = Field(5, ge=1, le=50)
    since: datetime | None = None
    until: datetime | None = None
    labels: list[str] | None = None  # any-of: chunk must contain at least one


class SearchHit(BaseModel):
    chunk_id: int
    started_at: datetime
    ended_at: datetime
    video_url: str | None
    labels: list[str]
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


def _resolve_video_url(stored_uri: str | None, started_at: datetime) -> str | None:
    """Always re-derive the path from the timestamp, in case the recorder
    wrote the file after ingest. Falls back to whatever was stored."""
    candidate = CLIPS_DIR / clip_filename(started_at)
    if candidate.exists():
        return f"/clips/{candidate.name}"
    return stored_uri


@app.post("/search", response_model=list[SearchHit])
def search(req: SearchRequest) -> list[SearchHit]:
    vec = embed(req.q)
    label_filter = req.labels or None  # None disables the filter

    sql = """
        SELECT id, started_at, ended_at, video_uri, labels,
               1 - (embedding <=> %s) AS score
        FROM chunks
        WHERE (%s::timestamptz IS NULL OR started_at >= %s)
          AND (%s::timestamptz IS NULL OR ended_at   <= %s)
          AND (%s::text[]      IS NULL OR labels && %s::text[])
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
                vec,
                req.k,
            ),
        )
        rows = cur.fetchall()

    return [
        SearchHit(
            chunk_id=r[0],
            started_at=r[1],
            ended_at=r[2],
            video_url=_resolve_video_url(r[3], r[1]),
            labels=list(r[4] or []),
            score=float(r[5]),
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
            SELECT id, started_at, ended_at, video_uri, labels, raw_json
            FROM chunks WHERE id = %s
            """,
            (chunk_id,),
        )
        row = cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="chunk not found")
    return {
        "chunk_id": row[0],
        "started_at": row[1],
        "ended_at": row[2],
        "video_url": _resolve_video_url(row[3], row[1]),
        "labels": list(row[4] or []),
        "raw_json": row[5],
    }


@app.get("/health")
def health() -> dict:
    return {"ok": True}
