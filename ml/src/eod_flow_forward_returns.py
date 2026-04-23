"""
Bot EOD options flow — forward-return validation (Phase 2).

For every burst candidate produced by the 1-min and 5-min pipelines,
join the bucket against the same-day minute-median underlying spot
series (self-derived from `underlying_price` on every print) and
compute signed forward returns at 1m, 5m, 15m, 30m, 60m horizons.

Answers: do bursts predict the move, and at what lag?

Direction convention (signed_ret > 0 = burst "predicted correctly"):
  call + buy-dominant  → +1  (bullish expectation)
  call + sell-dominant → -1  (bearish expectation)
  put  + buy-dominant  → -1  (bearish — user's primary thesis)
  put  + sell-dominant → +1  (bullish — premium harvesting)

Outputs under `ml/plots/eod-flow-forward-returns/`:
  bucket={N}min/date=YYYY-MM-DD/candidates_with_returns.csv
  bucket={N}min/summary.csv                   — per-horizon aggregate
  score_vs_return_{N}min.png                  — score decile × horizon grid
  bucket_size_comparison.png                  — 1min vs 5min at each horizon

Plus a summary block in `ml/findings.json` under
`eod_flow_forward_returns`.

Usage:
  ml/.venv/bin/python src/eod_flow_forward_returns.py
"""

from __future__ import annotations

import sys
import time

try:
    import duckdb
    import matplotlib.pyplot as plt
    import numpy as np
    import pandas as pd
    import seaborn as sns
except ImportError as e:
    print(f"Missing dependency: {e}")
    print("  ml/.venv/bin/pip install duckdb pandas matplotlib seaborn")
    sys.exit(1)

from utils import (  # noqa: E402
    ML_ROOT,
    save_section_findings,
    section,
    subsection,
    takeaway,
)

FLOW_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow"
BUCKETS_PARQUET_ROOT = ML_ROOT / "data" / "eod-flow-buckets"
PLOT_ROOT = ML_ROOT / "plots" / "eod-flow-forward-returns"
PLOT_ROOT.mkdir(parents=True, exist_ok=True)

BUCKET_SIZES: tuple[int, ...] = (1, 5)
HORIZONS_MIN: tuple[int, ...] = (1, 5, 15, 30, 60)
# Match the defaults in eod_flow_bursts.py so we rank the same universe.
MIN_PREMIUM_FLOOR = 10_000.0
MIN_MONEYNESS_PCT = 0.003
CANDIDATE_FLOOR = 0.90
# Tolerance for the asof-merge spot lookup. 90s covers per-minute
# granularity plus a bit of slack.
TOLERANCE = pd.Timedelta(seconds=90)

# Path-analysis observation window after the burst ends. 0DTE expires
# at market close, so we cap at 20:00 UTC (15:00 CT = regular session
# close) and at 120 minutes after bucket_end, whichever is earlier.
PATH_MAX_MINUTES = 120
SESSION_END_UTC_HOUR = 20  # 15:00 CT regular-session close

sns.set_theme(style="darkgrid", palette="muted")
plt.rcParams.update(
    {
        "figure.facecolor": "#1a1a2e",
        "axes.facecolor": "#16213e",
        "axes.edgecolor": "#555",
        "axes.labelcolor": "#ccc",
        "text.color": "#ccc",
        "xtick.color": "#aaa",
        "ytick.color": "#aaa",
        "grid.color": "#333",
        "grid.alpha": 0.5,
        "font.size": 9,
        "text.parse_math": False,
    }
)

COLORS = {
    "buy": "#2ecc71",
    "sell": "#e74c3c",
    "mid": "#95a5a6",
    "blue": "#3498db",
    "orange": "#f39c12",
    "purple": "#9b59b6",
}


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


# ── Candidate ranking (same logic as eod_flow_bursts.py) ─────


