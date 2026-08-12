"""Sign up, sign in, verify an address, reset a password.

Two rules run through all of it.

Nothing here tells a caller whether an address has an account. Signup and
forgot-password always answer the same way; login answers with one generic
message whether the address is unknown, the password wrong, the account locked,
or the account disabled.

Nothing here consumes a token on GET. Mail scanners -- Outlook Safe Links,
Defender, Proofpoint -- fetch every URL in an inbound message, so a link that
acts on GET is spent before the recipient ever clicks it. The pages are static;
they read the token from the URL and POST it.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from fastapi import (APIRouter, BackgroundTasks, Depends, HTTPException, Request,
                     Response, status)
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.deps import client_ip, current_user, require_user
from app.models import (PASSWORD_RESET, VERIFY_EMAIL, AuthSession, EmailToken,
                        User, utcnow)
from app.schemas import EmailIn, LoginIn, Ok, ResetIn, SignupIn, TokenIn, UserOut
from app.security import (burn_cpu, clear_session_cookie, fingerprint,
                          hash_password, new_token, session_expiry,
                          set_session_cookie, verify_password)
from app.services import email_service
from app.services.ratelimit import limiter
from app.services.store import store_of

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["auth"])

BAD_CREDENTIALS = "Email or password is incorrect."
CHECK_INBOX = "Check your email to finish setting up your account."
RESET_SENT = "If that address has an account, a reset link is on its way."
BAD_LINK = "That link has expired or has already been used."


# --------------------------------------------------------------------- helpers

def _limit(bucket: str, subject: str) -> None:
    wait = limiter.check(bucket, subject)
    if wait:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            "Too many attempts. Try again in a few minutes.",
                            headers={"Retry-After": str(int(wait))})


def _mint(db: Session, user: User, purpose: str, ttl: timedelta,
          ip: str | None) -> str:
    """Issue a one-shot token, retiring any earlier unused one of this purpose
    so a mailbox cannot accumulate a stack of live links."""
    db.execute(
        update(EmailToken)
        .where(EmailToken.user_id == user.id, EmailToken.purpose == purpose,
               EmailToken.used_at.is_(None))
        .values(used_at=utcnow())
    )
    raw = new_token()
    db.add(EmailToken(user_id=user.id, purpose=purpose, token_hash=fingerprint(raw),
                      expires_at=utcnow() + ttl, requested_ip=ip))
    db.commit()
    return raw


def _consume(db: Session, raw: str, purpose: str) -> User:
    """Spend a token, or refuse. One UPDATE, so two simultaneous clicks cannot
    both win: whichever loses sees rowcount 0."""
    now = utcnow()
    result = db.execute(
        update(EmailToken)
        .where(EmailToken.token_hash == fingerprint(raw),
               EmailToken.purpose == purpose,
               EmailToken.used_at.is_(None),
               EmailToken.expires_at > now)
        .values(used_at=now)
    )
    if result.rowcount != 1:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_LINK)

    token = db.scalar(select(EmailToken).where(EmailToken.token_hash == fingerprint(raw)))
    user = db.get(User, token.user_id) if token else None
    if user is None:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, BAD_LINK)
    db.commit()
    return user


def _start_session(db: Session, user: User, request: Request,
                   response: Response, s: Settings) -> None:
    now = utcnow()
    raw = new_token()
    db.add(AuthSession(
        user_id=user.id, token_hash=fingerprint(raw, s),
        created_at=now, last_seen_at=now, expires_at=session_expiry(s, now),
        ip=client_ip(request)[:45],
        user_agent=(request.headers.get("user-agent") or "")[:255] or None,
    ))
    user.last_login_at = now
    user.failed_login_count = 0
    user.locked_until = None
    db.commit()
    set_session_cookie(response, raw, s)


def _send_verification(user: User, raw: str, s: Settings) -> None:
    email_service.send_verification_email(
        user.email, user.name, f"{s.base_url}/verify?token={raw}")


def _domain_allowed(email: str, s: Settings) -> bool:
    allowed = s.allowed_signup_domains
    return not allowed or email.rsplit("@", 1)[-1].lower() in allowed


# ---------------------------------------------------------------------- routes

@router.post("/signup", response_model=Ok)
def signup(body: SignupIn, request: Request, bg: BackgroundTasks,
           db: Session = Depends(get_db), s: Settings = Depends(get_settings)) -> Ok:
    if not s.SIGNUP_ENABLED:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "New accounts are not being created right now.")
    ip = client_ip(request)
    _limit("signup:ip", ip)

    email = body.email.strip().lower()
    if not _domain_allowed(email, s):
        allowed = ", ".join(sorted(s.allowed_signup_domains))
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            f"Accounts are limited to these domains: {allowed}.")

    existing = db.scalar(select(User).where(User.email == email))
    if existing is not None:
        # Same answer as a fresh signup. The real owner is told what happened;
        # whoever submitted the form learns nothing.
        if existing.is_verified:
            bg.add_task(email_service.send_account_exists_email, existing.email,
                        existing.name, f"{s.base_url}/login", f"{s.base_url}/forgot")
        else:
            raw = _mint(db, existing, VERIFY_EMAIL,
                        timedelta(hours=s.VERIFY_TOKEN_TTL_HOURS), ip)
            bg.add_task(_send_verification, existing, raw, s)
        return Ok(message=CHECK_INBOX)

    user = User(email=email, name=body.name, password_hash=hash_password(body.password))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        # Lost a race against a simultaneous signup for the same address.
        db.rollback()
        return Ok(message=CHECK_INBOX)

    raw = _mint(db, user, VERIFY_EMAIL, timedelta(hours=s.VERIFY_TOKEN_TTL_HOURS), ip)
    bg.add_task(_send_verification, user, raw, s)
    log.info("account created: %s", email)
    return Ok(message=CHECK_INBOX)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response,
          db: Session = Depends(get_db), s: Settings = Depends(get_settings)) -> dict:
    email = body.email.strip().lower()
    _limit("login:ip", client_ip(request))
    _limit("login:email", email)

    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        burn_cpu()          # match the timing of a real verify
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    now = utcnow()
    # Locked accounts get the same message as a wrong password. Saying "locked"
    # would confirm the address exists and hand out a way to grief a colleague.
    if user.locked_until and user.locked_until > now:
        burn_cpu()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    ok, rehashed = verify_password(user.password_hash, body.password)
    if not ok:
        user.failed_login_count += 1
        if user.failed_login_count >= s.MAX_FAILED_LOGINS:
            over = user.failed_login_count - s.MAX_FAILED_LOGINS
            minutes = min(60, s.LOCKOUT_MINUTES * (2 ** over))
            user.locked_until = now + timedelta(minutes=minutes)
            log.warning("account %s locked for %d minutes", email, minutes)
        db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    if not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, BAD_CREDENTIALS)

    if not user.is_verified:
        # The one place the answer is specific. It only reaches someone who
        # already has valid credentials, and without it an unverified user has
        # no way forward.
        user.failed_login_count = 0
        db.commit()
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            {"error": "Confirm your email address before signing in.",
             "code": "email_not_verified"})

    if rehashed:
        user.password_hash = rehashed
    _start_session(db, user, request, response, s)
    limiter.reset("login:email", email)
    return {"ok": True, "user": UserOut.of(user).model_dump(mode="json")}


@router.post("/logout", response_model=Ok)
def logout(request: Request, response: Response,
           db: Session = Depends(get_db), s: Settings = Depends(get_settings)) -> Ok:
    raw = request.cookies.get(s.SESSION_COOKIE_NAME)
    if raw:
        db.execute(delete(AuthSession).where(AuthSession.token_hash == fingerprint(raw, s)))
        db.commit()
    clear_session_cookie(response, s)
    return Ok(message="Signed out.")


@router.get("/me")
def me(user: User = Depends(require_user)) -> dict:
    return {"user": UserOut.of(user).model_dump(mode="json")}


@router.post("/verify", response_model=Ok)
def verify(body: TokenIn, db: Session = Depends(get_db)) -> Ok:
    user = _consume(db, body.token, VERIFY_EMAIL)
    if not user.is_verified:
        user.email_verified_at = utcnow()
        db.commit()
        log.info("email verified: %s", user.email)
    return Ok(message="Your email address is confirmed. You can sign in now.")


@router.post("/resend-verification", response_model=Ok)
def resend_verification(body: EmailIn, request: Request, bg: BackgroundTasks,
                        db: Session = Depends(get_db),
                        s: Settings = Depends(get_settings)) -> Ok:
    email = body.email.strip().lower()
    _limit("resend:email", email)
    user = db.scalar(select(User).where(User.email == email))
    if user is not None and not user.is_verified and user.is_active:
        raw = _mint(db, user, VERIFY_EMAIL, timedelta(hours=s.VERIFY_TOKEN_TTL_HOURS),
                    client_ip(request))
        bg.add_task(_send_verification, user, raw, s)
    return Ok(message=CHECK_INBOX)


@router.post("/forgot", response_model=Ok)
def forgot(body: EmailIn, request: Request, bg: BackgroundTasks,
           db: Session = Depends(get_db), s: Settings = Depends(get_settings)) -> Ok:
    email = body.email.strip().lower()
    _limit("forgot:ip", client_ip(request))
    _limit("forgot:email", email)

    user = db.scalar(select(User).where(User.email == email))
    if user is None or not user.is_active:
        burn_cpu()          # keep the timing indistinguishable
        return Ok(message=RESET_SENT)

    raw = _mint(db, user, PASSWORD_RESET,
                timedelta(minutes=s.RESET_TOKEN_TTL_MINUTES), client_ip(request))
    bg.add_task(email_service.send_password_reset_email, user.email, user.name,
                f"{s.base_url}/reset?token={raw}")
    return Ok(message=RESET_SENT)


@router.post("/reset", response_model=Ok)
def reset(body: ResetIn, bg: BackgroundTasks, db: Session = Depends(get_db)) -> Ok:
    user = _consume(db, body.token, PASSWORD_RESET)

    user.password_hash = hash_password(body.password)
    # Controlling the mailbox proves the address, so an unverified account
    # becomes verified here rather than stranding the user.
    if not user.is_verified:
        user.email_verified_at = utcnow()
    user.failed_login_count = 0
    user.locked_until = None
    # Every other browser is signed out. This is the point of server-side
    # sessions: a stolen cookie dies with the password that leaked it.
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.commit()

    store_of().drop(user.id)
    bg.add_task(email_service.send_password_changed_email, user.email, user.name)
    log.info("password reset completed: %s", user.email)
    return Ok(message="Your password has been changed. Sign in with it now.")


@router.get("/session")
def session_state(user: User | None = Depends(current_user)) -> dict:
    """Whether this browser is signed in. Never 401s -- the sign-in page itself
    uses it to bounce an already-authenticated visitor onward."""
    return {"authenticated": user is not None,
            "user": UserOut.of(user).model_dump(mode="json") if user else None}
