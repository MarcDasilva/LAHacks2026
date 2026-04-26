"""Persist normalized memory events into Postgres windows."""

from __future__ import annotations

from typing import Any

import psycopg

from ingest.config import clip_uri
from ingest.embed import embed
from ingest.events import MemoryEvent, normalize_event


def ingest_record(cur: psycopg.Cursor, record: dict[str, Any]) -> dict[str, Any]:
    event = normalize_event(record)
    existing = _load_chunk(cur, event.camera_id, event.started_at)
    chunk = _merge_chunk(existing, event)
    chunk["embedding"] = embed(chunk["search_text"])
    chunk["video_uri"] = chunk["video_uri"] or clip_uri(chunk["started_at"], chunk["camera_id"])
    _save_chunk(cur, chunk)
    return chunk


def _load_chunk(cur: psycopg.Cursor, camera_id: str, started_at) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT id, camera_id, session_id, started_at, ended_at, video_uri,
               labels, yolo_text, stt_text, yamnet_text, search_text, raw_json
        FROM chunks
        WHERE camera_id = %s AND started_at = %s
        """,
        (camera_id, started_at),
    )
    row = cur.fetchone()
    if row is None:
        return None
    return {
        "id": row[0],
        "camera_id": row[1],
        "session_id": row[2],
        "started_at": row[3],
        "ended_at": row[4],
        "video_uri": row[5],
        "labels": list(row[6] or []),
        "yolo_text": row[7] or "",
        "stt_text": row[8] or "",
        "yamnet_text": row[9] or "",
        "search_text": row[10] or "",
        "raw_json": row[11] or {},
    }


def _merge_chunk(existing: dict[str, Any] | None, event: MemoryEvent) -> dict[str, Any]:
    chunk = existing or {
        "camera_id": event.camera_id,
        "session_id": event.session_id,
        "started_at": event.started_at,
        "ended_at": event.ended_at,
        "video_uri": None,
        "labels": [],
        "yolo_text": "",
        "stt_text": "",
        "yamnet_text": "",
        "search_text": "",
        "raw_json": {},
    }

    chunk["camera_id"] = event.camera_id
    chunk["session_id"] = event.session_id or chunk.get("session_id")
    chunk["ended_at"] = max(chunk["ended_at"], event.ended_at)
    chunk["labels"] = _merge_labels(chunk.get("labels"), event.labels)
    chunk["yolo_text"] = _merge_text(chunk.get("yolo_text"), event.yolo_text)
    chunk["stt_text"] = _merge_text(chunk.get("stt_text"), event.stt_text)
    chunk["yamnet_text"] = _merge_text(chunk.get("yamnet_text"), event.yamnet_text)
    chunk["raw_json"] = _merge_raw_json(chunk.get("raw_json"), event)
    chunk["search_text"] = _build_search_text(chunk)
    return chunk


def _save_chunk(cur: psycopg.Cursor, chunk: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO chunks (
            camera_id,
            session_id,
            started_at,
            ended_at,
            video_uri,
            labels,
            yolo_text,
            stt_text,
            yamnet_text,
            search_text,
            raw_json,
            embedding
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (camera_id, started_at) DO UPDATE SET
            session_id = EXCLUDED.session_id,
            ended_at = EXCLUDED.ended_at,
            video_uri = EXCLUDED.video_uri,
            labels = EXCLUDED.labels,
            yolo_text = EXCLUDED.yolo_text,
            stt_text = EXCLUDED.stt_text,
            yamnet_text = EXCLUDED.yamnet_text,
            search_text = EXCLUDED.search_text,
            raw_json = EXCLUDED.raw_json,
            embedding = EXCLUDED.embedding
        """,
        (
            chunk["camera_id"],
            chunk.get("session_id"),
            chunk["started_at"],
            chunk["ended_at"],
            chunk.get("video_uri"),
            chunk.get("labels", []),
            chunk.get("yolo_text", ""),
            chunk.get("stt_text", ""),
            chunk.get("yamnet_text", ""),
            chunk.get("search_text", ""),
            psycopg.types.json.Jsonb(chunk.get("raw_json", {})),
            chunk["embedding"],
        ),
    )


def _merge_labels(existing: list[str] | None, incoming: list[str] | None) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for label in (existing or []) + (incoming or []):
        normalized = str(label).strip().lower()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        merged.append(normalized)
    return merged


def _merge_text(existing: str | None, incoming: str | None) -> str:
    pieces: list[str] = []
    seen: set[str] = set()

    for blob in [existing or "", incoming or ""]:
        for line in blob.splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            key = cleaned.casefold()
            if key in seen:
                continue
            seen.add(key)
            pieces.append(cleaned)

    return "\n".join(pieces[-8:])


def _merge_raw_json(existing: Any, event: MemoryEvent) -> dict[str, Any]:
    prior_events = _extract_events(existing)
    prior_events.append(event.raw_json)
    return {
        "camera_id": event.camera_id,
        "session_id": event.session_id,
        "events": prior_events[-64:],
    }


def _extract_events(raw_json: Any) -> list[Any]:
    if isinstance(raw_json, dict):
        if isinstance(raw_json.get("events"), list):
            return list(raw_json["events"])
        if isinstance(raw_json.get("records"), list):
            return list(raw_json["records"])
        if raw_json:
            return [raw_json]
    return []


def _build_search_text(chunk: dict[str, Any]) -> str:
    parts = [f"camera {chunk['camera_id']}"]

    labels = chunk.get("labels") or []
    if labels:
        parts.append("objects " + ", ".join(labels))

    yolo_text = (chunk.get("yolo_text") or "").strip()
    if yolo_text:
        parts.append("visual detections " + yolo_text)

    stt_text = (chunk.get("stt_text") or "").strip()
    if stt_text:
        parts.append("speech transcript " + stt_text)

    yamnet_text = (chunk.get("yamnet_text") or "").strip()
    if yamnet_text:
        parts.append("audio events " + yamnet_text)

    return "\n".join(parts)
