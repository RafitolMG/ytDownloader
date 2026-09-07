"""Regressions for the audit fixes: rate-limit coverage, cache poisoning, and
unbounded in-memory maps."""
import threading

from src import discovery, search
from src.api import auth_routes


def _dependency_names(path: str, method: str = "POST") -> set[str]:
    """Names of the dependency callables FastAPI resolves for a route."""
    from src.api.routes import app

    for route in app.routes:
        if getattr(route, "path", None) == path and method in getattr(route, "methods", ()):
            return {d.call.__name__ for d in route.dependant.dependencies if d.call}
    raise AssertionError(f"route not found: {method} {path}")


def test_retry_carries_the_extraction_budget():
    """retry_job re-enters the download handlers as plain calls, so it has to
    declare the limiter itself — theirs never evaluates."""
    assert "rate_limit_extraction" in _dependency_names("/api/jobs/{job_id}/retry")


def test_album_search_does_not_cache_an_upstream_failure(monkeypatch):
    monkeypatch.setattr(search, "_ALBUM_SEARCH_CACHE", search._TTLCache(ttl_seconds=1800))

    def boom(q, limit):
        raise search._AlbumSearchUnavailable("upstream blip")

    monkeypatch.setattr(search, "_search_album_ids", boom)
    assert search.search_albums("nine inch nails") == []

    # Upstream recovers: the next call must hit it again, not the cached [].
    monkeypatch.setattr(search, "_search_album_ids", lambda q, limit: ["MPREbOk"])
    monkeypatch.setattr(search, "_album_card", lambda aid: {"album_id": aid})
    assert search.search_albums("nine inch nails") == [{"album_id": "MPREbOk"}]


def test_album_search_still_caches_a_genuine_empty(monkeypatch):
    monkeypatch.setattr(search, "_ALBUM_SEARCH_CACHE", search._TTLCache(ttl_seconds=1800))
    calls = []

    def none_found(q, limit):
        calls.append(q)
        return []

    monkeypatch.setattr(search, "_search_album_ids", none_found)
    assert search.search_albums("zzzz") == []
    assert search.search_albums("zzzz") == []
    assert len(calls) == 1


def test_related_cache_is_keyed_by_limit(monkeypatch):
    """Truncation happens upstream via `playlist_items`, so a cache keyed on the
    bare video id served a 40-item radio request the 12 items a suggestions call
    had already stored."""
    monkeypatch.setattr(search, "_RELATED_CACHE", search._TTLCache(ttl_seconds=900))
    ranges = []

    def fake_extract(self, url, download=False):
        ranges.append(self.params.get("playlist_items"))
        return {"entries": [{"id": f"v{i}", "title": f"t{i}"} for i in range(40)]}

    monkeypatch.setattr(search.yt_dlp.YoutubeDL, "extract_info", fake_extract)

    search.related("seed", limit=12)
    search.related("seed", limit=40)
    assert ranges == ["1-13", "1-41"], "a wider request must re-fetch, not reuse"

    search.related("seed", limit=12)
    assert len(ranges) == 2, "an identical request must still be served from cache"


def test_ttl_cache_survives_concurrent_eviction():
    cache = search._TTLCache(ttl_seconds=60, max_entries=50)
    errors = []

    def hammer(offset):
        try:
            for i in range(500):
                cache.set(f"{offset}:{i}", i)
                cache.get(f"{offset}:{i}")
        except Exception as e:  # pragma: no cover - the regression being guarded
            errors.append(e)

    threads = [threading.Thread(target=hammer, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(cache._store) <= 50


def test_roll_memory_outer_map_is_bounded():
    for n in range(discovery._ROLL_MEMORY_MAX_KEYS + 200):
        discovery.record_roll("u1", f"radio:{n}", 1, ["a"])
    assert len(discovery._roll_memory) <= discovery._ROLL_MEMORY_MAX_KEYS


def test_known_account_is_exempt_from_the_global_login_cap():
    """A username-rotation flood must not lock out people who already use the box."""
    ident = "regular@example.com"
    auth_routes._remember_account(ident)
    for n in range(auth_routes.config.LOGIN_RATELIMIT_GLOBAL_MAX + 10):
        auth_routes._login_global_limiter.check("*")

    assert auth_routes._is_known_account(ident) is True
    assert auth_routes._is_known_account("newcomer@example.com") is False


def test_known_accounts_map_is_bounded():
    for n in range(auth_routes._KNOWN_ACCOUNTS_MAX + 50):
        auth_routes._remember_account(f"u{n}@example.com")
    assert len(auth_routes._known_accounts) <= auth_routes._KNOWN_ACCOUNTS_MAX
