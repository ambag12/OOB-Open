"""Administrator endpoints: see who has an account, and turn them off."""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import (APIRouter, BackgroundTasks, Depends, HTTPException, Request,
                     status)
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.deps import client_ip, require_admin
from app.models import VERIFY_EMAIL, AuthSession, User
from app.routers.auth import _mint, _send_verification
from app.schemas import Ok, UserOut
from app.services.store import store_of

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"],
                   dependencies=[Depends(require_admin)])


@router.get("/users")
def list_users(db: Session = Depends(get_db)) -> dict:
    users = db.scalars(select(User).order_by(User.created_at.desc())).all()
    live = {uid for (uid,) in db.execute(
        select(AuthSession.user_id).group_by(AuthSession.user_id))}
    return {
        "users": [
            {**UserOut.of(u).model_dump(mode="json"), "signed_in": u.id in live}
            for u in users
        ],
        "sessions": db.scalar(select(func.count()).select_from(AuthSession)) or 0,
        "workspaces": len(store_of()),
    }


def _target(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such account.")
    return user


@router.post("/users/{user_id}/deactivate", response_model=Ok)
def deactivate(user_id: int, admin: User = Depends(require_admin),
               db: Session = Depends(get_db)) -> Ok:
    user = _target(db, user_id)
    if user.id == admin.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "You cannot deactivate your own account.")
    user.is_active = False
    # Signing them out is the point; leaving live sessions would make the
    # button look like it worked while they carried on using the dashboard.
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()
    store_of().drop(user.id)
    log.info("admin %s deactivated %s", admin.email, user.email)
    return Ok(message=f"{user.email} can no longer sign in.")


@router.post("/users/{user_id}/activate", response_model=Ok)
def activate(user_id: int, admin: User = Depends(require_admin),
             db: Session = Depends(get_db)) -> Ok:
    user = _target(db, user_id)
    user.is_active = True
    user.failed_login_count = 0
    user.locked_until = None
    db.commit()
    log.info("admin %s reactivated %s", admin.email, user.email)
    return Ok(message=f"{user.email} can sign in again.")


@router.post("/users/{user_id}/resend-verification", response_model=Ok)
def resend(user_id: int, request: Request, bg: BackgroundTasks,
           db: Session = Depends(get_db),
           s: Settings = Depends(get_settings)) -> Ok:
    user = _target(db, user_id)
    if user.is_verified:
        return Ok(message=f"{user.email} is already confirmed.")
    raw = _mint(db, user, VERIFY_EMAIL, timedelta(hours=s.VERIFY_TOKEN_TTL_HOURS),
                client_ip(request))
    bg.add_task(_send_verification, user, raw, s)
    return Ok(message=f"A new confirmation link is on its way to {user.email}.")


@router.post("/users/{user_id}/sign-out", response_model=Ok)
def sign_out(user_id: int, db: Session = Depends(get_db)) -> Ok:
    user = _target(db, user_id)
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()
    store_of().drop(user.id)
    return Ok(message=f"{user.email} has been signed out everywhere.")
