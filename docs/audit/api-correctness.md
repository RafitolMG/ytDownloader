# Pre-production audit — API correctness, contract integrity, state & caching

**Scope:** backend API semantics, frontend↔backend contract, cache/shared-state defects,
job lifecycle, database layer, input bounds, dead code.
**Branch:** `develop` @ `b16f7ac`. **Date:** 2026-09-07.
**Sibling lanes (security, UX) are out of scope** — two auth/limit observations are flagged
where they were stumbled on, not hunted.

Verification baseline: `backend/.venv/bin/python -m pytest -q` → **41 passed**;
`npx tsc -b --force` → **clean**. Every `CONFIRMED` finding below was reproduced with a
throwaway script under `/tmp/ytdl-audit/` (never in the repo).

---

## Executive summary

Eighteen findings: **3 High** (one of them a user-visible functional break), **7 Medium**, **8 Low**.

The single most important one is **not** in the backend: `useLiveJobProgress` handles the
progress WebSocket's `done`/`error`/`cancelled` events by invalidating a query but **never
updating its own state**. Everything that consumes the hook's `status` for completion —
i.e. every "⬇ add" button in the catalog, suggestions carousel, radio rows and album views —
is therefore permanently stuck on `···`. The download itself succeeds; the UI never learns.

The rest cluster in two families:

