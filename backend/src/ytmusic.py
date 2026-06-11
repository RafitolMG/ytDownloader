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
