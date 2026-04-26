"""Database connection defaults for local dev and dockerized setups."""

from __future__ import annotations

import os
import socket

_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_DB = "lingbot"
_DEFAULT_USER = "lingbot"
_DEFAULT_PASSWORD = "lingbot"
_DEFAULT_PORTS = (5433, 5432)


def default_dsn() -> str:
    explicit = os.environ.get("PG_DSN")
    if explicit:
        return explicit

    for port in _DEFAULT_PORTS:
        if _is_port_open(_DEFAULT_HOST, port):
            return _build_dsn(port)

    return _build_dsn(_DEFAULT_PORTS[0])


def _build_dsn(port: int) -> str:
    return (
        f"host={_DEFAULT_HOST} port={port} "
        f"dbname={_DEFAULT_DB} user={_DEFAULT_USER} password={_DEFAULT_PASSWORD}"
    )


def _is_port_open(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.2):
            return True
    except OSError:
        return False
