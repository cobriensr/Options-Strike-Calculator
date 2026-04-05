"""Configuration loaded from environment variables via pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All environment variables required by the sidecar."""

    # Databento
    databento_api_key: str

    # Postgres (Neon)
    database_url: str

    # Twilio SMS alerts
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_from_number: str = ""
    alert_phone_number: str = ""

    # Runtime
    port: int = 8080
    log_level: str = "INFO"

    # Alert config refresh interval (seconds)
    alert_config_refresh_s: int = 300

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def twilio_configured(self) -> bool:
        return bool(
            self.twilio_account_sid
            and self.twilio_auth_token
            and self.twilio_from_number
            and self.alert_phone_number
        )


settings = Settings()  # type: ignore[call-arg]
