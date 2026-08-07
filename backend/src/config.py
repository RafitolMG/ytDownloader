"""
Runtime configuration for ytDownloader backend.

Reads from environment with sensible dev defaults. Production deployments
must override HOMEAUTH_APP_API_KEY and SESSION_COOKIE_SECURE.
"""
import os


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default)


def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "on")


# HomeAuth integration
# BASE_URL is the URL the *backend* uses to reach HomeAuth (server-to-server,
# typically an internal Docker service name like http://home-auth:9876).
# PUBLIC_URL is the URL the *browser* uses for redirects (e.g. the "Register"
# link). When empty, falls back to BASE_URL — fine for dev where both are
# http://localhost:8080.
HOMEAUTH_BASE_URL: str = _env("HOMEAUTH_BASE_URL", "http://localhost:8080").rstrip("/")
HOMEAUTH_PUBLIC_URL: str = _env("HOMEAUTH_PUBLIC_URL", "").rstrip("/") or HOMEAUTH_BASE_URL
HOMEAUTH_APP_API_KEY: str = _env("HOMEAUTH_APP_API_KEY", "")

# Cookie issued by *this* backend to the browser
SESSION_COOKIE_NAME: str = _env("SESSION_COOKIE_NAME", "ytdl_session")
SESSION_COOKIE_SECURE: bool = _env_bool("SESSION_COOKIE_SECURE", False)
SESSION_COOKIE_SAMESITE: str = _env("SESSION_COOKIE_SAMESITE", "lax")
SESSION_TTL_DAYS: int = int(_env("SESSION_TTL_DAYS", "7"))

# Refresh window: try to refresh when access expires in less than this many seconds.
ACCESS_REFRESH_LEEWAY_SEC: int = int(_env("ACCESS_REFRESH_LEEWAY_SEC", "60"))

# Media tokens. Native (Capacitor) <audio>/download requests can't carry the
# httponly cookie cross-origin, so the client appends a signed, media-scoped,
# short-lived token as `?mt=`. Pin MEDIA_TOKEN_SECRET in production (and across
# replicas) so tokens survive restarts and verify on every worker; when empty,
# the backend generates a per-process secret (fine for the single-box default,
# but a restart invalidates outstanding tokens until the client re-fetches).
MEDIA_TOKEN_SECRET: str = _env("MEDIA_TOKEN_SECRET", "")
# Bound to a session (see media_token.py), so logout revokes it immediately; the
# TTL is now just a backstop and re-fetch cadence, kept short. The web client
# re-fetches ahead of expiry and AuthProvider polls it while signed in.
MEDIA_TOKEN_TTL_SEC: int = int(_env("MEDIA_TOKEN_TTL_SEC", "3600"))  # 1h

# CORS allow-list for the SPA dev server. Leave empty (or unset) in production
# when the backend serves the SPA from the same origin — CORS is a no-op then.
FRONTEND_ORIGIN: str = _env("FRONTEND_ORIGIN", "").rstrip("/")

# Dev-only: skip HomeAuth entirely and treat every request as a fixed dev user.
# Off by default. NEVER set this in production — anyone who can reach the
# backend gets ADMIN. The startup banner logs a loud warning when enabled.
DEV_AUTH_BYPASS: bool = _env_bool("DEV_AUTH_BYPASS", False)

# Explicit production marker. Set APP_ENV=production in prod (Coolify) so the
# backend enforces its security posture at boot instead of relying on the
# operator to remember individual flags. Anything else (default) = dev.
APP_ENV: str = _env("APP_ENV", "development").lower()
IS_PRODUCTION: bool = APP_ENV == "production"

# Fail closed: DEV_AUTH_BYPASS disables auth entirely (every request is ADMIN),
# so it must never run with a production posture. Refuse to start when it is on
# together with either explicit-prod (APP_ENV=production) or the SECURE-cookie
# prod marker, rather than silently serving an open backend.
if DEV_AUTH_BYPASS and (IS_PRODUCTION or SESSION_COOKIE_SECURE):
    raise RuntimeError(
        "DEV_AUTH_BYPASS is enabled in a production posture "
        "(APP_ENV=production or SESSION_COOKIE_SECURE=true). This would expose "
        "the backend with no auth. Refusing to start — unset DEV_AUTH_BYPASS."
    )

# In production the session cookie must be Secure (HTTPS-only); otherwise a
# stray cleartext request leaks the full session credential. Enforce it at boot
# rather than trusting the operator to set SESSION_COOKIE_SECURE=true by hand.
if IS_PRODUCTION and not SESSION_COOKIE_SECURE:
    raise RuntimeError(
        "APP_ENV=production requires SESSION_COOKIE_SECURE=true so the session "
        "cookie is only sent over HTTPS. Refusing to start — set it (the app is "
        "always deployed behind TLS)."
    )

# Music library — content-addressed audio storage. Every track downloaded as
# part of a playlist (or future single-track audio jobs) lives at
# {LIBRARY_DIR}/{video_id}/{codec}_{bitrate}.{ext}. Shared across users so the
# same source is never downloaded twice. In Coolify the parent must be a
# persistent volume mount.
_DEFAULT_LIBRARY_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),  # backend/
    "data",
    "library",
)
LIBRARY_DIR: str = _env("LIBRARY_DIR", _DEFAULT_LIBRARY_DIR)

