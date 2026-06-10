"""
In-process per-key sliding-window rate limiter.

Used to cap how fast one user can drive yt-dlp extractions. Every extraction is
a 1-5s subprocess that hits YouTube from the datacenter IP and leans on the
shared cookies — one user spamming search / scripting /api/resolutions can both
saturate the threadpool AND trip YouTube's bot defenses against the cookies
everyone depends on. Memory-only (no Redis); keyed by user_id, which is fine
since everyone is behind HomeAuth and the box is single-process.
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque


class SlidingWindowLimiter:
    def __init__(self, max_events: int, window_seconds: float) -> None:
        self.max_events = max_events
        self.window = window_seconds
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int]:
        """Record an event for `key` if under budget.

        Returns (allowed, retry_after_seconds). When not allowed, no event is
        recorded and retry_after is how long until the oldest event ages out.
        """
        now = time.monotonic()
        cutoff = now - self.window
        with self._lock:
            dq = self._events[key]
            while dq and dq[0] < cutoff:
                dq.popleft()
            if len(dq) >= self.max_events:
                retry = self.window - (now - dq[0])
                return False, max(1, int(retry) + 1)
            dq.append(now)
            if not dq:
                # Shouldn't happen (we just appended), but keep the map from
                # accumulating empty deques for one-shot keys.
                self._events.pop(key, None)
            return True, 0
