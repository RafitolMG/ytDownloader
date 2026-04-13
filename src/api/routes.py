import asyncio
import os
import queue
import shutil
import tempfile
import threading
import traceback
import uuid
import zipfile

from fastapi import BackgroundTasks, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
from pydantic import BaseModel

from src import ytDownloaderFunctions

app = FastAPI(title="YT Downloader")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# job_id -> {"queue": Queue, "file_path": str | None, "tmp_dir": str}
_jobs: dict[str, dict] = {}


# ── Request models ────────────────────────────────────────────────────────────

class ResolutionsRequest(BaseModel):
    url: str


class DownloadRequest(BaseModel):
    url: str
    format_code: str


class PlaylistDownloadRequest(BaseModel):
    url: str
    quality: str = 'audio'


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/")
def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.post("/api/resolutions")
def get_resolutions(body: ResolutionsRequest):
    """Fetch available MP4 formats for a single video, or detect a playlist URL."""
    try:
        if ytDownloaderFunctions.is_playlist(body.url):
            return {"is_playlist": True}
        return ytDownloaderFunctions.get_available_resolutions(body.url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/download")
def start_download(body: DownloadRequest):
    """
    Start a download in a background thread.
    Returns a job_id to connect to via WebSocket for progress updates.
    When done, fetch /api/file/{job_id} to receive the file.
    """
    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    tmp_dir = tempfile.mkdtemp(prefix="ytdl_")
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

    def run():
        try:
            def on_progress(percent: float):
                progress_queue.put({"type": "progress", "value": round(percent, 1)})

            video_filename, _, audio_codec, total_frames = ytDownloaderFunctions.download_video(
                body.url, body.format_code, tmp_dir, on_progress
            )

            final_path = video_filename

            if audio_codec == 'none':
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
                # Rename to clean filename now that the original video file is gone
                final_path = os.path.join(tmp_dir, f"{base}.mp4")
                os.rename(merged_tmp, final_path)

            _jobs[job_id]["file_path"] = final_path
            progress_queue.put({"type": "done", "filename": os.path.basename(final_path)})

        except Exception as e:
            traceback.print_exc()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            progress_queue.put({"type": "error", "message": str(e)})

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


@app.post("/api/download-playlist")
def start_playlist_download(body: PlaylistDownloadRequest):
    """
    Download all tracks in a playlist as MP3, zipped into a single archive.
    Returns a job_id to track progress via WebSocket.
    """
    job_id = str(uuid.uuid4())
    progress_queue: queue.Queue = queue.Queue()
    tmp_dir = tempfile.mkdtemp(prefix="ytdl_playlist_")
    _jobs[job_id] = {"queue": progress_queue, "file_path": None, "tmp_dir": tmp_dir}

    def run():
        try:
            def on_progress(percent: float):
                progress_queue.put({"type": "progress", "value": round(percent, 1)})

            def on_video_start(index, total, title):
                progress_queue.put({"type": "track", "index": index, "total": total, "title": title})

            ytDownloaderFunctions.download_playlist(
                body.url, body.quality, tmp_dir,
                on_progress=on_progress,
                on_video_start=on_video_start,
            )

            # Collect every file that was written to the temp dir
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
            progress_queue.put({"type": "done", "filename": "playlist.zip"})

        except Exception as e:
            traceback.print_exc()
            shutil.rmtree(tmp_dir, ignore_errors=True)
            _jobs.pop(job_id, None)
            progress_queue.put({"type": "error", "message": str(e)})

    threading.Thread(target=run, daemon=True).start()
    return {"job_id": job_id}


@app.websocket("/ws/progress/{job_id}")
async def progress_ws(websocket: WebSocket, job_id: str):
    """Stream download progress to the client via WebSocket."""
    if job_id not in _jobs:
        await websocket.close(code=4004)
        return

    await websocket.accept()
    progress_queue = _jobs[job_id]["queue"]

    try:
        while True:
            try:
                event = progress_queue.get_nowait()
                await websocket.send_json(event)
                if event["type"] in ("done", "error"):
                    break
            except queue.Empty:
                await asyncio.sleep(0.1)
        await websocket.close()
    except WebSocketDisconnect:
        pass


@app.get("/api/file/{job_id}")
def serve_file(job_id: str, background_tasks: BackgroundTasks):
    """Serve the downloaded file and clean up the temp directory afterwards."""
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
