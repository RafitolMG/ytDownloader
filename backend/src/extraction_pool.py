"""
Dedicated bounded threadpool for yt-dlp-bound request handlers.

FastAPI runs sync path handlers on a single shared anyio threadpool. A burst of
1-5s yt-dlp extractions there starves the cheap DB endpoints (library / catalog
/ playlists) queued on the same pool. Routing extraction through its own bounded
pool (via async handlers + run_extraction) isolates that load.

IMPORTANT: an async handler must NOT make blocking SQLite calls directly — that
would block the event loop. Handlers that mix db + extraction offload their
*whole* blocking body through here, so the db work runs in this pool too (db
uses thread-local connections, so a fresh worker thread is fine).
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from src import config

EXTRACTION_POOL = ThreadPoolExecutor(
    max_workers=config.EXTRACTION_WORKERS,
    thread_name_prefix="ytdl-extract",
)


async def run_extraction(fn: Callable[[], Any], *, timeout: float | None = None) -> Any:
    """Run a blocking callable in the extraction pool, off the event loop and the
    default request pool, with an optional timeout (raises asyncio.TimeoutError).

    On timeout the worker is abandoned — the yt-dlp subprocess keeps running to
    completion in the background — but the request is freed. That's acceptable
    for the rare hang; the bounded pool size caps how many can pile up.
    """
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(EXTRACTION_POOL, fn)
    if timeout is None:
        return await fut
    return await asyncio.wait_for(fut, timeout=timeout)
