"""
Loaders for the `flow_alerts` table.

Exports two functions used by `flow_eda.py` and any downstream ML code
that wants per-alert rows with optional forward-return outcomes joined
from `spx_candles_1m`.

Usage:
    from load_flow_alerts import (
        load_flow_alerts,
        load_flow_alerts_with_outcomes,
    )
    df = load_flow_alerts()
    df_out = load_flow_alerts_with_outcomes(forward_minutes=(5, 15, 30))

Both functions degrade gracefully: they return an empty DataFrame when
the underlying table has no rows yet (cron is expected to start
populating it tomorrow; backfill lands separately).
"""

from __future__ import annotations

import sys

try:
    import numpy as np
    import pandas as pd
    from sqlalchemy import create_engine
except ImportError:
    print("Missing dependencies. Run:")
    print("  ml/.venv/bin/pip install pandas numpy sqlalchemy psycopg2-binary")
    sys.exit(1)

from utils import load_env  # noqa: E402

# ── Column typing ───────────────────────────────────────────

_NUMERIC_COLUMNS: tuple[str, ...] = (
    "strike",
    "price",
    "underlying_price",
    "bid",
    "ask",
    "iv_start",
    "iv_end",
    "total_premium",
    "total_ask_side_prem",
    "total_bid_side_prem",
    "volume_oi_ratio",
    "ask_side_ratio",
    "bid_side_ratio",
    "net_premium",
    "distance_from_spot",
    "distance_pct",
    "moneyness",
)

_INT_COLUMNS: tuple[str, ...] = (
    "total_size",
    "trade_count",
    "expiry_count",
    "volume",
    "open_interest",
    "dte_at_alert",
    "minute_of_day",
    "session_elapsed_min",
    "day_of_week",
)

_BOOL_COLUMNS: tuple[str, ...] = (
    "has_sweep",
    "has_floor",
    "has_multileg",
    "has_singleleg",
    "all_opening_trades",
    "is_itm",
)

_TIMESTAMP_COLUMNS: tuple[str, ...] = (
    "created_at",
    "start_time",
    "end_time",
    "ingested_at",
)


# ── Low-level helpers ───────────────────────────────────────


def _engine():
    """Build a short-lived SQLAlchemy engine from DATABASE_URL."""
    env = load_env()
    database_url = env.get("DATABASE_URL", "")
    if not database_url:
        print("Error: DATABASE_URL not found in .env")
        sys.exit(1)
    return create_engine(database_url)


def _coerce_types(df: pd.DataFrame) -> pd.DataFrame:
    """Coerce DB rows to numeric/bool/timestamp types in-place-safe way."""
    if df.empty:
        return df

    for col in _NUMERIC_COLUMNS:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    for col in _INT_COLUMNS:
        if col in df.columns:
            # Use nullable Int64 so we keep NaN rather than silently
            # casting to 0 when the DB returned NULL.
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")

    for col in _BOOL_COLUMNS:
        if col in df.columns:
            df[col] = df[col].astype("boolean")

    for col in _TIMESTAMP_COLUMNS:
        if col in df.columns:
            df[col] = pd.to_datetime(df[col], utc=True, errors="coerce")

    return df


# ── Public loaders ──────────────────────────────────────────


def load_flow_alerts() -> pd.DataFrame:
    """Load all rows from `flow_alerts`, parsed into typed columns.

    Returns an empty DataFrame (with no columns guaranteed) when the
    table is empty or unreachable — callers must handle `df.empty`.
    """
    engine = _engine()
    try:
        df = pd.read_sql_query(
            "SELECT * FROM flow_alerts ORDER BY created_at ASC",
            engine,
        )
    except Exception as e:
        print(f"Error: flow_alerts query failed: {e}")
        return pd.DataFrame()
    finally:
        engine.dispose()

    return _coerce_types(df)


