#!/usr/bin/env python3
"""Build a sparse splat for a single video and register it in the manifest.

Usage:
  python3 scripts/process_video.py \
      --video /tmp/foo.mp4 \
      --video-id impulse__foo \
      --video-url https://res.cloudinary.com/.../foo.mp4 \
      --label foo

This is the per-video pipeline triggered by /api/upload-video. It:
  1. Marks the manifest entry status=processing.
  2. Extracts frames at --fps with ffmpeg, runs COLMAP feature_extractor +
     exhaustive_matcher + mapper + point_triangulator, writes points3D.bin.
  3. Converts the sparse model to LBMP (xyz+rgb) and a path JSON of camera
     centres, dropping them under
     dashboard/public/clouds/splats/<videoId>/{sparse.lbmp,sparse.path.json}.
  4. Marks the manifest entry status=ready (or status=failed on error).

The shared sparse cloud at /clouds/sparse.lbmp is left untouched.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = REPO_ROOT / "dashboard/public/clouds/splats/manifest.json"
DEFAULT_SPLATS_DIR = REPO_ROOT / "dashboard/public/clouds/splats"

LBMP_MAGIC = 0x4C424D50
LBMP_VERSION = 2
LBMP_STRIDE = 24


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
    sparse_dir = workspace / "sparse"
    if db.exists():
        db.unlink()
    if sparse_dir.exists():
        shutil.rmtree(sparse_dir)
    sparse_dir.mkdir(parents=True)

    run([
        "colmap", "feature_extractor",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--ImageReader.single_camera", "1",
        "--FeatureExtraction.use_gpu", "0",
        "--SiftExtraction.max_num_features", "20480",
        "--SiftExtraction.peak_threshold", "0.0025",
        "--SiftExtraction.edge_threshold", "14",
    ])
    run([
        "colmap", "exhaustive_matcher",
        "--database_path", str(db),
        "--FeatureMatching.use_gpu", "0",
        "--FeatureMatching.guided_matching", "1",
        "--SiftMatching.max_ratio", "0.85",
    ])
    run([
        "colmap", "mapper",
        "--database_path", str(db),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir),
        "--Mapper.ba_global_max_num_iterations", "75",
        "--Mapper.tri_min_angle", "0.8",
    ])

    submodels = [p for p in sorted(sparse_dir.iterdir()) if p.is_dir()]
    if not submodels:
        raise RuntimeError("colmap produced no sub-models")
    best = max(
        submodels,
        key=lambda p: (p / "points3D.bin").stat().st_size if (p / "points3D.bin").exists() else 0,
    )

    # Re-triangulate to harvest more environment points.
    retri_out = sparse_dir / f"{best.name}_retri"
    retri_out.mkdir(exist_ok=True)
    try:
        run([
            "colmap", "point_triangulator",
            "--database_path", str(db),
            "--image_path", str(images_dir),
            "--input_path", str(best),
            "--output_path", str(retri_out),
            "--Mapper.tri_min_angle", "0.8",
            "--Mapper.tri_create_max_angle_error", "3",
        ])
        if (retri_out / "points3D.bin").exists():
            shutil.rmtree(best)
            retri_out.rename(best)
    except subprocess.CalledProcessError:
        print("point_triangulator failed — keeping mapper output", file=sys.stderr)
        shutil.rmtree(retri_out, ignore_errors=True)
    return best


def read_points3d(path: Path) -> list[tuple[float, float, float, float, float, float]]:
    pts = []
    with path.open("rb") as f:
        (num_points,) = struct.unpack("<Q", f.read(8))
        for _ in range(num_points):
            f.read(8)
            x, y, z = struct.unpack("<3d", f.read(24))
            r, g, b = struct.unpack("<3B", f.read(3))
            f.read(8)
            (track_len,) = struct.unpack("<Q", f.read(8))
            f.read(track_len * 8)
            pts.append((x, y, z, r / 255.0, g / 255.0, b / 255.0))
    return pts


def _read_null_terminated(f) -> str:
    chunks: list[bytes] = []
    while True:
        ch = f.read(1)
        if not ch or ch == b"\x00":
            break
        chunks.append(ch)
    return b"".join(chunks).decode("utf-8", errors="replace")


def read_camera_centers(images_bin: Path) -> list[tuple[str, tuple[float, float, float]]]:
    out = []
    with images_bin.open("rb") as f:
        (num,) = struct.unpack("<Q", f.read(8))
        for _ in range(num):
            f.read(4)
            qw, qx, qy, qz = struct.unpack("<4d", f.read(32))
            tx, ty, tz = struct.unpack("<3d", f.read(24))
            f.read(4)
            name = _read_null_terminated(f)
            (n2d,) = struct.unpack("<Q", f.read(8))
            f.read(n2d * 24)
            r00 = 1 - 2 * (qy * qy + qz * qz)
            r10 = 2 * (qx * qy + qz * qw)
            r20 = 2 * (qx * qz - qy * qw)
            r01 = 2 * (qx * qy - qz * qw)
            r11 = 1 - 2 * (qx * qx + qz * qz)
            r21 = 2 * (qy * qz + qx * qw)
            r02 = 2 * (qx * qz + qy * qw)
            r12 = 2 * (qy * qz - qx * qw)
            r22 = 1 - 2 * (qx * qx + qy * qy)
            cx = -(r00 * tx + r10 * ty + r20 * tz)
            cy = -(r01 * tx + r11 * ty + r21 * tz)
            cz = -(r02 * tx + r12 * ty + r22 * tz)
            out.append((name, (cx, cy, cz)))
    return out


def write_lbmp(points, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("wb") as f:
        f.write(struct.pack("<IIII", LBMP_MAGIC, LBMP_VERSION, len(points), LBMP_STRIDE))
        for p in points:
            f.write(struct.pack("<6f", *p))


def write_path(centers, out: Path) -> int:
    ordered = sorted(centers, key=lambda kv: kv[0])
    payload = {
        "count": len(ordered),
        "points": [list(c) for _, c in ordered],
        "frames": [name for name, _ in ordered],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload) + "\n")
    return len(ordered)


def update_manifest(
    manifest_path: Path,
    video_id: str,
    record: dict,
) -> None:
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
    else:
        manifest = {"version": 1, "videos": {}}
    manifest.setdefault("videos", {})
    manifest["videos"][video_id] = record
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True, type=Path)
    ap.add_argument("--video-id", required=True)
    ap.add_argument("--video-url", required=True)
    ap.add_argument("--label", default=None)
    ap.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    ap.add_argument("--splats-dir", type=Path, default=DEFAULT_SPLATS_DIR)
    ap.add_argument("--fps", type=float, default=3.0)
    args = ap.parse_args()

    video_id = args.video_id
    out_dir = args.splats_dir / video_id
    out_dir.mkdir(parents=True, exist_ok=True)

    label = args.label or video_id
    base_record = {
        "videoId": video_id,
        "videoUrl": args.video_url,
        "label": label,
        "lbmpPath": f"/clouds/splats/{video_id}/sparse.lbmp",
        "pathPath": f"/clouds/splats/{video_id}/sparse.path.json",
    }

    update_manifest(args.manifest, video_id, {**base_record, "status": "processing"})

    try:
        with tempfile.TemporaryDirectory(prefix=f"colmap_{video_id}_") as tmp:
            workspace = Path(tmp)
            images_dir = workspace / "images"
            n_frames = extract_frames(args.video, images_dir, args.fps)
            print(f"extracted {n_frames} frames")
            if n_frames < 8:
                raise RuntimeError(f"not enough frames ({n_frames}) — need ≥8")
            best_model = run_colmap(workspace, images_dir)

            points = read_points3d(best_model / "points3D.bin")
            if not points:
                raise RuntimeError("colmap produced an empty cloud")
            write_lbmp(points, out_dir / "sparse.lbmp")
            n_path = 0
            images_bin = best_model / "images.bin"
            if images_bin.exists():
                n_path = write_path(read_camera_centers(images_bin), out_dir / "sparse.path.json")
            print(f"wrote {len(points):,} points and {n_path} camera poses")

        update_manifest(
            args.manifest,
            video_id,
            {**base_record, "status": "ready", "points": len(points)},
        )
        return 0
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        update_manifest(
            args.manifest,
            video_id,
            {**base_record, "status": "failed", "error": str(e)},
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
