"""Serves the built React app, plus the two health endpoints.

The auth screens used to be six static HTML files, each with its own page-*.js.
They are now routes inside the single-page app, so every non-API path that is
not a real file resolves to the same index.html and the client router decides
what to render.

The server-side redirects are kept even though the SPA guards the same routes.
They are what stops the app shell being sent to a signed-out visitor at all,
and they still work with scripting disabled -- the client guards only cover
navigations that happen after the document has loaded.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response

from app import db as db_module
from app.deps import current_user
from app.models import User

log = logging.getLogger(__name__)
router = APIRouter(tags=["pages"])

ROOT = Path(__file__).resolve().parent.parent.parent
DIST = ROOT / "dist"
NO_STORE = {"Cache-Control": "no-store"}

# Client routes the server has an opinion about. Anything else that is not a
# file under dist/ still falls through to the app shell.
SPA_ROUTES = ("/", "/login", "/signup", "/forgot", "/reset", "/verify", "/admin")


def shell() -> Response:
    """The one HTML document. Never cached: it names the hashed asset bundles,
    so a stale copy points at files that a deploy has already replaced."""
    index = DIST / "index.html"
    if not index.is_file():
        # A clear message beats a 500 with a traceback when someone starts the
        # server without having run the front-end build.
        return JSONResponse(
            {"error": "The front-end has not been built. Run: npm ci && npm run build"},
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            headers=NO_STORE,
        )
    return FileResponse(index, media_type="text/html; charset=utf-8", headers=NO_STORE)


def _safe_next(raw: str | None) -> str:
    """Only ever redirect within this site: '//evil.example' is protocol
    relative and would leave it."""
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


@router.get("/", include_in_schema=False)
def index(user: User | None = Depends(current_user)) -> Response:
    # Redirect on the server. Gating in JS alone would flash the app shell
    # before bouncing, and would show nothing at all with scripting disabled.
    if user is None:
        return RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)
    return shell()


@router.get("/login", include_in_schema=False)
def login_page(request: Request, user: User | None = Depends(current_user)) -> Response:
    if user is not None:
        return RedirectResponse(_safe_next(request.query_params.get("next")),
                                status_code=status.HTTP_303_SEE_OTHER)
    return shell()


@router.get("/signup", include_in_schema=False)
def signup_page(user: User | None = Depends(current_user)) -> Response:
    if user is not None:
        return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return shell()


@router.get("/forgot", include_in_schema=False)
def forgot_page() -> Response:
    return shell()


# Both of these stay inert on GET: they render, and the client reads the token
# out of the query string and POSTs it. A mail scanner that GETs every link in
# a message therefore cannot spend the token before the recipient opens it.
@router.get("/reset", include_in_schema=False)
def reset_page() -> Response:
    return shell()


@router.get("/verify", include_in_schema=False)
def verify_page() -> Response:
    return shell()


@router.get("/admin", include_in_schema=False)
def admin_page(user: User | None = Depends(current_user)) -> Response:
    if user is None:
        return RedirectResponse("/login?next=/admin", status_code=status.HTTP_303_SEE_OTHER)
    if not user.is_admin:
        return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return shell()


@router.get("/healthz", include_in_schema=False)
def healthz() -> JSONResponse:
    """Liveness only. Deliberately does not touch MySQL: if it did, a thirty
    second RDS failover would restart the container instead of just failing the
    handful of routes that actually need the database."""
    return JSONResponse({"status": "ok"}, headers=NO_STORE)


@router.get("/readyz", include_in_schema=False)
def readyz() -> JSONResponse:
    try:
        db_module.ping()
    except Exception as exc:                      # noqa: BLE001 - report, don't raise
        log.warning("readiness check failed: %s", exc)
        return JSONResponse({"db": "unreachable"},
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            headers=NO_STORE)
    return JSONResponse({"db": "ok"}, headers=NO_STORE)
