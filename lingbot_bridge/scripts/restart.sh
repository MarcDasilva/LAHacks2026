#!/usr/bin/env bash
# Restart the bridge processes (ingest server + inference runner) on this
# host with the latest .env loaded. Optionally, prebuild a session's
# cloud.bin so the first dashboard request doesn't pay the torch.load
# cost.
#
# Usage:
#   ./scripts/restart.sh                  # just restart
#   ./scripts/restart.sh church4          # restart + prebuild that session's cloud
set -euo pipefail

cd "$(dirname "$0")/.."

SESSION="${1:-}"
INGEST_LOG="${INGEST_LOG:-/tmp/ingest.log}"
RUNNER_LOG="${RUNNER_LOG:-/tmp/runner.log}"

echo "==> stopping any existing bridge processes"
pkill -f "uvicorn bridge" 2>/dev/null || true
pkill -f "bridge.inference_runner" 2>/dev/null || true
sleep 1

if [ ! -f .env ]; then
    echo "no .env found in $(pwd) — copy from .env.example first" >&2
    exit 1
fi

echo "==> loading .env"
set -a
# shellcheck disable=SC1091
source .env
set +a

PORT="${INGEST_PORT:-8888}"

echo "==> starting ingest server on :$PORT"
nohup uvicorn bridge.ingest_server:app --host 0.0.0.0 --port "$PORT" \
    > "$INGEST_LOG" 2>&1 &
INGEST_PID=$!
echo "    ingest pid=$INGEST_PID  log=$INGEST_LOG"

echo "==> starting inference runner"
nohup python -m bridge.inference_runner > "$RUNNER_LOG" 2>&1 &
RUNNER_PID=$!
echo "    runner pid=$RUNNER_PID  log=$RUNNER_LOG"

# Give them a moment to bind / load.
sleep 3

echo "==> health check"
if ! curl -fsS "http://localhost:$PORT/health"; then
    echo
    echo "ingest health check failed — last 20 lines of $INGEST_LOG:" >&2
    tail -n 20 "$INGEST_LOG" >&2 || true
    exit 1
fi
echo

# Quick liveness check on the runner — its log should at least show the
# "runner up" line by now.
if ! grep -q "runner up" "$RUNNER_LOG" 2>/dev/null; then
    echo "    (runner may still be loading — last 10 lines:)"
    tail -n 10 "$RUNNER_LOG" || true
fi

if [ -n "$SESSION" ]; then
    echo "==> rebuilding cloud for session '$SESSION' (forces cache miss with new key)"
    code=$(curl -s -o /tmp/cloud.bin -w "%{http_code}" \
        "http://localhost:$PORT/sessions/$SESSION/cloud")
    size=$(stat -c%s /tmp/cloud.bin 2>/dev/null || stat -f%z /tmp/cloud.bin)
    echo "    HTTP $code  ·  $size bytes  →  /tmp/cloud.bin"
    if [ -d "outputs/$SESSION" ]; then
        echo "==> outputs/$SESSION/:"
        ls -lh "outputs/$SESSION/" | sed 's/^/    /'
    fi
fi

echo "==> done."
