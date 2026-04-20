"""Strategy parameters — the sweep space for E1.4.

Per the v5 amendment, the PAC backtest is not pre-committed to reversals:
both CHoCH family (reversal) and BOS family (continuation) entry triggers
are tested. The E1.4 Optuna sweep will explore this entire param space.

For E1.3 Phase 1 we ship the model and enough triggers to run a baseline
backtest. Less-common triggers (choch_at_ob, bos_at_ob_retest, etc.)
land in Phase 2 when OB / FVG integration is tuned.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class EntryTrigger(StrEnum):
    """PAC structure event that fires a trade entry."""

    # Reversal family (CHoCH)
    CHOCH_REVERSAL = "choch_reversal"
    CHOCH_PLUS_REVERSAL = "choch_plus_reversal"
    # Continuation family (BOS)
    BOS_BREAKOUT = "bos_breakout"
    # Deferred to Phase 2: choch_at_ob, choch_at_fvg_fill, bos_retest,
    # bos_at_ob_retest, bos_with_volume


class ExitTrigger(StrEnum):
    """Rule that closes an open trade."""

    OPPOSITE_CHOCH = "opposite_choch"
    OPPOSITE_BOS = "opposite_bos"
    ATR_TARGET = "atr_target"
    SESSION_END = "session_end"
    # Deferred to Phase 2: ob_mitigation, trailing_swing


class StopPlacement(StrEnum):
    """Where the protective stop sits relative to entry."""

    N_ATR = "n_atr"  # N × ATR(14) from entry
    SWING_EXTREME = "swing_extreme"  # prior swing high/low from PAC
    # Deferred to Phase 2: ob_boundary, broken_swing


class SessionFilter(StrEnum):
    """Which intraday session is eligible for entries."""

    RTH = "rth"  # 13:30-20:00 UTC (8:30-15:00 CT during DST)
    NY_OPEN = "ny_open"  # 13:30-15:30 UTC (first 2 hours of RTH)
    RTH_EX_LUNCH = "rth_ex_lunch"  # RTH excluding 17:00-18:00 UTC (noon lunch)


@dataclass(frozen=True)
class StrategyParams:
    """Full parameter space for a single backtest run.

    Frozen for determinism — the sweep builds thousands of distinct
    StrategyParams instances and uses them as dict keys. Pydantic would
    give richer validation but a simple dataclass keeps the hot path
    allocation-free.

    Guardrails are enforced by __post_init__.
    """

    # --- Entry / exit / stop ---
    entry_trigger: EntryTrigger = EntryTrigger.CHOCH_PLUS_REVERSAL
    exit_trigger: ExitTrigger = ExitTrigger.OPPOSITE_CHOCH
    stop_placement: StopPlacement = StopPlacement.N_ATR

    # --- Position sizing ---
    contracts: int = 1  # number of contracts per entry (always 1 for v1)

    # --- Stop / target parameters ---
    stop_atr_multiple: float = 1.5  # used when stop_placement = N_ATR
    target_atr_multiple: float = 2.0  # used when exit_trigger = ATR_TARGET

    # --- Session filter ---
    session: SessionFilter = SessionFilter.RTH

    # --- Options filters (E1.2a features; some deferred to E1.2b) ---
    # None = filter off; values match overlay column semantics
    iv_tercile_filter: str | None = None  # "low" | "mid" | "high" | None
    event_day_filter: str | None = None  # "skip_events" | "events_only" | None

    # --- Cost model ---
    commission_per_rt: float = 1.90  # round-trip commission in USD (MNQ default)
    slippage_ticks: float = 0.5  # added to entry, subtracted from exit
    tick_value_dollars: float = 0.50  # MNQ tick value = $0.50; NQ = $5.00

    def __post_init__(self) -> None:
        if self.contracts < 1:
            raise ValueError(f"contracts must be >= 1, got {self.contracts}")
        if self.stop_atr_multiple <= 0:
            raise ValueError(
                f"stop_atr_multiple must be > 0, got {self.stop_atr_multiple}"
            )
        if self.target_atr_multiple <= 0:
            raise ValueError(
                f"target_atr_multiple must be > 0, got {self.target_atr_multiple}"
            )
        if self.commission_per_rt < 0:
            raise ValueError(
                f"commission_per_rt must be >= 0, got {self.commission_per_rt}"
            )
        if self.slippage_ticks < 0:
            raise ValueError(
                f"slippage_ticks must be >= 0, got {self.slippage_ticks}"
            )
        if self.tick_value_dollars <= 0:
            raise ValueError(
                f"tick_value_dollars must be > 0, got {self.tick_value_dollars}"
            )

    def session_window_utc(self) -> tuple[str, str]:
        """Return (start_time_utc, end_time_utc) as HH:MM strings."""
        if self.session == SessionFilter.RTH:
            return ("13:30", "20:00")
        if self.session == SessionFilter.NY_OPEN:
            return ("13:30", "15:30")
        if self.session == SessionFilter.RTH_EX_LUNCH:
            return ("13:30", "20:00")  # lunch exclusion handled separately
        raise ValueError(f"Unhandled session: {self.session}")
