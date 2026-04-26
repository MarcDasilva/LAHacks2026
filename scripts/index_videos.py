#!/usr/bin/env python3
"""Index Cloudinary videos for natural-language search.

For every video under the impulse/* prefix in Cloudinary:
  1. Download the source mp4 locally.
  2. Upload it to the Gemini Files API.
  3. Ask Gemini 2.x to emit a JSON list of (startSec, endSec, caption)
     covering the whole video at ~10s granularity.
  4. Embed each caption with text-embedding-004.
  5. Append { videoId, videoUrl, startSec, endSec, caption, embedding } to
     dashboard/public/clouds/search_index.json.

Re-runs are idempotent: existing entries with the same (videoId, startSec)
are kept and only missing videos are processed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = REPO_ROOT / "dashboard/public/clouds/search_index.json"
DEFAULT_ENV_FILE = REPO_ROOT / ".env"

GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
CAPTION_MODEL = "models/gemini-2.5-flash"
EMBED_MODEL = "models/gemini-embedding-001"

CAPTION_PROMPT = """\
Analyse this video and return a JSON array of segments covering the whole
video. Use roughly 10-second windows (you may merge adjacent windows when
the scene is unchanged, or split when something distinct happens).

For each segment output strictly this shape:
  { "startSec": number, "endSec": number, "caption": string }

The caption should be a vivid, specific description of what happens in
that segment — actions, objects, people, environment, notable sounds if
audible. 1-2 sentences. No filler ("In this segment..."), no markdown.

