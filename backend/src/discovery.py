"""
Discovery / recommendation logic: the hybrid search feed, the fuzzy
"same song, different upload" dedup, and the daily-mix scoring algorithm.

Extracted from the route layer so the dense, db-backed but request-independent
recommendation code lives on its own (and can be exercised directly). The route
handlers in api/routes.py import these names and call into them; nothing here
touches the request/job runtime.
"""
from __future__ import annotations

import hashlib
import re
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


def _daily_mixes_impl(count: int, size: int, user: CurrentUser):
    count = max(1, min(count, 6))
    size = max(5, min(size, 60))
    day_seed = int(datetime.now(timezone.utc).strftime("%Y%m%d"))

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

    # Anchors: most-played artists first (personalized), then the lead artist of
    # the most popular catalog tracks, so there are always several mixes even
    # with thin history. Anchor on the *first credited* name, not the whole
    # collab string, so list-by-artist matching stays meaningful.
    anchors = [a["artist"] for a in played]
    seen_a: set[str] = {a.lower() for a in anchors}
    for it in pool:
        if len(anchors) >= max(count, 6):
            break
        members = _artist_members(it.get("artist"))
        if not members:
            continue
        a = members[0]
        if a.lower() not in seen_a:
            seen_a.add(a.lower())
            anchors.append(a)

    if not anchors:
        return {"mixes": [], "personalized": False}

    rot = day_seed % len(anchors)
    todays = (anchors[rot:] + anchors[:rot])[:count]

    def build_tracks(anchor: str, i: int) -> list[dict]:
        """Score the catalog for this mix and select a varied tracklist."""
        anchor_l = anchor.lower()
        nbrs = neighbors.get(anchor_l, set())

        # Guarantee the anchor's own catalogue is a candidate even on a catalog
        # bigger than the popular-400 pool (a top-played artist whose deep cuts
        # didn't make the popularity cut).
        candidates = list(pool)
        for t in db.list_tracks_by_artist(user.user_id, anchor, limit=size):
            if key(t) not in pool_keys:
                candidates.append(t)

        # Group scored candidates by their *primary* (first-credited) artist —
        # that's the slot the per-artist cap counts against.
        groups: dict[str, list[tuple[float, dict]]] = {}
        for t in candidates:
            members = [m.lower() for m in _artist_members(t.get("artist"))]
            prim = members[0] if members else ""
            score = (
                _ANCHOR_BOOST * (1.0 if anchor_l in members else 0.0)
                + _NEIGHBOR_BOOST * (1.0 if set(members) & nbrs else 0.0)
                + _AFFINITY_WEIGHT * max((affinity.get(m, 0.0) for m in members), default=0.0)
                + _POPULARITY_WEIGHT * ((t.get("owner_count") or 0) / max_owner)
                + _JITTER_WEIGHT * _jitter(day_seed, i, t["video_id"])
            )
            groups.setdefault(prim, []).append((score, t))

        for lst in groups.values():
            lst.sort(key=lambda st: st[0], reverse=True)
        # Order groups by their best track's score — the anchor's group leads, so
        # the mix opens on an anchor track (its identity / cover art).
        ordered = sorted(groups.items(), key=lambda kv: kv[1][0][0], reverse=True)

        # Hard per-artist cap. The 35% share is the goal, but loosen it when there
        # simply aren't enough distinct artists to fill the mix (a catalog of one
        # or two artists can't be diversified) — ceil(size / artists) is the
        # smallest cap that still lets the mix reach `size`. The cap is otherwise
        # never relaxed: on a varied catalog one artist never exceeds 35%, even if
        # that leaves the mix a touch short of `size`.
        distinct = len(groups)
        cap = max(int(size * MAX_ARTIST_SHARE), -(-size // max(1, distinct)))

        # Round-robin one track per artist per pass, skipping artists at the cap.
        # Distinct artists surface early; no artist exceeds `cap`.
        picked: list[dict] = []
        idxs = {k: 0 for k, _ in ordered}
        counts: dict[str, int] = {}
        progress = True
        while len(picked) < size and progress:
            progress = False
            for k, lst in ordered:
                if len(picked) >= size:
                    break
                if counts.get(k, 0) >= cap or idxs[k] >= len(lst):
                    continue
                picked.append(lst[idxs[k]][1])
                idxs[k] += 1
                counts[k] = counts.get(k, 0) + 1
                progress = True
        return picked

    # Pass 1: build each mix's tracklist. Defer related() so all seeds fetch in
    # one concurrent batch below rather than one blocking round-trip per mix.
    built: list[dict] = []
    for i, anchor in enumerate(todays):
        tracks = build_tracks(anchor, i)
        if len(tracks) < 4:
            continue  # too thin to be a "mix"

        # Seed external suggestions from the first track of the first few distinct
        # artists in the mix — so the "more like this" tail spreads across the
        # mix's artists, not just the anchor.
        seeds: list[str] = []
        seed_artists: set[str] = set()
        for t in tracks:
            members = _artist_members(t.get("artist"))
            prim = members[0].lower() if members else ""
            if prim in seed_artists:
                continue
            seed_artists.add(prim)
            seeds.append(t["video_id"])
            if len(seeds) >= 3:
                break

        # "<Artist> - Topic" is YouTube's auto-channel naming — show just the artist.
        subtitle = anchor[: -len(" - Topic")] if anchor.endswith(" - Topic") else anchor
        built.append({"i": i, "tracks": tracks, "subtitle": subtitle, "seeds": seeds})

    # Sprinkle in not-yet-downloaded tracks related to each mix's seeds so the mix
    # keeps growing beyond the catalog — playing one downloads it (to the shared
    # catalog, without favouriting). All seeds fetched concurrently; best-effort.
    all_seeds = list({s for b in built for s in b["seeds"]})
    rel_map = search_mod.related_many(all_seeds, limit=18)

    # Exclude *every* stored track, not just the popular-400 pool — a song on the
    # server beyond that window would otherwise resurface here as a "download"
    # sprinkle. Fuzzy signatures also drop a different upload of a stored song.
    dedup_index = db.all_track_signatures_cached()
    known_ids = {it["video_id"] for it in dedup_index}
    owned_sigs = _owned_signatures(dedup_index)

    mixes: list[dict] = []
    for b in built:
        i = b["i"]
        # Round-robin across the mix's seeds so externals are artist-varied too.
        seed_lists = [rel_map.get(s, []) for s in b["seeds"]]
        externals: list[dict] = []
        seen_e: set[str] = set()
        depth = 0
        while len(externals) < 8 and any(depth < len(L) for L in seed_lists):
            for L in seed_lists:
                if len(externals) >= 8:
                    break
                if depth >= len(L):
                    continue
                entry = L[depth]
                vid = entry.get("id")
                if not vid or vid in known_ids or vid in seen_e:
                    continue
                seen_e.add(vid)
                item = _external_item(entry)
                if not _is_music_candidate(item, strict=False):
                    continue
                if _matches_owned(item, owned_sigs):
                    continue  # a different upload of a song already on the server
                externals.append(item)
            depth += 1

        mixes.append({
            "id": f"daily-{day_seed}-{i}",
            "title": f"Daily Mix {i + 1}",
            "subtitle": b["subtitle"],
            "accent": ("hot", "cool", "violet")[i % 3],
            "tracks": b["tracks"],
            "external": externals,
        })

    return {"mixes": mixes, "personalized": personalized}
