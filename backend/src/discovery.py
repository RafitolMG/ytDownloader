"""
Discovery / recommendation logic: the hybrid search feed, the fuzzy
"same song, different upload" dedup, and the daily-mix scoring algorithm.

Extracted from the route layer so the dense, db-backed but request-independent
recommendation code lives on its own (and can be exercised directly). The route
handlers in api/routes.py import these names and call into them; nothing here
touches the request/job runtime.
"""
from __future__ import annotations

import copy
import hashlib
import re
import threading
import traceback
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from typing import Iterable

from src import db, search as search_mod, ytmusic
from src.auth import CurrentUser


MAX_ARTIST_SHARE = 0.35      # ceiling on one artist's share of a mix
_ANCHOR_BOOST = 1.0          # track credits the anchor
_NEIGHBOR_BOOST = 0.45       # track shares a credit row with the anchor (collab graph)
_PLAYLIST_NEIGHBOR_BOOST = 0.35  # track's artist co-occurs with the anchor on a playlist
_AFFINITY_WEIGHT = 0.5       # × the user's normalized play affinity for the artist
_POPULARITY_WEIGHT = 0.1     # × normalized owner_count (cold-start tie-breaker)
_PLAY_WEIGHT = 0.3           # × normalized recent play count for the exact track
_JITTER_WEIGHT = 0.25        # × deterministic per-(day, mix, track) jitter

# How far back "recent" plays count as the current-taste signal. Recommendations
# blend this window's plays (falling back to all-time when the window is empty) so
# they track what the user listens to *now*, not their lifetime history.
_RECENCY_WINDOW_DAYS = 90


def _recency_since(days: int = _RECENCY_WINDOW_DAYS) -> str:
    """ISO lower bound for the recent-play window, matching db._now()'s format so
    the string compares lexicographically against stored played_at values."""
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")


def _artist_members(credit: str | None) -> list[str]:
    """Split a ", "-joined credit string into individual artist names (a collab
    stores every name in one `tracks.artist` row)."""
    return [m.strip() for m in (credit or "").split(",") if m.strip()]


def _jitter(day_seed: int, mix_i: int, video_id: str) -> float:
    """Stable pseudo-random value in [0, 1) for a (day, mix, track) triple.
    blake2b — not hash() — because Python salts str hashing per process, which
    would make today's mixes non-reproducible within the day."""
    h = hashlib.blake2b(f"{day_seed}:{mix_i}:{video_id}".encode(), digest_size=8)
    return int.from_bytes(h.digest(), "big") / 2**64


def _unit_hash(*parts: object) -> float:
    """Stable pseudo-random float in [0, 1) for an arbitrary key tuple. Same
    reasoning as `_jitter` (blake2b, not hash(), to survive per-process str-hash
    salting) but generalized for the rotation samplers below."""
    key = ":".join(str(p) for p in parts)
    h = hashlib.blake2b(key.encode(), digest_size=8)
    return int.from_bytes(h.digest(), "big") / 2**64


# ── Rotating recommendation seeds ────────────────────────────────────────────
# The suggestions carousel and the "more like this" radio each take a client
# `nonce` (refresh counter) that re-rolls the picks reproducibly. Weighting is
# Efraimidis-Spirakis sampling-without-replacement: key = u**(1/weight).

_SEED_POOL_POPULAR = 200     # candidate seeds pulled by owner_count
_SEED_POOL_RECENT = 120      # candidate seeds pulled by recency (fresh material)
_SEED_FAMILIAR_LIMIT = 50    # how many of the viewer's top plays to down-weight
_SEED_FAMILIAR_PENALTY = 0.35  # × weight for already-worn-out ("less-played" bias)
_SEED_W_BASE = 0.5           # floor so even a cold track can be sampled
_SEED_W_POP = 1.0            # × normalized owner_count
_SEED_W_RECENT = 1.0         # × recency (newest = 1, older = 0)
_SEED_ARTIST_CAP = 2         # max seeds sharing a primary artist (diversity)
_SEED_POSITIVE_SLOTS = 3     # seeds reserved for the viewer's actual top plays


def _es_sample(scored: list[tuple[float, str, str]], count: int,
               picked: list[str], per_artist: dict[str, int]) -> None:
    """Efraimidis-Spirakis pick: append video_ids from `scored` (already
    (draw_key, video_id, primary_artist) tuples) into `picked`, honoring the
    per-artist cap and skipping ids already picked, until `picked` reaches
    `count`. Mutates `picked`/`per_artist` in place so it can run in phases."""
    seen = set(picked)
    for _key, vid, primary in sorted(scored, key=lambda t: (t[0], t[1]), reverse=True):
        if len(picked) >= count:
            break
        if vid in seen:
            continue
        if primary and per_artist.get(primary, 0) >= _SEED_ARTIST_CAP:
            continue
        picked.append(vid)
        seen.add(vid)
        per_artist[primary] = per_artist.get(primary, 0) + 1


