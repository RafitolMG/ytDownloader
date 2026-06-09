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
# YTDL_DATA_DIR lets the deployment point the database at a mounted volume so it
# survives container redeploys (sessions + play history). Defaults to the
# in-repo ./data for local dev. In the Docker image this resolves to /app/data,
# which Coolify should back with persistent storage.
_DATA_DIR = os.environ.get("YTDL_DATA_DIR") or os.path.join(_BACKEND_ROOT, "data")
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

-- ── Music library ────────────────────────────────────────────────────────────
-- `tracks`: the master registry of physical audio files. One row per
-- (video_id, codec, bitrate) — shared across all users so the same source is
-- never downloaded twice.
CREATE TABLE IF NOT EXISTS tracks (
    video_id        TEXT NOT NULL,
    codec           TEXT NOT NULL,       -- 'mp3' | 'm4a' | 'flac' | ...
    bitrate         TEXT NOT NULL,       -- '192' | '320' | 'lossless' | '0'
    title           TEXT,
    artist          TEXT,                -- yt uploader
    duration_sec    INTEGER,
    thumbnail_url   TEXT,
    source_url      TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    file_size       INTEGER,
    sha256          TEXT,
    downloaded_at   TEXT NOT NULL,
    PRIMARY KEY (video_id, codec, bitrate)
);

