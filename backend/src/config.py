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
HOMEAUTH_BASE_URL: str = _env("HOMEAUTH_BASE_URL", "http://localhost:8080").rstrip("/")
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
