"""
Authentication endpoints. Talk to HomeAuth server-side and translate the
result into a ytdl_session cookie that the browser carries on every request.

The browser never sees the JWT nor the HomeAuth refresh cookie — both are
held only in the server-side `sessions` table.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from src import config, db, homeauth
from src.auth import CurrentUser, current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])

log = logging.getLogger(__name__)


# ── Request / response models ─────────────────────────────────────────────────

class LoginRequest(BaseModel):
    usernameOrEmail: str
    password: str


class WhoAmIResponse(BaseModel):
    user_id: str
    username: str
    role: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _new_session_id() -> str:
    # 32 bytes = 256 bits of entropy. URL-safe so it survives cookies cleanly.
    return secrets.token_urlsafe(32)


def _expires_at(seconds_ahead: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds_ahead)).isoformat(timespec="seconds")


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=config.SESSION_COOKIE_NAME,
        value=session_id,
        max_age=config.SESSION_TTL_DAYS * 86400,
        path="/",
        httponly=True,
        secure=config.SESSION_COOKIE_SECURE,
        samesite=config.SESSION_COOKIE_SAMESITE,
    )


def _clear_session_cookie(response: Response) -> None:
    response.set_cookie(
        key=config.SESSION_COOKIE_NAME,
        value="",
        max_age=0,
        path="/",
        httponly=True,
        secure=config.SESSION_COOKIE_SECURE,
        samesite=config.SESSION_COOKIE_SAMESITE,
    )


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/login", response_model=WhoAmIResponse)
def login(body: LoginRequest, response: Response):
    """
    Exchange credentials → HomeAuth login → server-side session row → set ytdl_session cookie.
    """
    try:
        result = homeauth.login(body.usernameOrEmail, body.password)
    except homeauth.HomeAuthError as e:
        if e.unreachable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="auth service unreachable",
            ) from e
        if e.status_code == 401:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid credentials") from e
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e)) from e

    session_id = _new_session_id()
    db.create_session(
        session_id=session_id,
        user_id=result.user_id,
        username=result.username,
        role=result.role,
        access_token=result.access_token,
        refresh_cookie=result.refresh_cookie,
        access_expires_at=_expires_at(result.expires_in),
    )
    _set_session_cookie(response, session_id)
    log.info("login user=%s role=%s", result.user_id, result.role)
    return WhoAmIResponse(user_id=result.user_id, username=result.username, role=result.role)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(response: Response, user: CurrentUser = Depends(current_user)):
    """Revoke the refresh upstream (best effort), then drop the local session."""
    session = db.get_session(user.session_id)
    if session is not None:
        homeauth.logout(session.get("refresh_cookie"))
        db.delete_session(user.session_id)
    _clear_session_cookie(response)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/whoami", response_model=WhoAmIResponse)
def whoami(user: CurrentUser = Depends(current_user)):
    return WhoAmIResponse(user_id=user.user_id, username=user.username, role=user.role)


@router.get("/config")
def auth_config():
    """
    Public — exposes only the upstream URLs the SPA needs (no secrets).
    Lets the frontend link out to HomeAuth's hosted register page without
    hardcoding HOMEAUTH_BASE_URL into the bundle.
    """
    return {
        "homeauth_base_url": config.HOMEAUTH_BASE_URL,
        "register_url": f"{config.HOMEAUTH_BASE_URL}/register",
    }


@router.get("/ping")
def auth_ping():
    """
    Public connectivity probe. Returns whether the backend can reach
    HomeAuth and whether the API key is accepted. Safe to expose: leaks no
    secrets — only base URL (which is already in /config) and a status code.
    Intended for post-deploy smoke testing from a browser or curl.
    """
    result = homeauth.ping()
    return {
        "reachable": result.reachable,
        "api_key_valid": result.api_key_valid,
        "latency_ms": result.latency_ms,
        "status_code": result.status_code,
        "base_url": result.base_url,
        "error": result.error,
    }
