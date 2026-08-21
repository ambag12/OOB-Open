"""Error rendering.

Two jobs. First, answer a 401 the way the caller can use: an HTML navigation
gets a redirect to the sign-in page, a fetch gets JSON. Without this, clicking
Excel export on an expired session dumps raw JSON into a new tab.

Second, stop leaking internals. The local serve.py answers 500s with
`f"{type(exc).__name__}: {exc}"`, which is fine for a tool on your own laptop
and not fine on a shared server.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, RedirectResponse

log = logging.getLogger(__name__)


def wants_html(request: Request) -> bool:
    accept = request.headers.get("accept") or ""
    # fetch() sends */* or application/json; a browser navigation asks for HTML
    # explicitly and first.
    return "text/html" in accept


def _login_redirect(request: Request) -> RedirectResponse:
    nxt = request.url.path
    if request.url.query:
        nxt = f"{nxt}?{request.url.query}"
    return RedirectResponse(f"/login?next={nxt}", status_code=status.HTTP_303_SEE_OTHER)


def install(app: FastAPI) -> None:

    @app.exception_handler(HTTPException)
    async def http_exception(request: Request, exc: HTTPException):
        if exc.status_code == status.HTTP_401_UNAUTHORIZED and wants_html(request):
            return _login_redirect(request)
        payload = {"error": exc.detail}
        if isinstance(exc.detail, dict):
            payload = exc.detail
        return JSONResponse(payload, status_code=exc.status_code,
                            headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Literal 422: the Starlette constant for it was renamed, and pinning to
        # either spelling would tie this file to a version range.
        return JSONResponse({"error": _readable(exc)}, status_code=422)

    @app.exception_handler(ValueError)
    async def value_error(request: Request, exc: ValueError):
        # The pipeline raises ValueError with deliberate user-facing copy
        # ("No change-history files uploaded yet."). Pass it straight through.
        return JSONResponse({"error": str(exc)}, status_code=status.HTTP_400_BAD_REQUEST)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):
        ref = uuid.uuid4().hex[:12]
        log.exception("unhandled error ref=%s on %s %s", ref, request.method,
                      request.url.path)
        return JSONResponse(
            {"error": "Something went wrong on our side.", "ref": ref},
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR)


def _readable(exc: RequestValidationError) -> str:
    """Turn pydantic's error list into one sentence a person can act on."""
    for err in exc.errors():
        field = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query"))
        msg = err.get("msg", "is not valid")
        if field:
            return f"{field}: {msg}"
        return msg
    return "That request was not valid."
