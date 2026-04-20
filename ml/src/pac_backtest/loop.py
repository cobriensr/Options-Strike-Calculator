"""Event-driven backtest loop.

Walks a PAC-enriched bar DataFrame chronologically, detecting entry
signals and managing open positions through to exit. Produces a list of
closed Trade objects.

Design constraints for v1 (Phase 1 of E1.3):

- **Single position at a time.** If flat, look for entry; if in a trade,
  look for stop/exit. No pyramiding, no layered targets.
- **Bar-close signals with next-bar-open fills.** The standard no-
  lookahead convention for 1m futures.
- **Intrabar stop hits resolve at the stop price.** A bar whose high/low
  crosses the stop closes the trade at the stop level that same bar.
  (Conservative — a market stop order in real conditions might slip
  past. Phase 2 adds configurable stop-fill slippage.)
- **Exit triggers check at bar close.** An opposite-CHoCH on bar N
  triggers an exit fill at bar N+1 open.
- **Session-end exit.** If still in a trade when the session filter
  window closes, flatten at the last in-window bar's close. This is the
  "forced-flat at 15:00 CT" discipline the user already applies.

Not yet implemented (Phase 2):
- numba `@njit` on the inner loop
- L1 tick fill refinement
- OB-boundary and broken-swing stop placements
- Trailing-swing exits
- Partial fills / pyramiding
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from pac_backtest.fills import compute_fill_price
from pac_backtest.params import (
    EntryTrigger,
    ExitTrigger,
    SessionFilter,
    StopPlacement,
    StrategyParams,
)
from pac_backtest.trades import Trade

# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────


def compute_atr(bars: pd.DataFrame, period: int = 14) -> pd.Series:
    """Classic Wilder ATR. Returns per-bar ATR aligned to `bars`."""
    high = bars["high"]
    low = bars["low"]
    close = bars["close"]
    prev_close = close.shift(1)

    tr = pd.concat(
        [
            (high - low).abs(),
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False).mean()


def session_window_mask(
    bars: pd.DataFrame, session: SessionFilter
) -> pd.Series:
    """Boolean mask: True for bars inside the session's entry-eligible window."""
    ts = bars["ts_event"]
    h = ts.dt.hour
    m = ts.dt.minute

    if session == SessionFilter.RTH:
        return ((h == 13) & (m >= 30)) | (h >= 14) & (h < 20) | (  # noqa: E711
            (h == 13) & (m >= 30)
        )
    if session == SessionFilter.NY_OPEN:
        # 13:30 UTC through 15:30 UTC
        return (
            ((h == 13) & (m >= 30))
            | (h == 14)
            | ((h == 15) & (m < 30))
        )
    if session == SessionFilter.RTH_EX_LUNCH:
        # RTH minus lunch hour (17:00-18:00 UTC)
        in_rth = ((h == 13) & (m >= 30)) | ((h >= 14) & (h < 20))
        in_lunch = h == 17
        return in_rth & ~in_lunch
    raise ValueError(f"Unhandled session: {session}")


# ─────────────────────────────────────────────────────────────────────────
# Entry / exit signal detectors
# ─────────────────────────────────────────────────────────────────────────


def detect_entry(
    bar: pd.Series, trigger: EntryTrigger
) -> tuple[str, str] | None:
    """Return (direction, setup_tag) if an entry signal fires on this bar.

    Direction is 'long' or 'short'. setup_tag is a descriptive label used
    downstream for cohort analysis.
    """
    if trigger == EntryTrigger.CHOCH_REVERSAL:
        choch = bar.get("CHOCH")
        if pd.notna(choch) and choch != 0:
            direction = "long" if choch == 1 else "short"
            return (direction, "choch_reversal")
        return None

    if trigger == EntryTrigger.CHOCH_PLUS_REVERSAL:
        cp = bar.get("CHOCHPlus")
        if pd.notna(cp) and cp != 0:
            direction = "long" if cp == 1 else "short"
            return (direction, "choch_plus_reversal")
        return None

    if trigger == EntryTrigger.BOS_BREAKOUT:
        bos = bar.get("BOS")
        if pd.notna(bos) and bos != 0:
            direction = "long" if bos == 1 else "short"
            return (direction, "bos_breakout")
        return None

    raise ValueError(f"Entry trigger not implemented: {trigger}")


