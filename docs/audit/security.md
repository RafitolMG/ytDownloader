# Security & data-isolation audit — ytDownloader (`develop`)

Scope: authorization, cross-user data isolation, media tokens & file serving, SSRF /
command injection through yt-dlp, secret & error leakage, session lifecycle, rate
limiting. Read-only audit; no source file was modified. `backend/.venv/bin/python -m
pytest -q` → **41 passed**.

## Executive summary

**9 findings: 1 High, 3 Medium, 5 Low. No Critical.**

The headline result is a negative one, and it is the most valuable part of this report:
**there is no IDOR and no cross-user data leakage.** Every route that takes an object id
from the path or body re-reads the row and enforces ownership (`_ensure_owner`,
`_ensure_playlist_owner`, `_ensure_playlist_visible`) or scopes the query by
`user.user_id` in `db.py` itself. There is no SQL injection, no path traversal, no
command injection, and no secret written to logs. The SSRF allow-list on yt-dlp URLs is
correct and already unit-tested.

Everything found is in the **abuse / availability** column, not the confidentiality one.

**The single most important thing to fix:** `POST /api/jobs/{job_id}/retry`
(`backend/src/api/routes.py:2514`) re-enters the download handlers by direct Python call,
so the `Depends(rate_limit_extraction)` budget on `/api/download` and
`/api/download-playlist` is never evaluated. That budget is the **only** per-user abuse
control in the app, and `backend/src/rate_limit.py:1-12` documents exactly what it
protects: the extraction threadpool and the *shared* YouTube cookies every user depends
on. Verified empirically: 120 retry calls in a row, budget = 40/min → limiter invoked
**0 times**, 120 jobs submitted, 120 temp directories created.

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | High | Extraction rate limit fully bypassed via job retry | `api/routes.py:2514` |
| 2 | Medium | Unauthenticated `/api/health/extraction` can wedge the request threadpool | `api/routes.py:2640` |
| 3 | Medium | No request-body size or string-field length limit anywhere | `api/routes.py` (all models) |
| 4 | Medium | Global login limiter lets anyone lock every user out of login | `api/auth_routes.py:95` |
| 5 | Low | `/api/auth/ping` is unauthenticated and discloses the internal HomeAuth URL | `api/auth_routes.py:182` |
| 6 | Low | `/api/catalog/radio/{video_id}` skips id validation → unbounded `_roll_memory` growth | `api/routes.py:1733`, `discovery.py:221` |
| 7 | Low | Media token is session-wide, 1 h, and travels in the query string | `media_token.py:48`, `config.py:50` |
| 8 | Low | Playlist `cover_url` is unvalidated and rendered to other users | `api/routes.py:2101` |
| 9 | Low | Upstream yt-dlp error text is reflected into HTTP bodies and job rows | `api/routes.py:448`, `:626` |

---

## Findings, by severity

### 1. `POST /api/jobs/{job_id}/retry` bypasses the extraction rate limit entirely — **High** — CONFIRMED

**Where:** `backend/src/api/routes.py:2514-2541` (`retry_job`), calling
`start_download` (`:474`) / `start_playlist_download` (`:771`).

**Defect:** `retry_job` declares only `Depends(current_user)`, then invokes the download
handlers as ordinary Python functions — `start_download(DownloadRequest(...), user=user)`
at `:2532`. FastAPI dependency injection does not run on a direct call, so the `_rl:
CurrentUser = Depends(rate_limit_extraction)` parameter keeps its default (a
`fastapi.params.Depends` object) and `_enforce_extraction_budget` (`:400`) is never
executed. The same call path also skips the limiter on the playlist branch (`:2526`).

**Verified:** with `RATELIMIT_PER_MIN=40`, 120 consecutive `retry_job()` calls produced
**0** limiter invocations and 120 submitted jobs; the same 45 calls through
`rate_limit_extraction` produced 45 checks and 5 × HTTP 429.

**Exploit:** any authenticated non-admin user creates one job (or reuses any finished
job they own), then loops `POST /api/jobs/{id}/retry`. Each call:
* immediately runs `tempfile.mkdtemp(prefix="ytdl_")` at `:502` (video/`as_file` jobs) —
  thousands of directories in the container temp dir; the reaper (`:270`) only collects
  *terminal* jobs older than one hour, and a queued job is never terminal;
