"""Outbound email.

`_send` never raises into a request path. A mail outage should leave the user
with "check your inbox" and a resend button, not a 500 -- and on the
forgot-password route, raising would also reveal whether the address existed.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from html import escape

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)


def _shell(name: str, heading: str, body_html: str) -> str:
    """Plain, table-free HTML. Mail clients are not browsers."""
    greeting = f"Hi {escape(name)}," if name else "Hi,"
    return (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;'
        'font-size:15px;line-height:1.55;color:#111827;max-width:520px">'
        f"<h2 style=\"font-size:18px;margin:0 0 14px\">{escape(heading)}</h2>"
        f"<p style=\"margin:0 0 12px\">{greeting}</p>"
        f"{body_html}"
        '<p style="margin:22px 0 0;font-size:12.5px;color:#6b7280">'
        "You are receiving this because someone used this address on the "
        "PPC out-of-budget dashboard. If that was not you, ignore this message."
        "</p></div>"
    )


def _button(url: str, label: str) -> str:
    safe = escape(url, quote=True)
    return (
        f'<p style="margin:0 0 18px"><a href="{safe}" '
        'style="display:inline-block;background:#111827;color:#fff;text-decoration:none;'
        f'padding:10px 18px;border-radius:8px;font-weight:600">{escape(label)}</a></p>'
        '<p style="margin:0 0 6px;font-size:12.5px;color:#6b7280">'
        "If the button does not work, paste this into your browser:</p>"
        f'<p style="margin:0;font-size:12.5px;word-break:break-all">{escape(url)}</p>'
    )


def _send(to: str, subject: str, html: str,
          attachment: str | Sequence[str] | None = None) -> bool:
    """Deliver one message. Returns True on success, False on any failure.

    The endpoint declares `to` as an array and attachments as `files` (plural).
    httpx sends a single string for `to` as one repeated field, which the API
    wraps back into a list, so one recipient needs no special handling.
    """
    s = get_settings()

    if s.EMAIL_PROVIDER == "console":
        log.info("EMAIL (console provider)\n  to:      %s\n  subject: %s\n  body:\n%s",
                 to, subject, html)
        return True

    data = {"to": to, "subject": subject, "body": html, "content_type": "html"}
    paths = [attachment] if isinstance(attachment, str) else list(attachment or ())
    handles = []
    try:
        # The field name has to be "files"; anything else is accepted and then
        # silently dropped, and the response comes back with attachments: [].
        for path in paths:
            handle = open(path, "rb")
            handles.append(handle)
        files = [("files", (os.path.basename(p), h))
                 for p, h in zip(paths, handles)] or None

        resp = httpx.post(
            s.EMAIL_ENDPOINT,
            headers={"Authorization": f"Bearer {s.EMAIL_API_KEY.get_secret_value()}"},
            data=data, files=files, timeout=s.EMAIL_TIMEOUT_S,
        )
        if resp.status_code >= 300:   # the API answers 202 on success
            log.error("email API returned %s for %s: %s",
                      resp.status_code, to, resp.text[:300])
            return False
        return True
    except (httpx.HTTPError, OSError) as exc:
        log.error("could not send email to %s: %s", to, exc)
        return False
    finally:
        for handle in handles:
            handle.close()


def send_email(to: str, subject: str, html: str,
               attachment: str | Sequence[str] | None = None) -> bool:
    """Public wrapper for arbitrary messages. Prefer the named helpers below."""
    return _send(to, subject, html, attachment)


def send_verification_email(to: str, name: str, verify_url: str) -> bool:
    hours = get_settings().VERIFY_TOKEN_TTL_HOURS
    body = (
        "<p style=\"margin:0 0 18px\">Confirm this address to finish setting up your "
        "account on the PPC out-of-budget dashboard.</p>"
        + _button(verify_url, "Confirm my email")
        + f'<p style="margin:16px 0 0;font-size:12.5px;color:#6b7280">'
          f"This link works once and expires in {hours} hours.</p>"
    )
    return _send(to, "Confirm your email address",
                 _shell(name, "One more step", body))


def send_password_reset_email(to: str, name: str, reset_url: str) -> bool:
    minutes = get_settings().RESET_TOKEN_TTL_MINUTES
    body = (
        '<p style="margin:0 0 18px">Use the button below to choose a new password.</p>'
        + _button(reset_url, "Choose a new password")
        + f'<p style="margin:16px 0 0;font-size:12.5px;color:#6b7280">'
          f"This link works once and expires in {minutes} minutes. If you did not "
          "ask for it, nothing has changed and you can ignore this.</p>"
    )
    return _send(to, "Reset your password", _shell(name, "Password reset", body))


def send_account_exists_email(to: str, name: str, login_url: str, forgot_url: str) -> bool:
    """Sent when someone signs up with an address that already has an account.

    Signup answers identically either way, so this is what tells the real owner
    what happened without telling the requester whether the address exists.
    """
    body = (
        '<p style="margin:0 0 12px">Someone just tried to create an account with this '
        "address, but you already have one.</p>"
        + _button(login_url, "Sign in")
        + '<p style="margin:18px 0 0;font-size:13px">Forgotten your password? '
          f'<a href="{escape(forgot_url, quote=True)}">Reset it here</a>.</p>'
    )
    return _send(to, "You already have an account",
                 _shell(name, "You already have an account", body))


def send_password_changed_email(to: str, name: str) -> bool:
    body = ('<p style="margin:0 0 12px">Your password has just been changed, and every '
            "browser that was signed in has been signed out.</p>"
            '<p style="margin:0">If this was not you, reset your password immediately '
            "and tell whoever runs this dashboard.</p>")
    return _send(to, "Your password was changed",
                 _shell(name, "Your password was changed", body))
