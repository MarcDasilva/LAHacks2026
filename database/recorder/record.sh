#!/usr/bin/env bash
# Slice the camera stream into 5s mp4 segments named by their unix-epoch
# start time, aligned to wall clock so segment boundaries match the 5s
# windows used by ingest/windows.py.
#
# Filename format must match ingest/config.py::clip_filename, i.e.
#   <camera_id>/clip-<unix_epoch_seconds>.mp4
#
# The API serves whatever files are present in $CLIPS_DIR via /clips/<name>.
#
# Adjust INPUT to the actual camera source (e.g. /dev/video0, an RTSP URL,
# or whatever lingbot exposes).

set -euo pipefail

INPUT="${INPUT:-/dev/video0}"
CLIPS_DIR="${CLIPS_DIR:-/data/clips}"
CAMERA_ID_RAW="${CAMERA_ID:-main-camera}"
CAMERA_ID="$(printf '%s' "$CAMERA_ID_RAW" | tr -cs '[:alnum:]._- ' '-' | sed 's/^-*//; s/-*$//')"
CAMERA_ID="${CAMERA_ID:-main-camera}"

mkdir -p "$CLIPS_DIR/$CAMERA_ID"

exec ffmpeg \
    -hide_banner \
    -loglevel warning \
    -i "$INPUT" \
    -c:v libx264 -preset veryfast -tune zerolatency \
    -pix_fmt yuv420p \
    -an \
    -f segment \
    -segment_time 5 \
    -segment_atclocktime 1 \
    -reset_timestamps 1 \
    -segment_format mp4 \
    -movflags +faststart \
    -strftime 1 \
    "$CLIPS_DIR/$CAMERA_ID/clip-%s.mp4"
