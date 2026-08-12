"""The HTML pages, plus the two health endpoints.

There is no template engine. The only thing a template would inject is the
`next` parameter and a status message, both of which the page reads from
location.search -- so these are static files and the JS does the rest.
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

WEB = Path(__file__).resolve().parent.parent.parent / "web"
NO_STORE = {"Cache-Control": "no-store"}


def page(name: str) -> FileResponse:
    return FileResponse(WEB / name, media_type="text/html; charset=utf-8",
                        headers=NO_STORE)


@router.get("/", include_in_schema=False)
def index(user: User | None = Depends(current_user)) -> Response:
    # Redirect on the server. Gating in JS would flash the whole app shell
    # before bouncing, and would show nothing at all with scripting disabled.
    if user is None:
        return RedirectResponse("/login", status_code=status.HTTP_303_SEE_OTHER)
    return page("index.html")


@router.get("/login", include_in_schema=False)
def login_page(request: Request, user: User | None = Depends(current_user)) -> Response:
    if user is not None:
        nxt = request.query_params.get("next") or "/"
        if not nxt.startswith("/") or nxt.startswith("//"):
            nxt = "/"        # only ever redirect within this site
        return RedirectResponse(nxt, status_code=status.HTTP_303_SEE_OTHER)
    return page("login.html")


@router.get("/signup", include_in_schema=False)
def signup_page(user: User | None = Depends(current_user)) -> Response:
    if user is not None:
        return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return page("signup.html")


@router.get("/forgot", include_in_schema=False)
def forgot_page() -> Response:
    return page("forgot.html")


# Both of these are deliberately inert: they render, read the token out of the
# query string, and POST it. A mail scanner that GETs every link in a message
# therefore cannot spend the token before the recipient opens it.
@router.get("/reset", include_in_schema=False)
def reset_page() -> Response:
    return page("reset.html")


@router.get("/verify", include_in_schema=False)
def verify_page() -> Response:
    return page("verify.html")


@router.get("/admin", include_in_schema=False)
def admin_page(user: User | None = Depends(current_user)) -> Response:
    if user is None:
        return RedirectResponse("/login?next=/admin", status_code=status.HTTP_303_SEE_OTHER)
    if not user.is_admin:
        return RedirectResponse("/", status_code=status.HTTP_303_SEE_OTHER)
    return page("admin.html")


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
