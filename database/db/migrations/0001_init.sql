CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chunks (
    id          BIGSERIAL PRIMARY KEY,
    started_at  TIMESTAMPTZ NOT NULL,
    ended_at    TIMESTAMPTZ NOT NULL,
    video_uri   TEXT,
    labels      TEXT[]      NOT NULL DEFAULT '{}',
    raw_json    JSONB       NOT NULL,
    embedding   vector(1024)
);

CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
    ON chunks USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS chunks_time_idx   ON chunks (started_at);
CREATE INDEX IF NOT EXISTS chunks_labels_gin ON chunks USING GIN (labels);
CREATE INDEX IF NOT EXISTS chunks_raw_gin    ON chunks USING GIN (raw_json jsonb_path_ops);
