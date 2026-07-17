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
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
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
    as_file         INTEGER NOT NULL DEFAULT 0,
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
    artist          TEXT,                -- all credited artists, joined ", "
    album           TEXT,                -- album title (YouTube Music metadata)
    album_artist    TEXT,                -- primary album artist, if distinct
    release_year    INTEGER,             -- release year, if known
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
-- The catalog's owner_count (COUNT) and is_owned (EXISTS) correlated subqueries
-- filter on (video_id, codec, bitrate) with no leading owner_id, so the PK and
-- the owner index above can't serve them. Without this, every catalog row scans
-- all of track_owners twice — and discover/suggestions/radio/daily-mixes each
-- read 400-500 rows. This index turns those scans into lookups.
CREATE INDEX IF NOT EXISTS idx_track_owners_track ON track_owners(video_id, codec, bitrate);
-- NOTE: the album column + its index (idx_tracks_album) are added in init()
-- AFTER the idempotent ALTERs — a legacy `tracks` table predates the column, so
-- indexing it here (before the ALTER) would fail with "no such column: album".

-- NOTE: the legacy `track_likes` table is gone — "liked" and "in library" were
-- merged (the heart toggle is the library toggle, `owner_count` is the social
-- signal). Existing DBs drop it via migration 3 in init().

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


# ── Migrations ─────────────────────────────────────────────────────────────────
# Versioned, ordered, applied once each via `schema_meta.version`. Every step is
# still written idempotently (PRAGMA checks / IF [NOT] EXISTS) so a DB in any
# prior state — including one that pre-dates schema_meta — migrates cleanly. To
# evolve the schema: append a new (version, fn) entry; never edit a shipped one.

def _migrate_jobs_owner_id(conn: sqlite3.Connection) -> None:
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "owner_id" not in cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN owner_id TEXT")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id)")


def _migrate_tracks_album(conn: sqlite3.Connection) -> None:
    # CREATE TABLE IF NOT EXISTS won't alter a legacy `tracks` table, so add the
    # album columns by hand. The index is created after, once `album` is sure to
    # exist (indexing it inside the base schema would fail on an un-migrated DB).
    track_cols = {row["name"] for row in conn.execute("PRAGMA table_info(tracks)")}
    for col, decl in (
        ("album", "TEXT"),
        ("album_artist", "TEXT"),
        ("release_year", "INTEGER"),
    ):
        if col not in track_cols:
            conn.execute(f"ALTER TABLE tracks ADD COLUMN {col} {decl}")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album)")


def _migrate_drop_track_likes(conn: sqlite3.Connection) -> None:
    # "Liked" and "in library" were merged; the table has been dead since.
    conn.execute("DROP INDEX IF EXISTS idx_track_likes_track")
    conn.execute("DROP INDEX IF EXISTS idx_track_likes_user")
    conn.execute("DROP TABLE IF EXISTS track_likes")


def _migrate_jobs_as_file(conn: sqlite3.Connection) -> None:
    # `as_file` records whether a job downloaded to device (file / zip) vs.
    # imported into the library. Persisted so retry can reproduce the original
    # flow instead of defaulting every audio/playlist retry to a library import.
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "as_file" not in cols:
        conn.execute("ALTER TABLE jobs ADD COLUMN as_file INTEGER NOT NULL DEFAULT 0")


# (version, migration_fn) in apply order. Bump past `current` runs only the new ones.
_MIGRATIONS: list[tuple[int, Any]] = [
    (1, _migrate_jobs_owner_id),
    (2, _migrate_tracks_album),
    (3, _migrate_drop_track_likes),
    (4, _migrate_jobs_as_file),
]


def _run_migrations(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)")
    row = conn.execute("SELECT version FROM schema_meta LIMIT 1").fetchone()
    if row is None:
        conn.execute("INSERT INTO schema_meta (version) VALUES (0)")
        current = 0
    else:
        current = int(row["version"])
    for version, fn in _MIGRATIONS:
        if version > current:
            fn(conn)
            conn.execute("UPDATE schema_meta SET version = ?", (version,))
            current = version


def init() -> None:
    """Create the base schema, run pending migrations, then mark any jobs left
    mid-flight (from a crash/restart) as interrupted."""
    with _write() as conn:
        conn.executescript(_SCHEMA)
        _run_migrations(conn)
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
    as_file: bool = False,
    resolution: str | None = None,
    ext: str | None = None,
    owner_id: str | None = None,
) -> None:
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO jobs (
                id, url, format_code, status, progress_pct,
                is_playlist, as_file, resolution, ext, owner_id, created_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                url,
                format_code,
                QUEUED,
                1 if is_playlist else 0,
                1 if as_file else 0,
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
    role: str | None = None,
    username: str | None = None,
) -> None:
    # Column names are fixed literals (never user input), so interpolating the
    # SET clause is safe; every value is still bound. role/username are updated
    # only when supplied, so a refresh re-syncs the identity HomeAuth returns.
    fields: list[str] = ["access_token = ?", "access_expires_at = ?", "last_seen_at = ?"]
    params: list[Any] = [access_token, access_expires_at, _now()]
    if refresh_cookie is not None:
        fields.append("refresh_cookie = ?")
        params.append(refresh_cookie)
    if role is not None:
        fields.append("role = ?")
        params.append(role)
    if username is not None:
        fields.append("username = ?")
        params.append(username)
    params.append(session_id)
    with _write() as conn:
        conn.execute(
            f"UPDATE sessions SET {', '.join(fields)} WHERE id = ?",
            params,
        )


def delete_session(session_id: str) -> None:
    with _write() as conn:
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


def delete_expired_sessions(max_age_days: int) -> int:
    """Delete session rows past their absolute lifetime (by created_at) and
    return how many were removed. Timestamps are UTC ISO-8601 at seconds
    precision, so a lexicographic `<` against the cutoff is monotonic in time.
    Keeps the sessions table (which holds live refresh credentials) from growing
    without bound and stops an expired cookie leaving a usable session behind."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat(timespec="seconds")
    with _write() as conn:
        cur = conn.execute("DELETE FROM sessions WHERE created_at < ?", (cutoff,))
        return cur.rowcount


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
    album: str | None = None,
    album_artist: str | None = None,
    release_year: int | None = None,
) -> None:
    """Idempotent: re-registering an existing track overwrites the row.

    `album`/`album_artist`/`release_year` use COALESCE on conflict so a later
    re-download that happens to carry less metadata (e.g. a flat playlist entry)
    never blanks out album info captured by an earlier richer extraction."""
    with _write() as conn:
        conn.execute(
            """
            INSERT INTO tracks (
                video_id, codec, bitrate, title, artist, album, album_artist,
                release_year, duration_sec, thumbnail_url, source_url, file_path,
                file_size, sha256, downloaded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(video_id, codec, bitrate) DO UPDATE SET
                title = excluded.title,
                artist = excluded.artist,
                album = COALESCE(excluded.album, tracks.album),
                album_artist = COALESCE(excluded.album_artist, tracks.album_artist),
                release_year = COALESCE(excluded.release_year, tracks.release_year),
                duration_sec = excluded.duration_sec,
                thumbnail_url = excluded.thumbnail_url,
                source_url = excluded.source_url,
                file_path = excluded.file_path,
                file_size = excluded.file_size,
                sha256 = excluded.sha256,
                downloaded_at = excluded.downloaded_at
            """,
            (
                video_id, codec, bitrate, title, artist, album, album_artist,
                release_year, duration_sec, thumbnail_url, source_url, file_path,
                file_size, sha256, _now(),
            ),
        )


def update_track_metadata(
    video_id: str,
    codec: str,
    bitrate: str,
    *,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    album_artist: str | None = None,
    release_year: int | None = None,
) -> bool:
    """Partial metadata update for one master track — only the provided (non-
    None) fields are written; the file/sha/owners are untouched. Used by the
    admin metadata-backfill (and any future metadata-correction). Returns True
    iff a row was updated."""
    updates: list[str] = []
    params: list[Any] = []
    for col, val in (
        ("title", title),
        ("artist", artist),
        ("album", album),
        ("album_artist", album_artist),
        ("release_year", release_year),
    ):
        if val is not None:
            updates.append(f"{col} = ?")
            params.append(val)
    if not updates:
        return False
    params.extend([video_id, codec, bitrate])
    with _write() as conn:
        cur = conn.execute(
            f"UPDATE tracks SET {', '.join(updates)} "
            "WHERE video_id = ? AND codec = ? AND bitrate = ?",
            params,
        )
        return cur.rowcount > 0


def list_tracks_for_backfill(only_missing_album: bool = False) -> list[dict[str, Any]]:
    """Tracks (key + file_path + current artist/album) for the metadata backfill.
    `only_missing_album` restricts to rows that never captured an album — i.e.
    the tracks downloaded before the album columns existed."""
    conn = _get_conn()
    where = "WHERE album IS NULL OR album = ''" if only_missing_album else ""
    rows = conn.execute(
        f"SELECT video_id, codec, bitrate, file_path, artist, album FROM tracks {where}"
    ).fetchall()
    return [dict(r) for r in rows]


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
        SELECT t.video_id, t.codec, t.bitrate, t.title, t.artist,
               t.album, t.album_artist, t.release_year, t.duration_sec,
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

    # owner_count (COUNT) and is_owned (per-viewer) used to be two correlated
    # subqueries evaluated per row — 600-1000 executions at the limits the
    # catalog/discover/radio/daily-mixes endpoints use. A single LEFT JOIN +
    # GROUP BY computes both in one pass (served by idx_track_owners_track).
    #
    # Param order must match the `?` order in the final SQL text: is_owned's
    # viewer in the SELECT, then the WHERE LIKE pair, then the owned_only HAVING
    # viewer, then LIMIT/OFFSET.
    conditions: list[str] = []
    where_params: list[Any] = []
    if query:
        conditions.append("(t.title LIKE ? OR t.artist LIKE ?)")
        wildcard = f"%{query}%"
        where_params.extend([wildcard, wildcard])
    where = (" WHERE " + " AND ".join(conditions)) if conditions else ""

    having = ""
    having_params: list[Any] = []
    if owned_only:
        # Keep only tracks the viewer owns — a post-aggregate filter reusing the
        # same is_owned expression instead of a second correlated subquery.
        having = " HAVING MAX(CASE WHEN o.owner_id = ? THEN 1 ELSE 0 END) = 1"
        having_params.append(viewer_id)

    params: list[Any] = [viewer_id, *where_params, *having_params, limit, offset]

    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT
            t.video_id, t.codec, t.bitrate, t.title, t.artist,
            t.album, t.album_artist, t.release_year, t.duration_sec,
            t.thumbnail_url, t.source_url, t.file_size, t.downloaded_at,
            COUNT(o.owner_id) AS owner_count,
            MAX(CASE WHEN o.owner_id = ? THEN 1 ELSE 0 END) AS is_owned
          FROM tracks t
          LEFT JOIN track_owners o
            ON o.video_id = t.video_id
           AND o.codec    = t.codec
           AND o.bitrate  = t.bitrate
          {where}
         GROUP BY t.video_id, t.codec, t.bitrate
         {having}
         ORDER BY {order_by}
         LIMIT ? OFFSET ?
        """,
        tuple(params),
    ).fetchall()
    return [dict(r) for r in rows]


def list_catalog_by_video_ids(
    viewer_id: str, video_ids: list[str]
) -> list[dict[str, Any]]:
    """Return catalog rows (same shape as `list_catalog`) for the given
    video_ids, annotated with `is_owned`/`owner_count` for `viewer_id`.

    Used by discover to detect search hits that are already in the catalog —
    even when their stored title/artist text doesn't match the query — so they
    surface as "add to library" (adopt, no re-download) rather than a fresh
    external download.
    """
    if not video_ids:
        return []
    placeholders = ",".join("?" for _ in video_ids)
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT {_TRACK_COLS}
          FROM tracks t
         WHERE t.video_id IN ({placeholders})
        """,
        (viewer_id, *video_ids),
    ).fetchall()
    return [dict(r) for r in rows]


def all_track_signatures() -> list[dict[str, Any]]:
    """Lightweight dedup index: one row per distinct video_id in the shared
    registry, with its title/artist.

    Discovery feeds (suggestions/discover) must exclude *every* track already on
    the server, not just a popular top-N — otherwise anything stored beyond that
    window resurfaces as a suggestion. This is the cheap full-coverage source for
    that filter: no owner join, no codec/bitrate fan-out (title/artist are stable
    across a video's encodings, so MAX collapses them to one row per video_id).
    """
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT video_id,
               MAX(title)  AS title,
               MAX(artist) AS artist
          FROM tracks
         GROUP BY video_id
        """
    ).fetchall()
    return [dict(r) for r in rows]