* inserts a `jobs` row and an entry in the in-process `_jobs` dict (`:196`) — neither is
  bounded;
* queues work on `_download_pool`, so the pool's queue (unbounded) grows without limit
  while the box keeps feeding YouTube requests through the **shared cookies** the
  limiter exists to protect. Tripping YouTube's bot defences on those cookies breaks
  extraction for *every* user (`rate_limit.py:5-11` states this rationale explicitly).

**Impact:** platform-wide denial of service (inode/disk exhaustion, memory growth,
shared-cookie burn) triggerable by any logged-in user with a one-line loop.

---

### 2. Unauthenticated `/api/health/extraction` can stall every synchronous endpoint — **Medium** — CONFIRMED

**Where:** `backend/src/api/routes.py:2640-2657` (`_run_extraction_probe`),
`:2667` (`health_extraction`).

**Defect:** two compounding issues.
1. The TTL cache check sits **inside** `_health_probe_lock` (`:2644-2646`), so every
   concurrent caller blocks on the mutex for the full duration of an in-flight probe
   even when the answer is already cached (verified: `cache check inside lock: True`).
2. `get_basic_info()` (`ytDownloaderFunctions.py:667`) has no wall-clock timeout, and
   `_get_cookie_opts()` configures `retries: 5`, `fragment_retries: 10`,
   `extractor_retries: 3` with back-off up to 30 s per attempt
   (`ytDownloaderFunctions.py:168-175`). A degraded YouTube path can hold the lock for
   minutes.

`health_extraction` is a **sync** `def` with **no auth dependency** (verified:
`dependencies == []`), so each request occupies one worker of the shared anyio
threadpool (Starlette default: 40) — the same pool that serves `/api/library`,
`/api/catalog/tracks`, `/api/playlists`, `/api/jobs` and `/api/track/*/stream`.

**Exploit:** an anonymous client opens ~40 concurrent `GET /api/health/extraction`
requests. The first triggers the probe and holds the lock; the other 39 park on the
mutex holding threadpool workers. While the probe runs, *every* synchronous endpoint in
the app queues behind them. The window is normally 1-3 s per 5 min, but becomes
open-ended precisely when extraction is broken — i.e. the endpoint amplifies the
outage it exists to report.

**Impact:** unauthenticated availability degradation, worst-case full stall.

---

### 3. No request-body size limit and no length bound on any string field — **Medium** — CONFIRMED

**Where:** every Pydantic model in `backend/src/api/routes.py` (`PlaylistCreate:2004`,
`PlaylistUpdate:2010`, `TrackImportRequest:1110`, `DownloadRequest:334`,
`PlaylistTracksBulk:2150`, `PlaylistReorder:2023`). No `max_length` / `constr` anywhere
(`grep max_length backend/src/` → no matches), and the only middleware registered on the
app is `CORSMiddleware` (`:82`). Neither uvicorn nor FastAPI imposes a default body cap.

**Verified:** `PlaylistCreate(name="A"*2_097_152, description=...)` and
`TrackImportRequest(source="B"*5_242_880)` are both accepted by the models.

**Exploit:** an authenticated user POSTs `/api/playlists` with a multi-megabyte `name`
and `description`; `db.create_playlist` (`db.py:1237`) writes it verbatim into SQLite.
There is also no cap on how many playlists one user may own (no `MAX_PLAYLIST*` anywhere),
so this loops. `POST /api/import/tracklist` is worse: `spotify.from_text`
(`spotify.py:165`) runs `csv.reader(io.StringIO(body))` and `splitlines()` over the whole
string in memory, then builds one `WantedTrack` per line, before `_cap_import_tracks`
(`:381`) ever sees the list — so the cap bounds downloads, not parsing.
`PlaylistTracksBulk.tracks` and `PlaylistReorder.order` are likewise unbounded lists.

**Impact:** disk exhaustion of the `/app/data` volume and memory spikes on the small
Oracle ARM box, from any authenticated user. On the shared SQLite file this also
degrades every other user's reads.

---

### 4. The global login limiter lets any unauthenticated client lock everyone out — **Medium** — CONFIRMED

**Where:** `backend/src/api/auth_routes.py:95-102`, `config.py:149-151`.

