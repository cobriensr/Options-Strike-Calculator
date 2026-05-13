"""Configuration loaded from environment variables via pydantic-settings.

Mirrors the sidecar's `config.py` pattern. All env var names are
documented in `README.md`. Defaults are tuned for production; local
development can override via `.env`.
"""

from __future__ import annotations

from typing import Literal

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings

from channel_registry import is_known_channel_token

# Forgiving canonicalization for WS_CHANNELS env vars. UW's flow-alerts
# channel uses a HYPHEN even though the URL path and most other channel
# names use underscores — almost everyone (including ourselves on
# Railway 2026-05-03) types `flow_alerts` and gets an empty handler
# table. Map the underscore form back to the canonical hyphen form so
# either env-var spelling boots cleanly.
_CHANNEL_ALIASES: dict[str, str] = {
    "flow_alerts": "flow-alerts",
}

# Lottery Finder universe — V3 (Mode A 0DTE intraday list) plus EXTENDED
# (Mode B DTE 1-3 trend list). Mirrors LOTTERY_V3_TICKERS +
# LOTTERY_EXTENDED_TICKERS in api/_lib/lottery-finder.ts; if either side
# changes, both lists need updating. Kept verbatim as a Python frozenset
# so the WS subscription set is stable regardless of dict iteration
# order in older Pythons.
_LOTTERY_TICKERS: frozenset[str] = frozenset(
    {
        # V3 (Mode A 0DTE intraday)
        "USAR", "WMT", "STX", "SOUN", "RIVN", "TSM", "SNDK", "XOM", "WDC", "SQQQ",
        "NDXP", "USO", "TNA", "RDDT", "SMCI", "TSLL", "SNOW", "TEAM", "RKLB", "SOFI",
        "RUTW", "TSLA", "SOXS", "WULF", "SLV", "SMH", "UBER", "MSTR", "TQQQ", "RIOT",
        "SOXL", "UNH", "QQQ", "RBLX", "SPY", "IWM",
        "SPXW",  # Added 2026-05-07 — primary 0DTE traded chain. See spec
                 # docs/superpowers/specs/spxw-backfill-2026-05-07.md.
        # Added 2026-05-07 from ticker discovery audit. V3 (Mode A) batch:
        # AI / speculative / crypto-adjacent that surfaced as top
        # 0DTE candidates. See docs/tmp/ticker-discovery-audit-2026-05-06.md
        "CRWV", "IBIT", "ARM", "OKLO", "APLD", "IONQ",
        "HIMS", "CAR", "IREN", "ASTS", "NBIS", "CRCL", "LITE", "NVTS",
        # EXTENDED (Mode B DTE 1-3 trend; SPY/IWM dedupe via set)
        "MU", "META", "AMD", "NVDA", "INTC", "MSFT", "AMZN",
        "PLTR", "AVGO", "GOOGL", "GOOG", "COIN", "HOOD", "MRVL",
        "ORCL", "AAPL",
        # Added 2026-05-07 from ticker discovery audit. EXTENDED (Mode B)
        # batch: mega-cap peer-class oversights.
        "QCOM", "NFLX", "LLY", "BABA", "NOW", "CRWD",
    },
)

