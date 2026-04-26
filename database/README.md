# database/ — Multimodal Camera Memory

A queryable memory of what each camera saw and heard, scoped to **YOLO,
STT/YAMNet, timestamps, and the matching video clips**. Lingbot pose /
map data is owned by a separate database and is intentionally out of
scope here.

> All commands in this README are run from the `database/` directory.

```
YOLO / STT / YAMNet events ─┐
                            ├─▶ ingest worker or POST /ingest/events
                            │                       │
camera(roomId) ─────────────┘                       ▼
camera ─▶ ffmpeg segmenter (5s mp4s per camera) ─▶ Postgres + pgvector
                                                    ▲
                                                    │
                                               FastAPI
                                             /search
                                             /chunks/:id
                                             /clips/<camera>/clip-<epoch>.mp4
```

## Components

| Path | What it does |
|------|--------------|
| `db/init.sql` | Base `chunks` table + vector / JSON indexes |
| `db/migrations/0002_multimodal_memory.sql` | Camera-aware multimodal columns + uniqueness per camera/window |
| `docker-compose.yml` | `pgvector/pgvector:pg16` on `localhost:5433` |
| `ingest/windows.py` | 5s wall-clock bucketing helpers |
| `ingest/events.py` | Normalize legacy records and live model-output payloads |
| `ingest/store.py` | Merge per-camera windows and upsert embeddings |
| `ingest/embed.py` | BGE-large-en-v1.5 text embeddings (1024 dims) |
| `ingest/worker.py` | stdin JSON-lines → normalize → per-camera upsert |
| `ingest/config.py` | Shared clips dir + camera-aware filename convention |
| `recorder/record.sh` | FFmpeg segmenter producing `<camera>/clip-<epoch>.mp4` files |
| `api/main.py` | `POST /search`, `POST /ingest/events`, `GET /chunks/{id}`, static `/clips` |
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

# 4. Recorder (separate terminal) — slices one camera into 5s mp4s
CAMERA_ID=main-camera INPUT=/dev/video0 ./recorder/record.sh

# 5a. Ingest from stdin (legacy/offline)
cat samples/fall.jsonl | python -m ingest.worker

# 5b. Or accept live events over HTTP
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

If you are using the dashboard websocket bridge, point it at the memory
API so incoming mobile `model-output` events are persisted automatically:

```bash
cd ../dashboard
MEMORY_API_URL=http://127.0.0.1:8000 npm run stream-server
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

## Ingest formats

The memory layer accepts two record shapes.

### 1. Legacy recognition JSONL

Useful for replays and simple object/action streams.

```json
{"ts": "2026-04-25T14:32:07.123Z",
 "camera_id": "main-camera",
 "labels": ["person", "chair", "fall", "lying_on_floor"],
 "confidence": 0.91}
```

### 2. Live multimodal event payloads

This is what the websocket bridge should forward when it receives a
mobile `model-output` message.

```json
{
  "camera_id": "main-camera",
  "kind": "stt",
  "payload": {
    "sessionID": "optional-session-id",
    "emittedAt": "2026-04-25T14:32:07.123Z",
    "chunk": {
      "chunkID": "8B7935A0-96C7-4555-A1AA-5CB3C54D28F4",
      "startedAt": "2026-04-25T14:32:06.400Z",
      "endedAt": "2026-04-25T14:32:09.500Z",
      "frameCount": 0
    },
    "output": {
      "text": "Help me over here",
      "confidence": 0.94,
      "tensorCount": 2
    }
  }
}
```

Supported `kind`s are `yolo`, `stt`, and `yamnet`.

Events are bucketed into fixed 5-second windows per `camera_id`, then
merged into one row. Each row stores:

- `camera_id`
- `started_at`, `ended_at`
- `labels` extracted from YOLO / legacy records
- `yolo_text`, `stt_text`, `yamnet_text`
- `search_text` used for embeddings
- `video_uri` for the matching clip, when present
- `raw_json.events[]` with the original source payloads

That means a natural-language query like "where did I see a person and
what did they say?" can match the combined row, not just one model.

## Searching from the UI

```ts
const r = await fetch("http://gx10.local:8000/search", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    q: "Where did I see a person asking for help?",
    camera_id: "main-camera",
    k: 5
  }),
}).then(r => r.json());

// r is SearchHit[]; each hit has:
//   chunk_id, camera_id, session_id, started_at, ended_at, score,
//   labels: string[]        (e.g. ["person","chair"])
//   yolo_text: string       (e.g. "person 98%, chair 81%")
//   stt_text: string        (e.g. "Help me over here")
//   yamnet_text: string
//   video_url: string|null  (e.g. "/clips/main-camera/clip-1745594810.mp4")
// Plug video_url straight into a <video src=...> element. CORS is enabled.
```

`video_url` is `null` until the recorder has flushed the segment for that
window — the API re-checks the filesystem on every request, so a clip
"appears" once the recorder finishes writing it (typically within a
couple of seconds of the window ending).

Filters supported on `/search`:

- `since`, `until` — ISO-8601 time bounds (`started_at >= since`, `ended_at <= until`)
- `camera_id` — only search one camera's memory window stream
- `labels` — string array; chunks whose `labels` overlap any of these are
  returned (Postgres `&&` array operator). Pass `["person"]` to only get
  rows tagged with a person detection.
- `k` — top-K (1..50, default 5)

## Live ingest endpoint

```bash
curl -s -X POST localhost:8000/ingest/events \
  -H 'Content-Type: application/json' \
  -d '{
    "camera_id": "main-camera",
    "kind": "yolo",
    "payload": {
      "sessionID": "demo-session",
      "emittedAt": "2026-04-25T14:32:07.123Z",
      "chunk": {
        "chunkID": "demo-1",
        "startedAt": "2026-04-25T14:32:06.400Z",
        "endedAt": "2026-04-25T14:32:09.500Z",
        "frameCount": 6
      },
      "output": {
        "text": "person 98%, chair 81%",
        "confidence": 0.98,
        "tensorCount": 1
      }
    }
  }' | jq
```

The response includes the merged window bounds and the resolved clip URL
if the segment already exists on disk.

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
     -d '{"q":"Where did I see a person?","camera_id":"main-camera","k":5}' | jq
```

Top hit's `[started_at, ended_at]` should bracket the staged event, and
`video_url` should resolve to a playable mp4.