def _rank_candidates(conn: duckdb.DuckDBPyConnection, bucket_min: int) -> pd.DataFrame:
    glob = str(
        BUCKETS_PARQUET_ROOT / f"bucket={bucket_min}min" / "date=*" / "data.parquet"
    )
    return conn.execute(
        f"""
        WITH raw AS (
            SELECT
                *,
                CAST(bucket_start AS DATE) AS date
            FROM read_parquet('{glob}', hive_partitioning = true)
            WHERE total_premium >= {MIN_PREMIUM_FLOOR}
              AND abs(moneyness_pct) >= {MIN_MONEYNESS_PCT}
              AND is_otm = TRUE
        ),
        scored AS (
            -- Score formula calibrated from eod_flow_premium_threshold.py:
            -- reward near-ATM + high premium; zero-out proximity bonus
            -- beyond 1% OTM (empirically no touch signal there).
            SELECT
                *,
                CAST(
                    log10(1 + total_premium)
                    + 3.0 * GREATEST(0, 1 - abs(moneyness_pct) / 0.010)
                    + (COALESCE(buy_premium_pct, 0.5) - 0.5)
                    AS DOUBLE
                ) AS composite_score
            FROM raw
        ),
        thresh AS (
            SELECT symbol, date,
                   quantile_cont(composite_score, {CANDIDATE_FLOOR}) AS floor_score
            FROM scored
            GROUP BY 1, 2
        ),
        ranked AS (
            SELECT s.*
            FROM scored s
            JOIN thresh t USING (symbol, date)
            WHERE s.composite_score >= t.floor_score
        )
        SELECT
            date, symbol, option_chain_id, bucket_start, bucket_end,
            strike, option_type, expiry,
            is_otm, n_prints, total_volume, total_premium,
            buy_premium_pct, bucket_spot, moneyness_pct, composite_score
        FROM ranked
        ORDER BY date ASC, composite_score DESC
        """
    ).fetchdf()


# ── Spot series (minute-median, self-derived) ────────────


