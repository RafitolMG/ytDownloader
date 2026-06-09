import asyncio
import hashlib
import os
import queue
import random
import shutil
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime, timedelta, timezone

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src import (
    catalog_categories as categories_mod,
    config,
    db,
    search as search_mod,
    ytDownloaderFunctions,
)
from src.api.auth_routes import router as auth_router
from src.auth import CurrentUser, current_user


def _ensure_owner(job: dict, user: CurrentUser) -> None:
    """403 unless the caller owns the job (ADMIN bypasses)."""
    if user.is_admin:
        return
    if job.get("owner_id") != user.user_id:
        raise HTTPException(status_code=403, detail="not your job")

app = FastAPI(title="YT Downloader")

if config.FRONTEND_ORIGIN:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[config.FRONTEND_ORIGIN],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(auth_router)

# SPA assets (compiled by Vite). In dev the SPA runs on its own port and this
# mount stays empty; in the Docker image the multi-stage build drops dist/ at
# YTDL_FRONTEND_DIST. The catch-all at the bottom serves index.html.
_FRONTEND_DIST = os.environ.get("YTDL_FRONTEND_DIST", "")


class _ImmutableStatic(StaticFiles):
    # Vite asset filenames embed a content hash (e.g. main-abc123.js), so they
    # can be cached forever — the filename changes whenever the contents do.
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


if _FRONTEND_DIST and os.path.isdir(os.path.join(_FRONTEND_DIST, "assets")):
    app.mount(
        "/assets",
        _ImmutableStatic(directory=os.path.join(_FRONTEND_DIST, "assets")),
        name="spa-assets",
    )


@app.on_event("startup")
def _init_db():
    import logging
    log = logging.getLogger("uvicorn.error")
    db.init()
    if config.DEV_AUTH_BYPASS:
        banner = "█" * 60
        log.warning("\n%s\n  DEV_AUTH_BYPASS=1 — every request is treated as ADMIN.\n  DO NOT run this build in production.\n%s", banner, banner)
    # Cookies: YouTube blocks datacenter IPs without an authenticated session.
    # Surface the resolution outcome at startup so prod misconfig is loud.
    resolved = ytDownloaderFunctions._resolve_cookies_file()
    if resolved:
        if config.YT_COOKIES_DATA and ytDownloaderFunctions._COOKIES_DATA_PATH:
            log.info(
                "yt-dlp cookies: loaded from YT_COOKIES_DATA env var (base64, %d bytes encoded)",
                len(config.YT_COOKIES_DATA),
            )
        else:
            log.info("yt-dlp cookies: loaded from %s", resolved)
    elif config.YT_COOKIES_DATA and ytDownloaderFunctions._COOKIES_DATA_ERROR:
        log.warning(
            "yt-dlp cookies: YT_COOKIES_DATA could not be decoded (%s). "
            "It must be base64-encoded — `base64 -w0 cookies.txt` and paste the output.",
            ytDownloaderFunctions._COOKIES_DATA_ERROR,
        )
    elif config.YT_COOKIES_FILE:
        log.warning(
            "yt-dlp cookies: YT_COOKIES_FILE=%s is set but the file does not exist — "
            "YouTube will likely block extraction.",
            config.YT_COOKIES_FILE,
        )
    else:
        log.warning(
            "yt-dlp cookies: none configured. Fine on a residential IP; on a VPS "
            "YouTube will block extraction with 'Sign in to confirm you're not a bot'."
        )


# ── In-memory job runtime (file paths, queues, cancel flags) ──────────────────

# job_id -> {"queue": Queue, "file_path": str | None, "tmp_dir": str}
_jobs: dict[str, dict] = {}
_cancelled: set[str] = set()


class _Cancelled(Exception):
    """Raised from inside the yt-dlp progress hook to abort a job."""


# ── Request models ────────────────────────────────────────────────────────────

class ResolutionsRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    format_code: str
    resolution: str | None = None
    ext: str | None = None
    # When true and `format_code` is an audio preset, write the result to a
    # tmp_dir and serve it via /api/file like a video instead of importing
    # into the user's library.
    as_file: bool = False


class PlaylistDownloadRequest(BaseModel):
    url: str
    # `quality` only applies when `as_file=True` (zip-to-device flow). In-app
    # imports are always mp3-320 regardless of what the client sends — see
    # the route body.
    quality: str = 'mp3-320'
    as_file: bool = False


# ── Routes ────────────────────────────────────────────────────────────────────

