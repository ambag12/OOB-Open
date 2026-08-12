"""Every knob the hosted app has, read once from the environment.

Secrets are `SecretStr` so they render as `**********` in tracebacks and in any
accidental `print(settings)`. The validator refuses to start on the two
misconfigurations that otherwise fail silently and confusingly at runtime.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _unquote(value: str) -> str:
    """Drop one matched pair of surrounding quotes.

    `docker run --env-file` passes values through literally, so a .env line
    reading MYSQL_PASSWORD='secret' arrives with the quotes still attached and
    the database answers "Access denied" with nothing to explain why. dotenv and
    `docker compose env_file:` both strip them, so this only ever fires on the
    raw docker run path -- but that failure is expensive to diagnose and this is
    cheap. A value that genuinely begins and ends with the same quote character
    would need it doubled.
    """
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8",
        extra="ignore", case_sensitive=False,
    )

    # ---- application -------------------------------------------------------
    APP_NAME: str = "PPC Out-of-Budget Dashboard"
    # Verification and reset links are built from this. If it is wrong, every
    # emailed link points somewhere the recipient cannot reach.
    APP_BASE_URL: str = "http://localhost:8000"
    SECRET_KEY: SecretStr
    ENV: Literal["dev", "prod"] = "prod"
    LOG_LEVEL: str = "INFO"

    # ---- database ----------------------------------------------------------
    MYSQL_HOST: str
    MYSQL_PORT: int = 3306
    MYSQL_USER: str
    MYSQL_PASSWORD: SecretStr
    MYSQL_DATABASE: str
    MYSQL_POOL_SIZE: int = 5
    MYSQL_POOL_RECYCLE: int = 3600
    MYSQL_SLOW_QUERY_MS: int = 500

    # ---- sessions & auth ---------------------------------------------------
    SESSION_COOKIE_NAME: str = "oob_session"
    SESSION_TTL_DAYS: int = 14
    # None means "derive from APP_BASE_URL". Setting it True over plain http
    # makes the browser silently drop the cookie -- login then does nothing.
    COOKIE_SECURE: bool | None = None
    VERIFY_TOKEN_TTL_HOURS: int = 24
    RESET_TOKEN_TTL_MINUTES: int = 60
    MAX_FAILED_LOGINS: int = 5
    LOCKOUT_MINUTES: int = 15
    MIN_PASSWORD_LENGTH: int = 10
    MAX_PASSWORD_LENGTH: int = 128
    SIGNUP_ENABLED: bool = True
    SIGNUP_ALLOWED_DOMAINS: str = ""      # comma separated; blank means any

    # ---- admin bootstrap ---------------------------------------------------
    ADMIN_EMAIL: str | None = None
    ADMIN_PASSWORD: SecretStr | None = None
    # Off by default: otherwise every restart reverts a rotated password and the
    # stale .env value becomes a permanent backdoor.
    ADMIN_RESET_PASSWORD: bool = False

    # ---- email -------------------------------------------------------------
    EMAIL_PROVIDER: Literal["api", "console"] = "api"
    EMAIL_ENDPOINT: str | None = None
    EMAIL_API_KEY: SecretStr | None = None
    EMAIL_FROM_NAME: str = "PPC Dashboard"
    EMAIL_TIMEOUT_S: float = 10.0

    # ---- workspaces & limits ----------------------------------------------
    WORKSPACE_ROOT: str | None = None                 # None -> system temp dir
    MAX_UPLOAD_BYTES: int = 200 * 1024 * 1024         # one file
    MAX_WORKSPACE_BYTES: int = 400 * 1024 * 1024      # per user, cumulative
    MAX_TOTAL_WORKSPACE_BYTES: int = 4 * 1024 ** 3
    MAX_ACTIVE_WORKSPACES: int = 20
    WORKSPACE_IDLE_TTL_MIN: int = 30
    MAX_CONCURRENT_ANALYSES: int = 2

    @field_validator("MYSQL_PASSWORD", "ADMIN_PASSWORD", "EMAIL_API_KEY",
                     "SECRET_KEY", mode="before")
    @classmethod
    def _strip_quotes(cls, v):
        return _unquote(v) if isinstance(v, str) else v

    @property
    def base_url(self) -> str:
        return self.APP_BASE_URL.rstrip("/")

    @property
    def cookie_secure(self) -> bool:
        if self.COOKIE_SECURE is not None:
            return self.COOKIE_SECURE
        return self.base_url.startswith("https://")

    @property
    def allowed_signup_domains(self) -> set[str]:
        return {d.strip().lower() for d in self.SIGNUP_ALLOWED_DOMAINS.split(",") if d.strip()}

    @model_validator(mode="after")
    def _check(self) -> "Settings":
        if len(self.SECRET_KEY.get_secret_value()) < 32:
            raise ValueError(
                "SECRET_KEY must be at least 32 characters. Generate one with: "
                'python -c "import secrets; print(secrets.token_urlsafe(48))"'
            )
        if self.EMAIL_PROVIDER == "api" and not (self.EMAIL_ENDPOINT and self.EMAIL_API_KEY):
            raise ValueError(
                "EMAIL_PROVIDER=api needs EMAIL_ENDPOINT and EMAIL_API_KEY. "
                "Set EMAIL_PROVIDER=console to log emails instead of sending them."
            )
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
