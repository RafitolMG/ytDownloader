# Improvement Backlog

This is the curated, deduplicated improvement backlog for ytDownloader, distilled from 47 raw ideas. Five concept pairs were merged into single canonical items (player-state persistence, playback hotkeys, skeleton loaders, route code-splitting, sleep timer), the editorial REVIEW NOTE was acted on and dropped, and every surviving item was spot-checked against the real tree on `develop`. Two grounding corrections were applied: `/api/preview/{video_id}` is auth-gated (so it cannot serve anonymous public-playlist viewers as one idea assumed), and CatalogPage thumbnails already carry `loading="lazy"` (so that half of the image-bandwidth idea was already shipped and was narrowed out). Items are organized by track, then ranked by impact-to-effort in the Top 10. Glyphs are drawn only from the approved Vaporwave palette; no emoji.

## Features

### Artist pages: group the catalog by artist with a dedicated route
- **Problem:** `db.list_tracks_by_artist()` (backend/src/db.py:899) exists and catalog rows carry artist, but clicking an artist navigates nowhere and there is no `/artist` route. The radio endpoint already computes "more like this" but is buried in a context menu.
- **Proposal:** Add `GET /api/catalog/artist/{name}` returning owned + catalog tracks, derived albums, and external radio candidates. Add `/artist/:name` -> ArtistPage with a hero header, owned-tracks list reusing CatalogRow, an albums strip, and a "more from this artist" external strip. Make artist text in the row/player components a NavLink.
- **Files:** backend/src/api/routes.py, backend/src/db.py, frontend/src/app/router.tsx, frontend/src/pages/ArtistPage.tsx (new), frontend/src/shared/api/client.ts, frontend/src/shared/api/types.ts, frontend/src/pages/CatalogPage.tsx, frontend/src/features/player/PlayerBar.tsx
- **Effort:** M
- **Impact:** 4
- **Risk:** `list_tracks_by_artist` matches `t.artist` exactly (the ", "-joined string), so a track credited "A, B" won't appear under "A". Mitigate with a token/LIKE match or the pages look sparse.
- **Depends on:** Benefits from "Inline track metadata correction" for clean artist data.

### Listening "Wrapped" / stats page (year + all-time)
- **Problem:** `GET /api/me/stats` (routes.py:1187, `window_days<=0` = all-time) already returns total_plays, top_tracks, top_artists, but the frontend only renders tiny 30-day carousels on the catalog home. No dedicated destination, no all-time view.
- **Proposal:** Add a `/stats` route -> StatsPage with a 7d/30d/365d/ALL window switcher, a big total-plays counter, ranked top-artists, and a play-all-able top-tracks grid. Add a "stats" entry (glyph ★) to NavTabs. Reuse `api.myStats(windowDays)`; pass 0 for all-time (already supported server-side).
- **Files:** frontend/src/pages/StatsPage.tsx (new), frontend/src/app/router.tsx, frontend/src/shared/ui/NavTabs.tsx, frontend/src/shared/api/client.ts, frontend/src/pages/CatalogPage.tsx
- **Effort:** S
- **Impact:** 4
- **Risk:** Low; read-only per-user. Show an empty-state for new users.
- **Depends on:** —

### Auto-radio: keep playing related tracks when the queue ends
- **Problem:** When a queue finishes, `advanceOrReshuffle()` in AudioPlayerProvider just stops (unless repeat='all'). The radio endpoint (routes.py:1246, `/api/catalog/radio/{video_id}`) already returns playable catalog tracks for any seed, but is only invoked from a context menu.
- **Proposal:** Add an autoplay toggle (∞ glyph, persisted) to PlayerBar transport. When on and the queue hits its tail, fetch `api.radio(current.video_id)` and enqueue only the returned playable `db[]` tracks (externals ignored — no silent downloads). Guard loops by tracking seen video_ids; debounce so a burst of queue-ends doesn't stack yt-dlp `related()` calls.
- **Files:** frontend/src/features/player/AudioPlayerProvider.tsx, frontend/src/features/player/PlayerBar.tsx, frontend/src/shared/api/client.ts
- **Effort:** M
- **Impact:** 5
- **Risk:** `radio()` does a yt-dlp `related()` call (1-3s) on a datacenter IP; 900s server cache exists but debounce/once-per-tail on the client. Only enqueue `db[]` so no unexpected downloads.
- **Depends on:** —

### Save the current play queue as a playlist
- **Problem:** The in-memory player queue and persisted playlists are separate systems. A hand-built queue (play/enqueue/radio) cannot be saved without re-adding each track one at a time. `createPlaylist` + `addToPlaylist` already exist.
- **Proposal:** Add a "save queue as playlist ⊕" action to the PlayQueuePanel header (and the NowPlayingView if built). Open the create dialog pre-seeded, then `createPlaylist` + sequential `addToPlaylist` over `orderedQueue` (skipping preview-codec tracks), then navigate to the new playlist.
- **Files:** frontend/src/features/player/PlayerBar.tsx, frontend/src/features/playlists/AddToPlaylistMenu.tsx, frontend/src/shared/api/client.ts
- **Effort:** S
- **Impact:** 4
- **Risk:** Preview-codec entries have no DB row and 404 on add — filter them and surface "N preview tracks skipped". Cap large queues / show progress.
- **Depends on:** —

