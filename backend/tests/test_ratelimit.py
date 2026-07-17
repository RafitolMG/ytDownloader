"""Sliding-window limiter: enforcement, retry-after, and idle-key eviction."""
import time

from src.rate_limit import SlidingWindowLimiter


def test_enforces_cap():
    lim = SlidingWindowLimiter(3, 100)
    assert [lim.check("k")[0] for _ in range(4)] == [True, True, True, False]


def test_retry_after_is_positive_when_blocked():
    lim = SlidingWindowLimiter(1, 100)
    lim.check("k")
    allowed, retry = lim.check("k")
    assert allowed is False and retry >= 1


def test_separate_keys_are_independent():
    lim = SlidingWindowLimiter(1, 100)
    assert lim.check("a")[0] is True
    assert lim.check("b")[0] is True   # different key, own budget
    assert lim.check("a")[0] is False  # a is now over


def test_evicts_idle_keys():
    lim = SlidingWindowLimiter(3, 100)
    lim._events["idle"].append(time.monotonic() - 500)  # older than the window
    lim._last_prune = time.monotonic() - 500            # force the periodic sweep
    lim.check("fresh")
    assert "idle" not in lim._events
    assert "fresh" in lim._events
