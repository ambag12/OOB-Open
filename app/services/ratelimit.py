"""A sliding-window rate limiter that needs no infrastructure.

The app is pinned to a single worker by its in-memory workspaces, so an
in-process limiter is exactly as effective as Redis would be here, and one
fewer thing to run.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

# key -> (limit, window seconds)
BUDGETS: dict[str, tuple[int, float]] = {
    "login:ip": (20, 600),
    "login:email": (10, 600),
    "signup:ip": (5, 3600),
    "forgot:ip": (5, 3600),
    "forgot:email": (3, 3600),
    "resend:email": (3, 3600),
    "analyze:user": (10, 300),
}


class SlidingWindow:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, bucket: str, subject: str) -> float:
        """Seconds to wait, or 0.0 if the call is allowed. Records the hit."""
        limit, window = BUDGETS[bucket]
        key = f"{bucket}:{subject}"
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window:
                q.popleft()
            if len(q) >= limit:
                return max(1.0, window - (now - q[0]))
            q.append(now)
            return 0.0

    def reset(self, bucket: str, subject: str) -> None:
        """Forget a subject's history -- called after a successful login."""
        with self._lock:
            self._hits.pop(f"{bucket}:{subject}", None)

    def prune(self) -> None:
        """Drop empty queues so the dictionary cannot grow without bound."""
        now = time.monotonic()
        with self._lock:
            for key in [k for k, q in self._hits.items()
                        if not q or now - q[-1] > max(w for _, w in BUDGETS.values())]:
                self._hits.pop(key, None)


limiter = SlidingWindow()
