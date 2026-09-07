"""
Short-lived, signed, media-scoped tokens.

Native (Capacitor) media requests (<audio>/download) can't carry the httponly
session cookie cross-origin, so the client appends a token as `?mt=`. Using the
raw session id there is dangerous: a URL query param lands in access logs,
Referer headers and proxy history, and the session id IS the full session
credential — a leak is a full account takeover.

Instead we hand out an HMAC-signed token that (a) is bound to the session that
requested it (the `sid` claim), (b) is scoped to media use ("p":"media") and to
one route class (the `scp` claim), and (c) expires. It carries no identity/role
of its own — the caller is resolved from the live session row at use time — so
logout (session deleted) and role changes take effect immediately, and a leak
grants at most media access that dies with the session and can never be replayed
as a cookie.

"Expires" is not "expires quickly" for streaming: see SCOPE_STREAM below.

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


# Route classes a token can be minted for. "stream" has to outlive a whole track
# (the <audio> element keeps issuing Range requests against the URL it was given,
# so an expiry mid-song breaks playback) — which is why its TTL is an hour, not
# the "expires quickly" this module used to claim. "file" is used once,
# immediately, so it gets seconds. Splitting them means a `mt` captured from an
# access log buys catalog streaming, not the caller's finished downloads.
SCOPE_STREAM = "stream"
SCOPE_FILE = "file"
_SCOPE_TTL = {
    SCOPE_STREAM: lambda: config.MEDIA_TOKEN_TTL_SEC,
    SCOPE_FILE: lambda: config.FILE_TOKEN_TTL_SEC,
}


def mint(user_id: str, session_id: str, scope: str = SCOPE_STREAM) -> tuple[str, int]:
    """Return (token, expires_in_seconds) for a media token bound to the session
    that requested it and to one route class. `uid` is informational (logging);
    authorization is done against the live session identified by `sid` at verify
    time."""
    if scope not in _SCOPE_TTL:
        raise ValueError(f"unknown media token scope: {scope!r}")
    ttl = _SCOPE_TTL[scope]()
    payload = {
        "p": "media",
        "scp": scope,
        "uid": user_id,
        "sid": session_id,
        "exp": int(time.time()) + ttl,
    }
    body = _b64e(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body)}", ttl


def verify(token: str, scope: str = SCOPE_STREAM) -> dict | None:
    """Return the claims dict for a valid, unexpired, session-bound media token
    minted for `scope`, else None. A token without a `sid` (malformed or minted
    by an older build) is rejected so it can't be used unbound."""
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
    # Tokens from a build before scoping carried no `scp`; they were usable
    # everywhere, so honour them only for the wider streaming class.
    if payload.get("scp", SCOPE_STREAM) != scope:
        return None
    if not payload.get("sid"):
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    return payload