# ── Discovery read cache ────────────────────────────────────────────────────────
# Loading the home fires several discovery feeds at once (suggestions, daily-
# mixes, radio, albums), and each re-reads the same two heavy sources: the
# popular catalog top-N (a LEFT JOIN + GROUP BY over all of track_owners) and the
# full-table signature index. A short TTL collapses that burst — and back-to-back
# reloads within the window — to one query each. Staleness only delays a freshly
# added track showing up in *discovery* surfaces by up to the TTL; the catalog
# browse / "mine" view stay uncached and immediately fresh.
#
# Returned lists/rows are shared — callers MUST treat them as read-only.
_DISCOVERY_CACHE_TTL = 30.0

_popular_cache: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}
_popular_lock = threading.Lock()


def popular_catalog(viewer_id: str, limit: int) -> list[dict[str, Any]]:
    """`list_catalog(sort='popular')` with a short per-viewer TTL cache. Per
    viewer because `is_owned` differs; the heavy owner aggregation is the shared
    cost the cache eliminates."""
    key = (viewer_id, limit)
    now = time.monotonic()
    with _popular_lock:
        hit = _popular_cache.get(key)
        if hit and hit[0] > now:
            return hit[1]
    rows = list_catalog(viewer_id, sort="popular", limit=limit, offset=0)
    with _popular_lock:
        _popular_cache[key] = (now + _DISCOVERY_CACHE_TTL, rows)
        if len(_popular_cache) > 256:
            for k in [k for k, v in _popular_cache.items() if v[0] <= now]:
                _popular_cache.pop(k, None)
    return rows


_signatures_cache: tuple[float, list[dict[str, Any]]] | None = None
_signatures_lock = threading.Lock()


def all_track_signatures_cached() -> list[dict[str, Any]]:
    """`all_track_signatures()` (global, viewer-independent) with a short TTL —
    it's a full-table scan that every home load otherwise repeats."""
    global _signatures_cache
    now = time.monotonic()
    with _signatures_lock:
        if _signatures_cache and _signatures_cache[0] > now:
            return _signatures_cache[1]
    rows = all_track_signatures()
    with _signatures_lock:
        _signatures_cache = (now + _DISCOVERY_CACHE_TTL, rows)
    return rows


# ── Play history ───────────────────────────────────────────────────────────────

# Reused SELECT for catalog-item-shaped rows. The single `?` is the viewer for
# the is_owned flag and must be the first bound param wherever this is spliced in.
_TRACK_COLS = """
    t.video_id, t.codec, t.bitrate, t.title, t.artist,
    t.album, t.album_artist, t.release_year, t.duration_sec,
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
    """Catalog tracks featuring an artist, newest first — catalog-item shaped.
    Used to anchor daily mixes to an artist. `t.artist` is a ", "-joined credit
    string, so we match the anchor as a *member* of that list (wrapping both
    sides in the ", " delimiter) — that way "Lola Indigo" still matches a track
    stored as "Lola Indigo, La Zowi". A full joined anchor string matches too."""
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT {_TRACK_COLS}
          FROM tracks t
         WHERE (', ' || t.artist || ', ') LIKE ('%, ' || ? || ', %') COLLATE NOCASE
         ORDER BY t.downloaded_at DESC
         LIMIT ?
        """,
        (viewer_id, artist, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def top_played_artists(
    viewer_id: str, *, limit: int = 10, since: str | None = None,
) -> list[dict[str, Any]]:
    """Most-played artists for a user: [{artist, play_count}], busiest first.
    `since` is an ISO timestamp lower bound on played_at (None = all time).

    `t.artist` is a ", "-joined credit string (a collab stores all names in one
    row), so grouping by it raw would surface whole credit lists as a single
    "artist". We group per-string in SQL, then split on commas and tally each
    individual artist case-insensitively (keeping the first-seen casing), so a
    feat counts toward every artist on it."""
    conn = _get_conn()
    where = "WHERE p.user_id = ? AND t.artist IS NOT NULL AND TRIM(t.artist) != ''"
    params: list[Any] = [viewer_id]
    if since:
        where += " AND p.played_at >= ?"
        params.append(since)
    rows = conn.execute(
        f"""
        SELECT t.artist AS artist, COUNT(*) AS play_count
          FROM plays p
          JOIN tracks t
            ON p.video_id = t.video_id
           AND p.codec    = t.codec
           AND p.bitrate  = t.bitrate
         {where}
         GROUP BY t.artist
        """,
        tuple(params),
    ).fetchall()
    counts: dict[str, int] = {}
    display: dict[str, str] = {}
    for r in rows:
        n = int(r["play_count"])
        for raw in (r["artist"] or "").split(","):
            name = raw.strip()
            if not name:
                continue
            key = name.lower()
            counts[key] = counts.get(key, 0) + n
            display.setdefault(key, name)
    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    return [
        {"artist": display[key], "play_count": cnt} for key, cnt in ranked[:limit]
    ]


def count_plays(viewer_id: str, *, since: str | None = None) -> int:
    """Total recorded plays for a user (optionally since an ISO timestamp)."""
    conn = _get_conn()
    if since:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM plays WHERE user_id = ? AND played_at >= ?",
            (viewer_id, since),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM plays WHERE user_id = ?", (viewer_id,),
        ).fetchone()
    return int(row["n"]) if row else 0


