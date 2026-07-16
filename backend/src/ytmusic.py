"""
YouTube Music metadata enrichment.

yt-dlp's scraped `artists`/`creators`/`tags` all carry the *full* credit list —
performers plus songwriters and producers under their government names — and no
field separates them. The YouTube Music internal API (innertube), which
ytmusicapi wraps, exposes the song's `videoDetails.author`: the performing
artists exactly as the app shows them, with the writer credits stripped.

This module looks that string up by video id and parses it into a clean name
list. Everything here is best-effort: any failure (network, parse, missing
client, track not in the YT Music catalog) returns None so callers fall back to
the yt-dlp heuristic. No exception ever escapes.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor

from src import config

log = logging.getLogger(__name__)

# Lazily-built singleton YTMusic client + a lock so concurrent download workers
# don't each construct one. A failed construction is cached as a sentinel so we
# don't retry the (slow) import/handshake on every track once it's broken.
_client = None
_client_tried = False
_lock = threading.Lock()

# Author strings join performers with commas, ampersands, "x", and a trailing
# "& Name" (e.g. "Ysy A, Xina Mora, & ONIRIA"). Split on all of them.
_SPLIT_RE = re.compile(r"\s*(?:,|&|/|\bx\b|·|;)\s*", re.IGNORECASE)


def _get_client():
    """Build (once) and return the YTMusic client, or None if unavailable."""
    global _client, _client_tried
    if _client_tried:
        return _client
    with _lock:
        if _client_tried:
            return _client
        _client_tried = True
        try:
            from ytmusicapi import YTMusic

            _client = YTMusic()
        except Exception as e:  # import error, network, etc.
            log.warning("ytmusicapi client unavailable: %s", e)
            _client = None
        return _client


def _parse_author(author: str) -> list[str]:
    """Split a YT Music author string into trimmed, de-duped performer names."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in _SPLIT_RE.split(author or ""):
        name = raw.strip().strip("&").strip()
        if not name:
            continue
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(name)
    return out


def clean_artists(video_id: str) -> list[str] | None:
    """Return the performing artists for a YT Music video id, or None.

    None means "no clean answer" — disabled by config, no client, the track
    isn't in YT Music, or any error — and the caller should keep its yt-dlp
    value. A non-empty list is the trustworthy performer set."""
    if not config.YTMUSIC_ENABLED or not video_id:
        return None
    client = _get_client()
    if client is None:
        return None
    try:
        song = client.get_song(video_id)
        author = (song.get("videoDetails") or {}).get("author") or ""
    except Exception as e:
        log.debug("ytmusic get_song failed for %s: %s", video_id, e)
        return None
    names = _parse_author(author)
    return names or None


def square_cover(video_id: str, size: int = 1080) -> "str | None":
    """Return a square album-cover URL for a YT Music track, or None.

    The stored thumbnail is the 16:9 video frame, which a square notification /
    now-playing slot crops awkwardly. YT Music exposes proper square art on
    yt3.googleusercontent.com; we take the largest and bump its size param to
    `size`. Best-effort: never raises."""
    if not config.YTMUSIC_ENABLED or not video_id:
        return None
    client = _get_client()
    if client is None:
        return None
    try:
        song = client.get_song(video_id)
        thumbs = (
            (song.get("videoDetails") or {}).get("thumbnail", {}).get("thumbnails") or []
        )
    except Exception as e:
        log.debug("ytmusic cover lookup failed for %s: %s", video_id, e)
        return None
    square = [t for t in thumbs if t.get("url") and t.get("width") == t.get("height")]
    if not square:
        return None
    url = square[-1]["url"]
    # Bump the googleusercontent size param (=w544-h544-…) to the requested size.
    return re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url)


# ── "Radio" suggestions (YT Music watch playlist) ─────────────────────────────
# yt-dlp's RD<id> mix (search.related) surfaces whatever YouTube would autoplay
# next — mostly *official music videos* (VEVO/OMV) and the odd reupload. YT
# Music's own radio (get_watch_playlist) returns catalog tracks: the audio (ATV,
# "- Topic") versions, with clean artist credits and square art. The
# "suggestions for you" feed seeds from this so it shows the music, not the clip.

_RADIO_TTL_SEC = 900
_radio_cache: dict[str, tuple[list[dict], float]] = {}
_radio_cache_lock = threading.Lock()

# Song search feeds the catalog's "found on youtube" results. Users re-type the
# same prefixes, so a short TTL kills the duplicate round-trips.
_SONG_SEARCH_TTL_SEC = 300
_song_search_cache: dict[str, tuple[list[dict], float]] = {}
_song_search_lock = threading.Lock()


