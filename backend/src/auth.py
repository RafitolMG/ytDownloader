"""
Auth middleware. `current_user` is the canonical FastAPI dependency that
protected routes must declare. Handles three states:

  - cookie missing / session unknown          → 401
  - access about to expire → try refresh, OK   → continue (DB updated)
  - HomeAuth unreachable                      → 503 (fail-closed)
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, Depends, HTTPException, Query, status

from src import config, db, homeauth, media_token

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CurrentUser:
    session_id: str
    user_id: str
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == db.ROLE_ADMIN

    @property
    def owner_filter(self) -> str | None:
        """Pass this to db.list_jobs(owner_id=...) — ADMIN sees all, USER scoped."""
        return None if self.is_admin else self.user_id


def _parse_iso(s: str) -> datetime:
    """Tolerant ISO-8601 parser that accepts both 'Z' and '+00:00' suffixes."""
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def _expires_in_seconds(seconds_ahead: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds_ahead)).isoformat(timespec="seconds")


def _refresh_session(session: dict) -> dict:
    """
    Call HomeAuth /auth/refresh with the stored cookie. Updates the DB row.
    Returns the refreshed session dict. Raises HTTPException on failure.
    """
    refresh_cookie = session.get("refresh_cookie")
    if not refresh_cookie:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired")

    try:
        result = homeauth.refresh(refresh_cookie)
    except homeauth.HomeAuthError as e:
        if e.unreachable:
            log.warning("HomeAuth unreachable while refreshing user=%s", session["user_id"])
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="auth service unreachable",
            ) from e
        # Refresh genuinely rejected (cookie expired or revoked) — drop the local
        # session. This runs single-flighted (see _refresh_if_needed), so it's a
        # real rejection, not a request that lost the refresh-rotation race.
        db.delete_session(session["id"])
        _drop_refresh_lock(session["id"])
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired") from e

    new_expires = _expires_in_seconds(result.expires_in)
    # HomeAuth echoes the current role/username in every refresh response, so we
    # re-sync them here. Otherwise a role change made in HomeAuth (e.g. an admin
    # being demoted) would never take effect for an active session — the role is
    # cached from login and outlives the change until the session finally drops.
    # Guard against an unexpected empty user block by trusting the fresh values
    # only when the refresh identifies the SAME user (non-empty, matching id).
    role_update = username_update = None
    if result.user_id and result.user_id == session["user_id"]:
        role_update = result.role
        username_update = result.username
    db.update_session_tokens(
        session["id"],
        access_token=result.access_token,
        access_expires_at=new_expires,
        refresh_cookie=result.refresh_cookie,
        role=role_update,
        username=username_update,
    )
    refreshed = dict(session)
    refreshed["access_token"] = result.access_token
    refreshed["access_expires_at"] = new_expires
    refreshed["refresh_cookie"] = result.refresh_cookie
    if role_update is not None:
        refreshed["role"] = role_update
        refreshed["username"] = username_update
    return refreshed


def _get_live_session(session_id: str) -> dict | None:
    """Fetch a session, treating one past its absolute lifetime as gone (and
    deleting it + its refresh lock). SESSION_TTL_DAYS mirrors the cookie max-age,
    so a server-side session — which stores live access/refresh credentials —
    never outlives the cookie that references it. A periodic sweep
    (db.delete_expired_sessions) reaps the rest in bulk."""
    session = db.get_session(session_id)
    if session is None:
        return None
    created = _parse_iso(session["created_at"])
    if datetime.now(timezone.utc) - created > timedelta(days=config.SESSION_TTL_DAYS):
        db.delete_session(session_id)
        _drop_refresh_lock(session_id)
        return None
    return session


def _needs_refresh(session: dict) -> bool:
    """True when the access token is within the refresh leeway of expiring."""
    now = datetime.now(timezone.utc)
    expires_at = _parse_iso(session["access_expires_at"])
    return expires_at - now <= timedelta(seconds=config.ACCESS_REFRESH_LEEWAY_SEC)


# Per-session refresh locks. HomeAuth rotates AND revokes the refresh cookie on
# every /auth/refresh (one-time use), so when the short-lived access token nears
# expiry the SPA's many parallel requests would each try to refresh with the
# SAME cookie: the first wins and rotates it, the rest present a now-revoked
# cookie, get a 401, and used to drop the whole session — logging the user out
# roughly every access-token lifetime (~15 min). Serializing refresh per session
# (single-flight) and re-reading under the lock lets the losers reuse the
# winner's fresh tokens instead of consuming the rotated cookie a second time.
_refresh_locks: dict[str, threading.Lock] = {}
_refresh_locks_guard = threading.Lock()


def _refresh_lock_for(session_id: str) -> threading.Lock:
    with _refresh_locks_guard:
        return _refresh_locks.setdefault(session_id, threading.Lock())


def _drop_refresh_lock(session_id: str) -> None:
    """Forget the per-session lock once its session is gone, so the map doesn't
    accumulate an entry per dead session."""
    with _refresh_locks_guard:
        _refresh_locks.pop(session_id, None)


def _refresh_if_needed(session: dict) -> dict:
    """Single-flighted refresh. Hold the per-session lock, then re-read the row
    under it: if a parallel request already refreshed (token no longer near
    expiry), reuse those tokens rather than presenting the rotated cookie again
    (which HomeAuth would reject, dropping the session)."""
    lock = _refresh_lock_for(session["id"])
    with lock:
        current = db.get_session(session["id"])
        if current is None:
            # A concurrent refresh rejection already dropped it — treat as expired.
            _drop_refresh_lock(session["id"])
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired"
            )
        if not _needs_refresh(current):
            return current
        return _refresh_session(current)


_DEV_USER = CurrentUser(
    session_id="dev-session",
    user_id="dev-user",
    username="dev",
    role=db.ROLE_ADMIN,
)


def current_user(ytdl_session: str | None = Cookie(default=None, alias=config.SESSION_COOKIE_NAME)) -> CurrentUser:
    """
    FastAPI dependency. Use as:

        @app.get("/api/whoami")
        def whoami(user: CurrentUser = Depends(current_user)):
            return user
    """
    if config.DEV_AUTH_BYPASS:
        return _DEV_USER

    if not ytdl_session:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="not authenticated")

    session = _get_live_session(ytdl_session)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session not found or expired")

    if _needs_refresh(session):
        session = _refresh_if_needed(session)

    db.touch_session(session["id"])

    return CurrentUser(
        session_id=session["id"],
        user_id=session["user_id"],
        username=session["username"],
        role=session["role"],
    )


def media_user(
    mt: str | None = Query(default=None),
    ytdl_session: str | None = Cookie(default=None, alias=config.SESSION_COOKIE_NAME),
) -> CurrentUser:
    """Auth for media endpoints (<audio> stream, preview, file download).

    The browser carries the httponly session cookie automatically, but a native
    (Capacitor) WebView loads the SPA from a different origin than the API, so
    those media requests — issued by the <audio>/anchor element, not by JS —
    cannot ride the cookie. The native client passes a short-lived, signed,
    media-scoped token (NOT the session id) as `mt` instead: it never lets a
    leaked URL be replayed as a session, and expires on its own. The cookie path
    (with full refresh/role/expiry) still applies for the web app, where `mt` is
    absent."""
    if config.DEV_AUTH_BYPASS:
        return _DEV_USER
    if mt:
        claims = media_token.verify(mt)
        if claims is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid or expired media token",
            )
        # Resolve the caller from the live session the token was bound to, not
        # from the token itself: logout (session gone) or an expired session
        # revokes the token, and the current role/username are read fresh rather
        # than frozen at mint time.
        session = _get_live_session(claims["sid"])
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="invalid or expired media token",
            )
        return CurrentUser(
            session_id=session["id"],
            user_id=session["user_id"],
            username=session["username"],
            role=session["role"],
        )
    return current_user(ytdl_session=ytdl_session)


def require_admin(user: CurrentUser = Depends(current_user)) -> CurrentUser:
    """FastAPI dependency for admin-only routes. Layers on top of
    `current_user`, so missing/expired sessions still 401 first; a valid
    non-admin session then yields 403. DEV_AUTH_BYPASS makes the dev user
    ADMIN, so local dev passes every admin route."""
    if not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin only")
    return user


def optional_user(ytdl_session: str | None = Cookie(default=None, alias=config.SESSION_COOKIE_NAME)) -> CurrentUser | None:
    """Variant for endpoints that personalize when logged-in but allow anon."""
    try:
        return current_user(ytdl_session=ytdl_session)
    except HTTPException:
        return None
