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
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import quote

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
# Mixes barely shift over a session and each call is a 1-3s yt-dlp round-trip,
# so cache them longer than plain searches.
_RELATED_CACHE = _TTLCache(ttl_seconds=900)
# Album search fans out one yt-dlp call per album just to fetch its title/cover,
# so it's the slowest endpoint — cache results (and individual albums) for long.
_ALBUM_SEARCH_CACHE = _TTLCache(ttl_seconds=1800)
_ALBUM_CACHE = _TTLCache(ttl_seconds=1800)


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


def related(video_id: str, limit: int = 20) -> list[dict]:
    """
    Return the YouTube Mix ("radio") for a video — the related tracks YouTube
    would auto-queue after it. Implemented as a flat extraction of the RD<id>
    auto-playlist, so it's the same cheap listing-level fetch as search().

    The seed video itself is filtered out. Best-effort: returns an empty list
    on any failure rather than raising, since this feeds at-rest suggestions,
    not a user-initiated action.
    """
    video_id = (video_id or "").strip()
    if not video_id:
        return []
    limit = max(1, min(limit, 50))

    cached = _RELATED_CACHE.get(video_id)
    if cached is not None:
        return cached

    # RD<id> is YouTube's deterministic "start a radio from this video" mix.
    mix_url = f"https://www.youtube.com/watch?v={video_id}&list=RD{video_id}"
    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "extract_flat": "in_playlist",
        "skip_download": True,
        "ignore_no_formats_error": True,
        # +1 leaves room to drop the seed without coming up short.
        "playlist_items": f"1-{limit + 1}",
        **_get_cookie_opts(),
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(mix_url, download=False)
    except Exception as e:
        log.warning("related failed for video_id=%r: %s", video_id, e)
        return []

    entries = (info or {}).get("entries") or []
    results = [
        shaped
        for e in entries
        if (shaped := _shape_entry(e)) is not None and shaped["id"] != video_id
    ]
    _RELATED_CACHE.set(video_id, results)
    return results


# ── Albums (YouTube Music) ────────────────────────────────────────────────────
# YouTube Music models an album as a browse page (id `MPREb…`) or a playlist
# (id `OLAK5uy_…`), both of which yt-dlp extracts as a normal playlist of the
# album's tracks. Album *search* is the `#albums` filter on the YTM search URL —
# it returns album browse ids with no titles, so we fetch each album's metadata
# (title/cover/artist) with a second flat extraction, fanned out across threads.

_ALBUM_TITLE_PREFIXES = ("Album - ", "Single - ", "EP - ", "Playlist - ")


def _is_album_id(vid: str) -> bool:
    return vid.startswith("MPREb") or vid.startswith("OLAK5uy_")


def album_browse_url(album_id: str) -> str:
    """Canonical URL yt-dlp resolves into the album's track playlist. Also what
    the frontend hands to the playlist-download flow to grab the whole album."""
    if album_id.startswith("OLAK5uy_"):
        return f"https://music.youtube.com/playlist?list={album_id}"
    return f"https://music.youtube.com/browse/{album_id}"


def _strip_album_prefix(title: str | None) -> str | None:
    if not title:
        return title
    for p in _ALBUM_TITLE_PREFIXES:
        if title.startswith(p):
            return title[len(p):].strip() or title
    return title


def _entry_thumb(entry: dict) -> str | None:
    thumb = entry.get("thumbnail")
    if not thumb:
        thumbs = entry.get("thumbnails") or []
        if thumbs:
            thumb = thumbs[-1].get("url")
    vid = entry.get("id")
    if not thumb and vid:
        # i.ytimg always has a thumbnail for a real video id — reliable fallback.
        thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return thumb


def _extract_album_raw(album_id: str) -> dict | None:
    """Flat-extract an album's track playlist. Returns the raw yt-dlp info."""
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
            return ydl.extract_info(album_browse_url(album_id), download=False)
    except Exception as e:
        log.warning("album extract failed for %r: %s", album_id, e)
        return None


def _album_header(album_id: str, info: dict, entries: list[dict]) -> dict:
    first = entries[0] if entries else {}
    return {
        "album_id": album_id,
        "title": _strip_album_prefix(info.get("title")),
        "artist": first.get("channel") or first.get("uploader") or first.get("artist"),
        "thumbnail": _entry_thumb(first) if entries else info.get("thumbnail"),
        "track_count": info.get("playlist_count") or len(entries),
        "url": album_browse_url(album_id),
    }


def _album_card(album_id: str) -> dict | None:
    """Lightweight album summary (header only) for the search grid."""
    info = _extract_album_raw(album_id)
    if not info:
        return None
    entries = [e for e in (info.get("entries") or []) if e and e.get("id")]
    if not entries:
        return None
    return _album_header(album_id, info, entries)


def search_albums(q: str, limit: int = 12) -> list[dict]:
    """Search YouTube Music for albums matching `q`.

    Two-stage: the `#albums` search filter yields album browse ids (no titles in
    flat mode), then each album's title/cover/artist is fetched concurrently.
    Best-effort and heavily cached — returns [] on any upstream failure.
    """
    q = q.strip()
    if not q:
        return []
    limit = max(1, min(limit, 16))

    cache_key = f"{limit}:{q.lower()}"
    cached = _ALBUM_SEARCH_CACHE.get(cache_key)
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
    url = f"https://music.youtube.com/search?q={quote(q)}#albums"
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as e:
        log.warning("album search failed for q=%r: %s", q, e)
        return []

    album_ids: list[str] = []
    for e in (info or {}).get("entries") or []:
        if not e:
            continue
        vid = e.get("id") or ""
        if _is_album_id(vid) and vid not in album_ids:
            album_ids.append(vid)
        if len(album_ids) >= limit:
            break

    if not album_ids:
        _ALBUM_SEARCH_CACHE.set(cache_key, [])
        return []

    def _safe(aid: str) -> dict | None:
        try:
            return _album_card(aid)
        except Exception:
            log.warning("album card failed for %r", aid, exc_info=True)
            return None

    with ThreadPoolExecutor(max_workers=6) as ex:
        cards = [c for c in ex.map(_safe, album_ids) if c]

    _ALBUM_SEARCH_CACHE.set(cache_key, cards)
    return cards


def get_album(album_id: str) -> dict | None:
    """Full album: header + the ordered tracklist (shaped like search results)."""
    album_id = (album_id or "").strip()
    if not album_id:
        return None

    cached = _ALBUM_CACHE.get(album_id)
    if cached is not None:
        return cached

    info = _extract_album_raw(album_id)
    if not info:
        return None
    entries = [e for e in (info.get("entries") or []) if e and e.get("id")]
    tracks = [shaped for e in entries if (shaped := _shape_entry(e)) is not None]

    result = {**_album_header(album_id, info, entries), "tracks": tracks}
    _ALBUM_CACHE.set(album_id, result)
    return result