Return ONLY the JSON array, no prose, no code fence.
"""


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def ensure_keys() -> tuple[str, str]:
    cloud = os.environ.get("CLOUDINARY_URL")
    gem = os.environ.get("GEMINI_API_KEY")
    missing = [k for k, v in (("CLOUDINARY_URL", cloud), ("GEMINI_API_KEY", gem)) if not v]
    if missing or not cloud or not gem:
        print(f"missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    return cloud, gem


def list_cloudinary_videos() -> list[dict]:
    import cloudinary  # type: ignore
    import cloudinary.api  # type: ignore

    cloudinary.config()
    result = cloudinary.api.resources(
        resource_type="video",
        type="upload",
        max_results=100,
        prefix="impulse/",
    )
    return list(result.get("resources", []))


def download_video(url: str, dest: Path) -> None:
    print(f"  → downloading {url}")
    with urllib.request.urlopen(url) as r, dest.open("wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def gemini_request(method: str, path: str, api_key: str, body: dict | None = None,
                   extra_headers: dict | None = None, timeout: float = 600) -> dict:
    url = f"{GEMINI_BASE}{path}"
    sep = "&" if "?" in path else "?"
    url = f"{url}{sep}key={api_key}"
    headers = {"Content-Type": "application/json"}
    if extra_headers:
        headers.update(extra_headers)
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def upload_video_to_gemini(local_path: Path, api_key: str) -> str:
    """Use the resumable Files API. Returns the active file URI."""
    size = local_path.stat().st_size
    # Files API uploads use the /upload/ subdomain prefix, not /v1beta/.
    init_url = f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={api_key}"
    init_body = json.dumps({"file": {"display_name": local_path.name}}).encode("utf-8")
    init_req = urllib.request.Request(
        init_url,
        data=init_body,
        method="POST",
        headers={
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": "video/mp4",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(init_req) as r:
        upload_url = r.headers.get("X-Goog-Upload-URL") or r.headers.get("x-goog-upload-url")
    if not upload_url:
        raise RuntimeError("gemini did not return an upload URL")

    with local_path.open("rb") as f:
        body = f.read()
    upload_req = urllib.request.Request(
        upload_url,
        data=body,
        method="POST",
        headers={
            "Content-Length": str(size),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
    )
    with urllib.request.urlopen(upload_req) as r:
        info = json.loads(r.read().decode("utf-8"))
    name = info["file"]["name"]

    # Poll until ACTIVE.
    for _ in range(60):
        meta = gemini_request("GET", f"/{name}", api_key)
        state = meta.get("state")
        if state == "ACTIVE":
            return meta["uri"]
        if state == "FAILED":
            raise RuntimeError(f"gemini file processing failed: {meta}")
        time.sleep(3)
    raise RuntimeError("gemini file did not become active within 3 minutes")


def caption_video(file_uri: str, api_key: str) -> list[dict]:
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"file_data": {"mime_type": "video/mp4", "file_uri": file_uri}},
                    {"text": CAPTION_PROMPT},
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.2,
            "responseSchema": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "startSec": {"type": "NUMBER"},
                        "endSec": {"type": "NUMBER"},
                        "caption": {"type": "STRING"},
                    },
                    "required": ["startSec", "endSec", "caption"],
                },
            },
        },
    }
    res = gemini_request("POST", f"/{CAPTION_MODEL}:generateContent", api_key, body=body)
    text = (
        res.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
    )
    if not text:
        raise RuntimeError(f"empty caption response: {res}")
    try:
        segments = json.loads(text)
    except json.JSONDecodeError:
        # Salvage: strip code fences and trim to the outermost array.
        cleaned = text.strip().lstrip("`").rstrip("`")
        if cleaned.startswith("json\n"):
            cleaned = cleaned[5:]
        first = cleaned.find("[")
        last = cleaned.rfind("]")
        if first == -1 or last == -1:
            raise
        segments = json.loads(cleaned[first : last + 1])
    cleaned = []
    for s in segments:
        try:
            cleaned.append(
                {
                    "startSec": float(s["startSec"]),
                    "endSec": float(s["endSec"]),
                    "caption": str(s["caption"]).strip(),
                }
            )
        except (KeyError, TypeError, ValueError):
            continue
    return cleaned


def embed_text(text: str, api_key: str) -> list[float]:
    body = {"content": {"parts": [{"text": text}]}, "taskType": "RETRIEVAL_DOCUMENT"}
    res = gemini_request("POST", f"/{EMBED_MODEL}:embedContent", api_key, body=body)
    return list(res["embedding"]["values"])


def load_index(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "model": EMBED_MODEL, "entries": []}
    return json.loads(path.read_text())


def save_index(path: Path, index: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    ap.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    ap.add_argument("--force", action="store_true",
                    help="re-index every video even if entries already exist")
    args = ap.parse_args()

    load_dotenv(args.env_file)
    _, gemini_key = ensure_keys()

    videos = list_cloudinary_videos()
    print(f"cloudinary library: {len(videos)} videos")

    index = load_index(args.index)
    indexed_ids = {e["videoId"] for e in index["entries"]}
    new_entries: list[dict] = []

    for v in videos:
        video_id = v["public_id"]
        if not args.force and video_id in indexed_ids:
            print(f"  skip (indexed): {video_id}")
            continue

        secure_url = v["secure_url"]
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / f"{video_id.replace('/', '_')}.mp4"
            download_video(secure_url, local)
            print(f"  uploading to gemini: {video_id}")
            file_uri = upload_video_to_gemini(local, gemini_key)
            print(f"  captioning: {file_uri}")
            segments = caption_video(file_uri, gemini_key)
            print(f"  → {len(segments)} segments")
            for s in segments:
                vec = embed_text(s["caption"], gemini_key)
                new_entries.append(
                    {
                        "videoId": video_id,
                        "videoUrl": secure_url,
                        "startSec": s["startSec"],
                        "endSec": s["endSec"],
                        "caption": s["caption"],
                        "embedding": vec,
                    }
                )

    if args.force:
        index["entries"] = new_entries
    else:
        index["entries"] = [e for e in index["entries"] if e["videoId"] not in {n["videoId"] for n in new_entries}]
        index["entries"].extend(new_entries)

    save_index(args.index, index)
    print(f"wrote {len(index['entries'])} entries → {args.index}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
