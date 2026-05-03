"""Configuration loaded from environment variables via pydantic-settings.

Mirrors the sidecar's `config.py` pattern. All env var names are
documented in `README.md`. Defaults are tuned for production; local
development can override via `.env`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All environment variables required by uw-stream."""

    # Required.
    database_url: str
    uw_api_key: str

    # Optional infrastructure.
    sentry_dsn: str = ""
    port: int = 8080
    log_level: str = "INFO"

    # Channel selection. Comma-separated string parsed into a list via
    # `channels` property. Defaults to flow-alerts only (Phase 1 scope).
    ws_channels: str = "flow-alerts"

    # Backpressure tuning.
    ws_queue_size: int = 50_000
    ws_batch_size: int = 500
    ws_batch_interval_ms: int = 2_000
    ws_backpressure_policy: Literal["drop_oldest", "drop_newest", "block"] = "drop_oldest"

    # Diagnostics.
    ws_log_sample_rate: float = 0.001

    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("ws_log_sample_rate")
    @classmethod
    def _validate_sample_rate(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("ws_log_sample_rate must be in [0.0, 1.0]")
        return v

    @property
    def channels(self) -> list[str]:
        """Parse WS_CHANNELS into a deduped, trimmed list."""
        seen: set[str] = set()
        out: list[str] = []
        for raw in self.ws_channels.split(","):
            ch = raw.strip()
            if ch and ch not in seen:
                seen.add(ch)
                out.append(ch)
        if not out:
            raise ValueError("WS_CHANNELS resolved to an empty list")
        return out

    @property
    def ws_url(self) -> str:
        """Full websocket URL with token query param baked in."""
        return f"wss://api.unusualwhales.com/socket?token={self.uw_api_key}"


settings = Settings()  # type: ignore[call-arg]