def detect_exit(
    bar: pd.Series,
    trade: Trade,
    trigger: ExitTrigger,
    atr: float,
    params: StrategyParams,
) -> str | None:
    """Return an exit reason string if an exit signal fires on this bar.

    Returns None if no exit signal. The caller fills on next-bar-open.
    """
    if trigger == ExitTrigger.OPPOSITE_CHOCH:
        choch = bar.get("CHOCH")
        if pd.notna(choch) and choch != 0:
            # Long exits on bearish CHoCH, short exits on bullish CHoCH
            if (trade.direction == "long" and choch == -1) or (
                trade.direction == "short" and choch == 1
            ):
                return "opposite_choch"
        return None

    if trigger == ExitTrigger.OPPOSITE_BOS:
        bos = bar.get("BOS")
        if pd.notna(bos) and bos != 0:
            if (trade.direction == "long" and bos == -1) or (
                trade.direction == "short" and bos == 1
            ):
                return "opposite_bos"
        return None

    if trigger == ExitTrigger.ATR_TARGET:
        target_distance = atr * params.target_atr_multiple
        if trade.direction == "long":
            if float(bar["high"]) >= trade.entry_price + target_distance:
                return "target_hit"
        else:
            if float(bar["low"]) <= trade.entry_price - target_distance:
                return "target_hit"
        return None

    if trigger == ExitTrigger.SESSION_END:
        return None  # handled by the session-window guard, not per-bar

    raise ValueError(f"Exit trigger not implemented: {trigger}")


def compute_stop_price(
    direction: str,
    entry_price: float,
    bar: pd.Series,
    placement: StopPlacement,
    atr: float,
    params: StrategyParams,
) -> float:
    """Place the protective stop based on StopPlacement rule."""
    if placement == StopPlacement.N_ATR:
        offset = atr * params.stop_atr_multiple
        return (
            entry_price - offset if direction == "long" else entry_price + offset
        )

    if placement == StopPlacement.SWING_EXTREME:
        # For long entries, stop = last swing low below entry
        # For short entries, stop = last swing high above entry
        # We use the most-recent same-direction swing from PAC engine output
        level = bar.get("Level_shl")
        if pd.notna(level) and level != 0:
            return float(level)
        # Fallback: 1.5× ATR if no nearby swing
        offset = atr * 1.5
        return (
            entry_price - offset if direction == "long" else entry_price + offset
        )

    raise ValueError(f"Stop placement not implemented: {placement}")


def intrabar_stop_hit(bar: pd.Series, trade: Trade) -> bool:
    """True if the bar's high/low range encloses the trade's stop price."""
    if trade.direction == "long":
        return float(bar["low"]) <= trade.stop_price
    return float(bar["high"]) >= trade.stop_price


def apply_options_filters(
    bar: pd.Series, params: StrategyParams
) -> tuple[bool, str | None]:
    """Check if an entry signal survives the options-derived regime filters.

    Returns ``(allowed, skip_reason)``.

    - If `iv_tercile_filter` is set, the bar must have an `iv_tercile`
      column whose value matches. Missing column = filter is a no-op
      (backward-compat with bars that haven't been joined with the
      options_features overlay).
    - If `event_day_filter` is "skip_events", bar is rejected when
      `is_event_day` is True. If "events_only", rejected when False.

    Filters all default to None (pass-through), so a caller who doesn't
    care about options regime gets the v1 backtest behavior unchanged.
    """
    # IV tercile filter
    if params.iv_tercile_filter is not None:
        tercile = bar.get("iv_tercile")
        if tercile is not None and pd.notna(tercile):
            if str(tercile) != params.iv_tercile_filter:
                return (
                    False,
                    f"iv_tercile={tercile} != filter={params.iv_tercile_filter}",
                )

    # Event-day filter
    if params.event_day_filter is not None:
        is_event = bar.get("is_event_day")
        if is_event is not None and pd.notna(is_event):
            is_event_bool = bool(is_event)
            if params.event_day_filter == "skip_events" and is_event_bool:
                return (False, "skip_events: bar is on event day")
            if params.event_day_filter == "events_only" and not is_event_bool:
                return (False, "events_only: bar is not on event day")

    return (True, None)


# ─────────────────────────────────────────────────────────────────────────
# Main event loop
# ─────────────────────────────────────────────────────────────────────────


