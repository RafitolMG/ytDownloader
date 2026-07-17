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
from datetime import datetime, timezone

from src import db, search as search_mod, ytmusic
from src.auth import CurrentUser


MAX_ARTIST_SHARE = 0.35      # ceiling on one artist's share of a mix
_ANCHOR_BOOST = 1.0          # track credits the anchor
_NEIGHBOR_BOOST = 0.45       # track shares a credit row with the anchor (collab graph)
_AFFINITY_WEIGHT = 0.5       # × the user's normalized play affinity for the artist
_POPULARITY_WEIGHT = 0.1     # × normalized owner_count (cold-start tie-breaker)
_JITTER_WEIGHT = 0.25        # × deterministic per-(day, mix, track) jitter


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
        already = [
            it
            for it in db.list_catalog_by_video_ids(user_id, raw_ids)
            if it["video_id"] not in known_ids
        ]
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


def _daily_mixes_impl(count: int, size: int, user: CurrentUser):
    """Cache the assembled lineup per (user, count, size) for the current day.

    The build is heavy — several YT Music radio round-trips plus scoring — and the
    home page (plus a re-fetch after every ~20s of listening) would otherwise
    rebuild it constantly. The day seed is the natural TTL; stale-day entries are
    swept on the next write. Mixes are meant to be daily, so within-day stability
    is the intended behaviour, not a regression."""
    count = max(1, min(count, 8))
    size = max(5, min(size, 60))
    day_seed = int(datetime.now(timezone.utc).strftime("%Y%m%d"))
    cache_key = (user.user_id, count, size)
    with _lineup_lock:
        hit = _lineup_cache.get(cache_key)
        if hit is not None and hit[0] == day_seed:
            return _reconcile_downloaded(hit[1], user)
    result = _build_daily_mixes(count, size, user, day_seed)
    with _lineup_lock:
        _lineup_cache[cache_key] = (day_seed, result)
        for k in [k for k, v in _lineup_cache.items() if v[0] != day_seed]:
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
    # across every mix without overriding the anchor structure.
    played = db.top_played_artists(user.user_id, limit=50)
    personalized = bool(played)
    max_play = max((a["play_count"] for a in played), default=0)
    affinity: dict[str, float] = (
        {a["artist"].lower(): a["play_count"] / max_play for a in played}
        if max_play
        else {}
    )

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

    # The whole-registry dedup index (for the discovery mix's external picks):
    # exclude *every* stored track, not just the popular-400 pool, plus fuzzy
    # signatures so a different upload of a stored song is dropped too.
    dedup_index = db.all_track_signatures_cached()
    known_ids = {it["video_id"] for it in dedup_index}
    owned_sigs = _owned_signatures(dedup_index)

    # Most-played tracks (for the "On Repeat" mix and to seed discovery / mark
    # which owned tracks are "deep cuts" the user rarely plays).
    played_tracks = db.top_played_tracks(user.user_id, limit=100)
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
                + _AFFINITY_WEIGHT * max((affinity.get(m, 0.0) for m in members), default=0.0)
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
