#!/usr/bin/env bash
# Downloads the LingBot-Map checkpoint from Hugging Face into ./models.
# Idempotent — skips files already downloaded.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO="${LINGBOT_HF_REPO:-robbyant/lingbot-map}"
DEST_DIR="${LINGBOT_MODEL_DIR:-./models}"

mkdir -p "$DEST_DIR"

# Pick the available CLI. `hf` replaced `huggingface-cli` in huggingface_hub 1.x.
if command -v hf >/dev/null 2>&1; then
    HF_CMD=hf
elif command -v huggingface-cli >/dev/null 2>&1; then
    HF_CMD=huggingface-cli
else
    echo "no HF CLI found, installing huggingface_hub..."
    pip install --quiet huggingface_hub hf_transfer
    HF_CMD=hf
fi

export HF_HUB_ENABLE_HF_TRANSFER=1

echo "==> downloading $REPO into $DEST_DIR (via $HF_CMD)"
"$HF_CMD" download "$REPO" \
    --local-dir "$DEST_DIR" \
    ${HF_TOKEN:+--token "$HF_TOKEN"}

echo "==> done."
ls -lh "$DEST_DIR"
