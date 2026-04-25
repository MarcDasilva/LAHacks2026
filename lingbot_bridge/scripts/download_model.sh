#!/usr/bin/env bash
# Downloads the LingBot-Map checkpoint from Hugging Face into ./models.
# Idempotent — skips if the file already exists at the expected size.
set -euo pipefail

cd "$(dirname "$0")/.."

REPO="${LINGBOT_HF_REPO:-robbyant/lingbot-map}"
DEST_DIR="${LINGBOT_MODEL_DIR:-./models}"

mkdir -p "$DEST_DIR"

if ! command -v huggingface-cli >/dev/null 2>&1; then
    echo "huggingface-cli not found, installing..."
    pip install --quiet "huggingface_hub[cli]" hf_transfer
fi

export HF_HUB_ENABLE_HF_TRANSFER=1

echo "==> downloading $REPO into $DEST_DIR"
huggingface-cli download "$REPO" \
    --local-dir "$DEST_DIR" \
    --local-dir-use-symlinks False \
    ${HF_TOKEN:+--token "$HF_TOKEN"}

echo "==> done."
ls -lh "$DEST_DIR"