**Defect:** `_login_global_limiter.check("*")` shares one 60-events-per-300 s window
across *all* accounts, and a rejection is a hard 429 for everyone — there is no
distinction between "an account under attack" and "an unrelated user trying to log in".

**Verified:** 60 attempts spread over 60 *rotated, never-repeated* identifiers (so the
per-account cap of 10 never trips) exhaust the global budget; a subsequent login for a
never-seen victim returns `429 too many login attempts — try again in a moment`.

**Exploit:** an unauthenticated attacker sends 60 `POST /api/auth/login` requests every
five minutes with rotating garbage usernames. Every legitimate user is denied login for
as long as the attacker keeps it up, at a cost of 12 requests/minute.

Minor related defect: at `:95-96` both limiters are consumed unconditionally, so a
request already rejected by the global cap still burns the victim account's budget.

**Impact:** cheap, sustained, unauthenticated denial of authentication.

---

### 5. `/api/auth/ping` is unauthenticated and discloses the internal HomeAuth URL — **Low** — CONFIRMED

**Where:** `backend/src/api/auth_routes.py:182-198`, `homeauth.py:196-228`.

**Defect:** the route has no auth dependency (verified: `deps=[]`) and returns
`base_url = config.HOMEAUTH_BASE_URL` (`homeauth.py:202`) — the **internal**,
server-to-server URL (e.g. `http://home-auth:9876` per `config.py:22-27`). Its own
docstring claims this is safe because the base URL "is already in /config", but
`/api/auth/config` (`:169`) deliberately returns `HOMEAUTH_PUBLIC_URL` instead. The
response also reports `api_key_valid`, `status_code` and `latency_ms`.

Each hit additionally drives an **unrate-limited outbound** `POST /auth/validate-token`
to HomeAuth carrying the real `X-Api-Key` (`homeauth.py:211-216`).

**Exploit:** an anonymous internet client learns the internal service name and port of
the sibling auth service, gets a live oracle for whether the app's API key is currently
accepted (useful for confirming a rotation broke, or for timing a follow-up), and can
use the endpoint as an unauthenticated request amplifier against HomeAuth.

**Impact:** internal topology disclosure + unauthenticated proxying of load onto the
auth service.

---

### 6. `/api/catalog/radio/{video_id}` skips id validation, growing `_roll_memory` without bound — **Low** — CONFIRMED

**Where:** `backend/src/api/routes.py:1733-1791`; `discovery.py:220-256`.

**Defect:** every other video-id route validates against `_VIDEO_ID_RE`
(`routes.py:1443, 1975, 1996, 2229, 2260, 2417`); `catalog_radio` does not (verified by
scanning the function body). The raw path segment flows to `search_mod.related()`
(`search.py:177`, which builds `https://www.youtube.com/watch?v={video_id}&list=RD{video_id}`
— host is fixed, so this is not SSRF) and, more importantly, to
`record_roll(user.user_id, f"radio:{video_id}", ...)` at `:1785`.

`_roll_memory` (`discovery.py:221`) is a plain `dict` keyed by `(user_id, surface)`.
Only the **inner** `OrderedDict` is capped (`_ROLL_MEMORY_DEPTH = 6`); the outer dict has
no eviction, contradicting the "Bounded and in-memory" comment at `discovery.py:218`.
**Verified:** 500 distinct 40-char surfaces → 500 permanently retained keys.

**Exploit:** an authenticated user walks `GET /api/catalog/radio/<arbitrary-long-string>`
at the 40/min budget (admins are exempt from the budget entirely, `:404`), adding one
never-freed dict entry per request for the process lifetime.

**Impact:** slow, unrecoverable memory growth in a long-lived single process on a small
ARM box. Also makes `_RELATED_CACHE` churn on junk keys.

---

### 7. Media tokens are session-wide, valid one hour, and carried in the query string — **Low** — CONFIRMED

**Where:** `backend/src/media_token.py:48-60`, `config.py:50`, `auth.py:235-274`.

**Design is sound where it matters:** the token is HMAC-SHA256 signed, compared with
`hmac.compare_digest` (`:71`), requires `p == "media"` and a non-empty `sid` (`:77-80`),
carries no role of its own, and authorization is resolved from the *live* session row at
verify time — so logout revokes it immediately (`auth.py:262`). A token for track A
cannot be escalated to admin, and it cannot be replayed as a session cookie. Those were
the questions in scope; they check out.

