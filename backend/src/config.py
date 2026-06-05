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

# CORS allow-list for the SPA dev server. Leave empty (or unset) in production
# when the backend serves the SPA from the same origin — CORS is a no-op then.
FRONTEND_ORIGIN: str = _env("FRONTEND_ORIGIN", "").rstrip("/")

# Dev-only: skip HomeAuth entirely and treat every request as a fixed dev user.
# Off by default. NEVER set this in production — anyone who can reach the
# backend gets ADMIN. The startup banner logs a loud warning when enabled.
DEV_AUTH_BYPASS: bool = _env_bool("DEV_AUTH_BYPASS", False)

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

# yt-dlp cookies file. YouTube blocks datacenter IPs (Coolify / VPS) without an
# authenticated session, so prod deployments must mount a Netscape-format
# cookies.txt exported from a logged-in browser. Empty string = no cookies
# (fine for local dev on a residential IP). When set, the file must exist or
# yt-dlp will error on every job.
YT_COOKIES_FILE: str = _env("YT_COOKIES_FILE", "")