### Persist & restore player state (queue, position, modes) across reload
- **Problem:** AudioPlayerProvider keeps queue/order/pos/shuffle/repeat/volume/position in React state with zero persistence (no localStorage in frontend/src). Reload wipes the queue, position, and resets volume — the single biggest barrier to the streaming roadmap's "resume where I left off".
- **Proposal:** Debounce a compact snapshot to localStorage (`ytdl.player.v1`) on change; on mount rehydrate paused (do NOT autoplay), rebuild queue by validating stored keys against `api.library()`, drop missing/preview tracks, restore volume/shuffle/repeat immediately, and seek to the saved position on first play. Persist volume separately so it survives a cleared queue.
- **Files:** frontend/src/features/player/AudioPlayerProvider.tsx, frontend/src/features/player/PlayerBar.tsx
- **Effort:** M
- **Impact:** 5
- **Risk:** Stale keys (deleted/un-owned) — validate against library and drop. Restore paused (browser autoplay policy).
- **Depends on:** — (merged from the duplicate ux/feature pair; richer ux version kept.)

### Sleep timer with countdown UX
- **Problem:** No way to stop playback after a set time; the only timer in AudioPlayerProvider is the play-recording timer.
- **Proposal:** Add `setSleepTimer(minutes | 'endOfTrack' | null)` to AudioPlayerProvider; a single re-armed `setTimeout` calls `pause()` (not stop, so the queue survives), or a ref flag checked in `onEnded` for end-of-track. Expose `remainingMs`. Add a ◑ glyph button in PlayerBar opening a popover (15/30/60 / end of track / off) with a live `tabular-nums` countdown (text-cool, text-sun under 1 min). Session-scoped.
- **Files:** frontend/src/features/player/AudioPlayerProvider.tsx, frontend/src/features/player/PlayerBar.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Background `setTimeout` throttling causes drift; acceptable for sleep, and end-of-track mode sidesteps it. Clear on track change/stop/logout.
- **Depends on:** — (merged superset of the two sleep-timer ideas.)

### Inline track metadata correction (title / artist / album / year)
- **Problem:** YouTube metadata is noisy ("(Official Video)", channel-as-artist). No UPDATE-tracks path exists (no `update_track` in db.py/routes.py). Bad metadata degrades albums, the proposed artist pages, lyrics matching, and stats.
- **Proposal:** Add `db.update_track_metadata(...)` writing only provided fields, exposed as `PATCH /api/catalog/tracks/{video_id}/{codec}/{bitrate}` with existing video-id validation. Gate v1 to `require_admin` (shared content-addressed master rows). Frontend: an "edit ▤" affordance opening a small inline form, invalidating `['catalog']`/`['library']`/`['album']`.
- **Files:** backend/src/db.py, backend/src/api/routes.py, frontend/src/pages/CatalogPage.tsx, frontend/src/shared/api/client.ts, frontend/src/shared/api/types.ts
- **Effort:** M
- **Impact:** 4
- **Risk:** One user's edit changes the title everyone sees — gate to admins (or "suggest correction"). Metadata-only UPDATE keeps content-addressing/sha256 intact.
- **Depends on:** — (foundation for artist pages, lyrics, stats quality.)

### Smart auto-playlists (saved rules over your library)
- **Problem:** Playlists are entirely manual. Data for dynamic lists already exists: `top_played_tracks`, `list_recent_plays`, recent additions, release_year/album. No "recently added", "most played", or "on-repeat" lists.
- **Proposal:** Add `GET /api/me/smart/{kind}` (recently-added, most-played, recently-played, on-repeat) returning `CatalogItem[]` from existing db helpers; pin them as virtual cards on PlaylistsPage opening a read-only SmartPlaylistPage with play-all. No new tables.
- **Files:** backend/src/api/routes.py, backend/src/db.py, frontend/src/pages/PlaylistsPage.tsx, frontend/src/pages/SmartPlaylistPage.tsx (new), frontend/src/app/router.tsx, frontend/src/shared/api/client.ts, frontend/src/shared/api/types.ts
- **Effort:** M
- **Impact:** 4
- **Risk:** Mostly reuses existing queries; keep limits <=100 to avoid correlated-subquery cost on large libraries.
- **Depends on:** —

### Cookie-expiry pre-warning in the admin System panel + extraction health detail
- **Problem:** YouTube cookies.txt is the most fragile prod dependency (datacenter IP triggers the n-sig challenge). The admin `/system` endpoint (admin_routes.py:154) reports only configured/source/decode-error and a binary probe — nothing parses cookie expiry, so admins learn cookies lapsed only after extraction 503s.
- **Proposal:** Parse the resolved Netscape cookies.txt (5th tab field = unix expiry) in `/system`: return min/median expiry, days_remaining, expired_count. AdminPage System tab renders a status row (text-cool >14d, text-sun ⚠ <14d, text-crit if any expired). Pure file parse via `_resolve_cookies_file()` — no yt-dlp call. Optionally expose days_remaining on `/api/health/extraction`.
- **Files:** backend/src/api/admin_routes.py, backend/src/ytDownloaderFunctions.py, frontend/src/pages/AdminPage.tsx, frontend/src/shared/api/types.ts
- **Effort:** S
- **Impact:** 4
- **Risk:** Cookie formats vary (`#HttpOnly_` prefix; session cookies expiry 0) — parse defensively, ignore expiry==0, fail soft to the binary status. Never return cookie values.
- **Depends on:** —

### Public playlist share links (read-only, unauthenticated view)
- **Problem:** Playlists support `visibility='public'` and `_ensure_playlist_visible()` (routes.py:1519) lets anyone view a public playlist, but `/playlists/:id` is behind RequireAuth and there is no share surface or public landing.
- **Proposal:** Add `GET /api/public/playlists/{id}` (unauthenticated, 404 unless public) returning PlaylistDetail minus owner controls/PII. Add an unauthenticated route `/p/:id` -> PublicPlaylistPage and a "copy share link ◈" button shown only when public.
- **Files:** backend/src/api/routes.py, frontend/src/app/router.tsx, frontend/src/pages/PublicPlaylistPage.tsx (new), frontend/src/pages/PlaylistDetailPage.tsx, frontend/src/shared/api/client.ts, frontend/src/shared/api/types.ts
- **Effort:** M
- **Impact:** 4
- **Risk:** GROUNDING CORRECTION — the raw idea assumed anonymous playback could route through `/api/preview`, but `/api/preview/{video_id}` is auth-gated (`Depends(current_user)`, routes.py:1820). v1 must therefore expose metadata only (no anonymous audio), or add a separate explicitly-scoped public preview path. Confirm no owner_id/PII in the payload.
- **Depends on:** —

