"""Ingest worker.

Reads JSON recognition records from stdin (one JSON object per line),
groups them into 5s windows, embeds each window's deduped label set, and
inserts into Postgres. If a recorded 5s mp4 exists for the window's start
time (see ingest.config.clip_path), its public URI is stamped onto the
row so the UI can fetch the clip.

Running:

    cat recognition_stream.jsonl | python -m ingest.worker

For live use, point the upstream model's stdout (or an HTTP-to-stdin shim)
at this process. Replacing `iter_stdin` with a Kafka/WebSocket consumer is
the natural extension.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Iterator

import psycopg
from pgvector.psycopg import register_vector

from ingest.config import clip_uri
from ingest.embed import embed
from ingest.windows import Window, aggregate

DSN = os.environ.get(
    "PG_DSN",
    "host=127.0.0.1 port=5432 dbname=lingbot user=lingbot password=lingbot",
)


def iter_stdin() -> Iterator[dict]:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


def insert_window(cur: psycopg.Cursor, w: Window) -> None:
    labels = w.labels
    text = w.label_text or "(no labels)"
    vec = embed(text)
    uri = clip_uri(w.started_at)
    cur.execute(
        """
        INSERT INTO chunks
            (started_at, ended_at, labels, raw_json, embedding, video_uri)
        VALUES
            (%s, %s, %s, %s, %s, %s)
        """,
        (w.started_at, w.ended_at, labels, json.dumps(w.raw_json), vec, uri),
    )


def main() -> None:
    with psycopg.connect(DSN, autocommit=True) as conn:
        register_vector(conn)
        with conn.cursor() as cur:
            count = 0
            for window in aggregate(iter_stdin()):
                insert_window(cur, window)
                count += 1
                if count % 10 == 0:
                    print(f"[ingest] inserted {count} windows", file=sys.stderr)
            print(f"[ingest] done, inserted {count} windows", file=sys.stderr)


if __name__ == "__main__":
    main()
