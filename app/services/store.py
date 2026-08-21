"""Per-user upload workspaces.

The local serve.py keeps one process-wide Session; hosted mode keeps one of
these per signed-in user. Two lock levels, and the order matters: the store
lock only ever guards the dictionary, never file I/O and never the analysis
itself, so one user's thirty-second run cannot block another user's file list.
"""

from __future__ import annotations

import logging
import re
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import BinaryIO

log = logging.getLogger(__name__)

ALLOWED_SUFFIXES = (".xlsx", ".xlsm", ".csv", ".tsv")
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")
_CHUNK = 1 << 20


class UploadTooLarge(Exception):
    """Raised when a file, or the workspace total, would exceed its cap."""


def safe_name(raw: str, index: int) -> str:
    """A filename that cannot escape the workspace directory.

    serve.py used `Path(name).name`, which is Windows-shaped: on Linux a
    backslash is an ordinary filename character, so 'a\\b.xlsx' comes back whole
    and '..' survives intact. Strip to an explicit allowlist instead.
    """
    base = PurePosixPath(raw.replace("\\", "/")).name
    base = _UNSAFE.sub("_", base).lstrip(".")[:100]
    if not base:
        base = "upload.xlsx"
    if not base.lower().endswith(ALLOWED_SUFFIXES):
        raise ValueError("Only .xlsx, .xlsm, .csv and .tsv files can be analysed.")
    return f"{index}_{base}"


@dataclass
class UserWorkspace:
    """One user's uploads and their most recent analysis."""

    user_id: int
    dir: Path
    history: list[Path] = field(default_factory=list)
    perf: Path | None = None
    last: dict | None = None            # AnalysisResult.artifacts
    bytes_used: int = 0
    touched: float = field(default_factory=time.monotonic)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def touch(self) -> None:
        self.touched = time.monotonic()

    def add(self, filename: str, src: BinaryIO, kind: str,
            max_file_bytes: int, max_total_bytes: int) -> Path:
        """Stream an upload to disk, enforcing both caps as it goes.

        The size is checked while writing rather than from Content-Length: that
        header is absent under chunked encoding, and it is the client's claim
        either way.
        """
        target = self.dir / safe_name(filename, len(self.history))
        written = 0
        try:
            with target.open("wb") as fh:
                while chunk := src.read(_CHUNK):
                    written += len(chunk)
                    if written > max_file_bytes:
                        raise UploadTooLarge("That file is too large.")
                    if self.bytes_used + written > max_total_bytes:
                        raise UploadTooLarge(
                            "That would use more working space than one account is "
                            "allowed. Start over to clear the files you have loaded.")
                    fh.write(chunk)
        except BaseException:
            target.unlink(missing_ok=True)
            raise

        if not written:
            target.unlink(missing_ok=True)
            raise ValueError("That file was empty.")

        self.bytes_used += written
        if kind == "perf":
            # Replacing the performance report leaves the old file behind on
            # disk; it is bounded by the workspace cap and cleared on reset.
            self.perf = target
        else:
            self.history.append(target)
        return target

    def names(self) -> dict:
        """What /api/state reports: original filenames, index prefix removed."""
        return {
            "history": [p.name.split("_", 1)[-1] for p in self.history],
            "perf": self.perf.name.split("_", 1)[-1] if self.perf else None,
        }

    def clear(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.history.clear()
        self.perf = None
        self.last = None
        self.bytes_used = 0

    def dispose(self) -> None:
        self.last = None
        shutil.rmtree(self.dir, ignore_errors=True)


class WorkspaceStore:
    """Workspaces keyed by user id, with idle and size eviction."""

    def __init__(self, root: Path, *, idle_ttl_s: float, max_workspaces: int,
                 max_total_bytes: int) -> None:
        self.root = root
        self.idle_ttl_s = idle_ttl_s
        self.max_workspaces = max_workspaces
        self.max_total_bytes = max_total_bytes
        self._spaces: dict[int, UserWorkspace] = {}
        self._lock = threading.RLock()

    def start(self) -> None:
        """Begin from a clean slate. Nothing here is meant to outlive a restart."""
        shutil.rmtree(self.root, ignore_errors=True)
        self.root.mkdir(parents=True, exist_ok=True)

    def get(self, user_id: int) -> UserWorkspace:
        with self._lock:
            ws = self._spaces.get(user_id)
            if ws is None:
                path = self.root / f"u{user_id}"
                shutil.rmtree(path, ignore_errors=True)
                path.mkdir(parents=True, exist_ok=True)
                try:
                    path.chmod(0o700)
                except OSError:                 # no-op on Windows
                    pass
                ws = UserWorkspace(user_id=user_id, dir=path)
                self._spaces[user_id] = ws
            ws.touch()
            return ws

    def peek(self, user_id: int) -> UserWorkspace | None:
        with self._lock:
            return self._spaces.get(user_id)

    def drop(self, user_id: int) -> None:
        with self._lock:
            ws = self._spaces.pop(user_id, None)
        if ws is not None:
            ws.dispose()

    def total_bytes(self) -> int:
        with self._lock:
            return sum(w.bytes_used for w in self._spaces.values())

    def sweep(self) -> int:
        """Evict idle workspaces, then the least recently used ones until the
        count and byte budgets are satisfied. Returns how many were dropped."""
        now = time.monotonic()
        with self._lock:
            doomed = [uid for uid, w in self._spaces.items()
                      if now - w.touched > self.idle_ttl_s]

            survivors = sorted(
                ((uid, w) for uid, w in self._spaces.items() if uid not in doomed),
                key=lambda kv: kv[1].touched,
            )
            while len(survivors) > self.max_workspaces:
                uid, _ = survivors.pop(0)
                doomed.append(uid)

            total = sum(w.bytes_used for _, w in survivors)
            while total > self.max_total_bytes and survivors:
                uid, w = survivors.pop(0)
                total -= w.bytes_used
                doomed.append(uid)

            evicted = [self._spaces.pop(uid) for uid in doomed if uid in self._spaces]

        # Deliberately outside the lock: rmtree of a few hundred megabytes
        # would otherwise stall every other request touching the store.
        for ws in evicted:
            ws.dispose()
        if evicted:
            log.info("evicted %d workspace(s)", len(evicted))
        return len(evicted)

    def dispose_all(self) -> None:
        with self._lock:
            spaces, self._spaces = list(self._spaces.values()), {}
        for ws in spaces:
            ws.dispose()
        shutil.rmtree(self.root, ignore_errors=True)

    def __len__(self) -> int:
        with self._lock:
            return len(self._spaces)


# The process-wide store. Created in the app lifespan, which is also why this
# app must run with a single worker: a second process would have its own store
# and a user's upload and analysis could land in different ones.
_store: WorkspaceStore | None = None


def set_store(store: WorkspaceStore) -> None:
    global _store
    _store = store


def store_of() -> WorkspaceStore:
    if _store is None:
        raise RuntimeError("Workspace store not initialised; the app lifespan sets it.")
    return _store
