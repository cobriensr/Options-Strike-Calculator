"""Microstructure feature engineering over the local TBBO Parquet archive.

Phase 4c of the max-leverage-Databento-UW roadmap. Produces one row per
``(date, symbol)`` pair with ~20 microstructure features covering order-flow
imbalance (OFI), spread widening, top-of-book (TOB) pressure persistence, and
tick velocity. Features are computed on the **front-month** contract for each
date (top-volume contract), matching the pattern in
``sidecar/src/archive_query.py``.

Design:

- **DuckDB over pandas.** The archive is 3.9 GB / 210M rows. DuckDB reads the
  year-partitioned Parquet directly with predicate pushdown, so a per-day
  query touches only the rows it needs. No full-day loads into pandas.
- **Per-minute aggregates in SQL, rolling windows in pandas.** SQL gives us
  MAX spreads (``MAX(ask-bid)`` — Phase 4c1), median TOB-pressure ratios
  (``percentile_cont``), filtered sums (``FILTER (WHERE side='B')``), and
  counts. Features that need a state
  machine (longest consecutive run, rolling z-scores vs trailing baseline)
  are computed on the per-minute Series in pandas.
- **Full UTC day** session window — captures Globex overnight activity that
  0DTE pre-market dynamics depend on. Per spec "Open questions" default.
- **All queries force session TimeZone=UTC** to guarantee deterministic date
  bucketing across environments. DuckDB's ``date_trunc('day', ts_recv)`` on a
  ``TIMESTAMP WITH TIME ZONE`` column honors the session TZ, so running on
  CT vs UTC vs Railway would otherwise yield different date partitions. Every
  ``duckdb.connect()`` in this module goes through ``_new_connection()`` which
  sets ``TimeZone = 'UTC'`` before any query runs.
- **Deterministic output columns.** Feature functions return ``dict``; the
  orchestrator assembles into a DataFrame with a fixed column order
  (``OUTPUT_COLUMNS``) so downstream ML code sees stable shape.

Verified TBBO archive schema (DuckDB REPL probe, 2026-04-18)::

    COLUMN                 TYPE                       NOTES
    ts_recv                TIMESTAMP WITH TIME ZONE   trade receipt ts (use this)
    ts_event               TIMESTAMP WITH TIME ZONE   exchange trade ts
    rtype                  UTINYINT
    publisher_id           USMALLINT
    instrument_id          UINTEGER                   (symbology uses BIGINT — DuckDB casts)
    action                 VARCHAR                    observed: 'T'
    side                   VARCHAR                    'A' ask-aggressor (SELL),
                                                      'B' bid-aggressor (BUY),
                                                      'N' none
    depth                  UTINYINT
    price                  DOUBLE
    size                   UINTEGER
    flags                  UTINYINT
    ts_in_delta            INTEGER
    sequence               UINTEGER
    bid_px_00              DOUBLE                     pre-trade best bid
    ask_px_00              DOUBLE                     pre-trade best ask
    bid_sz_00              UINTEGER
    ask_sz_00              UINTEGER
    bid_ct_00              UINTEGER
    ask_ct_00              UINTEGER
    symbol                 VARCHAR                    pre-resolved (e.g. "ESH6")
    year                   BIGINT                     partition column

The spec says ``side = 'S'`` for sell volume; reality is ``side = 'A'`` (ask-
aggressor, i.e. a trade that lifted the ask — a sell from the aggressor's
counterparty's side but driven by a seller who hit the bid... per Databento
conventions, 'A' means the resting side was the ASK, so the aggressor was a
seller). Net-net: the OFI sign convention used here treats B = buy flow, A =
sell flow.

CLI::

    cd ml
    .venv/bin/python -m src.features.microstructure \\
        --tbbo-root data/archive \\
        --out data/features/microstructure_daily.parquet
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

log = logging.getLogger("microstructure_features")


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Parquet compression — matches archive_convert / tbbo_convert for consistency.
PARQUET_COMPRESSION = "zstd"
PARQUET_COMPRESSION_LEVEL = 3

# OFI thresholds.
OFI_WINDOWS_MINUTES: tuple[int, ...] = (5, 15, 60)
OFI_MIN_TRADES_PER_WINDOW = 20  # skip windows with < 20 total trades (noise floor)
OFI_EXTREME_THRESHOLD = 0.3  # |OFI| > 0.3 counts as "extreme" flow

# Spread widening rolling baseline (minutes).
SPREAD_BASELINE_MINUTES = 30
SPREAD_BASELINE_MIN_PERIODS = 10
SPREAD_Z_EXCEEDANCE_2 = 2.0
SPREAD_Z_EXCEEDANCE_3 = 3.0

# TOB ratio thresholds.
TOB_BUY_PRESSURE_RATIO = 1.5
TOB_SELL_PRESSURE_RATIO = 0.67

# Backfill logging cadence.
BACKFILL_LOG_EVERY_N_DATES = 10

# Output column order — spec Table. Keep in sync with spec when edited.
OUTPUT_COLUMNS: tuple[str, ...] = (
    "date",
    "symbol",
    "front_month_contract",
    "is_degraded",
    "trade_count",
    # OFI 5m
    "ofi_5m_mean",
    "ofi_5m_std",
    "ofi_5m_abs_p95",
    "ofi_5m_pct_extreme",
    # OFI 15m
    "ofi_15m_mean",
    "ofi_15m_std",
    "ofi_15m_abs_p95",
    "ofi_15m_pct_extreme",
    # OFI 1h
    "ofi_1h_mean",
    "ofi_1h_std",
    "ofi_1h_abs_p95",
    "ofi_1h_pct_extreme",
    # Spread widening
    "spread_widening_count_2sigma",
    "spread_widening_count_3sigma",
    "spread_widening_max_zscore",
    "spread_widening_max_run_minutes",
    # TOB pressure
    "tob_extreme_minute_count",
    "tob_max_run_buy_pressure",
    "tob_max_run_sell_pressure",
    "tob_mean_abs_log_ratio",
    # Tick velocity
    "tick_velocity_mean",
    "tick_velocity_p95",
    "tick_velocity_max_minute",
)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def _tbbo_glob(tbbo_root: Path) -> str:
    """Glob for year-partitioned TBBO parquet files."""
    return str(tbbo_root / "tbbo" / "year=*" / "part.parquet")


def _symbology_path(tbbo_root: Path) -> str:
    """Path to the merged symbology sidecar."""
    return str(tbbo_root / "symbology.parquet")


def _condition_path(tbbo_root: Path) -> Path:
    """Path to the TBBO-namespaced condition file."""
    return tbbo_root / "tbbo_condition.json"


# ---------------------------------------------------------------------------
# Connection factory
# ---------------------------------------------------------------------------


def _new_connection() -> duckdb.DuckDBPyConnection:
    """Open a DuckDB connection with session TimeZone forced to UTC.

    Critical correctness hook. DuckDB's ``date_trunc('day', ts_recv)`` on a
    ``TIMESTAMP WITH TIME ZONE`` column uses the SESSION TimeZone, not UTC —
    so without this the same archive produces different feature rows on a
    Chicago MacBook vs a UTC cloud VM (trades at 00:30 UTC bucket into the
    previous day on CT). Every ``duckdb.connect()`` in this module MUST go
    through here so the guarantee holds at every query site.

    Callers that accept a pre-existing ``conn`` kwarg (e.g.
    ``compute_daily_features``) trust the caller to have used this helper
    when they built it. ``backfill_daily_features`` and the default-branch
    of ``compute_daily_features`` both use it.
    """
    conn = duckdb.connect()
    conn.execute("SET TimeZone = 'UTC'")
    return conn


# ---------------------------------------------------------------------------
# Degraded-days loader
# ---------------------------------------------------------------------------


def _load_degraded_days(condition_path: Path | None) -> set[str]:
    """Return the set of ISO dates flagged ``degraded`` in tbbo_condition.json.

    Returns an empty set if the file is missing, unreadable, or has no
    degraded entries. Logs a warning rather than failing — a downstream
    ``is_degraded=False`` for an actually-degraded day is a soft signal loss
    but not a correctness failure for the feature computation itself.
    """
    if condition_path is None or not condition_path.exists():
        return set()
    try:
        data = json.loads(condition_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Could not read condition file %s: %s", condition_path, exc)
        return set()

    if not isinstance(data, list):
        log.warning("Condition file %s is not a list; ignoring", condition_path)
        return set()

    degraded: set[str] = set()
    for entry in data:
        if (
            isinstance(entry, dict)
            and entry.get("condition") == "degraded"
            and isinstance(entry.get("date"), str)
        ):
            degraded.add(entry["date"])
    return degraded


# ---------------------------------------------------------------------------
# Front-month selection
# ---------------------------------------------------------------------------


def _pick_front_month(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    symbol: str,
) -> str | None:
    """Top-volume ES or NQ outright contract for ``date_iso`` (UTC day).

    Returns contract string like ``"ESH6"`` or ``None`` if no trades landed
    for the requested symbol on that date. Excludes calendar spreads
    (hyphenated) and options (space-separated) by forbidding those characters
    in the symbol.

    The spec asks for the join through ``symbology.parquet`` to mirror
    ``archive_query.py`` — we keep that pattern even though TBBO's ``symbol``
    column is already resolved, because:

    1. It's the documented archive contract and we want a single lookup story.
    2. Symbology's ``first_seen`` / ``last_seen`` could later prune work by
       date range, so the join site is the right place to add that filter.

    The TBBO ``instrument_id`` is ``UINTEGER`` and symbology's is ``BIGINT``;
    DuckDB auto-casts on the USING join.
    """
    symbol_upper = symbol.upper()
    if symbol_upper not in {"ES", "NQ"}:
        raise ValueError(f"symbol must be 'ES' or 'NQ', got {symbol!r}")

    like_pattern = f"{symbol_upper}%"

    # Secondary sort by symbol ASC: on tied volume (rare but real — early in
    # a roll cycle two contracts can briefly match), DuckDB's parallel
    # aggregate can otherwise pick either winner non-deterministically across
    # runs. Alphabetical tie-break is arbitrary but stable.
    row = conn.execute(
        """
        SELECT sym.symbol
        FROM read_parquet(?) AS bars
        JOIN read_parquet(?) AS sym USING (instrument_id)
        WHERE sym.symbol LIKE ?
          AND strpos(sym.symbol, ' ') = 0
          AND strpos(sym.symbol, '-') = 0
          AND CAST(date_trunc('day', bars.ts_recv) AS DATE) = ?::DATE
        GROUP BY sym.symbol
        ORDER BY SUM(bars.size) DESC, sym.symbol ASC
        LIMIT 1
        """,
        [tbbo_glob, symbology_path, like_pattern, date_iso],
    ).fetchone()
    return row[0] if row else None


# ---------------------------------------------------------------------------
# Per-minute SQL helper
# ---------------------------------------------------------------------------


def _per_minute_stats(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    contract: str,
) -> pd.DataFrame:
    """Pull per-minute aggregates for one (date, contract) in one SQL pass.

    Columns:
      * ``minute`` — DATETIME (TZ-naive UTC) bucket start
      * ``n_trades`` — count of trade events in the minute
      * ``buy_vol`` / ``sell_vol`` — sums of ``size`` filtered by side
      * ``max_spread`` — max of ``ask_px_00 - bid_px_00`` (Phase 4c1
        fix: median collapses on tick-floor products like ES where the
        spread is $0.25 on 80%+ of minutes; max captures genuine
        widening events that the median hides)
      * ``med_ratio`` — median of ``bid_sz_00 / NULLIF(ask_sz_00, 0)``

    The single-pass design matters: each side has hundreds of millions of
    rows across the archive, so we don't want to issue 4 separate queries
    per day. DuckDB runs this as one scan with per-minute grouping.
    """
    df = conn.execute(
        """
        WITH f AS (
            SELECT bars.ts_recv,
                   bars.side,
                   bars.size,
                   bars.bid_px_00,
                   bars.ask_px_00,
                   bars.bid_sz_00,
                   bars.ask_sz_00
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_recv) AS DATE) = ?::DATE
        )
        SELECT
            date_trunc('minute', ts_recv) AS minute,
            COUNT(*) AS n_trades,
            COALESCE(SUM(size) FILTER (WHERE side = 'B'), 0) AS buy_vol,
            COALESCE(SUM(size) FILTER (WHERE side = 'A'), 0) AS sell_vol,
            MAX(ask_px_00 - bid_px_00) AS max_spread,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY CAST(bid_sz_00 AS DOUBLE)
                       / NULLIF(CAST(ask_sz_00 AS DOUBLE), 0)
            ) AS med_ratio
        FROM f
        GROUP BY 1
        ORDER BY 1
        """,
        [tbbo_glob, symbology_path, contract, date_iso],
    ).fetchdf()

    if df.empty:
        return df

    # Normalize to TZ-naive datetimes for pandas rolling ops.
    # DuckDB returns TIMESTAMP WITH TIME ZONE → tz-aware.
    if pd.api.types.is_datetime64_any_dtype(df["minute"]) and df["minute"].dt.tz:
        df["minute"] = df["minute"].dt.tz_convert("UTC").dt.tz_localize(None)
    df = df.set_index("minute").sort_index()
    # Force numeric dtype (DuckDB DECIMAL → object in edge cases).
    for col in ("n_trades", "buy_vol", "sell_vol", "max_spread", "med_ratio"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


# ---------------------------------------------------------------------------
# Feature families
# ---------------------------------------------------------------------------


def _compute_ofi_stats(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    contract: str,
    *,
    per_minute: pd.DataFrame | None = None,
) -> dict[str, float]:
    """OFI statistics at 5m / 15m / 1h rolling windows.

    For each minute ``m``, we sum buy and sell volume over ``[m - W, m]``
    (pandas ``rolling(window=W, min_periods=W)``; a window needs all W
    minutes filled to avoid ragged starts). Skip windows where total volume
    is below ``OFI_MIN_TRADES_PER_WINDOW`` — those are noise-floor minutes
    (thin overnight stretches) that would dominate the mean/std if kept.

    Day aggregates per window:

    * ``mean`` / ``std`` across all valid minutes
    * ``abs_p95`` — 95th percentile of |OFI|
    * ``pct_extreme`` — fraction of valid windows with |OFI| > 0.3
    """
    if per_minute is None:
        per_minute = _per_minute_stats(
            conn, tbbo_glob, symbology_path, date_iso, contract
        )

    out: dict[str, float] = {}

    if per_minute.empty:
        for w in OFI_WINDOWS_MINUTES:
            out[f"ofi_{_window_key(w)}_mean"] = float("nan")
            out[f"ofi_{_window_key(w)}_std"] = float("nan")
            out[f"ofi_{_window_key(w)}_abs_p95"] = float("nan")
            out[f"ofi_{_window_key(w)}_pct_extreme"] = float("nan")
        return out

    # Build a dense minute index so the rolling window sees real gaps as
    # zero-volume minutes (overnight halts etc.). Without this, consecutive
    # sparse minutes would collapse into a single window position and we'd
    # over-count flow.
    dense = _densify_minute_index(per_minute)

    for w in OFI_WINDOWS_MINUTES:
        key = _window_key(w)
        # Rolling sums over the last W minutes, inclusive of the current.
        buy_sum = dense["buy_vol"].rolling(window=w, min_periods=w).sum()
        sell_sum = dense["sell_vol"].rolling(window=w, min_periods=w).sum()
        total = buy_sum + sell_sum

        # OFI with sample-size guard: both NaN out if total < threshold.
        ofi = (buy_sum - sell_sum) / total.where(
            total >= OFI_MIN_TRADES_PER_WINDOW
        )
        valid = ofi.dropna()

        if valid.empty:
            out[f"ofi_{key}_mean"] = float("nan")
            out[f"ofi_{key}_std"] = float("nan")
            out[f"ofi_{key}_abs_p95"] = float("nan")
            out[f"ofi_{key}_pct_extreme"] = float("nan")
            continue

        out[f"ofi_{key}_mean"] = float(valid.mean())
        # ddof=0 is the population std — matches the "describe this day's
        # flow" framing. ddof=1 with a single-valid-window day would NaN out.
        out[f"ofi_{key}_std"] = float(valid.std(ddof=0))
        out[f"ofi_{key}_abs_p95"] = float(valid.abs().quantile(0.95))
        out[f"ofi_{key}_pct_extreme"] = float(
            (valid.abs() > OFI_EXTREME_THRESHOLD).mean()
        )

    return out


def _compute_spread_widening_stats(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    contract: str,
    *,
    per_minute: pd.DataFrame | None = None,
) -> dict[str, float]:
    """Spread widening z-score stats over the session.

    Z-score for minute m uses a trailing 30-minute baseline of
    per-minute MAX spreads (strictly m-30 .. m-1 — ``shift(1)`` before
    rolling — so m never contributes to its own baseline). If baseline std
    is zero (all-flat 30m window), treat z = 0. Minutes without enough
    baseline (first 10 of session) are skipped.

    Day aggregates:
      * ``count_2sigma`` — count of minutes with z > 2.0
      * ``count_3sigma`` — count of minutes with z > 3.0
      * ``max_zscore`` — peak z observed
      * ``max_run_minutes`` — longest consecutive run of z > 2.0

    Phase 4c1 fix (2026-04-19): per-minute aggregator switched from
    ``percentile_cont(0.5)`` (median) to ``MAX(ask - bid)``. ES
    front-month spread is pinned at the $0.25 tick floor on ~80% of
    minutes, so a median-based baseline has std = 0 and the zero-std
    guard forces z = 0 universally — the feature carried no signal
    (validated in Phase 4d EDA, 80.1% zero-rate on ES). MAX captures
    single widened quotes within a minute, which is what liquidity
    withdrawal events look like on a minimum-tick-width product. NQ
    previously had 0% zero-rate on median and remains information-rich
    under MAX.
    """
    if per_minute is None:
        per_minute = _per_minute_stats(
            conn, tbbo_glob, symbology_path, date_iso, contract
        )

    if per_minute.empty:
        return {
            "spread_widening_count_2sigma": 0,
            "spread_widening_count_3sigma": 0,
            "spread_widening_max_zscore": float("nan"),
            "spread_widening_max_run_minutes": 0,
        }

    dense = _densify_minute_index(per_minute)
    # Max spread per minute — carry forward across dense gaps so the
    # rolling baseline sees a continuous series (halts are quiet but not
    # structurally "narrow" — holding the last known max prevents the
    # gap from NaN-poisoning the baseline).
    spread = dense["max_spread"].ffill()

    # Baseline is strictly the prior 30 minutes, excluding the current
    # minute from its own reference.
    baseline_med = (
        spread.shift(1).rolling(SPREAD_BASELINE_MINUTES, min_periods=SPREAD_BASELINE_MIN_PERIODS).median()
    )
    baseline_std = (
        spread.shift(1).rolling(SPREAD_BASELINE_MINUTES, min_periods=SPREAD_BASELINE_MIN_PERIODS).std(ddof=0)
    )

    # z = (cur - baseline_med) / baseline_std; guard zero-std as z=0.
    z = (spread - baseline_med) / baseline_std.where(baseline_std > 0)
    z = z.where(baseline_std > 0, other=0.0)
    # Minutes that never had enough baseline stay NaN → excluded below.
    z_valid = z[baseline_med.notna()]

    if z_valid.empty:
        return {
            "spread_widening_count_2sigma": 0,
            "spread_widening_count_3sigma": 0,
            "spread_widening_max_zscore": 0.0,
            "spread_widening_max_run_minutes": 0,
        }

    count_2 = int((z_valid > SPREAD_Z_EXCEEDANCE_2).sum())
    count_3 = int((z_valid > SPREAD_Z_EXCEEDANCE_3).sum())
    # max() of a Series with NaN-safe semantics — z_valid is already dropna'd
    # conceptually, but NaN can sneak in from the zero-std guard if the
    # baseline_std window was all-NaN (shouldn't happen after the
    # baseline_med.notna() gate, but be defensive).
    max_z = float(z_valid.max()) if z_valid.notna().any() else 0.0
    # Longest consecutive run over the dense minute axis.
    exceedance = (z_valid > SPREAD_Z_EXCEEDANCE_2).astype(int)
    max_run = _longest_run(exceedance.to_numpy())

    return {
        "spread_widening_count_2sigma": count_2,
        "spread_widening_count_3sigma": count_3,
        "spread_widening_max_zscore": max_z,
        "spread_widening_max_run_minutes": int(max_run),
    }


def _compute_tob_persistence_stats(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    contract: str,
    *,
    per_minute: pd.DataFrame | None = None,
) -> dict[str, float]:
    """Top-of-book pressure persistence across the session.

    Ratio = median(bid_sz_00 / ask_sz_00) across all quotes in a minute
    (NaN when ask_sz_00 = 0 — that row is skipped by the SQL's ``NULLIF``
    guard, not the whole minute).

    Day aggregates:
      * ``extreme_minute_count`` — minutes with ratio > 1.5 OR < 0.67
      * ``max_run_buy_pressure`` — longest consecutive run of ratio > 1.5
      * ``max_run_sell_pressure`` — longest consecutive run of ratio < 0.67
      * ``mean_abs_log_ratio`` — mean |log(ratio)| (balanced-flow-penalty)
    """
    if per_minute is None:
        per_minute = _per_minute_stats(
            conn, tbbo_glob, symbology_path, date_iso, contract
        )

    if per_minute.empty:
        return {
            "tob_extreme_minute_count": 0,
            "tob_max_run_buy_pressure": 0,
            "tob_max_run_sell_pressure": 0,
            "tob_mean_abs_log_ratio": float("nan"),
        }

    # Don't densify here: extreme-minute counts are over ACTUAL minutes
    # with trades. Densifying would inject NaN-ratio minutes that break
    # the consecutive-run counter. Runs therefore mean "uninterrupted
    # active minutes" rather than "wall-clock consecutive minutes" — which
    # is what the signal is really about (no data means no pressure).
    ratio = per_minute["med_ratio"].dropna()
    if ratio.empty:
        return {
            "tob_extreme_minute_count": 0,
            "tob_max_run_buy_pressure": 0,
            "tob_max_run_sell_pressure": 0,
            "tob_mean_abs_log_ratio": float("nan"),
        }

    buy_pressure = (ratio > TOB_BUY_PRESSURE_RATIO).astype(int)
    sell_pressure = (ratio < TOB_SELL_PRESSURE_RATIO).astype(int)
    extreme_count = int((buy_pressure.to_numpy() | sell_pressure.to_numpy()).sum())
    max_run_buy = _longest_run(buy_pressure.to_numpy())
    max_run_sell = _longest_run(sell_pressure.to_numpy())

    # log-ratio: guard ratio <= 0 (shouldn't happen — bid_sz is unsigned —
    # but if the division produced 0 from integer quirks, skip).
    positive = ratio[ratio > 0]
    if positive.empty:
        mean_abs_log = float("nan")
    else:
        mean_abs_log = float(np.abs(np.log(positive.to_numpy())).mean())

    return {
        "tob_extreme_minute_count": extreme_count,
        "tob_max_run_buy_pressure": int(max_run_buy),
        "tob_max_run_sell_pressure": int(max_run_sell),
        "tob_mean_abs_log_ratio": mean_abs_log,
    }


def _compute_tick_velocity_stats(
    conn: duckdb.DuckDBPyConnection,
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    contract: str,
    *,
    per_minute: pd.DataFrame | None = None,
) -> dict[str, float]:
    """Tick velocity: trades-per-minute mean / p95 / max."""
    if per_minute is None:
        per_minute = _per_minute_stats(
            conn, tbbo_glob, symbology_path, date_iso, contract
        )

    if per_minute.empty:
        return {
            "tick_velocity_mean": float("nan"),
            "tick_velocity_p95": float("nan"),
            "tick_velocity_max_minute": 0,
        }

    counts = per_minute["n_trades"].astype(float)
    return {
        "tick_velocity_mean": float(counts.mean()),
        "tick_velocity_p95": float(counts.quantile(0.95)),
        "tick_velocity_max_minute": int(counts.max()),
    }


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _window_key(minutes: int) -> str:
    """Render 5 → '5m', 15 → '15m', 60 → '1h' for column naming."""
    if minutes == 60:
        return "1h"
    return f"{minutes}m"


def _densify_minute_index(per_minute: pd.DataFrame) -> pd.DataFrame:
    """Reindex per-minute DataFrame onto a contiguous minute grid.

    Zero-fill integer volume / count columns; leave ``max_spread`` /
    ``med_ratio`` as NaN (caller chooses whether to forward-fill). This
    is how rolling windows see overnight halts as real gaps rather than
    collapsed neighbors.
    """
    if per_minute.empty:
        return per_minute
    idx = pd.date_range(
        start=per_minute.index.min(),
        end=per_minute.index.max(),
        freq="1min",
    )
    dense = per_minute.reindex(idx)
    for col in ("n_trades", "buy_vol", "sell_vol"):
        if col in dense.columns:
            dense[col] = dense[col].fillna(0)
    return dense


def _longest_run(arr: np.ndarray) -> int:
    """Length of the longest consecutive run of 1s in a 0/1 numpy array."""
    if arr.size == 0:
        return 0
    # NaN-safe: coerce to int. Caller is responsible for ensuring the values
    # are truly 0/1 — any nonzero counts as "hit".
    flat = (arr != 0).astype(int)
    max_run = 0
    cur = 0
    for v in flat:
        if v:
            cur += 1
            if cur > max_run:
                max_run = cur
        else:
            cur = 0
    return max_run


# ---------------------------------------------------------------------------
# Orchestrator: one (date, symbol) row
# ---------------------------------------------------------------------------


def compute_daily_features(
    tbbo_glob: str,
    symbology_path: str,
    date_iso: str,
    symbol: str,
    *,
    condition_path: Path | None = None,
    degraded_days: set[str] | None = None,
    conn: duckdb.DuckDBPyConnection | None = None,
) -> dict[str, Any] | None:
    """Compute one feature row for ``(date_iso, symbol)``.

    Returns a dict with all keys in ``OUTPUT_COLUMNS``, or ``None`` if no
    trades landed for that symbol on that date (i.e. market holiday or a
    symbol that didn't trade — the spec says skip rather than emit zeros).

    Degraded-days lookup: if ``degraded_days`` is provided (a pre-parsed
    ``set[str]`` of ISO dates), use it directly — avoids re-reading the
    JSON file on every call. Otherwise fall back to parsing
    ``condition_path`` (back-compat for single-day callers). If neither is
    provided, ``is_degraded`` is always ``False``.
    """
    owns_conn = conn is None
    if conn is None:
        conn = _new_connection()

    try:
        contract = _pick_front_month(
            conn, tbbo_glob, symbology_path, date_iso, symbol
        )
        if contract is None:
            return None

        per_minute = _per_minute_stats(
            conn, tbbo_glob, symbology_path, date_iso, contract
        )
        if per_minute.empty:
            return None

        trade_count = int(per_minute["n_trades"].sum())

        if degraded_days is None:
            degraded_days = _load_degraded_days(condition_path)

        row: dict[str, Any] = {
            "date": date.fromisoformat(date_iso),
            "symbol": symbol.upper(),
            "front_month_contract": contract,
            "is_degraded": date_iso in degraded_days,
            "trade_count": trade_count,
        }
        row.update(
            _compute_ofi_stats(
                conn, tbbo_glob, symbology_path, date_iso, contract,
                per_minute=per_minute,
            )
        )
        row.update(
            _compute_spread_widening_stats(
                conn, tbbo_glob, symbology_path, date_iso, contract,
                per_minute=per_minute,
            )
        )
        row.update(
            _compute_tob_persistence_stats(
                conn, tbbo_glob, symbology_path, date_iso, contract,
                per_minute=per_minute,
            )
        )
        row.update(
            _compute_tick_velocity_stats(
                conn, tbbo_glob, symbology_path, date_iso, contract,
                per_minute=per_minute,
            )
        )

        # Validate shape before returning — catches missing keys early.
        missing = set(OUTPUT_COLUMNS) - set(row.keys())
        if missing:
            raise RuntimeError(
                f"Feature row for {date_iso}/{symbol} missing columns: {sorted(missing)}"
            )
        return row
    finally:
        if owns_conn:
            conn.close()


# ---------------------------------------------------------------------------
# Orchestrator: backfill across a date range
# ---------------------------------------------------------------------------


def _archive_date_range(
    conn: duckdb.DuckDBPyConnection, tbbo_glob: str
) -> tuple[str, str] | None:
    """Min/max UTC date from the archive's ``ts_recv``, or None if empty."""
    row = conn.execute(
        """
        SELECT MIN(CAST(date_trunc('day', ts_recv) AS DATE)) AS mn,
               MAX(CAST(date_trunc('day', ts_recv) AS DATE)) AS mx
        FROM read_parquet(?)
        """,
        [tbbo_glob],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return row[0].isoformat(), row[1].isoformat()


def _daterange(start_iso: str, end_iso: str) -> list[str]:
    """Inclusive list of ISO dates from start..end."""
    start = date.fromisoformat(start_iso)
    end = date.fromisoformat(end_iso)
    if end < start:
        return []
    out: list[str] = []
    cur = start
    while cur <= end:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def backfill_daily_features(
    tbbo_root: Path,
    *,
    out_path: Path,
    start_date: str | None = None,
    end_date: str | None = None,
    symbols: Sequence[str] = ("ES", "NQ"),
) -> pd.DataFrame:
    """Iterate ``(date, symbol)``, compute features, write Parquet + return DataFrame.

    When ``start_date`` / ``end_date`` are ``None``, uses the archive's own
    min/max ``ts_recv`` date as the bounds. Dates that produce ``None`` from
    ``compute_daily_features`` (no trades) are skipped — not written as empty
    rows.
    """
    tbbo_root = tbbo_root.expanduser().resolve()
    out_path = out_path.expanduser().resolve()
    tbbo_glob = _tbbo_glob(tbbo_root)
    symbology_path = _symbology_path(tbbo_root)
    condition_path = _condition_path(tbbo_root)

    # Parse condition.json ONCE. Previously this re-read the file on every
    # (date, symbol) — 1,000+ disk reads in a 500-row backfill.
    degraded_days = _load_degraded_days(condition_path)
    log.info("Loaded %d degraded dates from %s", len(degraded_days), condition_path)

    conn = _new_connection()
    try:
        # Resolve date range. When bounds weren't given, this is the
        # "full archive" path. When given explicitly, honor them verbatim
        # — lets the user backfill a subset without re-scanning to derive
        # archive bounds.
        if start_date is None or end_date is None:
            bounds = _archive_date_range(conn, tbbo_glob)
            if bounds is None:
                log.warning("No TBBO rows in %s — nothing to backfill", tbbo_root)
                out_path.parent.mkdir(parents=True, exist_ok=True)
                empty = pd.DataFrame(columns=list(OUTPUT_COLUMNS))
                pq.write_table(
                    pa.Table.from_pandas(empty, preserve_index=False),
                    out_path,
                    compression=PARQUET_COMPRESSION,
                    compression_level=PARQUET_COMPRESSION_LEVEL,
                )
                return empty
            archive_start, archive_end = bounds
            start_date = start_date or archive_start
            end_date = end_date or archive_end

        dates = _daterange(start_date, end_date)
        log.info(
            "Backfill plan: %d dates × %d symbols (%s..%s, %s)",
            len(dates),
            len(symbols),
            start_date,
            end_date,
            ", ".join(symbols),
        )

        rows: list[dict[str, Any]] = []
        for i, date_iso in enumerate(dates, start=1):
            for sym in symbols:
                t0 = time.perf_counter()
                row = compute_daily_features(
                    tbbo_glob,
                    symbology_path,
                    date_iso,
                    sym,
                    degraded_days=degraded_days,
                    conn=conn,
                )
                dt_ms = (time.perf_counter() - t0) * 1000.0
                if row is not None:
                    rows.append(row)
                    log.debug(
                        "%s %s: contract=%s trades=%s (%.1f ms)",
                        date_iso,
                        sym,
                        row["front_month_contract"],
                        row["trade_count"],
                        dt_ms,
                    )
                else:
                    log.debug("%s %s: no trades (%.1f ms)", date_iso, sym, dt_ms)
            if i % BACKFILL_LOG_EVERY_N_DATES == 0 or i == len(dates):
                log.info(
                    "Progress: %d/%d dates processed, %d rows collected",
                    i,
                    len(dates),
                    len(rows),
                )
    finally:
        conn.close()

    if not rows:
        log.warning("No feature rows collected for %s..%s", start_date, end_date)
        df = pd.DataFrame(columns=list(OUTPUT_COLUMNS))
    else:
        df = pd.DataFrame(rows).reindex(columns=list(OUTPUT_COLUMNS))

    # Stable sort — (date, symbol) makes diffs across runs reviewable.
    if not df.empty:
        df = df.sort_values(["date", "symbol"], kind="stable").reset_index(drop=True)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.Table.from_pandas(df, preserve_index=False),
        out_path,
        compression=PARQUET_COMPRESSION,
        compression_level=PARQUET_COMPRESSION_LEVEL,
    )
    log.info("Wrote %d rows -> %s", len(df), out_path)
    return df


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compute microstructure features over the local TBBO archive."
    )
    parser.add_argument(
        "--tbbo-root",
        required=True,
        type=Path,
        help="Archive root containing tbbo/year=*/part.parquet and symbology.parquet.",
    )
    parser.add_argument(
        "--out",
        required=True,
        type=Path,
        help="Output Parquet path (e.g. data/features/microstructure_daily.parquet).",
    )
    parser.add_argument(
        "--start-date",
        default=None,
        help="Inclusive ISO date (YYYY-MM-DD). Defaults to archive min.",
    )
    parser.add_argument(
        "--end-date",
        default=None,
        help="Inclusive ISO date (YYYY-MM-DD). Defaults to archive max.",
    )
    parser.add_argument(
        "--symbols",
        nargs="+",
        default=["ES", "NQ"],
        help="Symbols to compute features for. Default: ES NQ.",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    t0 = datetime.now(UTC)
    try:
        df = backfill_daily_features(
            tbbo_root=args.tbbo_root,
            out_path=args.out,
            start_date=args.start_date,
            end_date=args.end_date,
            symbols=tuple(args.symbols),
        )
    except Exception as exc:
        log.error("Backfill failed: %s", exc, exc_info=args.verbose)
        return 1

    elapsed = datetime.now(UTC) - t0
    print()
    print(f"Wrote {len(df):,} feature rows -> {args.out}")
    print(f"  Symbols: {sorted(df['symbol'].unique().tolist()) if not df.empty else args.symbols}")
    if not df.empty:
        print(f"  Dates:   {df['date'].min()} .. {df['date'].max()}")
        print(f"  Degraded: {int(df['is_degraded'].sum())} rows")
    print(f"  Elapsed: {elapsed.total_seconds():.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