def weighted_seed_ids(viewer_id: str, *, count: int = 8, nonce: int = 0) -> list[str]:
    """Pick `count` seed video_ids for the suggestion radios, biased toward the
    viewer's taste while staying varied instead of always taking the top-N popular.

    Two phases:
      1. Positive taste seeds — a few slots reserved for the viewer's actual
         most-played tracks (recent window, all-time fallback), sampled weighted
         by play count. This makes suggestions lean on what they love instead of
         only using play history as a penalty.
      2. Variety seeds — fill the rest from the popular + recently-added pool with
         the existing less-played bias (owner_count + recency, the viewer's top
         plays penalized so worn-out material doesn't dominate).

    Both phases share one per-(day, nonce, video_id) jitter so a client ↻ refresh
    re-rolls reproducibly (the day component also drifts the default nonce=0 pick
    day to day), one artist cap, and one dedup set.

    Returns [] on a cold/empty catalog (caller decides the fallback)."""
    popular = db.popular_catalog(viewer_id, _SEED_POOL_POPULAR)
    if not popular:
        return []
    recent = db.list_catalog(viewer_id, sort="newest", limit=_SEED_POOL_RECENT)
    since = _recency_since()
    top_played = (
        db.top_played_tracks(viewer_id, limit=_SEED_FAMILIAR_LIMIT, since=since)
        or db.top_played_tracks(viewer_id, limit=_SEED_FAMILIAR_LIMIT)
    )
    familiar = {t["video_id"] for t in top_played}

    day_seed = int(datetime.now(timezone.utc).strftime("%Y%m%d"))

    picked: list[str] = []
    per_artist: dict[str, int] = {}

    # ── Phase 1: positive taste seeds ─────────────────────────────────────────
    max_pc = max((t.get("play_count") or 0) for t in top_played) or 1
    positive: list[tuple[float, str, str]] = []
    for t in top_played:
        vid = t["video_id"]
        weight = _SEED_W_BASE + (t.get("play_count") or 0) / max_pc
        u = _unit_hash(day_seed, nonce, "pos", vid)
        primary = next(iter(_artist_members(t.get("artist"))), "").lower()
        positive.append((u ** (1.0 / max(weight, 1e-6)), vid, primary))
    _es_sample(positive, min(_SEED_POSITIVE_SLOTS, count), picked, per_artist)

    # ── Phase 2: variety seeds from the popular + recent pool ──────────────────
    max_owner = max((c.get("owner_count") or 0) for c in popular) or 1
    recent_rank = {c["video_id"]: i for i, c in enumerate(recent)}
    n_recent = max(len(recent), 1)
    candidates: dict[str, dict] = {}
    for row in (*popular, *recent):
        candidates.setdefault(row["video_id"], row)

    variety: list[tuple[float, str, str]] = []
    for vid, row in candidates.items():
        pop_norm = (row.get("owner_count") or 0) / max_owner
        rank = recent_rank.get(vid)
        rec_norm = 0.0 if rank is None else 1.0 - rank / n_recent
        weight = _SEED_W_BASE + _SEED_W_POP * pop_norm + _SEED_W_RECENT * rec_norm
        if vid in familiar:
            weight *= _SEED_FAMILIAR_PENALTY
        u = _unit_hash(day_seed, nonce, vid)
        primary = next(iter(_artist_members(row.get("artist"))), "").lower()
        variety.append((u ** (1.0 / max(weight, 1e-6)), vid, primary))
    _es_sample(variety, count, picked, per_artist)

    return picked


def rotate_pick(
    ranked_items: list[tuple[int, dict]], count: int, *, nonce: int = 0,
    rank_falloff: float = 12.0, exclude: "set[str] | None" = None,
) -> list[dict]:
    """Pick `count` items from a relevance-ranked `(rank, item)` list, favoring
    the most-related while re-rolling per `nonce` so a ↻ refresh surfaces
    different picks. `rank_falloff` sets how fast relevance weight decays with
    rank (weight = falloff/(rank+falloff): 1.0 at rank 0). Each item must carry a
    'video_id'. Order of the return is by draw key (already rotated).

    `exclude` is a set of video_ids shown in recent rolls: they're held back so a
    ↻ surfaces fresh picks, and only drawn on if the fresh pool can't fill `count`
    (so a small pool never yields an empty roll)."""
    if count <= 0 or not ranked_items:
        return []
    exclude = exclude or set()

    def draw(items: list[tuple[int, dict]]) -> list[dict]:
        scored: list[tuple[float, dict]] = []
        for rank, item in items:
            weight = rank_falloff / (rank + rank_falloff)
            u = _unit_hash(nonce, item.get("video_id"))
            scored.append((u ** (1.0 / max(weight, 1e-6)), item))
        scored.sort(key=lambda t: t[0], reverse=True)
        return [item for _key, item in scored]

    fresh = [ri for ri in ranked_items if ri[1].get("video_id") not in exclude]
    picked = draw(fresh)[:count]
    if len(picked) < count:  # exclusion window drained the pool — relax
        have = {it.get("video_id") for it in picked}
        stale = [
            ri for ri in ranked_items
            if ri[1].get("video_id") in exclude and ri[1].get("video_id") not in have
        ]
        picked += draw(stale)[: count - len(picked)]
    return picked


# ── Cross-refresh memory ──────────────────────────────────────────────────────
# Each ↻ is an independent weighted draw over the same candidate pool, so
# consecutive rolls can resurface the same items. We remember the video_ids shown
# in the last few rolls per (user, surface) and hold them back from a *newer*
# roll — until the pool is exhausted, at which point callers relax so a roll is
# never starved. Determinism per nonce holds: the exclusion for nonce N is the
# union of the shown sets of the earlier nonces still in the window, stable as the
# client increments N. Bounded and in-memory, like the radio / lineup caches.

_ROLL_MEMORY_DEPTH = 6   # how many recent rolls to remember per (user, surface)
_roll_memory: "dict[tuple[str, str], OrderedDict[int, frozenset[str]]]" = {}
_roll_lock = threading.Lock()


