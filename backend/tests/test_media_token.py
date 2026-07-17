"""Media tokens are bound to their session (commit: bind media tokens)."""
import base64
import json

import pytest
from fastapi import HTTPException

from src import db, media_token
from src.auth import media_user


def test_mint_binds_to_session_without_identity_claims():
    token, ttl = media_token.mint("u1", "sid-x")
    claims = media_token.verify(token)
    assert claims is not None
    assert claims["sid"] == "sid-x"
    # No frozen identity/role travels in the token — it's read live from the session.
    assert "un" not in claims and "r" not in claims


def test_media_user_resolves_identity_from_live_session(new_session):
    sid, uid = new_session(role="USER")
    token, _ = media_token.mint(uid, sid)
    user = media_user(mt=token, ytdl_session=None)
    assert user.user_id == uid and user.role == "USER"


def test_reflects_live_role_change(new_session):
    sid, uid = new_session(role="USER")
    token, _ = media_token.mint(uid, sid)
    db.update_session_tokens(sid, access_token="t2", access_expires_at="2999-01-01T00:00:00+00:00", role="ADMIN")
    assert media_user(mt=token, ytdl_session=None).role == "ADMIN"


def test_revoked_when_session_deleted(new_session):
    sid, uid = new_session()
    token, _ = media_token.mint(uid, sid)
    db.delete_session(sid)
    with pytest.raises(HTTPException) as exc:
        media_user(mt=token, ytdl_session=None)
    assert exc.value.status_code == 401


def test_sidless_token_rejected():
    body = base64.urlsafe_b64encode(
        json.dumps({"p": "media", "uid": "u1", "exp": 9999999999}).encode()
    ).rstrip(b"=").decode()
    assert media_token.verify(f"{body}.{media_token._sign(body)}") is None


def test_tampered_signature_rejected():
    token, _ = media_token.mint("u1", "sid-x")
    body, _sig = token.split(".", 1)
    assert media_token.verify(f"{body}.deadbeef") is None
