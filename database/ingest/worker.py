"""Ingest worker.

Reads JSON records from stdin (one object per line) and folds them into
5-second per-camera memory windows in Postgres. Records may be:

- legacy recognition rows with `ts` + `labels`
- live multimodal rows with `kind` (`yolo` / `stt` / `yamnet`) plus text

Running:

    cat recognition_stream.jsonl | python -m ingest.worker
"""

from __future__ import annotations

import json
import os
import sys
from typing import Iterator

import psycopg
from pgvector.psycopg import register_vector

from ingest.db import default_dsn
from ingest.store import ingest_record

DSN = default_dsn()


def iter_stdin() -> Iterator[dict]:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        yield json.loads(line)


def main() -> None:
    with psycopg.connect(DSN, autocommit=True) as conn:
        register_vector(conn)
        with conn.cursor() as cur:
            count = 0
            for record in iter_stdin():
                ingest_record(cur, record)
                count += 1
                if count % 10 == 0:
                    print(f"[ingest] processed {count} events", file=sys.stderr)
            print(f"[ingest] done, processed {count} events", file=sys.stderr)


if __name__ == "__main__":
    main()
