"""Settings read from the environment at boot.

A missing required variable fails `load_settings()` with a ValidationError that
names the field. There is no `.env` reading and no CLI flag for secrets.

A malformed SENTRY_DSN fails boot too, with a fixed message that never echoes it.
`load_sentry_dsn()` reads that one variable alone, so a run whose other settings are
invalid can still report that to Sentry.
"""

from __future__ import annotations

from typing import Annotated

from pydantic import AfterValidator, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sentry_sdk.utils import Dsn


def _valid_dsn(value: str | None) -> str | None:
    """The DSN if the SDK can parse it; blank means unset."""
    if value is None or not value.strip():
        return None
    try:
        Dsn(value)
    except ValueError:  # BadDsn, and urlsplit's own errors (a bad port)
        raise ValueError("invalid sentry dsn") from None
    return value


SentryDsn = Annotated[str | None, AfterValidator(_valid_dsn)]


class Settings(BaseSettings):
    """Nightly job configuration."""

    model_config = SettingsConfigDict(extra="ignore")

    uw_api_key: SecretStr
    r2_access_key_id: SecretStr
    r2_secret_access_key: SecretStr
    r2_endpoint_url: str
    r2_bucket_fulltape: str
    sentry_dsn: SentryDsn = None

    @field_validator("r2_endpoint_url")
    @classmethod
    def _require_https(cls, value: str) -> str:
        if not value.startswith("https://"):
            raise ValueError("r2_endpoint_url must start with https://")
        return value


class _SentryOnly(BaseSettings):
    """SENTRY_DSN alone, read the same way Settings reads it."""

    model_config = SettingsConfigDict(extra="ignore")

    sentry_dsn: SentryDsn = None


def load_settings() -> Settings:
    """Build Settings from the environment, raising ValidationError if invalid."""
    return Settings()  # type: ignore[call-arg]


def load_sentry_dsn() -> str | None:
    """SENTRY_DSN if it is set and valid, whatever the other settings hold; else None."""
    try:
        return _SentryOnly().sentry_dsn
    except ValidationError:
        return None
