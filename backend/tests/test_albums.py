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


# ── Resolving a library album whose tracks came from plain YouTube ────────────

def test_normalize_title_folds_accents_and_asides_but_keeps_other_scripts():
    """These keys must equal what AlbumsPage.normalizeTitle produces — the two
    sides compare them directly. An ASCII-only filter used to fold every
    Cyrillic title to "", i.e. to "never matches"."""
    assert search.normalize_title("Cirugía") == "cirugia"
    assert search.normalize_title("HEGEMONICA (feat. L-Gante)") == "hegemonica"
    assert search.normalize_title("Últimamente") == "ultimamente"
    assert search.normalize_title("ЗаВоД - Ремикс") == "завод ремикс"
    assert search.normalize_title("100% Real") == "100 real"
    assert search.normalize_title(None) == ""


def test_resolve_prefers_the_edition_holding_our_titles_when_ids_do_not_match(monkeypatch):
    """A track downloaded from plain YouTube carries a different video id than
    its YouTube Music twin, so an id-only signal scores 0 against every
    candidate and the fullest unrelated album wins."""
    albums = {
        "MPREbRight": {
            "title": "Album - Por cesárea", "playlist_count": 3,
            "entries": [
                {"id": "ytm1", "title": "Cirugía", "channel": "Dillom"},
                {"id": "ytm2", "title": "La carie", "channel": "Dillom"},
                {"id": "ytm3", "title": "Últimamente", "channel": "Dillom"},
            ],
        },
        # Bigger, and would win on track_count alone.
        "MPREbWrong": {
            "title": "Album - POST MORTEM", "playlist_count": 5,
            "entries": [
                {"id": f"other{i}", "title": f"Unrelated {i}", "channel": "Dillom"}
                for i in range(5)
            ],
        },
    }
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    monkeypatch.setattr(search, "_extract_album_raw", lambda aid: albums[aid])
    monkeypatch.setattr(
        search, "_search_album_ids", lambda q, limit: ["MPREbWrong", "MPREbRight"]
    )

    ids_only = search.resolve_album("dillom por cesarea", owned_ids={"plainYT1", "plainYT2"})
    assert ids_only["title"] == "POST MORTEM"  # the failure being fixed

    with_titles = search.resolve_album(
        "dillom por cesarea",
        owned_ids={"plainYT1", "plainYT2"},
        owned_titles={"Cirugía", "La carie"},
    )
    assert with_titles["title"] == "Por cesárea"


def test_title_overlap_does_not_double_count_a_track_matched_by_id(monkeypatch):
    info = {
        "title": "Album - X", "playlist_count": 1,
        "entries": [{"id": "v1", "title": "Only Song", "channel": "A"}],
    }
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    monkeypatch.setattr(search, "_extract_album_raw", lambda aid: info)
    monkeypatch.setattr(search, "_search_album_ids", lambda q, limit: ["MPREbX"])

    a = search.resolve_album("x", owned_ids={"v1"}, owned_titles={"Only Song"})
    assert len(a["tracks"]) == 1


def test_resolve_widens_when_the_artist_buries_the_album(monkeypatch):
    """Naming the artist sharpens most searches but narrows against anything
    YouTube Music credits to someone else. The reported case: an Elden Ring DLC
    soundtrack, where "<composer> <album>" returned only the base game's album
    and the bare title returned the right one."""
    dlc = {
        "title": "Album - SHADOW OF THE ERDTREE OST", "playlist_count": 2,
        "entries": [
            {"id": "ytm-a", "title": "Messmer, the Impaler", "channel": "Tsukasa Saitoh"},
            {"id": "ytm-b", "title": "Bayle the Dread", "channel": "Tai Tomisawa"},
        ],
    }
    base = {
        "title": "Album - ELDEN RING OST", "playlist_count": 3,
        "entries": [
            {"id": f"base{i}", "title": f"Base Track {i}", "channel": "Tsukasa Saitoh"}
            for i in range(3)
        ],
    }
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    monkeypatch.setattr(
        search, "_extract_album_raw", lambda aid: dlc if aid == "MPREbDlc" else base
    )
    searched: list[str] = []

    def fake_search(q, limit):
        searched.append(q)
        # The artist-prefixed query only surfaces the base game's album.
        return ["MPREbBase"] if q.startswith("Tsukasa Saitoh") else ["MPREbBase", "MPREbDlc"]

    monkeypatch.setattr(search, "_search_album_ids", fake_search)

    owned = {"Messmer, the Impaler", "Bayle the Dread"}
    narrow = search.resolve_album(
        "Tsukasa Saitoh SHADOW OF THE ERDTREE OST", owned_titles=owned
    )
    assert narrow["title"] == "ELDEN RING OST"  # the failure being fixed

    searched.clear()
    widened = search.resolve_album(
        "Tsukasa Saitoh SHADOW OF THE ERDTREE OST",
        owned_titles=owned,
        fallback_q="SHADOW OF THE ERDTREE OST",
    )
    assert widened["title"] == "SHADOW OF THE ERDTREE OST"
    assert len(searched) == 2, "the precise query runs first"


def test_resolve_does_not_widen_once_it_has_a_hit(monkeypatch):
    """The second search is a round-trip; skip it when the first query already
    found an album holding something we own."""
    info = {
        "title": "Album - Right", "playlist_count": 1,
        "entries": [{"id": "v1", "title": "Song", "channel": "A"}],
    }
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    monkeypatch.setattr(search, "_extract_album_raw", lambda aid: info)
    searched: list[str] = []
    monkeypatch.setattr(
        search, "_search_album_ids", lambda q, limit: (searched.append(q), ["MPREbR"])[1]
    )

    search.resolve_album("A Right", owned_ids={"v1"}, fallback_q="Right")
    assert searched == ["A Right"]


def test_resolve_does_not_widen_with_nothing_to_match_against(monkeypatch):
    """No ids and no titles means every candidate scores 0 — a second search
    could not tell them apart, so it would only cost a round-trip."""
    info = {
        "title": "Album - X", "playlist_count": 1,
        "entries": [{"id": "v1", "title": "Song", "channel": "A"}],
    }
    monkeypatch.setattr(search, "_ALBUM_CACHE", search._TTLCache(ttl_seconds=1800))
    monkeypatch.setattr(search, "_extract_album_raw", lambda aid: info)
    searched: list[str] = []
    monkeypatch.setattr(
        search, "_search_album_ids", lambda q, limit: (searched.append(q), ["MPREbX"])[1]
    )

    search.resolve_album("A X", fallback_q="X")
    assert searched == ["A X"]
