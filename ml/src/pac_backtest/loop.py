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
    EntryVsOb,
    ExitTrigger,
    OnOppositeSignal,
    SessionBucket,
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
    active_ob: dict | None = None,
) -> float:
    """Place the protective stop based on StopPlacement rule.

    `active_ob` is required for `OB_BOUNDARY` placement and is the dict
    returned by `_find_active_ob_at()`. If unavailable, falls back to N_ATR.
    """
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

    if placement == StopPlacement.OB_BOUNDARY:
        if active_ob is not None:
            # Long stop = OB bottom (price falls to support — break that, fail)
            # Short stop = OB top (price rises to resistance — break that, fail)
            candidate = (
                active_ob["bottom"] if direction == "long" else active_ob["top"]
            )
            # Guard: if the OB is on the wrong side of entry, the stop would
            # fire instantly. A live trader would never use that OB — they'd
            # use a different reference. Fall back to N_ATR.
            on_correct_side = (
                (direction == "long" and candidate < entry_price)
                or (direction == "short" and candidate > entry_price)
            )
            if on_correct_side:
                return candidate
        # No active OB or wrong-side OB: fall back to N_ATR
        offset = atr * params.stop_atr_multiple
        return (
            entry_price - offset if direction == "long" else entry_price + offset
        )

    raise ValueError(f"Stop placement not implemented: {placement}")


def intrabar_stop_hit(bar: pd.Series, trade: Trade) -> bool:
    """True if the bar's high/low range encloses the trade's stop price."""
    if trade.direction == "long":
        return float(bar["low"]) <= trade.stop_price
    return float(bar["high"]) >= trade.stop_price


def _find_active_ob_at(bars: pd.DataFrame, signal_idx: int) -> dict | None:
    """Walk backward from `signal_idx` to find the most-recent active OB.

    "Active" means: an OB whose MitigatedIndex is either NaN or > signal_idx
    (not yet mitigated as of the signal bar). Returns a dict with top, bottom,
    mid, direction; None if no active OB exists.
    """
    if "OB" not in bars.columns:
        return None
    ob_col = bars["OB"].to_numpy()
    top_col = bars["OB_Top"].to_numpy() if "OB_Top" in bars.columns else None
    bot_col = bars["OB_Bottom"].to_numpy() if "OB_Bottom" in bars.columns else None
    mit_col = (
        bars["OB_MitigatedIndex"].to_numpy()
        if "OB_MitigatedIndex" in bars.columns
        else None
    )
    if top_col is None or bot_col is None:
        return None
    for i in range(signal_idx, -1, -1):
        ob_val = ob_col[i]
        if pd.isna(ob_val) or ob_val == 0:
            continue
        if mit_col is not None:
            mit = mit_col[i]
            if pd.notna(mit) and mit != 0 and mit <= signal_idx:
                continue
        top = float(top_col[i])
        bot = float(bot_col[i])
        return {
            "top": top,
            "bottom": bot,
            "mid": (top + bot) / 2.0,
            "direction": "bullish" if ob_val == 1 else "bearish",
            "bar_idx": i,
        }
    return None


