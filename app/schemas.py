"""Request and response bodies.

Declaring these as pydantic models is also a CSRF control: FastAPI then rejects
form-encoded content types with a 422, and an HTML form can only produce those.
A cross-site form therefore cannot reach any of these endpoints even before the
SameSite cookie attribute is considered.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.config import get_settings


def _password_field() -> Field:
    s = get_settings()
    return Field(min_length=s.MIN_PASSWORD_LENGTH, max_length=s.MAX_PASSWORD_LENGTH)


class SignupIn(BaseModel):
    email: EmailStr
    password: str = _password_field()
    name: str = Field(default="", max_length=120)

    @field_validator("name")
    @classmethod
    def _tidy(cls, v: str) -> str:
        return v.strip()


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class EmailIn(BaseModel):
    email: EmailStr


class TokenIn(BaseModel):
    token: str = Field(min_length=8, max_length=256)


class ResetIn(TokenIn):
    password: str = _password_field()


class SettingsIn(BaseModel):
    """The modelling assumptions the dashboard sends with /api/analyze.

    `roas` is a string because the settings dialog sends "" for "use the
    account average", and the pipeline already treats falsy as absent.
    """

    roas: str | float | None = None
    haircut: float = Field(default=0.7, ge=0, le=1)
    cap: float = Field(default=3, gt=0, le=100)
    merge_gap: int = Field(default=5, ge=0, le=720)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    is_admin: bool
    is_active: bool
    verified: bool
    created_at: datetime | None = None
    last_login_at: datetime | None = None

    @classmethod
    def of(cls, user) -> "UserOut":
        return cls(id=user.id, email=user.email, name=user.name,
                   is_admin=user.is_admin, is_active=user.is_active,
                   verified=user.is_verified, created_at=user.created_at,
                   last_login_at=user.last_login_at)


class Ok(BaseModel):
    ok: bool = True
    message: str | None = None