def roll_exclusions(user_id: str, surface: str, nonce: int) -> set[str]:
    """video_ids shown in remembered rolls *older* than `nonce` — the set a new
    roll should hold back. Empty for the initial load (nonce 0) or an unseen
    surface."""
    if nonce <= 0:
        return set()
    with _roll_lock:
        hist = _roll_memory.get((user_id, surface))
        if not hist:
            return set()
        out: set[str] = set()
        for n, ids in hist.items():
            if n < nonce:
                out |= ids
    return out


def record_roll(user_id: str, surface: str, nonce: int, video_ids: Iterable[str]) -> None:
    """Remember the ids a roll surfaced, capped to the last `_ROLL_MEMORY_DEPTH`
    rolls per (user, surface). Idempotent per nonce (re-recording overwrites)."""
    key = (user_id, surface)
    ids = frozenset(v for v in video_ids if v)
    with _roll_lock:
        hist = _roll_memory.get(key)
        if hist is None:
            hist = OrderedDict()
            _roll_memory[key] = hist
        hist[nonce] = ids
        hist.move_to_end(nonce)
        while len(hist) > _ROLL_MEMORY_DEPTH:
            hist.popitem(last=False)


def _scene_clusters(neighbors: dict[str, set[str]], day_seed: int) -> list[list[str]]:
    """Group collaborating artists into "scenes" by deterministic label
    propagation over the co-credit graph — a genre-like clustering *without* genre
    tags (YT Music exposes none per track, so we infer scenes from who records
    together). Node order is rotated by the day so scenes drift day to day; ties
    break on the label string so a given day is reproducible. Returns communities
    of >= 3 artists, largest first — smaller ones are already the single-artist
    mixes, so they're not worth a separate "scene" card."""
    if not neighbors:
        return []
    nodes = sorted(neighbors)
    rot = day_seed % len(nodes)
    nodes = nodes[rot:] + nodes[:rot]
    labels = {a: a for a in nodes}
    for _ in range(6):  # converges fast on a sparse co-credit graph
        changed = False
        for a in nodes:
            tally: dict[str, int] = {}
            for nb in neighbors.get(a, ()):  # neighbours vote their current label
                tally[labels[nb]] = tally.get(labels[nb], 0) + 1
            if not tally:
                continue
            best = max(tally.items(), key=lambda kv: (kv[1], kv[0]))[0]
            if labels[a] != best:
                labels[a] = best
                changed = True
        if not changed:
            break
    comms: dict[str, list[str]] = {}
    for a, lab in labels.items():
        comms.setdefault(lab, []).append(a)
    scenes = [sorted(m) for m in comms.values() if len(m) >= 3]
    scenes.sort(key=len, reverse=True)
    return scenes


def _external_item(entry: dict) -> dict:
    """Shape a yt-dlp flat entry (from search or related) into the external
    candidate dict the frontend renders as a downloadable row/card."""
    return {
        "video_id": entry.get("id"),
        "title": entry.get("title"),
        "artist": entry.get("channel"),
        "thumbnail_url": entry.get("thumbnail"),
        "duration_sec": entry.get("duration_seconds"),
        "source_url": entry.get("url"),
    }


def _is_music_candidate(item: dict, *, strict: bool) -> bool:
    """Best-effort "this is a music track" check on a flat search/related entry.

    The real is_music heuristic needs the full video info (categories, music
    metadata), which flat extraction omits — so we use the strongest signals
    available without a per-video fetch:
      - a "<Artist> - Topic" channel is always music (YouTube Music upload);
      - otherwise fall back to duration. Real songs run ~1-15 min; this cleanly
        drops the hour-long compilation streams, DJ mixes and podcasts that
        dominate generic genre searches, plus sub-minute shorts.

    `strict` (category/search feeds) requires a song-length duration. The
    lenient mode (radio Mixes, already seeded from music) only rejects the
    obvious non-songs so a missing duration still passes.
    """
    artist = (item.get("artist") or "")
    if artist.endswith(" - Topic"):
        return True
    dur = item.get("duration_sec")
    if strict:
        return dur is not None and 60 <= dur <= 900
    return dur is None or 45 <= dur <= 1800


def _owned_signatures(catalog: list[dict]) -> list[tuple[set, set]]:
    """Normalized (title-tokens, artist-tokens) for every owned track, for
    fuzzy "same song, different upload" dedup. The video_id set already catches
    the exact same upload; this catches the *other* YouTube video of a song we
    already have (e.g. an audio-only rip we own resurfacing as the music video,
    which carries a different video_id)."""
    sigs: list[tuple[set, set]] = []
    for it in catalog:
        title_tokens = set(ytmusic._norm(it.get("title") or "").split())
        if not title_tokens:
            continue
        artist_tokens = set(ytmusic._norm(it.get("artist") or "").split())
        sigs.append((title_tokens, artist_tokens))
    return sigs


def _matches_owned(item: dict, owned_sigs: list[tuple[set, set]]) -> bool:
    """True when a YouTube candidate is (fuzzily) a song we already own. The
    candidate's title is a raw YouTube title that usually embeds both the song
    and the artist ('Bad Bunny - Tití Me Preguntó (Video Oficial)'), so we test
    each owned track's title/artist tokens for containment in that blob.

    An owned track counts as a match when ≥80% of its title tokens appear in the
    candidate AND (when we have an artist on file) ≥50% of its artist tokens do —
    enough to catch the same song while letting a *different* song by the same
    artist through."""
    blob = set(
        ytmusic._norm(
            f"{item.get('title') or ''} {item.get('artist') or ''}"
        ).split()
    )
    if not blob:
        return False
    for title_tokens, artist_tokens in owned_sigs:
        if len(title_tokens & blob) / len(title_tokens) < 0.8:
            continue
        if not artist_tokens:
            return True
        if len(artist_tokens & blob) / len(artist_tokens) >= 0.5:
            return True
    return False


