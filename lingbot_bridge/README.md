# lingbot_bridge/

GX10-side service that runs **LingBot-Map** (3D streaming reconstruction)
against the same camera footage the mobile app streams to the rest of the
stack.

```
iOS Responder ──HTTP POST frames──▶  ingest_server  ──writes──▶  frames/<session_id>/*.jpg
                                                                        │
                                                                        ▼
                                                                 inference_runner
                                                                        │
                                                              ┌─────────┴──────────┐
                                                              ▼                    ▼
                                                       lingbot-map           outputs/<session>/
                                                       demo.py               point_cloud.ply
                                                                              poses.json
```

The `frames/` directory in this folder is the canonical drop zone — the
empty `frames/<epoch_ms>/` directories already in the repo are placeholders
from earlier capture sessions.

## Why this lives in its own folder

LingBot-Map needs CUDA 12.8 + Blackwell-class GPU (the GX10's Grace
Blackwell stack). It is intentionally isolated from `database/` so the
rest of the team can run the search/UI pipeline locally without GPUs.
The bridge only talks to the rest of the system via:

- **inbound:** HTTP frame uploads from the iOS app (or any client)
- **outbound:** files in `outputs/<session>/` (point clouds + poses);
  optional JSONL stream into `database/ingest/worker.py` if you derive
  labels from the reconstruction.

## Deploying on the GX10

The GX10 ships with NVIDIA DGX OS (Ubuntu 22.04, ARM64) and the NVIDIA
Container Toolkit pre-installed. Everything below assumes you have ssh
access and Docker is running.

```bash
# 0. Clone this repo on the GX10
git clone <repo-url> ~/LAHacks2026
cd ~/LAHacks2026/lingbot_bridge

# 1. Pull the lingbot-map source + checkpoint into ./vendor and ./models
./scripts/setup.sh

# 2. Configure (Hugging Face token, ports, etc.)
cp .env.example .env
$EDITOR .env

# 3. Build + start (uses NGC PyTorch arm64-sbsa as the base image)
docker compose up -d --build

# 4. Verify
curl http://localhost:8001/health
docker compose logs -f inference
```

After this, point the iOS app at `http://<gx10-host>:8001` (the same
hostname the database API uses — `gx10.local:8000` for the database,
`:8001` for the bridge).

## Local development on a Mac

You can run **only the ingest server** locally to validate the upload
contract — the inference runner needs CUDA and will refuse to start
without it.

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
INGEST_DISABLE_INFERENCE=1 uvicorn bridge.ingest_server:app --port 8001
```

Then POST a JPEG:

```bash
curl -X POST -F file=@some_frame.jpg \
  "http://localhost:8001/sessions/test123/frames"
ls frames/test123/
```

## API

`POST /sessions/{session_id}/frames` — multipart form upload of a single
JPEG. Stored as `frames/{session_id}/{ts_ms}_{seq}.jpg`. Returns
`{ok: true, path: "..."}`.

`POST /sessions/{session_id}/close` — signals end-of-session. The
inference runner picks this up, runs `demo.py` against the full session,
and writes results to `outputs/{session_id}/`.

`GET /sessions/{session_id}` — status: `{frames, last_frame_at, status}`
where status is `recording | reconstructing | done | failed`.

`GET /health` — `{ok: true, gpu: bool}`.

## Configuration

All knobs live in `.env` (see `.env.example`). Highlights:

- `LINGBOT_MODEL_PATH` — path to the downloaded checkpoint
  (default `./models/lingbot-map.pt`)
- `LINGBOT_MODE` — `streaming` (default) or `windowed`
- `LINGBOT_FPS` — target sample rate for inference (default 10)
- `INGEST_PORT` — ingest server port (default 8001)
- `MASK_SKY` — `1` to enable sky masking for outdoor scenes
- `USE_SDPA` — `1` to skip FlashInfer and use PyTorch SDPA fallback

## Notes / known limits

- LingBot-Map outputs **point clouds + camera poses**, not the
  `{labels: [...]}` records the database ingest worker expects. Wiring
  reconstruction → semantic labels is intentionally not part of this
  bridge — that's a downstream job.
- FlashInfer wheels for arm64+Blackwell may need a source build. The
  Dockerfile attempts the prebuilt wheel first and falls back to
  `USE_SDPA=1` if it fails — the runner will log which path it took.
- The HF checkpoint is ~4.6 GB. Keep `models/` on a fast disk.