# Shorthand sentinels for the lottery universe — typing one of these
# tokens in WS_CHANNELS expands to one per-ticker subscription per
# token, saving 50+ channel names in env config. Same ticker set for
# both shorthand spellings (option_trades_lottery, net_flow_lottery)
# so the daemon can subscribe to per-tick option flow + per-tick net
# premium aggregates on the same universe.
_OPTION_TRADES_LOTTERY = "option_trades_lottery"
_NET_FLOW_LOTTERY = "net_flow_lottery"


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

    # Interval B/A alert thresholds (SPXW handler — see
    # docs/superpowers/specs/interval-ba-ask-alert-2026-05-12.md).
    # Defaults are tuned for SPXW 0DTE specifically: a ≥75% ask-side
    # 5-min bucket on $250K+ premium is the structural-anomaly band
    # given SPX's mid-fill-dominated tape.
    #
    # Threshold raised 2026-05-12 from 0.70 → 0.75 after the empirical
    # edge analysis (12,313-alert backfill against 89 trading days,
    # docs/tmp/interval-ba-analysis-20260512-214350.md): the 70-75%
    # ratio band has hit-rate only +0.0pp over baseline at EOD on
    # CALLs, while the 75-85% band delivers +4pp edge with 26% fewer
    # alerts. 70% was below saturation.
    #
    # ``interval_ba_enabled`` defaults False so Phase 1 (handler ships)
    # can run in production accumulating state and emitting "would
    # have fired" log lines without writing to the not-yet-existing
    # ``interval_ba_alerts`` table. Phase 2 (DB migration) flips this
    # to True via the env var.
    interval_ba_enabled: bool = False
    interval_ba_ratio_threshold: float = 0.75
    interval_ba_premium_floor: int = 250_000
    interval_ba_window_sec: int = 300
    # Reject the alert when the multi-leg share of the bucket's premium
    # is at or above this threshold. Mirrors the silent-boom detector's
    # ``multiLegShareMax`` (see api/_lib/silent-boom.ts and migration
    # #146): UW's ``trade_code`` field carries the OPRA multi-leg sale
    # condition codes (mlat/mlet/mlft/mfto/masl/mesl/mfsl/mlct), and
    # spread-leg-dominated buckets carry no directional thesis. The
    # 2026-05-13 SPXW 6850 false fire was a single $1.14M ``mlet``
    # print → 100% ask, 100% multi-leg; this gate rejects that case.
    # Distribution of ML share across surviving fires is bimodal at ~0%
    # and ~100%, so 0.5 is a clean separator.
    interval_ba_multi_leg_share_max: float = 0.5

    # Per-ticker opt-in. Each handler (SPY/SPXW/QQQ) gates its DB+push
    # path on its ticker being present here. Defaults to all three;
    # operator can silence one (e.g. drop "QQQ") via the env var
    # INTERVAL_BA_TICKERS=SPY,SPXW without a code change. Stored as a
    # comma-separated string + parsed via the ``interval_ba_tickers``
    # property so the env shape matches ws_channels' convention.
    interval_ba_tickers_csv: str = "SPY,SPXW,QQQ"

    # Push-notification gating (Phase 4 of cross-symbol confluence spec,
    # docs/superpowers/specs/interval-ba-confluence-2026-05-13.md). When
    # True (default), only alerts whose confluence_tickers list is
    # non-empty fire a Web Push notification — solo SPY/SPXW/QQQ alerts
    # still write to interval_ba_alerts and surface in the in-app feed,
    # but they don't ping the phone. Suppresses the ~205-alerts/day fire
    # hose to ~30-50/day. Set INTERVAL_BA_PUSH_CONFLUENCE_ONLY=false to
    # restore the old "every alert pushes" behavior.
    interval_ba_push_confluence_only: bool = True

    # Web Push v2 (see docs/superpowers/specs/interval-ba-push-v2-2026-05-12.md).
    # Both default empty → notify_alert no-ops, mirroring the Phase 1
    # interval_ba_enabled pattern. Activate by setting both env vars on
    # Railway after the Vercel /api/push/* endpoints + VAPID keys are
    # in place. INTERNAL_NOTIFY_SECRET must match the Vercel-side value
    # byte-for-byte; the Vercel endpoint compares it via timing-safe
    # equal.
    vercel_notify_url: str = ""
    internal_notify_secret: str = ""

    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("ws_log_sample_rate")
    @classmethod
    def _validate_sample_rate(cls, v: float) -> float:
        if not 0.0 <= v <= 1.0:
            raise ValueError("ws_log_sample_rate must be in [0.0, 1.0]")
        return v

    @field_validator("interval_ba_ratio_threshold")
    @classmethod
    def _validate_ratio_threshold(cls, v: float) -> float:
        if not 0.0 < v <= 1.0:
            raise ValueError(
                "interval_ba_ratio_threshold must be in (0.0, 1.0]"
            )
        return v

    @field_validator("interval_ba_premium_floor")
    @classmethod
    def _validate_premium_floor(cls, v: int) -> int:
        if v < 0:
            raise ValueError("interval_ba_premium_floor must be >= 0")
        return v

    @field_validator("interval_ba_window_sec")
    @classmethod
    def _validate_window_sec(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("interval_ba_window_sec must be > 0")
        return v

    @field_validator("interval_ba_multi_leg_share_max")
    @classmethod
    def _validate_multi_leg_share_max(cls, v: float) -> float:
        if not 0.0 < v <= 1.0:
            raise ValueError(
                "interval_ba_multi_leg_share_max must be in (0.0, 1.0]"
            )
        return v

    @field_validator("ws_channels")
    @classmethod
    def _validate_channels_known(cls, v: str) -> str:
        """Reject unknown channel names at Settings() construction.

        Each comma-separated token in ``ws_channels`` is alias-resolved
        and then checked against the channel registry. A typo in
        WS_CHANNELS would otherwise silently boot the daemon with an
        unsubscribed channel; surfacing it here means the operator sees
        a clear error at startup instead of an empty handler table.
        """
        for raw in v.split(","):
            tok = raw.strip()
            if not tok:
                continue
            tok = _CHANNEL_ALIASES.get(tok, tok)
            if not is_known_channel_token(tok):
                raise ValueError(
                    f"WS_CHANNELS contains unknown channel {tok!r}. "
                    "Expected an exact channel name (e.g. 'flow-alerts', "
                    "'off_lit_trades'), a prefixed channel (e.g. "
                    "'option_trades:TSLA'), or a shorthand "
                    "('option_trades_lottery', 'net_flow_lottery'). "
                    "See channel_registry.py for the full list."
                )
        return v

    @model_validator(mode="after")
    def _validate_channels_non_empty(self) -> Settings:
        """Fail at Settings() construction (not at first .channels read)
        when WS_CHANNELS resolves to an empty list."""
        if not self.channels:
            raise ValueError(
                "WS_CHANNELS resolved to an empty list "
                "(check the WS_CHANNELS env var)"
            )
        return self

    @property
    def channels(self) -> list[str]:
        """Parse WS_CHANNELS into a deduped, trimmed list.

        Applies the known-aliases map so common typos like
        ``flow_alerts`` (URL-path style) get mapped to the canonical
        WS channel name ``flow-alerts``.

        Two shorthands expand inline to per-ticker channels:
        - ``option_trades_lottery`` → ``option_trades:<TICKER>`` per
          ticker in the Lottery Finder universe.
        - ``net_flow_lottery`` → ``net_flow:<TICKER>`` per ticker in
          the same universe (per-tick net call/put premium aggregates).
        Same ticker set for both so option-tape + net-flow stay aligned.
        """
        seen: set[str] = set()
        out: list[str] = []
        # Map shorthand → expansion-prefix. Sorted ticker list inside
        # so the channel order in /metrics + logs is stable across
        # daemon restarts.
        shorthand_prefix: dict[str, str] = {
            _OPTION_TRADES_LOTTERY: "option_trades:",
            _NET_FLOW_LOTTERY: "net_flow:",
        }
        for raw in self.ws_channels.split(","):
            ch = raw.strip()
            ch = _CHANNEL_ALIASES.get(ch, ch)
            if not ch:
                continue
            prefix = shorthand_prefix.get(ch)
            if prefix is not None:
                for ticker in sorted(_LOTTERY_TICKERS):
                    expanded = f"{prefix}{ticker}"
                    if expanded not in seen:
                        seen.add(expanded)
                        out.append(expanded)
                continue
            if ch not in seen:
                seen.add(ch)
                out.append(ch)
        return out

    @property
    def interval_ba_tickers(self) -> frozenset[str]:
        """Parse interval_ba_tickers_csv into a deduped, trimmed set.

        Each handler subclass checks membership at construction; an
        empty / malformed env var silences every handler instance (the
        master ``interval_ba_enabled`` switch is the explicit kill).
        """
        return frozenset(
            t.strip().upper()
            for t in self.interval_ba_tickers_csv.split(",")
            if t.strip()
        )

    @property
    def ws_url(self) -> str:
        """Full websocket URL with token query param baked in."""
        return f"wss://api.unusualwhales.com/socket?token={self.uw_api_key}"


settings = Settings()  # type: ignore[call-arg]
