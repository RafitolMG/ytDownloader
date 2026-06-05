"""
YouTube search: autocomplete suggestions (text strings) + full video results.

Two upstreams:
  - suggestqueries.google.com (with client=firefox returns clean JSON) for the
    typeahead dropdown. No API key.
  - yt-dlp's ytsearch:<N> for the result grid (flat extraction — listing-level
    metadata only, no per-video page fetch).

Both endpoints are cached in-memory with a short TTL because users type the
same prefixes constantly and the results don't shift second-by-second.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx
import yt_dlp

from src.ytDownloaderFunctions import _get_cookie_opts

log = logging.getLogger(__name__)


# ── TTL cache ─────────────────────────────────────────────────────────────────

class _TTLCache:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl = ttl_seconds
        self._store: dict[str, tuple[Any, float]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, ts = entry
        if time.time() - ts > self.ttl:
            self._store.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._store[key] = (value, time.time())


_SUGGEST_CACHE = _TTLCache(ttl_seconds=60)
_SEARCH_CACHE = _TTLCache(ttl_seconds=300)


# ── Suggest (autocomplete strings) ────────────────────────────────────────────

_SUGGEST_URL = "https://suggestqueries.google.com/complete/search"


def suggest(q: str, hl: str = "es") -> list[str]:
    """
    Return up to ~10 autocomplete strings for the query. Empty list on any
    error — this is a UX nicety, not a critical path.
    """
    q = q.strip()
    if not q:
        return []

    cache_key = f"{hl}:{q.lower()}"
    cached = _SUGGEST_CACHE.get(cache_key)
    if cached is not None:
        return cached

    try:
        # client=firefox returns plain JSON: ["q", ["s1", "s2", ...]]
        # Other clients wrap in JSONP / extra metadata — harder to parse.
        r = httpx.get(
            _SUGGEST_URL,
            params={"client": "firefox", "ds": "yt", "q": q, "hl": hl},
            timeout=5.0,
            headers={"User-Agent": "Mozilla/5.0"},
        )
        r.raise_for_status()
        data = r.json()
        suggestions = data[1] if isinstance(data, list) and len(data) > 1 else []
        suggestions = [s for s in suggestions if isinstance(s, str)]
    except Exception as e:
        log.warning("suggest failed for q=%r: %s", q, e)
        suggestions = []

    _SUGGEST_CACHE.set(cache_key, suggestions)
    return suggestions


# ── Search (video results) ────────────────────────────────────────────────────

def _shape_entry(entry: dict) -> dict | None:
    """Pick the SPA-relevant fields. Skip entries missing an id (shouldn't happen)."""
    vid = entry.get("id")
    if not vid:
        return None

    # Pick the best thumbnail: prefer the medium-sized one (around 320px wide)
    # when available — yt-dlp returns several sizes in `thumbnails`.
    thumbnail = entry.get("thumbnail")
    if not thumbnail:
        thumbs = entry.get("thumbnails") or []
        if thumbs:
            thumbnail = thumbs[-1].get("url")  # last is usually highest-res

    return {
        "id": vid,
        "title": entry.get("title") or "(untitled)",
        "channel": entry.get("channel") or entry.get("uploader"),
        "channel_url": entry.get("channel_url") or entry.get("uploader_url"),
        "thumbnail": thumbnail,
        "duration_seconds": int(entry["duration"]) if entry.get("duration") else None,
        "view_count": entry.get("view_count"),
        "url": entry.get("url") or f"https://www.youtube.com/watch?v={vid}",
    }


def search(q: str, limit: int = 20) -> list[dict]:
    """
    Run a YouTube search via yt-dlp. Flat extraction — listing-level metadata
    only (no per-video page fetch), so the call takes 1-3s for 20 results
    instead of 20-30s.
    """
    q = q.strip()
    if not q:
        return []
    limit = max(1, min(limit, 50))

    cache_key = f"{limit}:{q.lower()}"
    cached = _SEARCH_CACHE.get(cache_key)
    if cached is not None:
        return cached

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignore_no_formats_error": True,
        **_get_cookie_opts(),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False)
    except Exception as e:
        log.warning("search failed for q=%r: %s", q, e)
        raise

    entries = (info or {}).get("entries") or []
    results = [shaped for e in entries if (shaped := _shape_entry(e)) is not None]
    _SEARCH_CACHE.set(cache_key, results)
    return results
