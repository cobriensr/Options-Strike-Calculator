"""Per-bar options features overlay.

Orchestrator that produces one row per bar joining:
- VIX family daily closes + vx_ratio (forward-filled to intraday bars)
- Calendar event flags (OPEX, FOMC, is_event_day)

The output joins onto PAC engine output via `(ts_event,)`. All features in
this module are daily-cadence scalars — intraday options-derived features
(IV, straddle cone, max-pain distance) are deferred to E1.2b and will be
added by a separate module that joins on the same key.

Design note: kept intentionally thin. The overlay is a data-plumbing
layer, not a feature-engineering layer. Computations live in the leaf
modules (`vix.py`, `calendar.py`); `overlay.py` just joins them to the
caller's bar DataFrame.
"""

from __future__ import annotations

import pandas as pd

from options_features.calendar import calendar_features
from options_features.vix import load_vix_daily


def options_features_for_bars(
    bars: pd.DataFrame,
    *,
    refresh_vix: bool = False,
) -> pd.DataFrame:
    """Return a per-bar options features DataFrame aligned to `bars`.

    Parameters
    ----------
    bars:
        Bar DataFrame with at least `ts_event` (UTC-aware). Typically the
        output of `pac.archive_loader.load_bars()`.
    refresh_vix:
        Force yfinance re-pull for VIX family even if cache is fresh. Used
        by tests to verify the pull path when needed.

    Returns
    -------
    DataFrame with columns (and length matching `bars`):
        ts_event         : UTC bar timestamp (unchanged from input)
        day              : UTC calendar date derived from ts_event
        vix              : VIX daily close, forward-filled
        vix9d            : VIX9D daily close, forward-filled
        vix1d            : VIX1D daily close, forward-filled (NaN pre-2023)
        vvix             : VVIX daily close, forward-filled
        vx_ratio         : vix / vix9d, forward-filled
        is_opex          : bool, monthly OPEX flag
        is_quarterly_opex: bool, quarterly OPEX flag
        is_fomc          : bool, FOMC decision day flag
        is_event_day     : bool, OR of is_opex + is_fomc

    Forward-fill policy: the daily VIX close is the prior-day close carried
    forward to every bar of the following session, since intraday VIX moves
    continuously and the daily close is the most recent confirmed value.
    Weekend / holiday days get the last available close (pandas ffill).
    """
    if "ts_event" not in bars.columns:
        raise KeyError("bars must have 'ts_event' column")
    if len(bars) == 0:
        # Return an empty frame with expected columns so callers can
        # pd.concat / merge without special-casing
        return pd.DataFrame(
            columns=[
                "ts_event",
                "day",
                "vix",
                "vix9d",
                "vix1d",
                "vvix",
                "vx_ratio",
                "is_opex",
                "is_quarterly_opex",
                "is_fomc",
                "is_event_day",
            ]
        )

    out = bars[["ts_event"]].copy()
    out["day"] = out["ts_event"].dt.tz_convert("UTC").dt.date

    # VIX family: pull all days covering the bar range, then forward-fill
    # to the per-bar dates. Request a wider window than strictly needed so
    # the first bars of the window don't end up NaN because yfinance hasn't
    # reported that day's close yet.
    unique_days = sorted(out["day"].unique())
    first_day = unique_days[0]
    last_day = unique_days[-1]
    # Widen the window by ~10 trading days on the lower end to ensure we
    # have a prior close to forward-fill from on the first bar's date.
    vix_start = (pd.Timestamp(first_day) - pd.Timedelta(days=14)).strftime("%Y-%m-%d")
    vix_end = (pd.Timestamp(last_day) + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    vix_df = load_vix_daily(start=vix_start, end=vix_end, refresh=refresh_vix)

    # Build a calendar of ALL dates in the bar range (including weekends /
    # holidays) so forward-fill has a continuous index to walk.
    all_days = pd.date_range(first_day, last_day, freq="D").date
    vix_by_day = (
        pd.DataFrame({"day": all_days})
        .merge(vix_df, on="day", how="left")
        .sort_values("day")
        .ffill()
    )
    out = out.merge(vix_by_day, on="day", how="left")

    # Calendar flags per bar
    cal = calendar_features(unique_days)
    out = out.merge(cal, on="day", how="left")

    return out
