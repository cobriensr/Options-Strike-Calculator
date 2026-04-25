"""Shared utilities for the iv_anomaly D/E phase scripts.

Centralizes regime classification, BEST_STRATEGY picking, and PnL
aggregation that were previously duplicated across 8 files with subtle
drift. Also fixes the methodological bug surfaced in the Phase A-E
code review (commit 9c20cb2 follow-up):

   The per-(ticker, date) regime was computed from `first_spot` =
   first ALERT's spot_at_detect, not the actual session-open spot. For
   tickers whose alerts cluster late in the day (NDXP, single-names),
   this systematically biased regime labels toward "less trending"
   buckets. We now derive open/close from `strike_iv_snapshots` over
   the full trading session per (ticker, date), independent of when
   alerts fired.

Constants below MUST stay in sync with `api/_lib/constants.ts` —
the live cross-asset endpoint imports the TS twins of these. If you
tune one, tune the other and re-run the affected ML scripts.
"""
from __future__ import annotations

import warnings
from datetime import datetime
from typing import Iterable

import numpy as np
import pandas as pd

# ── Constants (mirrored from api/_lib/constants.ts Phase F section) ──────

REGIME_THRESHOLDS = {
    "chop": 0.25,
    "mild": 1.0,
    "strong": 2.0,
}
TAPE_WINDOW_MIN = 15
VIX_WINDOW_MIN = 30
LAG_MAX_MIN = 5
DP_AT_STRIKE_BAND_PTS = 5
DP_NEAR_STRIKE_BAND_PTS = 25
DP_BUCKETS = {
    "small": 50_000_000,
    "medium": 200_000_000,
}
EVENT_WINDOW_MIN = 30
VIX_DELTA_THRESHOLD = 0.2

# Picker requires a minimum sample size to compute std reliably and to
# avoid `inf` from a 1-row group with std=0.
BEST_STRATEGY_N_FLOOR = 30
BEST_STRATEGY_MIN_OBSERVATIONS = 5

NON_ORACLE_STRATEGIES = ("pnl_itm_touch", "pnl_eod")


# ── Pandas warning silencer (psycopg2 connections trigger a UserWarning) ──

def silence_pandas_psycopg2_warning() -> None:
    """Suppress the psycopg2/pandas-read_sql_query SQLAlchemy warning.

    Each call prints `UserWarning: pandas only supports SQLAlchemy
    connectable...`. We deliberately keep psycopg2 (lighter, no extra
    dep) — silence the warning at script start.
    """
    warnings.filterwarnings(
        "ignore",
        message="pandas only supports SQLAlchemy connectable",
        category=UserWarning,
    )


# ── Regime classifier ─────────────────────────────────────────────────────


def regime_label(pct_change: float) -> str:
    """Classify a same-day % change into the project's regime taxonomy.

    Mirrors `regimeLabel` in api/iv-anomalies-cross-asset.ts. Thresholds
    live in `REGIME_THRESHOLDS` so re-tuning happens in one place.
    """
    if pct_change is None or not np.isfinite(pct_change):
        return "unknown"
    a = abs(pct_change)
    if a < REGIME_THRESHOLDS["chop"]:
        return "chop"
    direction = "up" if pct_change > 0 else "down"
    if a < REGIME_THRESHOLDS["mild"]:
        return f"mild_trend_{direction}"
    if a < REGIME_THRESHOLDS["strong"]:
        return f"strong_trend_{direction}"
    return f"extreme_{direction}"


# ── Session-bounded daily regime (the bugfix) ─────────────────────────────

REGIME_LABELS_PARQUET = "ml/data/iv-anomaly-regime-labels-2026-04-25.parquet"


def load_session_regime_labels() -> pd.DataFrame:
    """Read the cached regime-labels parquet built by `build-regime-labels.py`.

    Raises FileNotFoundError with an actionable message if the parquet
    is stale/missing — that means the user needs to re-run the builder
    after a data backfill.
    """
    from pathlib import Path

    p = Path(__file__).resolve().parents[1] / REGIME_LABELS_PARQUET
    if not p.exists():
        raise FileNotFoundError(
            f"{p} missing. Run `ml/.venv/bin/python ml/build-regime-labels.py` "
            "first to refresh from strike_iv_snapshots."
        )
    df = pd.read_parquet(p)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def fetch_session_regime_labels(conn, tickers: Iterable[str]) -> pd.DataFrame:
    """Compute per-(ticker, date) regime from full trading-session bounds.

    Pulls the EARLIEST and LATEST `strike_iv_snapshots.spot` per
    (ticker, calendar-date-in-CT) regardless of which compound key
    generated the snapshot. This is the "true session" version that the
    code review flagged: alert-clustering bias is removed because we no
    longer anchor `first_spot` on the first ALERT's `spot_at_detect`.

    Returns DataFrame with columns: ticker, date, open_spot, close_spot,
    pct_change, regime.
    """
    silence_pandas_psycopg2_warning()
    sql = """
    SELECT
        ticker,
        TO_CHAR((ts AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') AS date,
        (ARRAY_AGG(spot ORDER BY ts ASC))[1] AS open_spot,
        (ARRAY_AGG(spot ORDER BY ts DESC))[1] AS close_spot
    FROM strike_iv_snapshots
    WHERE ticker = ANY(%(tickers)s)
    GROUP BY ticker, (ts AT TIME ZONE 'America/Chicago')::date
    """
    df = pd.read_sql_query(sql, conn, params={"tickers": list(tickers)})
    df["open_spot"] = df["open_spot"].astype(float)
    df["close_spot"] = df["close_spot"].astype(float)
    mask = (df["open_spot"] > 0) & np.isfinite(df["open_spot"])
    df["pct_change"] = np.where(
        mask,
        (df["close_spot"] - df["open_spot"]) / df["open_spot"] * 100.0,
        np.nan,
    )
    df["regime"] = df["pct_change"].apply(regime_label)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def attach_regime(df: pd.DataFrame, session_labels: pd.DataFrame) -> pd.DataFrame:
    """Left-join session-derived regime labels onto an alerts DataFrame.

    Requires `df` to have a `ticker` column and either `date` (already)
    or `alert_ts` (we'll derive). Mutates a copy.
    """
    out = df.copy()
    if "date" not in out.columns:
        if "alert_ct" not in out.columns:
            out["alert_ct"] = pd.to_datetime(out["alert_ts"], utc=True).dt.tz_convert("US/Central")
        out["date"] = out["alert_ct"].dt.date
    return out.merge(
        session_labels[["ticker", "date", "regime", "pct_change"]],
        on=["ticker", "date"],
        how="left",
    )


