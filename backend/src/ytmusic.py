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
import unicodedata

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
