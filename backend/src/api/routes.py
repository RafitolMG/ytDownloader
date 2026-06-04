import asyncio
import os
import queue
import shutil
import tempfile
import threading
import time
import traceback
import uuid
import zipfile

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from src import config, db, ytDownloaderFunctions
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
    db.init()


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
            return {"is_playlist": True}
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
    Returns a job_id to connect to via WebSocket for progress updates.
    When done, fetch /api/file/{job_id} to receive the file.
    """
    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    tmp_dir = tempfile.mkdtemp(prefix="ytdl_")
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

    db.create_job(
        job_id=job_id,
        url=body.url,
        format_code=body.format_code,
        resolution=body.resolution,
        ext=body.ext,
        owner_id=user.user_id,
    )

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

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


@app.post("/api/download-playlist")
def start_playlist_download(body: PlaylistDownloadRequest, user: CurrentUser = Depends(current_user)):
    """
    Download all tracks in a playlist as MP3, zipped into a single archive.
    Returns a job_id to track progress via WebSocket.
    """
    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    tmp_dir = tempfile.mkdtemp(prefix="ytdl_playlist_")
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

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
                info = ytDownloaderFunctions.get_playlist_info(body.url)
                db.set_metadata(
                    job_id,
                    playlist_title=info.get('title'),
                    playlist_count=info.get('count'),
                    thumbnail_url=info.get('thumbnail_url'),
                )
                progress_queue.put({"type": "metadata", **info})
            except Exception:
                traceback.print_exc()

            db.mark_started(job_id)
            on_progress = _throttled_progress(job_id, progress_queue)

            def on_video_start(index, total, title):
                progress_queue.put({"type": "track", "index": index, "total": total, "title": title})

            ytDownloaderFunctions.download_playlist(
                body.url, body.quality, tmp_dir,
                on_progress=on_progress,
                on_video_start=on_video_start,
            )

            downloaded = []
            for root, _dirs, files in os.walk(tmp_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    downloaded.append((fpath, os.path.relpath(fpath, tmp_dir)))

            if not downloaded:
                raise RuntimeError(
                    "No tracks were downloaded. Possible causes: the playlist is "
                    "private or empty, YouTube is blocking the request (add a "
                    "cookies.txt file to the project root), or all tracks are "
                    "unavailable in your region."
                )

            zip_path = os.path.join(tmp_dir, "playlist.zip")
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
                for fpath, arcname in downloaded:
                    if not fpath.endswith("playlist.zip"):
                        zf.write(fpath, arcname)

            _jobs[job_id]["file_path"] = zip_path
            db.finish(job_id, size_bytes=os.path.getsize(zip_path))
            progress_queue.put({"type": "done", "filename": "playlist.zip"})

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