def _load_spx_1m_closes(start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    """Load SPX 1-min closes covering [start, end] (UTC)."""
    engine = _engine()
    try:
        df = pd.read_sql_query(
            """
            SELECT timestamp, close
            FROM spx_candles_1m
            WHERE timestamp BETWEEN %(start)s AND %(end)s
            ORDER BY timestamp ASC
            """,
            engine,
            params={"start": start.to_pydatetime(), "end": end.to_pydatetime()},
        )
    except Exception as e:
        print(f"Warning: spx_candles_1m query failed: {e}")
        return pd.DataFrame(columns=["timestamp", "close"])
    finally:
        engine.dispose()

    if df.empty:
        return df

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df["close"] = pd.to_numeric(df["close"], errors="coerce")
    return df.dropna(subset=["timestamp", "close"]).sort_values("timestamp")


def attach_forward_returns(
    alerts: pd.DataFrame,
    candles: pd.DataFrame,
    forward_minutes: tuple[int, ...] = (5, 15, 30),
    tolerance_seconds: int = 90,
) -> pd.DataFrame:
    """Compute signed decimal forward returns for each alert.

    Uses pd.merge_asof to find the nearest SPX 1-min close within
    `tolerance_seconds` of the alert `created_at` (the base price),
    then again for each `created_at + h minutes` target.

    Args:
      alerts: output of load_flow_alerts() (must have `created_at` col)
      candles: output of _load_spx_1m_closes() (must have
               `timestamp`, `close`)
      forward_minutes: horizons in minutes
      tolerance_seconds: merge_asof tolerance. 90s comfortably covers
                         the 60s bar cadence plus clock skew.

    Adds columns: `base_price`, and `ret_fwd_{h}` for each h. Returns a
    new DataFrame (does not mutate `alerts`).
    """
    out = alerts.copy()
    if out.empty or candles.empty:
        for h in forward_minutes:
            out[f"ret_fwd_{h}"] = np.nan
        return out

    candles_sorted = candles[["timestamp", "close"]].sort_values("timestamp")

    # Base price: nearest candle at or just before the alert.
    base = pd.merge_asof(
        out[["created_at"]].sort_values("created_at").reset_index(),
        candles_sorted,
        left_on="created_at",
        right_on="timestamp",
        direction="backward",
        tolerance=pd.Timedelta(seconds=tolerance_seconds),
    )
    base = base.rename(columns={"close": "base_price"}).set_index("index")
    out["base_price"] = base["base_price"]

    # Forward prices at each horizon.
    for h in forward_minutes:
        target_col = f"_target_{h}"
        out[target_col] = out["created_at"] + pd.Timedelta(minutes=h)
        fwd = pd.merge_asof(
            out[[target_col]].sort_values(target_col).reset_index(),
            candles_sorted,
            left_on=target_col,
            right_on="timestamp",
            direction="nearest",
            tolerance=pd.Timedelta(seconds=tolerance_seconds),
        )
        fwd = fwd.rename(columns={"close": f"_fwd_{h}"}).set_index("index")
        out[f"_fwd_{h}"] = fwd[f"_fwd_{h}"]
        base_price = out["base_price"]
        fwd_price = out[f"_fwd_{h}"]
        out[f"ret_fwd_{h}"] = (fwd_price - base_price) / base_price

        out = out.drop(columns=[target_col, f"_fwd_{h}"])

    return out


def load_flow_alerts_with_outcomes(
    forward_minutes: tuple[int, ...] = (5, 15, 30),
) -> pd.DataFrame:
    """Load flow_alerts joined with SPX 1-min closes to compute
    forward returns at the given horizons.

    Adds columns: `base_price`, `ret_fwd_{h}` for each h in
    `forward_minutes`. Returns NaN for any horizon where a post-alert
    candle is missing within ±90s tolerance.
    """
    alerts = load_flow_alerts()
    if alerts.empty:
        return alerts

    max_horizon = max(forward_minutes) if forward_minutes else 0
    start = alerts["created_at"].min() - pd.Timedelta(minutes=5)
    end = alerts["created_at"].max() + pd.Timedelta(minutes=max_horizon + 5)
    candles = _load_spx_1m_closes(start, end)

    return attach_forward_returns(alerts, candles, forward_minutes)