def _parse_length(text: str | None) -> int | None:
    """'3:45' / '1:02:03' → seconds; None on anything unparseable."""
    if not text:
        return None
    try:
        nums = [int(p) for p in text.split(":")]
    except ValueError:
        return None
    secs = 0
    for p in nums:
        secs = secs * 60 + p
    return secs or None


def radio(video_id: str, limit: int = 25) -> list[dict]:
    """YT Music radio for a seed video id, as external-candidate dicts (the
    discovery `_external_item` shape: video_id/title/artist/thumbnail_url/
    duration_sec/source_url).

    Returns the tracks YouTube Music would queue after the seed — the audio (ATV)
    versions, not the official videoclips yt-dlp's RD mix returns. UGC reuploads
    are dropped and audio tracks are ordered ahead of music videos, so the caller
    surfaces the music version first. Best-effort: [] on any failure (disabled by
    config, no client, seed not in YT Music, network)."""
    if not config.YTMUSIC_ENABLED or not video_id:
        return []
    now = time.time()
    with _radio_cache_lock:
        hit = _radio_cache.get(video_id)
        if hit is not None and now - hit[1] <= _RADIO_TTL_SEC:
            return hit[0]
    client = _get_client()
    if client is None:
        return []
    try:
        data = client.get_watch_playlist(videoId=video_id, radio=True, limit=limit)
        tracks = (data or {}).get("tracks") or []
    except Exception as e:
        log.debug("ytmusic radio failed for %s: %s", video_id, e)
        return []

    scored: list[tuple[int, dict]] = []
    for t in tracks:
        vid = t.get("videoId")
        if not vid or vid == video_id:
            continue
        vtype = t.get("videoType") or ""
        if "UGC" in vtype:
            continue  # random user reupload — not a catalog track
        artists = [a.get("name") for a in (t.get("artists") or []) if a.get("name")]
        thumbs = t.get("thumbnail") or []
        item = {
            "video_id": vid,
            "title": t.get("title"),
            "artist": ", ".join(artists) or None,
            "thumbnail_url": thumbs[-1].get("url") if thumbs else None,
            "duration_sec": _parse_length(t.get("length")),
            "source_url": f"https://www.youtube.com/watch?v={vid}",
        }
        # Prefer the audio track (ATV) over the official music video (OMV).
        scored.append((0 if "ATV" in vtype else 1, item))

    # Stable sort keeps radio (relevance) order within each group; just floats the
    # audio versions above the videoclips.
    scored.sort(key=lambda s: s[0])
    results = [it for _, it in scored]
    with _radio_cache_lock:
        _radio_cache[video_id] = (results, now)
        if len(_radio_cache) > 256:  # bound the map on the long-lived process
            oldest = min(_radio_cache, key=lambda k: _radio_cache[k][1])
            _radio_cache.pop(oldest, None)
    return results


def radio_many(video_ids: list[str], limit: int = 25) -> dict[str, list[dict]]:
    """radio() for several seeds concurrently → {video_id: candidates}. Mirrors
    search.related_many so a cold suggestions request overlaps the round-trips
    instead of paying them serially. Per-seed failures degrade to []."""
    ids = [v for v in dict.fromkeys(video_ids) if v]
    if not ids or not config.YTMUSIC_ENABLED:
        return {}

    def _one(vid: str) -> tuple[str, list[dict]]:
        try:
            return vid, radio(vid, limit=limit)
        except Exception:
            log.debug("ytmusic radio failed for %r", vid, exc_info=True)
            return vid, []

    out: dict[str, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=min(4, len(ids))) as ex:
        for vid, res in ex.map(_one, ids):
            out[vid] = res
    return out


def search_songs(q: str, limit: int = 12) -> list[dict]:
    """YouTube Music song search → raw candidate dicts in the *same shape as
    `search.search()`* (i.e. `search._shape_entry` output), so the discover feed
    can use it as a drop-in, cleaner source than plain YouTube.

    The `songs` filter returns real music tracks with artist/duration/album — no
    videoclips, lyric videos, live sets or non-music — where a bare `ytsearch`
    returns everything. Best-effort: `[]` when disabled, no client, or on any
    error, so the caller can fall back to plain YouTube search."""
    q = (q or "").strip()
    if not config.YTMUSIC_ENABLED or not q:
        return []
    limit = max(1, min(limit, 40))

    now = time.time()
    key = f"{limit}:{q.lower()}"
    with _song_search_lock:
        hit = _song_search_cache.get(key)
        if hit is not None and now - hit[1] <= _SONG_SEARCH_TTL_SEC:
            return hit[0]

    client = _get_client()
    if client is None:
        return []
    try:
        results = client.search(q, filter="songs", limit=limit)
    except Exception as e:
        log.debug("ytmusic song search failed for %r: %s", q, e)
        return []

    out: list[dict] = []
    for r in results or []:
        vid = r.get("videoId")
        if not vid:
            continue
        artists = [a.get("name") for a in (r.get("artists") or []) if a.get("name")]
        thumbs = r.get("thumbnails") or []
        out.append({
            "id": vid,
            "title": r.get("title"),
            "channel": ", ".join(artists) or None,
            "channel_url": None,
            "thumbnail": thumbs[-1].get("url") if thumbs else None,
            "duration_seconds": r.get("duration_seconds") or _parse_length(r.get("duration")),
            "view_count": None,
            # Plain watch URL — the download flow resolves it like any other.
            "url": f"https://www.youtube.com/watch?v={vid}",
        })

    with _song_search_lock:
        _song_search_cache[key] = (out, now)
        if len(_song_search_cache) > 256:  # bound the map on the long-lived process
            oldest = min(_song_search_cache, key=lambda k: _song_search_cache[k][1])
            _song_search_cache.pop(oldest, None)
    return out


