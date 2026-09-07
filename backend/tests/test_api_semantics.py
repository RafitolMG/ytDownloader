"""An outage must not look like an empty result, and a rejected write must not
look like a successful one."""
import pytest

from src import db, discovery, search


def test_get_album_distinguishes_a_dead_upstream_from_a_missing_album(monkeypatch):
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))

    def boom(album_id):
        raise search.UpstreamUnavailable("youtube music unreachable")

    monkeypatch.setattr(search, "_extract_album_raw", boom)
    with pytest.raises(search.UpstreamUnavailable):
        search.get_album("MPREbDead")

    # An album the upstream *answered* for still comes back, tracklist and all —
    # only the failure is an exception now.
    monkeypatch.setattr(search, "_extract_album_raw", lambda aid: {"entries": []})
    assert search.get_album("MPREbEmpty")["tracks"] == []


def test_a_failed_upstream_is_never_cached_as_an_empty_album(monkeypatch):
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    calls = []

    def flaky(album_id):
        calls.append(album_id)
        if len(calls) == 1:
            raise search.UpstreamUnavailable("blip")
        return {"title": "Album - Real", "entries": [{"id": "v1", "title": "t"}]}

    monkeypatch.setattr(search, "_extract_album_raw", flaky)
    with pytest.raises(search.UpstreamUnavailable):
        search.get_album("MPREbFlaky")
    assert len(search.get_album("MPREbFlaky")["tracks"]) == 1


def test_discover_surfaces_a_search_outage_instead_of_an_empty_feed(monkeypatch):
    monkeypatch.setattr(discovery.ytmusic, "search_songs", lambda q, limit: [])

    def boom(q, limit):
        raise RuntimeError("HTTP Error 429: Too Many Requests")

    monkeypatch.setattr(discovery.search_mod, "search", boom)
    monkeypatch.setattr(discovery.db, "list_catalog", lambda *a, **kw: [])

    with pytest.raises(search.UpstreamUnavailable):
        discovery._discover_feed("u1", "nine inch nails", 20, 12)


def test_update_playlist_rejects_a_bad_visibility_instead_of_dropping_the_patch():
    """It used to return False for an invalid visibility, which discarded the
    valid fields alongside it while the route still answered 200 {"ok": true}."""
    pid = "pl-visibility-test"
    db.create_playlist(playlist_id=pid, owner_id="u1", name="original")
    with pytest.raises(ValueError):
        db.update_playlist(pid, name="new name", visibility="everyone")
    assert db.get_playlist(pid)["name"] == "original"


def test_playlist_update_model_constrains_visibility():
    from pydantic import ValidationError

    from src.api.routes import PlaylistUpdate

    assert PlaylistUpdate(visibility="private").visibility == "private"
    with pytest.raises(ValidationError):
        PlaylistUpdate(visibility="everyone")


# ── Catalog search: literal terms, accent- and case-insensitive ───────────────

def _seed_catalog():
    for vid, title, artist in [
        ("s1", "Canción Bonita", "Carlos Vives"),
        ("s2", "Plain Song", "Someone"),
        ("s3", "100% Real", "ЗАВОД"),
        ("s4", "snake_case", "Someone"),
    ]:
        db.register_track(
            video_id=vid, codec="mp3", bitrate="320", title=title, artist=artist,
            duration_sec=100, thumbnail_url=None, source_url="u", file_path=f"/{vid}",
            file_size=1, sha256=vid,
        )


def _titles(query):
    return sorted(
        r["title"] for r in db.list_catalog("viewer", query=query, limit=50)
    )


def test_search_folds_accents_and_case():
    _seed_catalog()
    assert "Canción Bonita" in _titles("cancion")
    assert "Canción Bonita" in _titles("CANCIÓN")
    assert "Canción Bonita" in _titles("bonita")
    assert "100% Real" in _titles("завод")  # non-ASCII case folding too


def test_search_treats_wildcards_literally():
    """`%` used to be a live LIKE metacharacter, so typing it dumped the catalog."""
    _seed_catalog()
    assert _titles("%") == ["100% Real"]
    assert _titles("_") == ["snake_case"]
    assert _titles("100%") == ["100% Real"]
