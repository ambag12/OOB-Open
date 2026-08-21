"""The hosted application.

    uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1

One worker is load-bearing, not a leftover: uploads and the last analysis live
in this process's memory, so with two workers a user's upload and their analyse
request could land in different processes.
"""

from __future__ import annotations

import logging
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete

from app import errors
from app.bootstrap import seed_admin
from app.config import get_settings
from app.db import SessionLocal, create_schema
from app.models import AuthSession, EmailToken, utcnow
from app.routers import admin, analysis, auth, pages
from app.services.ratelimit import limiter
from app.services.store import WorkspaceStore, set_store, store_of

log = logging.getLogger(__name__)
settings = get_settings()

WEB = Path(__file__).resolve().parent.parent / "web"
DIST = Path(__file__).resolve().parent.parent.parent / "dist"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}
SWEEP_INTERVAL_S = 60
TOKEN_RETENTION = timedelta(days=7)
_STARTED = time.monotonic()


def _workspace_root() -> Path:
    base = settings.WORKSPACE_ROOT or tempfile.gettempdir()
    return Path(base) / "oob-workspaces"


def _sweeper(store: WorkspaceStore, stop: threading.Event) -> None:
    """Housekeeping, in a thread rather than an asyncio task: removing a few
    hundred megabytes of uploads is blocking work and would stall the loop."""
    while not stop.wait(SWEEP_INTERVAL_S):
        try:
            store.sweep()
            limiter.prune()
            with SessionLocal() as db:
                now = utcnow()
                db.execute(delete(AuthSession).where(AuthSession.expires_at < now))
                db.execute(delete(EmailToken).where(
                    EmailToken.expires_at < now - TOKEN_RETENTION))
                db.commit()
        except Exception:                       # noqa: BLE001 - never kill the sweeper
            log.exception("sweep failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.basicConfig(level=settings.LOG_LEVEL,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    log.info("%s starting", settings.APP_NAME)
    log.info("base url %s, cookie secure=%s", settings.base_url, settings.cookie_secure)
    if not settings.cookie_secure and settings.base_url.startswith("https://"):
        log.warning("COOKIE_SECURE is off but APP_BASE_URL is https -- "
                    "session cookies will travel without the Secure flag")

    create_schema()
    with SessionLocal() as db:
        seed_admin(db, settings)

    store = WorkspaceStore(
        _workspace_root(),
        idle_ttl_s=settings.WORKSPACE_IDLE_TTL_MIN * 60,
        max_workspaces=settings.MAX_ACTIVE_WORKSPACES,
        max_total_bytes=settings.MAX_TOTAL_WORKSPACE_BYTES,
    )
    store.start()
    set_store(store)

    stop = threading.Event()
    thread = threading.Thread(target=_sweeper, args=(store, stop),
                              name="workspace-sweeper", daemon=True)
    thread.start()
    log.info("ready on %s", settings.base_url)
    try:
        yield
    finally:
        stop.set()
        thread.join(timeout=5)
        store.dispose_all()
        log.info("stopped")


app = FastAPI(title=settings.APP_NAME, lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def guard(request: Request, call_next):
    """Body-size ceiling, cross-origin write guard, and security headers."""
    if request.method not in SAFE_METHODS:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > settings.MAX_UPLOAD_BYTES:
            # Refuse before reading the body. Starlette has no size limit of
            # its own, so without this a large POST is fully buffered first.
            return JSONResponse(
                {"error": "That file is too large."},
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)

        # SameSite=Lax already blocks cross-site cookie-bearing writes; this
        # covers the multipart upload route, which a plain HTML form can forge.
        origin = request.headers.get("origin") or request.headers.get("referer")
        if origin:
            host = urlparse(origin).netloc.lower()
            allowed = {urlparse(settings.base_url).netloc.lower(),
                       (request.headers.get("host") or "").lower()}
            if host and host not in allowed:
                return JSONResponse({"error": "Bad origin."},
                                    status_code=status.HTTP_403_FORBIDDEN)

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    # Reset and verification tokens ride in the query string, so no Referer.
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; "
        "base-uri 'none'; form-action 'self'")
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


errors.install(app)
app.include_router(pages.router)
app.include_router(auth.router)
app.include_router(analysis.router)
app.include_router(admin.router)

# Component-wise containment, ETags and 304s for free. The local serve.py does
# this with a str.startswith prefix check, which a sibling directory would pass.
app.mount("/static", StaticFiles(directory=WEB), name="static")

# The hashed bundles Vite emits. Long-lived: the filenames change on every
# build, so a cached asset can never be the wrong one.
if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/statusz", include_in_schema=False)
def statusz() -> dict:
    """Cheap operational counters. No account data, so no auth needed."""
    store = store_of()
    return {"workspaces": len(store), "bytes": store.total_bytes(),
            "uptime_s": int(time.monotonic() - _STARTED)}


# Registered last so it shadows nothing. Any GET that is not an API call, a
# mounted asset or a route above is a client route -- hand back the app shell
# and let the router in the browser resolve it.
@app.get("/{path:path}", include_in_schema=False)
def spa_fallback(path: str) -> Response:
    if path.startswith(("api/", "static/", "assets/")):
        return JSONResponse({"error": "Not found."},
                            status_code=status.HTTP_404_NOT_FOUND,
                            headers={"Cache-Control": "no-store"})
    return pages.shell()
