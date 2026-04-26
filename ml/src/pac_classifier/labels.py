"""Simulate +1.5R / -1R outcomes per PAC event for the binary classifier
plus a signed forward-return label for the regression target.

Per `pac-event-classifier-2026-04-24.md`:

- **Label A** (binary): walk bars forward from `event_bar_idx + 1`. R
  is defined as `stop_R_atr * atr_14_at_event` (default 1.5×ATR
  = a "1R" stop distance — matches the backtest's default
  stop_atr_multiple). Target is `target_R_multiple × R` = 1.5R from a
  1R stop, so target_distance = 1.5 × stop_distance. Exit on first
  hit; if both stop and target hit on the same bar, stop wins
  (matches `pac_backtest/loop.py`'s priority). After `timeout_bars`,
  exit at bar close. Returns: 1 (win, target hit), 0 (loss, stop
  hit), NaN (timeout — no clean outcome to label).

- **Label B** (regression): signed P/L over a fixed forward horizon
  in bars (default 30 minutes worth — 30 bars on 1m, 6 bars on 5m).
  Computed regardless of stop/target outcomes — used to predict raw
  directional impulse rather than discrete trade outcome.

Conservative defaults match the backtest:
- intrabar tie-break: stop wins on the same bar
- entry fill = bar's close at the event ts (no slippage modeled here;
  slippage/cost gets layered in at metric-evaluation time, not at
  label-generation time, so the labels stay model-friendly)
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Defaults align with the spec's canonical numbers. Override per-call
# only when running ablation studies — otherwise downstream features
# will get inconsistent labels.
DEFAULT_STOP_ATR_MULT = 1.5  # = 1R distance in ATR units
DEFAULT_TARGET_R_MULT = 1.5  # = 1.5R target (= 2.25 × ATR)
DEFAULT_TIMEOUT_BARS_5M = 48  # 4 hours of 5m bars
DEFAULT_TIMEOUT_BARS_1M = 240  # 4 hours of 1m bars
DEFAULT_RETURN_HORIZON_BARS_5M = 6  # 30 minutes of 5m bars
DEFAULT_RETURN_HORIZON_BARS_1M = 30  # 30 minutes of 1m bars


@dataclass(frozen=True)
class LabelResult:
    """Per-event outcome under both label schemes."""

    label_a: float  # 1.0 (win), 0.0 (loss), NaN (timeout)
    exit_reason: str  # "target" | "stop" | "timeout" | "no_data"
    bars_to_exit: int  # how many bars from event to exit
    realized_R: float  # signed return in R units; +1.5 = full target, -1 = stop
    forward_return_dollars: float  # raw P&L over the fixed horizon (Label B)


def label_event(
    bars: pd.DataFrame,
    event_bar_idx: int,
    direction: str,
    atr_at_event: float,
    *,
    stop_atr_mult: float = DEFAULT_STOP_ATR_MULT,
    target_r_mult: float = DEFAULT_TARGET_R_MULT,
    timeout_bars: int = DEFAULT_TIMEOUT_BARS_5M,
    return_horizon_bars: int = DEFAULT_RETURN_HORIZON_BARS_5M,
    tick_value_dollars: float = 5.0,  # NQ default; MNQ = 0.50
) -> LabelResult:
    """Compute Label A + Label B for one event.

    Parameters
    ----------
    bars:
        Full OHLC DataFrame. Must contain ``high``, ``low``, ``close``
        columns.
    event_bar_idx:
        Positional index of the event bar in `bars`.
    direction:
        "up" → simulate long, "dn" → simulate short.
    atr_at_event:
        atr_14 value at the event bar; used to size stop / target.
    """
    if direction not in {"up", "dn"}:
        raise ValueError(f"direction must be 'up' or 'dn', got {direction!r}")

    n = len(bars)
    if event_bar_idx < 0 or event_bar_idx >= n - 1:
        # Need at least one bar after the event to walk into. Edge case
        # at the right boundary of the dataset.
        return LabelResult(
            label_a=float("nan"),
            exit_reason="no_data",
            bars_to_exit=0,
            realized_R=float("nan"),
            forward_return_dollars=float("nan"),
        )

    if not np.isfinite(atr_at_event) or atr_at_event <= 0:
        # Can't size R if ATR is missing or zero (very early in session
        # before the EWMA warmup completes).
        return LabelResult(
            label_a=float("nan"),
            exit_reason="no_data",
            bars_to_exit=0,
            realized_R=float("nan"),
            forward_return_dollars=float("nan"),
        )

    entry_price = float(bars.iloc[event_bar_idx]["close"])
    stop_distance = stop_atr_mult * atr_at_event  # = 1R
    target_distance = target_r_mult * stop_distance  # = target_r_mult × R

    if direction == "up":
        stop_price = entry_price - stop_distance
        target_price = entry_price + target_distance
    else:
        stop_price = entry_price + stop_distance
        target_price = entry_price - target_distance

    # Walk forward from event_bar_idx + 1 (don't trade on the event
    # bar itself — its close is our entry, anything intrabar AFTER
    # entry is on the next bar).
    end_walk = min(event_bar_idx + 1 + timeout_bars, n)
    highs = bars["high"].to_numpy(dtype=np.float64)
    lows = bars["low"].to_numpy(dtype=np.float64)
    closes = bars["close"].to_numpy(dtype=np.float64)

    label_a = float("nan")
    exit_reason = "timeout"
    bars_to_exit = end_walk - (event_bar_idx + 1)
    realized_R = float("nan")

    for i in range(event_bar_idx + 1, end_walk):
        bar_high = highs[i]
        bar_low = lows[i]

        if direction == "up":
            stop_hit = bar_low <= stop_price
            target_hit = bar_high >= target_price
        else:
            stop_hit = bar_high >= stop_price
            target_hit = bar_low <= target_price

        # Tie-break: stop wins on a bar where both are hit. Matches
        # pac_backtest/loop.py's intrabar priority (stop check fires
        # before target/exit-trigger logic).
        if stop_hit:
            label_a = 0.0
            exit_reason = "stop"
            bars_to_exit = i - event_bar_idx
            realized_R = -1.0
            break
        if target_hit:
            label_a = 1.0
            exit_reason = "target"
            bars_to_exit = i - event_bar_idx
            realized_R = target_r_mult  # = +1.5 by default
            break

    # Timeout: emit NaN for label_a (per the spec — clean outcome not
    # observable). For realized_R we still want a number so the
    # regression target downstream has data, so we close at the
    # last-walked bar's close.
    if exit_reason == "timeout" and end_walk > event_bar_idx + 1:
        last_close = closes[end_walk - 1]
        if direction == "up":
            realized = (last_close - entry_price) / stop_distance
        else:
            realized = (entry_price - last_close) / stop_distance
        realized_R = float(realized)

    # Label B — signed forward-return at fixed horizon. Independent of
    # stop/target outcomes.
    horizon_idx = event_bar_idx + return_horizon_bars
    if horizon_idx < n:
        horizon_close = closes[horizon_idx]
        if direction == "up":
            forward_return_dollars = (horizon_close - entry_price) * tick_value_dollars
        else:
            forward_return_dollars = (entry_price - horizon_close) * tick_value_dollars
    else:
        forward_return_dollars = float("nan")

    return LabelResult(
        label_a=label_a,
        exit_reason=exit_reason,
        bars_to_exit=int(bars_to_exit),
        realized_R=float(realized_R),
        forward_return_dollars=float(forward_return_dollars),
    )


def label_events(
    bars: pd.DataFrame,
    events: pd.DataFrame,
    *,
    timeframe: str = "5m",
    stop_atr_mult: float = DEFAULT_STOP_ATR_MULT,
    target_r_mult: float = DEFAULT_TARGET_R_MULT,
    tick_value_dollars: float = 5.0,
) -> pd.DataFrame:
    """Apply `label_event` across an entire events DataFrame.

    Convenience wrapper that picks sensible bar-count defaults from
    `timeframe` and emits a labels DataFrame indexed positionally with
    the input events. Input columns expected: `bar_idx`,
    `signal_direction`, `atr_14` (i.e., the schema returned by
    `pac_classifier.events.extract_events`).
    """
    if timeframe == "5m":
        timeout_bars = DEFAULT_TIMEOUT_BARS_5M
        return_horizon_bars = DEFAULT_RETURN_HORIZON_BARS_5M
    elif timeframe == "1m":
        timeout_bars = DEFAULT_TIMEOUT_BARS_1M
        return_horizon_bars = DEFAULT_RETURN_HORIZON_BARS_1M
    else:
        raise ValueError(f"Unsupported timeframe {timeframe!r}; expected '1m' or '5m'.")

    out_rows: list[dict] = []
    for _, evt in events.iterrows():
        result = label_event(
            bars,
            event_bar_idx=int(evt["bar_idx"]),
            direction=str(evt["signal_direction"]),
            atr_at_event=float(evt["atr_14"]) if pd.notna(evt["atr_14"]) else float("nan"),
            stop_atr_mult=stop_atr_mult,
            target_r_mult=target_r_mult,
            timeout_bars=timeout_bars,
            return_horizon_bars=return_horizon_bars,
            tick_value_dollars=tick_value_dollars,
        )
        out_rows.append(
            {
                "bar_idx": int(evt["bar_idx"]),
                "label_a": result.label_a,
                "exit_reason": result.exit_reason,
                "bars_to_exit": result.bars_to_exit,
                "realized_R": result.realized_R,
                "forward_return_dollars": result.forward_return_dollars,
            }
        )

    if not out_rows:
        return pd.DataFrame(
            {
                "bar_idx": pd.Series([], dtype=np.int64),
                "label_a": pd.Series([], dtype=np.float64),
                "exit_reason": pd.Series([], dtype=object),
                "bars_to_exit": pd.Series([], dtype=np.int64),
                "realized_R": pd.Series([], dtype=np.float64),
                "forward_return_dollars": pd.Series([], dtype=np.float64),
            }
        )
    return pd.DataFrame(out_rows)