def _load_minute_spot(conn: duckdb.DuckDBPyConnection, date_str: str) -> pd.DataFrame:
    """Per-minute spot series per symbol with MIN/MAX/MEDIAN.

    Returns columns: symbol, ts, spot (median), spot_min, spot_max.
    Min/max are needed for touch detection — a 1-second tick through
    the strike would vanish under a minute-median but survives as the
    minute's high or low.
    """
    parquet = FLOW_PARQUET_ROOT / f"date={date_str}" / "data.parquet"
    if not parquet.exists():
        return pd.DataFrame(columns=["symbol", "ts", "spot", "spot_min", "spot_max"])
    df = conn.execute(
        f"""
        SELECT
            underlying_symbol AS symbol,
            time_bucket(INTERVAL 1 MINUTE, executed_at) AS ts,
            MEDIAN(underlying_price) AS spot,
            MIN(underlying_price)    AS spot_min,
            MAX(underlying_price)    AS spot_max
        FROM read_parquet({_sql_string(str(parquet))})
        WHERE underlying_price IS NOT NULL
        GROUP BY 1, 2
        ORDER BY 1, 2
        """
    ).fetchdf()
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    for col in ("spot", "spot_min", "spot_max"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.dropna(subset=["spot"])


# ── Forward-return attachment ────────────────────────────


def _attach_forward_returns(
    candidates: pd.DataFrame, spot_by_symbol_date: dict
) -> pd.DataFrame:
    """Add base_spot and ret_fwd_{N}m for each horizon.

    Uses pandas.merge_asof per (symbol, date). Direction 'nearest'
    with a 90-second tolerance — we want the closest spot reading
    even if the bucket_end landed a few seconds past the top of the
    minute.
    """
    out = candidates.copy()
    out["bucket_end"] = pd.to_datetime(out["bucket_end"], utc=True)
    out["base_spot"] = np.nan
    for h in HORIZONS_MIN:
        out[f"ret_fwd_{h}m"] = np.nan

    # Group once, iterate per (symbol, date).
    for (symbol, date), group in out.groupby(["symbol", "date"], sort=False):
        spot = spot_by_symbol_date.get((symbol, str(date)))
        if spot is None or spot.empty:
            continue

        sub = group.sort_values("bucket_end")
        idx = sub.index

        # Base spot at bucket_end.
        merged = pd.merge_asof(
            sub[["bucket_end"]].reset_index(drop=True),
            spot[["ts", "spot"]].sort_values("ts"),
            left_on="bucket_end",
            right_on="ts",
            direction="nearest",
            tolerance=TOLERANCE,
        )
        out.loc[idx, "base_spot"] = merged["spot"].to_numpy()

        for h in HORIZONS_MIN:
            target = sub["bucket_end"] + pd.Timedelta(minutes=h)
            tgt = pd.DataFrame({"target_ts": target.reset_index(drop=True)})
            fwd = pd.merge_asof(
                tgt,
                spot[["ts", "spot"]].sort_values("ts"),
                left_on="target_ts",
                right_on="ts",
                direction="nearest",
                tolerance=TOLERANCE,
            )
            fwd_spot = fwd["spot"].to_numpy()
            base = merged["spot"].to_numpy()
            with np.errstate(invalid="ignore", divide="ignore"):
                out.loc[idx, f"ret_fwd_{h}m"] = (fwd_spot - base) / base

    return out


def _attach_direction_and_signed(df: pd.DataFrame) -> pd.DataFrame:
    """Add two signed-return families:

    `toward_ret_{h}m`  — strike-as-magnet hypothesis.
        direction = +1 for OTM calls (strike above spot), -1 for OTM
        puts (strike below spot). Positive values mean spot drifted
        toward the strike over the horizon. Aggression (buy vs sell)
        is irrelevant here; the hypothesis is that concentrated
        volume at a strike creates gravity.

    `signed_ret_{h}m`  — aggression-predicts-direction hypothesis.
        direction = (+1 for call, -1 for put) × (+1 if buy-dominant).
        Positive means the burst's implied directional bet was correct.
    """
    d = df.copy()
    call_sign = d["option_type"].map({"call": 1, "put": -1}).fillna(0).astype(int)
    buy_sign = np.where(d["buy_premium_pct"] > 0.5, 1, -1)
    d["direction_toward_strike"] = call_sign
    d["direction_by_burst"] = call_sign * buy_sign
    for h in HORIZONS_MIN:
        d[f"toward_ret_{h}m"] = d[f"ret_fwd_{h}m"] * d["direction_toward_strike"]
        d[f"signed_ret_{h}m"] = d[f"ret_fwd_{h}m"] * d["direction_by_burst"]
    return d


# ── Path analysis (touch / MFE / MAE) ────────────────────


def _attach_path_stats(
    candidates: pd.DataFrame,
    spot_by_symbol_date: dict,
) -> pd.DataFrame:
    """For each candidate, compute post-burst price-path statistics.

    Observation window: (bucket_end, min(bucket_end + PATH_MAX_MINUTES,
    session_end_utc)]. For each candidate, walk minute spot bars and
    track:

      distance_to_strike_bps  — how far the strike is from base_spot
                                at bucket_end (always >= 0).
      touched_strike          — did any minute's high/low cross the
                                strike in the direction-toward-strike
                                (uses spot_max for calls, spot_min for
                                puts).
      minutes_to_touch        — time from bucket_end to the first
                                minute that crossed (or NaN).
      peak_toward_bps         — MFE. Largest directional move toward
                                the strike, in bps of base_spot. Always
                                >= 0 (floor at 0 means "never moved
                                toward strike even once").
      peak_against_bps        — MAE. Largest directional move AGAINST
                                the strike, expressed as positive
                                magnitude. Always >= 0.
      minutes_to_peak_toward  — time at which MFE was achieved.
      end_of_window_ret_bps   — directional return at the end of the
                                observation window.
    """
    out = candidates.copy()
    new_cols = [
        "distance_to_strike_bps",
        "touched_strike",
        "minutes_to_touch",
        "peak_toward_bps",
        "peak_against_bps",
        "minutes_to_peak_toward",
        "minutes_to_peak_against",
        "end_of_window_ret_bps",
        "window_minutes",
    ]
    for c in new_cols:
        out[c] = np.nan
    out["touched_strike"] = False

    for (symbol, date), group in out.groupby(["symbol", "date"], sort=False):
        spot = spot_by_symbol_date.get((symbol, str(date)))
        if spot is None or spot.empty:
            continue
        spot_sorted = spot.sort_values("ts").reset_index(drop=True)

        for idx, row in group.iterrows():
            bucket_end = pd.to_datetime(row["bucket_end"])
            base_spot = row.get("base_spot")
            strike = row["strike"]
            direction = row["direction_toward_strike"]
            if pd.isna(base_spot) or base_spot <= 0 or direction == 0:
                continue

            # Session-end cap (20:00 UTC = 15:00 CT regular close).
            session_end = bucket_end.replace(
                hour=SESSION_END_UTC_HOUR, minute=0, second=0, microsecond=0
            )
            hard_cap = bucket_end + pd.Timedelta(minutes=PATH_MAX_MINUTES)
            window_end = min(session_end, hard_cap)
            if window_end <= bucket_end:
                continue

            mask = (spot_sorted["ts"] > bucket_end) & (spot_sorted["ts"] <= window_end)
            window = spot_sorted.loc[mask]
            if window.empty:
                continue

            # Distance to strike in bps (always positive).
            dist_bps = float(abs(strike - base_spot) / base_spot * 1e4)
            out.at[idx, "distance_to_strike_bps"] = dist_bps

            # Touch detection uses per-minute extremes: for calls
            # (direction=+1), we need spot_max >= strike. For puts
            # (direction=-1), spot_min <= strike.
            if direction > 0:
                touch_mask = window["spot_max"] >= strike
            else:
                touch_mask = window["spot_min"] <= strike

            if touch_mask.any():
                first_touch_ts = window.loc[touch_mask, "ts"].iloc[0]
                out.at[idx, "touched_strike"] = True
                out.at[idx, "minutes_to_touch"] = float(
                    (first_touch_ts - bucket_end).total_seconds() / 60.0
                )

            # Directional path in bps: (spot - base) / base × direction.
            # For calls: spot_max produces best-case toward, spot_min worst.
            # For puts: spot_min toward, spot_max against. Reuse by
            # swapping based on sign.
            if direction > 0:
                toward_series = window["spot_max"]
                against_series = window["spot_min"]
            else:
                toward_series = window["spot_min"]
                against_series = window["spot_max"]

            toward_bps = (toward_series - base_spot) / base_spot * direction * 1e4
            against_bps = (against_series - base_spot) / base_spot * direction * 1e4

            mfe_val = float(toward_bps.max())
            out.at[idx, "peak_toward_bps"] = max(mfe_val, 0.0)
            if mfe_val > 0:
                mfe_ts = window.loc[toward_bps.idxmax(), "ts"]
                out.at[idx, "minutes_to_peak_toward"] = float(
                    (mfe_ts - bucket_end).total_seconds() / 60.0
                )

            mae_val = float(against_bps.min())
            # MAE expressed as positive magnitude; 0 if price never
            # moved against strike at all during window.
            out.at[idx, "peak_against_bps"] = max(-mae_val, 0.0)
            if mae_val < 0:
                mae_ts = window.loc[against_bps.idxmin(), "ts"]
                out.at[idx, "minutes_to_peak_against"] = float(
                    (mae_ts - bucket_end).total_seconds() / 60.0
                )

            last_row = window.iloc[-1]
            end_ret = (last_row["spot"] - base_spot) / base_spot * direction * 1e4
            out.at[idx, "end_of_window_ret_bps"] = float(end_ret)
            out.at[idx, "window_minutes"] = float(
                (last_row["ts"] - bucket_end).total_seconds() / 60.0
            )

    return out


# ── Aggregates + plots ───────────────────────────────────


def _summarize(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """Per-horizon summary for the strike-as-magnet hypothesis.

    Primary metric: toward_ret_{h}m. Secondary: signed_ret_{h}m
    (aggression-based) for comparison. 10bps is the intraday-
    noise-floor hit threshold for SPX.
    """
    rows = []
    for h in HORIZONS_MIN:
        t = df[f"toward_ret_{h}m"].dropna()
        s = df[f"signed_ret_{h}m"].dropna()
        rows.append(
            {
                "bucket_min": bucket_min,
                "horizon_min": h,
                "n": int(len(t)),
                "toward_mean_bps": float(t.mean() * 10_000) if len(t) else None,
                "toward_median_bps": (float(t.median() * 10_000) if len(t) else None),
                "toward_hit_10bps": (float((t > 0.0010).mean()) if len(t) else None),
                "toward_p_pos": float((t > 0).mean()) if len(t) else None,
                "burst_mean_bps": float(s.mean() * 10_000) if len(s) else None,
                "burst_p_pos": float((s > 0).mean()) if len(s) else None,
            }
        )
    return pd.DataFrame(rows)


def _summarize_path(df: pd.DataFrame, bucket_min: int) -> pd.DataFrame:
    """Aggregate path-analysis stats by composite-score decile.

    For each decile:
      n                     — candidate count in decile
      touch_pct             — % that touched the strike
      mean_minutes_to_touch — mean time-to-touch (touched only)
      median_dist_bps       — median strike distance at burst
      median_mfe_bps        — median peak toward-strike excursion
      median_mae_bps        — median peak against-strike excursion
      mfe_mae_ratio         — median MFE / median MAE (trading-reward-to-risk)
      mean_end_ret_bps      — mean directional return at end-of-window
    """
    if df.empty or "composite_score" not in df.columns:
        return pd.DataFrame()
    d = df.dropna(subset=["composite_score", "distance_to_strike_bps"]).copy()
    d["decile"] = pd.qcut(d["composite_score"], 10, labels=False, duplicates="drop")

    rows = []
    for dec, grp in d.groupby("decile"):
        n = len(grp)
        touched = grp[grp["touched_strike"]]
        mfe = grp["peak_toward_bps"].dropna()
        mae = grp["peak_against_bps"].dropna()
        med_mfe = float(mfe.median()) if len(mfe) else None
        med_mae = float(mae.median()) if len(mae) else None
        rows.append(
            {
                "bucket_min": bucket_min,
                "decile": int(dec),
                "n": n,
                "touch_pct": float(grp["touched_strike"].mean() * 100),
                "mean_minutes_to_touch": (
                    float(touched["minutes_to_touch"].mean())
                    if not touched.empty
                    else None
                ),
                "median_minutes_to_touch": (
                    float(touched["minutes_to_touch"].median())
                    if not touched.empty
                    else None
                ),
                "median_dist_bps": float(grp["distance_to_strike_bps"].median()),
                "median_mfe_bps": med_mfe,
                "median_mae_bps": med_mae,
                "mfe_mae_ratio": (
                    (med_mfe / med_mae)
                    if med_mfe is not None and med_mae is not None and med_mae > 0
                    else None
                ),
                "mean_end_ret_bps": float(grp["end_of_window_ret_bps"].mean()),
            }
        )
    return pd.DataFrame(rows)


def _plot_score_deciles(df: pd.DataFrame, bucket_min: int) -> None:
    """Mean signed return by composite_score decile, one panel per horizon."""
    if df.empty:
        return
    d = df.dropna(subset=["composite_score"]).copy()
    d["decile"] = pd.qcut(d["composite_score"], 10, labels=False, duplicates="drop")
    fig, axes = plt.subplots(
        1,
        len(HORIZONS_MIN),
        figsize=(3.2 * len(HORIZONS_MIN), 3.8),
        sharey=True,
        constrained_layout=True,
    )
    for ax, h in zip(axes, HORIZONS_MIN, strict=True):
        col = f"toward_ret_{h}m"
        g = d.groupby("decile")[col].agg(["mean", "count"]).dropna()
        if g.empty:
            continue
        means_bps = g["mean"] * 10_000
        bars = ax.bar(
            g.index.astype(int),
            means_bps,
            color=[COLORS["buy"] if v > 0 else COLORS["sell"] for v in means_bps],
            edgecolor="#222",
        )
        ax.axhline(0, color=COLORS["mid"], linewidth=0.8)
        ax.set_title(f"{h}m horizon", color="#fff")
        ax.set_xlabel("score decile (0=low, 9=high)")
        if ax is axes[0]:
            ax.set_ylabel("mean signed return (bps)")
        # Annotate counts.
        for rect, (_, n) in zip(bars, g["count"].items(), strict=True):
            ax.annotate(
                f"n={int(n)}",
                xy=(rect.get_x() + rect.get_width() / 2, 0),
                xytext=(0, -12),
                textcoords="offset points",
                ha="center",
                color="#aaa",
                fontsize=7,
            )
    fig.suptitle(
        f"Burst score → toward-strike forward return by decile "
        f"({bucket_min}-min buckets) — positive = price moved toward the strike",
        color="#fff",
        fontsize=11,
    )
    plt.savefig(PLOT_ROOT / f"score_vs_return_{bucket_min}min.png", dpi=130)
    plt.close(fig)
    print(
        f"  wrote {(PLOT_ROOT / f'score_vs_return_{bucket_min}min.png').relative_to(ML_ROOT)}"
    )


def _plot_bucket_size_comparison(summaries: dict[int, pd.DataFrame]) -> None:
    if not summaries:
        return
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.5), constrained_layout=True)

    width = 0.35
    xs = np.arange(len(HORIZONS_MIN))
    for i, bucket_min in enumerate(sorted(summaries.keys())):
        s = summaries[bucket_min].sort_values("horizon_min")
        offset = (i - 0.5) * width
        label = f"{bucket_min}-min buckets"
        color = COLORS["blue"] if bucket_min == 1 else COLORS["orange"]
        axes[0].bar(
            xs + offset,
            s["toward_mean_bps"].fillna(0),
            width,
            color=color,
            edgecolor="#222",
            label=label,
        )
        axes[1].bar(
            xs + offset,
            s["toward_p_pos"].fillna(0) * 100,
            width,
            color=color,
            edgecolor="#222",
            label=label,
        )
    for ax in axes:
        ax.set_xticks(xs)
        ax.set_xticklabels([f"{h}m" for h in HORIZONS_MIN])
        ax.axhline(0, color=COLORS["mid"], linewidth=0.8)
        ax.legend(loc="best", fontsize=9, facecolor="#1a1a2e", edgecolor="#555")
    axes[0].set_title(
        "Mean toward-strike return (bps) — > 0 = price drifted to strike", color="#fff"
    )
    axes[0].set_ylabel("bps")
    axes[1].set_title("% of bursts where price moved toward strike", color="#fff")
    axes[1].set_ylabel("%")
    axes[1].axhline(50, color="#9b59b6", linewidth=0.8, linestyle="--", alpha=0.6)

    fig.suptitle(
        "Bucket size comparison — strike-as-magnet test at each horizon",
        color="#fff",
        fontsize=12,
    )
    plt.savefig(PLOT_ROOT / "bucket_size_comparison.png", dpi=130)
    plt.close(fig)
    print(f"  wrote {(PLOT_ROOT / 'bucket_size_comparison.png').relative_to(ML_ROOT)}")