**The residual gap:** the token has no per-track and no per-route scope, and
`MEDIA_TOKEN_TTL_SEC` defaults to **3600 s** despite `media_token.py:14` describing it as
"expires quickly". `mediaUrl()` (`frontend/src/shared/api/client.ts:108-112`) and
`wsUrl()` (`:57-67`) append it as `?mt=`, which is exactly the place —
"access logs, Referer headers and proxy history" (`media_token.py:6-7`) — the module
docstring identifies as leaky.

**Exploit:** a `mt` value captured from a reverse-proxy access log, a shared screenshot,
or a Referer gives an attacker one hour of: streaming the **entire shared catalog**
(`/api/track/{id}/stream`), proxying arbitrary YouTube audio through the server
(`/api/preview/{id}`), downloading **any completed job file owned by that user**
(`/api/file/{job_id}`), and subscribing to their job progress (`/ws/progress/{job_id}`).
There is no revocation short of logging that session out.

**Impact:** bounded but real; shorten the TTL and/or bind the token to a route class.

---

### 8. Playlist `cover_url` is stored unvalidated and rendered to other users — **Low** — CONFIRMED

**Where:** `backend/src/api/routes.py:2101-2118` (`patch_playlist`), `db.py:1291-1293`;
rendered at `frontend/src/pages/PlaylistsPage.tsx:235-237` as `<img src={playlist.cover_url}>`.

**Defect:** `PlaylistUpdate.cover_url` is an unconstrained `str`. `update_playlist`
validates `visibility` against an allow-list (`db.py:1287`) but writes `cover_url`
verbatim. A playlist can be flipped to `public` in the same request, and
`db.list_playlists` (`:1331`) returns every public playlist to every authenticated user.

Not XSS — React escapes the attribute and `javascript:` is inert in `img[src]`.

**Exploit:** a user creates a public playlist and PATCHes
`cover_url = "https://attacker.example/p.png?u=<id>"`. Every user who opens the Playlists
page silently issues a request to the attacker's host, disclosing their IP, User-Agent
and Referer — a cross-user tracking beacon inside an app whose whole premise is a
private, self-hosted library.

**Impact:** cross-user IP/UA disclosure to a third party; also lets a user point the
cover at an arbitrary internal URL that the *viewer's* browser (not the server) fetches.

---

### 9. Upstream error text is reflected into HTTP bodies and persisted in job rows — **Low** — CONFIRMED

**Where:** `backend/src/api/routes.py:448` (`detail=str(e)`), `:2594`
(`detail=f"search failed: {e}"`), `:1824` (`detail=f"album search failed: {e}"`);
persisted via `db.fail(job_id, str(e))` at `:626`, `:697`, `:734`, `:988`, `:1269`, and
emitted over the WebSocket as `track_skipped.message` at `:965` and `:1248`.

**Defect:** raw `yt_dlp` / `httpx` exception strings are interpolated into responses and
into `jobs.error_message`, which `db.get` (`db.py:448`, `SELECT *`) returns wholesale
from `GET /api/jobs/{id}` and the WS `snapshot` frame (`:1322`).

**Exploit:** a user fires `POST /api/resolutions` at a URL that fails inside yt-dlp and
reads the 400 body. yt-dlp error text routinely embeds the resolved `cookiefile` path
(the `/tmp/yt-cookies-*.txt` tempfile created at `ytDownloaderFunctions.py:51`), the
`cachedir` path, signed `googlevideo.com` media URLs, and upstream HTTP details —
disclosing server filesystem layout and deployment internals to a normal user.

Scope is limited (the caller sees only their own job rows), which is why this is Low
rather than Medium.

**Impact:** internal path / deployment-detail disclosure to authenticated users.

---

## Explicitly clean — no issues found

These were traced end-to-end and are **not** defective. Recording them so the blind
spots are visible and the same ground is not re-covered.

