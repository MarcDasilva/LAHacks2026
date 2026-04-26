# IMPULSE — Real-Time Incident Response Platform  

![Tech Pic](tech.pdf)

IMPULSE is a command center for emergency responders (fire, EMS, police). It unifies live camera feeds, AI-powered scene detection, 3D spatial reconstruction, and geospatial dispatch coordination into a single web interface.

---

## What It Does

| Feature | Description |
|---|---|
| Live Camera Feeds | Stream video from iOS devices to a web dashboard in real time |
| AI Scene Detection | YOLO (objects) and Qwen2.5-Omni (audio reasoning) run on-device via Apple Neural Engine |
| Semantic Search | Ask "person fallen down" and get timestamped video clips back |
| Incident Alerts | View, triage, and dispatch responders to geolocated incidents on a 3D map |
| 3D Reconstruction | Build a point cloud of a scene from uploaded frames using LingBot-Map |

---

## Architecture

<img width="1508" height="413" alt="diagram" src="https://github.com/user-attachments/assets/cd4ada6d-8b08-483e-ac9e-b84ba0149f51" />


The **ASUS GX10** is the central on-site hub. It runs the database, search API, and frame relay. The LingBot bridge lives on a separate GPU server (NVIDIA DGX). The iOS app does all ML inference locally on-device.

---

## Components

### 1. `dashboard/` — Web UI

**Tech:** Next.js 16, React 19, TypeScript, Three.js, MapLibre GL, Tailwind CSS

Two main pages:

**Live Camera Dashboard (`/dashboard`)**
- Real-time video streams from connected iOS cameras
- Displays AI model outputs (YOLO detections, Qwen2.5-Omni audio descriptions) alongside the feed
- Supports multiple cameras via room-based multiplexing
- WebRTC (low latency) with JPEG-over-WebSocket fallback

**Incident Alerts (`/alerts`)**
- Queue of incoming incidents with severity levels (critical / high / medium)
- 3D MapLibre GL map with building highlights and zoom controls
- Click an alert to focus the map on that location
- Dispatch buttons to send a police car or EMT unit

Also contains a built-in **frame relay server** (`server/frame-stream-server.mjs`) — a Node.js WebSocket hub that connects iOS senders to web viewers and stores the latest model outputs per room.

---

### 2. `database/` — Recognition Memory + Search

**Tech:** FastAPI, PostgreSQL + pgvector, sentence-transformers (BGE-large-en-v1.5)

Runs on the **ASUS GX10**. Stores a searchable log of everything the AI has detected and links each record back to the video stored in Cloudinary.

**Media storage: Cloudinary**
Videos are uploaded to Cloudinary under the `impulse/` prefix. The PostgreSQL `chunks` table stores the Cloudinary `video_uri` alongside each recognition record — so querying the DB gives you both the metadata and a direct link to the clip.

**PostgreSQL schema (`chunks` table):**
| Column | Description |
|---|---|
| `started_at` / `ended_at` | Time window this chunk covers |
| `video_uri` | Cloudinary URL for the corresponding clip |
| `labels` | Array of detected labels (GIN indexed) |
| `yolo_text`, `stt_text`, `yamnet_text` | Per-model text outputs |
| `search_text` | Combined field for trigram search |
| `embedding` | 1024-dim vector for semantic search (HNSW index) |
| `camera_id`, `session_id` | Which camera / session produced this chunk |
| `raw_json` | Full JSONB payload for arbitrary querying |

**Indexing pipeline (`scripts/index_videos.py`):**
1. Lists all videos in Cloudinary under `impulse/`
2. Downloads each MP4, samples one frame every N seconds with ffmpeg
3. Captions each frame with **GPT-4o-mini** (vision)
4. Embeds each caption with **`text-embedding-3-small`**
5. Writes `{ videoId, videoUrl, startSec, endSec, caption, embedding }` entries to `dashboard/public/clouds/search_index.json`

**API Endpoints:**
- `POST /search` — natural language search with optional time/label filters
- `GET /chunks/{id}` — full chunk metadata including Cloudinary video URL
- `POST /api/upload-video` (dashboard) — uploads a video to Cloudinary, triggers indexing

---

### 3. `lingbot_bridge/` — 3D Reconstruction Pipeline

**Tech:** FastAPI, LingBot-Map (CUDA), viser (streaming 3D viewer)

Runs on a GPU server (NVIDIA DGX). Takes frames from the iOS app and reconstructs the scene in 3D.

**How it works:**
1. iOS app uploads JPEG frames to `/sessions/{id}/frames`
2. A background poller detects idle sessions and queues them for inference
3. LingBot-Map runs `demo.py` as a subprocess — outputs a `.ply` point cloud + camera poses
4. Results stream to a viser viewer (embeddable iframe) and are also served as binary data
5. The dashboard's Three.js viewer fetches the binary cloud and renders it interactively

**API Endpoints:**
- `POST /sessions/{id}/frames` — upload a frame
- `POST /sessions/{id}/close` — signal end of capture, trigger inference
- `GET /sessions/{id}` — poll status (`recording → queued → reconstructing → done`)
- `GET /sessions/{id}/cloud` — download binary point cloud
- `GET /sessions/{id}/frustums` — camera pose frustums

---

### 4. `mobile/Responder` — iOS App

**Tech:** Swift, ZETIC Melange SDK (v1.6.0), Apple Neural Engine