def apply_v4_entry_filters(
    bar: pd.Series,
    direction: str,
    params: StrategyParams,
    active_ob: dict | None,
    entry_price: float,
) -> tuple[bool, str | None]:
    """Entry-quality filters added in E1.4d v4. Each filter defaults to OFF.

    Returns ``(allowed, skip_reason)``.
    """
    # Session-bucket filter
    if params.session_bucket != SessionBucket.ANY:
        sb = bar.get("session_bucket")
        if sb is None or pd.isna(sb) or str(sb) != params.session_bucket.value:
            return (False, f"session_bucket={sb} != {params.session_bucket.value}")

    # ADX threshold
    if params.min_adx_14 is not None:
        adx = bar.get("adx_14")
        if adx is None or pd.isna(adx) or float(adx) < params.min_adx_14:
            return (False, f"adx_14={adx} < {params.min_adx_14}")

    # OB volume z threshold
    if params.min_ob_volume_z is not None:
        z = bar.get("ob_volume_z_50")
        if z is None or pd.isna(z) or float(z) < params.min_ob_volume_z:
            return (False, f"ob_volume_z_50={z} < {params.min_ob_volume_z}")

    # OB %ATR threshold
    if params.min_ob_pct_atr is not None:
        pct = bar.get("ob_pct_atr")
        if pct is None or pd.isna(pct) or float(pct) < params.min_ob_pct_atr:
            return (False, f"ob_pct_atr={pct} < {params.min_ob_pct_atr}")

    # VWAP z-score on the trade's side: long requires close > VWAP by N std,
    # short requires close < VWAP by N std.
    if params.min_z_entry_vwap is not None:
        z = bar.get("z_close_vwap")
        if z is None or pd.isna(z):
            return (False, "z_close_vwap unavailable")
        zf = float(z)
        if direction == "long" and zf < params.min_z_entry_vwap:
            return (False, f"z_close_vwap={zf} < +{params.min_z_entry_vwap}")
        if direction == "short" and zf > -params.min_z_entry_vwap:
            return (False, f"z_close_vwap={zf} > -{params.min_z_entry_vwap}")

    # Entry-vs-OB filter — requires an active OB to evaluate
    if params.entry_vs_ob != EntryVsOb.ANY:
        if active_ob is None:
            return (False, "entry_vs_ob filter set but no active OB")
        if params.entry_vs_ob == EntryVsOb.ABOVE_OB_MID and entry_price <= active_ob["mid"]:
            return (False, f"entry {entry_price} not > OB mid {active_ob['mid']}")
        if params.entry_vs_ob == EntryVsOb.BELOW_OB_MID and entry_price >= active_ob["mid"]:
            return (False, f"entry {entry_price} not < OB mid {active_ob['mid']}")
        if params.entry_vs_ob == EntryVsOb.INSIDE_OB and not (
            active_ob["bottom"] <= entry_price <= active_ob["top"]
        ):
            return (False, f"entry {entry_price} not in OB [{active_ob['bottom']}, {active_ob['top']}]")

    return (True, None)


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
# Entry-bar context snapshot (E1.4d Phase 2)
# ─────────────────────────────────────────────────────────────────────────


# Columns we capture into Trade.entry_features at signal time. Each is
# only set if present on the bar — older bar frames missing columns
# silently produce a partial snapshot rather than crashing.
_ENTRY_FEATURE_COLUMNS = (
    "session_bucket",
    "minutes_from_rth_open",
    "minutes_to_rth_close",
    "atr_14",
    "adx_14",
    "di_plus_14",
    "di_minus_14",
    "z_close_vwap",
    "ob_pct_atr",
    "ob_volume_z_50",
    "OB_z_top",
    "OB_z_bot",
    "OB_z_mid",
    "OB_width",
    "OBVolume",
    "session_vwap",
    "session_std",
    "is_fomc",
    "is_opex",
    "is_event_day",
)


