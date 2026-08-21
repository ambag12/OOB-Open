"""Upload, analyse, export -- the original dashboard API, now per user.

Every route here is `def`, not `async def`, on purpose. The pipeline is
synchronous and CPU-bound: one analysis holds a core for seconds to tens of
seconds. FastAPI runs `def` handlers in a worker thread, so a long run cannot
stall the event loop and everyone else's requests with it.
"""

from __future__ import annotations

import logging
import threading

from fastapi import (APIRouter, Depends, File, Form, HTTPException, Response,
                     UploadFile, status)

from app.config import Settings, get_settings
from app.deps import require_user
from app.models import User
from app.schemas import Ok, SettingsIn
from app.services import exporters
from app.services.analysis import run_analysis
from app.services.ratelimit import limiter
from app.services.store import UploadTooLarge, UserWorkspace, store_of

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["analysis"])

# Bounds peak memory. The default worker threadpool is 40 threads; without this
# a burst of uploads could start 40 concurrent pipelines and exhaust the box.
_slots = threading.BoundedSemaphore(get_settings().MAX_CONCURRENT_ANALYSES)


def workspace(user: User = Depends(require_user)) -> UserWorkspace:
    return store_of().get(user.id)


@router.get("/state")
def state(user: User = Depends(require_user),
          ws: UserWorkspace = Depends(workspace)) -> dict:
    with ws.lock:
        payload = ws.names()
    payload["user"] = {"email": user.email, "name": user.name, "is_admin": user.is_admin}
    return payload


@router.post("/upload")
def upload(file: UploadFile = File(...), kind: str = Form("history"),
           ws: UserWorkspace = Depends(workspace),
           s: Settings = Depends(get_settings)) -> dict:
    if kind not in ("history", "perf"):
        raise ValueError("Unknown upload kind.")
    try:
        with ws.lock:
            saved = ws.add(file.filename or "upload.xlsx", file.file, kind,
                           s.MAX_UPLOAD_BYTES, s.MAX_WORKSPACE_BYTES)
    except UploadTooLarge as exc:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, str(exc)) from exc
    finally:
        file.file.close()
    return {"ok": True, "name": saved.name.split("_", 1)[-1]}


@router.post("/analyze")
def analyze(body: SettingsIn | None = None,
            user: User = Depends(require_user),
            ws: UserWorkspace = Depends(workspace)) -> dict:
    wait = limiter.check("analyze:user", str(user.id))
    if wait:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "That is a lot of runs in a short time. Give it a minute.",
                            headers={"Retry-After": str(int(wait))})

    if not _slots.acquire(blocking=False):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "The server is analysing other reports right now. "
                            "Try again in a moment.",
                            headers={"Retry-After": "30"})
    try:
        settings_in = (body or SettingsIn()).model_dump()
        with ws.lock:
            # Released before the run so the previous result is not held
            # alongside the new one at the peak of the build.
            ws.last = None
            result = run_analysis(ws.history, ws.perf, settings_in)
            ws.last = result.artifacts
        return result.payload
    finally:
        _slots.release()


@router.post("/clear", response_model=Ok)
def clear(ws: UserWorkspace = Depends(workspace)) -> Ok:
    with ws.lock:
        ws.clear()
    return Ok()


@router.get("/export")
def export(format: str = "xlsx", ws: UserWorkspace = Depends(workspace)) -> Response:
    with ws.lock:
        last = ws.last
        if not last:
            raise ValueError("Analyse some files first.")
        stamp = exporters.export_stamp(last)
        if format == "csv":
            body, mime, name = (exporters.csv_bytes(last), exporters.CSV_MIME,
                                f"ppc-budget_{stamp}.csv")
        else:
            body, mime, name = (exporters.xlsx_bytes(last), exporters.XLSX_MIME,
                                f"ppc-budget-report_{stamp}.xlsx")
    return Response(body, media_type=mime,
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
