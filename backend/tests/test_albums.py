"""Album resolution regression tests.

The album cache is process-wide and long-lived (30 min), so a caller that
reshapes the dict it gets back empties the album for every later request. That
showed up as albums opening with no tracklist and library albums silently
falling back to the owned-only view.
"""
from src import search
from src.api.routes import _album_payload


def _fake_album(monkeypatch, track_ids):
    info = {
        "title": "Album - Test Record",
        "playlist_count": len(track_ids),
        "entries": [
            {"id": vid, "title": f"track {vid}", "channel": "The Band", "thumbnail": "t"}
            for vid in track_ids
        ],
    }
    monkeypatch.setattr(search, "_extract_album_raw", lambda album_id: info)
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))


def test_get_album_cache_survives_a_mutating_caller(monkeypatch):
    _fake_album(monkeypatch, ["v1", "v2", "v3"])

    first = search.get_album("MPREbTest")
    assert len(first["tracks"]) == 3
    first.pop("tracks")  # a caller reshaping its own copy

    assert len(search.get_album("MPREbTest")["tracks"]) == 3


def test_resolve_album_keeps_scoring_on_a_warm_cache(monkeypatch):
    _fake_album(monkeypatch, ["v1", "v2", "v3"])
    monkeypatch.setattr(search, "_search_album_ids", lambda q, limit: ["MPREbTest"])

    search.resolve_album("test record", owned_ids={"v1", "v2"}).pop("tracks")

    again = search.resolve_album("test record", owned_ids={"v1", "v2"})
    assert [t["id"] for t in again["tracks"]] == ["v1", "v2", "v3"]


def test_album_payload_does_not_consume_the_album(monkeypatch):
    _fake_album(monkeypatch, ["v1", "v2"])
    album = search.get_album("MPREbTest")

    payload = _album_payload("viewer", album)

    assert [t["video_id"] for t in payload["tracks"]] == ["v1", "v2"]
    assert "tracks" not in payload["album"]  # header only — not duplicated
    assert len(album["tracks"]) == 2, "payload must not consume its argument"


def test_album_payload_dedupes_repeated_track_ids(monkeypatch):
    _fake_album(monkeypatch, ["v1", "v1", "v2"])

    payload = _album_payload("viewer", search.get_album("MPREbTest"))

    assert [t["video_id"] for t in payload["tracks"]] == ["v1", "v2"]