# ── Spotify → YT Music matching ───────────────────────────────────────────────
# Spotify hands us {artist, title, duration} but no audio (DRM). We re-find each
# song on YT Music and download that. The hard part is rejecting wrong matches:
# a search for a song YT Music doesn't have still returns *something*, so taking
# the first result would download the wrong track. We score candidates and only
# accept a confident one — duration is the strongest signal (the same recording
# is always within a few seconds), backed by title + artist token overlap.

_DUR_HARD_LIMIT_SEC = 20   # reject a candidate further than this from Spotify's
_MIN_TITLE_SIM = 0.45      # query-vs-candidate title token overlap floor
_MIN_ARTIST_SIM = 0.30     # query-vs-candidate artist token overlap floor


def _norm(s: str) -> str:
    """Lowercase, strip accents, drop bracketed asides / feat-tails and
    punctuation — so 'Tú Me Dejaste (Remaster)' ≈ 'tu me dejaste'."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode()
    s = s.lower()
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    s = re.sub(r"\b(feat|ft|with|prod)\b.*", " ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(s.split())


def _coverage(query: str, text: str) -> float:
    """Directional token coverage: what fraction of `query`'s tokens appear in
    `text` (0..1). Asymmetric on purpose — a Spotify primary artist ('C.
    Tangana') must be *contained* in YT Music's fuller credit ('C. Tangana, Niño
    de Elche, La Hungara') without the extra featured names diluting the score."""
    q, t = set(_norm(query).split()), set(_norm(text).split())
    if not q or not t:
        return 0.0
    return len(q & t) / len(q)


class Match:
    """A scored YT Music candidate for a Spotify track."""

    def __init__(self, video_id: str, title: str, artists: str, duration: "int | None", score: float):
        self.video_id = video_id
        self.title = title
        self.artists = artists
        self.duration = duration
        self.score = score


def search_match(
    artist: str, title: str, duration_sec: "int | None" = None
) -> "Match | None":
    """Find the best-matching YT Music song for a Spotify track, or None when no
    candidate is confident enough (so the caller can flag it 'no match' rather
    than download the wrong song). Best-effort: never raises."""
    if not config.YTMUSIC_ENABLED:
        return None
    client = _get_client()
    if client is None:
        return None
    query = f"{artist} {title}".strip()
    try:
        results = client.search(query, filter="songs", limit=5)
    except Exception as e:
        log.debug("ytmusic search failed for %r: %s", query, e)
        return None

    best: "Match | None" = None
    for r in results or []:
        vid = r.get("videoId")
        if not vid:
            continue
        cand_title = r.get("title") or ""
        cand_artists = ", ".join(a.get("name", "") for a in (r.get("artists") or []))
        cand_dur = r.get("duration_seconds")

        title_sim = _coverage(title, cand_title)
        artist_sim = _coverage(artist, cand_artists)
        if title_sim < _MIN_TITLE_SIM:
            continue
        # Gate on the artist only when one was supplied — bare query lines (no
        # "Artist - Title") lean on title + duration alone.
        if artist and artist_sim < _MIN_ARTIST_SIM:
            continue
        if duration_sec and cand_dur and abs(cand_dur - duration_sec) > _DUR_HARD_LIMIT_SEC:
            continue

        # Duration proximity dominates (0 = exact); title/artist break ties.
        dur_pen = (
            abs(cand_dur - duration_sec) * 0.03
            if (duration_sec and cand_dur)
            else 0.0
        )
        score = title_sim + 0.5 * artist_sim - dur_pen
        if best is None or score > best.score:
            best = Match(vid, cand_title, cand_artists, cand_dur, score)
    return best
