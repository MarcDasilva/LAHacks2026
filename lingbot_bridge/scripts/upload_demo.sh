#!/usr/bin/env bash
# Upload a directory of frames to the bridge as a single session, in sorted
# order, then close the session. Sorted upload matters: the bridge assigns
# sequence numbers by arrival order, and lingbot-map's streaming
# reconstruction is order-sensitive — if frames arrive scrambled the model
# produces a degenerate blob.
#
# Usage:
#   ./scripts/upload_demo.sh <session_id> <frames_dir> [bridge_url]
#
# Example:
#   ./scripts/upload_demo.sh church4 vendor/lingbot-map/example/church
set -euo pipefail

SID="${1:?session_id required}"
DIR="${2:?frames_dir required}"
BRIDGE="${3:-http://localhost:8888}"

if [ ! -d "$DIR" ]; then
    echo "no such dir: $DIR" >&2
    exit 1
fi

cd "$(dirname "$0")/.."

# Reset any existing session state on the server side.
rm -rf "frames/$SID" "outputs/$SID" "state/sessions/$SID.json" 2>/dev/null || true

echo "==> uploading frames from $DIR (sorted) to $BRIDGE/sessions/$SID"
n=0
# `find ... | sort` gives a stable, deterministic sequence — the bridge
# assigns 00000000.jpg, 00000001.jpg, … in this exact order.
while IFS= read -r f; do
    curl -fsS -F "file=@$f" "$BRIDGE/sessions/$SID/frames" -o /dev/null
    n=$((n + 1))
    if [ $((n % 50)) -eq 0 ]; then
        echo "    $n frames..."
    fi
done < <(find "$DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" \) | sort)

echo "==> uploaded $n frames"

if [ "$n" -eq 0 ]; then
    echo "no frames found in $DIR (looking for .jpg/.jpeg/.png)" >&2
    exit 1
fi

echo "==> closing session"
curl -fsS -X POST "$BRIDGE/sessions/$SID/close"
echo

echo "==> waiting for runner. tail -f /tmp/runner.log to watch."
echo "    (the runner picks up queued sessions every 2s, then takes ~90s to reconstruct)"
