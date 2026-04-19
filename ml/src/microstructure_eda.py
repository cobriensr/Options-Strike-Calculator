"""Phase 4d — Microstructure EDA + signal validation.

Six EDA questions validating the Phase 4c microstructure feature matrix
(``ml/data/features/microstructure_daily.parquet``) against outcome labels
derived from the 17-year OHLCV archive:

    Q1  Feature distributions — shape, outliers, missingness
    Q2  Feature correlation matrix — redundancy / pairs with |rho| > 0.9
    Q3  Spread widening zero-rate — confirm or refute the Phase 4c finding
    Q4  Derived outcomes — ret_day, ret_5d, up/flat/down regime label
    Q5  Feature -> outcome Spearman correlations, Bonferroni-corrected
    Q6  Cohort analysis — top vs bottom quartile on top-3 Q5 features

Each question emits one PNG under ``ml/plots/microstructure_q*_*.png`` and
one entry in ``ml/findings_microstructure.json``. The module is pure: no
network calls, no DB writes, no model training. Runs fully offline against
local Parquet archives.

Outcome derivation uses the **same front-month contract** that the feature
row stores (``front_month_contract``) to avoid cross-contract roll noise.
Every DuckDB connection forces ``TimeZone = 'UTC'`` so ``date_trunc('day',
ts_event)`` buckets by UTC calendar day regardless of host timezone —
matches the Phase 4c regression-tested guarantee.

CLI::

    cd ml
    .venv/bin/python -m src.microstructure_eda \\
        --features data/features/microstructure_daily.parquet \\
        --ohlcv-root data/archive \\
        --plots-dir plots \\
        --findings findings_microstructure.json
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import duckdb
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

log = logging.getLogger("microstructure_eda")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Regime-label thresholds for ret_day.
#   ret_day >  OUTCOME_UP_THRESHOLD         -> "up"
#   |ret_day| <= OUTCOME_UP_THRESHOLD        -> "flat"
#   ret_day <  OUTCOME_DOWN_THRESHOLD       -> "down"
#
# Boundary convention: strictly greater-than / strictly less-than. An exact
# +0.005 lands in "flat" (a 50 bps move on ES is within noise for a 0DTE
# decision gate). Tested explicitly in test_outcome_classification_*.
OUTCOME_UP_THRESHOLD = 0.005
OUTCOME_DOWN_THRESHOLD = -0.005

# Forward-return window (trading days).
FORWARD_DAYS = 5

# Spread widening zero-rate recommendation trigger (Q3).
SPREAD_ZERO_RATE_THRESHOLD = 0.9

# |rho| callout for high-correlation pairs (Q2).
HIGH_CORRELATION_THRESHOLD = 0.9

# Q5 top-N features per symbol (by |Spearman rho|).
CORRELATION_RANK_TOP_N = 10

# Q6 cohort quartile (top 25% vs bottom 25%).
COHORT_QUANTILE = 0.25

# Non-feature columns in the Parquet (identifier / bookkeeping) and any
# outcome columns derived after ``derive_outcomes``. Kept as one tuple so
# every question uses the same exclusion list.
META_COLUMNS = (
    "date",
    "symbol",
    "front_month_contract",
    "is_degraded",
    "trade_count",
    "ret_day",
    "ret_5d",
    "regime_label",
)

# Plot settings.
PLOT_DPI = 150
PLOT_FIGSIZE_GRID = (16, 18)
PLOT_FIGSIZE_SINGLE = (10, 6)
PLOT_FIGSIZE_WIDE = (12, 6)
PLOT_FIGSIZE_HEATMAP = (14, 12)
PLOT_FIGSIZE_COHORT = (14, 8)

# Color palette (matched to flow_eda.py's COLORS dict).
COLORS = {
    "green": "#2ecc71",
    "red": "#e74c3c",
    "blue": "#3498db",
    "orange": "#f39c12",
    "purple": "#9b59b6",
    "gray": "#95a5a6",
    "teal": "#1abc9c",
}

# Outlier rule: rows beyond +/- 3 IQR of the column median.
IQR_OUTLIER_MULTIPLIER = 3.0


# ---------------------------------------------------------------------------
# Connection + OHLCV helpers
# ---------------------------------------------------------------------------


def _new_connection() -> duckdb.DuckDBPyConnection:
    """Open a DuckDB connection with session TimeZone forced to UTC.

    Mirrors ``features.microstructure._new_connection``: without this,
    ``date_trunc('day', ts_event)`` on a TIMESTAMP WITH TIME ZONE column
    honors the session TZ, causing a trade at 00:01 UTC on a Chicago host
    to bucket into the previous UTC day.
    """
    conn = duckdb.connect()
    conn.execute("SET TimeZone = 'UTC'")
    return conn


def _numeric_feature_columns(feature_df: pd.DataFrame) -> list[str]:
    """Return the feature-matrix numeric columns (excluding meta columns)."""
    return [
        c
        for c in feature_df.columns
        if c not in META_COLUMNS and pd.api.types.is_numeric_dtype(feature_df[c])
    ]


# ---------------------------------------------------------------------------
# Outcome derivation (Q4 prerequisite)
# ---------------------------------------------------------------------------


def _fetch_day_open_close(
    conn: duckdb.DuckDBPyConnection,
    ohlcv_glob: str,
    symbology_path: str,
    contract: str,
    date_iso: str,
) -> tuple[float | None, float | None]:
    """First-open / last-close for ``contract`` on UTC day ``date_iso``.

    Returns ``(None, None)`` if no OHLCV rows match. Uses the same UTC
    bucketing as the Phase 4c feature builder.
    """
    row = conn.execute(
        """
        SELECT FIRST(open ORDER BY ts_event) AS day_open,
               LAST(close  ORDER BY ts_event) AS day_close
        FROM read_parquet(?) AS bars
        JOIN read_parquet(?) AS sym USING (instrument_id)
        WHERE sym.symbol = ?
          AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        """,
        [ohlcv_glob, symbology_path, contract, date_iso],
    ).fetchone()
    if row is None or row[0] is None:
        return None, None
    return float(row[0]), float(row[1])


def derive_outcomes(
    feature_df: pd.DataFrame,
    ohlcv_glob: str,
    symbology_path: str,
    conn: duckdb.DuckDBPyConnection | None = None,
) -> pd.DataFrame:
    """Join ``ret_day``, ``ret_5d``, and ``regime_label`` onto ``feature_df``.

    For each ``(date, symbol, front_month_contract)`` row:

    * ``ret_day`` = (day_close - day_open) / day_open, using the contract's
      own open/close on that UTC day.
    * ``ret_5d`` = (close_{t+5d} - close_t) / close_t where t+5d is the
      5th calendar-forward date that still has OHLCV for the same contract;
      NaN if the contract has no close on the t+5 date (roll boundary or
      outside archive).
    * ``regime_label`` -> {"up", "flat", "down"} per the thresholds.

    Rows with no OHLCV data for their contract on ``date`` are dropped with
    a warning (degenerate — usually points at a symbology mismatch).

    The function never mutates ``feature_df``; returns a new DataFrame.
    """
    owns_conn = conn is None
    if conn is None:
        conn = _new_connection()

    try:
        records: list[dict[str, Any]] = []
        dropped = 0
        for _, row in feature_df.iterrows():
            date_val = row["date"]
            date_iso = (
                date_val.isoformat()
                if isinstance(date_val, date)
                else str(date_val)
            )
            contract = row["front_month_contract"]
            day_open, day_close = _fetch_day_open_close(
                conn, ohlcv_glob, symbology_path, contract, date_iso
            )
            if day_open is None or day_open == 0:
                dropped += 1
                log.warning(
                    "Dropping row %s/%s: no OHLCV for contract %s",
                    date_iso,
                    row["symbol"],
                    contract,
                )
                continue
            ret_day = (day_close - day_open) / day_open

            # ret_5d: find close 5 calendar days forward for the same contract.
            # Calendar days, not trading days — the archive doesn't carry a
            # trading-day index. 5 calendar days ~= 3-5 trading days depending
            # on weekends; acceptable for a coarse forward-window feature.
            target_date = (
                date_val
                if isinstance(date_val, date)
                else date.fromisoformat(date_iso)
            )
            # Iterate up to FORWARD_DAYS+5 calendar days forward looking for
            # the next date with a close for this contract. This is robust to
            # weekends and holidays — the first found close wins.
            future_close: float | None = None
            for offset in range(FORWARD_DAYS, FORWARD_DAYS + 5):
                try:
                    future_iso = (
                        target_date.toordinal() + offset
                    )
                    future_date = date.fromordinal(future_iso)
                except (OverflowError, ValueError):
                    break
                _, f_close = _fetch_day_open_close(
                    conn,
                    ohlcv_glob,
                    symbology_path,
                    contract,
                    future_date.isoformat(),
                )
                if f_close is not None:
                    future_close = f_close
                    break
            ret_5d = (
                (future_close - day_close) / day_close
                if future_close is not None and day_close
                else float("nan")
            )

            if ret_day > OUTCOME_UP_THRESHOLD:
                regime = "up"
            elif ret_day < OUTCOME_DOWN_THRESHOLD:
                regime = "down"
            else:
                regime = "flat"

            records.append(
                {
                    "date": date_val,
                    "symbol": row["symbol"],
                    "ret_day": ret_day,
                    "ret_5d": ret_5d,
                    "regime_label": regime,
                }
            )

        if dropped:
            log.warning("derive_outcomes: dropped %d row(s) with no OHLCV", dropped)
    finally:
        if owns_conn:
            conn.close()

    outcomes = pd.DataFrame.from_records(records)
    if outcomes.empty:
        # Return feature_df with NaN outcome columns so downstream code has a
        # stable shape to work with.
        out = feature_df.copy()
        out["ret_day"] = float("nan")
        out["ret_5d"] = float("nan")
        out["regime_label"] = "flat"
        return out.iloc[0:0]  # zero rows — caller can detect

    merged = feature_df.merge(outcomes, on=["date", "symbol"], how="inner")
    return merged


# ---------------------------------------------------------------------------
# Q1: Distributions
# ---------------------------------------------------------------------------


def q1_distributions(df: pd.DataFrame, out_path: Path) -> dict[str, Any]:
    """Histogram panel + per-feature summary stats.

    Includes degraded rows — outlier detection is the explicit purpose of
    this question, and degraded days often ARE the outliers. Ordinary Q5/Q6
    analyses exclude them.
    """
    features = _numeric_feature_columns(df)
    n_features = len(features)

    ncols = 4
    nrows = (n_features + ncols - 1) // ncols
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(PLOT_FIGSIZE_GRID[0], nrows * 2.5)
    )
    axes_flat = axes.flatten() if nrows > 1 else np.atleast_1d(axes).flatten()

    per_feature: dict[str, dict[str, float | int]] = {}
    for i, col in enumerate(features):
        series = df[col].astype(float)
        ax = axes_flat[i]
        valid = series.dropna()
        if len(valid) > 0:
            # Clip the extreme 1% for histogram readability; annotate stats
            # below using the un-clipped series so the reported p99 is honest.
            lower = valid.quantile(0.005)
            upper = valid.quantile(0.995)
            ax.hist(
                valid.clip(lower=lower, upper=upper),
                bins=40,
                color=COLORS["blue"],
                edgecolor="#222",
                alpha=0.85,
            )
            ax.axvline(
                valid.median(), color=COLORS["red"], linewidth=1, linestyle="--"
            )
        ax.set_title(col, fontsize=9)
        ax.tick_params(labelsize=7)

        # Outlier fraction using the 3-IQR rule around the median.
        if len(valid) >= 4:
            q1 = valid.quantile(0.25)
            q3 = valid.quantile(0.75)
            iqr = q3 - q1
            lo = q1 - IQR_OUTLIER_MULTIPLIER * iqr
            hi = q3 + IQR_OUTLIER_MULTIPLIER * iqr
            outlier_frac = float(((valid < lo) | (valid > hi)).mean())
        else:
            outlier_frac = 0.0

        per_feature[col] = {
            "mean": float(valid.mean()) if len(valid) else float("nan"),
            "std": float(valid.std(ddof=0)) if len(valid) else float("nan"),
            "p01": float(valid.quantile(0.01)) if len(valid) else float("nan"),
            "p50": float(valid.median()) if len(valid) else float("nan"),
            "p99": float(valid.quantile(0.99)) if len(valid) else float("nan"),
            "n_missing": int(series.isna().sum()),
            "outlier_fraction": outlier_frac,
        }

    # Hide any leftover subplot slots.
    for j in range(n_features, len(axes_flat)):
        axes_flat[j].axis("off")

    fig.suptitle(
        f"Microstructure features - distributions (N={len(df)} rows, "
        f"{n_features} features)",
        fontsize=12,
    )
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    high_outlier = {
        k: v["outlier_fraction"]
        for k, v in per_feature.items()
        if v["outlier_fraction"] > 0.05
    }
    summary = (
        f"Plotted {n_features} feature distributions. "
        f"{len(high_outlier)} feature(s) have >5% outlier fraction "
        "(3-IQR rule)."
    )

    return {
        "id": "q1_distributions",
        "summary": summary,
        "n_features": n_features,
        "n_rows": int(len(df)),
        "per_feature": per_feature,
    }


# ---------------------------------------------------------------------------
# Q2: Correlation matrix
# ---------------------------------------------------------------------------


def q2_correlation(df: pd.DataFrame, out_path: Path) -> dict[str, Any]:
    """Spearman correlation heatmap across features + high-correlation pairs."""
    features = _numeric_feature_columns(df)
    # Drop constant columns from the correlation matrix — they produce NaN
    # rows that make the heatmap unreadable.
    keep = [c for c in features if df[c].nunique(dropna=True) > 1]
    corr = df[keep].corr(method="spearman")

    fig, ax = plt.subplots(figsize=PLOT_FIGSIZE_HEATMAP)
    im = ax.imshow(corr.to_numpy(), cmap="RdBu_r", vmin=-1, vmax=1, aspect="auto")
    ax.set_xticks(range(len(keep)))
    ax.set_yticks(range(len(keep)))
    ax.set_xticklabels(keep, rotation=60, ha="right", fontsize=7)
    ax.set_yticklabels(keep, fontsize=7)
    ax.set_title(
        f"Microstructure features - Spearman correlation (N={len(df)})"
    )
    fig.colorbar(im, ax=ax, fraction=0.04, pad=0.02)
    fig.tight_layout()
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    # High-correlation pairs (|rho| > threshold, off-diagonal, upper triangle).
    pairs: list[dict[str, Any]] = []
    for i, a in enumerate(keep):
        for b in keep[i + 1 :]:
            rho = corr.loc[a, b]
            if pd.notna(rho) and abs(rho) > HIGH_CORRELATION_THRESHOLD:
                pairs.append({"a": a, "b": b, "rho": float(rho)})
    pairs.sort(key=lambda p: abs(p["rho"]), reverse=True)

    # Dropped constants (reported for transparency).
    dropped_constants = sorted(set(features) - set(keep))

    summary = (
        f"{len(pairs)} feature pair(s) with |rho| > "
        f"{HIGH_CORRELATION_THRESHOLD}. "
        f"{len(dropped_constants)} constant column(s) excluded."
    )

    return {
        "id": "q2_correlation",
        "summary": summary,
        "n_features_analyzed": len(keep),
        "high_correlations": pairs,
        "dropped_constant_columns": dropped_constants,
    }


# ---------------------------------------------------------------------------
# Q3: Spread widening zero-rate
# ---------------------------------------------------------------------------


def q3_spread_zero_rate(df: pd.DataFrame, out_path: Path) -> dict[str, Any]:
    """Per-symbol rate of ``spread_widening_max_zscore == 0``.

    If any symbol exceeds ``SPREAD_ZERO_RATE_THRESHOLD`` the findings dict
    includes a ``recommendation`` string for a Phase 4c follow-up.
    """
    col = "spread_widening_max_zscore"
    per_symbol: dict[str, dict[str, float | int]] = {}
    for sym, grp in df.groupby("symbol", observed=True):
        zero_rate = float((grp[col] == 0).mean()) if len(grp) else 0.0
        per_symbol[str(sym)] = {
            "zero_rate": zero_rate,
            "n_rows": int(len(grp)),
        }

    fig, ax = plt.subplots(figsize=PLOT_FIGSIZE_SINGLE)
    syms = list(per_symbol.keys())
    rates = [per_symbol[s]["zero_rate"] for s in syms]
    colors = [
        COLORS["red"] if r > SPREAD_ZERO_RATE_THRESHOLD else COLORS["green"]
        for r in rates
    ]
    ax.bar(syms, rates, color=colors, edgecolor="#222")
    ax.axhline(
        SPREAD_ZERO_RATE_THRESHOLD,
        color=COLORS["gray"],
        linestyle="--",
        linewidth=1,
        label=f"threshold = {SPREAD_ZERO_RATE_THRESHOLD}",
    )
    ax.set_ylim(0, 1)
    ax.set_ylabel("fraction of rows with spread_widening_max_zscore == 0")
    ax.set_title("Spread widening zero-rate by symbol")
    for i, r in enumerate(rates):
        ax.text(i, r + 0.02, f"{r:.2%}", ha="center", fontsize=9)
    ax.legend(loc="upper right")
    fig.tight_layout()
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    trigger = {
        s: v["zero_rate"]
        for s, v in per_symbol.items()
        if v["zero_rate"] > SPREAD_ZERO_RATE_THRESHOLD
    }
    result: dict[str, Any] = {
        "id": "q3_spread_zero_rate",
        "per_symbol": per_symbol,
        "threshold": SPREAD_ZERO_RATE_THRESHOLD,
    }
    if trigger:
        trigger_repr = ", ".join(f"{k}={v:.2%}" for k, v in trigger.items())
        result["summary"] = (
            f"Spread-widening zero-rate exceeds {SPREAD_ZERO_RATE_THRESHOLD:.0%} "
            f"for: {trigger_repr}."
        )
        result["recommendation"] = (
            "Phase 4c follow-up: change the per-minute spread aggregator from "
            "percentile_cont(0.5) (median) to MAX(ask_px_00 - bid_px_00) or "
            "percentile_cont(0.95) so a single widened quote within a minute "
            "can register in the z-score. The median is constant at one tick "
            "on ES, killing the signal."
        )
    else:
        result["summary"] = (
            f"Spread-widening zero-rate below {SPREAD_ZERO_RATE_THRESHOLD:.0%} "
            "for all symbols; feature retains signal."
        )
    return result


# ---------------------------------------------------------------------------
# Q4: Returns / regime distribution
# ---------------------------------------------------------------------------


def q4_returns(df: pd.DataFrame, out_path: Path) -> dict[str, Any]:
    """ret_day + ret_5d histograms and per-symbol class counts.

    Operates on the outcome-augmented frame produced by ``derive_outcomes``.
    """
    if "ret_day" not in df.columns:
        raise ValueError("q4_returns requires outcome columns; call derive_outcomes first")

    fig, axes = plt.subplots(2, 2, figsize=PLOT_FIGSIZE_GRID[0:1] + (10,))
    # Top row: ret_day and ret_5d histograms (all symbols combined).
    rd = df["ret_day"].dropna()
    r5 = df["ret_5d"].dropna()
    axes[0, 0].hist(rd, bins=40, color=COLORS["blue"], edgecolor="#222")
    axes[0, 0].axvline(OUTCOME_UP_THRESHOLD, color=COLORS["green"], linestyle="--")
    axes[0, 0].axvline(OUTCOME_DOWN_THRESHOLD, color=COLORS["red"], linestyle="--")
    axes[0, 0].set_title(f"ret_day (n={len(rd)})")
    axes[0, 0].set_xlabel("ret_day")

    axes[0, 1].hist(r5, bins=40, color=COLORS["purple"], edgecolor="#222")
    axes[0, 1].set_title(f"ret_5d (n={len(r5)})")
    axes[0, 1].set_xlabel(f"ret_{FORWARD_DAYS}d")

    # Bottom row: per-symbol regime class counts.
    per_symbol: dict[str, dict[str, Any]] = {}
    syms = sorted(df["symbol"].unique())
    ax_counts = axes[1, 0]
    ax_scatter = axes[1, 1]

    bar_w = 0.25
    xs = np.arange(len(syms))
    for i, cls in enumerate(["up", "flat", "down"]):
        counts = [
            int(((df["symbol"] == s) & (df["regime_label"] == cls)).sum())
            for s in syms
        ]
        ax_counts.bar(
            xs + (i - 1) * bar_w,
            counts,
            bar_w,
            label=cls,
            color={"up": COLORS["green"], "flat": COLORS["gray"], "down": COLORS["red"]}[cls],
            edgecolor="#222",
        )
    ax_counts.set_xticks(xs)
    ax_counts.set_xticklabels(syms)
    ax_counts.set_title("Regime class counts by symbol")
    ax_counts.legend()

    # Scatter: ret_day vs ret_5d (where both present), colored by regime.
    has_both = df.dropna(subset=["ret_day", "ret_5d"])
    color_map = {"up": COLORS["green"], "flat": COLORS["gray"], "down": COLORS["red"]}
    colors = [color_map[r] for r in has_both["regime_label"]]
    ax_scatter.scatter(has_both["ret_day"], has_both["ret_5d"], c=colors, s=10, alpha=0.5)
    ax_scatter.axhline(0, color="#888", linewidth=0.5)
    ax_scatter.axvline(0, color="#888", linewidth=0.5)
    ax_scatter.set_xlabel("ret_day")
    ax_scatter.set_ylabel(f"ret_{FORWARD_DAYS}d")
    ax_scatter.set_title(f"ret_day vs ret_{FORWARD_DAYS}d (n={len(has_both)})")

    for sym in syms:
        grp = df[df["symbol"] == sym]
        rd_sym = grp["ret_day"].dropna()
        r5_sym = grp["ret_5d"].dropna()
        class_counts = grp["regime_label"].value_counts().to_dict()
        per_symbol[str(sym)] = {
            "n_rows": int(len(grp)),
            "ret_day_mean": float(rd_sym.mean()) if len(rd_sym) else float("nan"),
            "ret_day_std": float(rd_sym.std(ddof=0)) if len(rd_sym) else float("nan"),
            "ret_5d_mean": float(r5_sym.mean()) if len(r5_sym) else float("nan"),
            "ret_5d_std": float(r5_sym.std(ddof=0)) if len(r5_sym) else float("nan"),
            "class_counts": {
                "up": int(class_counts.get("up", 0)),
                "flat": int(class_counts.get("flat", 0)),
                "down": int(class_counts.get("down", 0)),
            },
        }

    fig.suptitle(f"Outcome distributions (N={len(df)})")
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    return {
        "id": "q4_returns",
        "summary": (
            f"ret_day n={len(rd)}, ret_5d n={len(r5)} across "
            f"{len(syms)} symbol(s)."
        ),
        "forward_days": FORWARD_DAYS,
        "up_threshold": OUTCOME_UP_THRESHOLD,
        "down_threshold": OUTCOME_DOWN_THRESHOLD,
        "per_symbol": per_symbol,
    }


# ---------------------------------------------------------------------------
# Q5: Feature -> ret_day Spearman, Bonferroni-corrected
# ---------------------------------------------------------------------------


def q5_feature_vs_return(df: pd.DataFrame, out_path: Path) -> dict[str, Any]:
    """Spearman rho between each feature and ret_day, per symbol.

    Bonferroni-corrected: p_bonf = min(1, p * n_features * n_symbols). The
    correction divisor is derived from the DataFrame so the rule is invariant
    to feature-set changes.

    Excludes ``is_degraded=True`` rows — these are deliberate outliers for
    signal validation, not normal market behavior.
    """
    features = _numeric_feature_columns(df)
    # Drop the trivial "trade_count" (already excluded via META_COLUMNS) and
    # any constant columns. Note: trade_count IS in META_COLUMNS by design.
    # Drop constants.
    features = [f for f in features if df[f].nunique(dropna=True) > 1]

    clean = df[~df["is_degraded"]].dropna(subset=["ret_day"]) if "is_degraded" in df.columns else df.dropna(subset=["ret_day"])
    symbols = sorted(clean["symbol"].unique())
    n_tests = max(1, len(features) * len(symbols))

    per_symbol: dict[str, list[dict[str, Any]]] = {}
    significant_features: set[str] = set()

    for sym in symbols:
        grp = clean[clean["symbol"] == sym]
        rows: list[dict[str, Any]] = []
        for feat in features:
            pair = grp[[feat, "ret_day"]].dropna()
            if len(pair) < 10 or pair[feat].nunique() < 2:
                rows.append(
                    {
                        "feature": feat,
                        "spearman": float("nan"),
                        "p_value": float("nan"),
                        "p_bonf": float("nan"),
                        "n": int(len(pair)),
                        "significant": False,
                    }
                )
                continue
            rho, p = stats.spearmanr(pair[feat], pair["ret_day"])
            p_bonf = min(1.0, float(p) * n_tests) if pd.notna(p) else float("nan")
            significant = bool(pd.notna(p_bonf) and p_bonf < 0.05)
            if significant:
                significant_features.add(feat)
            rows.append(
                {
                    "feature": feat,
                    "spearman": float(rho),
                    "p_value": float(p),
                    "p_bonf": p_bonf,
                    "n": int(len(pair)),
                    "significant": significant,
                }
            )
        rows.sort(key=lambda r: abs(r["spearman"]) if pd.notna(r["spearman"]) else -1, reverse=True)
        per_symbol[str(sym)] = rows[:CORRELATION_RANK_TOP_N]

    # Ranked bar plot: one subplot per symbol.
    ncols = len(symbols) if symbols else 1
    fig, axes = plt.subplots(
        1, ncols, figsize=(6 * ncols, 7), sharey=False
    )
    if ncols == 1:
        axes = [axes]
    for ax, sym in zip(axes, symbols):
        rows = per_symbol[str(sym)]
        feats = [r["feature"] for r in rows]
        rhos = [r["spearman"] if pd.notna(r["spearman"]) else 0 for r in rows]
        colors = [
            COLORS["green"] if r["significant"] else COLORS["gray"] for r in rows
        ]
        ax.barh(feats[::-1], rhos[::-1], color=colors[::-1], edgecolor="#222")
        ax.axvline(0, color="#888", linewidth=0.5)
        ax.set_title(
            f"{sym} - Spearman rho (top {len(rows)})\n"
            f"green = p_bonf < 0.05 (n_tests={n_tests})",
            fontsize=10,
        )
        ax.set_xlabel("Spearman rho (feature vs ret_day)")
        ax.tick_params(labelsize=8)

    fig.suptitle(
        f"Feature -> ret_day Spearman, Bonferroni-corrected "
        f"(n_features={len(features)}, n_symbols={len(symbols)}, n_tests={n_tests})"
    )
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    summary = (
        f"{len(significant_features)} feature(s) with p_bonf < 0.05 "
        f"across {len(symbols)} symbol(s) (n_tests = "
        f"{len(features)} features x {len(symbols)} symbols = {n_tests})."
    )

    # Convenience keys for schema parity with the spec.
    result: dict[str, Any] = {
        "id": "q5_feature_vs_return",
        "summary": summary,
        "n_tests": n_tests,
        "n_features": len(features),
        "n_symbols": len(symbols),
        "bonferroni_alpha": 0.05 / n_tests,
    }
    for sym in symbols:
        result[f"top_features_{str(sym).lower()}"] = per_symbol[str(sym)]

    return result


# ---------------------------------------------------------------------------
# Q6: Cohort analysis (top vs bottom quartile of top-3 Q5 features)
# ---------------------------------------------------------------------------


def q6_cohorts(
    df: pd.DataFrame,
    out_path: Path,
    top_features: list[str],
) -> dict[str, Any]:
    """Compare ret_day between top-quartile and bottom-quartile cohorts.

    Uses Mann-Whitney U (non-parametric, no normality assumption). Excludes
    ``is_degraded=True`` rows.
    """
    clean = df[~df["is_degraded"]].dropna(subset=["ret_day"]) if "is_degraded" in df.columns else df.dropna(subset=["ret_day"])

    cohorts: list[dict[str, Any]] = []
    usable = [f for f in top_features if f in clean.columns]
    ncols = max(1, len(usable))

    if usable:
        fig, axes = plt.subplots(1, ncols, figsize=(5 * ncols, 6), sharey=True)
        if ncols == 1:
            axes = [axes]
    else:
        # No usable features -> write a placeholder plot so the orchestrator
        # can rely on the PNG existing.
        fig, ax = plt.subplots(figsize=PLOT_FIGSIZE_SINGLE)
        ax.text(
            0.5,
            0.5,
            "No usable top features for cohort analysis.",
            ha="center",
            va="center",
            transform=ax.transAxes,
        )
        ax.axis("off")
        fig.tight_layout()
        fig.savefig(out_path, dpi=PLOT_DPI)
        plt.close(fig)
        return {
            "id": "q6_cohorts",
            "summary": "No usable top features for cohort analysis.",
            "quantile": COHORT_QUANTILE,
            "cohorts": [],
        }

    for ax, feat in zip(axes, usable):
        valid = clean[[feat, "ret_day"]].dropna()
        if len(valid) < 8 or valid[feat].nunique() < 4:
            cohorts.append(
                {
                    "feature": feat,
                    "status": "insufficient_data",
                    "n": int(len(valid)),
                }
            )
            ax.set_title(f"{feat}\n(insufficient data)")
            ax.axis("off")
            continue
        lo = valid[feat].quantile(COHORT_QUANTILE)
        hi = valid[feat].quantile(1.0 - COHORT_QUANTILE)
        bottom = valid[valid[feat] <= lo]["ret_day"]
        top = valid[valid[feat] >= hi]["ret_day"]
        if len(bottom) < 4 or len(top) < 4:
            cohorts.append(
                {
                    "feature": feat,
                    "status": "insufficient_cohort",
                    "n_bottom": int(len(bottom)),
                    "n_top": int(len(top)),
                }
            )
            ax.set_title(f"{feat}\n(small cohorts)")
            ax.axis("off")
            continue

        try:
            u_stat, p = stats.mannwhitneyu(top, bottom, alternative="two-sided")
        except ValueError:
            u_stat, p = float("nan"), float("nan")

        cohorts.append(
            {
                "feature": feat,
                "quantile": COHORT_QUANTILE,
                "n_bottom": int(len(bottom)),
                "n_top": int(len(top)),
                "bottom_median_ret_day": float(bottom.median()),
                "top_median_ret_day": float(top.median()),
                "bottom_mean_ret_day": float(bottom.mean()),
                "top_mean_ret_day": float(top.mean()),
                "mannwhitney_u": float(u_stat) if pd.notna(u_stat) else None,
                "mannwhitney_p": float(p) if pd.notna(p) else None,
                "significant": bool(pd.notna(p) and p < 0.05),
            }
        )

        data = [bottom, top]
        bp = ax.boxplot(
            data,
            tick_labels=[f"Q1\nn={len(bottom)}", f"Q4\nn={len(top)}"],
            patch_artist=True,
            showfliers=False,
        )
        for patch, c in zip(bp["boxes"], [COLORS["red"], COLORS["green"]]):
            patch.set_facecolor(c)
            patch.set_alpha(0.6)
        ax.set_title(f"{feat}\np={p:.4f}" if pd.notna(p) else feat)
        ax.axhline(0, color="#888", linewidth=0.5)
        ax.set_ylabel("ret_day")

    fig.suptitle(
        f"Cohort analysis - Q1 vs Q4 on top-{len(usable)} features"
    )
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    fig.savefig(out_path, dpi=PLOT_DPI)
    plt.close(fig)

    n_sig = sum(1 for c in cohorts if c.get("significant"))
    summary = (
        f"Cohort analysis on {len(usable)} feature(s); "
        f"{n_sig} with Mann-Whitney p < 0.05."
    )
    return {
        "id": "q6_cohorts",
        "summary": summary,
        "quantile": COHORT_QUANTILE,
        "cohorts": cohorts,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def _pick_top_features(q5_result: dict[str, Any], top_n: int = 3) -> list[str]:
    """Union top-N |rho| features across all symbols from the Q5 output."""
    seen: list[str] = []
    # Iterate sorted keys so output is deterministic across runs.
    for key in sorted(q5_result.keys()):
        if not key.startswith("top_features_"):
            continue
        rows = q5_result[key]
        for r in rows[:top_n]:
            feat = r.get("feature")
            if feat and feat not in seen:
                seen.append(feat)
    return seen


def run_all_questions(
    feature_path: Path,
    ohlcv_glob: str,
    symbology_path: str,
    plots_dir: Path,
    findings_path: Path,
) -> dict[str, Any]:
    """Run Q1..Q6 end-to-end and write all PNGs + findings JSON.

    Returns the findings dict (also written to ``findings_path``).
    """
    feature_path = feature_path.expanduser().resolve()
    plots_dir = plots_dir.expanduser().resolve()
    findings_path = findings_path.expanduser().resolve()
    plots_dir.mkdir(parents=True, exist_ok=True)
    findings_path.parent.mkdir(parents=True, exist_ok=True)

    log.info("Loading feature Parquet: %s", feature_path)
    features_df = pd.read_parquet(feature_path)
    log.info("Loaded %d feature rows", len(features_df))

    log.info("Deriving outcomes (ret_day, ret_5d, regime_label)")
    enriched = derive_outcomes(features_df, ohlcv_glob, symbology_path)
    log.info("After outcome join: %d rows", len(enriched))

    q1 = q1_distributions(features_df, plots_dir / "microstructure_q1_distributions.png")
    q2 = q2_correlation(features_df, plots_dir / "microstructure_q2_correlation.png")
    q3 = q3_spread_zero_rate(
        features_df, plots_dir / "microstructure_q3_spread_zero_rate.png"
    )
    q4 = q4_returns(enriched, plots_dir / "microstructure_q4_returns.png")
    q5 = q5_feature_vs_return(
        enriched, plots_dir / "microstructure_q5_feature_vs_return.png"
    )
    top_features = _pick_top_features(q5, top_n=3)
    q6 = q6_cohorts(
        enriched, plots_dir / "microstructure_q6_cohorts.png", top_features
    )

    date_vals = features_df["date"]
    findings: dict[str, Any] = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "feature_file": str(feature_path),
        "outcome_source": ohlcv_glob,
        "n_rows": int(len(features_df)),
        "n_symbols": int(features_df["symbol"].nunique()),
        "date_range": {
            "start": str(date_vals.min()),
            "end": str(date_vals.max()),
        },
        "questions": [q1, q2, q3, q4, q5, q6],
    }

    findings_path.write_text(json.dumps(findings, indent=2, default=str) + "\n")
    log.info("Wrote findings -> %s", findings_path)
    return findings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Phase 4d microstructure EDA over the Phase 4c feature Parquet.",
    )
    parser.add_argument(
        "--features",
        required=True,
        type=Path,
        help="Path to microstructure_daily.parquet.",
    )
    parser.add_argument(
        "--ohlcv-root",
        required=True,
        type=Path,
        help="Archive root containing ohlcv_1m/year=*/part.parquet and symbology.parquet.",
    )
    parser.add_argument(
        "--plots-dir",
        required=True,
        type=Path,
        help="Output directory for PNG plots.",
    )
    parser.add_argument(
        "--findings",
        required=True,
        type=Path,
        help="Output path for findings_microstructure.json.",
    )
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
    )

    ohlcv_root = args.ohlcv_root.expanduser().resolve()
    ohlcv_glob = str(ohlcv_root / "ohlcv_1m" / "year=*" / "part.parquet")
    symbology_path = str(ohlcv_root / "symbology.parquet")

    try:
        run_all_questions(
            feature_path=args.features,
            ohlcv_glob=ohlcv_glob,
            symbology_path=symbology_path,
            plots_dir=args.plots_dir,
            findings_path=args.findings,
        )
    except Exception as exc:
        log.error("EDA failed: %s", exc, exc_info=args.verbose)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
