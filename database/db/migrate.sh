#!/usr/bin/env bash
# Tiny SQL migration runner.
#
# Applies every db/migrations/*.sql file (in lexicographic order) that
# hasn't been recorded in the schema_migrations table yet. Each file runs
# in a single transaction; if it fails, nothing is recorded and the next
# run will retry.
#
# Usage:
#   ./db/migrate.sh                  # uses $PG_DSN
#   PG_DSN="..." ./db/migrate.sh
#
# To add a migration: drop a new file in db/migrations/ named
# <NNNN>_<slug>.sql with a strictly-greater number than the latest, then
# rerun this script. Never edit a migration that's already been applied.

set -euo pipefail

cd "$(dirname "$0")/.."

default_dsn() {
    local base="host=127.0.0.1 dbname=lingbot user=lingbot password=lingbot"
    if command -v pg_isready >/dev/null 2>&1; then
        if pg_isready -q -h 127.0.0.1 -p 5433; then
            echo "$base port=5433"
            return
        fi
        if pg_isready -q -h 127.0.0.1 -p 5432; then
            echo "$base port=5432"
            return
        fi
    fi
    echo "$base port=5433"
}

PG_DSN="${PG_DSN:-$(default_dsn)}"
MIGRATIONS_DIR="db/migrations"

psql_run() { psql "$PG_DSN" -v ON_ERROR_STOP=1 -X -q "$@"; }

psql_run -c "
    CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
" >/dev/null

applied="$(psql_run -At -c 'SELECT version FROM schema_migrations ORDER BY version' | sort)"

shopt -s nullglob
files=( "$MIGRATIONS_DIR"/*.sql )
shopt -u nullglob

if (( ${#files[@]} == 0 )); then
    echo "no migration files in $MIGRATIONS_DIR" >&2
    exit 1
fi

ran=0
for f in "${files[@]}"; do
    version="$(basename "$f" .sql)"
    if grep -Fxq "$version" <<<"$applied"; then
        continue
    fi
    echo "[migrate] applying $version"
    psql_run -1 -f "$f" >/dev/null
    psql_run -c "INSERT INTO schema_migrations (version) VALUES ('$version')" >/dev/null
    ran=$(( ran + 1 ))
done

if (( ran == 0 )); then
    echo "[migrate] up to date"
else
    echo "[migrate] applied $ran migration(s)"
fi
