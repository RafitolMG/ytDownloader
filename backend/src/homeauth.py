"""
HTTP client for HomeAuth — the centralized auth service.

Server-to-server only. The API key in `X-Api-Key` must never leave this
process. The refresh-cookie path uses Cookie header (server-to-server),
not browser cookies — HomeAuth's SameSite=Strict cookie wouldn't reach
a cross-site browser anyway.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from http.cookies import SimpleCookie
from typing import Any

import httpx

from src import config

log = logging.getLogger(__name__)

# HomeAuth's refresh cookie name (per integration spec — NOT the same as our session cookie)
_REFRESH_COOKIE_NAME = "homeauth_refresh"


class HomeAuthError(Exception):
    """Raised when HomeAuth refuses or is unreachable. Translates to 401/503."""

    def __init__(self, message: str, *, status_code: int | None = None, unreachable: bool = False):
        super().__init__(message)
        self.status_code = status_code
        self.unreachable = unreachable


@dataclass(frozen=True)
class AuthResult:
    access_token: str
    expires_in: int
    user_id: str
    username: str
    role: str
    refresh_cookie: str | None


def _client() -> httpx.Client:
    return httpx.Client(base_url=config.HOMEAUTH_BASE_URL, timeout=httpx.Timeout(8.0))


def _extract_refresh_cookie(headers: httpx.Headers) -> str | None:
    """Parse Set-Cookie headers and return the homeauth_refresh value, or None."""
    for raw in headers.get_list("set-cookie"):
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            continue
        morsel = jar.get(_REFRESH_COOKIE_NAME)
        if morsel is not None and morsel.value:
            return morsel.value
    return None


def _result_from_auth_response(resp: httpx.Response) -> AuthResult:
    body = resp.json()
    user = body.get("user") or {}
    return AuthResult(
        access_token=body["accessToken"],
        expires_in=int(body.get("expiresIn") or 900),
        user_id=str(user.get("id", "")),
        username=str(user.get("username", "")),
        role=str(user.get("role", "USER")),
        refresh_cookie=_extract_refresh_cookie(resp.headers),
    )


def login(username_or_email: str, password: str) -> AuthResult:
    """Exchange credentials for an access token + refresh cookie."""
    try:
        with _client() as cli:
            resp = cli.post(
                "/auth/login",
                json={"usernameOrEmail": username_or_email, "password": password},
            )
    except httpx.RequestError as e:
        log.warning("HomeAuth unreachable on login: %s", e)
        raise HomeAuthError("auth service unreachable", unreachable=True) from e

    if resp.status_code == 401:
        raise HomeAuthError("invalid credentials", status_code=401)
    if resp.status_code >= 400:
        raise HomeAuthError(f"auth service error: {resp.status_code}", status_code=resp.status_code)
    return _result_from_auth_response(resp)


def refresh(refresh_cookie_value: str) -> AuthResult:
    """Use the stored refresh cookie to obtain a new access token."""
    try:
        with _client() as cli:
            resp = cli.post(
                "/auth/refresh",
                cookies={_REFRESH_COOKIE_NAME: refresh_cookie_value},
            )
    except httpx.RequestError as e:
        log.warning("HomeAuth unreachable on refresh: %s", e)
        raise HomeAuthError("auth service unreachable", unreachable=True) from e

    if resp.status_code == 401:
        raise HomeAuthError("refresh rejected", status_code=401)
    if resp.status_code >= 400:
        raise HomeAuthError(f"auth service error: {resp.status_code}", status_code=resp.status_code)
    result = _result_from_auth_response(resp)
    # If HomeAuth didn't rotate the refresh cookie, keep the old one
    if result.refresh_cookie is None:
        result = AuthResult(
            access_token=result.access_token,
            expires_in=result.expires_in,
            user_id=result.user_id,
            username=result.username,
            role=result.role,
            refresh_cookie=refresh_cookie_value,
        )
    return result


def logout(refresh_cookie_value: str | None) -> None:
    """Best-effort revoke. Errors are swallowed — local session is destroyed anyway."""
    if not refresh_cookie_value:
        return
    try:
        with _client() as cli:
            cli.post(
                "/auth/logout",
                cookies={_REFRESH_COOKIE_NAME: refresh_cookie_value},
            )
    except httpx.RequestError as e:
        log.info("HomeAuth unreachable on logout (continuing): %s", e)


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    user_id: str | None
    username: str | None
    role: str | None
    expires_at: str | None


def validate_token(access_token: str) -> ValidationResult:
    """
    Server-side check via API key. Spec: always 200 unless API key bad.
    Errors / unreachable → fail-closed (treat as invalid).
    """
    if not config.HOMEAUTH_APP_API_KEY:
        raise HomeAuthError(
            "HOMEAUTH_APP_API_KEY is not set — backend cannot validate tokens",
            status_code=500,
        )
    try:
        with _client() as cli:
            resp = cli.post(
                "/auth/validate-token",
                headers={"X-Api-Key": config.HOMEAUTH_APP_API_KEY},
                json={"token": access_token},
            )
    except httpx.RequestError as e:
        log.warning("HomeAuth unreachable on validate-token: %s", e)
        raise HomeAuthError("auth service unreachable", unreachable=True) from e

    if resp.status_code == 401:
        # API key is bad or missing — operator config error, not user error
        raise HomeAuthError("API key rejected by HomeAuth", status_code=401)
    if resp.status_code >= 400:
        raise HomeAuthError(f"auth service error: {resp.status_code}", status_code=resp.status_code)

    body: dict[str, Any] = resp.json()
    return ValidationResult(
        valid=bool(body.get("valid")),
        user_id=body.get("userId"),
        username=body.get("username"),
        role=body.get("role"),
        expires_at=body.get("expiresAt"),
    )
