"""Password hashing, opaque token minting, and the session cookie."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta

from argon2 import PasswordHasher
from argon2.exceptions import (InvalidHashError, VerificationError,
                               VerifyMismatchError)
from fastapi import Response

from app.config import Settings, get_settings

log = logging.getLogger(__name__)

# OWASP's second recommended argon2id profile: 19 MiB, t=2, p=1. Sized so that
# a handful of concurrent logins cannot exhaust a 2 GB container's memory.
_ph = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1,
                     hash_len=32, salt_len=16)

# Verified on the unknown-email path so response time does not distinguish
# "no such account" from "wrong password".
_DUMMY_HASH = _ph.hash("timing-equalisation-placeholder")


def hash_password(raw: str) -> str:
    return _ph.hash(raw)


def verify_password(stored: str, raw: str) -> tuple[bool, str | None]:
    """(ok, replacement_hash). The replacement is set when the stored hash was
    made with weaker parameters than the current ones."""
    try:
        _ph.verify(stored, raw)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False, None
    try:
        return True, (_ph.hash(raw) if _ph.check_needs_rehash(stored) else None)
    except Exception:                      # noqa: BLE001 - a rehash failure must not block login
        return True, None


def burn_cpu() -> None:
    """Spend the same time a real verify would, and discard the result."""
    try:
        _ph.verify(_DUMMY_HASH, "x")
    except Exception:                      # noqa: BLE001 - always mismatches, by design
        pass


# --------------------------------------------------------------------- tokens

def new_token() -> str:
    """256 bits of URL-safe randomness. Used for both session cookies and the
    one-shot links sent by email."""
    return secrets.token_urlsafe(32)


def fingerprint(raw: str, s: Settings | None = None) -> str:
    """What gets stored. Keyed with SECRET_KEY so a leaked table of hashes is
    not enough to forge one, and so rotating the key invalidates everything."""
    key = (s or get_settings()).SECRET_KEY.get_secret_value().encode()
    return hmac.new(key, raw.encode(), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------- cookie

def set_session_cookie(response: Response, raw_token: str, s: Settings) -> None:
    response.set_cookie(
        key=s.SESSION_COOKIE_NAME,
        value=raw_token,
        max_age=s.SESSION_TTL_DAYS * 86400,
        httponly=True,          # app.js builds a lot of markup; XSS must not reach this
        samesite="lax",         # strict would break links clicked from a webmail tab
        secure=s.cookie_secure,
        path="/",
        # No domain: host-only. A Domain attribute on a bare IP is invalid and
        # the browser drops the cookie without saying so.
    )


def clear_session_cookie(response: Response, s: Settings) -> None:
    response.delete_cookie(
        key=s.SESSION_COOKIE_NAME, path="/",
        httponly=True, samesite="lax", secure=s.cookie_secure,
    )


def session_expiry(s: Settings, now: datetime) -> datetime:
    return now + timedelta(days=s.SESSION_TTL_DAYS)
