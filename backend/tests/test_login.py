"""Login brute-force throttle (commit: rate-limit login)."""
import pytest
from fastapi import HTTPException, Response

from src import config, homeauth
from src.api import auth_routes


def _reject(*_a, **_k):
    raise homeauth.HomeAuthError("invalid credentials", status_code=401)


def _fresh_limiters():
    auth_routes._login_limiter._events.clear()
    auth_routes._login_global_limiter._events.clear()


def _attempt(ident: str) -> int:
    try:
        auth_routes.login(auth_routes.LoginRequest(usernameOrEmail=ident, password="x"), Response())
        return 200
    except HTTPException as exc:
        return exc.status_code


def test_login_throttles_after_cap(monkeypatch):
    _fresh_limiters()
    monkeypatch.setattr(homeauth, "login", _reject)
    codes = [_attempt("attacker@example.com") for _ in range(config.LOGIN_RATELIMIT_MAX + 1)]
    assert codes[-1] == 429            # capped
    assert codes[:-1].count(401) == config.LOGIN_RATELIMIT_MAX  # earlier attempts hit HomeAuth (bad creds)


def test_login_throttle_is_per_account(monkeypatch):
    _fresh_limiters()
    monkeypatch.setattr(homeauth, "login", _reject)
    for _ in range(config.LOGIN_RATELIMIT_MAX + 1):
        _attempt("victim@example.com")
    # A different account still reaches HomeAuth — it's not collaterally locked.
    assert _attempt("someone-else@example.com") == 401