**Authorization / IDOR — clean.** All 61 registered routes were enumerated
programmatically from `app.routes` with their resolved dependencies. Every route except
`/api/health`, `/api/health/extraction`, `/api/auth/config`, `/api/auth/login`,
`/api/auth/ping` and `/api/catalog/categories` requires `current_user`, `media_user` or
`require_admin`; the WebSocket authenticates in its handler (`:1301-1319`) and is
covered by `tests/test_security.py:55`. Every id-taking handler re-reads the row and
gates it:
* jobs — `_ensure_owner` on get/cancel/retry/delete/file/WS (`:2497, 2507, 2520, 2549, 1381, 1316`); list uses `db.list_jobs(owner_id=user.owner_filter)`;
* playlists — `_ensure_playlist_owner` on PATCH/DELETE/add/bulk/remove/reorder (`:2110, 2129, 2143, 2165, 2182, 2198`), `_ensure_playlist_visible` on GET (`:2092`); `db.list_playlists` re-applies visibility in SQL even when the caller supplies `owner_id` (`db.py:1327-1332`);
* library / catalog ownership — `db.list_library`, `link_owner`, `unlink_owner` all take `user.user_id` as the filter (`db.py:779, 694, 740`);
* history / stats / recent — every query is `WHERE user_id = ?` (`db.py:1017, 1085, 1141, 1188`).

I found **no** handler that reads or mutates a row by a caller-supplied id without an
ownership or visibility check.

**Cross-user leakage in payloads — clean.** `_TRACK_COLS` (`db.py:990`) and the hand-
written column lists in `list_library`, `list_catalog`, `list_playlist_tracks` and
`list_recent_additions` never select `tracks.file_path` or `tracks.sha256`; only the
admin table does (`db.py:1632`, behind `require_admin`). Session tokens are never
selected outside `db.get_session`. The two identifiers that do cross users are both
deliberate product features: `/api/activity` returns other users' `owner_id` + `username`
(`db.py:1210-1213`, the shared activity feed) and a public playlist's `owner_id`
(`:2095`). Worth a product decision — the raw HomeAuth `owner_id` is not needed for
either UI — but not a defect.

**Path traversal — clean.** `stream_track` and `serve_file` use server-derived paths
(`tracks.file_path`, `_jobs[id]["file_path"]`), never caller input. The SPA catch-all
(`:2698-2710`) does `realpath` + prefix containment; I tested `../../../../etc/passwd`,
`/etc/passwd`, `a/../../../../etc/passwd` and `..%2f..%2f…` — all resolve outside
`_SPA_ROOT` and fall through to `index.html`. The `Range` parser (`:2286-2307`) rejects
negative/oversized/inverted ranges with 416.

**SSRF / command injection — clean.** `_validate_youtube_url` (`:362`) parses with
`urlparse`, checks `hostname` (not the raw string) and the scheme, and is exercised by
`tests/test_security.py:12-34` against the userinfo (`youtube.com@evil.com`), suffix
(`youtube.com.evil.com`), `file://`, `ftp://` and `169.254.169.254` cases. It gates
`/api/download`, `/api/download-playlist` and `/api/resolutions`. The Spotify importer
never fetches a user URL: `parse_playlist_id` extracts a 22-char `[A-Za-z0-9]` id and it
is substituted into a hardcoded `https://open.spotify.com/embed/playlist/{pid}`
(`spotify.py:29, 100`). Album ids are gated by `_ALBUM_ID_RE` (`:1799, 1905`). Every
`subprocess` call is an argv **list** with no `shell=True`
(`ytDownloaderFunctions.py:269, 365, 410, 454, 472`); the cookies tempfile is created
with `tempfile.mkstemp` (0600).

**SQL injection — clean.** Every f-string in `db.py` interpolates only server-controlled
tokens: hardcoded column names (`:380, 386, 654, 661`), allow-listed `ORDER BY` from
`_CATALOG_SORTS` / `_ADMIN_TRACK_SORTS` (`:831, 1626`), or generated `?` placeholders
(`:897, 1559`). All user values are bound parameters.

**Secrets & logging — clean.** No token, cookie value, password or `X-Api-Key` reaches a
log statement. `homeauth.py` logs only exception types on transport failure; `auth.py:63`
logs a user id; `auth_routes.py:130` logs user id + role. `get_cookies_expiry`
(`ytDownloaderFunctions.py:71`) explicitly never returns cookie names or values.
`MEDIA_TOKEN_SECRET` is absent from `.env.example`, which means production falls back to
a fresh per-process `secrets.token_urlsafe(32)` — that is the *safer* default here.

