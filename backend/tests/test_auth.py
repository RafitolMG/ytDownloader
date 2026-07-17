"""Session auth: refresh role-sync, absolute expiry, and last_seen throttling."""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from src import auth, config, db, homeauth


def _old_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")


def test_refresh_syncs_demoted_role(new_session, monkeypatch):
    sid, uid = new_session(role="ADMIN")
    monkeypatch.setattr(homeauth, "refresh", lambda rc: homeauth.AuthResult(
        access_token="a1", expires_in=900, user_id=uid, username=uid, role="USER", refresh_cookie="rc1"))
    out = auth._refresh_session(db.get_session(sid))
    assert out["role"] == "USER"
    assert db.get_session(sid)["role"] == "USER"


def test_refresh_guard_keeps_role_on_empty_user_block(new_session, monkeypatch):
    sid, uid = new_session(role="ADMIN")
    # An unexpected empty/mismatched user block must not wipe the identity...
    monkeypatch.setattr(homeauth, "refresh", lambda rc: homeauth.AuthResult(
        access_token="a2", expires_in=900, user_id="", username="", role="USER", refresh_cookie="rc2"))
    auth._refresh_session(db.get_session(sid))
    assert db.get_session(sid)["role"] == "ADMIN"        # unchanged
    assert db.get_session(sid)["access_token"] == "a2"   # ...but tokens still refresh


def test_fresh_session_accepted(new_session):
    sid, uid = new_session(role="USER")
    assert auth.current_user(ytdl_session=sid).user_id == uid


def test_expired_session_rejected_and_deleted(new_session):
    sid, _ = new_session(created_at=_old_iso(config.SESSION_TTL_DAYS + 1))
    with pytest.raises(HTTPException) as exc:
        auth.current_user(ytdl_session=sid)
    assert exc.value.status_code == 401
    assert db.get_session(sid) is None


def test_bulk_sweep_drops_expired_keeps_fresh(new_session):
    old1, _ = new_session(created_at=_old_iso(config.SESSION_TTL_DAYS + 2))
    old2, _ = new_session(created_at=_old_iso(config.SESSION_TTL_DAYS + 2))
    fresh, _ = new_session()
    removed = db.delete_expired_sessions(config.SESSION_TTL_DAYS)
    assert removed >= 2
    assert db.get_session(old1) is None and db.get_session(old2) is None
    assert db.get_session(fresh) is not None


def test_touch_is_throttled(monkeypatch):
    calls = {"n": 0}
    monkeypatch.setattr(db, "touch_session", lambda sid: calls.__setitem__("n", calls["n"] + 1))
    auth._last_touch.clear()
    for _ in range(25):
        auth._touch_session_throttled("s-touch")
    assert calls["n"] == 1
