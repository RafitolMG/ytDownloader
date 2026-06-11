"""
Resolve a "wishlist" — a public Spotify playlist link OR a pasted track list —
into (artist, title, duration) rows. The importer then re-finds each on YouTube
Music (`ytmusic.search_match`) and downloads it; Spotify itself serves no audio.

No Spotify credentials needed:
  - A public playlist's tracks are read from the embed player's bootstrap JSON
    (open.spotify.com/embed/playlist/{id}). That endpoint caps at the first
    ~100 tracks, so bigger imports should paste a list/CSV instead.
  - A pasted list is parsed as either an Exportify-style CSV (Track Name /
    Artist Name(s) / Duration columns) or plain "Artist - Title" lines —
    unlimited length.
"""
from __future__ import annotations

import csv
import io
import json
import logging
import re
from dataclasses import dataclass

import httpx

log = logging.getLogger(__name__)

EMBED_TRACK_CAP = 100  # Spotify's embed bootstrap only carries the first ~100.

_PLAYLIST_RE = re.compile(r"(?:playlist[/:])([A-Za-z0-9]{22})")
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S
)
# Common "Artist - Title" separators (hyphen, en/em dash).
_LINE_SEP_RE = re.compile(r"\s+[-–—]\s+")


class TrackListError(Exception):
    """Raised on bad input / fetch failure so the importer can report cleanly."""


@dataclass(frozen=True)
class WantedTrack:
    artist: str          # may be "" for a bare free-text query line
    title: str
    duration_sec: int | None


@dataclass(frozen=True)
class WishList:
    name: str
    tracks: list[WantedTrack]
    capped: bool          # True when a playlist had more than we could read


def parse_playlist_id(url_or_id: str) -> str | None:
    """Extract a playlist id from an open.spotify.com URL, spotify: URI, or a
    bare 22-char id. None when nothing playlist-shaped is found."""
    s = (url_or_id or "").strip()
    m = _PLAYLIST_RE.search(s)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9]{22}", s):
        return s
    return None


def looks_like_playlist_link(text: str) -> bool:
    """True when the whole input is a single Spotify playlist reference (vs a
    pasted multi-line list)."""
    s = (text or "").strip()
    return "\n" not in s and parse_playlist_id(s) is not None


# ── Spotify embed (public playlist, no auth) ──────────────────────────────────

def _find_track_list(node) -> list | None:
    """Depth-first search for the embed state's `trackList` array."""
    if isinstance(node, dict):
        tl = node.get("trackList")
        if isinstance(tl, list):
            return tl
        for v in node.values():
            found = _find_track_list(v)
            if found is not None:
                return found
    elif isinstance(node, list):
        for v in node:
            found = _find_track_list(v)
            if found is not None:
                return found
    return None


def from_spotify_url(url_or_id: str) -> WishList:
    """Read a public playlist's name + first ~100 tracks via the embed player."""
    pid = parse_playlist_id(url_or_id)
    if not pid:
        raise TrackListError("That doesn't look like a Spotify playlist link")
    try:
        r = httpx.get(
            f"https://open.spotify.com/embed/playlist/{pid}",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=20,
            follow_redirects=True,
        )
    except httpx.HTTPError as e:
        raise TrackListError(f"Couldn't reach Spotify: {e}") from e
    if r.status_code == 404:
        raise TrackListError("Playlist not found — is it public?")
    if r.status_code != 200:
        raise TrackListError(f"Spotify returned HTTP {r.status_code}")

    m = _NEXT_DATA_RE.search(r.text)
    if not m:
        raise TrackListError("Couldn't read the playlist (Spotify changed its page)")
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError as e:
        raise TrackListError("Couldn't parse the playlist data") from e

    entity = (((data.get("props") or {}).get("pageProps") or {}).get("state") or {}).get("data") or {}
    name = (entity.get("entity") or {}).get("name") or "Spotify playlist"
    raw = _find_track_list(data) or []

    tracks: list[WantedTrack] = []
    for t in raw:
        title = (t or {}).get("title")
        artist = (t or {}).get("subtitle") or ""
        if not title:
            continue
        dur_ms = t.get("duration")
        tracks.append(
            WantedTrack(
                artist=artist.strip(),
                title=title.strip(),
                duration_sec=round(dur_ms / 1000) if dur_ms else None,
            )
        )
    if not tracks:
        raise TrackListError("That playlist looks empty or private")
    return WishList(name=name, tracks=tracks, capped=len(tracks) >= EMBED_TRACK_CAP)


# ── Pasted list / CSV ─────────────────────────────────────────────────────────

def _csv_columns(header: list[str]) -> "tuple[int, int, int | None] | None":
    """Locate (title, artist, duration_ms?) column indices in a CSV header.
    Tolerant of Exportify's exact labels and common variants."""
    low = [h.strip().lower() for h in header]

    def find(*names):
        for n in names:
            if n in low:
                return low.index(n)
        return None

    ti = find("track name", "title", "name", "track")
    ai = find("artist name(s)", "artist name", "artist", "artists")
    di = find("duration (ms)", "duration ms", "duration_ms")
    if ti is None or ai is None:
        return None
    return ti, ai, di


def from_text(text: str) -> WishList:
    """Parse a pasted list — Exportify CSV or plain 'Artist - Title' lines."""
    body = (text or "").strip()
    if not body:
        raise TrackListError("Nothing to import — paste a list or a Spotify link")

    tracks: list[WantedTrack] = []

    # Try CSV first: needs a header row with recognisable Track/Artist columns.
    try:
        rows = list(csv.reader(io.StringIO(body)))
    except csv.Error:
        rows = []
    cols = _csv_columns(rows[0]) if rows and len(rows[0]) > 1 else None
    if cols:
        ti, ai, di = cols
        for row in rows[1:]:
            if len(row) <= max(ti, ai):
                continue
            title = (row[ti] or "").strip()
            artist = (row[ai] or "").strip()
            if not title:
                continue
            dur = None
            if di is not None and di < len(row):
                raw = (row[di] or "").strip()
                if raw.isdigit():
                    dur = round(int(raw) / 1000)
            tracks.append(WantedTrack(artist=artist, title=title, duration_sec=dur))
    else:
        # Plain lines: "Artist - Title". A line without a separator becomes a
        # bare query (artist="") — the matcher then leans on title + duration.
        for line in body.splitlines():
            line = line.strip()
            if not line:
                continue
            parts = _LINE_SEP_RE.split(line, maxsplit=1)
            if len(parts) == 2:
                tracks.append(
                    WantedTrack(artist=parts[0].strip(), title=parts[1].strip(), duration_sec=None)
                )
            else:
                tracks.append(WantedTrack(artist="", title=line, duration_sec=None))

    if not tracks:
        raise TrackListError("Couldn't find any tracks in that list")
    return WishList(name="Imported list", tracks=tracks, capped=False)


def resolve(source: str) -> WishList:
    """Top-level: a single Spotify playlist link → embed; anything else → list."""
    return from_spotify_url(source) if looks_like_playlist_link(source) else from_text(source)
