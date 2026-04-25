# LAHacks2026

Monorepo for the project. Each top-level folder is one independently
runnable component:

| Folder | What lives here |
|--------|------------------|
| `database/` | Postgres + pgvector, ingest worker, search API, video clip storage. The recognition stream lands here and the UI queries it. |
| `backend/`  | _(planned)_ Application server / orchestration. |
| `frontend/` | _(planned)_ Web UI. |
| `ios/`      | _(planned)_ iOS client. |

See each folder's README for setup instructions.
