"""Text embedding wrapper. BGE-large-en-v1.5 by default (1024 dims).

Set EMBED_MODEL to override; the model dim must match `chunks.embedding`'s
declared vector(N) in db/init.sql.
"""

from __future__ import annotations

import os
from functools import lru_cache

import numpy as np
from sentence_transformers import SentenceTransformer

DEFAULT_MODEL = "BAAI/bge-large-en-v1.5"
EMBED_DIM = 1024


@lru_cache(maxsize=1)
def _model() -> SentenceTransformer:
    name = os.environ.get("EMBED_MODEL", DEFAULT_MODEL)
    device = os.environ.get("EMBED_DEVICE", "cpu")
    return SentenceTransformer(name, device=device)


def embed(text: str) -> np.ndarray:
    vec = _model().encode(text, normalize_embeddings=True)
    return np.asarray(vec, dtype=np.float32)


def embed_batch(texts: list[str]) -> np.ndarray:
    vecs = _model().encode(texts, normalize_embeddings=True, batch_size=16)
    return np.asarray(vecs, dtype=np.float32)
