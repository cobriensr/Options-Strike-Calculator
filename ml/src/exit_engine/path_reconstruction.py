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
    df["nbbo_bid"] = pd.to_numeric(df["nbbo_bid"], errors="coerce").astype("float64")
    df["nbbo_ask"] = pd.to_numeric(df["nbbo_ask"], errors="coerce").astype("float64")
    df["minute"] = df["executed_at"].dt.floor("min")
    df["mid"] = (df["nbbo_bid"] + df["nbbo_ask"]) / 2.0
    df["spread"] = df["nbbo_ask"] - df["nbbo_bid"]
    _GREEK_NUM = ["implied_volatility", "delta", "gamma", "underlying_price", "strike"]
    has_greeks = all(c in df.columns for c in ["implied_volatility", "delta", "gamma", "underlying_price"])
    for c in _GREEK_NUM:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce").astype("float64")
    agg = dict(
        mid=("mid", "last"), spread=("spread", "last"),
        bid=("nbbo_bid", "last"), ask=("nbbo_ask", "last"),
    )
    if has_greeks:
        agg["implied_volatility"] = ("implied_volatility", "last")
        agg["delta"] = ("delta", "last")
        agg["gamma"] = ("gamma", "last")
        agg["underlying_price"] = ("underlying_price", "last")
    if "strike" in df.columns:
        agg["strike"] = ("strike", "first")
    if "option_type" in df.columns:
        agg["option_type"] = ("option_type", "first")
    grouped = df.groupby("minute", observed=True).agg(**agg).reset_index()
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