The field device. All ML runs **on-device** via the Apple Neural Engine — no round-trips to the server for inference.

**ZETIC Melange** is the SDK that handles model compilation, optimization, and execution on the Neural Engine. Models are downloaded once on first run and cached locally.

**On-device AI pipeline:**

| Model | What it does |
|---|---|
| YOLO | Object detection on the camera frame |
| Qwen2.5-Omni 3B (audio) | Reasons about ambient audio — "what sounds do you hear?", danger detection |

**Qwen2.5-Omni audio pipeline** (two-stage, memory-swapped):
```
mic (16kHz mono)
  → mel spectrogram (128 bands, Whisper-compatible)
  → audio encoder  (zetic/qwen2.5_omni_audio_encoder_chunk_f16)
  → embeddings injected into LLM decoder
  → LLM decoder   (zetic/QWEN_2.5_omni_3b_decoder)
  → streaming text output
```
The encoder and decoder cannot coexist in memory on ≤6 GB RAM, so the app swaps them: run encoder → unload → load decoder → stream tokens. Swap takes ~5–10s on iPhone 15 Pro. iPhone 16 Pro+ (8 GB) can potentially skip the swap.

**Frame streaming to dashboard:**
- Streams JPEG frames over WebSocket to the GX10's frame relay
- Sends YOLO + Qwen audio outputs as JSON alongside each frame
- Requires same Wi-Fi network as the GX10

---

## Data Flows

**Live streaming:**
```
iOS camera → Frame Stream Server (GX10:8787) → Dashboard (WebRTC / JPEG)
iOS models → Frame Stream Server (JSON)      → Dashboard model output panel
```

**Semantic search:**
```
User uploads video → Cloudinary (stores MP4) → index_videos.py
  → ffmpeg samples frames → GPT-4o-mini captions → text-embedding-3-small
  → search_index.json + chunks rows with video_uri (Cloudinary URL)

User types query → pgvector cosine search → chunks rows
  → Cloudinary video_uri returned → playback in dashboard
```

**3D reconstruction:**
```
iOS uploads frames → LingBot Bridge (GPU server) queues session
→ demo.py runs LingBot-Map → point_cloud.ply
→ binary export → Three.js renders in dashboard
```

---

## Running Locally

### Dashboard + Frame Server
```bash
cd dashboard
npm install
npm run dev                               # Next.js on :3000
node server/frame-stream-server.mjs       # WebSocket relay on :8787
```

### Database API (runs on GX10)
```bash
cd database
docker compose up -d                      # PostgreSQL + pgvector on :5432
python -m uvicorn api.main:app --reload   # Search API on :8000
python ingest/worker.py                   # Feed JSON lines via stdin
```

### LingBot Bridge (requires GPU server)
```bash
cd lingbot_bridge
cp .env.example .env                      # set LINGBOT_MODEL_PATH etc.
python ingest_server.py                   # Frame ingest + viser on :8001 / :8890
python inference_runner.py                # Background poller (separate terminal)
```

### iOS App
1. Open `mobile/Responder` in Xcode 14+
2. Add `ZeticMLangeiOS` via SPM (exact version `1.6.0`)
3. Manually link `Accelerate.framework` (Build Phases → Link Binary With Libraries)
4. Set env vars in the Xcode scheme:
```
RESPONDER_FRAME_STREAM_WS_URL=ws://<gx10-lan-ip>:8787
RESPONDER_FRAME_STREAM_ROOM_ID=main-camera
RESPONDER_FRAME_STREAM_FPS=10
RESPONDER_FRAME_STREAM_JPEG_QUALITY=0.65
```
5. Run on a physical device (iPhone 8+ for YOLO, iPhone 15 Pro+ for Qwen audio)

---

## Environment Variables

**Dashboard** (`.env.local`):
```
NEXT_PUBLIC_FRAME_STREAM_WS_URL=ws://<gx10-ip>:8787
NEXT_PUBLIC_VISER_URL=http://<gpu-server-ip>:8890
```

**Database** (`.env`):
```
PG_DSN=host=127.0.0.1 port=5432 dbname=lingbot user=lingbot password=lingbot
CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
OPENAI_API_KEY=sk-...
```

**LingBot Bridge** (`.env`):
```
LINGBOT_MODEL_PATH=./models/lingbot-map.pt
LINGBOT_MODE=streaming
INGEST_PORT=8001
SESSION_IDLE_SECONDS=30
```

---

## Tech Stack Summary

| Layer | Technologies |
|---|---|
| Frontend | Next.js, React, TypeScript, Tailwind CSS, Three.js, MapLibre GL |
| Streaming | WebRTC, WebSocket (Node.js relay on GX10) |
| Search | FastAPI, PostgreSQL, pgvector, sentence-transformers, OpenAI embeddings (on GX10) |
| Media Storage | Cloudinary (video clips under `impulse/` prefix) |
| On-device AI | ZETIC Melange SDK, YOLO, Qwen2.5-Omni 3B, Apple Neural Engine |
| 3D Reconstruction | LingBot-Map, viser, CUDA 12.8 (NVIDIA DGX) |
| Central Hub | ASUS GX10 (database, search API, frame relay) |
| Infrastructure | Docker, FFmpeg |
| Mobile | iOS (Swift), iPhone 15 Pro+ for full audio pipeline |
