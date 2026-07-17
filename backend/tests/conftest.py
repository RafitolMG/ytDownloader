"""Shared test setup.

Point the DB at a throwaway dir and disable the auth bypass BEFORE importing the
app (config reads the environment at import time), then init the schema once.
Tests exercise the auth/token/rate-limit logic through direct function calls —
reliable and fast, and they don't depend on cross-thread TestClient behaviour.
"""
import os
import tempfile

os.environ["YTDL_DATA_DIR"] = tempfile.mkdtemp(prefix="ytdl_pytest_")
os.environ.pop("DEV_AUTH_BYPASS", None)
os.environ.setdefault("YTDL_LOGIN_FAIL_DELAY_SEC", "0")  # keep the throttle tests fast

import pytest  # noqa: E402
from src import db  # noqa: E402

db.init()

FUTURE = "2999-01-01T00:00:00+00:00"
_counter = {"n": 0}


@pytest.fixture
def new_session():
    """Create a session row and return (session_id, user_id). `created_at` lets a
    test backdate the row to exercise expiry. Ids are unique per call so tests
    sharing the process-wide DB don't collide."""
    def _make(*, role: str = "USER", created_at: str | None = None):
        _counter["n"] += 1
        sid = f"sid-{_counter['n']}"
        uid = f"u-{_counter['n']}"
        db.create_session(
            session_id=sid, user_id=uid, username=uid, role=role,
            access_token="t", refresh_cookie="rc", access_expires_at=FUTURE,
        )
        if created_at:
            with db._write() as c:
                c.execute("UPDATE sessions SET created_at=? WHERE id=?", (created_at, sid))
        return sid, uid
    return _make
