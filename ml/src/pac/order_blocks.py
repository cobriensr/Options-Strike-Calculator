"""Order-block enrichment on top of `smartmoneyconcepts.smc.ob()`.

Upstream `smc.ob()` already emits per-OB volume (`OBVolume`) and volume-
share percentage (`Percentage`) — the "volumetric" half of LuxAlgo's
Volumetric Order Blocks. What's missing is the z-score positioning of
the OB relative to current session VWAP ± 1σ, which is how the manual
journal CSV expresses OB extensiveness (columns `Z OB Top`, `Z OB
Bottom`, `Z OB Mid`).

This module provides:

1. `session_vwap_and_std(df)` — per-bar cumulative session VWAP and
   cumulative session std, both reset at the UTC day boundary. These
   are the reference statistics that z-scores are normalized against.

2. `enrich_ob_with_z(df, ob, stats)` — add z-score columns to `ob`
   output computed at OB formation time (the bar where the OB fires).

3. `z_at_timestamp(ob_row, stats_at_t)` — compute z-scores at any
   timestamp (used when evaluating an entry that may occur *after* OB
   formation). This is the semantics of the manual journal CSV: the
   z-score was the OB's position relative to VWAP *at entry time*, not
   at formation time.

Session boundary is the UTC calendar day to match the DuckDB archive
loader's TimeZone pin. For CME products, that boundary falls at 00:00
UTC which is during Asia session — not ideal for RTH-only analysis,
but consistent, and RTH backtests can filter to the relevant window.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def session_vwap_and_std(df: pd.DataFrame) -> pd.DataFrame:
    """Compute per-bar cumulative session VWAP and std, reset at UTC day.

    Parameters
    ----------
    df:
        Bar DataFrame with columns `ts_event`, `high`, `low`, `close`,
        `volume`. Timestamps must be UTC-aware (as produced by
        `archive_loader.load_bars()`).

    Returns
    -------
    DataFrame with columns:
        ts_event, session_vwap, session_std

    `session_vwap` is `sum(typical_price * volume) / sum(volume)` taken
    cumulatively within each UTC calendar day, where typical_price is
    `(high + low + close) / 3`. `session_std` is the cumulative standard
    deviation of typical prices within the same session, minimum 1
    observation returns 0 std (not NaN) to keep downstream z-score math
    safe from division-by-NaN.
    """
    required = {"ts_event", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise KeyError(f"Missing required columns: {sorted(missing)}")

    out = df[["ts_event"]].copy()
    tp = (df["high"] + df["low"] + df["close"]) / 3.0
    vol = df["volume"].astype(float)
    session = df["ts_event"].dt.floor("D")

    # Cumulative (price*vol) and (vol) per session
    pv = tp * vol
    grp = session
    cum_pv = pv.groupby(grp).cumsum()
    cum_vol = vol.groupby(grp).cumsum()

    # Guard against a bar with zero volume at session start — carry VWAP
    # forward rather than emit NaN. In practice CME 1m bars always have
    # volume > 0 during the globex session, so this is belt-and-suspenders.
    with np.errstate(divide="ignore", invalid="ignore"):
        vwap = np.where(cum_vol > 0, cum_pv / cum_vol, np.nan)
    out["session_vwap"] = pd.Series(vwap, index=df.index).ffill()

    # Cumulative std of typical prices per session. `expanding().std()`
    # returns NaN for the first observation (std of 1 value is undefined);
    # we coerce that to 0 so z-scores are well-defined from bar 1.
    out["session_std"] = (
        tp.groupby(grp).expanding().std().reset_index(level=0, drop=True)
    )
    out["session_std"] = out["session_std"].fillna(0.0)

    return out


def enrich_ob_with_z(
    df: pd.DataFrame,
    ob: pd.DataFrame,
    stats: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Add OB z-score columns at OB formation time.

    Parameters
    ----------
    df:
        The source bar DataFrame (used for computing session stats if
        `stats` is None).
    ob:
        Output of `smc.ob()`. Expected columns: `OB`, `Top`, `Bottom`,
        `OBVolume`, `MitigatedIndex`, `Percentage`.
    stats:
        Optional pre-computed output of `session_vwap_and_std(df)`. If
        None, computed inline. Passed in when the caller already needs
        the per-bar stats for other features (saves one group-by).

    Returns
    -------
    Copy of `ob` with added columns:
        OB_mid    : (Top + Bottom) / 2, convenience pre-computation
        OB_width  : Top - Bottom
        OB_z_top  : (Top - session_vwap) / session_std at OB formation
        OB_z_bot  : (Bottom - session_vwap) / session_std at OB formation
        OB_z_mid  : (Mid - session_vwap) / session_std at OB formation

    Rows where no OB is active at that bar get NaN for all z columns.
    """
    if stats is None:
        stats = session_vwap_and_std(df)
    if len(stats) != len(ob):
        raise ValueError(
            f"Stats len {len(stats)} != ob len {len(ob)}; must align on the same bars"
        )

    enriched = ob.copy()
    top = enriched["Top"].to_numpy(dtype=float)
    bot = enriched["Bottom"].to_numpy(dtype=float)
    vwap = stats["session_vwap"].to_numpy(dtype=float)
    std = stats["session_std"].to_numpy(dtype=float)
    ob_active = enriched["OB"].to_numpy()

    mid = (top + bot) / 2.0
    width = top - bot

    # z = (price - vwap) / std; guard against std == 0 (very early in session)
    # by emitting NaN so callers don't mistake "no spread" for "at VWAP".
    with np.errstate(divide="ignore", invalid="ignore"):
        z_top = np.where(std > 0, (top - vwap) / std, np.nan)
        z_bot = np.where(std > 0, (bot - vwap) / std, np.nan)
        z_mid = np.where(std > 0, (mid - vwap) / std, np.nan)

    # Only fill the z columns on bars where an OB is actually active —
    # on other bars Top/Bottom are NaN anyway, so z would be NaN.
    has_ob = ~np.isnan(ob_active) & (ob_active != 0)
    z_top = np.where(has_ob, z_top, np.nan)
    z_bot = np.where(has_ob, z_bot, np.nan)
    z_mid = np.where(has_ob, z_mid, np.nan)
    mid = np.where(has_ob, mid, np.nan)
    width = np.where(has_ob, width, np.nan)

    enriched["OB_mid"] = mid
    enriched["OB_width"] = width
    enriched["OB_z_top"] = z_top
    enriched["OB_z_bot"] = z_bot
    enriched["OB_z_mid"] = z_mid

    return enriched


def z_at_timestamp(
    price: float,
    session_vwap: float,
    session_std: float,
) -> float:
    """Convenience: z-score of a single price against a single VWAP/std pair.

    Used at entry time to compute `Z OB Top` / `Z OB Mid` values that
    match the manual journal CSV semantics — the OB's position relative
    to VWAP at the moment of entry, not at OB formation.

    Returns NaN if `session_std <= 0` (undefined very early in session).
    """
    if session_std is None or session_std <= 0 or np.isnan(session_std):
        return float("nan")
    return (price - session_vwap) / session_std
