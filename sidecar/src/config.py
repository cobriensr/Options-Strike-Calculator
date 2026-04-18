"""Configuration loaded from environment variables via pydantic-settings."""

from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """All environment variables required by the sidecar."""

    # Databento
    databento_api_key: str

    # Postgres (Neon)
    database_url: str

    # Theta Data — nightly EOD ingest. Credentials (THETA_EMAIL /
    # THETA_PASSWORD) are read directly by theta_launcher from os.environ
    # at boot time; they deliberately live outside Settings so the sidecar
    # starts fine without them (Databento-only mode).
    theta_roots: str = "SPXW,VIX,VIXW,NDXP"
    theta_backfill_days: int = 90

    # Runtime
    port: int = 8080
    log_level: str = "INFO"

    model_config = {"env_file": ".env", "extra": "ignore"}

    @property
    def theta_roots_list(self) -> list[str]:
        """Parse THETA_ROOTS into a deduped, trimmed list of root symbols."""
        seen: set[str] = set()
        out: list[str] = []
        for raw in self.theta_roots.split(","):
            root = raw.strip().upper()
            if root and root not in seen:
                seen.add(root)
                out.append(root)
        return out


settings = Settings()  # type: ignore[call-arg]
