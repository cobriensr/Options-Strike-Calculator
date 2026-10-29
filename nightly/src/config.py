"""Settings read from the environment at boot.

A missing required variable fails `load_settings()` with a ValidationError that
names the field. There is no `.env` reading and no CLI flag for secrets.
"""

from __future__ import annotations

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Nightly job configuration."""

    model_config = SettingsConfigDict(extra="ignore")

    uw_api_key: SecretStr
    r2_access_key_id: SecretStr
    r2_secret_access_key: SecretStr
    r2_endpoint_url: str
    r2_bucket_fulltape: str
    sentry_dsn: str | None = None

    @field_validator("r2_endpoint_url")
    @classmethod
    def _require_https(cls, value: str) -> str:
        if not value.startswith("https://"):
            raise ValueError("r2_endpoint_url must start with https://")
        return value


def load_settings() -> Settings:
    """Build Settings from the environment, raising ValidationError if invalid."""
    return Settings()  # type: ignore[call-arg]
