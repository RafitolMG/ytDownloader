"""
Authentication endpoints. Talk to HomeAuth server-side and translate the
result into a ytdl_session cookie that the browser carries on every request.

The browser never sees the JWT nor the HomeAuth refresh cookie — both are
held only in the server-side `sessions` table.
"""
from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel

from src import config, db, homeauth, media_token as media_token_mod, rate_limit
from src.auth import CurrentUser, current_user

router = APIRouter(prefix="/api/auth", tags=["auth"])

log = logging.getLogger(__name__)

# Brute-force throttles for /login (see config for rationale). Per-account keys
# the submitted identifier; the global limiter (key "*") bounds username-rotation
# spraying that would slip past any single per-account key.
_login_limiter = rate_limit.SlidingWindowLimiter(
    config.LOGIN_RATELIMIT_MAX, config.LOGIN_RATELIMIT_WINDOW_SEC
)
_login_global_limiter = rate_limit.SlidingWindowLimiter(
    config.LOGIN_RATELIMIT_GLOBAL_MAX, config.LOGIN_RATELIMIT_WINDOW_SEC
)


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
    # Throttle before touching HomeAuth so a brute-force is both rejected here and
    # never forwarded upstream. Key on the account (not client IP — the proxy
    # collapses every client to one IP) plus a global cap.
    ident = body.usernameOrEmail.strip().lower()
    ok_global, retry_g = _login_global_limiter.check("*")
    ok_account, retry_a = _login_limiter.check(ident)
    if not ok_global or not ok_account:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too many login attempts — try again in a moment",
            headers={"Retry-After": str(max(retry_g, retry_a))},
        )
    try:
        result = homeauth.login(body.usernameOrEmail, body.password)
    except homeauth.HomeAuthError as e:
        if e.unreachable:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="auth service unreachable",
            ) from e
        if e.status_code == 401:
            # Add a small delay on a bad credential to slow guessing that stays
            # under the rate cap (runs in the threadpool, off the event loop).
            if config.LOGIN_FAIL_DELAY_SEC > 0:
                time.sleep(config.LOGIN_FAIL_DELAY_SEC)
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


@router.get("/media-token")
def media_token(user: CurrentUser = Depends(current_user)):
    """Hand the authenticated client a short-lived, signed, media-scoped token to
    append to media URLs.

    Native (Capacitor) builds serve the SPA from a different origin than the API,
    so the <audio>/download requests can't carry the httponly session cookie. JS
    can't read the cookie either, so it asks here — over a normal cookie-authed
    request — for a token to put in the `mt` query param. The token is NOT the
    session id: it's HMAC-signed, carries only user/role + an expiry, and dies on
    its own, so a leaked media URL can't be replayed as a session. The client
    re-fetches before it expires. The web app never calls this (cookie suffices)."""
    token, expires_in = media_token_mod.mint(user.user_id, user.session_id)
    return {"token": token, "expires_in": expires_in}


@router.get("/config")
def auth_config():
    """
    Public — exposes only the upstream URLs the SPA needs (no secrets).
    Must return the *public* URL (browser-reachable), never the internal
    service-name URL the backend uses for server-to-server calls.
    """
    return {
        "homeauth_base_url": config.HOMEAUTH_PUBLIC_URL,
        "register_url": f"{config.HOMEAUTH_PUBLIC_URL}/register",
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
