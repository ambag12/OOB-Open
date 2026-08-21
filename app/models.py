"""Account tables.

Every table is prefixed `oob_`. The target database is shared and `create_all`
silently skips a table that already exists, so an unprefixed `users` could
quietly bind the app to somebody else's table.

Column types are deliberately portable -- Integer/String/Boolean/DateTime, no
MySQL-specific types -- so the test suite can run the whole auth flow against
in-memory SQLite without a database server.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (Boolean, DateTime, ForeignKey, Index, Integer, String,
                        UniqueConstraint)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

VERIFY_EMAIL = "verify_email"
PASSWORD_RESET = "password_reset"


def utcnow() -> datetime:
    """Naive UTC. MySQL DATETIME carries no timezone, so storing an aware value
    would round-trip as naive anyway and the comparisons would start raising."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "oob_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False)  # lowercased on write
    name: Mapped[str] = mapped_column(String(120), nullable=False, default="")
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # NULL means unverified. A timestamp is more useful than a bool here.
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False,
                                                 default=utcnow, onupdate=utcnow)

    __table_args__ = (UniqueConstraint("email", name="uq_oob_users_email"),)

    @property
    def is_verified(self) -> bool:
        return self.email_verified_at is not None


class AuthSession(Base):
    """A signed-in browser.

    Named AuthSession, not Session, so it cannot be confused with
    sqlalchemy.orm.Session in a type annotation or an import.
    """

    __tablename__ = "oob_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("oob_users.id", ondelete="CASCADE"), nullable=False)
    # HMAC of the cookie value, never the value itself: a read-only database
    # leak then yields nothing anyone can log in with.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)   # 45 = IPv6 text max
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_oob_sessions_hash"),
        Index("ix_oob_sessions_user", "user_id"),
        Index("ix_oob_sessions_expires", "expires_at"),
    )


class EmailToken(Base):
    """One-shot link sent by email: address verification or password reset."""

    __tablename__ = "oob_email_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("oob_users.id", ondelete="CASCADE"), nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    requested_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    __table_args__ = (
        UniqueConstraint("token_hash", name="uq_oob_email_tokens_hash"),
        Index("ix_oob_email_tokens_user_purpose", "user_id", "purpose"),
        Index("ix_oob_email_tokens_expires", "expires_at"),
    )