def list_recent_additions(*, limit: int = 30) -> list[dict[str, Any]]:
    """Recent library adds across all users — the activity feed. Each row is a
    catalog track plus who added it (display name resolved from their most
    recent session) and when."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT o.owner_id, o.added_at,
               (SELECT s.username FROM sessions s
                 WHERE s.user_id = o.owner_id
                 ORDER BY s.last_seen_at DESC LIMIT 1) AS username,
               t.video_id, t.codec, t.bitrate, t.title, t.artist,
               t.album, t.album_artist, t.release_year, t.duration_sec,
               t.thumbnail_url, t.source_url, t.file_size, t.downloaded_at
          FROM track_owners o
          JOIN tracks t
            ON o.video_id = t.video_id
           AND o.codec    = t.codec
           AND o.bitrate  = t.bitrate
         ORDER BY o.added_at DESC
         LIMIT ?
        """,
        (limit,),
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
        SELECT t.video_id, t.codec, t.bitrate, t.title, t.artist,
               t.album, t.album_artist, t.release_year, t.duration_sec,
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


def add_tracks_to_playlist(
    playlist_id: str, keys: list[tuple[str, str, str]],
) -> int:
    """Append many tracks in one transaction (vs. N round-trips). Skips tracks
    already in the playlist or absent from the catalog. Returns how many were
    actually added."""
    if not keys:
        return 0
    with _write() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM playlist_tracks WHERE playlist_id = ?",
            (playlist_id,),
        ).fetchone()
        pos = int(row["next_pos"]) if row else 0
        added = 0
        for video_id, codec, bitrate in keys:
            in_catalog = conn.execute(
                "SELECT 1 FROM tracks WHERE video_id = ? AND codec = ? AND bitrate = ?",
                (video_id, codec, bitrate),
            ).fetchone()
            if in_catalog is None:
                continue
            existing = conn.execute(
                """
                SELECT 1 FROM playlist_tracks
                 WHERE playlist_id = ? AND video_id = ? AND codec = ? AND bitrate = ?
                """,
                (playlist_id, video_id, codec, bitrate),
            ).fetchone()
            if existing:
                continue
            conn.execute(
                """
                INSERT INTO playlist_tracks (
                    playlist_id, video_id, codec, bitrate, position, added_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (playlist_id, video_id, codec, bitrate, pos, _now()),
            )
            pos += 1
            added += 1
        if added:
            conn.execute(
                "UPDATE playlists SET updated_at = ? WHERE id = ?",
                (_now(), playlist_id),
            )
        return added


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


# ── Admin ──────────────────────────────────────────────────────────────────────
# Platform-wide aggregates and management worklists. Reads only — destructive
# actions reuse the existing `count_owners` / `delete_track_master`. The HTTP
# route layer adds filesystem-derived fields (file_exists, on-disk byte sums)
# and the yt-dlp version; nothing here touches the disk.

_ADMIN_TRACK_SORTS = {
    'largest':  't.file_size DESC',
    'smallest': 't.file_size ASC',
    'newest':   't.downloaded_at DESC',
    'oldest':   't.downloaded_at ASC',
    'popular':  'owner_count DESC, t.downloaded_at DESC',
}


def admin_overview() -> dict[str, Any]:
    """Single-pass aggregate of platform totals for the admin Overview cards.

    Distinct users come from `sessions` (one identity may hold several sessions).
    `active_jobs` counts jobs in any in-flight status. The yt-dlp version is
    appended by the route, not here."""
    conn = _get_conn()
    active_q = ",".join("?" * len(ACTIVE_STATUSES))
    users = conn.execute(
        "SELECT COUNT(DISTINCT user_id) AS n FROM sessions"
    ).fetchone()
    tracks = conn.execute(
        "SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS storage FROM tracks"
    ).fetchone()
    plays = conn.execute("SELECT COUNT(*) AS n FROM plays").fetchone()
    active_jobs = conn.execute(
        f"SELECT COUNT(*) AS n FROM jobs WHERE status IN ({active_q})",
        ACTIVE_STATUSES,
    ).fetchone()
    playlists = conn.execute("SELECT COUNT(*) AS n FROM playlists").fetchone()
    schema = conn.execute(
        "SELECT version FROM schema_meta LIMIT 1"
    ).fetchone()
    return {
        "users": int(users["n"]),
        "tracks": int(tracks["n"]),
        "storage_bytes": int(tracks["storage"]),
        "plays": int(plays["n"]),
        "active_jobs": int(active_jobs["n"]),
        "playlists": int(playlists["n"]),
        "schema_version": int(schema["version"]) if schema else 0,
    }


def admin_list_users() -> list[dict[str, Any]]:
    """Per-user roster: one row per distinct `sessions.user_id`. Username/role
    reflect the most recent session (by last_seen_at); `last_seen_at` is the max
    across sessions. Library/play counts are LEFT-JOINed from `track_owners`
    (owner_id) and `plays` (user_id), so a user with neither still appears."""
    conn = _get_conn()
    rows = conn.execute(
        """
        SELECT
            s.user_id AS user_id,
            (SELECT s2.username FROM sessions s2
              WHERE s2.user_id = s.user_id
              ORDER BY s2.last_seen_at DESC LIMIT 1) AS username,
            (SELECT s3.role FROM sessions s3
              WHERE s3.user_id = s.user_id
              ORDER BY s3.last_seen_at DESC LIMIT 1) AS role,
            MAX(s.last_seen_at) AS last_seen_at,
            (SELECT COUNT(*) FROM track_owners o
              WHERE o.owner_id = s.user_id) AS library_count,
            (SELECT COUNT(*) FROM plays p
              WHERE p.user_id = s.user_id) AS play_count
          FROM sessions s
         GROUP BY s.user_id
         ORDER BY last_seen_at DESC
        """
    ).fetchall()
    return [dict(r) for r in rows]


def admin_list_tracks(
    *,
    sort: str = 'largest',
    limit: int = 200,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Catalog tracks for the storage-management table. Each row carries
    `owner_count` (users who have it in their library) and `playlist_count`
    (playlists that reference it) so the admin sees what a delete would affect.
    `sort` is one of `_ADMIN_TRACK_SORTS` (unknown → 'largest'). The route adds
    `file_exists` per row — no fs access here."""
    order_by = _ADMIN_TRACK_SORTS.get(sort, _ADMIN_TRACK_SORTS['largest'])
    conn = _get_conn()
    rows = conn.execute(
        f"""
        SELECT
            t.video_id, t.codec, t.bitrate, t.title, t.artist, t.album,
            t.duration_sec, t.file_path, t.file_size, t.downloaded_at,
            (SELECT COUNT(*) FROM track_owners o
              WHERE o.video_id = t.video_id
                AND o.codec    = t.codec
                AND o.bitrate  = t.bitrate) AS owner_count,
            (SELECT COUNT(*) FROM playlist_tracks pt
              WHERE pt.video_id = t.video_id
                AND pt.codec    = t.codec
                AND pt.bitrate  = t.bitrate) AS playlist_count
          FROM tracks t
         ORDER BY {order_by}
         LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()
    return [dict(r) for r in rows]


def count_playlist_refs(video_id: str, codec: str, bitrate: str) -> int:
    """How many playlists reference this track. Deleting the master cascades
    playlist_tracks, so a delete must account for these (not just owners)."""
    conn = _get_conn()
    row = conn.execute(
        """
        SELECT COUNT(*) AS n FROM playlist_tracks
         WHERE video_id = ? AND codec = ? AND bitrate = ?
        """,
        (video_id, codec, bitrate),
    ).fetchone()
    return int(row["n"]) if row else 0
