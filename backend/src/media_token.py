"""
Short-lived, signed, media-scoped tokens.

Native (Capacitor) media requests (<audio>/download) can't carry the httponly
session cookie cross-origin, so the client appends a token as `?mt=`. Using the
raw session id there is dangerous: a URL query param lands in access logs,
Referer headers and proxy history, and the session id IS the full session
credential — a leak is a full account takeover.

Instead we hand out an HMAC-signed token that (a) carries only user_id/username/
role plus an expiry, (b) is scoped to media use ("p":"media"), and (c) expires
quickly. A leak grants at most short-lived media access and can never be replayed
as a session cookie.

Format: `<base64url(payload)>.<base64url(hmac_sha256)>`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

from src import config

# Pin the secret via env in production (and across replicas) so tokens survive a
# restart and verify on every worker. Otherwise a fresh per-process secret just
# invalidates outstanding tokens on restart — the client re-fetches transparently.
_SECRET = (config.MEDIA_TOKEN_SECRET or secrets.token_urlsafe(32)).encode()


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sign(body: str) -> str:
    return _b64e(hmac.new(_SECRET, body.encode(), hashlib.sha256).digest())


def mint(user_id: str, username: str, role: str) -> tuple[str, int]:
    """Return (token, expires_in_seconds) for a media-scoped token."""
    ttl = config.MEDIA_TOKEN_TTL_SEC
    payload = {
        "p": "media",
        "uid": user_id,
        "un": username,
        "r": role,
        "exp": int(time.time()) + ttl,
    }
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}", ttl


def verify(token: str) -> dict | None:
    """Return the claims dict for a valid, unexpired media token, else None."""
    try:
        body, sig = token.split(".", 1)
    except ValueError:
        return None
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        payload = json.loads(_b64d(body))
    except Exception:
        return None
    if payload.get("p") != "media":
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload
