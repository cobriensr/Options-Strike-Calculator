"""Daily VIX family series (VIX, VIX9D, VIX1D, VVIX) with parquet cache.

Matches the pattern in `ml/src/moc_regime_vix.py`: pulls from yfinance,
caches to a single parquet file, re-pulls only when the cache is stale.
Adds the VIX/VIX9D ratio as a term-structure signal — ratio > 1 means
short-term vol is above 9-day vol (contango = normal), ratio < 1 means
short-term vol has spiked above 9-day (backwardation = stress).

Caller responsibility: join these daily scalars to 1m bars via
`overlay.options_features_for_bars()`.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

try:
    import yfinance as yf
except ImportError as e:
    raise ImportError(
        "yfinance required for VIX data pull. Install via "
        "`ml/.venv/bin/pip install yfinance`."
    ) from e


# Cache lives alongside other ml/data/ artifacts. Matches `moc_regime_vix.py`
# convention so both modules can share the same cache file if we ever
# consolidate.
_CACHE_PATH = Path(__file__).resolve().parents[3] / "data" / "vix_family_daily.parquet"

# Yahoo tickers for each VIX variant. ^VIX1D was introduced in April 2023,
# so its history is short. Callers should handle NaN for older dates.
_TICKERS = {
    "vix": "^VIX",
    "vix9d": "^VIX9D",
    "vix1d": "^VIX1D",
    "vvix": "^VVIX",
}


def _pull_fresh(start: str, end: str | None = None) -> pd.DataFrame:
    """Fetch all VIX family series from yfinance. No caching logic."""
    frames: list[pd.DataFrame] = []
    for col, ticker in _TICKERS.items():
        ser = yf.download(
            ticker,
            start=start,
            end=end,
            progress=False,
            auto_adjust=False,
        )["Close"]
        # yfinance returns DataFrame if multiple tickers; since we request
        # one at a time here the Close is a Series. Normalize.
        if isinstance(ser, pd.DataFrame):
            ser = ser.squeeze("columns")
        frames.append(ser.rename(col))
    merged = pd.concat(frames, axis=1)
    merged.index = merged.index.tz_localize(None)  # strip tz for date-only storage
    merged.index.name = "day"
    return merged.reset_index()


def load_vix_daily(
    start: str = "2010-01-01",
    end: str | None = None,
    *,
    refresh: bool = False,
) -> pd.DataFrame:
    """Load VIX/VIX9D/VIX1D/VVIX daily closes, with parquet cache.

    Parameters
    ----------
    start:
        Earliest calendar day requested (ISO date).
    end:
        Latest calendar day (exclusive, ISO) or None for today.
    refresh:
        If True, re-pull everything even if the cache is fresh. Used when
        a test or debug session suspects stale data.

    Returns
    -------
    DataFrame with columns `day, vix, vix9d, vix1d, vvix, vx_ratio` where
    `vx_ratio = vix / vix9d` (NaN if vix9d is NaN or zero).

    Cache behavior: if the cache covers the requested range, read it. If
    it's missing the tail, re-pull fresh (yfinance lacks incremental append).
    """
    need_pull = refresh or not _CACHE_PATH.exists()
    if not need_pull:
        cached = pd.read_parquet(_CACHE_PATH)
        cached_end = pd.Timestamp(cached["day"].max()).date()
        requested_end = (
            pd.Timestamp(end).date() if end else pd.Timestamp.today().date()
        )
        # Tolerate up to 1 missing trading day before triggering a re-pull.
        # Avoids refresh thrash on weekends / holidays.
        if (requested_end - cached_end).days > 1:
            need_pull = True

    if need_pull:
        fresh = _pull_fresh(start=start, end=end)
        _CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        fresh.to_parquet(_CACHE_PATH, index=False)
        df = fresh
    else:
        df = pd.read_parquet(_CACHE_PATH)

    # Filter to the requested range
    df = df[df["day"] >= pd.Timestamp(start)]
    if end is not None:
        df = df[df["day"] < pd.Timestamp(end)]

    # Compute vx_ratio, safe against zero or NaN vix9d
    ratio = df["vix"] / df["vix9d"].where(df["vix9d"] > 0)
    df = df.assign(vx_ratio=ratio).reset_index(drop=True)

    # Normalize day to date object so downstream joins are type-consistent
    df["day"] = pd.to_datetime(df["day"]).dt.date
    return df
