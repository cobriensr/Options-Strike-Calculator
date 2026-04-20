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
    OB_BOUNDARY = "ob_boundary"  # OB top (for short) / bottom (for long) at entry
    # Deferred: broken_swing


class SessionFilter(StrEnum):
    """Which intraday session is eligible for entries.

    The v3 broad buckets are kept for backward compat. v4 added the
    finer-grained `SessionBucket` filter (see below) which works on the
    `session_bucket` column added by `pac.features.add_session_bucket`.
    Both can coexist in `StrategyParams`.
    """

    RTH = "rth"  # 13:30-20:00 UTC (8:30-15:00 CT during DST)
    NY_OPEN = "ny_open"  # 13:30-15:30 UTC (first 2 hours of RTH)
    RTH_EX_LUNCH = "rth_ex_lunch"  # RTH excluding 17:00-18:00 UTC (noon lunch)


class SessionBucket(StrEnum):
    """E1.4d v4 fine-grained intraday bucket filter.

    Matches the `session_bucket` column produced by
    `pac.features.add_session_bucket`. `ANY` disables the filter so it
    can sit alongside the broader `SessionFilter` enum without conflict.
    """

    ANY = "any"
    PRE_MARKET = "pre_market"
    NY_OPEN = "ny_open"
    AM = "am"
    LUNCH = "lunch"
    PM = "pm"
    CLOSE = "close"


class EntryVsOb(StrEnum):
    """Filter on entry-price position relative to the most-recent active OB."""

    ANY = "any"
    ABOVE_OB_MID = "above_ob_mid"
    INSIDE_OB = "inside_ob"
    BELOW_OB_MID = "below_ob_mid"


class OnOppositeSignal(StrEnum):
    """How to react when an opposite-direction entry signal fires while in a trade.

    HOLD_AND_SKIP    : ignore the new signal (v3 default behavior)
    EXIT_ONLY        : close current at next-bar-open, do not flip
    EXIT_AND_FLIP    : close current AND open opposite at the same fill bar
    HOLD_AND_TIGHTEN : keep position; move stop to entry price (breakeven)
    """

    HOLD_AND_SKIP = "hold_and_skip"
    EXIT_ONLY = "exit_only"
    EXIT_AND_FLIP = "exit_and_flip"
    HOLD_AND_TIGHTEN = "hold_and_tighten"


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

    # --- E1.4d v4 entry-quality filters ---
    # All default to OFF / ANY so v3 behavior is preserved when the new
    # search dims aren't sampled.
    session_bucket: SessionBucket = SessionBucket.ANY
    min_ob_volume_z: float | None = None  # require OB volume z >= threshold
    min_ob_pct_atr: float | None = None  # require OB width as % of ATR >= threshold
    entry_vs_ob: EntryVsOb = EntryVsOb.ANY  # entry price position vs OB
    min_z_entry_vwap: float | None = None  # signed by direction; require |z| >= threshold ON THE TRADE'S SIDE of VWAP
    min_adx_14: float | None = None  # require ADX(14) >= threshold

    # --- E1.4d v4 position-management dim ---
    on_opposite_signal: OnOppositeSignal = OnOppositeSignal.HOLD_AND_SKIP

    # --- E1.4d v4 exit additions ---
    exit_after_n_bos: int | None = None  # close after N same-dir BOS post-entry

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
        if self.exit_after_n_bos is not None and self.exit_after_n_bos < 1:
            raise ValueError(
                f"exit_after_n_bos must be >= 1 if set, got {self.exit_after_n_bos}"
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
