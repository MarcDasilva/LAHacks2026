CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS camera_id  TEXT NOT NULL DEFAULT 'main-camera',
    ADD COLUMN IF NOT EXISTS session_id TEXT,
    ADD COLUMN IF NOT EXISTS yolo_text  TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS stt_text   TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS yamnet_text TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';

UPDATE chunks
SET search_text = CASE
    WHEN search_text <> '' THEN search_text
    WHEN array_length(labels, 1) IS NULL THEN ''
    ELSE array_to_string(labels, ', ')
END
WHERE search_text = '';

CREATE UNIQUE INDEX IF NOT EXISTS chunks_camera_window_uidx
    ON chunks (camera_id, started_at);

CREATE INDEX IF NOT EXISTS chunks_camera_time_idx
    ON chunks (camera_id, started_at DESC);

CREATE INDEX IF NOT EXISTS chunks_search_text_trgm_idx
    ON chunks USING GIN (search_text gin_trgm_ops);
