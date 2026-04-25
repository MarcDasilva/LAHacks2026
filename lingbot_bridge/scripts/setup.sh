#!/usr/bin/env bash
# Run once on the GX10 (or any host doing the docker build) before
# `docker compose up`. Pulls the lingbot-map source repo into ./vendor and
# the model checkpoint into ./models.
set -euo pipefail

cd "$(dirname "$0")/.."

LINGBOT_REPO="${LINGBOT_REPO:-https://github.com/robbyant/lingbot-map.git}"
LINGBOT_REF="${LINGBOT_REF:-main}"

mkdir -p vendor models

if [ ! -d vendor/lingbot-map/.git ]; then
    echo "==> cloning $LINGBOT_REPO @ $LINGBOT_REF"
    git clone --depth 1 --branch "$LINGBOT_REF" "$LINGBOT_REPO" vendor/lingbot-map
else
    echo "==> vendor/lingbot-map already present, fetching latest"
    git -C vendor/lingbot-map fetch --depth 1 origin "$LINGBOT_REF"
    git -C vendor/lingbot-map checkout "$LINGBOT_REF"
    git -C vendor/lingbot-map pull --ff-only
fi

./scripts/download_model.sh

cat <<EOF

==> setup complete.
    vendor/lingbot-map  (source)
    models/             ($(ls -1 models 2>/dev/null | wc -l) file(s))

Next:
    cp .env.example .env  # if you haven't
    docker compose up -d --build
EOF
