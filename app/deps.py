"""Request-scoped dependencies: the database session and the signed-in user."""

from __future__ import annotations

from datetime import timedelta

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models import AuthSession, User, utcnow
from app.security import fingerprint, session_expiry

# Written at most this often, so ordinary asset requests do not each cost a write.
_LAST_SEEN_RESOLUTION = timedelta(minutes=5)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def current_user(request: Request,
                 db: Session = Depends(get_db),
                 s: Settings = Depends(get_settings)) -> User | None:
    """Resolve the session cookie, or None. Never raises -- pages that merely
    render differently for anonymous visitors depend on that."""
    raw = request.cookies.get(s.SESSION_COOKIE_NAME)
    if not raw:
        return None

    now = utcnow()
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == fingerprint(raw, s)))
    if sess is None:
        return None
    if sess.expires_at <= now:
        db.execute(delete(AuthSession).where(AuthSession.id == sess.id))
        db.commit()
        return None

    user = db.get(User, sess.user_id)
    if user is None or not user.is_active:
        return None

    dirty = False
    if now - sess.last_seen_at > _LAST_SEEN_RESOLUTION:
        sess.last_seen_at = now
        dirty = True
    # Rolling expiry: past the halfway mark, extend rather than sign the user
    # out mid-session. The cookie's own max-age is refreshed in the same place
    # it was set, so this only needs to move the server-side row.
    if sess.expires_at - now < timedelta(days=s.SESSION_TTL_DAYS) / 2:
        sess.expires_at = session_expiry(s, now)
        dirty = True
    if dirty:
        db.commit()

    request.state.session_id = sess.id
    return user


def require_user(user: User | None = Depends(current_user)) -> User:
    if user is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in.")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "That area is for administrators.")
    return user
