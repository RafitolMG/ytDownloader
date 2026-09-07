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


# ── Media token scoping, cover allowlist, error redaction ────────────────────

def test_a_streaming_token_cannot_fetch_a_job_file():
    """A `mt` lifted from an access log buys catalog streaming — not the
    caller's finished downloads."""
    from src import media_token

    stream, _ = media_token.mint("u1", "s1", media_token.SCOPE_STREAM)
    assert media_token.verify(stream, scope=media_token.SCOPE_STREAM) is not None
    assert media_token.verify(stream, scope=media_token.SCOPE_FILE) is None

    file_token, ttl = media_token.mint("u1", "s1", media_token.SCOPE_FILE)
    assert media_token.verify(file_token, scope=media_token.SCOPE_FILE) is not None
    assert media_token.verify(file_token, scope=media_token.SCOPE_STREAM) is None
    assert ttl <= config.MEDIA_TOKEN_TTL_SEC


def test_file_route_takes_the_narrow_scope():
    from src.api.routes import app

    for route in app.routes:
        if getattr(route, "path", None) == "/api/file/{job_id}":
            names = {d.call.__name__ for d in route.dependant.dependencies if d.call}
            assert names == {"dependency"}, names  # media_user_for(...), not media_user
            return
    raise AssertionError("route not found")


@pytest.mark.parametrize(
    "url",
    [
        "https://attacker.example/pixel.png?u=victim",
        "http://i.ytimg.com/vi/abc.jpg",
        "https://evil.i.ytimg.com.attacker.net/x.png",
        "javascript:alert(1)",
    ],
)
def test_playlist_cover_rejects_a_third_party_beacon(url):
    from pydantic import ValidationError

    from src.api.routes import PlaylistUpdate

    with pytest.raises(ValidationError):
        PlaylistUpdate(cover_url=url)


def test_playlist_cover_accepts_a_youtube_thumbnail():
    from src.api.routes import PlaylistUpdate

    ok = "https://i.ytimg.com/vi/abc/hqdefault.jpg"
    assert PlaylistUpdate(cover_url=ok).cover_url == ok


def test_error_text_loses_paths_and_signed_urls_but_keeps_the_message():
    from src.api.routes import safe_error

    assert safe_error("cookiefile /tmp/yt-cookies-ab12.txt not found") == (
        "cookiefile <path> not found"
    )
    assert "googlevideo" not in safe_error(
        "403 for url https://rr3---sn-x.googlevideo.com/videoplayback?sig=SECRET"
    )
    # The part the user needs must survive.
    assert safe_error("Sign in to confirm you're not a bot") == (
        "Sign in to confirm you're not a bot"
    )
    assert len(safe_error("x" * 5000)) <= 300


def test_extraction_health_reports_each_upstream_separately(monkeypatch):
    """Albums die with youtube music while downloads keep working, so one
    aggregate flag can't describe the failure — it used to say "ok" while every
    album screen came back empty."""
    from src.api import routes

    monkeypatch.setattr(routes, "_probe_video", lambda: (True, None))
    monkeypatch.setattr(
        routes, "_probe_music", lambda: (False, "youtube music: blocked")
    )
    monkeypatch.setattr(
        routes, "_health_probe",
        {"checked_at": 0.0, "ok": None, "error": None, "video_ok": None, "music_ok": None},
    )

    r = client.get("/api/health/extraction")
    assert r.status_code == 503
    body = r.json()
    assert body["youtube_ok"] is True
    assert body["youtube_music_ok"] is False
    assert body["status"] == "degraded"
    assert "youtube music" in body["error"]