# Packaging words that distinguish *uploads* of the same song (the audio rip vs
# the "official video" vs the "lyrics" cut) without changing the recording.
# Stripped before fingerprinting so those variants collapse to one result.
# Version words that DO change the recording — remix, live, acoustic,
# sped/slowed — are deliberately absent, so a genuine alternate version still
# shows as its own candidate.
_TITLE_NOISE = {
    "official", "oficial", "video", "videoclip", "audio", "lyric", "lyrics",
    "letra", "letras", "visualizer", "visualiser", "mv", "hd", "hq", "4k",
    "music", "clip", "subtitulada", "subtitulado", "version",
}


# Words that mark a genuinely different *recording* of a song. ytmusic._norm
# strips parenthesised asides — '(Remix)', '(Acoustic)' — so without this a
# remix would fold into the original. We scan the raw title for these and carry
# them as distinguishing '::'-prefixed marker tokens that must match exactly.
_VERSION_MARKERS = (
    "remix", "acoustic", "live", "instrumental", "cover", "demo",
    "unplugged", "sped up", "slowed", "8d",
)


def _song_fingerprint(item: dict) -> frozenset:
    """Rough identity for a song independent of which YouTube upload it is:
    normalized title tokens minus packaging noise, plus '::'-prefixed markers for
    any alternate-recording keyword in the raw title (so remixes/lives stay
    distinct). The title usually embeds the artist too; the channel ('…VEVO',
    '… - Topic', reupload handles) is too unreliable for externals to fold in."""
    raw = (item.get("title") or "").lower()
    toks = {t for t in ytmusic._norm(raw).split() if t not in _TITLE_NOISE}
    for m in _VERSION_MARKERS:
        if re.search(rf"\b{re.escape(m)}\b", raw):
            toks.add("::" + m.replace(" ", ""))
    return frozenset(toks)


def _same_song(a: frozenset, b: frozenset) -> bool:
    """True when two fingerprints are near-identical — the same song in different
    packaging. Alternate-recording markers must match exactly (an original and
    its remix are NOT the same song); the remaining title tokens must then highly
    overlap, with a 2-token floor so unrelated single-word titles ('Closer' vs
    'Numb') don't collide."""
    ma = {t for t in a if t.startswith("::")}
    mb = {t for t in b if t.startswith("::")}
    if ma != mb:
        return False
    a, b = a - ma, b - mb
    if not a or not b:
        return False
    inter = len(a & b)
    return inter / min(len(a), len(b)) >= 0.85 and (inter >= 2 or a == b)


def _discover_feed(
    user_id: str,
    q_norm: str,
    limit: int,
    external_limit: int,
    *,
    music_only: bool = False,
) -> dict:
    """Shared hybrid feed: catalog matches + YouTube candidates not yet in the
    library. Used by both the search box and the curated category pages.

    Externals are deduped against the catalog matches by video_id. With
    `music_only` (categories), candidates are filtered to song-like tracks and
    we over-fetch to compensate for what the filter drops.
    """
    db_items = db.list_catalog(
        user_id, query=q_norm or None, sort="popular", limit=limit, offset=0,
    )

    externals: list[dict] = []
    # No query → purely local. External search only makes sense when looking
    # for something specific (search box) or a category seed is supplied.
    if q_norm and external_limit > 0:
        known_ids = {it["video_id"] for it in db_items}
        fetch = external_limit + len(known_ids)
        if music_only:
            # Long mixes get dropped, so cast a wider net to still fill the page.
            fetch = min(50, fetch * 3)
        # Prefer YouTube Music (songs only — real tracks with artist/duration, no
        # videoclips or non-music) and fall back to plain YouTube search when YT
        # Music is disabled or comes up empty. Both return the same shape.
        raw = ytmusic.search_songs(q_norm, limit=fetch)
        if not raw:
            try:
                raw = search_mod.search(q_norm, limit=fetch)
            except Exception:
                traceback.print_exc()
                raw = []
        # Some search hits are already in the catalog but didn't match the text
        # query (different stored title/artist). Pull those in as catalog rows
        # so they render as "add to library" (adopt, no re-download) instead of
        # a fresh download row.
        raw_ids = [e.get("id") for e in raw if e.get("id")]
        # list_catalog_by_video_ids returns one row per (video_id, codec, bitrate),
        # so a track owned in two codecs comes back twice. Collapse to one row per
        # video_id (prefer the copy in most libraries, matching _reconcile below)
        # before extending — otherwise the discover feed lists the same song twice.
        already_by_vid: dict[str, dict] = {}
        for it in db.list_catalog_by_video_ids(user_id, raw_ids):
            if it["video_id"] in known_ids:
                continue
            cur = already_by_vid.get(it["video_id"])
            if cur is None or (it.get("owner_count") or 0) > (cur.get("owner_count") or 0):
                already_by_vid[it["video_id"]] = it
        already = list(already_by_vid.values())
        if already:
            db_items.extend(already)
            known_ids.update(it["video_id"] for it in already)
        # Fuzzy owned dedup: a discover candidate is often a *different* YouTube
        # upload of a song already in the library (the music video of an
        # audio-only rip we own, etc.), which carries a different video_id and so
        # sails past the id filter above. Discover exists to surface songs NOT in
        # the library, so drop these. Signatures come from the whole registry,
        # not just the query-matched rows (the owned copy's stored title/artist
        # may not textually match q) nor a popular top-N (a stored song beyond
        # that window would slip through as an external candidate).
        owned_sigs = _owned_signatures(db.all_track_signatures_cached())
        # Collapse different uploads of the same song *within this feed* too —
        # otherwise a category shows both the audio rip and the "official video"
        # of one track, and a user adding both downloads the same song twice.
        kept_fps: list[frozenset] = []
        for entry in raw:
            if len(externals) >= external_limit:
                break
            vid = entry.get("id")
            if not vid or vid in known_ids:
                continue
            item = _external_item(entry)
            if music_only and not _is_music_candidate(item, strict=True):
                continue
            if _matches_owned(item, owned_sigs):
                continue
            fp = _song_fingerprint(item)
            if any(_same_song(fp, k) for k in kept_fps):
                continue  # another upload of a song already in this feed
            externals.append(item)
            kept_fps.append(fp)

    return {"db": db_items, "external": externals}


