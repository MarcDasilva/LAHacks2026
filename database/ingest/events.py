"""Normalize live model outputs and legacy recognition records into one shape."""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from ingest.config import sanitize_camera_id
from ingest.windows import bucket_bounds

_YOLO_PERCENT_RE = re.compile(r"\s+\d+%.*$")
_MULTISPACE_RE = re.compile(r"\s+")


@dataclass
class MemoryEvent:
    camera_id: str
    session_id: str | None
    kind: str | None
    event_ts: datetime
    started_at: datetime
    ended_at: datetime
    labels: list[str]
    yolo_text: str
    stt_text: str
    yamnet_text: str
    raw_json: dict[str, Any]


def normalize_event(record: dict[str, Any]) -> MemoryEvent:
    payload = _payload_of(record)
    kind = _kind_of(record)
    camera_id = sanitize_camera_id(
        _first_non_empty(
            record.get("camera_id"),
            record.get("cameraId"),
            record.get("roomId"),
            payload.get("camera_id"),
            payload.get("cameraId"),
        )
    )
    session_id = _optional_text(
        _first_non_empty(
            record.get("session_id"),
            record.get("sessionID"),
            payload.get("session_id"),
            payload.get("sessionID"),
        )
    )
    event_ts = _timestamp_of(record, payload)
    started_at, ended_at = bucket_bounds(event_ts)
    text = _extract_text(record, payload)

    labels = _labels_of(record, payload, kind, text)
    yolo_text = text if kind == "yolo" else ""
    stt_text = text if kind == "stt" else ""
    yamnet_text = text if kind == "yamnet" else ""

    if kind is None and labels and not yolo_text:
        yolo_text = ", ".join(labels)

    return MemoryEvent(
        camera_id=camera_id,
        session_id=session_id,
        kind=kind,
        event_ts=event_ts,
        started_at=started_at,
        ended_at=ended_at,
        labels=labels,
        yolo_text=yolo_text,
        stt_text=stt_text,
        yamnet_text=yamnet_text,
        raw_json=record,
    )


def _payload_of(record: dict[str, Any]) -> dict[str, Any]:
    payload = record.get("payload")
    return payload if isinstance(payload, dict) else record


def _kind_of(record: dict[str, Any]) -> str | None:
    raw = _optional_text(record.get("kind"))
    if raw in {"yolo", "stt", "yamnet"}:
        return raw
    return None


def _timestamp_of(record: dict[str, Any], payload: dict[str, Any]) -> datetime:
    chunk = payload.get("chunk")
    if isinstance(chunk, dict):
        raw = _first_non_empty(chunk.get("startedAt"), chunk.get("endedAt"))
        if raw is not None:
            return _parse_datetime(raw)

    raw = _first_non_empty(
        record.get("ts"),
        record.get("timestamp"),
        record.get("emittedAt"),
        payload.get("ts"),
        payload.get("timestamp"),
        payload.get("emittedAt"),
    )
    if raw is None:
        raise ValueError(f"record missing timestamp: {record!r}")
    return _parse_datetime(raw)


def _extract_text(record: dict[str, Any], payload: dict[str, Any]) -> str:
    output = payload.get("output")
    if isinstance(output, dict):
        text = _optional_text(output.get("text"))
        if text:
            return text
    return _optional_text(_first_non_empty(record.get("text"), payload.get("text"))) or ""


def _labels_of(
    record: dict[str, Any],
    payload: dict[str, Any],
    kind: str | None,
    text: str,
) -> list[str]:
    raw = record.get("labels")
    if raw is None:
        raw = payload.get("labels")

    labels: list[str] = []
    if isinstance(raw, list):
        labels.extend(_normalize_label(x) for x in raw)

    detections = payload.get("detections")
    if isinstance(detections, list):
        for item in detections:
            if isinstance(item, dict):
                labels.append(_normalize_label(item.get("item") or item.get("label")))

    if kind == "yolo":
        labels.extend(_labels_from_yolo_text(text))
    elif kind == "yamnet":
        labels.extend(_labels_from_generic_text(text))

    deduped: list[str] = []
    seen: set[str] = set()
    for label in labels:
        if not label:
            continue
        lowered = label.casefold()
        if lowered in seen:
            continue
        seen.add(lowered)
        deduped.append(label)
    return deduped


def _labels_from_yolo_text(text: str) -> list[str]:
    lowered = text.strip().lower()
    if not lowered or lowered == "no objects detected.":
        return []

    labels: list[str] = []
    for piece in text.split(","):
        candidate = _YOLO_PERCENT_RE.sub("", piece).strip(" .")
        normalized = _normalize_label(candidate)
        if normalized:
            labels.append(normalized)
    return labels


def _labels_from_generic_text(text: str) -> list[str]:
    if not text.strip():
        return []
    labels: list[str] = []
    for piece in text.split(","):
        normalized = _normalize_label(piece)
        if normalized:
            labels.append(normalized)
    return labels


def _normalize_label(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip().strip(".")
    text = _MULTISPACE_RE.sub(" ", text)
    return text.lower()


def _parse_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _first_non_empty(*values: Any) -> Any:
    for value in values:
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def _optional_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None