# ── BEST_STRATEGY picker (single source of truth) ────────────────────────


def _sharpe_score(series: pd.Series) -> float:
    """Mean-over-std of a numeric series, with guards against pathological inputs.

    Returns `-inf` when the series is too small or has zero std (a
    1-row group has std=NaN; a constant-valued group has std=0). Both
    cases would otherwise yield `inf`/NaN and hijack `max()`.
    """
    col = series.dropna()
    if len(col) < BEST_STRATEGY_MIN_OBSERVATIONS:
        return -np.inf
    std = col.std()
    if std is None or pd.isna(std) or std <= 0:
        return -np.inf
    return float(col.mean() / std)


def pick_best_strategy_per_ticker_regime(df: pd.DataFrame) -> dict:
    """Pick best non-oracle strategy per (ticker, regime).

    Falls back to ticker-level pick when the (ticker, regime) cell has
    fewer than `BEST_STRATEGY_N_FLOOR` rows. Replaces the 6+ ad-hoc
    re-implementations across D/E scripts that had subtle drift.
    """
    ticker_level: dict[str, str] = {}
    for ticker, sub in df.groupby("ticker"):
        scores = {s: _sharpe_score(sub[s]) for s in NON_ORACLE_STRATEGIES}
        ticker_level[ticker] = max(scores, key=scores.get)

    best: dict[tuple[str, str], str] = {}
    for (ticker, regime), sub in df.groupby(["ticker", "regime"]):
        if len(sub) >= BEST_STRATEGY_N_FLOOR:
            scores = {s: _sharpe_score(sub[s]) for s in NON_ORACLE_STRATEGIES}
            picked = max(scores, key=scores.get)
            # If both scores are -inf (no usable data), fall back.
            best[(ticker, regime)] = picked if scores[picked] > -np.inf else ticker_level[ticker]
        else:
            best[(ticker, regime)] = ticker_level[ticker]
    return best


def apply_best_strategy(df: pd.DataFrame, best_map: dict) -> pd.DataFrame:
    """Add `best_strategy`, `best_pnl_pct`, `entry_dollars`, `best_dollar` columns.

    `entry_premium` must be present (from the backtest parquet).
    """
    out = df.copy()
    out["best_strategy"] = out.apply(
        lambda r: best_map.get((r["ticker"], r["regime"]), "pnl_eod"), axis=1
    )
    out["best_pnl_pct"] = out.apply(
        lambda r: r[r["best_strategy"]] if pd.notna(r[r["best_strategy"]]) else np.nan,
        axis=1,
    )
    out["entry_dollars"] = out["entry_premium"].astype(float) * 100.0
    out["best_dollar"] = out["entry_dollars"] * out["best_pnl_pct"]
    return out


# ── PnL aggregation (DRY) ────────────────────────────────────────────────


def aggregate_pnl(df: pd.DataFrame, group_cols: list[str]) -> pd.DataFrame:
    """Standard PnL aggregation: n, win%, mean%, mean$, median$.

    Drops rows with NaN `best_pnl_pct` so empty-group counts don't
    silently inflate `n`.
    """
    sub = df.dropna(subset=["best_pnl_pct"])
    g = sub.groupby(group_cols, dropna=False).agg(
        n=("anomaly_id", "count"),
        win_pct=("best_pnl_pct", lambda x: float((x > 0).mean() * 100)),
        mean_pct=("best_pnl_pct", "mean"),
        mean_dollar=("best_dollar", "mean"),
        median_dollar=("best_dollar", "median"),
    )
    return g.round(2)


# ── JSON serialization (no `default=str` masking) ────────────────────────


def to_jsonable(obj):
    """Convert pandas/numpy types to JSON-native equivalents.

    Replaces the `default=str` fallback that silently stringified
    `np.int64` and `pd.Timestamp` instances. Now those convert
    explicitly; anything else raises `TypeError` at dump time so future
    serialization bugs surface immediately.
    """
    import datetime as _dt

    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj) if np.isfinite(obj) else None
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    if isinstance(obj, (_dt.date, _dt.datetime)):
        return obj.isoformat()
    raise TypeError(f"to_jsonable: unsupported type {type(obj).__name__}")
