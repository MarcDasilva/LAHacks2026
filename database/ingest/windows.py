"""5-second windowing for the recognition JSON stream.

Each upstream record is expected to look roughly like:

    {
        "ts": "2026-04-25T14:32:07.123Z",   # ISO-8601 with timezone
        "labels": ["person", "fall", "lying_on_floor"],
        ...arbitrary other fields...
    }

The aggregator groups records into fixed 5-second buckets aligned to the
unix epoch (so all consumers agree on bucket boundaries). When a bucket is
"closed" -- i.e. a record arrives whose timestamp falls in a later bucket --
the closed bucket is yielded for embedding + DB insert.

Labels from every record in a window are deduplicated into a single set.
The embedded text is a space-joined string of those labels; the upstream
model is expected to mix object classes ("person") with action/event
labels ("fall", "lying_on_floor") so semantic queries still resolve.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Iterable, Iterator

# 5-second windowing
WINDOW_SECONDS = 5


@dataclass
class Window:
    started_at: datetime
    ended_at: datetime
    label_set: set[str] = field(default_factory=set)
    records: list[dict] = field(default_factory=list)

    @property
    def labels(self) -> list[str]:
        return sorted(self.label_set)

    @property
    def label_text(self) -> str:
        return " ".join(self.labels)

    @property
    def raw_json(self) -> dict:
        return {"records": self.records}


def _bucket_start(ts: datetime) -> datetime:
    epoch = ts.timestamp()
    floored = (epoch // WINDOW_SECONDS) * WINDOW_SECONDS
    return datetime.fromtimestamp(floored, tz=timezone.utc)


def bucket_bounds(ts: datetime) -> tuple[datetime, datetime]:
    started_at = _bucket_start(ts)
    return started_at, started_at + timedelta(seconds=WINDOW_SECONDS)


def _parse_ts(record: dict) -> datetime:
    raw = record.get("ts") or record.get("timestamp")
    if raw is None:
        raise ValueError(f"record missing ts/timestamp: {record!r}")
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=timezone.utc)
    s = str(raw).replace("Z", "+00:00")
    return datetime.fromisoformat(s)


def _labels_of(record: dict) -> list[str]:
    raw = record.get("labels") or []
    return [str(x) for x in raw if str(x).strip()]


def aggregate(records: Iterable[dict]) -> Iterator[Window]:
    """Yield closed 5s windows from a stream of recognition records.

    Records are assumed (mostly) ordered. Out-of-order records that fall
    into a window already closed are dropped silently.
    """
    current: Window | None = None

    for rec in records:
        ts = _parse_ts(rec)
        bucket, bucket_end = bucket_bounds(ts)

        if current is None:
            current = Window(bucket, bucket_end)

        if bucket > current.started_at:
            yield current
            current = Window(bucket, bucket_end)
        elif bucket < current.started_at:
            continue

        current.label_set.update(_labels_of(rec))
        current.records.append(rec)

    if current is not None and current.records:
        yield current
