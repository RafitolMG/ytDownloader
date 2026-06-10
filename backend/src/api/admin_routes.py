"""
Admin panel backend API. Every route here is gated by `require_admin`
(401 unauth → 403 non-admin → pass admin) and returns the exact JSON shapes
the admin SPA expects.

Filesystem work (file_exists checks, on-disk byte sums, os.remove) lives HERE,
not in db.py — the db layer only knows rows. The extraction-health probe is
reused from the public routes module via a lazy import to avoid an import-time
cycle (routes imports this module's router).
"""
from __future__ import annotations

import os
import re
import shutil

import yt_dlp

from fastapi import APIRouter, Depends, HTTPException

from src import config, db, ytDownloaderFunctions
from src.auth import CurrentUser, require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Mirrors routes.py:1759 — a YouTube video id is 11 url-safe base64 chars.
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


@router.get("/overview")
def overview(user: CurrentUser = Depends(require_admin)) -> dict:
    """Platform totals for the Overview stat cards."""
    data = db.admin_overview()
    data["yt_dlp_version"] = yt_dlp.version.__version__
    return data


@router.get("/users")
def users(user: CurrentUser = Depends(require_admin)) -> dict:
    """Per-user roster table."""
    return {"users": db.admin_list_users()}


@router.get("/jobs")
def jobs(
    status: str | None = None,
    limit: int = 200,
    user: CurrentUser = Depends(require_admin),
) -> dict:
    """All jobs across every owner (admin queue view). Reuses the existing
    list_jobs (owner_id=None → every owner), then filters by status in Python
    when the query param is supplied."""
    rows = db.list_jobs(owner_id=None, limit=limit)
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return {"jobs": rows}


@router.get("/tracks")
def tracks(
    sort: str = "largest",
    limit: int = 200,
    offset: int = 0,
    user: CurrentUser = Depends(require_admin),
) -> dict:
    """Storage management table. Adds file_exists per row (filesystem check
    lives here, not in db)."""
    rows = db.admin_list_tracks(sort=sort, limit=limit, offset=offset)
    for row in rows:
        row["file_exists"] = os.path.isfile(row["file_path"])
    return {"tracks": rows}


@router.delete("/tracks/{video_id}/{codec}/{bitrate}")
def delete_track(
    video_id: str,
    codec: str,
    bitrate: str,
    force: bool = False,
    user: CurrentUser = Depends(require_admin),
) -> dict:
    """Hard-delete one master track row + its file on disk.

    Refuses (409) while the track is still in use — owned by a user OR present in
    any playlist — unless force=true. The playlist check matters because
    playlist_tracks cascades on delete, so deleting a not-favourited-but-
    playlisted track would silently strip it from those playlists. The file_path
    comes from the trusted DB; os.remove is wrapped so a missing file (already
    gone) doesn't error the request."""
    if not VIDEO_ID_RE.match(video_id):
        raise HTTPException(status_code=422, detail="invalid video id")

    owner_count = db.count_owners(video_id, codec, bitrate)
    playlist_count = db.count_playlist_refs(video_id, codec, bitrate)
    if (owner_count > 0 or playlist_count > 0) and not force:
        reasons = []
        if owner_count > 0:
            reasons.append(f"owned by {owner_count} user(s)")
        if playlist_count > 0:
            reasons.append(f"in {playlist_count} playlist(s)")
        raise HTTPException(
            status_code=409,
            detail=f"track still in use ({', '.join(reasons)}); pass force=true to delete anyway",
        )

    # Capture the file size before deleting the row so we can report bytes freed.
    existing = db.get_track(video_id, codec, bitrate)
    file_size = (existing or {}).get("file_size") or 0

    path = db.delete_track_master(video_id, codec, bitrate)
    if path is None:
        raise HTTPException(status_code=404, detail="track not found")

    # The master row is already gone; never let a stubborn file on disk turn
    # that into a 500 (which would orphan the file with no row to reclaim it).
    bytes_reclaimed = 0
    try:
        os.remove(path)
        bytes_reclaimed = file_size
    except FileNotFoundError:
        bytes_reclaimed = 0
    except OSError:
        # PermissionError / IsADirectoryError / network-mount errors: the row
        # is deleted, so swallow and report 0 reclaimed rather than erroring.
        bytes_reclaimed = 0

    return {
        "ok": True,
        "deleted": True,
        "bytes_reclaimed": bytes_reclaimed,
        "owner_count": owner_count,
        "playlist_count": playlist_count,
    }


