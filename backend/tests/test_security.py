"""SSRF url allow-list, object ownership, import cap, and WebSocket auth gate."""
import pytest
from fastapi import HTTPException
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from src import config, db
from src.auth import CurrentUser
from src.api.routes import _cap_import_tracks, _ensure_owner, _validate_youtube_url, app


@pytest.mark.parametrize("url", [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "http://music.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
])
def test_validate_url_allows_youtube(url):
    _validate_youtube_url(url)  # must not raise


@pytest.mark.parametrize("url", [
    "https://youtube.com@evil.com/",     # userinfo trick — hostname is evil.com
    "https://youtube.com.evil.com/",     # suffix trick
    "https://evil.com/youtube.com",      # path, not host
    "https://notyoutube.com/",
    "file:///etc/passwd",                # non-http scheme yt-dlp would honour
    "http://169.254.169.254/latest/",    # cloud metadata
    "ftp://youtube.com/x",               # non-http scheme
    "not a url",
])
def test_validate_url_rejects_non_youtube(url):
    with pytest.raises(HTTPException):
        _validate_youtube_url(url)


def test_ensure_owner_enforces_ownership():
    owner = CurrentUser("s", "u1", "a", "USER")
    other = CurrentUser("s", "u2", "b", "USER")
    admin = CurrentUser("s", "u9", "root", db.ROLE_ADMIN)
    _ensure_owner({"owner_id": "u1"}, owner)  # owner: ok
    _ensure_owner({"owner_id": "u1"}, admin)  # admin bypass: ok
    with pytest.raises(HTTPException) as exc:
        _ensure_owner({"owner_id": "u1"}, other)
    assert exc.value.status_code == 403


def test_import_cap_truncates():
    capped, was = _cap_import_tracks(list(range(config.MAX_IMPORT_TRACKS + 50)))
    assert len(capped) == config.MAX_IMPORT_TRACKS and was is True
    small, was2 = _cap_import_tracks([1, 2, 3])
    assert len(small) == 3 and was2 is False


def test_progress_ws_rejects_anonymous():
    # No cookie and no media token → the handshake must be refused (4401), not
    # accepted with a job snapshot.
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws/progress/whatever") as ws:
                ws.receive_json()
    assert exc.value.code == 4401
