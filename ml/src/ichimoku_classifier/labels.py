"""Ichimoku-native label generators — three traditional strategies.

Replaces the PAC-style fixed ±1.5R bracket from
`pac_classifier.labels` with stops / targets / exits derived from the
Ichimoku indicator state itself. Three preset strategies are
provided, each modeling a canonical Ichimoku trading approach:

## Strategies

### `STRATEGY_KIJUN_STOP_2R`  (most common discretionary setup)

- **Stop:** Kijun line at the entry bar.
  - Long: stop = `kijun_26[entry_bar]`. Skipped (no_data) if Kijun >=
    entry_close (Kijun on the wrong side — trading against trend).
  - Short: symmetric — stop = `kijun_26[entry_bar]`, skip if Kijun <=
    entry_close.
- **Target:** entry ± 2 × stop_distance (2R reward:risk).
- **Exit:** first-touch (stop or target), stop wins on tie.
- **Timeout:** 48 bars (4h on 5m, same as PAC).

### `STRATEGY_CLOUD_STOP_2R`  (cloud-as-support/resistance)

- **Stop:** far cloud edge at entry bar.
  - Long: stop = `cloud_bottom[entry_bar]`. Skipped if `cloud_bottom`
    is undefined or >= entry_close.
  - Short: symmetric — stop = `cloud_top[entry_bar]`, skip if >=
    entry_close.
- **Target:** entry ± 2 × stop_distance (same R-multiple as A).
- **Exit:** first-touch.

### `STRATEGY_TK_REVERSAL_EXIT`  (trend-following, no fixed target)

- **Stop:** Kijun line at entry (same as A).
- **No fixed target** — trades exit on a reversal signal rather than
  an R-multiple. Exit triggers, in priority order on each bar:
    1. Stop hit (price touches Kijun against direction).
    2. Opposite TK cross (the `BOS` column in enriched flips to the
       opposite sign of the entry direction).
    3. Close re-crosses Kijun in the wrong direction (close < Kijun
       for a long, close > Kijun for a short).
- **Timeout:** 96 bars (extended — let trends play out).

## label_a interpretation under each strategy

For A and B (fixed-target strategies), label_a follows the standard
PAC convention: 1.0 = target hit, 0.0 = stop hit, NaN = timeout.

For C (reversal-exit), label_a is "did this trade exit profitably?"
— 1.0 if realized_R > 0 at exit (reversal-with-profit OR clean
target-equivalent), 0.0 if realized_R < 0 at exit (stop hit OR
reversal-with-loss), NaN only if the trade timed out without any
exit trigger firing.

`exit_reason` is the most direct way to tell which behavior fired —
"stop", "target", "tk_reversal", "kijun_recross", "timeout", or
"no_data".

## Required `enriched` columns

The labeler reads from the IchimokuEngine's enriched DataFrame:

    high, low, close                — for stop/target intrabar checks
    kijun_26                        — for Kijun stops (A, C)
    cloud_top, cloud_bottom         — for cloud stops (B)
    BOS                             — for TK-reversal exit (C)

Missing columns produce `no_data` rather than crashing.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from pac_classifier.labels import (
    DEFAULT_RETURN_HORIZON_BARS_1M,
    DEFAULT_RETURN_HORIZON_BARS_5M,
    DEFAULT_TIMEOUT_BARS_5M,
    LabelResult,
)

# ---------------------------------------------------------------------------
# Strategy spec
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StrategySpec:
    """Configuration for one Ichimoku labeling strategy.

    Attributes
    ----------
    name : str
        Human-readable identifier ("kijun_stop_2r", "cloud_stop_2r",
        "tk_reversal_exit"). Surfaced in dataset filenames + findings.
    stop_mode : {"kijun", "cloud"}
        Where the initial stop comes from.
    target_mode : {"r_multiple", "none"}
        "r_multiple" → fixed multiple of stop distance.
        "none" → no target; trade exits only on stop or reversal.
    target_r_mult : float
        Target = entry ± target_r_mult × stop_distance. Ignored when
        target_mode = "none".
    exit_on_tk_reversal : bool
        Exit when the BOS column at a forward bar flips against the
        entry direction. Used by Strategy C.
    exit_on_kijun_recross : bool
        Exit when close re-crosses Kijun in the wrong direction. Used
        by Strategy C.
    timeout_bars : int
        Max bars to walk forward before forcing exit at close.
    skip_if_stop_on_wrong_side : bool
        If True (default), trades where the stop level is on the
        wrong side of entry (e.g. long with Kijun > entry) emit
        `no_data` rather than the trade. Matches traditional Ichimoku
        usage — you don't take longs against bearish Ichimoku.
    """

    name: str
    stop_mode: str
    target_mode: str
    target_r_mult: float = 2.0
    exit_on_tk_reversal: bool = False
    exit_on_kijun_recross: bool = False
    timeout_bars: int = DEFAULT_TIMEOUT_BARS_5M
    skip_if_stop_on_wrong_side: bool = True

    # ---- Variant knobs (added 2026-04-25 to push Strategy C profitability) ----

    # Ratchet the stop with the Kijun line in the trade's favor (only).
    # Long: stop_price = max(current_stop, kijun[i]) when kijun > stop.
    # Short: stop_price = min(current_stop, kijun[i]) when kijun < stop.
    # Never moves against the trade. Lets winners run while still
    # protecting accumulated profit. Only applies when stop_mode="kijun".
    use_trailing_stop: bool = False

    # Win threshold in R units. Default 0.0 = "any positive realized_R
    # is a win" (the original Strategy C behavior). Setting > 0 raises
    # the bar — e.g. 0.5 means label_a=1 only if realized_R > +0.5R.
    # Stop hits and timeouts are unaffected (stop = always 0, timeout =
    # always NaN).
    win_threshold_r: float = 0.0


# Canonical preset strategies — the three "passes" the user asked for.
STRATEGY_KIJUN_STOP_2R = StrategySpec(
    name="kijun_stop_2r",
    stop_mode="kijun",
    target_mode="r_multiple",
    target_r_mult=2.0,
)

STRATEGY_CLOUD_STOP_2R = StrategySpec(
    name="cloud_stop_2r",
    stop_mode="cloud",
    target_mode="r_multiple",
    target_r_mult=2.0,
)

STRATEGY_TK_REVERSAL_EXIT = StrategySpec(
    name="tk_reversal_exit",
    stop_mode="kijun",
    target_mode="none",
    exit_on_tk_reversal=True,
    exit_on_kijun_recross=True,
    timeout_bars=DEFAULT_TIMEOUT_BARS_5M * 2,  # let trends play out longer
)

# ---- Strategy C variants — push profitability ----

# Variant 1: Trailing Kijun stop. Lets winners run further by ratcheting
# the stop forward. Same exit triggers, same labeling rule.
STRATEGY_TK_REV_TRAILING = StrategySpec(
    name="tk_rev_trailing",
    stop_mode="kijun",
    target_mode="none",
    exit_on_tk_reversal=True,
    exit_on_kijun_recross=True,
    timeout_bars=DEFAULT_TIMEOUT_BARS_5M * 2,
    use_trailing_stop=True,
)

# Variant 2: Higher win threshold. Same static stop, same exit triggers,
# but label_a=1 only when realized_R > +0.5R. Forces the model to learn
# "predict big winners" specifically.
STRATEGY_TK_REV_THRESH_05 = StrategySpec(
    name="tk_rev_thresh_05",
    stop_mode="kijun",
    target_mode="none",
    exit_on_tk_reversal=True,
    exit_on_kijun_recross=True,
    timeout_bars=DEFAULT_TIMEOUT_BARS_5M * 2,
    win_threshold_r=0.5,
)

# Variant 3: Combined — trailing stop + 0.5R win threshold. Best of both.
STRATEGY_TK_REV_COMBINED = StrategySpec(
    name="tk_rev_combined",
    stop_mode="kijun",
    target_mode="none",
    exit_on_tk_reversal=True,
    exit_on_kijun_recross=True,
    timeout_bars=DEFAULT_TIMEOUT_BARS_5M * 2,
    use_trailing_stop=True,
    win_threshold_r=0.5,
)


# Map name → spec for CLI lookup.
PRESET_STRATEGIES: dict[str, StrategySpec] = {
    s.name: s
    for s in (
        STRATEGY_KIJUN_STOP_2R,
        STRATEGY_CLOUD_STOP_2R,
        STRATEGY_TK_REVERSAL_EXIT,
        STRATEGY_TK_REV_TRAILING,
        STRATEGY_TK_REV_THRESH_05,
        STRATEGY_TK_REV_COMBINED,
    )
}


# ---------------------------------------------------------------------------
# Single-event labeler
# ---------------------------------------------------------------------------


def _resolve_stop_price(
    enriched: pd.DataFrame,
    event_bar_idx: int,
    direction: str,
    entry_price: float,
    spec: StrategySpec,
) -> float | None:
    """Return the initial stop price per `spec.stop_mode`, or None if
    the stop level is unavailable / on the wrong side of entry.

    None → caller emits `no_data`.
    """
    bar = enriched.iloc[event_bar_idx]
    if spec.stop_mode == "kijun":
        kijun = bar.get("kijun_26", float("nan"))
        if not np.isfinite(kijun):
            return None
        if direction == "up":
            if kijun >= entry_price:
                return None if spec.skip_if_stop_on_wrong_side else float(entry_price * 0.999)
            return float(kijun)
        # short
        if kijun <= entry_price:
            return None if spec.skip_if_stop_on_wrong_side else float(entry_price * 1.001)
        return float(kijun)

    if spec.stop_mode == "cloud":
        if direction == "up":
            cloud_bottom = bar.get("cloud_bottom", float("nan"))
            if not np.isfinite(cloud_bottom) or cloud_bottom >= entry_price:
                return None if spec.skip_if_stop_on_wrong_side else float(entry_price * 0.999)
            return float(cloud_bottom)
        # short
        cloud_top = bar.get("cloud_top", float("nan"))
        if not np.isfinite(cloud_top) or cloud_top <= entry_price:
            return None if spec.skip_if_stop_on_wrong_side else float(entry_price * 1.001)
        return float(cloud_top)

    raise ValueError(f"unsupported stop_mode: {spec.stop_mode!r}")


def label_ichimoku_event(
    enriched: pd.DataFrame,
    event_bar_idx: int,
    direction: str,
    spec: StrategySpec,
    *,
    return_horizon_bars: int = DEFAULT_RETURN_HORIZON_BARS_5M,
    tick_value_dollars: float = 5.0,
) -> LabelResult:
    """Compute Label A + Label B for one Ichimoku event under `spec`.

    Walks forward from `event_bar_idx + 1`, applying spec-defined
    stop / target / reversal-exit logic. Mirrors the bar-walk semantics
    of `pac_classifier.labels.label_event` (intrabar checks, stop wins
    on tie).
    """
    if direction not in {"up", "dn"}:
        raise ValueError(f"direction must be 'up' or 'dn', got {direction!r}")

    n = len(enriched)
    if event_bar_idx < 0 or event_bar_idx >= n - 1:
        return _no_data_result()

    entry_price = float(enriched.iloc[event_bar_idx]["close"])
    stop_price = _resolve_stop_price(enriched, event_bar_idx, direction, entry_price, spec)
    if stop_price is None:
        return _no_data_result()

    stop_distance = abs(entry_price - stop_price)
    if stop_distance <= 0:
        return _no_data_result()

    # Target
    target_price: float | None
    if spec.target_mode == "r_multiple":
        if direction == "up":
            target_price = entry_price + spec.target_r_mult * stop_distance
        else:
            target_price = entry_price - spec.target_r_mult * stop_distance
    elif spec.target_mode == "none":
        target_price = None
    else:
        raise ValueError(f"unsupported target_mode: {spec.target_mode!r}")

    end_walk = min(event_bar_idx + 1 + spec.timeout_bars, n)
    highs = enriched["high"].to_numpy(dtype=np.float64)
    lows = enriched["low"].to_numpy(dtype=np.float64)
    closes = enriched["close"].to_numpy(dtype=np.float64)
    bos = (
        enriched["BOS"].to_numpy(dtype=np.float64, na_value=np.nan)
        if "BOS" in enriched.columns
        else np.full(n, np.nan, dtype=np.float64)
    )
    kijun = (
        enriched["kijun_26"].to_numpy(dtype=np.float64, na_value=np.nan)
        if "kijun_26" in enriched.columns
        else np.full(n, np.nan, dtype=np.float64)
    )
    entry_dir_sign = 1.0 if direction == "up" else -1.0

    label_a = float("nan")
    exit_reason = "timeout"
    bars_to_exit = end_walk - (event_bar_idx + 1)
    realized_r = float("nan")

    win_threshold = spec.win_threshold_r
    use_trailing = spec.use_trailing_stop and spec.stop_mode == "kijun"

    for i in range(event_bar_idx + 1, end_walk):
        bar_high = highs[i]
        bar_low = lows[i]

        # 1. Stop hit (priority — same as PAC convention)
        if direction == "up":
            stop_hit = bar_low <= stop_price
        else:
            stop_hit = bar_high >= stop_price
        if stop_hit:
            label_a = 0.0
            exit_reason = "stop"
            bars_to_exit = i - event_bar_idx
            # Trailing stops can lock in profit before reversing — if the
            # stop has ratcheted past entry, exit value is the (now
            # favorable) stop level, not entry. Otherwise it's a -1R loss.
            if use_trailing:
                signed_pnl = (stop_price - entry_price) * entry_dir_sign
                realized_r = signed_pnl / stop_distance
                # Reclassify per win threshold
                label_a = 1.0 if realized_r > win_threshold else 0.0
            else:
                realized_r = -1.0
            break

        # 2. Target hit (only if target_price defined)
        if target_price is not None:
            if direction == "up":
                target_hit = bar_high >= target_price
            else:
                target_hit = bar_low <= target_price
            if target_hit:
                exit_reason = "target"
                bars_to_exit = i - event_bar_idx
                realized_r = spec.target_r_mult
                label_a = 1.0 if realized_r > win_threshold else 0.0
                break

        # 3. TK-reversal exit (Strategy C)
        if spec.exit_on_tk_reversal and np.isfinite(bos[i]):
            # An opposite TK cross at this bar — sign opposite to entry
            if (entry_dir_sign > 0 and bos[i] < 0) or (entry_dir_sign < 0 and bos[i] > 0):
                exit_close = closes[i]
                signed_pnl = (exit_close - entry_price) * entry_dir_sign
                realized_r = signed_pnl / stop_distance
                label_a = 1.0 if realized_r > win_threshold else 0.0
                exit_reason = "tk_reversal"
                bars_to_exit = i - event_bar_idx
                break

        # 4. Close re-crosses Kijun against direction (Strategy C)
        if spec.exit_on_kijun_recross and np.isfinite(kijun[i]):
            close_i = closes[i]
            wrong_side = (direction == "up" and close_i < kijun[i]) or (
                direction == "dn" and close_i > kijun[i]
            )
            if wrong_side:
                signed_pnl = (close_i - entry_price) * entry_dir_sign
                realized_r = signed_pnl / stop_distance
                label_a = 1.0 if realized_r > win_threshold else 0.0
                exit_reason = "kijun_recross"
                bars_to_exit = i - event_bar_idx
                break

        # 5. Ratchet trailing stop — only AFTER all exit checks fired,
        # so the stop check at bar i used the prior bar's value. Update
        # only if Kijun has moved favorably since.
        if use_trailing and np.isfinite(kijun[i]):
            if direction == "up" and kijun[i] > stop_price:
                stop_price = float(kijun[i])
            elif direction == "dn" and kijun[i] < stop_price:
                stop_price = float(kijun[i])

    # Timeout: emit signed forward fraction of R, label_a = NaN.
    if exit_reason == "timeout" and end_walk > event_bar_idx + 1:
        last_close = closes[end_walk - 1]
        realized_r = ((last_close - entry_price) * entry_dir_sign) / stop_distance

    # Label B — signed forward return (independent of exit logic)
    horizon_idx = event_bar_idx + return_horizon_bars
    if horizon_idx < n:
        horizon_close = closes[horizon_idx]
        forward_return_dollars = (horizon_close - entry_price) * entry_dir_sign * tick_value_dollars
    else:
        forward_return_dollars = float("nan")

    return LabelResult(
        label_a=label_a,
        exit_reason=exit_reason,
        bars_to_exit=int(bars_to_exit),
        realized_R=float(realized_r),
        forward_return_dollars=float(forward_return_dollars),
    )


def _no_data_result() -> LabelResult:
    return LabelResult(
        label_a=float("nan"),
        exit_reason="no_data",
        bars_to_exit=0,
        realized_R=float("nan"),
        forward_return_dollars=float("nan"),
    )


# ---------------------------------------------------------------------------
# Batch labeler
# ---------------------------------------------------------------------------


def label_ichimoku_events(
    enriched: pd.DataFrame,
    events: pd.DataFrame,
    spec: StrategySpec,
    *,
    timeframe: str = "5m",
    tick_value_dollars: float = 5.0,
) -> pd.DataFrame:
    """Apply `label_ichimoku_event` across every event row.

    The output schema matches `pac_classifier.labels.label_events` so
    `pac_classifier.dataset.build_dataset`'s downstream merge logic
    works unchanged when this is dropped in.
    """
    if timeframe == "5m":
        return_horizon_bars = DEFAULT_RETURN_HORIZON_BARS_5M
    elif timeframe == "1m":
        return_horizon_bars = DEFAULT_RETURN_HORIZON_BARS_1M
    else:
        raise ValueError(f"Unsupported timeframe {timeframe!r}; expected '1m' or '5m'.")

    out_rows: list[dict] = []
    for _, evt in events.iterrows():
        result = label_ichimoku_event(
            enriched,
            event_bar_idx=int(evt["bar_idx"]),
            direction=str(evt["signal_direction"]),
            spec=spec,
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