def run_backtest(
    bars: pd.DataFrame,
    params: StrategyParams,
    *,
    entry_eligible_indices: np.ndarray | None = None,
) -> list[Trade]:
    """Run one backtest over `bars` with `params`. Return closed Trades.

    Expected columns on `bars`:
        ts_event, open, high, low, close, volume
        HighLow, Level_shl (from PAC swing_highs_lows)
        BOS, CHOCH, Level_bc (from PAC bos_choch)
        CHOCHPlus (from PAC structure.tag_choch_plus)

    Preconditions:
    - `bars` is sorted by ts_event ascending.
    - PAC engine has already run — structure columns are populated.

    Optional args:
    - `entry_eligible_indices`: if provided, restricts entry signals to
      bars whose integer position is in this numpy int array. ANDs with
      the session-window mask. Used by the CPCV sweep to restrict
      entries to a specific fold window while ATR + structure detection
      stay continuous across the full bar history (no warmup loss).
      Open trades opened inside the window are still managed to their
      natural exits even if those fall outside the window — matches
      the "embargo" discipline in CPCV.
    """
    required_cols = {
        "ts_event",
        "open",
        "high",
        "low",
        "close",
        "HighLow",
        "Level_shl",
        "BOS",
        "CHOCH",
        "CHOCHPlus",
    }
    missing = required_cols - set(bars.columns)
    if missing:
        raise KeyError(f"run_backtest bars missing required columns: {missing}")

    if len(bars) == 0:
        return []

    # Pre-compute ATR vectorized
    atr_series = compute_atr(bars, period=14).to_numpy()

    # Pre-compute session eligibility mask. If a fold restriction was
    # passed, AND it in — trades only open on bars that satisfy BOTH
    # the session window AND the fold membership.
    eligible = session_window_mask(bars, params.session).to_numpy()
    if entry_eligible_indices is not None:
        fold_mask = np.zeros(len(bars), dtype=np.bool_)
        fold_mask[entry_eligible_indices] = True
        eligible = eligible & fold_mask

    trades: list[Trade] = []
    open_trade: Trade | None = None
    trade_entry_idx: int | None = None

    for i in range(len(bars)):
        bar = bars.iloc[i]
        ts = bar["ts_event"]
        atr_val = float(atr_series[i]) if not pd.isna(atr_series[i]) else 0.0

        # ---- MANAGE OPEN TRADE ----
        if open_trade is not None:
            # 1. Intrabar stop check (highest priority)
            if intrabar_stop_hit(bar, open_trade):
                slice_during = bars.iloc[(trade_entry_idx or 0) + 1 : i + 1]
                open_trade.close(
                    exit_ts=ts,
                    exit_price=open_trade.stop_price,
                    exit_reason="stop_hit",
                    bars_during_trade=slice_during,
                )
                trades.append(open_trade)
                open_trade = None
                trade_entry_idx = None
                continue

            # 2. Exit trigger check (fires at bar close, fills next bar open)
            exit_reason = detect_exit(
                bar, open_trade, params.exit_trigger, atr_val, params
            )
            if exit_reason is not None:
                fill_side = (
                    "exit_long"
                    if open_trade.direction == "long"
                    else "exit_short"
                )
                exit_price = compute_fill_price(bars, i, fill_side, params)
                if exit_price is not None:
                    slice_during = bars.iloc[(trade_entry_idx or 0) + 1 : i + 2]
                    exit_ts = bars.iloc[i + 1]["ts_event"]
                    open_trade.close(
                        exit_ts=exit_ts,
                        exit_price=exit_price,
                        exit_reason=exit_reason,
                        bars_during_trade=slice_during,
                    )
                    trades.append(open_trade)
                    open_trade = None
                    trade_entry_idx = None
                    continue

            # 3. Session-end forced flat — close at THIS bar's close if the
            #    next bar is outside the eligible window.
            if i + 1 < len(bars) and not eligible[i + 1] and eligible[i]:
                slice_during = bars.iloc[(trade_entry_idx or 0) + 1 : i + 1]
                open_trade.close(
                    exit_ts=ts,
                    exit_price=float(bar["close"]),
                    exit_reason="session_end",
                    bars_during_trade=slice_during,
                )
                trades.append(open_trade)
                open_trade = None
                trade_entry_idx = None
                continue

        # ---- LOOK FOR NEW ENTRY ----
        if open_trade is None and eligible[i]:
            entry = detect_entry(bar, params.entry_trigger)
            if entry is not None:
                # Options regime filter check — skips entry without
                # marking the signal as a trade. Keeps filter-rejected
                # signals out of downstream per-setup-tag metrics
                # (no silent overrepresentation of bad filter buckets).
                allowed, _skip_reason = apply_options_filters(bar, params)
                if not allowed:
                    continue

                direction, setup_tag = entry
                fill_side = (
                    "entry_long" if direction == "long" else "entry_short"
                )
                entry_price = compute_fill_price(bars, i, fill_side, params)
                if entry_price is None:
                    continue  # no next bar — skip

                stop_price = compute_stop_price(
                    direction,
                    entry_price,
                    bar,
                    params.stop_placement,
                    atr_val,
                    params,
                )

                # Entry fills at NEXT bar's open — ts becomes next bar's ts
                entry_ts = bars.iloc[i + 1]["ts_event"]
                open_trade = Trade(
                    entry_ts=entry_ts,
                    entry_price=entry_price,
                    direction=direction,
                    stop_price=stop_price,
                    setup_tag=setup_tag,
                    contracts=params.contracts,
                    tick_value_dollars=params.tick_value_dollars,
                    commission_per_rt=params.commission_per_rt,
                )
                trade_entry_idx = i + 1  # the entry bar is the NEXT one

    # If we ended with an open trade (rare — would require data cutoff
    # mid-trade), force-flatten at the last bar's close.
    if open_trade is not None:
        last_bar = bars.iloc[-1]
        slice_during = bars.iloc[(trade_entry_idx or 0) + 1 :]
        open_trade.close(
            exit_ts=last_bar["ts_event"],
            exit_price=float(last_bar["close"]),
            exit_reason="data_end",
            bars_during_trade=slice_during,
        )
        trades.append(open_trade)

    return trades
