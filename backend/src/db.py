"""
SQLite persistence layer for the download queue.

Single table `jobs` holding both active and historical downloads.
WAL mode enabled so the WS background writers don't block API readers.
The actual video file is *not* persisted — only the metadata needed to
display history and re-trigger a download.
"""
from __future__ import annotations

import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

# ── Paths ─────────────────────────────────────────────────────────────────────

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.path.join(_BACKEND_ROOT, "data")
_DB_PATH = os.path.join(_DATA_DIR, "queue.db")

# Thread-local connection so each worker thread gets its own handle.
_local = threading.local()
_write_lock = threading.Lock()


# ── Connection / schema ───────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    os.makedirs(_DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(_DB_PATH, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    return conn


@contextmanager
def _write() -> Iterator[sqlite3.Connection]:
    """Serialize writes across threads. SQLite handles concurrent readers."""
    conn = _get_conn()
    with _write_lock:
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise


_SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    title           TEXT,
    uploader        TEXT,
    thumbnail_url   TEXT,
    duration_sec    INTEGER,
    format_code     TEXT NOT NULL,
    resolution      TEXT,
    ext             TEXT,
    size_bytes      INTEGER,
    status          TEXT NOT NULL,
    progress_pct    REAL NOT NULL DEFAULT 0,
    error_message   TEXT,
    is_playlist     INTEGER NOT NULL DEFAULT 0,
    playlist_title  TEXT,
    playlist_count  INTEGER,
    created_at      TEXT NOT NULL,
    started_at      TEXT,
    completed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);

CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL,
    username            TEXT NOT NULL,
    role                TEXT NOT NULL,
    access_token        TEXT NOT NULL,
    refresh_cookie      TEXT,
    access_expires_at   TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
"""

ROLE_ADMIN = "ADMIN"
ROLE_USER = "USER"

# Statuses (kept as constants here so callers don't drift)
QUEUED = "queued"
DOWNLOADING = "downloading"
MERGING = "merging"
TRANSCODING = "transcoding"
DONE = "done"
ERROR = "error"
INTERRUPTED = "interrupted"
CANCELLED = "cancelled"

ACTIVE_STATUSES = (QUEUED, DOWNLOADING, MERGING, TRANSCODING)


def init() -> None:
    """Create schema, then mark any jobs left mid-flight as interrupted."""
    with _write() as conn:
        conn.executescript(_SCHEMA)
        # Idempotent ALTER for owner_id (legacy DBs predate this column).
        cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
        if "owner_id" not in cols:
            conn.execute("ALTER TABLE jobs ADD COLUMN owner_id TEXT")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id)")
        conn.execute(
            f"UPDATE jobs SET status = '{INTERRUPTED}', error_message = ? "
            f"WHERE status IN ({','.join('?' * len(ACTIVE_STATUSES))})",
            ("interrupted by backend restart", *ACTIVE_STATUSES),
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


# ── CRUD ──────────────────────────────────────────────────────────────────────

def create_job(
    *,
    job_id: str,
    url: str,
    format_code: str,
    is_playlist: bool = False,
    resolution: str | None = None,
    ext: str | None = None,
    owner_id: str | None = None,
) -> None:
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                id, url, format_code, status, progress_pct,
                is_playlist, resolution, ext, owner_id, created_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                url,
                format_code,
                QUEUED,
                1 if is_playlist else 0,
                resolution,
                ext,
                owner_id,
                _now(),
            ),
        )


def set_metadata(
    job_id: str,
    *,
    title: str | None = None,
    uploader: str | None = None,
    thumbnail_url: str | None = None,
    duration_sec: int | None = None,
    playlist_title: str | None = None,
    playlist_count: int | None = None,
) -> None:
    """Populate fields we only learn once yt-dlp has parsed the URL."""
    updates: list[str] = []
    params: list[Any] = []
    for key, val in (
        ("title", title),
        ("uploader", uploader),
        ("thumbnail_url", thumbnail_url),
        ("duration_sec", duration_sec),
        ("playlist_title", playlist_title),
        ("playlist_count", playlist_count),
    ):
        if val is not None:
            updates.append(f"{key} = ?")
            params.append(val)
    if not updates:
        return
    params.append(job_id)
    with _write() as conn:
        conn.execute(f"UPDATE jobs SET {', '.join(updates)} WHERE id = ?", params)


def mark_started(job_id: str) -> None:
    with _write() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, started_at = ? WHERE id = ?",
            (DOWNLOADING, _now(), job_id),
        )


def update_progress(job_id: str, progress_pct: float, status: str | None = None) -> None:
    with _write() as conn:
        if status:
            conn.execute(
                "UPDATE jobs SET progress_pct = ?, status = ? WHERE id = ?",
                (progress_pct, status, job_id),
            )
        else:
            conn.execute(
                "UPDATE jobs SET progress_pct = ? WHERE id = ?",
                (progress_pct, job_id),
            )


def finish(job_id: str, *, size_bytes: int | None = None) -> None:
    with _write() as conn:
        conn.execute(
            """
            UPDATE jobs
               SET status = ?, progress_pct = 100, size_bytes = ?, completed_at = ?
             WHERE id = ?
            """,
            (DONE, size_bytes, _now(), job_id),
        )


def fail(job_id: str, message: str) -> None:
    with _write() as conn:
        conn.execute(
            """
            UPDATE jobs
               SET status = ?, error_message = ?, completed_at = ?
             WHERE id = ?
            """,
            (ERROR, message, _now(), job_id),
        )


def cancel(job_id: str) -> None:
    with _write() as conn:
        conn.execute(
            "UPDATE jobs SET status = ?, completed_at = ? WHERE id = ?",
            (CANCELLED, _now(), job_id),
        )


def delete(job_id: str) -> None:
    with _write() as conn:
        conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))


def get(job_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _row_to_dict(row)


def list_jobs(*, owner_id: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    """
    Return jobs sorted newest-first. If `owner_id` is given, restrict to that
    owner (USER scope). When None, return every job (ADMIN scope).
    """
    conn = _get_conn()
    if owner_id is None:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jobs WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?",
            (owner_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ── Sessions ──────────────────────────────────────────────────────────────────

def create_session(
    *,
    session_id: str,
    user_id: str,
    username: str,
    role: str,
    access_token: str,
    refresh_cookie: str | None,
    access_expires_at: str,
) -> None:
    now = _now()
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO sessions (
                id, user_id, username, role,
                access_token, refresh_cookie,
                access_expires_at, created_at, last_seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id, user_id, username, role,
                access_token, refresh_cookie,
                access_expires_at, now, now,
            ),
        )


def get_session(session_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM sessions WHERE id = ?", (session_id,)
    ).fetchone()
    return _row_to_dict(row)


def touch_session(session_id: str) -> None:
    with _write() as conn:
        conn.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE id = ?",
            (_now(), session_id),
        )


def update_session_tokens(
    session_id: str,
    *,
    access_token: str,
    access_expires_at: str,
    refresh_cookie: str | None = None,
) -> None:
    with _write() as conn:
        if refresh_cookie is not None:
            conn.execute(
                """
                UPDATE sessions
                   SET access_token = ?, access_expires_at = ?,
                       refresh_cookie = ?, last_seen_at = ?
                 WHERE id = ?
                """,
                (access_token, access_expires_at, refresh_cookie, _now(), session_id),
            )
        else:
            conn.execute(
                """
                UPDATE sessions
                   SET access_token = ?, access_expires_at = ?, last_seen_at = ?
                 WHERE id = ?
                """,
                (access_token, access_expires_at, _now(), session_id),
            )


def delete_session(session_id: str) -> None:
    with _write() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