def _snapshot_entry_features(bar: pd.Series) -> dict:
    """Build the entry-features dict from a single signal bar.

    Coerces numpy scalar / pandas timestamp types to plain Python so the
    dict round-trips cleanly through JSON serialization downstream.
    """
    snap: dict = {}
    for col in _ENTRY_FEATURE_COLUMNS:
        if col not in bar.index:
            continue
        v = bar[col]
        if pd.isna(v):
            snap[col] = None
        elif isinstance(v, (np.bool_, bool)):
            snap[col] = bool(v)
        elif isinstance(v, (np.integer,)):
            snap[col] = int(v)
        elif isinstance(v, (np.floating, float)):
            snap[col] = float(v)
        else:
            snap[col] = v if isinstance(v, str) else str(v)
    return snap


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
    bos_count_since_entry: int = 0  # E1.4d: incremented on same-dir BOS post-entry

    for i in range(len(bars)):
        bar = bars.iloc[i]
        ts = bar["ts_event"]
        atr_val = float(atr_series[i]) if not pd.isna(atr_series[i]) else 0.0

        # Detect entry-signal-on-this-bar once. Reused for both opposite-signal
        # handling (when in a trade) and new-entry logic (when flat).
        new_entry = detect_entry(bar, params.entry_trigger)

        # If EXIT_ONLY fires this bar, we close the trade but must NOT open
        # a new one on the same bar — the trader is "stepping aside", not flipping.
        skip_entry_this_bar = False

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
                bos_count_since_entry = 0
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
                    bos_count_since_entry = 0
                    continue

            # 3. BoS-count exit (E1.4d) — close after N same-dir BOS post-entry.
            if params.exit_after_n_bos is not None and open_trade is not None:
                bos_val = bar.get("BOS")
                if pd.notna(bos_val) and bos_val != 0:
                    same_dir = (
                        (open_trade.direction == "long" and bos_val == 1)
                        or (open_trade.direction == "short" and bos_val == -1)
                    )
                    if same_dir:
                        bos_count_since_entry += 1
                        if bos_count_since_entry >= params.exit_after_n_bos:
                            fill_side = (
                                "exit_long"
                                if open_trade.direction == "long"
                                else "exit_short"
                            )
                            exit_price = compute_fill_price(
                                bars, i, fill_side, params
                            )
                            if exit_price is not None:
                                slice_during = bars.iloc[
                                    (trade_entry_idx or 0) + 1 : i + 2
                                ]
                                exit_ts = bars.iloc[i + 1]["ts_event"]
                                open_trade.close(
                                    exit_ts=exit_ts,
                                    exit_price=exit_price,
                                    exit_reason=f"exit_after_{params.exit_after_n_bos}_bos",
                                    bars_during_trade=slice_during,
                                )
                                trades.append(open_trade)
                                open_trade = None
                                trade_entry_idx = None
                                bos_count_since_entry = 0
                                continue

            # 4. Opposite-signal handling (E1.4d)
            if open_trade is not None and new_entry is not None:
                new_dir, _ = new_entry
                if new_dir != open_trade.direction:
                    rule = params.on_opposite_signal
                    if rule == OnOppositeSignal.HOLD_AND_SKIP:
                        pass  # ignore the signal; do not enter on this bar either
                        skip_entry_this_bar = True
                    elif rule == OnOppositeSignal.HOLD_AND_TIGHTEN:
                        # Move stop to entry price (breakeven); skip new entry
                        open_trade.stop_price = open_trade.entry_price
                        skip_entry_this_bar = True
                    elif rule in (OnOppositeSignal.EXIT_ONLY, OnOppositeSignal.EXIT_AND_FLIP):
                        fill_side = (
                            "exit_long"
                            if open_trade.direction == "long"
                            else "exit_short"
                        )
                        exit_price = compute_fill_price(
                            bars, i, fill_side, params
                        )
                        if exit_price is not None:
                            slice_during = bars.iloc[
                                (trade_entry_idx or 0) + 1 : i + 2
                            ]
                            exit_ts = bars.iloc[i + 1]["ts_event"]
                            open_trade.close(
                                exit_ts=exit_ts,
                                exit_price=exit_price,
                                exit_reason="opposite_signal",
                                bars_during_trade=slice_during,
                            )
                            trades.append(open_trade)
                            open_trade = None
                            trade_entry_idx = None
                            bos_count_since_entry = 0
                            # EXIT_AND_FLIP falls through to entry block this
                            # iteration (open_trade is now None), letting
                            # detect_entry's opposite-direction signal open
                            # the flip. EXIT_ONLY blocks the entry instead.
                            if rule == OnOppositeSignal.EXIT_ONLY:
                                skip_entry_this_bar = True

            # 5. Session-end forced flat — close at THIS bar's close if the
            #    next bar is outside the eligible window.
            if open_trade is not None and i + 1 < len(bars) and not eligible[i + 1] and eligible[i]:
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
                bos_count_since_entry = 0
                continue

        # ---- LOOK FOR NEW ENTRY ----
        if (
            open_trade is None
            and eligible[i]
            and not skip_entry_this_bar
            and new_entry is not None
        ):
            # Options regime filter check — skips entry without
            # marking the signal as a trade. Keeps filter-rejected
            # signals out of downstream per-setup-tag metrics.
            allowed, _skip_reason = apply_options_filters(bar, params)
            if not allowed:
                continue

            direction, setup_tag = new_entry
            fill_side = (
                "entry_long" if direction == "long" else "entry_short"
            )
            entry_price = compute_fill_price(bars, i, fill_side, params)
            if entry_price is None:
                continue  # no next bar — skip

            # Find the most-recent active OB at signal time. Used both for
            # entry_vs_ob filter AND for OB_BOUNDARY stop placement.
            active_ob = _find_active_ob_at(bars, i)

            # E1.4d v4 entry-quality filters
            allowed_v4, _v4_reason = apply_v4_entry_filters(
                bar, direction, params, active_ob, entry_price
            )
            if not allowed_v4:
                continue

            stop_price = compute_stop_price(
                direction,
                entry_price,
                bar,
                params.stop_placement,
                atr_val,
                params,
                active_ob=active_ob,
            )

            # Entry fills at NEXT bar's open — ts becomes next bar's ts
            entry_ts = bars.iloc[i + 1]["ts_event"]
            # Snapshot the signal-bar context features (what the trader
            # saw when deciding to enter, before the next-bar fill).
            entry_features = _snapshot_entry_features(bar)
            open_trade = Trade(
                entry_ts=entry_ts,
                entry_price=entry_price,
                direction=direction,
                stop_price=stop_price,
                setup_tag=setup_tag,
                contracts=params.contracts,
                tick_value_dollars=params.tick_value_dollars,
                commission_per_rt=params.commission_per_rt,
                entry_features=entry_features,
            )
            trade_entry_idx = i + 1  # the entry bar is the NEXT one
            bos_count_since_entry = 0

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