**Session lifecycle — clean.** A fresh 256-bit id is minted on every login
(`auth_routes.py:51, 119`), so there is no session fixation. The cookie is `httponly`,
`Secure` (enforced at boot when `APP_ENV=production`, `config.py:81-86`), `SameSite=lax`
with no GET-mutating routes, so CSRF is covered. `_get_live_session` enforces the
absolute TTL server-side and drops the row (`auth.py:104-118`), with a periodic sweep
(`:316`). The single-flight refresh (`:177-193`) re-reads under the per-session lock, so
losers of the rotation race reuse the winner's tokens instead of self-logging-out.
Role/username are re-synced from every refresh and only when the user id matches
(`:83-85`), so a HomeAuth demotion takes effect. Logout revokes upstream, deletes the
row, drops the lock and clears the cookie (`auth_routes.py:134-145`).
`DEV_AUTH_BYPASS` refuses to boot in a production posture (`config.py:71-76`).

**CORS — not an issue in this topology.** The middleware is only registered when
`FRONTEND_ORIGIN` is non-empty (`:81`), and both `README.md:111` and
`.env.example` say to leave it empty in production (the backend serves the SPA
same-origin). The native build routes JSON through `CapacitorHttp`
(`frontend/capacitor.config.ts`), bypassing the WebView CORS sandbox — so no origin
needs to be allow-listed. *(Note for operators: setting `FRONTEND_ORIGIN=*` would be
dangerous — Starlette echoes the request origin alongside
`Access-Control-Allow-Credentials: true` when a cookie is present. Nothing in the repo
does this today.)*

**Offline downloads — no backend surface.** The offline feature is entirely client-side
(`frontend/src/features/offline/{storage,offlineIndex,OfflineProvider}.tsx` over the
Capacitor filesystem). There is no server-side offline endpoint and therefore no
per-user offline data to isolate.

---

## Coverage

**Read in full:** `backend/src/api/routes.py` (2710 ll.), `api/admin_routes.py`,
`api/auth_routes.py`, `auth.py`, `media_token.py`, `rate_limit.py`, `homeauth.py`,
`config.py`, `spotify.py`, `search.py`, `extraction_pool.py`, `tests/test_security.py`,
`tests/conftest.py`, `Dockerfile`, `backend/.env.example`.

**Read selectively (targeted at the audit questions):** `db.py` — schema, every query
builder, all `list_*` / `admin_*` / playlist / play-history functions;
`ytDownloaderFunctions.py` — cookie resolution, all `subprocess` sites, all
`download_*` / `get_*_info` entry points, `outtmpl` construction;
`discovery.py` — `_discover_feed`, roll memory, lineup cache, `_daily_mixes_impl`;
`frontend/src/shared/api/client.ts`, `capacitor.config.ts`, plus grep sweeps of
`frontend/src` for `dangerouslySetInnerHTML`, `localStorage`, `cover_url`, `mt=`.

**Verified dynamically:** route/dependency table generated from `app.routes`;
retry rate-limit bypass; `_roll_memory` growth; unbounded Pydantic string fields;
health-probe lock ordering; global login lockout; SPA-fallback path containment;
full pytest suite.

**Blind spots — not covered:**
* `ytmusic.py` was read at signature level only (no user-controlled URL construction was
  visible, but its request paths were not traced line-by-line).
* `discovery.py` scoring internals (`_build_daily_mixes`, `_scene_clusters`,
  `weighted_seed_ids`) were skimmed for data-scoping only, not audited for logic.
* Frontend components were swept by grep for XSS sinks rather than read end-to-end; a
  full React review is not done.
* No live end-to-end testing against a running server — no HomeAuth instance was
  available, so all auth-path conclusions come from code tracing plus the existing unit
  tests.
* yt-dlp's own extractor selection for non-`/watch` `*.youtube.com` paths was not
  empirically probed; the host allow-list is correct, but whether some
  `youtube.com/<path>` reaches yt-dlp's generic extractor was not tested.
* Everything outside the repo: the Coolify/Traefik layer (TLS termination, proxy body
  limits, security headers, IP allow-lists), the HomeAuth service itself, and the
  contents/scope of the production YouTube cookies.