# ── Main ─────────────────────────────────────────────────


def _build_spot_cache(
    conn: duckdb.DuckDBPyConnection, dates: list[str]
) -> dict[tuple[str, str], pd.DataFrame]:
    """Return {(symbol, date_str): DataFrame of minute spots}."""
    cache: dict[tuple[str, str], pd.DataFrame] = {}
    for d in dates:
        full = _load_minute_spot(conn, d)
        if full.empty:
            continue
        for sym in full["symbol"].unique():
            cache[(sym, d)] = full[full["symbol"] == sym].copy()
    return cache


def main() -> int:
    section("EOD Flow Forward-Return Validation")

    conn = duckdb.connect()
    conn.execute("PRAGMA threads=4")
    conn.execute("PRAGMA memory_limit='6GB'")

    # Find all dates across both bucket sizes.
    all_dates = sorted(
        {p.name.removeprefix("date=") for p in FLOW_PARQUET_ROOT.glob("date=*")}
    )
    print(f"  dates found: {len(all_dates)} ({all_dates[0]} … {all_dates[-1]})")

    subsection("Build minute-spot cache")
    t0 = time.monotonic()
    spot_cache = _build_spot_cache(conn, all_dates)
    print(
        f"  cache entries: {len(spot_cache)}  (built in {time.monotonic() - t0:.1f}s)"
    )

    summaries: dict[int, pd.DataFrame] = {}
    enriched_all: dict[int, pd.DataFrame] = {}

    for bucket_min in BUCKET_SIZES:
        subsection(f"Rank + enrich: {bucket_min}-min buckets")
        cands = _rank_candidates(conn, bucket_min)
        if cands.empty:
            print(f"  No {bucket_min}-min candidates found.")
            continue
        cands["date"] = pd.to_datetime(cands["date"]).dt.date.astype(str)

        t_enrich = time.monotonic()
        enriched = _attach_forward_returns(cands, spot_cache)
        enriched = _attach_direction_and_signed(enriched)
        enriched = _attach_path_stats(enriched, spot_cache)
        print(
            f"  candidates={len(enriched):,}  "
            f"enriched in {time.monotonic() - t_enrich:.1f}s"
        )

        # Per-day CSVs — now include path stats columns.
        for d in sorted(enriched["date"].unique()):
            day_df = enriched[enriched["date"] == d]
            day_dir = PLOT_ROOT / f"bucket={bucket_min}min" / f"date={d}"
            day_dir.mkdir(parents=True, exist_ok=True)
            day_df.to_csv(day_dir / "candidates_with_returns.csv", index=False)

        # Cross-day horizon summary.
        summary = _summarize(enriched, bucket_min)
        summary.to_csv(
            PLOT_ROOT / f"bucket={bucket_min}min" / "summary.csv", index=False
        )
        print()
        print("  Horizon summary:")
        print(summary.round(3).to_string(index=False))

        # Cross-day path summary by score decile.
        path_summary = _summarize_path(enriched, bucket_min)
        if not path_summary.empty:
            path_summary.to_csv(
                PLOT_ROOT / f"bucket={bucket_min}min" / "path_summary.csv",
                index=False,
            )
            print()
            print("  Path summary by score decile (touch rate, MFE, MAE):")
            print(path_summary.round(2).to_string(index=False))

        summaries[bucket_min] = summary
        enriched_all[bucket_min] = enriched

        _plot_score_deciles(enriched, bucket_min)

    subsection("Bucket-size comparison")
    _plot_bucket_size_comparison(summaries)

    conn.close()

    # Findings summary.
    findings = {
        "horizons_min": list(HORIZONS_MIN),
        "bucket_sizes": list(BUCKET_SIZES),
        "summaries": {bm: summaries[bm].to_dict(orient="records") for bm in summaries},
    }
    save_section_findings("eod_flow_forward_returns", findings)

    # Takeaway: best (bucket, horizon) for the strike-magnet hypothesis.
    if summaries:
        best = None
        for bm, s in summaries.items():
            for _, row in s.iterrows():
                if row["toward_mean_bps"] is None:
                    continue
                if best is None or row["toward_mean_bps"] > best[2]:
                    best = (bm, row["horizon_min"], row["toward_mean_bps"])
        if best:
            takeaway(
                f"Strike-magnet best: {best[0]}-min bucket × {best[1]}-min "
                f"horizon → mean toward-strike return {best[2]:.2f} bps "
                "(positive = price drifted toward the strike)."
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