# yt-dlp player / n-sig cache. yt-dlp caches the extracted "player" JS that
# solves YouTube's signature / n-param challenges so it isn't re-downloaded and
# re-parsed on every extraction. Its default location is ~/.cache/yt-dlp — the
# container user's home, which is NOT on the persistent volume, so it's wiped on
# every redeploy, forcing a cold "Downloading player" + n-sig recompile on the
# first extraction after each restart. Pin it beside the library (under the same
# persistent volume) so the cache survives redeploys. Most valuable from a
# datacenter IP, where the n-sig challenge is on the critical path of every fetch.
YTDLP_CACHE_DIR: str = _env("YTDLP_CACHE_DIR", os.path.join(os.path.dirname(LIBRARY_DIR), "yt-dlp-cache"))

# yt-dlp cookies. YouTube blocks datacenter IPs (Coolify / VPS) without an
# authenticated session, so prod deployments must provide a Netscape-format
# cookies.txt exported from a logged-in browser.
#
# Two ways to supply it (DATA wins over FILE if both are set):
#   YT_COOKIES_DATA — base64-encoded cookies.txt. The backend decodes and
#                     writes it to a tempfile on first use. base64 keeps the
#                     value on a single line with no shell-special characters,
#                     which is what Coolify needs because it sources env files
#                     as bash. Generate with `base64 -w0 cookies.txt`.
#   YT_COOKIES_FILE — absolute path to a cookies.txt already on disk. Useful
#                     when the file is bind-mounted via Coolify's File Mount
#                     or pre-placed in the persistent volume.
# Empty strings = no cookies (fine for local dev on a residential IP).
YT_COOKIES_DATA: str = _env("YT_COOKIES_DATA", "")
YT_COOKIES_FILE: str = _env("YT_COOKIES_FILE", "")

# YouTube Music metadata enrichment. yt-dlp's scraped artist list mixes
# performers with songwriters/producers (under legal names) and no field
# separates them; the YT Music internal API (ytmusicapi) returns just the
# performing artists. On a download we query it by video id and prefer its
# clean list, falling back to the yt-dlp heuristic when it fails / the track
# isn't in the YT Music catalog. Set to "false" in prod if the datacenter IP
# gets blocked — the heuristic still applies.
YTMUSIC_ENABLED: bool = _env_bool("YTMUSIC_ENABLED", True)

# Per-user rate limit on yt-dlp-bound endpoints (resolutions / search / discover
# / album-search / category / radio). Generous enough that human browsing never
# trips it (~1/sec sustained) but a script or spam can't saturate the extraction
# threadpool or hammer YouTube against the shared cookies. ADMINs are exempt.
RATELIMIT_PER_MIN: int = int(_env("YTDL_RATELIMIT_PER_MIN", "40"))
RATELIMIT_WINDOW_SEC: int = int(_env("YTDL_RATELIMIT_WINDOW_SEC", "60"))

# Login throttle. /api/auth/login has no client identity yet, so it can't use
# the per-user extraction limiter, and behind a reverse proxy every request
# shares the proxy IP — so we key on the submitted account (normalised) plus a
# global cap, both generous enough that a human never trips them but a scripted
# password guess / spray does. A small delay on a rejected credential slows
# slow-and-low guessing beyond the cap. All tunable via env.
LOGIN_RATELIMIT_MAX: int = int(_env("YTDL_LOGIN_RATELIMIT_MAX", "10"))
LOGIN_RATELIMIT_GLOBAL_MAX: int = int(_env("YTDL_LOGIN_RATELIMIT_GLOBAL_MAX", "60"))
LOGIN_RATELIMIT_WINDOW_SEC: int = int(_env("YTDL_LOGIN_RATELIMIT_WINDOW_SEC", "300"))
LOGIN_FAIL_DELAY_SEC: float = float(_env("YTDL_LOGIN_FAIL_DELAY_SEC", "0.5"))

# Dedicated bounded threadpool for yt-dlp-bound request handlers. Keeps slow
# extraction subprocesses off the default request threadpool so they can't stall
# the cheap DB endpoints (library/catalog/playlists). Sized to the (small ARM)
# core count by default. EXTRACTION_TIMEOUT_SEC bounds a single request → 504.
EXTRACTION_WORKERS: int = int(_env("YTDL_EXTRACTION_WORKERS", "0")) or min(4, (os.cpu_count() or 4))
EXTRACTION_TIMEOUT_SEC: float = float(_env("YTDL_EXTRACTION_TIMEOUT_SEC", "45"))

# Max background download jobs (single video / playlist / tracklist import) that
# run concurrently. Each is a long-running yt-dlp + ffmpeg pipeline that eats
# CPU/disk/network and the shared YouTube cookies, so we bound them with a pool:
# jobs beyond this stay queued (in their created state) until a slot frees,
# instead of spawning an unbounded thread per request. Sized small for the ARM
# box. Endpoint rate limiting caps how fast jobs can be created in the meantime.
MAX_CONCURRENT_DOWNLOADS: int = int(_env("YTDL_MAX_CONCURRENT_DOWNLOADS", "0")) or min(3, (os.cpu_count() or 3))

# Hard cap on how many tracks one playlist download / tracklist import will
# process. The per-user rate limit bounds how fast *jobs* are created, not the
# work *inside* a job, so without this a single request pointed at a giant
# playlist (or a pasted 10k-line list) could fill the library volume and run for
# hours. Beyond the cap the import is truncated (and flagged to the client).
MAX_IMPORT_TRACKS: int = int(_env("YTDL_MAX_IMPORT_TRACKS", "500"))

# Hard ceiling on a single ffmpeg merge/transcode pass. A hung ffmpeg (rare, but
# it can wedge on a corrupt stream) would otherwise block its download worker
# forever, permanently consuming one of the MAX_CONCURRENT_DOWNLOADS slots.
FFMPEG_TIMEOUT_SEC: float = float(_env("YTDL_FFMPEG_TIMEOUT_SEC", "1800"))
