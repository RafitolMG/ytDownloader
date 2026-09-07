"""Request-size limits, and the progress hub's subscribe-before-snapshot order."""
import asyncio

import pytest
from fastapi.testclient import TestClient

from src import config, homeauth
from src.api import auth_routes
from src.api.routes import _ProgressHub, app

client = TestClient(app)


def test_rejects_a_body_that_declares_it_is_too_large():
    r = client.post(
        "/api/playlists",
        content=b"x" * (config.MAX_REQUEST_BYTES + 1),
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 413


def test_rejects_an_oversized_chunked_body_with_no_content_length():
    """content-length is only a claim — a chunked upload can omit it entirely."""
    chunk = b"y" * 65536
    count = config.MAX_REQUEST_BYTES // len(chunk) + 2

    def stream():
        for _ in range(count):
            yield chunk

    r = client.post(
        "/api/playlists", content=stream(), headers={"content-type": "application/json"}
    )
    assert r.status_code == 413


def test_a_normal_body_still_reaches_the_handler(monkeypatch):
    """The first attempt at this limiter read the body and could not put it back,
    which turned every POST in the app into a 422. /api/auth/login is the canary:
    it is unauthenticated, so a 422 here can only mean the body went missing."""
    def reject(username, password):
        raise homeauth.HomeAuthError("nope", status_code=401)

    monkeypatch.setattr(auth_routes.homeauth, "login", reject)
    monkeypatch.setattr(auth_routes, "_is_known_account", lambda ident: True)

    r = client.post(
        "/api/auth/login", json={"usernameOrEmail": "someone", "password": "pw"}
    )
    assert r.status_code == 401, r.text


def test_get_requests_are_untouched():
    assert client.get("/api/health").status_code == 200


@pytest.mark.parametrize(
    "model_name, payload",
    [
        ("PlaylistCreate", {"name": "n" * 500}),
        ("PlaylistCreate", {"name": "ok", "description": "d" * 5000}),
        ("TrackImportRequest", {"source": "s" * (config.MAX_IMPORT_SOURCE_CHARS + 1)}),
        ("DownloadRequest", {"url": "u" * 4000, "format_code": "mp3-320"}),
    ],
)
def test_oversized_fields_are_rejected_by_the_model(model_name, payload):
    from pydantic import ValidationError

    from src.api import routes

    with pytest.raises(ValidationError):
        getattr(routes, model_name)(**payload)


def test_progress_hub_drops_events_published_before_subscribing():
    """This is why the websocket subscribes *before* reading its snapshot: an
    event published in between used to reach nobody, so a client could get a
    snapshot saying 'downloading' and then silence."""

    async def scenario():
        hub = _ProgressHub()
        loop = asyncio.get_running_loop()

        hub.put({"type": "done"})          # nobody listening yet
        sub = hub.subscribe(loop)
        assert sub.empty(), "a late subscriber must not receive past events"

        hub.put({"type": "done"})          # published after subscribing
        await asyncio.sleep(0)             # let call_soon_threadsafe land
        assert sub.get_nowait() == {"type": "done"}

    asyncio.run(scenario())
