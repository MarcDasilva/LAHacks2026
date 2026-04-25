# database/ — Streaming Recognition Memory

A queryable memory of what the robot saw, scoped to **the recognition stream
+ the video clips that go with it**. Lingbot pose / map data is owned by a
separate database and is intentionally out of scope here.

> All commands in this README are run from the `database/` directory.

```
JSON recognition stream ─┐
                         ├─▶ ingest worker ─▶ Postgres + pgvector
                         │                       ▲
camera ─▶ ffmpeg segmenter (5s mp4s) ──────────┐ │
                         │                     │ │
                         └────────────────── FastAPI ──▶ UI
                                              /search
                                              /clips/<file>.mp4
```

## Components

| Path | What it does |
|------|--------------|
| `db/init.sql` | `chunks` table, HNSW vector index, JSONB GIN index |
| `docker-compose.yml` | `pgvector/pgvector:pg16` on `localhost:5432` |
| `ingest/windows.py` | Group recognition records into 5s wall-clock-aligned windows |
| `ingest/embed.py` | BGE-large-en-v1.5 text embeddings (1024 dims) |
| `ingest/worker.py` | stdin JSON-lines → window → embed → INSERT |
| `ingest/config.py` | Shared clips dir + filename convention |
| `recorder/record.sh` | FFmpeg segmenter producing `clip-<epoch>.mp4` files |
| `api/main.py` | `POST /search`, `GET /chunks/{id}`, static `/clips` |
| `db/migrations/` | Numbered SQL files, applied in order by `db/migrate.sh` |
| `db/migrate.sh` | Idempotent migration runner (records applied versions in `schema_migrations`) |

## Quick start

```bash
# 1. DB container
docker compose up -d postgres
until docker exec lingbot-pg pg_isready -U lingbot -d lingbot; do sleep 1; done

# 2. Apply migrations (idempotent — safe to rerun any time)
./db/migrate.sh

# 3. Python deps
pip install -r requirements.txt

# 4. Recorder (separate terminal) — slices the camera into 5s mp4s
INPUT=/dev/video0 ./recorder/record.sh

# 5. Ingest (separate terminal) — pipe the recognition stream in
cat samples/fall.jsonl | python -m ingest.worker

# 6. API
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

## Migrations

Schema lives in `db/migrations/<NNNN>_<slug>.sql`, applied lexicographically.
A small `schema_migrations(version, applied_at)` table tracks what's run.

To add a change to the schema:

```bash
# Pick the next number
ls db/migrations
# -> 0001_init.sql

# Create a new file with a strictly greater number
$EDITOR db/migrations/0002_add_chunk_source.sql

# Apply
./db/migrate.sh
```

Rules:

- **Never edit a migration that's been applied.** Add a new one instead.
- Migrations run inside a transaction (`psql -1`). If your file fails
  partway, nothing is recorded and the next run will retry.
- Ordering is purely lexicographic — keep the 4-digit zero-padded prefix.
- `./db/migrate.sh` is idempotent: rerunning skips files already in
  `schema_migrations`. CI / teammates can run it on every pull.

To reset the database from scratch (destroys all data):

```bash
docker compose down -v && docker compose up -d postgres
until docker exec lingbot-pg pg_isready -U lingbot -d lingbot; do sleep 1; done
./db/migrate.sh
```

## Recognition record format

The ingest worker reads JSON Lines from stdin. Each record needs a
timestamp and a `labels` array — the upstream recognition model is
expected to mix object classes (`"person"`, `"chair"`) with action/event
labels (`"fall"`, `"lying_on_floor"`) so semantic queries still work.

```json
{"ts": "2026-04-25T14:32:07.123Z",
 "labels": ["person", "chair", "fall", "lying_on_floor"],
 "confidence": 0.91}
```

`ts` (or `timestamp`) is required. `labels` from every record in a 5s
window are deduplicated into one set, joined into a string, and embedded
with BGE for semantic search. The full original payload is preserved
verbatim in `raw_json` for any custom analysis.

## Searching from the UI

```ts
const r = await fetch("http://gx10.local:8000/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ q: "person fallen down", k: 5 }),
}).then(r => r.json());

// r is SearchHit[]; each hit has:
//   chunk_id, started_at, ended_at, score,
//   labels: string[]        (e.g. ["person","fall","lying_on_floor"])
//   video_url: string|null  (e.g. "/clips/clip-1745594810.mp4")
// Plug video_url straight into a <video src=...> element. CORS is enabled.
```

`video_url` is `null` until the recorder has flushed the segment for that
window — the API re-checks the filesystem on every request, so a clip
"appears" once the recorder finishes writing it (typically within a
couple of seconds of the window ending).

Filters supported on `/search`:

- `since`, `until` — ISO-8601 time bounds (`started_at >= since`, `ended_at <= until`)
- `labels` — string array; chunks whose `labels` overlap any of these are
  returned (Postgres `&&` array operator). Pass `["fall"]` to only get
  chunks tagged `fall`.
- `k` — top-K (1..50, default 5)

## Verification

```bash
# Confirm extension
psql "$PG_DSN" -c '\dx vector'

# Replay sample stream
cat samples/fall.jsonl | python -m ingest.worker
psql "$PG_DSN" -c "SELECT count(*) FROM chunks;"

# Search
curl -s -X POST localhost:8000/search \
     -H 'Content-Type: application/json' \
     -d '{"q":"person fallen down","k":5}' | jq
```

Top hit's `[started_at, ended_at]` should bracket the staged event, and
`video_url` should resolve to a playable mp4.
