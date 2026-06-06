import asyncio
import hashlib
import os
import queue
import shutil
import tempfile
import threading
import time
import traceback
import uuid

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src import config, db, search as search_mod, ytDownloaderFunctions
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


class PlaylistDownloadRequest(BaseModel):
    url: str
    quality: str = 'audio'


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

    Two flows depending on `format_code`:
      - Audio preset (mp3-192, mp3-320, m4a, flac): imports the track into
        the user's music library (shared content-addressed storage with
        dedup). Emits `done {filename: null}` so the frontend doesn't try to
        download a file.
      - Anything else: standard single-video download → tmp_dir → file served
        via /api/file/{job_id}.
    """
    is_audio_import = ytDownloaderFunctions.is_audio_quality(body.format_code)

    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    # For audio imports we don't need a tmp_dir at the job level — the per-track
    # downloader manages its own scratch space under LIBRARY_DIR.
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

    target = run_audio_import if is_audio_import else run
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
    Import a playlist into the user's library. Each track is stored in the
    shared content-addressed library at LIBRARY_DIR/{video_id}/{codec}_{bitrate}.{ext}.

    Dedup rules per track:
      - If the (video_id, codec, bitrate) tuple exists in `tracks` AND the
        file is present on disk → skip the download and just link this user as
        an owner.
      - If the row exists but the file is gone → re-download.
      - Otherwise → download, hash, register, link.

    Returns a job_id to track progress via WebSocket.
    """
    try:
        codec, bitrate, ext = ytDownloaderFunctions.parse_audio_quality(body.quality)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": None}

    db.create_job(
        job_id=job_id,
        url=body.url,
        format_code=body.quality,
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

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


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
    media_type = "application/zip" if file_path.endswith(".zip") else "video/mp4"
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
    Unlink the caller from a track. If they were the last owner, the master
    record and the underlying audio file are deleted too. Cleans up the
    video_id directory when empty.
    """
    result = db.remove_from_library(user.user_id, video_id, codec, bitrate)
    if not result["unlinked"]:
        raise HTTPException(status_code=404, detail="track not in your library")

    if result["orphaned"] and result["file_path"]:
        try:
            os.remove(result["file_path"])
        except FileNotFoundError:
            pass
        # Drop the per-video directory if it's now empty.
        parent = os.path.dirname(result["file_path"])
        try:
            if os.path.isdir(parent) and not os.listdir(parent):
                os.rmdir(parent)
        except OSError:
            pass

    return {"ok": True, "orphaned": result["orphaned"]}


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
    """
    if not db.is_owned(user.user_id, video_id, codec, bitrate) and not user.is_admin:
        raise HTTPException(status_code=404, detail="track not in your library")

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
