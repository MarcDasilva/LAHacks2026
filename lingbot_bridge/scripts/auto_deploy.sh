#!/usr/bin/env bash
# Watch the remote git branch and auto-pull + restart the bridge whenever
# there's a new commit. Meant to run inside tmux/screen on the pod so we
# don't have to manually `git pull && ./scripts/restart.sh` after every
# push from the laptop.
#
# Usage:
#   ./scripts/auto_deploy.sh                # poll every 15s, branch=current
#   POLL=30 BRANCH=main ./scripts/auto_deploy.sh
set -euo pipefail

cd "$(dirname "$0")/../.."   # repo root

POLL="${POLL:-15}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

echo "==> auto-deploy watching origin/$BRANCH every ${POLL}s"
echo "    repo: $(pwd)"
echo "    initial HEAD: $(git rev-parse --short HEAD)"

# Make sure we restart at least once on startup, so the running bridge is
# always whatever's checked out right now.
( cd lingbot_bridge && ./scripts/restart.sh ) || echo "    initial restart failed; continuing to watch"

while true; do
    sleep "$POLL"

    if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
        echo "    [$(date +%H:%M:%S)] fetch failed; will retry"
        continue
    fi

    LOCAL=$(git rev-parse HEAD)
    REMOTE=$(git rev-parse "origin/$BRANCH")
    if [ "$LOCAL" = "$REMOTE" ]; then
        continue
    fi

    echo "==> [$(date +%H:%M:%S)] new commit detected: $(git rev-parse --short "$REMOTE")"
    if ! git pull --ff-only origin "$BRANCH"; then
        echo "    pull failed (non-ff?); skipping restart"
        continue
    fi

    echo "==> restarting bridge"
    ( cd lingbot_bridge && ./scripts/restart.sh ) || echo "    restart failed; will retry on next push"
done
