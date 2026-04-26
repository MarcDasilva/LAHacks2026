#!/usr/bin/env python3
"""Sparse COLMAP reconstruction from a video → LBMP point cloud for the dashboard.

Pipeline:
  1. ffmpeg samples frames from the input video into <workspace>/images/
  2. COLMAP feature_extractor + sequential_matcher + mapper produce sparse/0/
  3. points3D.bin is parsed and written as LBMP v2 (xyz+rgb floats) to the
     dashboard's public/ dir so PointCloudViewer can fetch it as a static file.

Defaults are tuned for assets/output/input/IMG_0718.mp4 → sparse cloud at
dashboard/public/clouds/sparse.lbmp.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VIDEO = REPO_ROOT / "assets/output/input/IMG_0718.mp4"
DEFAULT_WORKSPACE = REPO_ROOT / "assets/output"
DEFAULT_LBMP_OUT = REPO_ROOT / "dashboard/public/clouds/sparse.lbmp"
DEFAULT_URL_JSON = REPO_ROOT / "dashboard/public/clouds/sparse.url.json"
DEFAULT_VIDEO_URL_JSON = REPO_ROOT / "dashboard/public/clouds/video.url.json"
DEFAULT_ENV_FILE = REPO_ROOT / ".env"

LBMP_MAGIC = 0x4C424D50
LBMP_VERSION = 2
LBMP_STRIDE = 24  # 6 floats × 4 bytes


def run(cmd: list[str]) -> None:
    print(f"\n$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def extract_frames(video: Path, images_dir: Path, fps: float) -> int:
    if images_dir.exists():
        shutil.rmtree(images_dir)
    images_dir.mkdir(parents=True)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-i", str(video),
        "-vf", f"fps={fps},scale='min(1600,iw)':-2",
        "-qscale:v", "2",
        str(images_dir / "frame_%05d.jpg"),
    ])
    return len(list(images_dir.glob("*.jpg")))


def run_colmap(workspace: Path, images_dir: Path) -> Path:
    db = workspace / "database.db"
    if db.exists():
        db.unlink()
    sparse_dir = workspace / "sparse"
    if sparse_dir.exists():
        shutil.rmtree(sparse_dir)
    sparse_dir.mkdir(parents=True)

    run([
        "colmap", "feature_extractor",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--ImageReader.single_camera", "1",
        "--FeatureExtraction.use_gpu", "0",
    ])
    run([
        "colmap", "sequential_matcher",
        "--database_path", str(db),
        "--FeatureMatching.use_gpu", "0",
    ])
    run([
        "colmap", "mapper",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir),
    ])

    # mapper writes one or more sub-models (0/, 1/, ...) — pick the largest.
    submodels = sorted(p for p in sparse_dir.iterdir() if p.is_dir())
    if not submodels:
        raise RuntimeError("colmap mapper produced no sub-models")
    best = max(submodels, key=lambda p: (p / "points3D.bin").stat().st_size if (p / "points3D.bin").exists() else 0)
    return best / "points3D.bin"


def read_colmap_points3d(path: Path) -> list[tuple[float, float, float, float, float, float]]:
    """Parse COLMAP's binary points3D.bin. Returns list of (x, y, z, r, g, b) with rgb in [0, 1]."""
    pts: list[tuple[float, float, float, float, float, float]] = []
    with path.open("rb") as f:
        (num_points,) = struct.unpack("<Q", f.read(8))
        for _ in range(num_points):
            f.read(8)  # point3D_id (u64)
            x, y, z = struct.unpack("<3d", f.read(24))
            r, g, b = struct.unpack("<3B", f.read(3))
            f.read(8)  # error (f64)
            (track_len,) = struct.unpack("<Q", f.read(8))
            f.read(track_len * 8)  # track entries (u32 image_id + u32 point2d_idx) × track_len
            pts.append((x, y, z, r / 255.0, g / 255.0, b / 255.0))
    return pts


