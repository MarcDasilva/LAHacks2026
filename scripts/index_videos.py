#!/usr/bin/env python3
"""Index Cloudinary videos for natural-language search via OpenAI.

For every video under the impulse/* prefix in Cloudinary:
  1. Download the source mp4 locally and probe its duration.
  2. Sample one JPEG frame every <interval> seconds with ffmpeg.
  3. Caption each frame with gpt-4o-mini (vision input).
  4. Embed each caption with text-embedding-3-small.
  5. Append { videoId, videoUrl, startSec, endSec, caption, embedding } to
     dashboard/public/clouds/search_index.json.

Re-runs are idempotent: existing entries with the same videoId are kept
unless --force is passed.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_INDEX = REPO_ROOT / "dashboard/public/clouds/search_index.json"
DEFAULT_ENV_FILE = REPO_ROOT / ".env"

OPENAI_BASE = "https://api.openai.com/v1"
CAPTION_MODEL = "gpt-4o-mini"
EMBED_MODEL = "text-embedding-3-small"

CAPTION_PROMPT = (
    "Describe this video frame in 1-2 vivid, specific sentences. "
    "Mention people, objects, environment, lighting, notable actions. "
    "No filler ('In this image…', 'The frame shows…'), no markdown."
)


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
    oa = os.environ.get("OPENAI_API_KEY")
    if not cloud or not oa:
        missing = [k for k, v in (("CLOUDINARY_URL", cloud), ("OPENAI_API_KEY", oa)) if not v]
        print(f"missing env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)
    return cloud, oa


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


def fetch_cloudinary_video(public_id: str) -> dict:
    import cloudinary  # type: ignore
    import cloudinary.api  # type: ignore

    cloudinary.config()
    return dict(cloudinary.api.resource(public_id, resource_type="video"))


def download_video(url: str, dest: Path) -> None:
    print(f"  → downloading {url}")
    with urllib.request.urlopen(url) as r, dest.open("wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


def probe_duration(video: Path) -> float:
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video),
        ],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def extract_frame(video: Path, t_sec: float, dest: Path) -> None:
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{t_sec:.3f}",
            "-i", str(video),
            "-frames:v", "1",
            "-vf", "scale='min(960,iw)':-2",
            "-q:v", "3",
            str(dest),
        ],
        check=True,
    )


def openai_request(method: str, path: str, api_key: str, body: dict | None = None,
                   timeout: float = 120) -> dict:
    url = f"{OPENAI_BASE}{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"openai {method} {path} → {e.code}: {msg}") from e


def caption_frame(frame_path: Path, api_key: str) -> str:
    with frame_path.open("rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = {
        "model": CAPTION_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": CAPTION_PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "low"},
                    },
                ],
            }
        ],
        "max_tokens": 220,
        "temperature": 0.2,
    }
    res = openai_request("POST", "/chat/completions", api_key, body=body)
    text = res["choices"][0]["message"]["content"].strip()
    # Strip wrapping quotes if the model emitted any.
    if text.startswith(("'", '"')) and text.endswith(("'", '"')):
        text = text[1:-1].strip()
    return text


def embed_text(text: str, api_key: str) -> list[float]:
    body = {"model": EMBED_MODEL, "input": text}
    res = openai_request("POST", "/embeddings", api_key, body=body)
    return list(res["data"][0]["embedding"])


def load_index(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "model": EMBED_MODEL, "entries": []}
    return json.loads(path.read_text())


def save_index(path: Path, index: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index) + "\n")


def public_id_to_video_id(public_id: str) -> str:
    """Match the dashboard manifest convention so search results join cleanly."""
    return public_id.replace("/", "__").replace("\\", "__")


def index_video(video_meta: dict, api_key: str, interval: float) -> list[dict]:
    public_id = video_meta["public_id"]
    video_id = public_id_to_video_id(public_id)
    secure_url = video_meta["secure_url"]
    out: list[dict] = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        local = tmp_dir / f"{video_id.replace('/', '_')}.mp4"
        download_video(secure_url, local)
        duration = probe_duration(local)
        print(f"  duration {duration:.1f}s")

        # Sample timestamps at the centre of each interval window so the
        # caption is representative of the segment.
        timestamps: list[float] = []
        t = 0.0
        while t < duration:
            timestamps.append(min(t + interval / 2.0, duration - 0.1))
            t += interval

        for i, t_mid in enumerate(timestamps):
            start_sec = i * interval
            end_sec = min((i + 1) * interval, duration)
            frame = tmp_dir / f"frame_{i:04d}.jpg"
            extract_frame(local, t_mid, frame)
            caption = caption_frame(frame, api_key)
            embedding = embed_text(caption, api_key)
            out.append(
                {
                    "videoId": video_id,
                    "videoUrl": secure_url,
                    "startSec": round(start_sec, 2),
                    "endSec": round(end_sec, 2),
                    "caption": caption,
                    "embedding": embedding,
                }
            )
            print(f"    {start_sec:>5.1f}s–{end_sec:>5.1f}s  {caption[:90]}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    ap.add_argument("--index", type=Path, default=DEFAULT_INDEX)
    ap.add_argument("--interval", type=float, default=8.0,
                    help="seconds per sampled segment")
    ap.add_argument("--force", action="store_true",
                    help="re-index every video even if entries already exist")
    ap.add_argument("--public-id", default=None,
                    help="index a single Cloudinary video by public_id "
                         "(skips the library scan; implies --force for that video)")
    args = ap.parse_args()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg/ffprobe required on PATH", file=sys.stderr)
        return 1

    load_dotenv(args.env_file)
    _, openai_key = ensure_keys()

    if args.public_id:
        # Cloudinary needs a brief moment between upload and the resource
        # being queryable; retry up to a few times before giving up.
        videos: list[dict] = []
        last_err: Exception | None = None
        for _ in range(5):
            try:
                videos = [fetch_cloudinary_video(args.public_id)]
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                import time as _time
                _time.sleep(2.0)
        if not videos:
            print(f"cloudinary resource not found: {args.public_id} ({last_err})", file=sys.stderr)
            return 1
    else:
        videos = list_cloudinary_videos()
    print(f"to index: {len(videos)} video(s)")

    index = load_index(args.index)
    indexed_ids = {e["videoId"] for e in index["entries"]}
    new_entries: list[dict] = []

    # Single-id mode always re-indexes that one video; library mode only
    # re-indexes when --force is set.
    force_all = bool(args.force or args.public_id)

    for v in videos:
        public_id = v["public_id"]
        video_id = public_id_to_video_id(public_id)
        if not force_all and video_id in indexed_ids:
            print(f"  skip (indexed): {video_id}")
            continue
        print(f"  indexing: {video_id}")
        new_entries.extend(index_video(v, openai_key, args.interval))

    # Always merge by videoId — replace entries for any video that was
    # re-indexed this run, leave the rest alone. The only time the whole
    # file gets rewritten is when --force is set without --public-id and
    # every entry is in `new_entries`.
    new_ids = {n["videoId"] for n in new_entries}
    index["entries"] = [e for e in index["entries"] if e["videoId"] not in new_ids]
    index["entries"].extend(new_entries)

    index["model"] = EMBED_MODEL
    save_index(args.index, index)
    print(f"wrote {len(index['entries'])} entries → {args.index}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
