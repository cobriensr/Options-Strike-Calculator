"""Reconstruct a fire's per-minute executable-mid path from the parquet tape.

Single-session path mirrors exit_simulation.build_minute_prices but is
entry-anchored (minutes_since_entry) and post-entry only. The multi-day
assembler concatenates per-day frames for mode-B holds.
"""
from __future__ import annotations

import pandas as pd

_CANCELED_TRUTHY = [True, "t", "true", "True"]


def build_minute_path(
    trades: pd.DataFrame, entry_ts: pd.Timestamp, entry_price: float
) -> pd.DataFrame:
    """Per-minute mid/spread from one day's trades for a single chain.

    Returns columns: minute, mid, spread, bid, ask, minutes_since_entry.
    Keeps minutes at or after the entry minute only.
    """
    if trades.empty or entry_price <= 0:
        return pd.DataFrame()
    df = trades[~trades["canceled"].isin(_CANCELED_TRUTHY)].copy()
    if df.empty:
        return pd.DataFrame()
    df["minute"] = df["executed_at"].dt.floor("min")
    df["mid"] = (df["nbbo_bid"] + df["nbbo_ask"]) / 2.0
    df["spread"] = df["nbbo_ask"] - df["nbbo_bid"]
    grouped = (
        df.groupby("minute", observed=True)
        .agg(mid=("mid", "last"), spread=("spread", "last"),
             bid=("nbbo_bid", "last"), ask=("nbbo_ask", "last"))
        .reset_index()
    )
    grouped = grouped[grouped["mid"] > 0].reset_index(drop=True)
    entry_minute = entry_ts.floor("min")
    grouped = grouped[grouped["minute"] >= entry_minute].reset_index(drop=True)
    if grouped.empty:
        return grouped
    grouped["minutes_since_entry"] = (
        (grouped["minute"] - entry_minute).dt.total_seconds() / 60.0
    )
    return grouped


def assemble_multiday_path(
    day_frames: list[pd.DataFrame], entry_ts: pd.Timestamp, entry_price: float
) -> pd.DataFrame:
    """Concatenate ordered per-day trade frames into one entry-anchored path.

    minutes_since_entry is wall-clock from entry across sessions (overnight gaps
    are real elapsed minutes -- the EOD carry model, not this function, decides
    whether to hold across them)."""
    parts = [
        build_minute_path(d, entry_ts, entry_price) for d in day_frames if not d.empty
    ]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame()
    out = pd.concat(parts, ignore_index=True).sort_values("minute").reset_index(drop=True)
    entry_minute = entry_ts.floor("min")
    out["minutes_since_entry"] = (out["minute"] - entry_minute).dt.total_seconds() / 60.0
    return out