1. **Cache-key and cache-failure defects in `search.py`** — the same family as the
   `_album_payload` bug that motivated this audit, one layer up. `_RELATED_CACHE` omits
   `limit` from its key, so a 12-item entry starves the 50-item radio pool for 15 minutes;
   `search_albums` caches the *empty result of an upstream failure* for 30 minutes.
   Separately, `search.py`'s `_TTLCache` is the only cache in the codebase written from
   thread pools **without a lock** (`ytmusic.py`'s plain dicts *are* locked), and its
   eviction loop provably raises `RuntimeError: dictionary changed size during iteration`.
2. **Upstream failures presented as "nothing found."** `/api/catalog/discover`,
   `/api/albums/search` return `200` with empty arrays and `/api/albums/{id}` returns `404`
   when yt-dlp/YT Music is down. Combined with the client's 30-minute `staleTime` and
   `retry: false` on album resolve, a 10-second upstream blip reads as a permanent
   "album not found."

**Explicit clean results** (things checked that are fine) are listed at the end — notably
the route-ordering hypothesis in the brief is **not** a defect, and no *second* instance of
the seed bug class (a cached mutable handed out and then mutated) exists.

---

## Findings

### H1 — `done`/`error`/`cancelled` WS events update no state, so external downloads never complete in the UI  ·  **High**  ·  CONFIRMED

**Where:** `frontend/src/features/queue/useLiveJobProgress.ts:69-76`,
consumed at `frontend/src/features/catalog/useExternalDownload.ts:20,37,52,59`.

The hook's `onmessage` switch calls `setState` in the `snapshot`, `progress`, `status`,
`track` and `track_skipped` cases — and **not** in `done`, `error` or `cancelled`, which only
call `qc.invalidateQueries({ queryKey: ['jobs'] })`. Mechanically verified:

```
case 'snapshot':      setsState=true      case 'done':      setsState=false
case 'progress':      setsState=true      case 'error':     setsState=false
case 'status':        setsState=true      case 'cancelled': setsState=false
case 'track':         setsState=true
case 'track_skipped': setsState=true
```

So `LiveJobProgress.status` can only reach `'done'` via the `snapshot` event (the DB row at
connect time). But the backend only emits `{"type":"status", …}` with `db.MERGING` /
`db.TRANSCODING` (`backend/src/api/routes.py:649,672`) — never `done` — and
`useExternalDownload` opens the socket immediately after `POST /api/download` returns, so its
snapshot always carries `queued`/`downloading`. `enabled` is `jobId !== null`, which never
goes back to false, so the hook never resets and never reconnects.

**Failure scenario:** open the catalog / suggestions carousel / a remote album, click ⬇ on a
YouTube candidate. The mp3-320 import runs to completion server-side and the track lands in
the catalog. In the UI:
- `isDone` stays `false` → the card never shows `✓ added` (`cards.tsx:83-88`) and the row
  keeps rendering `··· downloading 100%` (`rows.tsx:287-290`);
- `isPending` stays `true` → the ⬇ button stays `disabled` forever (`rows.tsx:316`,
  `cards.tsx:80`), so the user cannot act on that row again without a page reload;
- the `useEffect` at `useExternalDownload.ts:39` never fires, so `['discover']`,
  `['catalog']`, `['daily-mixes']`, `['library']` and `['activity']` are never invalidated —
  the newly downloaded track keeps rendering as an un-owned external row;
- a *failed* download is equally invisible: `live.status === 'error'` never becomes true, so
  `setFailed('download failed — check the queue')` never runs and the spinner is permanent.

`JobRow` (`frontend/src/features/queue/JobRow.tsx:49`) escapes this only because it derives
`enabled` from the polled job status, which resets the hook to `EMPTY` a few seconds later.

---

### H2 — `_RELATED_CACHE` key omits `limit`, so a small request poisons the radio pool for 15 minutes  ·  **High**  ·  CONFIRMED

**Where:** `backend/src/search.py:192` (`_RELATED_CACHE.get(video_id)`) and
`backend/src/search.py:222` (`_RELATED_CACHE.set(video_id, results)`).

`related(video_id, limit)` clamps `limit`, passes it to yt-dlp as
`playlist_items: "1-{limit+1}"`, then caches the result under the **bare `video_id`**. Every
other cache in the module keys on `f"{limit}:{q}"`; this one does not.

Call sites request wildly different sizes:
- `discovery.discovery_external` → `search_mod.related_many(seeds, limit=18)`
- `routes.catalog_suggestions` → `search_mod.related_many(seed_ids, limit=12)`
- `routes.py:1756` (`catalog_radio`) → `search_mod.related(video_id, limit=external_limit + 40)`
  (up to 50 after clamping) — and the player's autoplay radio calls it via
  `api.radio(cur.video_id, { external_limit: 0 })`
  (`frontend/src/features/player/AudioPlayerProvider.tsx:558`), i.e. `pool_size = 40`.

**Failure scenario:** a suggestions refresh seeds on video `V` with `limit=12` and caches 13
entries. Within the next 15 minutes the user finishes a track by `V` and autoplay-radio fires
`catalog_radio` wanting a 40-item pool; it gets the 13-item list back. `rotate_pick` then
samples from a pool it believes is large, `db_items` shrinks to whatever of those 13 are
owned, and `triggerAutoRadio` appends far fewer (often zero) tracks than intended. Proven:

```
first call asked yt-dlp for 13 items; second call upstream hits=1; small=13 big=13
-> radio pool starved: True
```

(Also relevant: `ytmusic.radio()` has the same key shape but every call site uses `limit=25`,
so it is currently latent rather than live.)

---

### H3 — `search_albums` caches the *empty result of an upstream failure* for 30 minutes  ·  **High**  ·  CONFIRMED

**Where:** `backend/src/search.py:390-392`, with `_search_album_ids` swallowing at
`backend/src/search.py:355-357`.

`_search_album_ids` returns `[]` on **any** exception (network, yt-dlp extractor break,
YouTube bot challenge). `search_albums` cannot distinguish that from a genuine zero-result
search and unconditionally writes it into the 30-minute `_ALBUM_SEARCH_CACHE`.

**Failure scenario:** a user searches "ok computer" during a five-second upstream hiccup. The
empty list is cached. Upstream recovers immediately, but every retry of that query — from
that user or any other — returns `{"albums": []}` for the next 30 minutes. The frontend
compounds this: `AlbumsPage.tsx:98-101` holds the result with `staleTime: 5 * 60_000`.
Proven:

```
failure cached: first=[] second-after-recovery=[] -> poisoned for 30min: True
```

A related, milder case: when only *some* of the per-album `_album_card` fan-out calls fail
(`search.py:394-405`), the short card list is cached for 30 minutes just the same.

---

### M1 — `_TTLCache` is unsynchronized while written from thread pools  ·  **Medium**  ·  CONFIRMED

**Where:** `backend/src/search.py:31-57` — `_store` is a plain dict; `set()` does
`pop` → assign → `while len(...) > max: pop(next(iter(...)))` with no lock.

Concurrent writers are real, not hypothetical:
- `resolve_album` fans `get_album()` (which calls `_ALBUM_CACHE.set`) across
  `ThreadPoolExecutor(max_workers=min(6, …))` (`search.py:468`);
- `related_many` fans `related()` (which calls `_RELATED_CACHE.set`) across up to 6 threads
  (`search.py:246`);
- on top of that, `EXTRACTION_POOL` serves up to `min(4, cpu_count)` requests in parallel.

`ytmusic.py` guards its equivalent module-level dicts with `_radio_cache_lock` /
`_song_search_lock`; `search.py` does not. That inconsistency is the bug.

**Failure scenario:** once a cache is at `max_entries` (200 for the album caches, 512 for the
rest), two threads entering the eviction loop concurrently raise
`RuntimeError: dictionary changed size during iteration` from `next(iter(self._store))`.
Reproduced in ~1s with 16 threads:

```
TTLCache.set race errors: ["RuntimeError('dictionary changed size during iteration')", ...]
```

Blast radius depends on the caller: inside `search()` it propagates to a `502`; inside
`get_album()` under `album_detail` it escapes `run_extraction` (only `asyncio.TimeoutError`
is caught) and becomes a `500`; inside `related_many` it is caught and degrades that seed to
`[]`. A silent partial-loss variant also exists (two `set()`s racing can drop an entry), but
that only costs an extra upstream call.

---

### M2 — Retrying a track-list import job always 400s  ·  **Medium**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2514-2540` (`retry_job`), interacting with
`backend/src/api/routes.py:1117-1131` (`start_tracklist_import` stores
`url='tracklist-import'`, `is_playlist=True`).

`retry_job` dispatches on `row["is_playlist"]` only, so a Spotify/CSV import job is routed to
`start_playlist_download`, whose first act is `_validate_youtube_url('tracklist-import')`.

**Failure scenario:** an import of a 200-track pasted list dies halfway (network drop). The
user hits ↻ in the queue. Proven:

```
retry tracklist-import -> 400 {'detail': 'only youtube urls are allowed'}
```

The queue shows a raw `400: only youtube urls are allowed` and there is no other way to
resume the import — the original paste is gone from the UI. `retry_job` has no branch for
`url == 'tracklist-import'` and the jobs table doesn't persist the source list.

---

### M3 — Upstream failures are returned as "nothing found" (200-empty / 404), not 502  ·  **Medium**  ·  CONFIRMED

**Where:**
- `backend/src/discovery.py:461-465` — `_discover_feed` catches every exception from
  `search_mod.search`, prints a traceback, sets `raw = []`.
- `backend/src/api/routes.py:1802-1826` — `albums_search`'s `except Exception → 502` is dead
  code: `search_mod.search_albums` never raises (see H3).
- `backend/src/api/routes.py:1895-1920` — `album_detail` maps `get_album() is None` to `404`,
  but `get_album` returns `None` both for "no such album" and for "`_extract_album_raw`
  failed" (`search.py:306-311`).
- `backend/src/api/routes.py:1852-1893` — `album_resolve` has the same conflation.
- `backend/src/search.py:103-108` — `suggest()` caches `[]` on failure for 60s.

**Failure scenario:** YouTube starts challenging the datacenter IP (the documented prod
failure mode for this box). Proven behaviour with a dead upstream:

```
/api/catalog/discover -> 200 {'db': [], 'external': []}
/api/albums/search    -> 200 {'albums': []}
/api/albums/{id}      -> 404 {'detail': 'album not found'}
```

The client has no way to tell an outage from an empty catalog, so it renders "no results"
empty states and — for `LibraryAlbumView`, which uses `retry: false` and
`staleTime: 30 * 60_000` (`frontend/src/pages/AlbumsPage.tsx:380-383`) — will not retry for
30 minutes. `/api/health/extraction` correctly returns 503 in this situation, so the
information exists; it just never reaches the feature endpoints.

---

### M4 — `list_catalog` interpolates search text into `LIKE` without escaping wildcards  ·  **Medium**  ·  CONFIRMED

**Where:** `backend/src/db.py:843-846`
(`conditions.append("(t.title LIKE ? OR t.artist LIKE ?)")` / `wildcard = f"%{query}%"`).

Parameterized, so **not** SQL injection — but `%` and `_` inside `query` stay live pattern
metacharacters. `list_tracks_by_artist` (`db.py:1127-1136`) escapes them properly with
`ESCAPE '\'`; `list_catalog` does not. Proven against the real endpoint:

```
q='%'  -> ['Canción Bonita', 'Plain Song']   (entire catalog)
q='_'  -> ['Canción Bonita', 'Plain Song']
```

**Failure scenario:** typing `%` (or a title containing `_`) in the catalog search box
returns the whole catalog up to `limit` (max 500) instead of matches, and feeds that same
noise into `/api/catalog/discover`'s `db` block.

Second, separable defect on the same line: SQLite's `LIKE` folds case for **ASCII only**, and
`COLLATE NOCASE` doesn't help. On a Spanish-language catalog:

```
q='Canción' -> ['Canción Bonita']    q='cancion' -> []
```

Searching without accents — the normal way people type on a phone — silently misses.
(`ytmusic._norm` already does accent folding elsewhere in the codebase; the catalog query
doesn't use it.)

---

### M5 — `retry_job` bypasses the extraction rate limiter and drops the `own` flag  ·  **Medium**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2525-2540`.

`retry_job` calls `start_download(...)` / `start_playlist_download(...)` as plain Python
functions, passing only `body` and `user=user`. Their `_rl: CurrentUser = Depends(rate_limit_extraction)`
parameter keeps its default — a `Depends` object — so `_enforce_extraction_budget` never runs.
Verified: `start_download params: ['body', 'user', '_rl']`.

**Failure scenario:** a client loops `POST /api/jobs/{id}/retry` and drives unlimited yt-dlp
extractions against the shared cookies, which is precisely what `RATELIMIT_PER_MIN` exists to
prevent. (Flagging as stumbled-on; the security lane owns the severity call.)

Same handler, separate contract bug: `DownloadRequest.own` is never persisted to the `jobs`
table, and `retry_job` reconstructs the request without it. A daily-mix "fetch to catalog but
don't favourite" download (`own=False`, `useExternalDownload.ts:28`) becomes `own=True` on
retry, silently adding the track to the user's library.

---

### M6 — `PATCH /api/playlists/{id}` answers `200 {"ok": true}` for updates the DB rejected  ·  **Medium**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2102-2118` ignores `update_playlist`'s return value;
`backend/src/db.py:1286-1291` returns `False` — **discarding the entire patch** — when
`visibility` is not in `{'public','private'}`.

**Failure scenario:** a client sends `{"name": "New name", "visibility": "everyone"}`. The
whole update is dropped, including the valid name change, and the API reports success.
Proven:

```
PATCH visibility=everyone -> 200 {'ok': True} | stored: private
```

The UI refetches, shows the unchanged playlist, and the user assumes a render bug. An empty
patch body behaves the same way (`db.py:1294-1295`). `POST /api/playlists` has the mirrored
problem: `create_playlist` silently coerces an invalid `visibility` to `private`
(`db.py:1245-1246`) rather than rejecting it with a 422.

---

### M7 — Progress-WS snapshot/subscribe race, plus a socket that never closes on the success path  ·  **Medium**  ·  SUSPECTED (code-path traced; timing-dependent)

**Where:** `backend/src/api/routes.py:1322-1332`.

`progress_ws` sends the DB snapshot (line 1322), *then* reads `_jobs.get(job_id)` (1324) and
only then calls `hub.subscribe(loop)` (1332). `_ProgressHub.put` drops events with no
subscribers (`routes.py:175-182`, by design). Two consequences:

1. **Race:** if the worker publishes its terminal event between the snapshot and the
   `subscribe()`, the client gets a snapshot saying `downloading` and then nothing. It falls
   back on `useJobs`' 4-5s poll — except for `useExternalDownload`, which doesn't poll at all
   (see H1).
2. **Leak:** the success paths of `run_audio_import` (`routes.py:608-615`), `run` (`routes.py:681-686`) and
   `run_zip` (`routes.py:1080-1090`) do **not** `_jobs.pop(job_id)` — only the `_Cancelled` and
   `except Exception` paths do. So a client connecting after a successful job finds
   `runtime is not None`, subscribes, and blocks in `asyncio.wait` on a hub that will never
   publish again. The socket and its two tasks stay alive until the client disconnects or the
   reaper clears the entry an hour later (`_REAP_GRACE_SEC = 3600`, `routes.py:255`).

**Fix shape (not applied):** subscribe first, then send the snapshot, then drain; and re-read
the DB row after subscribing to close immediately if it is already terminal.

---

### L1 — Client declares response fields the server never sends  ·  **Low**  ·  CONFIRMED

- `frontend/src/shared/api/client.ts:307-311` types `removeFromLibrary` as
  `{ ok: true; orphaned: boolean }`. `remove_track` (`routes.py:1431-1450`) returns
  `{"ok": true}`. Proven: `DELETE /api/library -> 200 {'ok': True}; 'orphaned' present: False`.
  Any consumer reading `.orphaned` gets `undefined` typed as `boolean` — the exact silent
  drift the audit brief asks about. (`catalogUnown` at `client.ts:432` declares the same field
  but as optional, so it is merely noise.)
- `frontend/src/shared/api/types.ts:466-473` — the `WsEvent` `done` variant omits `no_match`,
  and the `metadata` variant omits `count` / `capped`, all three of which
  `start_tracklist_import` emits (`routes.py:1153`, `routes.py:1257`). `ImportPage.tsx:55,56,79`
  reads them through `as number` / `Boolean(...)` casts, which is why `tsc` stays green.

---

### L2 — Zod validates only the two auth responses; every feed/list response is an unchecked cast  ·  **Low**  ·  CONFIRMED

**Where:** `frontend/src/shared/api/schemas.ts` defines `whoamiSchema` and `mediaTokenSchema`
and nothing else; `json<T>()` (`client.ts:129-164`) validates only when a schema is passed,
which happens at exactly `client.ts:91,227,233`.

So the 40-odd feed/list types in `types.ts` are compile-time decoration with no runtime
enforcement — L1 above is what that costs. This is a documented, deliberate choice
(`schemas.ts:11-15`), recorded here so the risk is explicit rather than as a defect.

---

### L3 — Two more unsynchronized module dicts mutated across threads  ·  **Low**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2348-2358` (`_preview_cache_put`, `min()` over the live
dict) and `backend/src/api/routes.py:2208-2217` (`_cover_cache_put`, `list(...)[:N]`).

Both are written from `EXTRACTION_POOL` threads and read from the event loop. Reproduced the
same `RuntimeError: dictionary changed size during iteration` with the exact `min()`-over-a-
live-dict shape. Requires the cache to be at its cap (`_PREVIEW_CACHE_MAX = 256`,
`_COVER_CACHE_MAX = 2048`), so it is rarer than M1; in `_resolve_preview` it would surface as
an uncaught `500` on `/api/preview/{video_id}`.

`_cover_cache_put` has a second, benign-but-wrong path: `track_cover` returns
`_cover_cache.get(video_id)` *after* the put, so a concurrent eviction of the entry it just
wrote makes the endpoint answer `{"cover_url": null}` for a cover it actually resolved
(`routes.py:2220-2233`).

---

### L4 — `/api/catalog/radio/{video_id}` doesn't validate the video id  ·  **Low**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:1734-1756`. Every other video-id endpoint
(`remove_track`, `catalog_adopt`, `catalog_unown`, `track_cover`, `stream_track`,
`preview_track`) gates on `_VIDEO_ID_RE`; this one passes the raw path segment to
`search_mod.related`, which interpolates it into
`https://www.youtube.com/watch?v={id}&list=RD{id}` (`search.py:197`) and uses it verbatim as
the `_RELATED_CACHE` key.

**Failure scenario:** `GET /api/catalog/radio/abc%26list=PLxxxx` yields a URL whose query
string the caller partly controls (still on `youtube.com`, so impact is limited to steering
the extraction and to writing arbitrary cache keys into the 512-entry `_RELATED_CACHE`).
It is an inconsistency with the surrounding code more than an exploit.

---

### L5 — `GET /api/jobs` silently truncates at 200 rows  ·  **Low**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2487` calls `db.list_jobs(owner_id=user.owner_filter)`,
which defaults to `limit: int = 200` (`db.py:454`). The route exposes no `limit`/`offset`, the
response carries no total, and `QueuePage` / `QueueList` render whatever comes back.

**Failure scenario:** a heavy user's 201st-oldest job simply stops existing in the queue view;
its DB row is still there and `/api/jobs/{id}` still resolves it, so there's no signal that
anything was hidden. (`/api/library` had exactly this bug at 500 and was fixed by raising the
cap — same pattern, still present here.)

---

### L6 — `/api/history` returns a *job* id in `id`  ·  **Low**  ·  CONFIRMED

**Where:** `backend/src/api/routes.py:2597-2623` emits `{"id": row["id"], …}` shaped to match
`SearchResultItem` so both render through one card. `SearchResultItem.id` is a **video** id;
`HistoryItem.id` is a job UUID. Proven:
`{'id': 'job-xyz', …, 'url': 'https://youtu.be/aaaaaaaaaaa'}`.

Harmless today — `SearchResultCard` only reads `title`/`channel`/`thumbnail`/`duration_seconds`
and the history dropdown re-analyzes via `url`. It is a trap for the next person who wires
`item.id` into `api.previewUrl()` or `catalogAdopt()`.

Same handler, second-order: it fetches `limit * 3` rows and filters `status == DONE` in
Python, so a user whose recent history is mostly failures gets fewer than `limit` items with
no indication.

---

### L7 — Dead client method and unused endpoints  ·  **Low**  ·  CONFIRMED

- `api.suggest` (`client.ts:239-242` → `GET /api/search/suggest`) has **zero** call sites in
  the SPA; `SearchBar` uses `useDropdownPreview` → `api.search` instead. Both the client method
  and the endpoint (plus `search.suggest`, `_SUGGEST_URL`, `_SUGGEST_CACHE` in `search.py`) are
  unreachable from the app.
- `GET /api/jobs/{job_id}` has no SPA caller (only the list, cancel, retry and delete are used).
- `GET /api/auth/ping` has no SPA caller.
- `/api/health` and `/api/health/extraction` are deliberately app-external (uptime monitor) —
  not dead.

Every other client method maps to a live route, and every other route has a caller.

---

### L8 — `list_catalog` aggregates the whole `tracks` table before `LIMIT`/`OFFSET`; no index on `downloaded_at`  ·  **Low**  ·  CONFIRMED (by inspection)

**Where:** `backend/src/db.py:859-882`. The `LEFT JOIN track_owners … GROUP BY video_id,
codec, bitrate ORDER BY {order_by} LIMIT ? OFFSET ?` computes `owner_count` / `is_owned` for
**every** track before discarding all but one page, and `_CATALOG_SORTS['newest']` orders by
`t.downloaded_at`, for which no index exists (only `idx_tracks_album` and the PK).

Pagination therefore costs the same as a full scan on every page, and `/api/catalog/tracks`
is hit on nearly every screen. `popular_catalog`'s 30s TTL cache absorbs the discovery
callers but **not** the catalog browse / "mine" view, which is uncached by design
(`db.py:936-943`). Not a correctness bug; called out because it grows with the catalog on a
small ARM box.

Related, same class: `album_resolve` (`routes.py:1871-1879`) pulls the caller's entire
library (`limit=10000`) and filters album titles in Python instead of using `idx_tracks_album`
— one full library read per library-album open.

---

## Coverage

**Read in full:** `backend/src/api/routes.py` (2710), `backend/src/search.py` (478),
`backend/src/ytmusic.py` (390), `backend/src/discovery.py` (1012),
`backend/src/extraction_pool.py`, `backend/src/rate_limit.py`,
`frontend/src/shared/api/client.ts`, `types.ts`, `schemas.ts`, `useJobs.ts`,
`frontend/src/features/queue/useLiveJobProgress.ts`, `JobRow.tsx`,
`frontend/src/features/capture/useCapture.ts`,
`frontend/src/features/catalog/useExternalDownload.ts`,
`frontend/src/features/offline/offlineIndex.ts`, `frontend/src/app/providers.tsx`.

**Read in relevant part:** `backend/src/db.py` (schema, migrations, all job/track/catalog/
play/playlist accessors, both discovery caches), `backend/src/ytDownloaderFunctions.py`
(`get_available_resolutions`, `get_basic_info`, `get_playlist_tracks`, `parse_audio_quality`),
`backend/src/api/admin_routes.py`, `backend/src/config.py`,
`frontend/src/pages/AlbumsPage.tsx`, `ImportPage.tsx`,
`frontend/src/features/catalog/{cards,rows}.tsx`,
`frontend/src/features/player/AudioPlayerProvider.tsx`,
`frontend/src/features/search/{useSearch.ts,SearchResultCard.tsx}`.

**Method:** all 48 routes enumerated from the live `app.routes` and diffed field-by-field
against `client.ts`/`types.ts`; findings reproduced with FastAPI `TestClient` under
`DEV_AUTH_BYPASS=1` against a throwaway SQLite file, plus standalone scripts for the cache
and thread-race defects. Backend suite and frontend typecheck both green before and after
(read-only audit; no source file was modified).

### Explicitly checked, no issues found

- **Route ordering / shadowing.** The brief's hypothesis is wrong: registration order is
  `/api/albums/search` (#37) → `/api/albums/resolve` (#38) → `/api/albums/{album_id}` (#39),
  so the static paths win. Swept all 48 routes for static-vs-parameterized collisions —
  `/api/track/play` vs `/api/track/{video_id}/…` differ in method and depth;
  `/api/playlists/{id}/tracks` vs `…/tracks/bulk` differ in depth; the SPA catch-all is last
  and guards `api/`, `ws/`, `assets/`. Nothing is unreachable.
- **A second instance of the seed bug class.** Traced every cached mutable to its consumers:
  `db.popular_catalog` and `db.all_track_signatures_cached` (shared lists, comment at
  `db.py:942` says read-only — all six call sites only read); `discovery._lineup_cache`
  (`_reconcile_downloaded` `deepcopy`s before mutating, `discovery.py:601`);
  `ytmusic._radio_cache` / `_song_search_cache` (items flow into responses, never mutated);
  `search._SEARCH_CACHE` / `_RELATED_CACHE` (`_external_item` copies, callers read-only);
  `search._ALBUM_CACHE` (fixed by `_album_copy` + `_album_payload`, and covered by
  `tests/test_albums.py`). Grepped every `append`/`update`/`sort`/`pop`/item-assignment in
  `discovery.py` and `routes.py` — none touches a shared row dict.
- **Transactions.** `db._write()` serializes all writers on `_write_lock` with
  commit/rollback; multi-statement mutations (`add_track_to_playlist`,
  `add_tracks_to_playlist`, `reorder_playlist`, `delete_track_master`) each run inside one
  block. `reorder_playlist`'s two-phase negative-parking is correct.
- **SQL construction.** No user input is ever interpolated. `_CATALOG_SORTS` /
  `_ADMIN_TRACK_SORTS` are whitelist lookups with a safe default; every `f"""…"""` splices
  only literals or `?` placeholders; `list_catalog_by_video_ids` builds its `IN` list from
  `",".join("?" …)`.
- **Bounds and clamping.** `limit`/`offset`/`window_days` are clamped in every list endpoint
  (`catalog/tracks` 1-500, `library` 1-10000, `search` 1-50, `albums/*` 1-16,
  `daily-mixes` count 1-8 / size 5-60, `me/stats` 0-3650, `activity`/`recent` capped);
  negatives and overflow values are absorbed, non-numeric input 422s via Pydantic.
  `_cap_import_tracks` bounds imports at `MAX_IMPORT_TRACKS`. No unbounded list endpoint
  except the `/api/jobs` cap noted in L5.
- **Job state machine.** `queued → downloading → (merging|transcoding) → done|error|cancelled`
  is consistent across `db.py`, `types.ts` `JobStatus` and `STATUS_STYLES`; `cancel` and
  `delete` correctly 409 on the wrong state; `init()` sweeps in-flight rows to `interrupted`
  on restart; the reaper cleans `_jobs`/`_cancelled`/tmp dirs on every terminal path.
- **`_ProgressHub`.** Fan-out, `call_soon_threadsafe` bridging, and subscribe/unsubscribe are
  correctly locked; the `_wait_disconnect` racer frees the socket promptly and `finally`
  always unsubscribes. Only the ordering issue in M7 applies.
- **`SlidingWindowLimiter`** — fully locked, self-pruning, bounded.
- **`stream_track` Range handling** — units check, suffix-range (`bytes=-N`) per RFC 7233,
  416 with `Content-Range: bytes */size`, correct `Content-Length`.
- **Response-shape parity** for `/api/library`, `/api/catalog/tracks`, `/api/me/recent`,
  `/api/me/stats`, `/api/activity`, `/api/playlists`, `/api/playlists/{id}`,
  `/api/catalog/{discover,category,radio,daily-mixes,suggestions}`, `/api/albums/*`,
  `/api/resolutions`, `/api/admin/*` — verified field-by-field against `types.ts`. Extra
  server fields (`height`/`codec_rank`/`size_bytes` on formats, `uploader`/`artists`/`album`
  on playlist tracks, `play_count`/`last_played_at` on recent) are additive and harmless;
  `is_owner` is coerced to a real bool on both the list and detail endpoints.

### Not examined

Authentication and session handling (`auth.py`, `homeauth.py`, `media_token.py`,
`auth_routes.py`), CORS/cookie posture, and the SPA-fallback path traversal guard — the
security lane owns these. Capacitor/native specifics, the offline download manager's
filesystem layer (`storage.ts`, `OfflineProvider.tsx`), player/MediaSession behaviour, and
all styling/layout — the UX lane owns these. `ytDownloaderFunctions.py`'s yt-dlp/ffmpeg
invocation internals were read only where they define a response shape.