_lineup_cache: dict[tuple, tuple[int, dict]] = {}
_lineup_lock = threading.Lock()
_MAX_MIX_ROLLS = 12  # cap on cached nonce variants per (user, count, size) per day


def _roll_seed(day_seed: int, nonce: int) -> int:
    """Blend a refresh nonce into the day seed so a ↻ re-rolls the whole lineup
    (anchors, scenes, jitter) reproducibly. nonce=0 returns the day seed
    unchanged, preserving the default day-seeded behaviour."""
    if nonce == 0:
        return day_seed
    h = hashlib.blake2b(f"{day_seed}:{nonce}".encode(), digest_size=8)
    return int.from_bytes(h.digest(), "big")


def _daily_mixes_impl(count: int, size: int, user: CurrentUser, nonce: int = 0):
    """Cache the assembled lineup per (user, count, size, nonce) for the current
    day.

    The build is heavy — several YT Music radio round-trips plus scoring — and the
    home page (plus a re-fetch after every ~20s of listening) would otherwise
    rebuild it constantly. The day seed is the natural TTL; stale-day entries are
    swept on the next write. `nonce` is the client ↻ refresh counter: nonce=0 is
    the stable day-seeded lineup; a higher nonce re-rolls it reproducibly. We keep
    only the most recent `_MAX_MIX_ROLLS` variants per (user, count, size) so
    repeated refreshing can't grow the cache without bound."""
    count = max(1, min(count, 8))
    size = max(5, min(size, 60))
    nonce = max(0, int(nonce))
    day_seed = int(datetime.now(timezone.utc).strftime("%Y%m%d"))
    cache_key = (user.user_id, count, size, nonce)
    with _lineup_lock:
        hit = _lineup_cache.get(cache_key)
        if hit is not None and hit[0] == day_seed:
            return _reconcile_downloaded(hit[1], user)
    result = _build_daily_mixes(count, size, user, _roll_seed(day_seed, nonce))
    with _lineup_lock:
        _lineup_cache[cache_key] = (day_seed, result)
        # Drop stale-day entries, then bound the surviving nonce variants for this
        # (user, count, size) to the newest few (keys sort by nonce).
        for k in [k for k, v in _lineup_cache.items() if v[0] != day_seed]:
            _lineup_cache.pop(k, None)
        variants = sorted(
            (k for k in _lineup_cache if k[:3] == cache_key[:3]),
            key=lambda k: k[3],
        )
        for k in variants[:-_MAX_MIX_ROLLS]:
            _lineup_cache.pop(k, None)
    return _reconcile_downloaded(result, user)


def _reconcile_downloaded(result: dict, user: CurrentUser) -> dict:
    """Promote any of a mix's `external` (not-yet-downloaded) suggestions that
    have since been downloaded into its playable `tracks`.

    The lineup is cached for the whole day (see `_daily_mixes_impl`), so a track
    downloaded from a mix's "download to play" list would otherwise stay stranded
    in `external` — un-playable — until tomorrow's rebuild. Re-checking the
    catalog on each serve is cheap (one indexed lookup) and keeps the mix stable
    while still reflecting what's now on the server. Returns a copy; the cached
    lineup is never mutated."""
    mixes = result.get("mixes") or []
    ext_ids = {
        e["video_id"]
        for m in mixes
        for e in m.get("external", [])
        if e.get("video_id")
    }
    if not ext_ids:
        return result

    rows = db.list_catalog_by_video_ids(user.user_id, list(ext_ids))
    by_vid: dict[str, dict] = {}
    for r in rows:
        # One catalog row per video_id — prefer the copy already in most
        # libraries, then the newest download, so a re-encode doesn't shadow it.
        cur = by_vid.get(r["video_id"])
        if cur is None or (r.get("owner_count") or 0) > (cur.get("owner_count") or 0):
            by_vid[r["video_id"]] = r
    if not by_vid:
        return result

    out = copy.deepcopy(result)
    for m in out["mixes"]:
        have = {(t["video_id"], t["codec"], t["bitrate"]) for t in m["tracks"]}
        keep_external: list[dict] = []
        for e in m.get("external", []):
            row = by_vid.get(e.get("video_id"))
            if row is None:
                keep_external.append(e)
                continue
            key = (row["video_id"], row["codec"], row["bitrate"])
            if key not in have:
                m["tracks"].append(row)
                have.add(key)
        m["external"] = keep_external
        # Cover collage may have leaned on an external thumbnail that's now a
        # track — recompute from the reconciled lists (tracks first).
        urls: list[str] = []
        for t in list(m["tracks"]) + list(m["external"]):
            u = t.get("thumbnail_url")
            if u and u not in urls:
                urls.append(u)
            if len(urls) >= 4:
                break
        m["cover_urls"] = urls
    return out