def load_dotenv(path: Path) -> None:
    """Minimal .env loader — sets variables in os.environ if not already set."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def _import_cloudinary():
    try:
        import cloudinary  # type: ignore
        import cloudinary.uploader  # type: ignore
    except ImportError:
        print("cloudinary not installed — skipping upload (pip install cloudinary)", file=sys.stderr)
        return None
    if not os.environ.get("CLOUDINARY_URL"):
        print("CLOUDINARY_URL not set — skipping upload", file=sys.stderr)
        return None
    cloudinary.config()  # auto-reads CLOUDINARY_URL
    return cloudinary


def upload_to_cloudinary(path: Path, public_id: str, resource_type: str) -> str | None:
    """Upload a file as the given resource_type (raw|video|image). Returns secure_url or None."""
    cloudinary = _import_cloudinary()
    if cloudinary is None:
        return None
    print(f"\nuploading {path.name} to cloudinary as {resource_type}/{public_id} ...")
    result = cloudinary.uploader.upload_large(
        str(path),
        resource_type=resource_type,
        public_id=public_id,
        overwrite=True,
        invalidate=True,
    )
    return result.get("secure_url")


def write_lbmp(points: list[tuple[float, float, float, float, float, float]], out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    n = len(points)
    with out.open("wb") as f:
        f.write(struct.pack("<IIII", LBMP_MAGIC, LBMP_VERSION, n, LBMP_STRIDE))
        for p in points:
            f.write(struct.pack("<6f", *p))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", type=Path, default=DEFAULT_VIDEO)
    ap.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
    ap.add_argument("--out", type=Path, default=DEFAULT_LBMP_OUT)
    ap.add_argument("--url-json", type=Path, default=DEFAULT_URL_JSON,
                    help="where to write the cloudinary URL JSON the dashboard reads")
    ap.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    ap.add_argument("--cloudinary-public-id", default="impulse/sparse_splat",
                    help="cloudinary public_id for the LBMP raw upload")
    ap.add_argument("--video-public-id", default="impulse/sparse_source",
                    help="cloudinary public_id for the source video upload")
    ap.add_argument("--video-url-json", type=Path, default=DEFAULT_VIDEO_URL_JSON,
                    help="where to write the cloudinary video URL pointer JSON")
    ap.add_argument("--skip-upload", action="store_true", help="don't push the LBMP to cloudinary")
    ap.add_argument("--skip-video-upload", action="store_true", help="don't push the source video to cloudinary")
    ap.add_argument("--fps", type=float, default=2.0, help="frames per second to sample from video")
    ap.add_argument("--skip-extract", action="store_true", help="reuse existing frames in <workspace>/images/")
    ap.add_argument("--skip-colmap", action="store_true", help="reuse existing sparse/*/points3D.bin")
    args = ap.parse_args()

    load_dotenv(args.env_file)

    if not args.video.exists() and not (args.skip_extract or args.skip_colmap):
        print(f"video not found: {args.video}", file=sys.stderr)
        return 1

    images_dir = args.workspace / "images"
    if args.skip_extract:
        n_frames = len(list(images_dir.glob("*.jpg")))
        print(f"reusing {n_frames} frames in {images_dir}")
    else:
        n_frames = extract_frames(args.video, images_dir, args.fps)
        print(f"extracted {n_frames} frames to {images_dir}")
        if n_frames < 8:
            print("warning: fewer than 8 frames — sparse reconstruction will likely fail", file=sys.stderr)

    if args.skip_colmap:
        sparse_dir = args.workspace / "sparse"
        candidates = [p / "points3D.bin" for p in sorted(sparse_dir.iterdir()) if p.is_dir()]
        candidates = [p for p in candidates if p.exists()]
        if not candidates:
            print("no existing sparse model found", file=sys.stderr)
            return 1
        points3d_path = max(candidates, key=lambda p: p.stat().st_size)
    else:
        points3d_path = run_colmap(args.workspace, images_dir)

    points = read_colmap_points3d(points3d_path)
    print(f"parsed {len(points):,} points from {points3d_path}")
    if not points:
        print("empty cloud — refusing to write LBMP", file=sys.stderr)
        return 1

    write_lbmp(points, args.out)
    print(f"wrote LBMP → {args.out} ({args.out.stat().st_size:,} bytes)")

    if not args.skip_upload:
        secure_url = upload_to_cloudinary(args.out, args.cloudinary_public_id, "raw")
        if secure_url:
            args.url_json.parent.mkdir(parents=True, exist_ok=True)
            args.url_json.write_text(json.dumps({"url": secure_url}, indent=2) + "\n")
            print(f"uploaded → {secure_url}")
            print(f"wrote URL pointer → {args.url_json}")
        else:
            print("dashboard will fall back to the local /clouds/sparse.lbmp")

    if not args.skip_video_upload and args.video.exists():
        video_url = upload_to_cloudinary(args.video, args.video_public_id, "video")
        if video_url:
            args.video_url_json.parent.mkdir(parents=True, exist_ok=True)
            args.video_url_json.write_text(
                json.dumps({"url": video_url, "localPath": str(args.video.relative_to(REPO_ROOT))}, indent=2) + "\n"
            )
            print(f"uploaded video → {video_url}")
            print(f"wrote video URL pointer → {args.video_url_json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