### Export / import playlists (portable JSON)
- **Problem:** Playlists are fully CRUD-able but have no backup/portability. Content-addressed shared storage makes importing cheap (tracks usually already exist).
- **Proposal:** Frontend-only v1: an "export" button downloading `{name, description, tracks:[{video_id,codec,bitrate,title,artist}]}` as a Blob; an "import" action on PlaylistsPage that `createPlaylist` + `addToPlaylist`s each key, links existing catalog tracks instantly, and surfaces missing ones as "N not in catalog yet" with a one-tap validated download.
- **Files:** frontend/src/pages/PlaylistDetailPage.tsx, frontend/src/pages/PlaylistsPage.tsx, frontend/src/shared/api/client.ts
- **Effort:** M
- **Impact:** 3
- **Risk:** Missing tracks only play after a real validated download — make explicit; cap import size to avoid a yt-dlp flood on the datacenter IP.
- **Depends on:** —

### Lyrics panel (LRCLIB time-synced + plain fallback)
- **Problem:** Tracks carry title + artist + duration_sec — everything needed for lyrics — but there is no lyrics surface. LRCLIB is a free, key-less, ARM-friendly HTTP API (not YouTube, so no n-sig/cookie exposure).
- **Proposal:** Add `GET /api/track/{video_id}/lyrics?codec&bitrate` proxying LRCLIB server-side with a small TTL cache (mirroring search.py's `_TTLCache`). Frontend: a "lyrics" toggle in PlayerBar opening a portal panel that highlights synced lines on `player.position` when LRC timestamps exist, else plain text, else "no lyrics found". Only catalog tracks (existing checks); no user URLs reach an extractor.
- **Files:** backend/src/api/routes.py, backend/src/search.py, frontend/src/features/player/PlayerBar.tsx, frontend/src/features/player/AudioPlayerProvider.tsx, frontend/src/shared/api/client.ts, frontend/src/shared/api/types.ts
- **Effort:** M
- **Impact:** 3
- **Risk:** LRCLIB matches on noisy title/artist text (feat./remix) — expect misses, fail soft. Add a timeout and the same rate-limit posture as other outbound calls.
- **Depends on:** Benefits from "Inline track metadata correction".

### Installable PWA (offline shell + add-to-home, lock-screen polish)
- **Problem:** No PWA manifest or service worker (public/ has only favicon.svg, no manifest in index.html). MediaSession is already wired for lock-screen controls, so installability is the natural next step for a phone-first music app.
- **Proposal:** Add vite-plugin-pwa with a vaporwave manifest (theme #ff2975 / bg #0d0420, maskable icons, standalone). Network-first runtime cache for safe-to-stale `/api` GETs, precache the app shell; never cache `/api/track`, `/api/preview`, `/api/auth`, or the WS path. Add a "⬇ install app" affordance wired to `beforeinstallprompt`.
- **Files:** frontend/vite.config.ts, frontend/package.json, frontend/index.html, frontend/public/manifest.webmanifest (new), frontend/src/shared/ui/AppHeader.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** Mis-scoped SW can serve stale auth-sensitive responses — explicitly exclude auth/stream/preview/WS; verify the 401 redirect still works through the SW.
- **Depends on:** —

## Performance

### Per-user rate limiting on yt-dlp-bound endpoints
- **Problem:** No rate limiting anywhere in the backend. Every yt-dlp-bound endpoint (`/api/resolutions`, `/api/search`, `/api/catalog/discover`, `/api/albums/search`) spawns a 1-5s subprocess and pays the n-sig cost on the datacenter IP. One user spamming search or scripting `/api/resolutions` can saturate the threadpool AND trip YouTube's bot defenses against the shared cookies — self-DoS for everyone.
- **Proposal:** Add an in-process per-user sliding-window/token-bucket limiter (keyed by `user_id`, ~20 yt-dlp calls / 60s, env-configurable) as a FastAPI dependency on the extraction endpoints. Apply AFTER the TTL-cache short-circuit so cache hits never count. Return 429 + Retry-After; SPA shows a "slow down ⚠" toast. Memory-only, exempt admin probes.
- **Files:** backend/src/api/routes.py, backend/src/search.py, backend/src/config.py
- **Effort:** M
- **Impact:** 5
- **Risk:** Too-tight limit frustrates rapid browsing — tune generously and count only cache-miss extractions. Key on user_id (everyone is behind HomeAuth). Stacks cleanly with the extraction threadpool (limiter caps demand, pool caps concurrency).
- **Depends on:** —

### Offload synchronous yt-dlp handlers to a bounded threadpool
- **Problem:** `/api/resolutions` (routes.py:185, plain `def`) and `/api/search`/`/api/albums/*` call yt-dlp subprocesses (1-5s) inline. FastAPI runs sync handlers on a shared 40-thread anyio pool; a burst of these blocks slots and stalls cheap DB endpoints (library/catalog/playlists) on the same pool.
- **Proposal:** Add a bounded `EXTRACTION_POOL` (~4 workers, sized to ARM cores) in a new backend/src/extraction_pool.py. Convert the yt-dlp-bound handlers to `async def` and `run_in_executor(EXTRACTION_POOL, fn, ...)`, preserving the TTL-cache short-circuit and `_validate_youtube_url` before dispatch. Add a per-request timeout returning 504.
- **Files:** backend/src/api/routes.py, backend/src/extraction_pool.py (new), backend/src/search.py
- **Effort:** M
- **Impact:** 5
- **Risk:** async + run_in_executor risks ordering/exception bugs; keep cache hits instant before submitting. Tune pool size to core count.
- **Depends on:** Pairs with per-user rate limiting.

### Replace correlated owner_count/is_owned subqueries in list_catalog with a single GROUP BY join
- **Problem:** `list_catalog` (db.py:721-783) computes owner_count and is_owned as per-row correlated subqueries (db.py:771,776). At limit 300-500 (catalog, suggestions, radio, daily-mixes all funnel through it) that is 600-1000 subquery executions per request.
- **Proposal:** Rewrite to a single pass: `LEFT JOIN track_owners` with `COUNT(o.owner_id)` and `MAX(CASE WHEN o.owner_id=:viewer THEN 1 ELSE 0 END)`, `GROUP BY (video_id,codec,bitrate)`. Validate with `EXPLAIN QUERY PLAN` against `idx_track_owners_track`; keep ORDER BY/LIMIT/OFFSET semantics.
- **Files:** backend/src/db.py
- **Effort:** M
- **Impact:** 4
- **Risk:** ORDER BY popular sorts by owner_count — ensure the aggregate alias is usable in ORDER BY and LIMIT applies after grouping. Verify with a read-only EXPLAIN + before/after row-count compare; mind the title/artist LIKE filter interacting with GROUP BY.
- **Depends on:** — (this is the root fix the daily-mixes precompute idea builds on.)

### Precompute daily-mixes and suggestions on a background refresher
- **Problem:** `/api/catalog/daily-mixes` (routes.py:1356) and `/api/catalog/suggestions` (routes.py:1097) read `list_catalog` at limit 400-500 (~800-1000 subqueries) plus `related_many()` (4-6 yt-dlp calls) on every home-screen hit. The catalog body is global and `day_seed` rotates only once per day, so almost all work is recomputed identically per user.
- **Proposal:** Cache the viewer-independent heavy part (popular pool + `related_many()`) once per `day_seed` in a `_TTLCache` (new mixes_cache.py); per request, run only the cheap personalization layer (`top_played_artists` + is_owned overlay via `list_catalog_by_video_ids`, db.py:787) on the chosen video_ids.
- **Files:** backend/src/api/routes.py, backend/src/mixes_cache.py (new), backend/src/search.py
- **Effort:** M
- **Impact:** 4
- **Risk:** Keep personalization outside the shared cache. Mid-day catalog additions won't appear until the next rotation — acceptable, document it.
- **Depends on:** Best done after the GROUP BY rewrite (smaller win once subqueries are gone, but cuts the yt-dlp calls regardless).

### Route-level code splitting (per-page chunks + themed Suspense fallback)
- **Problem:** router.tsx statically imports all nine pages (verified, lines 2-10), so Vite emits one ~411kB bundle and ships AdminPage to every non-admin user up front. No Suspense fallback exists, so first navigation to a heavy page flashes blank.
- **Proposal:** Convert each page import to `React.lazy(() => import(...))` and wrap `<Routes>` in a `<Suspense>` with a themed font-pixel "░▒▓ loading ▓▒░" fallback (reusing the Skeleton component). Keep LoginPage eager and RequireAuth/RequireAdmin outside the lazy boundary. Optionally add a `manualChunks` vendor split in vite.config.ts. Ensure ErrorBoundary still catches chunk-load failures.
- **Files:** frontend/src/app/router.tsx, frontend/vite.config.ts, frontend/src/shared/ui/Skeleton.tsx
- **Effort:** S
- **Impact:** 4
- **Risk:** Fallback flash on first navigation — mitigate with the themed splash and optional Catalog prefetch after paint.
- **Depends on:** — (merged from the perf + ui code-split pair; ui's themed-fallback detail folded in.)

### Bound the search/album TTL caches to prevent unbounded memory growth
- **Problem:** `_TTLCache` (search.py:31) evicts only on TTL read, never on size. `_SUGGEST_CACHE`/`_SEARCH_CACHE`/`_RELATED_CACHE`/`_ALBUM_*_CACHE` (60s-1800s) grow without limit on user-controlled keys — a real OOM risk on the small Oracle ARM box over long uptime.
- **Proposal:** Add a `max_entries` cap to `_TTLCache.set()` (e.g. 500 search/suggest, 200 albums), evicting the oldest by insertion order. Keep TTL behaviour; optionally add a periodic expired-key sweep. ~10-line isolated change.
- **Files:** backend/src/search.py
- **Effort:** S
- **Impact:** 3
- **Risk:** Low/additive; only risk is evicting a hot entry under heavy distinct-query load (self-correcting). Size generously.
- **Depends on:** —

### Signal WebSocket progress with an event instead of busy-polling every 100ms
- **Problem:** `progress_ws` (routes.py:831) runs `get_nowait()`/`sleep(0.1)` per job, waking the loop 10x/sec per watched job even when idle, adding up to 100ms event latency.
- **Proposal:** Keep the thread-safe `queue.Queue` but store an `asyncio.Event` per job in `_jobs`, set it from the worker via `loop.call_soon_threadsafe(event.set)` after each put, and replace the sleep with `await asyncio.wait_for(event.wait(), timeout=1.0)` (the 1s timeout bounds terminal-state detection).
- **Files:** backend/src/api/routes.py
- **Effort:** M
- **Impact:** 3
- **Risk:** Cross-thread signalling must use `call_soon_threadsafe` with the captured loop; the bounded `wait_for` timeout is the safety net against a missed signal.
- **Depends on:** —

### React Query stale/gc tuning + shared <Thumb> placeholder
- **Problem:** Ad-hoc staleTimes across pages; the 0s `['jobs']` query plus per-page polling means overlapping intervals hammer `/api/jobs`, and CatalogPage/LikedSongsPage/AlbumsPage/PlaylistsPage each independently mount `['library']`. (Note: thumbnail `loading="lazy"` is ALREADY shipped on CatalogPage rows — verified — so the image-bandwidth half of the original idea is dropped; only the React Query consolidation and a `<Thumb>` gradient placeholder remain.)
- **Proposal:** Centralize a single jobs-polling owner (drive `['jobs']` `refetchInterval` only from `useJobs`/QueueIndicator; other pages read cache with a sane staleTime) and set default `staleTime` (~15s) + `gcTime` in the QueryClient. Add a small `<Thumb>` component rendering a card-vapor gradient placeholder until load, applied where thumbnails lack one.
- **Files:** frontend/src/shared/api/useJobs.ts, frontend/src/app/providers.tsx, frontend/src/shared/ui/Thumb.tsx (new), frontend/src/pages/CatalogPage.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Consolidating jobs polling must not break live progress — keep the `useLiveJobProgress` WS path untouched, only dedupe the REST poll.
- **Depends on:** —

### Move blocking os.path.isfile() loop in admin tracks listing off the request thread
- **Problem:** admin_routes.py:73 loops `os.path.isfile(row['file_path'])` over up to 200 rows synchronously per Storage-tab load/sort/filter — up to 200 serialized stat() calls, worse on a Coolify overlay mount.
- **Proposal:** Wrap the stat loop in `asyncio.to_thread` (after making the handler async) and add a 30s `_TTLCache` for `file_path -> bool` to dedupe repeated loads. Keep `require_admin`.
- **Files:** backend/src/api/admin_routes.py
- **Effort:** S
- **Impact:** 2
- **Risk:** Admin-only, bounded. A cached `file_exists` can be ~30s stale after an out-of-band deletion — acceptable.
- **Depends on:** —

### Garbage-collect abandoned job state and leaked tmp_dirs on a periodic sweep
- **Problem:** `_jobs` (routes.py:124) entries are removed only when `/api/file/{job_id}` serves+cleans them; errored/cancelled/never-fetched jobs leave a `queue.Queue` + tmp_dir resident forever, and `/tmp/ytdl_*` dirs (mkdtemp at routes.py:247) leak disk on a crash. A slow memory leak over weeks of ARM uptime.
- **Proposal:** Add an asyncio reaper (every ~10min) that, for terminal jobs older than a 1h grace, `rmtree`s the tmp_dir and pops `_jobs`/`_cancelled`; on startup, scan the `ytdl_` prefix and remove dirs with no active job. The WS snapshot path already falls back to DB.
- **Files:** backend/src/api/routes.py
- **Effort:** M
- **Impact:** 2
- **Risk:** Must not delete tmp_dirs for jobs still streaming to a not-yet-connected WS client — the 1h grace + terminal-status check guards this; startup scan targets only the `ytdl_` prefix.
- **Depends on:** —

### Virtualize the long unvirtualized lists (catalog 300, library/liked 500, admin 200)
- **Problem:** No list virtualization anywhere. CatalogPage renders up to 300 rows, LikedSongs/Albums up to 500, AdminPage tables up to 200 — each row mounting interactive children, atop paint-heavy scanline/chromatic-aberration filters. Scroll jank and slow mount on low-power devices.
- **Proposal:** Introduce a windowing primitive (@tanstack/react-virtual, consistent with the existing react-query stack, or a hand-rolled fixed-height windowed list) for the catalog list, liked list, and admin tables. Keep row markup/styling identical; only the container becomes a virtualized scroller. Leave the short carousels and drag-reorder playlist as-is.
- **Files:** frontend/src/pages/CatalogPage.tsx, frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/AdminPage.tsx, frontend/src/shared/ui/VirtualList.tsx (new)
- **Effort:** L
- **Impact:** 3
- **Risk:** Variable-height rows mis-position with naive windowing — start fixed-height; exclude drag-reorder; keep sticky headers/play-all outside the scroller.
- **Depends on:** —

## UX

### Undo toast for destructive library/playlist removals
- **Problem:** Removing a liked song fires `api.removeFromLibrary` immediately with no confirmation or undo; the only Toast variant is ErrorToast (crit-only). An accidental ♥ tap silently drops a track with no feedback channel.
- **Proposal:** Generalize Toast.tsx into an ActionToast (variant info/success/err + optional action button, ↺ glyph for undo) via a lightweight ToastContext in providers.tsx. On liked/playlist removal, optimistically remove the row and show "removed - ↺ undo" for ~6s; undo re-calls `addToLibrary`/playlist-add with the captured key.
- **Files:** frontend/src/shared/ui/Toast.tsx, frontend/src/app/providers.tsx, frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/PlaylistDetailPage.tsx
- **Effort:** M
- **Impact:** 4
- **Risk:** Re-adding needs the original codec/bitrate (the row already has it). Low.
- **Depends on:** — (this is the shared toast primitive several other items build on.)

### Surface download progress globally with a click-through to the track
- **Problem:** Download progress is only visible on QueuePage/QueueDrawer. After triggering a catalog download and navigating away, the only signal is the QueueIndicator badge count; finished jobs aren't auto-offered to the player.
- **Proposal:** Add a compact GlobalDownloadStrip above PlayerBar that, when active jobs exist, shows the newest active job's title + a font-pixel progress bar (reusing JobRow's `buildBar`) driven by `useLiveJobProgress`, linking to `/queue`. On an audio-import transitioning to "done", show a success ActionToast "added - ▶ play" that enqueues the freshly-owned track.
- **Files:** frontend/src/features/queue/useLiveJobProgress.ts, frontend/src/features/player/PlayerBar.tsx, frontend/src/shared/ui/QueueIndicator.tsx, frontend/src/app/providers.tsx
- **Effort:** L
- **Impact:** 4
- **Risk:** Picking "the newest active job" across concurrent downloads needs a small read-only selector; re-derive each poll to tolerate races.
- **Depends on:** Undo toast (ActionToast primitive).

### Bulk multi-select on library / liked / catalog rows
- **Problem:** Every action is per-row; removing 20 likes or adding 15 tracks to a playlist is 15-20 menu interactions. No selection state exists.
- **Proposal:** Add a "SELECT" mode toggle on LikedSongs and Catalog. In mode, rows show a ◉/○ toggle and a sticky action bar appears: "add to playlist ⊕", "enqueue ≣", "remove ✕" (with batch undo). Selection is a Set of keys; reuses per-track endpoints in a loop for v1.
- **Files:** frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/CatalogPage.tsx, frontend/src/features/playlists/AddToPlaylistMenu.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** Looping endpoints is many round-trips/partial-failure prone — `Promise.allSettled`, report "M of N", cap the batch. Mode toggle must not break play-on-click.
- **Depends on:** Undo toast (batch undo).

### Library sort + filter on Liked Songs
- **Problem:** LikedSongsPage supports only a client-side substring filter, no sort, raw API order. The catalog has sorts; a user's own up-to-500-track library has none.
- **Proposal:** Add a font-pixel RECENT/TITLE/ARTIST segmented control sorting the memoized `filtered` array client-side (added_at desc default), plus an optional artist quick-filter chip row from distinct artists. Persist the choice to localStorage.
- **Files:** frontend/src/pages/LikedSongsPage.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Needs `added_at` on LibraryItem; fall back to API order for RECENT if absent.
- **Depends on:** —

### Now-playing deep-link via shareable URL + ?play param
- **Problem:** No way to deep-link a track; playback only starts via in-page `player.play()`. No copy-link affordance — blocks "listen to this" sharing between same-HomeAuth users.
- **Proposal:** Add a `?play=<video_id>/<codec>/<bitrate>` handler that on mount fetches the matching item and calls `play([item])`, then strips the param via `history.replaceState`. Add a "share" button to PlayerBar/row menus copying the link and showing the success ActionToast.
- **Files:** frontend/src/features/player/AudioPlayerProvider.tsx, frontend/src/features/player/PlayerBar.tsx, frontend/src/app/router.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** If the linked track isn't owned by the recipient the stream 403s — fall back to preview or an adopt prompt.
- **Depends on:** Undo toast (ActionToast).

### Mobile swipe gestures for player transport and queue
- **Problem:** No swipe gestures; mobile relies on small tap targets, and shuffle/repeat are hidden on mobile.
- **Proposal:** Add lightweight touch handlers to the PlayerBar cover+title cluster only: swipe-left/right = next/prev, swipe-up/down = open/close the queue panel (threshold ~50px, directional ratio guard). Keep all buttons; leave desktop untouched.
- **Files:** frontend/src/features/player/PlayerBar.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** Swipe vs scroll conflict — scope to the metadata cluster with a clear directional threshold.
- **Depends on:** —

## UI

### Expanded "Now Playing" view (full-screen on mobile, side panel on desktop)
- **Problem:** The only expanded surface is the narrow PlayQueuePanel. Cover art renders tiny, title/artist truncate to one line, and there is nowhere for album, large transport, or lyrics-space — the central roadmap gap for an in-app streaming product.
- **Proposal:** Add features/player/NowPlayingView.tsx: a portal'd overlay opened from an expand glyph in PlayerBar. Full-screen on mobile, centered card-vapor panel on desktop. Large cover, ChromaticTitle, artist · album · year, a tall seek bar reusing the existing seek logic, large transport, shuffle/repeat/volume, and the inline queue. All state already on `useAudioPlayer`.
- **Files:** frontend/src/features/player/NowPlayingView.tsx (new), frontend/src/features/player/PlayerBar.tsx
- **Effort:** L
- **Impact:** 5
- **Risk:** Portal + scroll-lock must not trap focus or leak body scroll; Escape closes; reduced-motion skips the transition.
- **Depends on:** —

### Now-playing indicator on track rows (equalizer glyph for the active track)
- **Problem:** When a list track plays, rows give no signal which is live — only the PlayQueuePanel marks it. The player exposes `current` with a stable trackKey.
- **Proposal:** Add a shared NowPlayingTick (CSS 3-bar equalizer, cool color, reduced-motion -> static ▶) rendered in place of the row index/play glyph when a row's (video_id,codec,bitrate) matches `current`. Wire into CatalogRow, LikedRow, and PlaylistDetail TrackRow. Pure read of player state.
- **Files:** frontend/src/shared/ui/NowPlayingTick.tsx (new), frontend/src/index.css, frontend/src/pages/CatalogPage.tsx, frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/PlaylistDetailPage.tsx
- **Effort:** M
- **Impact:** 4
- **Risk:** Low; keep the animation GPU-cheap (`transform: scaleY`), static under reduced-motion.
- **Depends on:** —

### Visible focus rings + accessible names on all player/nav controls
- **Problem:** Transport buttons convey meaning only via `title` (no aria-label); the seek strip is a non-focusable `div` with `onClick`; no component defines a `focus-visible` style, so keyboard users get an often-invisible default ring on the dark bg.
- **Proposal:** Add a shared `focus-visible` utility in index.css (cyan glow ring + offset, sharp radius) applied to PlayerButton/PlayerToggle/NavLink/QueueIndicator. Add aria-label to every transport button. Make the seek bar a real `<input type=range>` (or `role=slider` with arrow handling) so it is reachable.
- **Files:** frontend/src/index.css, frontend/src/features/player/PlayerBar.tsx, frontend/src/shared/ui/NavTabs.tsx
- **Effort:** M
- **Impact:** 4
- **Risk:** Low; use `focus-visible` (not `focus`) so rings don't appear on mouse click.
- **Depends on:** —

### Global player-bar spacer so the fixed bar never overlaps page content
- **Problem:** PlayerBar is fixed-bottom and globally mounted with no layout offset; every page hardcodes `pb-32` to clear it. The bar grows taller on mobile and an expanded now-playing breaks the assumption, so the magic number drifts per page and content clips.
- **Proposal:** Render a single spacer div sized to the bar (`h-[var(--player-bar-h)]`) only when `p.current` is set, exported from the player feature; drop the per-page `pb-32`. Set `--player-bar-h` on `:root` and update it from PlayerBar via ResizeObserver (or fixed mobile/desktop values).
- **Files:** frontend/src/features/player/PlayerBar.tsx, frontend/src/index.css, frontend/src/pages/CatalogPage.tsx, frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/PlaylistDetailPage.tsx, frontend/src/pages/AlbumsPage.tsx
- **Effort:** M
- **Impact:** 4
- **Risk:** Touches many pages — verify no double-padding remains and the spacer collapses to 0 when nothing plays.
- **Depends on:** —

### Reusable skeleton component + consistent loading states across list pages
- **Problem:** Loading UX is split-brain: carousels use animate-pulse skeleton cards but the main catalog/category/radio views and Albums/Playlists/Liked fall back to bare "··· loading ···" text — inconsistent against the polished carousels.
- **Proposal:** Extract shared/ui/Skeleton.tsx with SkeletonRow (thumb + two text bars) and SkeletonCard (matching the carousel card), built with card-vapor + animate-pulse + border-border. Replace the text-only loading blocks on Catalog list/category/radio, Albums, Playlists, LikedSongs, PlaylistDetail with N matching skeletons; gate the pulse behind prefers-reduced-motion to a static dim.
- **Files:** frontend/src/shared/ui/Skeleton.tsx (new), frontend/src/pages/CatalogPage.tsx, frontend/src/pages/AlbumsPage.tsx, frontend/src/pages/PlaylistsPage.tsx, frontend/src/pages/LikedSongsPage.tsx, frontend/src/pages/PlaylistDetailPage.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** Skeleton dims drifting from real rows causes a small jump — match the existing aspect-video thumb + two text lines.
- **Depends on:** — (merged from the two skeleton ideas; the speculative "confirm-before-leave mid-seek-edit" half was dropped per the review note — the seek bar commits instantly, no edit buffer exists.)

### Keyboard shortcuts for playback (space / arrows / m)
- **Problem:** AudioPlayerProvider exposes togglePlay/next/prev/seek/setVolume/toggleShuffle/cycleRepeat but nothing binds keyboard to them — only QueueDrawer and AddToPlaylistMenu handle keydown (Esc).
- **Proposal:** Add a `useGlobalPlayerHotkeys()` hook mounted once: Space=togglePlay, Arrow L/R=seek ∓5s, Shift+Arrow=prev/next, Arrow U/D=volume, M=mute, S=shuffle, R=repeat. Guard against INPUT/TEXTAREA/contenteditable focus and require `p.current`; preventDefault only on Space. Add a "?" help affordance in the now-playing view listing the bindings.
- **Files:** frontend/src/features/player/useGlobalPlayerHotkeys.ts (new), frontend/src/features/player/PlayerBar.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Must not hijack typing in search/forms — the activeElement guard scopes it.
- **Depends on:** — (merged from the identical ux/ui hotkey pair; lighter S-effort framing kept.)

### Empty / first-run states across Browse, Albums, Playlists, Stats
- **Problem:** A brand-new user sees bare text fall-throughs ("no albums yet", "no playlists") and Browse sections that simply vanish when empty, leaving blank gaps with no guidance toward the bootstrapping action (capture a track).
- **Proposal:** Build a shared `<EmptyState>` (card-vapor panel, a ◈/⊕ glyph, font-pixel headline + sub-line, optional CTA NavLink styled like NavTabs active). Use it for the cold-start Browse home ("the catalog is empty — ▶ capture your first track"), Albums/Playlists/Liked empties, and the Stats empty ("listen to build your stats ★").
- **Files:** frontend/src/shared/ui/EmptyState.tsx (new), frontend/src/pages/CatalogPage.tsx, frontend/src/pages/AlbumsPage.tsx, frontend/src/pages/PlaylistsPage.tsx, frontend/src/pages/LikedSongsPage.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Low; only show the Browse-home empty when ALL sections are empty (true cold start), not during a brief carousel load.
- **Depends on:** —

### Themed two-step confirm for playlist delete (replace native window.confirm)
- **Problem:** PlaylistDetailPage deletes via native `window.confirm` (white system modal) — the only native confirm in the SPA, inconsistent with AdminPage's existing custom two-step ConfirmButton.
- **Proposal:** Extract AdminPage's ConfirmButton (click-to-arm "✕ cancel" + confirm, no native dialog) into shared/ui as `<ConfirmButton>` and use it in PlaylistDetailPage's delete handler; AdminPage imports the shared version to avoid divergence.
- **Files:** frontend/src/pages/AdminPage.tsx, frontend/src/pages/PlaylistDetailPage.tsx, frontend/src/shared/ui/ConfirmButton.tsx (new)
- **Effort:** S
- **Impact:** 3
- **Risk:** Extraction must preserve AdminPage's two-step behavior.
- **Depends on:** —

### Iconography consistency pass + a single shared glyph map
- **Problem:** Theme glyphs are inlined ad hoc and some break the documented set: volume uses ♪/♪̸ (off-palette, inconsistent strikethrough), repeat-one mixes ↻ with a superscript digit, prev/next differ from NavTabs' ▶. No central glyph source, so drift continues.
- **Proposal:** Create shared/ui/glyphs.ts exporting named constants from the approved palette (PLAY ▶, PAUSE ❚❚, PREV, NEXT, SHUFFLE ⇄, REPEAT ↺, QUEUE ≣, CLOSE ✕, EXPAND ▤, OWNED ◉, ADD ⊕, WARN ⚠, STAR ★, DOWNLOAD ⬇). Replace inline glyphs in PlayerBar/NavTabs; pick one volume/mute treatment from the allowed set.
- **Files:** frontend/src/shared/ui/glyphs.ts (new), frontend/src/features/player/PlayerBar.tsx, frontend/src/shared/ui/NavTabs.tsx
- **Effort:** S
- **Impact:** 3
- **Risk:** Cosmetic; verify chosen glyphs render in VT323.
- **Depends on:** —

### Larger touch target + drag-scrub for the seek bar on mobile
- **Problem:** The seek bar is a 1.5px-tall strip with a single onClick — far below the 44px touch guideline — and the thumb is hidden until group-hover (never triggers on touch), so mobile users get no scrub handle.
- **Proposal:** Wrap the 1.5px bar in a taller transparent hit area (py-2), add pointerdown/move/up handlers for drag-scrubbing with a live target-time preview, and always-show the thumb on coarse pointers. Reuse the existing ratio->seconds math; commit seek on pointerup or throttle.
- **Files:** frontend/src/features/player/PlayerBar.tsx
- **Effort:** M
- **Impact:** 3
- **Risk:** Pointer-capture must release cleanly; throttle preview so dragging stays smooth.
- **Depends on:** Overlaps with the focus-rings item (both make the seek bar a real control) — coordinate so the bar becomes a single accessible, scrub-able input.

## Top 10 — do these first

1. Per-user rate limiting on yt-dlp-bound endpoints — performance — M / 5 — protects the shared cookies/IP reputation, the single most fragile prod dependency, against self-DoS.
2. Persist & restore player state across reload — feature — M / 5 — removes the biggest barrier to the streaming roadmap's "resume where I left off"; pure frontend.
3. Auto-radio when the queue ends — feature — M / 5 — turns the app into continuous listening using an endpoint that already exists.
4. Route-level code splitting — performance — S / 4 — cheapest large win: splits the ~411kB bundle and stops shipping AdminPage to every user.
5. Listening "Wrapped" / stats page — feature — S / 4 — a whole feature for almost free; the stats endpoint already supports every window including all-time.
6. Save the current play queue as a playlist — feature — S / 4 — closes the listen->curate loop over existing APIs; small effort.
7. Cookie-expiry pre-warning in admin System panel — feature — S / 4 — turns the worst silent prod failure into an advance warning via a pure file parse.
8. Replace correlated subqueries in list_catalog with a GROUP BY join — performance — M / 4 — fixes the per-row subquery cost feeding every Browse/discover/radio/mixes endpoint.
9. Undo toast for destructive removals — ux — M / 4 — fixes a silent data-loss footgun and unlocks the ActionToast primitive several other items reuse.
10. Now-playing indicator on track rows — ui — M / 4 — high-visibility polish (you can finally see what's playing) over a pure read of existing player state.

## Quick wins

- Listening "Wrapped" / stats page — S, impact 4 — reuse an already-built endpoint.
- Save the current play queue as a playlist — S, impact 4 — frontend-only over existing APIs.
- Cookie-expiry pre-warning in admin System panel — S, impact 4 — pure file parse, admin-only.
- Route-level code splitting — S, impact 4 — one router.tsx change for a big bundle cut.
- Sleep timer with countdown UX — S, impact 3 — clean hook point in the provider.
- Bound the search/album TTL caches — S, impact 3 — ~10-line OOM guard.
- React Query stale/gc tuning + shared <Thumb> — S, impact 3 — stops `/api/jobs` poll storms.
- Library sort + filter on Liked Songs — S, impact 3 — client-side over the existing memo pipeline.
- Keyboard shortcuts for playback — S, impact 3 — pure leverage over existing player actions.
- Empty / first-run states — S, impact 3 — makes cold-start obvious and on-brand.
- Themed two-step confirm for playlist delete — S, impact 3 — removes the only native modal.
- Iconography consistency + shared glyph map — S, impact 3 — stops glyph drift.

## Deliberately not proposed

- **REVIEW NOTE: collapse the duplicate pairs** — acted on, not shipped as a backlog item. The five duplicate concepts (player persistence, hotkeys, skeletons, code-split, sleep timer) were merged into one canonical entry each and the weaker twins dropped, exactly as the note advised.
- **Confirm-before-leave while mid-seek-edit** (half of a raw ux item) — dropped: there is no edit buffer, the seek bar commits instantly, so the trigger does not exist. Only the skeleton-loaders half of that idea survived.
- **Thumbnail `loading="lazy"`** (half of the image-bandwidth perf idea) — dropped as already shipped: CatalogPage rows already carry `loading="lazy"` (verified, 6 occurrences). Only the React Query consolidation + `<Thumb>` placeholder were kept.
- **Anonymous audio playback for public playlists** — deliberately scoped out of v1: `/api/preview/{video_id}` is auth-gated, so the public share link is metadata-only until a separately-scoped public preview path is designed; exposing the existing preview/stream to anonymous viewers would leak the per-user library trust model.
- **Cross-user metadata editing without a gate** — not proposed open: master rows are shared and content-addressed, so inline metadata correction is gated to admins (or a suggest-correction flow) to prevent one user vandalizing the shared catalog.
