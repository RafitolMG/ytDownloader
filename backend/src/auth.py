"""
Auth middleware. `current_user` is the canonical FastAPI dependency that
protected routes must declare. Handles three states:

  - cookie missing / session unknown          → 401
  - access about to expire → try refresh, OK   → continue (DB updated)
  - HomeAuth unreachable                      → 503 (fail-closed)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import Cookie, HTTPException, status

from src import config, db, homeauth

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
        # Refresh rejected (cookie expired or revoked) — drop the local session.
        db.delete_session(session["id"])
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session expired") from e

    new_expires = _expires_in_seconds(result.expires_in)
    db.update_session_tokens(
        session["id"],
        access_token=result.access_token,
        access_expires_at=new_expires,
        refresh_cookie=result.refresh_cookie,
    )
    refreshed = dict(session)
    refreshed["access_token"] = result.access_token
    refreshed["access_expires_at"] = new_expires
    refreshed["refresh_cookie"] = result.refresh_cookie
    return refreshed


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

    session = db.get_session(ytdl_session)
    if session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="session not found")

    now = datetime.now(timezone.utc)
    expires_at = _parse_iso(session["access_expires_at"])
    if expires_at - now <= timedelta(seconds=config.ACCESS_REFRESH_LEEWAY_SEC):
        session = _refresh_session(session)

    db.touch_session(session["id"])

    return CurrentUser(
        session_id=session["id"],
        user_id=session["user_id"],
        username=session["username"],
        role=session["role"],
    )


def optional_user(ytdl_session: str | None = Cookie(default=None, alias=config.SESSION_COOKIE_NAME)) -> CurrentUser | None:
    """Variant for endpoints that personalize when logged-in but allow anon."""
    try:
        return current_user(ytdl_session=ytdl_session)
    except HTTPException:
        return None
