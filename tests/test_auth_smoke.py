#!/usr/bin/env python3
"""End-to-end checks for the hosted app.

    python3 tests/test_auth_smoke.py

Runs against in-memory SQLite with email routed to a capture list, so it needs
no MySQL, no network, and sends no mail. Every model column is a portable type
precisely so this is possible.

Plain asserts and a main(), matching tests/test_golden.py -- no pytest.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

WORK = Path(tempfile.mkdtemp(prefix="oob-authtest-"))

# Must be set before app.config reads the environment.
os.environ["EMAIL_PROVIDER"] = "console"
os.environ["APP_BASE_URL"] = "http://testserver"
os.environ["WORKSPACE_ROOT"] = str(WORK)
os.environ.setdefault("SECRET_KEY", "test-secret-key-at-least-32-characters-long")
os.environ.setdefault("MYSQL_HOST", "unused-in-this-test")
os.environ.setdefault("MYSQL_USER", "unused")
os.environ.setdefault("MYSQL_PASSWORD", "unused")
os.environ.setdefault("MYSQL_DATABASE", "unused")
os.environ.setdefault("ADMIN_EMAIL", "admin@example.com")
os.environ.setdefault("ADMIN_PASSWORD", "admin-password-1")

from sqlalchemy import create_engine                                # noqa: E402
from sqlalchemy.orm import sessionmaker                             # noqa: E402
from sqlalchemy.pool import StaticPool                              # noqa: E402

import app.db as db_module                                          # noqa: E402

# Point the app at SQLite before anything imports SessionLocal from it.
_sqlite = create_engine("sqlite://", connect_args={"check_same_thread": False},
                        poolclass=StaticPool)
db_module.engine = _sqlite
db_module.SessionLocal = sessionmaker(bind=_sqlite, autoflush=False,
                                      expire_on_commit=False, future=True)

from fastapi.testclient import TestClient                           # noqa: E402

from app.config import get_settings                                 # noqa: E402
from app.main import app                                            # noqa: E402
from app.services import email_service                              # noqa: E402
from tests import synthetic                                         # noqa: E402

SENT: list[tuple[str, str, str]] = []
email_service._send = lambda to, subject, html, attachment=None: (
    SENT.append((to, subject, html)) or True)

FIXTURE = synthetic.build(WORK / "amazon-ads-history_synthetic.xlsx")
GENERIC_LOGIN_ERROR = "Email or password is incorrect."

PASSED: list[str] = []
FAILED: list[str] = []


def check(label: str, condition: bool, detail: object = "") -> None:
    if condition:
        PASSED.append(label)
        print(f"  pass  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}" + (f"  <- {detail}" if detail else ""))


def link_from_mail(prefix: str) -> str:
    """Pull the most recent link with this prefix out of the captured HTML."""
    for _to, _subject, html in reversed(SENT):
        i = html.find(prefix)
        if i >= 0:
            return html[i:].split('"')[0].split("<")[0].strip()
    raise AssertionError(f"no email contained a {prefix!r} link")


def token_from_mail(prefix: str) -> str:
    return link_from_mail(prefix).split("token=")[1]


def verify_new_user(client: TestClient, email: str, password: str, name: str = "") -> None:
    client.post("/api/auth/signup",
                json={"email": email, "password": password, "name": name})
    client.post("/api/auth/verify",
                json={"token": token_from_mail("http://testserver/verify?token=")})


def main() -> int:
    with TestClient(app, base_url="http://testserver") as c:
        _anonymous(c)
        _signup_and_verify(c)
        _login(c)
        _dashboard(c)
        _csrf_and_admin_gate(c)
        _isolation(c)
        _logout(c)
        _forgot_and_reset(c)
        _lockout(c)
        _admin(c)

    print(f"\n{len(PASSED)}/{len(PASSED) + len(FAILED)} passed")
    if FAILED:
        print("failed: " + ", ".join(FAILED))
    return 1 if FAILED else 0


# --------------------------------------------------------------------- checks

def _anonymous(c: TestClient) -> None:
    r = c.get("/", follow_redirects=False)
    check("anonymous / redirects to the sign-in page",
          r.status_code == 303 and r.headers["location"] == "/login", r.status_code)
    check("healthz is up", c.get("/healthz").status_code == 200)
    check("readyz reports the database", c.get("/readyz").json().get("db") == "ok")
    check("anonymous api call is 401", c.get("/api/state").status_code == 401)

    r = c.get("/api/state", headers={"Accept": "text/html"}, follow_redirects=False)
    check("a browser navigation gets redirected, not JSON",
          r.status_code == 303 and "/login" in r.headers["location"], r.status_code)


def _signup_and_verify(c: TestClient) -> None:
    body = {"email": "alice@example.com", "password": "correct-horse-1", "name": "Alice"}
    first = c.post("/api/auth/signup", json=body)
    check("signup succeeds", first.status_code == 200, first.text)

    repeat = c.post("/api/auth/signup", json=body)
    check("signing up an existing address answers identically",
          repeat.status_code == first.status_code and repeat.json() == first.json(),
          repeat.text)

    r = c.post("/api/auth/signup", json={"email": "x@example.com", "password": "short"})
    check("a short password is refused", r.status_code == 422, r.status_code)

    token = token_from_mail("http://testserver/verify?token=")
    r = c.get(f"/verify?token={token}")
    check("the verify page is served as html",
          r.status_code == 200 and "text/html" in r.headers["content-type"])

    r = c.post("/api/auth/login",
               json={"email": "alice@example.com", "password": "correct-horse-1"})
    check("signing in before confirming is refused with a reason",
          r.status_code == 403 and r.json().get("code") == "email_not_verified", r.text)

    r = c.post("/api/auth/verify", json={"token": token})
    check("loading the page did not spend the token; posting it does",
          r.status_code == 200, r.text)
    r = c.post("/api/auth/verify", json={"token": token})
    check("a verification token works only once", r.status_code == 400, r.status_code)


def _login(c: TestClient) -> None:
    r = c.post("/api/auth/login",
               json={"email": "alice@example.com", "password": "wrong-password"})
    check("a wrong password is refused without detail",
          r.status_code == 401 and r.json()["error"] == GENERIC_LOGIN_ERROR, r.text)
    r = c.post("/api/auth/login",
               json={"email": "nobody@example.com", "password": "wrong-password"})
    check("an unknown address gets the very same message",
          r.status_code == 401 and r.json()["error"] == GENERIC_LOGIN_ERROR, r.text)

    r = c.post("/api/auth/login",
               json={"email": "alice@example.com", "password": "correct-horse-1"})
    check("signing in works", r.status_code == 200, r.text)

    cookie = r.headers.get("set-cookie", "")
    check("the session cookie is HttpOnly", "httponly" in cookie.lower(), cookie)
    check("the session cookie is SameSite=Lax", "samesite=lax" in cookie.lower(), cookie)
    check("the session cookie is not Secure over plain http",
          "secure" not in cookie.lower(), cookie)

    state = c.get("/api/state")
    check("the api answers once signed in", state.status_code == 200, state.text)
    check("the state carries who is signed in",
          state.json()["user"]["email"] == "alice@example.com")
    check("the dashboard itself is served", c.get("/").status_code == 200)


def _dashboard(c: TestClient) -> None:
    with FIXTURE.open("rb") as fh:
        r = c.post("/api/upload", files={"file": (FIXTURE.name, fh)},
                   data={"kind": "history"})
    check("an export uploads", r.status_code == 200, r.text)
    check("the uploaded file is listed",
          c.get("/api/state").json()["history"] == [FIXTURE.name])

    r = c.post("/api/analyze", json={"haircut": 0.7, "cap": 3, "merge_gap": 5})
    check("the analysis runs", r.status_code == 200, r.text[:200])
    payload = r.json()
    check("the payload has campaigns in it", bool(payload.get("campaigns")),
          sorted(payload)[:6])

    r = c.get("/api/export?format=csv")
    check("the csv export downloads",
          r.status_code == 200 and r.content[:3] == b"\xef\xbb\xbf", r.status_code)
    check("the csv is sent as an attachment",
          "attachment" in r.headers.get("content-disposition", ""))
    r = c.get("/api/export?format=xlsx")
    check("the excel export downloads",
          r.status_code == 200 and r.content[:2] == b"PK", r.status_code)

    r = c.post("/api/upload", files={"file": ("payload.exe", b"x" * 32)},
               data={"kind": "history"})
    check("the file type is enforced on the server, not just in the browser",
          r.status_code == 400, r.status_code)

    r = c.post("/api/clear")
    check("starting over empties the workspace",
          r.status_code == 200 and c.get("/api/state").json()["history"] == [])


def _csrf_and_admin_gate(c: TestClient) -> None:
    r = c.post("/api/clear", headers={"Origin": "https://evil.example"})
    check("a write from another origin is refused", r.status_code == 403, r.status_code)
    check("an ordinary member cannot reach the admin api",
          c.get("/api/admin/users").status_code == 403)
    r = c.get("/admin", follow_redirects=False)
    check("an ordinary member is bounced off the admin page",
          r.status_code == 303 and r.headers["location"] == "/", r.status_code)


def _isolation(c: TestClient) -> None:
    with TestClient(app, base_url="http://testserver") as other:
        verify_new_user(other, "bob@example.com", "another-good-1", "Bob")
        other.post("/api/auth/login",
                   json={"email": "bob@example.com", "password": "another-good-1"})
        with FIXTURE.open("rb") as fh:
            other.post("/api/upload", files={"file": ("bobs-file.xlsx", fh)},
                       data={"kind": "history"})
        check("the second account sees its own upload",
              other.get("/api/state").json()["history"] == ["bobs-file.xlsx"])
        check("the first account does not see it",
              c.get("/api/state").json()["history"] == [])
        check("and has no analysis to export from the other's data",
              other.get("/api/export?format=csv").status_code == 400)


def _logout(c: TestClient) -> None:
    check("signing out works", c.post("/api/auth/logout").status_code == 200)
    check("the session is dead afterwards", c.get("/api/state").status_code == 401)


def _forgot_and_reset(c: TestClient) -> None:
    before = len(SENT)
    known = c.post("/api/auth/forgot", json={"email": "alice@example.com"})
    unknown = c.post("/api/auth/forgot", json={"email": "ghost@example.com"})
    check("forgot-password answers the same for a known and unknown address",
          known.status_code == unknown.status_code and known.json() == unknown.json())
    check("but only the real address was actually emailed", len(SENT) == before + 1)

    token = token_from_mail("http://testserver/reset?token=")
    r = c.post("/api/auth/reset",
               json={"token": token, "password": "brand-new-secret-9"})
    check("the password is reset", r.status_code == 200, r.text)
    r = c.post("/api/auth/reset",
               json={"token": token, "password": "yet-another-one-1"})
    check("a reset token works only once", r.status_code == 400, r.status_code)

    r = c.post("/api/auth/login",
               json={"email": "alice@example.com", "password": "correct-horse-1"})
    check("the old password stops working", r.status_code == 401)
    r = c.post("/api/auth/login",
               json={"email": "alice@example.com", "password": "brand-new-secret-9"})
    check("the new password works", r.status_code == 200, r.text)
    c.post("/api/auth/logout")


def _lockout(c: TestClient) -> None:
    s = get_settings()
    for _ in range(s.MAX_FAILED_LOGINS + 1):
        r = c.post("/api/auth/login",
                   json={"email": "bob@example.com", "password": "definitely-wrong"})
    check("a locked account is not announced as locked",
          r.status_code == 401 and r.json()["error"] == GENERIC_LOGIN_ERROR, r.text)
    r = c.post("/api/auth/login",
               json={"email": "bob@example.com", "password": "another-good-1"})
    check("even the right password is refused while locked",
          r.status_code == 401, r.status_code)


def _admin(c: TestClient) -> None:
    from app.bootstrap import seed_admin

    s = get_settings()
    with db_module.SessionLocal() as db:
        seed_admin(db, s)

    r = c.post("/api/auth/login",
               json={"email": s.ADMIN_EMAIL,
                     "password": s.ADMIN_PASSWORD.get_secret_value()})
    check("the seeded admin can sign in", r.status_code == 200, r.text)

    r = c.get("/api/admin/users")
    check("the admin can list accounts",
          r.status_code == 200 and len(r.json()["users"]) >= 3, r.text[:200])
    check("the admin page renders", c.get("/admin").status_code == 200)

    users = r.json()["users"]
    bob = next(u for u in users if u["email"] == "bob@example.com")
    check("the admin can clear a lockout",
          c.post(f"/api/admin/users/{bob['id']}/activate").status_code == 200)
    check("the admin can disable an account",
          c.post(f"/api/admin/users/{bob['id']}/deactivate").status_code == 200)

    r = c.post("/api/auth/login",
               json={"email": "bob@example.com", "password": "another-good-1"})
    check("a disabled account cannot sign in", r.status_code == 401, r.status_code)

    me = c.get("/api/auth/me").json()["user"]
    check("the admin cannot disable themselves",
          c.post(f"/api/admin/users/{me['id']}/deactivate").status_code == 400)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        import shutil
        shutil.rmtree(WORK, ignore_errors=True)