@app.post("/api/resolutions")
def get_resolutions(body: ResolutionsRequest):
    """Fetch available MP4 formats for a single video, or detect a playlist URL."""
    try:
        if ytDownloaderFunctions.is_playlist(body.url):
            info = ytDownloaderFunctions.get_playlist_tracks(body.url)
            return {"is_playlist": True, **info}
        return ytDownloaderFunctions.get_available_resolutions(body.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


def _throttled_progress(job_id: str, progress_queue: queue.Queue):
    """
    Build an on_progress callback that:
      - cancels via _Cancelled if the job is in _cancelled
      - emits every WS update (lightweight)
      - throttles DB writes to ~every 1s or 1% delta
    """
    state = {"last_db_pct": -1.0, "last_db_t": 0.0}

    def on_progress(percent: float):
        if job_id in _cancelled:
            raise _Cancelled()
        rounded = round(percent, 1)
        progress_queue.put({"type": "progress", "value": rounded})
        now = time.monotonic()
        if abs(percent - state["last_db_pct"]) >= 1.0 or now - state["last_db_t"] >= 1.0:
            db.update_progress(job_id, rounded)
            state["last_db_pct"] = percent
            state["last_db_t"] = now

    return on_progress


@app.post("/api/download")
def start_download(body: DownloadRequest, user: CurrentUser = Depends(current_user)):
    """
    Start a download in a background thread.

    Three flows depending on `format_code` + `as_file`:
      - Audio preset (mp3-192, mp3-320, m4a, flac) with `as_file=False`:
        imports the track into the user's music library (shared content-
        addressed storage with dedup). Emits `done {filename: null}` so the
        frontend doesn't try to download a file.
      - Audio preset with `as_file=True`: writes the extracted audio to
        tmp_dir and serves it via /api/file like a video — no library row.
      - Anything else: standard single-video download → tmp_dir → file served
        via /api/file/{job_id}.
    """
    is_audio_preset = ytDownloaderFunctions.is_audio_quality(body.format_code)
    is_audio_import = is_audio_preset and not body.as_file
    is_audio_file = is_audio_preset and body.as_file

    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    # For library imports we don't need a tmp_dir at the job level — the
    # per-track downloader manages its own scratch space under LIBRARY_DIR.
    tmp_dir = None if is_audio_import else tempfile.mkdtemp(prefix="ytdl_")
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

    db.create_job(
        job_id=job_id,
        url=body.url,
        format_code=body.format_code,
        resolution=body.resolution,
        ext=body.ext,
        owner_id=user.user_id,
    )

    def run_audio_import():
        try:
            codec, bitrate, ext = ytDownloaderFunctions.parse_audio_quality(body.format_code)
            info = ytDownloaderFunctions.get_single_video_info(body.url)
            video_id = info['id']

            db.set_metadata(
                job_id,
                title=info.get('title'),
                uploader=info.get('uploader'),
                thumbnail_url=info.get('thumbnail'),
                duration_sec=info.get('duration_sec'),
            )
            progress_queue.put({
                "type": "metadata",
                "title": info.get('title'),
                "uploader": info.get('uploader'),
                "thumbnail_url": info.get('thumbnail'),
                "duration_sec": info.get('duration_sec'),
            })

            db.mark_started(job_id)

            existing = db.get_track(video_id, codec, bitrate)
            if existing and os.path.isfile(existing['file_path']):
                # Already in the shared library — just link this user.
                db.link_owner(
                    owner_id=user.user_id,
                    video_id=video_id,
                    codec=codec,
                    bitrate=bitrate,
                )
                progress_queue.put({"type": "progress", "value": 100.0})
                db.finish(job_id, size_bytes=existing.get('file_size'))
                progress_queue.put({
                    "type": "done",
                    "filename": None,
                    "imported": 0,
                    "reused": 1,
                })
                return

            dest_path = _library_path(video_id, codec, bitrate, ext)

            def on_progress(pct: float):
                if job_id in _cancelled:
                    raise _Cancelled()
                progress_queue.put({"type": "progress", "value": round(pct, 1)})

            ytDownloaderFunctions.download_track_audio(
                info['webpage_url'], codec, bitrate, dest_path,
                on_progress=on_progress,
            )

            file_size = os.path.getsize(dest_path)
            sha256 = _sha256_file(dest_path)
            db.register_track(
                video_id=video_id,
                codec=codec,
                bitrate=bitrate,
                title=info.get('title'),
                artist=info.get('uploader'),
                duration_sec=info.get('duration_sec'),
                thumbnail_url=info.get('thumbnail'),
                source_url=info['webpage_url'],
                file_path=dest_path,
                file_size=file_size,
                sha256=sha256,
            )
            db.link_owner(
                owner_id=user.user_id,
                video_id=video_id,
                codec=codec,
                bitrate=bitrate,
            )
            db.finish(job_id, size_bytes=file_size)
            progress_queue.put({
                "type": "done",
                "filename": None,
                "imported": 1,
                "reused": 0,
            })

        except _Cancelled:
            _jobs.pop(job_id, None)
            _cancelled.discard(job_id)
            db.cancel(job_id)
            progress_queue.put({"type": "cancelled"})

        except Exception as e:
            traceback.print_exc()
            _jobs.pop(job_id, None)
            db.fail(job_id, str(e))
            progress_queue.put({"type": "error", "message": str(e)})

    def run():
        try:
            try:
                info = ytDownloaderFunctions.get_basic_info(body.url)
                db.set_metadata(job_id, **info)
                progress_queue.put({"type": "metadata", **info})
            except Exception:
                traceback.print_exc()

            db.mark_started(job_id)
            on_progress = _throttled_progress(job_id, progress_queue)

            video_filename, _, audio_codec, total_frames = ytDownloaderFunctions.download_video(
                body.url, body.format_code, tmp_dir, on_progress
            )

            final_path = video_filename

            if audio_codec == 'none':
                db.update_progress(job_id, 0, status=db.MERGING)
                progress_queue.put({"type": "status", "value": db.MERGING})

                audio_filename, _ = ytDownloaderFunctions.download_audio(
                    body.url, tmp_dir, on_progress
                )
                base = os.path.splitext(os.path.basename(video_filename))[0]
                merged_tmp = os.path.join(tmp_dir, f"{base}_out.mp4")
                ytDownloaderFunctions.merge_audio_video(
                    video_filename, audio_filename, merged_tmp, total_frames, on_progress
                )
                for f in (video_filename, audio_filename):
                    try:
                        os.remove(f)
                    except OSError:
                        pass
                final_path = os.path.join(tmp_dir, f"{base}.mp4")
                os.rename(merged_tmp, final_path)

            # If the video stream is AV1 (or anything non-H.264), transcode it.
            # YouTube only serves AV1 above 1080p, so this hits 1440p/2160p.
            codec = ytDownloaderFunctions.get_video_codec(final_path)
            if codec and codec.lower() != 'h264':
                db.update_progress(job_id, 0, status=db.TRANSCODING)
                progress_queue.put({"type": "status", "value": db.TRANSCODING})
                base = os.path.splitext(os.path.basename(final_path))[0]
                transcoded = os.path.join(tmp_dir, f"{base}_h264.mp4")
                ytDownloaderFunctions.transcode_video_to_h264(
                    final_path, transcoded, total_frames, on_progress
                )
                os.remove(final_path)
                os.rename(transcoded, final_path)

            _jobs[job_id]["file_path"] = final_path
            size = os.path.getsize(final_path)
            db.finish(job_id, size_bytes=size)
            progress_queue.put({"type": "done", "filename": os.path.basename(final_path)})

        except _Cancelled:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            _cancelled.discard(job_id)
            db.cancel(job_id)
            progress_queue.put({"type": "cancelled"})

        except Exception as e:
            traceback.print_exc()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            db.fail(job_id, str(e))
            progress_queue.put({"type": "error", "message": str(e)})

    def run_audio_file():
        try:
            try:
                info = ytDownloaderFunctions.get_basic_info(body.url)
                db.set_metadata(job_id, **info)
                progress_queue.put({"type": "metadata", **info})
            except Exception:
                traceback.print_exc()

            db.mark_started(job_id)
            on_progress = _throttled_progress(job_id, progress_queue)

            codec, bitrate, _ext = ytDownloaderFunctions.parse_audio_quality(body.format_code)
            final_path = ytDownloaderFunctions.download_audio_file(
                body.url, codec, bitrate, tmp_dir, on_progress,
            )

            _jobs[job_id]["file_path"] = final_path
            size = os.path.getsize(final_path)
            db.finish(job_id, size_bytes=size)
            progress_queue.put({"type": "done", "filename": os.path.basename(final_path)})

        except _Cancelled:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            _cancelled.discard(job_id)
            db.cancel(job_id)
            progress_queue.put({"type": "cancelled"})

        except Exception as e:
            traceback.print_exc()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            db.fail(job_id, str(e))
            progress_queue.put({"type": "error", "message": str(e)})

    if is_audio_import:
        target = run_audio_import
    elif is_audio_file:
        target = run_audio_file
    else:
        target = run
    threading.Thread(target=target, daemon=True).start()
    return {"job_id": job_id}


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _library_path(video_id: str, codec: str, bitrate: str, ext: str) -> str:
    return os.path.join(config.LIBRARY_DIR, video_id, f"{codec}_{bitrate}.{ext}")


@app.post("/api/download-playlist")
def start_playlist_download(body: PlaylistDownloadRequest, user: CurrentUser = Depends(current_user)):
    """
    Two flows depending on `as_file`:

      - `as_file=False` (default — in-app import): every track is stored in
        the shared content-addressed library and linked to the user. Quality
        is forced to mp3-320 here — the client doesn't get to pick. The
        catalog only carries one canonical bitrate.
      - `as_file=True` (download to device): each track is extracted to a
        per-job tmp_dir, zipped into one archive, and served via /api/file
        like a single-video download. The library is NOT touched.

    Dedup rules (in-app flow only):
      - If the (video_id, codec, bitrate) tuple exists in `tracks` AND the
        file is present on disk → skip the download and just link this user
        as an owner.
      - If the row exists but the file is gone → re-download.
      - Otherwise → download, hash, register, link.

    Returns a job_id to track progress via WebSocket.
    """
    # The in-app catalog standardises on mp3-320; ignore whatever the client
    # sent. Only the zip-to-device flow honours `body.quality`.
    effective_quality = body.quality if body.as_file else 'mp3-320'
    try:
        codec, bitrate, ext = ytDownloaderFunctions.parse_audio_quality(effective_quality)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    # Zip flow stages everything in a tmp_dir; in-app flow writes straight
    # to LIBRARY_DIR via the per-track downloader and needs no scratch space.
    tmp_dir = tempfile.mkdtemp(prefix="ytdl_pl_") if body.as_file else None
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

    db.create_job(
        job_id=job_id,
        url=body.url,
        format_code=effective_quality,
        is_playlist=True,
        owner_id=user.user_id,
    )

    def run():
        try:
            try:
                info = ytDownloaderFunctions.get_playlist_tracks(body.url)
                db.set_metadata(
                    job_id,
                    playlist_title=info.get('title'),
                    playlist_count=info.get('count'),
                    thumbnail_url=info.get('thumbnail_url'),
                )
                # Strip `tracks` from the WS payload — it can be hundreds of
                # entries and the client already fetched them at analyze time.
                meta_event = {k: v for k, v in info.items() if k != 'tracks'}
                progress_queue.put({"type": "metadata", **meta_event})
            except Exception:
                traceback.print_exc()
                raise

            tracks = info.get('tracks') or []
            if not tracks:
                raise RuntimeError(
                    "Playlist returned no tracks. It may be private, empty, or "
                    "blocked in your region."
                )

            db.mark_started(job_id)
            total = len(tracks)
            playlist_title = info.get('title')
            imported = 0
            reused = 0
            skipped = 0

            # Mirror the YouTube playlist as a real `playlists` row so the user
            # gets a curated, reorderable copy out of the box. Private by
            # default — they can flip it public from the UI. Lazily created
            # only after we have something to add (avoids empty playlists if
            # the import fails before the first track).
            mirrored_playlist_id: str | None = None

            def ensure_mirrored_playlist() -> str:
                nonlocal mirrored_playlist_id
                if mirrored_playlist_id is None:
                    pid = str(uuid.uuid4())
                    db.create_playlist(
                        playlist_id=pid,
                        owner_id=user.user_id,
                        name=playlist_title or "YouTube import",
                        description=f"Imported from {body.url}",
                        visibility="private",
                    )
                    mirrored_playlist_id = pid
                return mirrored_playlist_id

            for idx, entry in enumerate(tracks, start=1):
                if job_id in _cancelled:
                    raise _Cancelled()

                video_id = entry['id']
                title = entry.get('title') or video_id
                progress_queue.put({"type": "track", "index": idx, "total": total, "title": title})

                # Overall progress baseline at the start of this track.
                base_pct = (idx - 1) / total * 100

                existing = db.get_track(video_id, codec, bitrate)
                if existing and os.path.isfile(existing['file_path']):
                    # Already in the shared library — just link this user.
                    db.link_owner(
                        owner_id=user.user_id,
                        video_id=video_id,
                        codec=codec,
                        bitrate=bitrate,
                        source_playlist_title=playlist_title,
                    )
                    db.add_track_to_playlist(
                        ensure_mirrored_playlist(), video_id, codec, bitrate,
                    )
                    reused += 1
                    progress_queue.put({"type": "progress", "value": round(idx / total * 100, 1)})
                    db.update_progress(job_id, idx / total * 100)
                    continue

                dest_path = _library_path(video_id, codec, bitrate, ext)

                def on_track_progress(pct: float, _base=base_pct, _total=total):
                    if job_id in _cancelled:
                        raise _Cancelled()
                    overall = _base + (pct / _total)
                    progress_queue.put({"type": "progress", "value": round(overall, 1)})

                # Per-track try/except: one removed/private/region-locked
                # video shouldn't abort the entire playlist. _Cancelled still
                # propagates so the user's abort works.
                try:
                    ytDownloaderFunctions.download_track_audio(
                        entry.get('url') or f"https://www.youtube.com/watch?v={video_id}",
                        codec, bitrate, dest_path,
                        on_progress=on_track_progress,
                    )

                    file_size = os.path.getsize(dest_path)
                    sha256 = _sha256_file(dest_path)

                    db.register_track(
                        video_id=video_id,
                        codec=codec,
                        bitrate=bitrate,
                        title=title,
                        artist=entry.get('uploader'),
                        duration_sec=entry.get('duration_sec'),
                        thumbnail_url=entry.get('thumbnail'),
                        source_url=entry.get('url') or f"https://www.youtube.com/watch?v={video_id}",
                        file_path=dest_path,
                        file_size=file_size,
                        sha256=sha256,
                    )
                    db.link_owner(
                        owner_id=user.user_id,
                        video_id=video_id,
                        codec=codec,
                        bitrate=bitrate,
                        source_playlist_title=playlist_title,
                    )
                    db.add_track_to_playlist(
                        ensure_mirrored_playlist(), video_id, codec, bitrate,
                    )
                    imported += 1
                except _Cancelled:
                    raise
                except Exception as track_err:
                    traceback.print_exc()
                    skipped += 1
                    progress_queue.put({
                        "type": "track_skipped",
                        "index": idx,
                        "total": total,
                        "title": title,
                        "message": str(track_err),
                    })

                db.update_progress(job_id, idx / total * 100)

            db.finish(job_id, size_bytes=None)
            progress_queue.put({
                "type": "done",
                "filename": None,
                "imported": imported,
                "reused": reused,
                "skipped": skipped,
            })

        except _Cancelled:
            _jobs.pop(job_id, None)
            _cancelled.discard(job_id)
            db.cancel(job_id)
            progress_queue.put({"type": "cancelled"})

        except Exception as e:
            traceback.print_exc()
            _jobs.pop(job_id, None)
            db.fail(job_id, str(e))
            progress_queue.put({"type": "error", "message": str(e)})

    def run_zip():
        # Stage every track audio file in tmp_dir, then zip them as a single
        # archive served via /api/file. Per-track failures don't abort the
        # zip — they're surfaced as `track_skipped` and the rest still ship.
        try:
            try:
                info = ytDownloaderFunctions.get_playlist_tracks(body.url)
                db.set_metadata(
                    job_id,
                    playlist_title=info.get('title'),
                    playlist_count=info.get('count'),
                    thumbnail_url=info.get('thumbnail_url'),
                )
                meta_event = {k: v for k, v in info.items() if k != 'tracks'}
                progress_queue.put({"type": "metadata", **meta_event})
            except Exception:
                traceback.print_exc()
                raise

            tracks = info.get('tracks') or []
            if not tracks:
                raise RuntimeError(
                    "Playlist returned no tracks. It may be private, empty, or "
                    "blocked in your region."
                )

            db.mark_started(job_id)
            total = len(tracks)
            playlist_title = info.get('title') or "playlist"
            staged: list[tuple[str, str]] = []  # (src_path, arcname)
            skipped = 0

            for idx, entry in enumerate(tracks, start=1):
                if job_id in _cancelled:
                    raise _Cancelled()

                video_id = entry['id']
                title = entry.get('title') or video_id
                progress_queue.put({"type": "track", "index": idx, "total": total, "title": title})

                base_pct = (idx - 1) / total * 100

                # Each track is staged to its own subdir so download_track_audio
                # can drop its scratch files without colliding across tracks.
                track_dir = os.path.join(tmp_dir, video_id)
                arcname = f"{idx:02d} - {_safe_filename(title)}.{ext}"
                dest_path = os.path.join(track_dir, arcname)

                def on_track_progress(pct: float, _base=base_pct, _total=total):
                    if job_id in _cancelled:
                        raise _Cancelled()
                    overall = _base + (pct / _total)
                    progress_queue.put({"type": "progress", "value": round(overall, 1)})

                try:
                    ytDownloaderFunctions.download_track_audio(
                        entry.get('url') or f"https://www.youtube.com/watch?v={video_id}",
                        codec, bitrate, dest_path,
                        on_progress=on_track_progress,
                    )
                    staged.append((dest_path, arcname))
                except _Cancelled:
                    raise
                except Exception as track_err:
                    traceback.print_exc()
                    skipped += 1
                    progress_queue.put({
                        "type": "track_skipped",
                        "index": idx,
                        "total": total,
                        "title": title,
                        "message": str(track_err),
                    })

                db.update_progress(job_id, idx / total * 100)

            if not staged:
                raise RuntimeError(
                    "No tracks could be downloaded — every one failed or was skipped."
                )

            zip_name = f"{_safe_filename(playlist_title)}.zip"
            zip_path = os.path.join(tmp_dir, zip_name)
            # Audio is already compressed; ZIP_STORED keeps CPU + time low.
            with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
                for src, arcname in staged:
                    zf.write(src, arcname)

            _jobs[job_id]["file_path"] = zip_path
            zip_size = os.path.getsize(zip_path)
            db.finish(job_id, size_bytes=zip_size)
            progress_queue.put({
                "type": "done",
                "filename": zip_name,
                "imported": len(staged),
                "reused": 0,
                "skipped": skipped,
            })

        except _Cancelled:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            _cancelled.discard(job_id)
            db.cancel(job_id)
            progress_queue.put({"type": "cancelled"})

        except Exception as e:
            traceback.print_exc()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            db.fail(job_id, str(e))
            progress_queue.put({"type": "error", "message": str(e)})

    target = run_zip if body.as_file else run
    threading.Thread(target=target, daemon=True).start()
    return {"job_id": job_id}


def _safe_filename(s: str) -> str:
    """Strip filesystem-hostile characters from a string for use as a filename.
    Truncates to 120 chars to keep the resulting paths well under the 255-byte
    limit shared by ext4/NTFS/APFS."""
    bad = '<>:"/\\|?*\0'
    cleaned = ''.join(c if c not in bad else '_' for c in s).strip().strip('.')
    return (cleaned or 'track')[:120]


@app.websocket("/ws/progress/{job_id}")
async def progress_ws(websocket: WebSocket, job_id: str):
    """
    Stream download progress.

    Sends a `snapshot` event with the current DB state first, then either:
      - streams live queue events if the job is still running in memory, or
      - closes immediately if the job has reached a terminal state.
    """
    row = db.get(job_id)
    if row is None:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    await websocket.send_json({"type": "snapshot", "job": row})

    runtime = _jobs.get(job_id)
    if runtime is None:
        # Already finished, failed, interrupted, or cancelled — nothing live to stream.
        await websocket.close()
        return

    progress_queue: queue.Queue = runtime["queue"]
    try:
        while True:
            try:
                event = progress_queue.get_nowait()
                await websocket.send_json(event)
                if event["type"] in ("done", "error", "cancelled"):
                    break
            except queue.Empty:
                await asyncio.sleep(0.1)
        await websocket.close()
    except WebSocketDisconnect:
        pass


@app.get("/api/file/{job_id}")
def serve_file(
    job_id: str,
    background_tasks: BackgroundTasks,
    user: CurrentUser = Depends(current_user),
):
    """Serve the downloaded file and clean up the temp directory afterwards."""
    row = db.get(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    _ensure_owner(row, user)

    job = _jobs.get(job_id)
    if not job or not job.get("file_path"):
        raise HTTPException(status_code=404, detail="File not ready or already downloaded.")

    file_path = job["file_path"]
    tmp_dir = job["tmp_dir"]

    def cleanup():
        _jobs.pop(job_id, None)
        shutil.rmtree(tmp_dir, ignore_errors=True)

    background_tasks.add_task(cleanup)
    ext = os.path.splitext(file_path)[1].lower().lstrip(".")
    media_type = {
        "zip": "application/zip",
        "mp3": "audio/mpeg",
        "m4a": "audio/mp4",
        "flac": "audio/flac",
    }.get(ext, "video/mp4")
    return FileResponse(
        path=file_path,
        filename=os.path.basename(file_path),
        media_type=media_type,
    )


# ── Music library streaming ───────────────────────────────────────────────────

_AUDIO_MEDIA_TYPES = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "flac": "audio/flac",
}


@app.get("/api/library")
def list_library(limit: int = 500, user: CurrentUser = Depends(current_user)):
    """Return the caller's music library — every track they own."""
    return {"items": db.list_library(user.user_id, limit=limit)}


@app.delete("/api/library/{video_id}")
def remove_track(
    video_id: str,
    codec: str,
    bitrate: str,
    user: CurrentUser = Depends(current_user),
):
    """
    Unlink the caller from a track. The master row and the underlying file
    are preserved so the track stays in the shared catalog and other users
    can keep playing or adopting it — even when the caller was the last
    owner. Orphan cleanup is an admin concern.
    """
    unlinked = db.unlink_owner(user.user_id, video_id, codec, bitrate)
    if not unlinked:
        raise HTTPException(status_code=404, detail="track not in your library")
    return {"ok": True}


# ── Shared catalog ────────────────────────────────────────────────────────────
# Every download lands in the global `tracks` registry. The catalog surfaces it
# so any user can adopt an existing track into their library without triggering
# a fresh download. "In library" and "liked" used to be separate concepts; they
# were merged — the heart toggle is the library toggle, and `owner_count` is
# the social signal (people who saved this track).

_CATALOG_SORTS = {"newest", "popular", "title", "artist"}


@app.get("/api/catalog/tracks")
def list_catalog(
    q: str | None = None,
    sort: str = "newest",
    owned_only: bool = False,
    limit: int = 200,
    offset: int = 0,
    user: CurrentUser = Depends(current_user),
):
    """Paginated global track listing with per-viewer is_owned/is_liked flags.

    `owned_only=true` returns just the caller's library — the catalog's "mine"
    view that replaced the standalone Library page."""
    if sort not in _CATALOG_SORTS:
        sort = "newest"
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    items = db.list_catalog(
        user.user_id, query=q, sort=sort, owned_only=owned_only,
        limit=limit, offset=offset,
    )
    return {"items": items}


def _external_item(entry: dict) -> dict:
    """Shape a yt-dlp flat entry (from search or related) into the external
    candidate dict the frontend renders as a downloadable row/card."""
    return {
        "video_id": entry.get("id"),
        "title": entry.get("title"),
        "artist": entry.get("channel"),
        "thumbnail_url": entry.get("thumbnail"),
        "duration_sec": entry.get("duration_seconds"),
        "source_url": entry.get("url"),
    }


def _is_music_candidate(item: dict, *, strict: bool) -> bool:
    """Best-effort "this is a music track" check on a flat search/related entry.

    The real is_music heuristic needs the full video info (categories, music
    metadata), which flat extraction omits — so we use the strongest signals
    available without a per-video fetch:
      - a "<Artist> - Topic" channel is always music (YouTube Music upload);
      - otherwise fall back to duration. Real songs run ~1-15 min; this cleanly
        drops the hour-long compilation streams, DJ mixes and podcasts that
        dominate generic genre searches, plus sub-minute shorts.

    `strict` (category/search feeds) requires a song-length duration. The
    lenient mode (radio Mixes, already seeded from music) only rejects the
    obvious non-songs so a missing duration still passes.
    """
    artist = (item.get("artist") or "")
    if artist.endswith(" - Topic"):
        return True
    dur = item.get("duration_sec")
    if strict:
        return dur is not None and 60 <= dur <= 900
    return dur is None or 45 <= dur <= 1800


def _discover_feed(
    user_id: str,
    q_norm: str,
    limit: int,
    external_limit: int,
    *,
    music_only: bool = False,
) -> dict:
    """Shared hybrid feed: catalog matches + YouTube candidates not yet in the
    library. Used by both the search box and the curated category pages.

    Externals are deduped against the catalog matches by video_id. With
    `music_only` (categories), candidates are filtered to song-like tracks and
    we over-fetch to compensate for what the filter drops.
    """
    db_items = db.list_catalog(
        user_id, query=q_norm or None, sort="popular", limit=limit, offset=0,
    )

    externals: list[dict] = []
    # No query → purely local. External search only makes sense when looking
    # for something specific (search box) or a category seed is supplied.
    if q_norm and external_limit > 0:
        known_ids = {it["video_id"] for it in db_items}
        fetch = external_limit + len(known_ids)
        if music_only:
            # Long mixes get dropped, so cast a wider net to still fill the page.
            fetch = min(50, fetch * 3)
        try:
            raw = search_mod.search(q_norm, limit=fetch)
        except Exception:
            traceback.print_exc()
            raw = []
        for entry in raw:
            if len(externals) >= external_limit:
                break
            vid = entry.get("id")
            if not vid or vid in known_ids:
                continue
            item = _external_item(entry)
            if music_only and not _is_music_candidate(item, strict=True):
                continue
            externals.append(item)

    return {"db": db_items, "external": externals}


@app.get("/api/catalog/discover")
def catalog_discover(
    q: str = "",
    limit: int = 20,
    external_limit: int = 10,
    user: CurrentUser = Depends(current_user),
):
    """
    Hybrid search: local catalog + YouTube candidates that aren't yet in the
    shared library. Externals carry the metadata needed to render a row and
    fire a download against /api/download — they're not real tracks until the
    user clicks ⬇ and the job completes.

    Dedup: an external is dropped if its `video_id` already appears in the
    catalog results. We don't run an `is_music` check per external — that
    would require a per-video yt-dlp call (1-2s each). The user explicitly
    opts in by clicking the download button, so a stray podcast slipping
    through is acceptable; they can always un-own it.
    """
    q_norm = (q or "").strip()
    limit = max(1, min(limit, 100))
    external_limit = max(0, min(external_limit, 25))
    return _discover_feed(user.user_id, q_norm, limit, external_limit)


@app.get("/api/catalog/suggestions")
def catalog_suggestions(
    limit: int = 18,
    user: CurrentUser = Depends(current_user),
):
    """
    At-rest discovery: seed YouTube Mixes from the catalog's most popular
    tracks and surface related songs that aren't in the shared library yet.

    Why this shape:
      - Seeds come from `sort="popular"` so suggestions track what the group
        actually listens to, not a random corner of the catalog.
      - Results are round-robin interleaved across seeds so one artist's mix
        doesn't dominate the list.
      - Dedup is against the *entire* catalog (everything downloaded), not just
        the seeds, so we never suggest something already owned.

    Best-effort: an empty/cold catalog or a failing mix yields fewer (or zero)
    suggestions rather than an error.
    """
    limit = max(1, min(limit, 40))

    # One generous read does double duty: pick popular seeds AND build the
    # dedup set of everything already in the shared library.
    catalog = db.list_catalog(user.user_id, sort="popular", limit=500, offset=0)
    if not catalog:
        return {"external": []}

    known_ids = {it["video_id"] for it in catalog}

    # A few seeds is plenty — each Mix returns ~12 related videos and fetching
    # them is the slow part (one yt-dlp call each, cached 15min after).
    mixes: list[list[dict]] = []
    for seed in catalog[:4]:
        try:
            mixes.append(search_mod.related(seed["video_id"], limit=12))
        except Exception:
            traceback.print_exc()
            mixes.append([])

    seen: set[str] = set()
    suggestions: list[dict] = []
    depth = 0
    # Round-robin: take the i-th entry from every mix before the (i+1)-th, so
    # the head of the list is a spread across seeds rather than one full mix.
    while len(suggestions) < limit and any(depth < len(m) for m in mixes):
        for mix in mixes:
            if depth >= len(mix) or len(suggestions) >= limit:
                continue
            entry = mix[depth]
            vid = entry.get("id")
            if not vid or vid in known_ids or vid in seen:
                continue
            item = _external_item(entry)
            # Radio Mixes are music-seeded; the lenient filter only trims the
            # odd hour-long upload or sub-minute clip that sneaks in.
            if not _is_music_candidate(item, strict=False):
                continue
            seen.add(vid)
            suggestions.append(item)
        depth += 1

    return {"external": suggestions}


# ── Play history ───────────────────────────────────────────────────────────────

class PlayEvent(BaseModel):
    video_id: str
    codec: str
    bitrate: str


@app.post("/api/track/play")
def track_play(body: PlayEvent, user: CurrentUser = Depends(current_user)):
    """Record a playback. Fire-and-forget from the client after ~20s of
    listening. Swallows failures (e.g. a track removed mid-play) — losing a
    play event must never break playback."""
    try:
        db.record_play(user.user_id, body.video_id, body.codec, body.bitrate)
    except Exception:
        traceback.print_exc()
    return {"ok": True}


@app.get("/api/me/recent")
def recent_plays(limit: int = 20, user: CurrentUser = Depends(current_user)):
    """The caller's recently played tracks (distinct, newest first)."""
    limit = max(1, min(limit, 50))
    return {"items": db.list_recent_plays(user.user_id, limit=limit)}


@app.get("/api/me/stats")
def my_stats(window_days: int = 30, user: CurrentUser = Depends(current_user)):
    """Personal listening stats over a window — top tracks/artists + totals,
    a lightweight 'wrapped'. window_days <= 0 means all time."""
    window_days = max(0, min(window_days, 3650))
    since = None
    if window_days > 0:
        since = (datetime.now(timezone.utc) - timedelta(days=window_days)).isoformat()
    return {
        "window_days": window_days,
        "total_plays": db.count_plays(user.user_id, since=since),
        "top_tracks": db.top_played_tracks(user.user_id, limit=12, since=since),
        "top_artists": db.top_played_artists(user.user_id, limit=8, since=since),
    }


@app.get("/api/activity")
def activity(limit: int = 30, user: CurrentUser = Depends(current_user)):
    """Recent library additions across all users — the shared activity feed."""
    limit = max(1, min(limit, 100))
    return {"items": db.list_recent_additions(limit=limit)}


# ── Browse: categories + daily mixes ────────────────────────────────────────────

@app.get("/api/catalog/categories")
def catalog_categories():
    """The curated Browse grid. Static config — no auth needed beyond the SPA."""
    return {
        "categories": [
            {k: c[k] for k in ("slug", "title", "accent")}
            for c in categories_mod.CATEGORIES
        ]
    }


@app.get("/api/catalog/category/{slug}")
def catalog_category(
    slug: str,
    limit: int = 12,
    external_limit: int = 18,
    user: CurrentUser = Depends(current_user),
):
    """A category feed: the curated seed search run through the discover
    pipeline — catalog tracks you can play + YouTube candidates to download."""
    cat = categories_mod.CATEGORY_BY_SLUG.get(slug)
    if cat is None:
        raise HTTPException(status_code=404, detail="unknown category")
    limit = max(1, min(limit, 50))
    external_limit = max(0, min(external_limit, 30))
    feed = _discover_feed(
        user.user_id, cat["query"], limit, external_limit, music_only=True,
    )
    return {
        "category": {k: cat[k] for k in ("slug", "title", "accent")},
        **feed,
    }


@app.get("/api/catalog/radio/{video_id}")
def catalog_radio(
    video_id: str,
    external_limit: int = 18,
    user: CurrentUser = Depends(current_user),
):
    """"More like this" / artist radio for a track: the seed's YouTube Mix split
    into what's already in the catalog (playable now) and new candidates to
    download. Music-filtered (lenient — the Mix is music-seeded)."""
    external_limit = max(0, min(external_limit, 30))
    try:
        rel = search_mod.related(video_id, limit=external_limit + 20)
    except Exception:
        traceback.print_exc()
        rel = []

    by_id = {
        c["video_id"]: c
        for c in db.list_catalog(user.user_id, sort="popular", limit=500)
    }

    db_items: list[dict] = []
    externals: list[dict] = []
    seen: set[str] = set()
    for entry in rel:
        vid = entry.get("id")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        if vid in by_id:
            db_items.append(by_id[vid])
            continue
        if len(externals) >= external_limit:
            continue
        item = _external_item(entry)
        if not _is_music_candidate(item, strict=False):
            continue
        externals.append(item)

    return {"db": db_items, "external": externals}


@app.get("/api/catalog/daily-mixes")
def daily_mixes(
    count: int = 4,
    size: int = 40,
    user: CurrentUser = Depends(current_user),
):
    """Rotating daily mixes of *playable* catalog tracks.

    Personalized when the user has listening history (anchored to their most-
    played artists); otherwise anchored to the catalog's most popular artists.
    A per-day seed rotates which artists anchor today's mixes and shuffles each
    mix deterministically, so they're stable within a day and change the next.

    Each mix leads with the anchor artist's tracks then fills with a per-mix
    shuffle of the rest of the catalog — so mixes are long and each one draws a
    different slice (variety across mixes, not the same popular tail repeated).
    Mix length is naturally bounded by how much music has been downloaded.
    """
    count = max(1, min(count, 6))
    size = max(5, min(size, 60))
    day_seed = int(datetime.now(timezone.utc).strftime("%Y%m%d"))

    def key(t: dict) -> tuple:
        return (t["video_id"], t["codec"], t["bitrate"])

    # Seeds: most-played artists first (personalized), then top up with artists
    # behind the most popular catalog tracks so there are always several mixes
    # to choose from even with thin listening history.
    anchors = [a["artist"] for a in db.top_played_artists(user.user_id, limit=12)]
    personalized = bool(anchors)

    # Wide pool so mixes can be long and varied as the catalog grows.
    pool = db.list_catalog(user.user_id, sort="popular", limit=400)
    seen_a: set[str] = {a for a in anchors}
    for it in pool:
        if len(anchors) >= max(count, 6):
            break
        a = (it.get("artist") or "").strip()
        if a and a not in seen_a:
            seen_a.add(a)
            anchors.append(a)

    if not anchors:
        return {"mixes": [], "personalized": False}

    # Rotate which anchors lead today.
    rot = day_seed % len(anchors)
    todays = (anchors[rot:] + anchors[:rot])[:count]

    mixes: list[dict] = []
    for i, anchor in enumerate(todays):
        lead = db.list_tracks_by_artist(user.user_id, anchor, limit=size)
        random.Random(day_seed * 7 + i).shuffle(lead)
        have = {key(t) for t in lead}
        # Everything else, shuffled with a per-mix seed so each mix pulls a
        # different cross-section of the catalog rather than the same tail.
        rest = [t for t in pool if key(t) not in have]
        random.Random(day_seed + i).shuffle(rest)
        tracks = (lead + rest)[:size]
        if len(tracks) < 4:
            continue  # too thin to be a "mix"
        # "<Artist> - Topic" is YouTube's auto-channel naming — show just the artist.
        subtitle = anchor[: -len(" - Topic")] if anchor.endswith(" - Topic") else anchor
        mixes.append({
            "id": f"daily-{day_seed}-{i}",
            "title": f"Daily Mix {i + 1}",
            "subtitle": subtitle,
            "accent": ("hot", "cool", "violet")[i % 3],
            "tracks": tracks,
        })

    return {"mixes": mixes, "personalized": personalized}


@app.post("/api/catalog/tracks/{video_id}/{codec}/{bitrate}/own")
def catalog_adopt(
    video_id: str,
    codec: str,
    bitrate: str,
    user: CurrentUser = Depends(current_user),
):
    """Adopt an existing catalog track into the caller's library — no download
    happens, just a new `track_owners` row."""
    if db.get_track(video_id, codec, bitrate) is None:
        raise HTTPException(status_code=404, detail="track not in catalog")
    db.link_owner(
        owner_id=user.user_id,
        video_id=video_id, codec=codec, bitrate=bitrate,
    )
    return {"ok": True, "owned": True}


@app.delete("/api/catalog/tracks/{video_id}/{codec}/{bitrate}/own")
def catalog_unown(
    video_id: str,
    codec: str,
    bitrate: str,
    user: CurrentUser = Depends(current_user),
):
    """Un-adopt: remove the caller from the track's owner list. The track
    stays in the shared catalog so anyone else can keep playing or adopting
    it — that's the whole point of the catalog being eternal."""
    db.unlink_owner(user.user_id, video_id, codec, bitrate)
    return {"ok": True, "owned": False}


# ── Playlists ────────────────────────────────────────────────────────────────

class PlaylistCreate(BaseModel):
    name: str
    description: str | None = None
    visibility: str = "private"  # 'private' | 'public'


class PlaylistUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    visibility: str | None = None
    cover_url: str | None = None


class PlaylistTrackKey(BaseModel):
    video_id: str
    codec: str
    bitrate: str


class PlaylistReorder(BaseModel):
    order: list[PlaylistTrackKey]


def _ensure_playlist_visible(playlist: dict, user: CurrentUser) -> None:
    """403 unless the playlist is public or the caller owns it (ADMIN bypasses)."""
    if user.is_admin:
        return
    if playlist["visibility"] == "public":
        return
    if playlist["owner_id"] == user.user_id:
        return
    raise HTTPException(status_code=403, detail="playlist is private")


def _ensure_playlist_owner(playlist: dict, user: CurrentUser) -> None:
    """403 unless the caller owns the playlist (ADMIN bypasses)."""
    if user.is_admin:
        return
    if playlist["owner_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="not your playlist")


@app.get("/api/playlists")
def list_playlists(
    owner_id: str | None = None,
    limit: int = 200,
    user: CurrentUser = Depends(current_user),
):
    """List playlists viewable by the caller — every public playlist + their
    own private ones. Pass `owner_id=me` (or a user id) to scope by creator."""
    if owner_id == "me":
        owner_id = user.user_id
    limit = max(1, min(limit, 500))
    items = db.list_playlists(user.user_id, owner_id=owner_id, limit=limit)
    return {"items": items}


@app.post("/api/playlists")
def create_playlist(
    body: PlaylistCreate,
    user: CurrentUser = Depends(current_user),
):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    playlist_id = str(uuid.uuid4())
    db.create_playlist(
        playlist_id=playlist_id,
        owner_id=user.user_id,
        name=name,
        description=body.description,
        visibility=body.visibility,
    )
    return {"id": playlist_id}


@app.get("/api/playlists/{playlist_id}")
def get_playlist(
    playlist_id: str,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_visible(playlist, user)
    tracks = db.list_playlist_tracks(playlist_id)
    return {
        **playlist,
        "is_owner": playlist["owner_id"] == user.user_id,
        "tracks": tracks,
    }


@app.patch("/api/playlists/{playlist_id}")
def patch_playlist(
    playlist_id: str,
    body: PlaylistUpdate,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_owner(playlist, user)
    db.update_playlist(
        playlist_id,
        name=body.name.strip() if body.name is not None else None,
        description=body.description,
        visibility=body.visibility,
        cover_url=body.cover_url,
    )
    return {"ok": True}


@app.delete("/api/playlists/{playlist_id}")
def delete_playlist(
    playlist_id: str,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_owner(playlist, user)
    db.delete_playlist(playlist_id)
    return {"ok": True}


@app.post("/api/playlists/{playlist_id}/tracks")
def add_track(
    playlist_id: str,
    body: PlaylistTrackKey,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_owner(playlist, user)
    if db.get_track(body.video_id, body.codec, body.bitrate) is None:
        raise HTTPException(status_code=404, detail="track not in catalog")
    added = db.add_track_to_playlist(playlist_id, body.video_id, body.codec, body.bitrate)
    return {"ok": True, "added": added}


@app.delete("/api/playlists/{playlist_id}/tracks/{video_id}/{codec}/{bitrate}")
def remove_track_from_playlist(
    playlist_id: str,
    video_id: str,
    codec: str,
    bitrate: str,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_owner(playlist, user)
    removed = db.remove_track_from_playlist(playlist_id, video_id, codec, bitrate)
    if not removed:
        raise HTTPException(status_code=404, detail="track not in this playlist")
    return {"ok": True}


@app.patch("/api/playlists/{playlist_id}/order")
def reorder_playlist(
    playlist_id: str,
    body: PlaylistReorder,
    user: CurrentUser = Depends(current_user),
):
    playlist = db.get_playlist(playlist_id)
    if playlist is None:
        raise HTTPException(status_code=404, detail="playlist not found")
    _ensure_playlist_owner(playlist, user)
    keys = [(k.video_id, k.codec, k.bitrate) for k in body.order]
    reordered = db.reorder_playlist(playlist_id, keys)
    return {"ok": True, "reordered": reordered}


@app.get("/api/track/{video_id}/stream")
def stream_track(
    video_id: str,
    request: Request,
    codec: str = "mp3",
    bitrate: str = "192",
    user: CurrentUser = Depends(current_user),
):
    """
    Stream a track from the library to an HTML <audio> element. Honors the
    `Range` header so the browser can seek without re-downloading.

    Any authenticated user can stream any track in the shared catalog — this is
    what lets users play tracks from public playlists or the catalog without
    first adopting them into their own library.
    """
    track = db.get_track(video_id, codec, bitrate)
    if track is None:
        raise HTTPException(status_code=404, detail="track not found")
    file_path = track["file_path"]
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=410, detail="track file missing on disk")

    file_size = os.path.getsize(file_path)
    media_type = _AUDIO_MEDIA_TYPES.get(track["codec"], "application/octet-stream")
    range_header = request.headers.get("range") or request.headers.get("Range")

    if not range_header:
        return FileResponse(
            file_path,
            media_type=media_type,
            headers={
                "Accept-Ranges": "bytes",
                "Content-Length": str(file_size),
                "Cache-Control": "private, max-age=3600",
            },
        )

    # Parse `Range: bytes=START-END`. We only handle a single byte range — the
    # browser's <audio> tag never issues multipart range requests.
    try:
        units, _, ranges = range_header.partition("=")
        if units.strip().lower() != "bytes":
            raise ValueError("only `bytes` units are supported")
        start_str, _, end_str = ranges.strip().split(",", 1)[0].partition("-")
        start = int(start_str) if start_str else 0
        end = int(end_str) if end_str else file_size - 1
    except ValueError:
        raise HTTPException(status_code=416, detail="invalid Range header")

    if start < 0 or end >= file_size or start > end:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    chunk_size = 1024 * 64
    length = end - start + 1

    def iter_chunk():
        remaining = length
        with open(file_path, "rb") as f:
            f.seek(start)
            while remaining > 0:
                buf = f.read(min(chunk_size, remaining))
                if not buf:
                    break
                remaining -= len(buf)
                yield buf

    return StreamingResponse(
        iter_chunk(),
        status_code=206,
        media_type=media_type,
        headers={
            "Accept-Ranges": "bytes",
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Content-Length": str(length),
            "Cache-Control": "private, max-age=3600",
        },
    )


# ── Job history / queue management ────────────────────────────────────────────

@app.get("/api/jobs")
def list_jobs(user: CurrentUser = Depends(current_user)):
    """Return all jobs ordered by creation time desc. USER scoped to own jobs; ADMIN sees all."""
    return {"jobs": db.list_jobs(owner_id=user.owner_filter)}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, user: CurrentUser = Depends(current_user)):
    row = db.get(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    _ensure_owner(row, user)
    return row


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, user: CurrentUser = Depends(current_user)):
    """Mark an active job for cancellation. The thread will abort at next progress tick."""
    row = db.get(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    _ensure_owner(row, user)
    if row["status"] not in db.ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail=f"Job is not active (status={row['status']}).")
    _cancelled.add(job_id)
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
def retry_job(job_id: str, user: CurrentUser = Depends(current_user)):
    """Re-queue a previously completed/interrupted/failed job with its original parameters."""
    row = db.get(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    _ensure_owner(row, user)
    if row["status"] in db.ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="Job is still active.")

    if row["is_playlist"]:
        return start_playlist_download(
            PlaylistDownloadRequest(url=row["url"], quality=row["format_code"]),
            user=user,
        )
    return start_download(
        DownloadRequest(
            url=row["url"],
            format_code=row["format_code"],
            resolution=row["resolution"],
            ext=row["ext"],
        ),
        user=user,
    )


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str, user: CurrentUser = Depends(current_user)):
    row = db.get(job_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    _ensure_owner(row, user)
    if row["status"] in db.ACTIVE_STATUSES:
        raise HTTPException(status_code=409, detail="Cancel the job before deleting it.")
    db.delete(job_id)
    return {"ok": True}


# ── Search ────────────────────────────────────────────────────────────────────

@app.get("/api/search/suggest")
def search_suggest(
    q: str = "",
    hl: str = "es",
    user: CurrentUser = Depends(current_user),
):
    """Autocomplete strings for the search bar dropdown. Cached 60s."""
    return {"suggestions": search_mod.suggest(q, hl=hl)}


@app.get("/api/search")
def search_videos(
    q: str = "",
    limit: int = 20,
    user: CurrentUser = Depends(current_user),
):
    """yt-dlp ytsearch:<q> — listing-level metadata only. Cached 5min."""
    try:
        return {"results": search_mod.search(q, limit=limit)}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"search failed: {e}")


@app.get("/api/history")
def search_history(
    limit: int = 20,
    user: CurrentUser = Depends(current_user),
):
    """
    Recent completed downloads for the current user — used as the empty-state
    dropdown in the search bar. Returns the same shape the search results do
    so the frontend can render both with one card component.
    """
    rows = db.list_jobs(owner_id=user.user_id, limit=limit * 3)
    items = []
    for row in rows:
        if row.get("status") != db.DONE:
            continue
        items.append({
            "id": row["id"],
            "title": row.get("title"),
            "channel": row.get("uploader"),
            "thumbnail": row.get("thumbnail_url"),
            "duration_seconds": row.get("duration_sec"),
            "url": row["url"],
            "completed_at": row.get("completed_at"),
        })
        if len(items) >= limit:
            break
    return {"items": items}


# ── SPA fallback ──────────────────────────────────────────────────────────────
# Must be declared AFTER every /api and /ws route so it doesn't shadow them.
# Returns index.html for any GET that didn't match — the React router takes over
# on the client. If the build isn't present (dev), responds 404.

if _FRONTEND_DIST and os.path.isfile(os.path.join(_FRONTEND_DIST, "index.html")):
    _SPA_INDEX = os.path.join(_FRONTEND_DIST, "index.html")

    # index.html is the SPA's manifest — must always revalidate or the browser
    # ends up loading stale bundles after a deploy. Same for root-level static
    # files (favicon, manifest.json) that don't have a content hash in the name.
    _NO_CACHE = {"Cache-Control": "no-cache"}

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        if full_path.startswith(("api/", "ws/", "assets/")):
            raise HTTPException(status_code=404)
        candidate = os.path.join(_FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate, headers=_NO_CACHE)
        return FileResponse(_SPA_INDEX, headers=_NO_CACHE)
