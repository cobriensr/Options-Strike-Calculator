"""Configuration loaded from environment variables via pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All environment variables required by the sidecar."""

    # Databento
    databento_api_key: str

    # Postgres (Neon)
    database_url: str

    # Runtime
    port: int = 8080
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()  # type: ignore[call-arg]