@router.post("/tracks/backfill-metadata")
def backfill_metadata(
    only_missing: bool = True,
    overwrite_artist: bool = True,
    user: CurrentUser = Depends(require_admin),
) -> dict:
    """Recover album / multi-artist / year for existing tracks by reading the
    metadata yt-dlp already embedded in each file (ffprobe, fully offline — no
    YouTube call). `only_missing` scans just tracks with no album (the ones
    downloaded before the album columns existed); `overwrite_artist` upgrades a
    single-name artist to the file's joined multi-artist string. Idempotent and
    re-runnable."""
    scanned = updated = no_file = no_new = 0
    for t in db.list_tracks_for_backfill(only_missing_album=only_missing):
        scanned += 1
        tags = ytDownloaderFunctions.read_file_tags(t["file_path"])
        if tags is None:
            no_file += 1
            continue
        fields: dict = {
            "album": tags["album"],
            "album_artist": tags["album_artist"],
            "release_year": tags["release_year"],
        }
        if tags["title"]:
            fields["title"] = tags["title"]
        # Artist: fill when missing, or upgrade to the file's (joined, multi-
        # artist) value when overwrite is on — the embedded tag is yt-dlp's.
        cur_artist = (t.get("artist") or "").strip()
        if tags["artist"] and (overwrite_artist or not cur_artist):
            fields["artist"] = tags["artist"]
        fields = {k: v for k, v in fields.items() if v is not None}
        if not fields:
            no_new += 1
            continue
        if db.update_track_metadata(t["video_id"], t["codec"], t["bitrate"], **fields):
            updated += 1
    return {
        "scanned": scanned,
        "updated": updated,
        "no_file": no_file,
        "no_new_tags": no_new,
    }


@router.post("/tracks/normalize-artists")
def normalize_artists(
    user: CurrentUser = Depends(require_admin),
) -> dict:
    """Re-normalize the stored `artist` string of every track: case-insensitive
    de-dupe + cap to the first few names (see ytDownloaderFunctions.
    normalize_artist_names). Cleans up the over-stuffed credit lists the backfill
    wrote (YT Music dumps writers/producers alongside performers). Offline,
    idempotent, re-runnable; only rows whose artist actually changes are touched."""
    scanned = updated = 0
    samples: list[dict] = []
    for t in db.list_tracks_for_backfill(only_missing_album=False):
        scanned += 1
        cur = (t.get("artist") or "").strip()
        if not cur:
            continue
        names = ytDownloaderFunctions.normalize_artist_names(cur)
        cleaned = ", ".join(names)
        if cleaned and cleaned != cur:
            if db.update_track_metadata(
                t["video_id"], t["codec"], t["bitrate"], artist=cleaned
            ):
                updated += 1
                if len(samples) < 10:
                    samples.append({"before": cur, "after": cleaned})
    return {"scanned": scanned, "updated": updated, "samples": samples}


@router.get("/system")
def system(user: CurrentUser = Depends(require_admin)) -> dict:
    """System health panel: yt-dlp version, cookies config status, cached
    extraction probe, DB path+size, LIBRARY_DIR disk usage."""
    # Cookies status.
    resolved = ytDownloaderFunctions._resolve_cookies_file()
    if config.YT_COOKIES_DATA and ytDownloaderFunctions._COOKIES_DATA_PATH:
        source = "data"
    elif config.YT_COOKIES_FILE and resolved:
        source = "file"
    elif resolved:
        source = "repo"
    else:
        source = "none"
    cookies = {
        "configured": resolved is not None,
        "source": source,
        "error": ytDownloaderFunctions._COOKIES_DATA_ERROR,
        # Expiry summary so admins get an advance warning before cookies lapse
        # (the worst silent prod failure). None when no cookies file is set.
        "expiry": ytDownloaderFunctions.get_cookies_expiry(),
    }

    # Extraction probe — lazy import to avoid an import-time cycle (routes
    # imports admin_router from this module).
    from src.api import routes as _routes
    probe = _routes._run_extraction_probe()
    extraction = {
        "ok": probe["ok"],
        "error": probe["error"],
        "checked_at": probe["checked_at"],
    }

    # DB file.
    db_path = db._DB_PATH
    db_size = os.path.getsize(db_path) if os.path.isfile(db_path) else 0

    # Library disk usage. Ensure the dir exists so disk_usage doesn't raise on
    # a fresh deploy.
    os.makedirs(config.LIBRARY_DIR, exist_ok=True)
    usage = shutil.disk_usage(config.LIBRARY_DIR)

    return {
        "yt_dlp_version": yt_dlp.version.__version__,
        "cookies": cookies,
        "extraction": extraction,
        "db": {"path": db_path, "size_bytes": db_size},
        "library": {
            "path": config.LIBRARY_DIR,
            "used_bytes": usage.used,
            "total_bytes": usage.total,
            "free_bytes": usage.free,
        },
    }
