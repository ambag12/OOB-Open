"""Seed the administrator account named in the environment."""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import User, utcnow
from app.security import hash_password

log = logging.getLogger(__name__)


def seed_admin(db: Session, s: Settings) -> User | None:
    """Idempotent. Creates the admin pre-verified on first run; on later runs it
    repairs the flags but leaves the password alone -- otherwise every restart
    would revert a rotated password and the stale .env value would be a
    permanent way in. ADMIN_RESET_PASSWORD=true is the deliberate override."""
    if not (s.ADMIN_EMAIL and s.ADMIN_PASSWORD):
        log.info("ADMIN_EMAIL/ADMIN_PASSWORD not set; skipping admin seed")
        return None

    email = s.ADMIN_EMAIL.strip().lower()
    user = db.scalar(select(User).where(User.email == email))

    if user is None:
        user = User(
            email=email,
            name="Administrator",
            password_hash=hash_password(s.ADMIN_PASSWORD.get_secret_value()),
            is_admin=True,
            is_active=True,
            email_verified_at=utcnow(),
        )
        db.add(user)
        db.commit()
        log.info("seeded admin account %s", email)
        return user

    changed = []
    if not user.is_admin:
        user.is_admin = True
        changed.append("is_admin")
    if not user.is_active:
        user.is_active = True
        changed.append("is_active")
    if user.email_verified_at is None:
        user.email_verified_at = utcnow()
        changed.append("email_verified_at")
    if user.locked_until is not None or user.failed_login_count:
        user.locked_until = None
        user.failed_login_count = 0
        changed.append("lockout cleared")
    if s.ADMIN_RESET_PASSWORD:
        user.password_hash = hash_password(s.ADMIN_PASSWORD.get_secret_value())
        changed.append("password reset from ADMIN_PASSWORD")

    if changed:
        db.commit()
        log.info("admin account %s updated: %s", email, ", ".join(changed))
    else:
        log.info("admin account %s already present", email)
    return user