-- `track_owners`: per-user library membership. Multiple owners can reference
-- the same physical file in `tracks`.
CREATE TABLE IF NOT EXISTS track_owners (
    owner_id              TEXT NOT NULL,
    video_id              TEXT NOT NULL,
    codec                 TEXT NOT NULL,
    bitrate               TEXT NOT NULL,
    added_at              TEXT NOT NULL,
    source_playlist_title TEXT,
    PRIMARY KEY (owner_id, video_id, codec, bitrate),
    FOREIGN KEY (video_id, codec, bitrate)
        REFERENCES tracks(video_id, codec, bitrate) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_track_owners_owner ON track_owners(owner_id, added_at DESC);

-- `track_likes`: heart/favorite. Independent from ownership so a user can
-- like a track without adding it to their library, and vice versa.
CREATE TABLE IF NOT EXISTS track_likes (
    user_id  TEXT NOT NULL,
    video_id TEXT NOT NULL,
    codec    TEXT NOT NULL,
    bitrate  TEXT NOT NULL,
    liked_at TEXT NOT NULL,
    PRIMARY KEY (user_id, video_id, codec, bitrate),
    FOREIGN KEY (video_id, codec, bitrate)
        REFERENCES tracks(video_id, codec, bitrate) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_track_likes_track ON track_likes(video_id, codec, bitrate);
CREATE INDEX IF NOT EXISTS idx_track_likes_user  ON track_likes(user_id, liked_at DESC);

-- `plays`: one row per recorded playback. Append-only listening log that powers
-- "recently played" and personalized daily mixes. A play is recorded only after
-- the track has been listened to for a while (the client gates on ~20s) so
-- skips don't pollute the signal.
CREATE TABLE IF NOT EXISTS plays (
    user_id   TEXT NOT NULL,
    video_id  TEXT NOT NULL,
    codec     TEXT NOT NULL,
    bitrate   TEXT NOT NULL,
    played_at TEXT NOT NULL,
    FOREIGN KEY (video_id, codec, bitrate)
        REFERENCES tracks(video_id, codec, bitrate) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plays_user_time  ON plays(user_id, played_at DESC);
CREATE INDEX IF NOT EXISTS idx_plays_user_track ON plays(user_id, video_id, codec, bitrate);

-- ── Playlists ────────────────────────────────────────────────────────────────
-- User-curated lists of tracks pulled from the shared catalog. Visibility is
-- per playlist: 'public' means any authenticated user can see and play it but
-- only the owner can mutate. 'private' is owner-only end-to-end.
CREATE TABLE IF NOT EXISTS playlists (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    visibility   TEXT NOT NULL DEFAULT 'private',  -- 'public' | 'private'
    cover_url    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_playlists_owner      ON playlists(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_playlists_visibility ON playlists(visibility, updated_at DESC);

-- `playlist_tracks`: ordered M2M between playlists and tracks. `position` is
-- a sparse integer (gaps allowed) so reorders can be O(1) per move without a
-- full renumber. The (playlist_id, position) unique index is enforced at the
-- application level on insert.
CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id TEXT NOT NULL,
    video_id    TEXT NOT NULL,
    codec       TEXT NOT NULL,
    bitrate     TEXT NOT NULL,
    position    INTEGER NOT NULL,
    added_at    TEXT NOT NULL,
    PRIMARY KEY (playlist_id, video_id, codec, bitrate),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (video_id, codec, bitrate)
        REFERENCES tracks(video_id, codec, bitrate) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_playlist_tracks_pos ON playlist_tracks(playlist_id, position);
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


# ── Music library ────────────────────────────────────────────────────────────

def get_track(video_id: str, codec: str, bitrate: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM tracks WHERE video_id = ? AND codec = ? AND bitrate = ?",
        (video_id, codec, bitrate),
    ).fetchone()
    return _row_to_dict(row)


def register_track(
    *,
    video_id: str,
    codec: str,
    bitrate: str,
    title: str | None,
    artist: str | None,
    duration_sec: int | None,
    thumbnail_url: str | None,
    source_url: str,
    file_path: str,
    file_size: int | None,
    sha256: str | None,
) -> None:
    """Idempotent: re-registering an existing track overwrites the row."""
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO tracks (
                video_id, codec, bitrate, title, artist, duration_sec,
                thumbnail_url, source_url, file_path, file_size, sha256, downloaded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id, codec, bitrate) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                duration_sec = excluded.duration_sec,
                thumbnail_url = excluded.thumbnail_url,
                source_url = excluded.source_url,
                file_path = excluded.file_path,
                file_size = excluded.file_size,
                sha256 = excluded.sha256,
                downloaded_at = excluded.downloaded_at
            """,
            (
                video_id, codec, bitrate, title, artist, duration_sec,
                thumbnail_url, source_url, file_path, file_size, sha256, _now(),
            ),
        )


def link_owner(
    *,
    owner_id: str,
    video_id: str,
    codec: str,
    bitrate: str,
    source_playlist_title: str | None = None,
) -> None:
    """Idempotent: links a user to a track. Existing rows are left untouched
    so we don't overwrite an earlier `source_playlist_title`."""
    with _write() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO track_owners (
                owner_id, video_id, codec, bitrate, added_at, source_playlist_title
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (owner_id, video_id, codec, bitrate, _now(), source_playlist_title),
        )


def is_owned(owner_id: str, video_id: str, codec: str, bitrate: str) -> bool:
    conn = _get_conn()
    row = conn.execute(
        """
        SELECT 1 FROM track_owners
         WHERE owner_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
         LIMIT 1
        """,
        (owner_id, video_id, codec, bitrate),
    ).fetchone()
    return row is not None


def count_owners(video_id: str, codec: str, bitrate: str) -> int:
    conn = _get_conn()
    row = conn.execute(
        """
        SELECT COUNT(*) AS n FROM track_owners
         WHERE video_id = ? AND codec = ? AND bitrate = ?
        """,
        (video_id, codec, bitrate),
    ).fetchone()
    return int(row["n"]) if row else 0


def unlink_owner(
    owner_id: str, video_id: str, codec: str, bitrate: str
) -> bool:
    """Remove a user from a track's owner list. The master `tracks` row and
    the underlying file are **always** preserved — catalog/library actions
    must not silently delete shared assets. Reclaiming orphans is a separate
    admin concern (see `delete_track_master`).

    Returns True iff a row was actually removed.
    """
    with _write() as conn:
        cur = conn.execute(
            """
            DELETE FROM track_owners
             WHERE owner_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
            """,
            (owner_id, video_id, codec, bitrate),
        )
        return cur.rowcount > 0


def delete_track_master(video_id: str, codec: str, bitrate: str) -> str | None:
    """Hard-delete the master row + return its file_path so the caller can
    rm the physical file. Intended for admin cleanup of orphans, NOT for
    normal user-facing library removals."""
    with _write() as conn:
        row = conn.execute(
            "SELECT file_path FROM tracks WHERE video_id = ? AND codec = ? AND bitrate = ?",
            (video_id, codec, bitrate),
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            "DELETE FROM tracks WHERE video_id = ? AND codec = ? AND bitrate = ?",
            (video_id, codec, bitrate),
        )
        return row["file_path"]


def list_library(owner_id: str, limit: int = 500) -> list[dict[str, Any]]:
    """Return the caller's library — joins track_owners with tracks."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT t.video_id, t.codec, t.bitrate, t.title, t.artist, t.duration_sec,
               t.thumbnail_url, t.source_url, t.file_size,
               o.added_at, o.source_playlist_title
          FROM track_owners o
          JOIN tracks t
            ON t.video_id = o.video_id
           AND t.codec = o.codec
           AND t.bitrate = o.bitrate
         WHERE o.owner_id = ?
         ORDER BY o.added_at DESC
         LIMIT ?
        """,
        (owner_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Catalog (shared global view of `tracks`) ──────────────────────────────────

_CATALOG_SORTS = {
    'newest': 't.downloaded_at DESC',
    # "popular" used to be likes; after merging like↔library, popularity is the
    # number of users who have the track in their library (owner_count).
    'popular': 'owner_count DESC, t.downloaded_at DESC',
    'title':  "COALESCE(t.title, '') COLLATE NOCASE ASC",
    'artist': "COALESCE(t.artist, '') COLLATE NOCASE ASC, COALESCE(t.title, '') COLLATE NOCASE ASC",
}


def list_catalog(
    viewer_id: str,
    *,
    query: str | None = None,
    sort: str = 'newest',
    owned_only: bool = False,
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Return every track in the shared registry, annotated with social state
    relative to `viewer_id`: `is_owned`, `owner_count`.

    `query` is a case-insensitive substring match against title/artist.
    `sort` is one of `_CATALOG_SORTS` keys; unknown values fall back to 'newest'.
    `owned_only` restricts results to tracks `viewer_id` has in their library —
    this is what powers the catalog's "mine" view (the former Library page).
    """
    order_by = _CATALOG_SORTS.get(sort, _CATALOG_SORTS['newest'])

    # Positional params must line up with the order `?` placeholders appear in
    # the final SQL text: the SELECT's is_owned EXISTS first, then WHERE
    # conditions, then LIMIT/OFFSET.
    conditions: list[str] = []
    where_params: list[Any] = []
    if query:
        conditions.append("(t.title LIKE ? OR t.artist LIKE ?)")
        wildcard = f"%{query}%"
        where_params.extend([wildcard, wildcard])
    if owned_only:
        conditions.append(
            """EXISTS(SELECT 1 FROM track_owners o4
                    WHERE o4.owner_id = ?
                      AND o4.video_id = t.video_id
                      AND o4.codec    = t.codec
                      AND o4.bitrate  = t.bitrate)"""
        )
        where_params.append(viewer_id)
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
    params: list[Any] = [viewer_id, *where_params, limit, offset]

    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT
            t.video_id, t.codec, t.bitrate, t.title, t.artist, t.duration_sec,
            t.thumbnail_url, t.source_url, t.file_size, t.downloaded_at,
            (SELECT COUNT(*) FROM track_owners o2
              WHERE o2.video_id = t.video_id
                AND o2.codec    = t.codec
                AND o2.bitrate  = t.bitrate) AS owner_count,
            EXISTS(SELECT 1 FROM track_owners o3
                    WHERE o3.owner_id = ?
                      AND o3.video_id = t.video_id
                      AND o3.codec    = t.codec
                      AND o3.bitrate  = t.bitrate) AS is_owned
          FROM tracks t
          {where}
         ORDER BY {order_by}
         LIMIT ? OFFSET ?
        """,
        tuple(params),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Play history ───────────────────────────────────────────────────────────────

# Reused SELECT for catalog-item-shaped rows. The single `?` is the viewer for
# the is_owned flag and must be the first bound param wherever this is spliced in.
_TRACK_COLS = """
    t.video_id, t.codec, t.bitrate, t.title, t.artist, t.duration_sec,
    t.thumbnail_url, t.source_url, t.file_size, t.downloaded_at,
    (SELECT COUNT(*) FROM track_owners o2
      WHERE o2.video_id = t.video_id
        AND o2.codec    = t.codec
        AND o2.bitrate  = t.bitrate) AS owner_count,
    EXISTS(SELECT 1 FROM track_owners o3
            WHERE o3.owner_id = ?
              AND o3.video_id = t.video_id
              AND o3.codec    = t.codec
              AND o3.bitrate  = t.bitrate) AS is_owned
"""


def record_play(user_id: str, video_id: str, codec: str, bitrate: str) -> None:
    """Append a playback to the listening log. No-op safety: the FK to `tracks`
    means a play for a track that no longer exists raises — callers swallow it."""
    with _write() as conn:
        conn.execute(
            "INSERT INTO plays (user_id, video_id, codec, bitrate, played_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (user_id, video_id, codec, bitrate, _now()),
        )


def list_recent_plays(viewer_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
    """Most recently played tracks (distinct), newest first — catalog-item shaped
    plus `last_played_at` and `play_count`."""
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT {_TRACK_COLS},
               MAX(p.played_at) AS last_played_at,
               COUNT(*)         AS play_count
          FROM plays p
          JOIN tracks t
            ON p.video_id = t.video_id
           AND p.codec    = t.codec
           AND p.bitrate  = t.bitrate
         WHERE p.user_id = ?
         GROUP BY t.video_id, t.codec, t.bitrate
         ORDER BY last_played_at DESC
         LIMIT ?
        """,
        (viewer_id, viewer_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def top_played_tracks(
    viewer_id: str, *, limit: int = 50, since: str | None = None,
) -> list[dict[str, Any]]:
    """Most-played tracks for a user, catalog-item shaped plus `play_count`.
    `since` is an ISO timestamp lower bound on played_at (None = all time)."""
    conn = _get_conn()
    where = "WHERE p.user_id = ?"
    params: list[Any] = [viewer_id, viewer_id]
    if since:
        where += " AND p.played_at >= ?"
        params.append(since)
    params.append(limit)
    rows = conn.execute(
        f"""
        SELECT {_TRACK_COLS},
               COUNT(*) AS play_count
          FROM plays p
          JOIN tracks t
            ON p.video_id = t.video_id
           AND p.codec    = t.codec
           AND p.bitrate  = t.bitrate
         {where}
         GROUP BY t.video_id, t.codec, t.bitrate
         ORDER BY play_count DESC, MAX(p.played_at) DESC
         LIMIT ?
        """,
        tuple(params),
    ).fetchall()
    return [dict(r) for r in rows]


def list_tracks_by_artist(
    viewer_id: str, artist: str, *, limit: int = 40,
) -> list[dict[str, Any]]:
    """Catalog tracks by an exact artist match, newest first — catalog-item
    shaped. Used to anchor daily mixes to an artist."""
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT {_TRACK_COLS}
          FROM tracks t
         WHERE t.artist = ?
         ORDER BY t.downloaded_at DESC
         LIMIT ?
        """,
        (viewer_id, artist, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def top_played_artists(viewer_id: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """Most-played artists for a user: [{artist, play_count}], busiest first."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT t.artist AS artist, COUNT(*) AS play_count
          FROM plays p
          JOIN tracks t
            ON p.video_id = t.video_id
           AND p.codec    = t.codec
           AND p.bitrate  = t.bitrate
         WHERE p.user_id = ?
           AND t.artist IS NOT NULL
           AND TRIM(t.artist) != ''
         GROUP BY t.artist
         ORDER BY play_count DESC
         LIMIT ?
        """,
        (viewer_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


# ── Playlists ────────────────────────────────────────────────────────────────

PLAYLIST_PUBLIC = "public"
PLAYLIST_PRIVATE = "private"
_VISIBILITIES = {PLAYLIST_PUBLIC, PLAYLIST_PRIVATE}


def create_playlist(
    *,
    playlist_id: str,
    owner_id: str,
    name: str,
    description: str | None = None,
    visibility: str = PLAYLIST_PRIVATE,
) -> None:
    if visibility not in _VISIBILITIES:
        visibility = PLAYLIST_PRIVATE
    now = _now()
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO playlists (
                id, owner_id, name, description, visibility,
                cover_url, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
            """,
            (playlist_id, owner_id, name, description, visibility, now, now),
        )


def get_playlist(playlist_id: str) -> dict[str, Any] | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM playlists WHERE id = ?",
        (playlist_id,),
    ).fetchone()
    return _row_to_dict(row)


def update_playlist(
    playlist_id: str,
    *,
    name: str | None = None,
    description: str | None = None,
    visibility: str | None = None,
    cover_url: str | None = None,
) -> bool:
    """Partial update. Returns True iff a row was modified."""
    updates: list[str] = []
    params: list[Any] = []
    if name is not None:
        updates.append("name = ?")
        params.append(name)
    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if visibility is not None:
        if visibility not in _VISIBILITIES:
            return False
        updates.append("visibility = ?")
        params.append(visibility)
    if cover_url is not None:
        updates.append("cover_url = ?")
        params.append(cover_url)
    if not updates:
        return False
    updates.append("updated_at = ?")
    params.append(_now())
    params.append(playlist_id)
    with _write() as conn:
        cur = conn.execute(
            f"UPDATE playlists SET {', '.join(updates)} WHERE id = ?",
            tuple(params),
        )
        return cur.rowcount > 0


def delete_playlist(playlist_id: str) -> bool:
    with _write() as conn:
        cur = conn.execute("DELETE FROM playlists WHERE id = ?", (playlist_id,))
        return cur.rowcount > 0


def list_playlists(
    viewer_id: str,
    *,
    owner_id: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """List playlists the viewer can see. By default returns all of theirs +
    every public playlist; when `owner_id` is set, scopes to that owner (still
    respecting visibility for non-owners).

    Each row is annotated with `track_count` and `is_owner`.
    """
    params: list[Any] = [viewer_id]
    where = ""
    if owner_id is not None:
        where = "WHERE p.owner_id = ? AND (p.owner_id = ? OR p.visibility = 'public')"
        params.extend([owner_id, viewer_id])
    else:
        where = "WHERE p.owner_id = ? OR p.visibility = 'public'"
        params.append(viewer_id)
    params.append(limit)

    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT p.id, p.owner_id, p.name, p.description, p.visibility,
               p.cover_url, p.created_at, p.updated_at,
               (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
               (p.owner_id = ?) AS is_owner
          FROM playlists p
          {where}
         ORDER BY p.updated_at DESC
         LIMIT ?
        """,
        tuple(params),
    ).fetchall()
    return [dict(r) for r in rows]


def list_playlist_tracks(playlist_id: str) -> list[dict[str, Any]]:
    """Ordered tracks for a playlist, joined with `tracks` for display fields."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT t.video_id, t.codec, t.bitrate, t.title, t.artist, t.duration_sec,
               t.thumbnail_url, t.source_url, t.file_size,
               pt.position, pt.added_at
          FROM playlist_tracks pt
          JOIN tracks t
            ON t.video_id = pt.video_id
           AND t.codec    = pt.codec
           AND t.bitrate  = pt.bitrate
         WHERE pt.playlist_id = ?
         ORDER BY pt.position ASC
        """,
        (playlist_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def add_track_to_playlist(
    playlist_id: str, video_id: str, codec: str, bitrate: str,
) -> bool:
    """Append a track to the end of the playlist. Returns False if the track
    is already in the playlist."""
    with _write() as conn:
        existing = conn.execute(
            """
            SELECT 1 FROM playlist_tracks
             WHERE playlist_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
            """,
            (playlist_id, video_id, codec, bitrate),
        ).fetchone()
        if existing:
            return False
        row = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()
        next_pos = int(row["next_pos"]) if row else 0
        conn.execute(
            """
            INSERT INTO playlist_tracks (
                playlist_id, video_id, codec, bitrate, position, added_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (playlist_id, video_id, codec, bitrate, next_pos, _now()),
        )
        conn.execute(
            "UPDATE playlists SET updated_at = ? WHERE id = ?",
            (_now(), playlist_id),
        )
        return True


def remove_track_from_playlist(
    playlist_id: str, video_id: str, codec: str, bitrate: str,
) -> bool:
    with _write() as conn:
        cur = conn.execute(
            """
            DELETE FROM playlist_tracks
             WHERE playlist_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
            """,
            (playlist_id, video_id, codec, bitrate),
        )
        if cur.rowcount > 0:
            conn.execute(
                "UPDATE playlists SET updated_at = ? WHERE id = ?",
                (_now(), playlist_id),
            )
            return True
        return False


def reorder_playlist(
    playlist_id: str,
    ordered_keys: list[tuple[str, str, str]],
) -> int:
    """Rewrite positions to match the given order. Keys not in the playlist are
    skipped silently; tracks not in `ordered_keys` keep their current relative
    order pushed to the tail. Returns the number of rows actually repositioned.

    Two-phase update so we don't trip the (playlist_id, position) uniqueness if
    we ever add it: first park everything in negative space, then assign final
    positions.
    """
    with _write() as conn:
        # Current tracks for this playlist.
        existing_rows = conn.execute(
            """
            SELECT video_id, codec, bitrate, position
              FROM playlist_tracks
             WHERE playlist_id = ?
             ORDER BY position ASC
            """,
            (playlist_id,),
        ).fetchall()
        existing = {(r["video_id"], r["codec"], r["bitrate"]): r["position"] for r in existing_rows}
        if not existing:
            return 0

        # Filter requested order to ones that exist.
        requested = [k for k in ordered_keys if k in existing]
        # Append leftovers in their original order so we don't lose them.
        seen = set(requested)
        tail = [
            (r["video_id"], r["codec"], r["bitrate"])
            for r in existing_rows
            if (r["video_id"], r["codec"], r["bitrate"]) not in seen
        ]
        final = requested + tail

        # Phase 1: shove everything into negative positions to avoid PK collisions.
        conn.execute(
            "UPDATE playlist_tracks SET position = -position - 1 WHERE playlist_id = ?",
            (playlist_id,),
        )
        # Phase 2: assign final positions.
        for new_pos, (vid, codec, bitrate) in enumerate(final):
            conn.execute(
                """
                UPDATE playlist_tracks SET position = ?
                 WHERE playlist_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
                """,
                (new_pos, playlist_id, vid, codec, bitrate),
            )
        conn.execute(
            "UPDATE playlists SET updated_at = ? WHERE id = ?",
            (_now(), playlist_id),
        )
        return len(final)
