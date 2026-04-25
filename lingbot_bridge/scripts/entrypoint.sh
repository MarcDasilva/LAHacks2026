#!/usr/bin/env bash
# Container entrypoint — boots the ingest server and the inference runner
# side-by-side under one PID 1. Exits if either dies.
set -euo pipefail

cd /opt/bridge

: "${INGEST_PORT:=8001}"
: "${LINGBOT_MODEL_PATH:=/opt/bridge/models/lingbot-map.pt}"

if [ ! -f "$LINGBOT_MODEL_PATH" ]; then
    # Fallback: try to find a .pt under /opt/bridge/models.
    found="$(find /opt/bridge/models -maxdepth 2 -name '*.pt' | head -n1 || true)"
    if [ -n "$found" ]; then
        export LINGBOT_MODEL_PATH="$found"
        echo "entrypoint: using $LINGBOT_MODEL_PATH"
    else
        echo "entrypoint: no checkpoint found in /opt/bridge/models — did you run scripts/download_model.sh on the host?"
        exit 1
    fi
fi

python -c "import torch; assert torch.cuda.is_available(), 'CUDA not visible inside container'; print('CUDA OK:', torch.cuda.get_device_name(0))"

# Run both processes; if either exits non-zero, kill the other.
uvicorn bridge.ingest_server:app --host 0.0.0.0 --port "$INGEST_PORT" &
INGEST_PID=$!

python -m bridge.inference_runner &
RUNNER_PID=$!

trap 'kill $INGEST_PID $RUNNER_PID 2>/dev/null || true' EXIT INT TERM

wait -n $INGEST_PID $RUNNER_PID
EXIT_CODE=$?
echo "entrypoint: a child process exited ($EXIT_CODE), shutting down"
exit $EXIT_CODE