def _build_daily_mixes(count: int, size: int, user: CurrentUser, day_seed: int):
    def key(t: dict) -> tuple:
        return (t["video_id"], t["codec"], t["bitrate"])

    # ── Signals ──────────────────────────────────────────────────────────────
    # User affinity per artist (normalized 0-1), so personal favourites float up
    # across every mix without overriding the anchor structure. Prefer the recent
    # window (current taste) and fall back to all-time so a user who hasn't
    # listened lately isn't left with an empty affinity map.
    since = _recency_since()
    played = (
        db.top_played_artists(user.user_id, limit=50, since=since)
        or db.top_played_artists(user.user_id, limit=50)
    )
    personalized = bool(played)
    max_play = max((a["play_count"] for a in played), default=0)
    affinity: dict[str, float] = (
        {a["artist"].lower(): a["play_count"] / max_play for a in played}
        if max_play
        else {}
    )
    # Per-track recent play counts (current taste), normalized, so a track the
    # user actually plays floats up within a mix — not just its artist's affinity.
    track_plays = db.play_counts(user.user_id, since=since) or db.play_counts(user.user_id)
    max_track_play = max(track_plays.values(), default=0) or 1

    # Wide pool so mixes can be long and varied as the catalog grows.
    pool = db.popular_catalog(user.user_id, 400)
    if not pool:
        return {"mixes": [], "personalized": False}

    pool_keys = {key(t) for t in pool}
    max_owner = max((t.get("owner_count") or 0) for t in pool) or 1

    # Co-credit adjacency from the pool: artists that share a credit row are
    # treated as neighbours (collaborators, same-scene features) — cheap, offline,
    # and a good "near the anchor" signal without genre tags.
    neighbors: dict[str, set[str]] = {}
    for it in pool:
        members = [m.lower() for m in _artist_members(it.get("artist"))]
        for m in members:
            neighbors.setdefault(m, set()).update(x for x in members if x != m)

    # Soft adjacency from shared playlists: artists whose tracks land on the same
    # imported playlist are grouped — a latent mood/genre signal the co-credit
    # graph misses (source_playlist_title is otherwise unused by discovery). Kept
    # separate from `neighbors` so it only *boosts* scoring, never perturbs anchor
    # spreading or scene clustering.
    playlist_neighbors: dict[str, set[str]] = {}
    _pl_groups: dict[str, set[str]] = {}
    for row in db.owned_playlist_artist_rows(user.user_id):
        for m in _artist_members(row.get("artist")):
            _pl_groups.setdefault(row["title"], set()).add(m.lower())
    for grp in _pl_groups.values():
        for a in grp:
            playlist_neighbors.setdefault(a, set()).update(x for x in grp if x != a)

    # The whole-registry dedup index (for the discovery mix's external picks):
    # exclude *every* stored track, not just the popular-400 pool, plus fuzzy
    # signatures so a different upload of a stored song is dropped too.
    dedup_index = db.all_track_signatures_cached()
    known_ids = {it["video_id"] for it in dedup_index}
    owned_sigs = _owned_signatures(dedup_index)

    # Most-played tracks (for the "On Repeat" mix and to seed discovery / mark
    # which owned tracks are "deep cuts" the user rarely plays).
    played_tracks = (
        db.top_played_tracks(user.user_id, limit=100, since=since)
        or db.top_played_tracks(user.user_id, limit=100)
    )
    played_keys = {key(t) for t in played_tracks}

    # `used` reserves a track for the FIRST mix that picks it, so the lineup stops
    # re-showing the same few popular/collaborator tracks in every mix — the main
    # reason the old feed looked like 4 copies. Every generator skips `used` keys
    # and each emitted mix adds its tracks to it.
    used: set[tuple] = set()

    # Scale each catalog mix's length to how much music there is. With strict
    # cross-mix exclusion a fixed size=40 lets the first mix swallow a small
    # library and leaves nothing for the rest (→ 2-3 mixes). Budgeting the pool
    # across the catalog-drawn mixes (discovery pulls from YT Music, not the pool)
    # yields several *distinct* mixes instead of one huge one; a large catalog
    # keeps full-length mixes.
    mix_size = min(size, max(8, len(pool) // max(1, count - 1)))

    # ── Per-kind track selection ──────────────────────────────────────────────

    def _cap_select(tracks: list[dict], mix_i: int, *, shuffle: bool) -> list[dict]:
        """Take up to `mix_size` tracks — preserving input order, or a per-day
        jitter order when `shuffle` (so era/deep-cut mixes rotate day to day) —
        skipping `used` tracks and holding each primary artist under the cap."""
        seq = tracks
        if shuffle:
            seq = sorted(
                tracks,
                key=lambda t: _jitter(day_seed, mix_i, t["video_id"]),
                reverse=True,
            )
        cap = max(int(mix_size * MAX_ARTIST_SHARE), 1)
        picked: list[dict] = []
        counts: dict[str, int] = {}
        for t in seq:
            if len(picked) >= mix_size:
                break
            if key(t) in used:
                continue
            prim = (_artist_members(t.get("artist")) or [""])[0].lower()
            if counts.get(prim, 0) >= cap:
                continue
            picked.append(t)
            counts[prim] = counts.get(prim, 0) + 1
        return picked

    def build_artist_mix(anchor: str, mix_i: int) -> list[dict]:
        """Score the catalog around one anchor artist (anchor → collaborators →
        play affinity → popularity → jitter) and select a varied tracklist,
        skipping tracks already claimed by an earlier mix today."""
        anchor_l = anchor.lower()
        nbrs = neighbors.get(anchor_l, set())
        p_nbrs = playlist_neighbors.get(anchor_l, set())
        candidates = list(pool)
        for t in db.list_tracks_by_artist(user.user_id, anchor, limit=mix_size):
            if key(t) not in pool_keys:
                candidates.append(t)

        groups: dict[str, list[tuple[float, dict]]] = {}
        for t in candidates:
            if key(t) in used:
                continue
            members = [m.lower() for m in _artist_members(t.get("artist"))]
            prim = members[0] if members else ""
            score = (
                _ANCHOR_BOOST * (1.0 if anchor_l in members else 0.0)
                + _NEIGHBOR_BOOST * (1.0 if set(members) & nbrs else 0.0)
                + _PLAYLIST_NEIGHBOR_BOOST * (1.0 if set(members) & p_nbrs else 0.0)
                + _AFFINITY_WEIGHT * max((affinity.get(m, 0.0) for m in members), default=0.0)
                + _PLAY_WEIGHT * (track_plays.get(t["video_id"], 0) / max_track_play)
                + _POPULARITY_WEIGHT * ((t.get("owner_count") or 0) / max_owner)
                + _JITTER_WEIGHT * _jitter(day_seed, mix_i, t["video_id"])
            )
            groups.setdefault(prim, []).append((score, t))
        if not groups:
            return []

        for lst in groups.values():
            lst.sort(key=lambda st: st[0], reverse=True)
        ordered = sorted(groups.items(), key=lambda kv: kv[1][0][0], reverse=True)
        distinct = len(groups)
        cap = max(int(mix_size * MAX_ARTIST_SHARE), -(-mix_size // max(1, distinct)))

        picked: list[dict] = []
        idxs = {k: 0 for k, _ in ordered}
        counts: dict[str, int] = {}
        progress = True
        while len(picked) < mix_size and progress:
            progress = False
            for k, lst in ordered:
                if len(picked) >= mix_size:
                    break
                if counts.get(k, 0) >= cap or idxs[k] >= len(lst):
                    continue
                picked.append(lst[idxs[k]][1])
                idxs[k] += 1
                counts[k] = counts.get(k, 0) + 1
                progress = True
        return picked

    def spread_anchors(n: int) -> list[str]:
        """Up to `n` artist anchors spread across the co-credit graph. Rank by play
        history then catalog popularity, rotate by the day, but skip any artist
        that shares a credit with an already-picked anchor — so each artist mix is
        a *different* community instead of the same clique re-anchored."""
        ranked = [a["artist"] for a in played]
        seen = {a.lower() for a in ranked}
        for it in pool:
            members = _artist_members(it.get("artist"))
            if members and members[0].lower() not in seen:
                seen.add(members[0].lower())
                ranked.append(members[0])
        if not ranked:
            return []
        rot = day_seed % len(ranked)
        ranked = ranked[rot:] + ranked[:rot]
        picked: list[str] = []
        blocked: set[str] = set()
        for a in ranked:
            al = a.lower()
            if al in blocked:
                continue
            picked.append(a)
            blocked.add(al)
            blocked |= neighbors.get(al, set())
            if len(picked) >= n:
                break
        return picked

    def decade_bands() -> list[tuple[int, str]]:
        """Release-year decades with enough tracks in the pool to fill a mix,
        newest first — as (decade, "2010s")."""
        buckets: dict[int, int] = {}
        for t in pool:
            y = t.get("release_year")
            if not y:
                continue
            d = (int(y) // 10) * 10
            buckets[d] = buckets.get(d, 0) + 1
        bands = [(d, f"{d}s") for d, c in buckets.items() if c >= max(4, mix_size // 3)]
        bands.sort(reverse=True)
        return bands

    def decade_tracks(decade: int) -> list[dict]:
        return [
            t for t in pool
            if t.get("release_year") and (int(t["release_year"]) // 10) * 10 == decade
        ]

    def deep_cut_tracks() -> list[dict]:
        """Owned tracks the user has rarely/never played — resurfaced."""
        return [t for t in pool if t.get("is_owned") and key(t) not in played_keys]

    def cluster_tracks(members: list[str]) -> list[dict]:
        """Pool tracks whose lead artist belongs to a scene — spread across the
        whole community rather than anchored on one artist."""
        ms = {m.lower() for m in members}
        return [
            t for t in pool
            if (_artist_members(t.get("artist")) or [""])[0].lower() in ms
        ]

    def scene_label(members: list[str]) -> str:
        """Name a scene by its 2-3 most-represented artists in the pool, '+N' for
        the rest, so the card reads e.g. 'Feid · Blessd · Ryan Castro +4'."""
        ms = {m.lower() for m in members}
        counts: dict[str, int] = {}
        display: dict[str, str] = {}
        for t in pool:
            for m in _artist_members(t.get("artist")):
                if m.lower() in ms:
                    counts[m.lower()] = counts.get(m.lower(), 0) + 1
                    display.setdefault(m.lower(), m)
        top = sorted(counts, key=lambda k: counts[k], reverse=True)[:3]
        names = [display[k] for k in top]
        extra = len(members) - len(names)
        label = " · ".join(names)
        return (label + (f" +{extra}" if extra > 0 else "")) or "mixed"

    def discovery_external() -> list[dict]:
        """New music NOT on the server, from YT Music radio seeded on the user's
        taste (falls back to yt-dlp related). This is the variety injection — the
        catalog can't diversify what isn't downloaded yet."""
        seeds = [t["video_id"] for t in (played_tracks or pool)[:5] if t.get("video_id")]
        if not seeds:
            return []
        radio = ytmusic.radio_many(seeds, limit=25)
        mix_lists = [radio.get(s, []) for s in seeds]
        if not any(mix_lists):  # YT Music unavailable — fall back to yt-dlp related
            rel = search_mod.related_many(seeds, limit=18)
            mix_lists = [[_external_item(e) for e in rel.get(s, [])] for s in seeds]

        external: list[dict] = []
        seen_e: set[str] = set()
        kept_fps: list[frozenset] = []
        depth = 0
        while len(external) < size and any(depth < len(L) for L in mix_lists):
            for L in mix_lists:
                if len(external) >= size or depth >= len(L):
                    continue
                item = L[depth]
                vid = item.get("video_id")
                if not vid or vid in known_ids or vid in seen_e:
                    continue
                seen_e.add(vid)
                if not _is_music_candidate(item, strict=False):
                    continue
                if _matches_owned(item, owned_sigs):
                    continue  # a different upload of a song already on the server
                fp = _song_fingerprint(item)
                if any(_same_song(fp, k) for k in kept_fps):
                    continue
                external.append(item)
                kept_fps.append(fp)
            depth += 1
        return external

    # ── Plan a varied lineup, then build it in order ──────────────────────────
    # Interleave kinds so the carousel reads varied top to bottom. Kinds with thin
    # data are skipped; artist mixes backfill so the lineup always reaches `count`
    # (or as close as the catalog allows). Discovery is placed early — it's the
    # freshest surface — but only one discovery mix.
    anchors = spread_anchors(count)
    bands = decade_bands()
    scenes = _scene_clusters(neighbors, day_seed)
    has_deep = bool(deep_cut_tracks())

    plan: list[tuple[str, object]] = []
    ai = bi = ci = 0
    if len(played_tracks) >= 8:
        plan.append(("on_repeat", None))
    if ai < len(anchors):
        plan.append(("artist", anchors[ai])); ai += 1
    if ci < len(scenes):
        plan.append(("cluster", scenes[ci])); ci += 1
    if bi < len(bands):
        plan.append(("decade", bands[bi])); bi += 1
    plan.append(("discovery", None))
    if ai < len(anchors):
        plan.append(("artist", anchors[ai])); ai += 1
    if has_deep:
        plan.append(("deep_cuts", None))
    if ci < len(scenes):
        plan.append(("cluster", scenes[ci])); ci += 1
    if bi < len(bands):
        plan.append(("decade", bands[bi])); bi += 1
    while ai < len(anchors):
        plan.append(("artist", anchors[ai])); ai += 1

    def _cover_urls(tracks: list[dict], external: list[dict]) -> list[str]:
        """Up to 4 distinct thumbnails for a collage cover."""
        urls: list[str] = []
        for t in list(tracks) + list(external):
            u = t.get("thumbnail_url")
            if u and u not in urls:
                urls.append(u)
            if len(urls) >= 4:
                break
        return urls

    mixes: list[dict] = []
    artist_n = 0
    discovered = False
    for kind, payload in plan:
        if len(mixes) >= count:
            break

        external: list[dict] = []
        if kind == "artist":
            anchor = payload  # type: ignore[assignment]
            tracks = build_artist_mix(anchor, len(mixes))
            artist_n += 1
            title = f"Daily Mix {artist_n}"
            subtitle = anchor[: -len(" - Topic")] if anchor.endswith(" - Topic") else anchor
        elif kind == "on_repeat":
            tracks = _cap_select(played_tracks, len(mixes), shuffle=False)
            title, subtitle = "On Repeat", "your heavy rotation"
        elif kind == "deep_cuts":
            tracks = _cap_select(deep_cut_tracks(), len(mixes), shuffle=True)
            title, subtitle = "Deep Cuts", "rarely played, back again"
        elif kind == "decade":
            decade, label = payload  # type: ignore[misc]
            tracks = _cap_select(decade_tracks(decade), len(mixes), shuffle=True)
            title, subtitle = label, "time capsule"
        elif kind == "cluster":
            members = payload  # type: ignore[assignment]
            tracks = _cap_select(cluster_tracks(members), len(mixes), shuffle=True)
            title, subtitle = "Your Scene", scene_label(members)
        elif kind == "discovery":
            if discovered:
                continue
            discovered = True
            external = discovery_external()
            # A few not-yet-used owned/played tracks as a playable lead-in so the
            # card has a cover and ▶ works; the mix is otherwise all new music.
            tracks = [t for t in played_tracks if key(t) not in used][:5]
            title, subtitle = "Fresh Finds", "new to you"
        else:
            continue

        if len(tracks) + len(external) < 4:
            continue  # too thin to be a mix

        for t in tracks:
            used.add(key(t))
        mixes.append({
            "id": f"daily-{day_seed}-{len(mixes)}",
            "kind": kind,
            "title": title,
            "subtitle": subtitle,
            "accent": ("hot", "cool", "violet")[len(mixes) % 3],
            "tracks": tracks,
            "external": external,
            "cover_urls": _cover_urls(tracks, external),
        })

    return {"mixes": mixes, "personalized": personalized}
