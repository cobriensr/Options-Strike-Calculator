"""Periscope EDA 05 — Gamma-level edge experiment.

Tests three pre-registered claims against periscope_analyses.key_levels
joined to spx_candles_1m:

  1. Walls hold (touch-then-reverse vs sham at same distance)
  2. Magnet predicts SPX close better than naive spot
  3. Charm-zero crosses more (or less) frequently than sham

Outputs:
    ml/plots/periscope-eda/gamma_wall_reversal.png
    ml/plots/periscope-eda/gamma_wall_distance_dist.png
    ml/plots/periscope-eda/magnet_predictor_quality.png
    ml/plots/periscope-eda/charm_zero_cross_rates.png
    ml/exports/gamma_wall_events.csv
    ml/findings.json   (appends three blocks)

CLI::

    ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py

Spec: docs/superpowers/specs/periscope-gamma-wall-edge-2026-05-14.md
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

# sys.path mutation must precede the `periscope_gamma_wall_lib` import below;
# ml/conftest.py handles this for pytest, but scripts run directly need to add
# ml/src/ themselves.
_HERE = Path(__file__).resolve().parent
_ML_SRC = _HERE.parent
sys.path.insert(0, str(_ML_SRC))

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import psycopg2  # noqa: E402
from scipy.stats import wilcoxon  # noqa: E402
from statsmodels.stats.contingency_tables import mcnemar  # noqa: E402

from periscope_gamma_wall_lib import (  # noqa: E402
    PRIMARY_BUCKETS,
    compute_charm_zero_event,
    compute_magnet_event,
    compute_wall_event,
    distance_bucket,
    mirror_strike,
)

PLOT_DIR = Path("ml/plots/periscope-eda")
CSV_PATH = Path("ml/exports/gamma_wall_events.csv")
FINDINGS_PATH = Path("ml/findings.json")

BONFERRONI_ALPHA = 0.05 / 3
EFFECT_SIZE_THRESHOLD_PP = 0.10  # 10 percentage points
EFFECT_SIZE_THRESHOLD_MAGNET = 1.0  # 1 SPX point^2 in median squared-error delta


def fetch_reads(database_url: str) -> pd.DataFrame:
    """Fetch periscope_analyses rows with key_levels, before 15:00 CT same day."""
    sql = """
        SELECT
          id                          AS read_id,
          trading_date,
          read_time                   AS read_time_utc,
          spot_at_read_time::float    AS spot_at_read,
          mode,
          calibration_quality,
          (key_levels->>'gamma_ceiling')::float AS wall_ceiling,
          (key_levels->>'gamma_floor')::float   AS wall_floor,
          (key_levels->>'magnet')::float        AS magnet,
          (key_levels->>'charm_zero')::float    AS charm_zero
        FROM periscope_analyses
        WHERE mode IN ('pre_trade', 'intraday')
          AND read_time < ((trading_date + INTERVAL '15 hours')
                           AT TIME ZONE 'America/Chicago')
          AND key_levels IS NOT NULL
        ORDER BY trading_date, read_time
    """
    with psycopg2.connect(database_url) as conn:
        return pd.read_sql_query(sql, conn)


def fetch_bars_for_read(conn, trading_date, read_time_utc) -> pd.DataFrame:
    """Fetch regular-hours SPX 1-min bars from read_time to 15:00 CT same day.

    NOTE: queries index_candles_1m directly (the compat view spx_candles_1m
    does not exist in this DB). symbol='SPX' filter is required.
    """
    sql = """
        SELECT timestamp, close::float AS close
        FROM index_candles_1m
        WHERE symbol = 'SPX'
          AND date = %s
          AND timestamp >= %s
          AND timestamp <= ((%s::date + INTERVAL '15 hours')
                            AT TIME ZONE 'America/Chicago')
          AND market_time = 'r'
        ORDER BY timestamp
    """
    return pd.read_sql_query(
        sql, conn, params=(trading_date, read_time_utc, trading_date)
    )


def build_events(reads: pd.DataFrame, database_url: str) -> dict[str, pd.DataFrame]:
    """For each read, compute all per-event rows for the three claims.

    Returns dict with keys 'walls', 'magnet', 'charm' — each a DataFrame.

    Walls DataFrame columns:
        read_id, trading_date, read_time_utc, mode, calibration_quality,
        spot_at_read, wall_type, wall_strike, real_or_sham, distance_initial,
        bucket, touched, classification, reversal_signed, breached_eod, success
    """
    wall_rows: list[dict] = []
    magnet_rows: list[dict] = []
    charm_rows: list[dict] = []
    excluded_no_bars = 0

    with psycopg2.connect(database_url) as conn:
        for _, r in reads.iterrows():
            bars = fetch_bars_for_read(conn, r.trading_date, r.read_time_utc)
            if bars.empty:
                excluded_no_bars += 1
                continue

            spx_close = float(bars["close"].iloc[-1])

            for wall_type, real_strike in (
                ("ceiling", r.wall_ceiling),
                ("floor", r.wall_floor),
            ):
                if pd.isna(real_strike):
                    continue
                ev_real = compute_wall_event(
                    bars,
                    float(real_strike),
                    wall_type,
                    float(r.spot_at_read),
                )
                sham_strike = mirror_strike(float(r.spot_at_read), float(real_strike))
                sham_type: str = "floor" if wall_type == "ceiling" else "ceiling"
                ev_sham = compute_wall_event(
                    bars,
                    sham_strike,
                    sham_type,
                    float(r.spot_at_read),
                )
                for tag, ev, strike in (
                    ("real", ev_real, float(real_strike)),
                    ("sham", ev_sham, sham_strike),
                ):
                    wall_rows.append(
                        {
                            "read_id": int(r.read_id),
                            "trading_date": r.trading_date,
                            "read_time_utc": r.read_time_utc,
                            "mode": r["mode"],
                            "calibration_quality": r.calibration_quality,
                            "spot_at_read": float(r.spot_at_read),
                            "wall_type": wall_type,
                            "wall_strike": strike,
                            "real_or_sham": tag,
                            **ev,
                        }
                    )

            if pd.notna(r.magnet):
                ev = compute_magnet_event(
                    spx_close, float(r.magnet), float(r.spot_at_read)
                )
                if ev is not None:
                    magnet_rows.append(
                        {
                            "read_id": int(r.read_id),
                            "trading_date": r.trading_date,
                            "mode": r["mode"],
                            "calibration_quality": r.calibration_quality,
                            "spot_at_read": float(r.spot_at_read),
                            "magnet": float(r.magnet),
                            "spx_close": spx_close,
                            **ev,
                        }
                    )

            if pd.notna(r.charm_zero):
                ev = compute_charm_zero_event(
                    bars, float(r.charm_zero), float(r.spot_at_read)
                )
                if ev is not None:
                    charm_rows.append(
                        {
                            "read_id": int(r.read_id),
                            "trading_date": r.trading_date,
                            "mode": r["mode"],
                            "calibration_quality": r.calibration_quality,
                            "spot_at_read": float(r.spot_at_read),
                            "charm_zero": float(r.charm_zero),
                            "bucket": distance_bucket(ev["distance"]),
                            **ev,
                        }
                    )

    print(f"  excluded_no_bar_coverage = {excluded_no_bars}")
    return {
        "walls": pd.DataFrame(wall_rows),
        "magnet": pd.DataFrame(magnet_rows),
        "charm": pd.DataFrame(charm_rows),
    }


def test_walls(walls_df: pd.DataFrame) -> dict:
    """Run primary McNemar test on walls (real vs sham success, paired).

    Returns dict suitable for findings.json:
        claim, n_pairs, real_success_rate, sham_success_rate,
        effect_pp, p_value, passes_bonferroni, effect_size_meets_threshold,
        verdict, threats_to_validity
    """
    if walls_df.empty:
        return {
            "claim": "walls_hold",
            "n_pairs": 0,
            "verdict": "no_data",
            "p_value": None,
        }

    primary = walls_df[walls_df["bucket"].isin(PRIMARY_BUCKETS)]
    pivot = primary.pivot_table(
        index=["read_id", "wall_type"],
        columns="real_or_sham",
        values="success",
        aggfunc="first",
    ).dropna()

    if len(pivot) == 0:
        return {
            "claim": "walls_hold",
            "n_pairs": 0,
            "verdict": "no_data_in_primary_buckets",
            "p_value": None,
        }

    # Build 2x2 contingency table for McNemar:
    #            sham=0  sham=1
    # real=0      a       b
    # real=1      c       d
    real = pivot["real"].astype(int).values
    sham = pivot["sham"].astype(int).values
    a = int(((real == 0) & (sham == 0)).sum())
    b = int(((real == 0) & (sham == 1)).sum())
    c = int(((real == 1) & (sham == 0)).sum())
    d = int(((real == 1) & (sham == 1)).sum())
    table = [[a, b], [c, d]]

    result = mcnemar(table, exact=True)
    p_value = float(result.pvalue)
    real_rate = float(real.mean())
    sham_rate = float(sham.mean())
    effect_pp = real_rate - sham_rate

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = effect_pp >= EFFECT_SIZE_THRESHOLD_PP

    return {
        "claim": "walls_hold",
        "n_pairs": int(len(pivot)),
        "real_success_rate": real_rate,
        "sham_success_rate": sham_rate,
        "effect_pp": effect_pp,
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "contingency_table": {"a": a, "b": b, "c": c, "d": d},
        "threats_to_validity": [
            "SPX cash != tradeable (option premium not tested here)",
            "Multiple reads per day not strictly independent",
            "Selection effect on key_levels non-null",
        ],
    }


def test_magnet(magnet_df: pd.DataFrame) -> dict:
    """Wilcoxon signed-rank on delta = err_magnet - err_naive.

    H0: median delta == 0.
    Win: median(delta) < 0 (magnet has lower squared error) AND
         |median(delta)| >= EFFECT_SIZE_THRESHOLD_MAGNET (1 point^2).
    """
    if magnet_df.empty or len(magnet_df) < 6:
        return {
            "claim": "magnet_predicts_close",
            "n_reads": int(len(magnet_df)),
            "verdict": "no_data",
            "p_value": None,
        }

    delta = magnet_df["delta"].astype(float).values
    median_delta = float(pd.Series(delta).median())

    # Wilcoxon requires non-zero values; scipy uses zero_method='wilcox' by
    # default since 1.13 (treats zeros via the Wilcoxon convention).
    result = wilcoxon(delta, alternative="less")  # H1: median < 0
    p_value = float(result.pvalue)

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = (median_delta < 0) and (
        abs(median_delta) >= EFFECT_SIZE_THRESHOLD_MAGNET
    )

    return {
        "claim": "magnet_predicts_close",
        "n_reads": int(len(magnet_df)),
        "median_delta": median_delta,
        "median_err_magnet": float(pd.Series(magnet_df["err_magnet"]).median()),
        "median_err_naive": float(pd.Series(magnet_df["err_naive"]).median()),
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "threats_to_validity": [
            "Subset |magnet - spot| >= 3pt only — small or near-spot magnets excluded",
            "Squared-error metric penalizes large misses heavily",
        ],
    }


def test_charm_zero(charm_df: pd.DataFrame) -> dict:
    """McNemar paired on crossed_real vs crossed_sham.

    Two-sided (direction not pre-specified — either sign counts per spec).
    """
    if charm_df.empty:
        return {
            "claim": "charm_zero_cross",
            "n_pairs": 0,
            "verdict": "no_data",
            "p_value": None,
        }

    real = charm_df["crossed_real"].astype(int).values
    sham = charm_df["crossed_sham"].astype(int).values
    a = int(((real == 0) & (sham == 0)).sum())
    b = int(((real == 0) & (sham == 1)).sum())
    c = int(((real == 1) & (sham == 0)).sum())
    d = int(((real == 1) & (sham == 1)).sum())
    result = mcnemar([[a, b], [c, d]], exact=True)
    p_value = float(result.pvalue)
    real_rate = float(real.mean())
    sham_rate = float(sham.mean())
    effect_pp = abs(real_rate - sham_rate)  # two-sided: magnitude only

    passes_p = p_value < BONFERRONI_ALPHA
    passes_effect = effect_pp >= EFFECT_SIZE_THRESHOLD_PP

    return {
        "claim": "charm_zero_cross",
        "n_pairs": int(len(charm_df)),
        "real_cross_rate": real_rate,
        "sham_cross_rate": sham_rate,
        "effect_pp_abs": effect_pp,
        "direction": "real > sham" if real_rate > sham_rate else "real < sham",
        "p_value": p_value,
        "bonferroni_alpha": BONFERRONI_ALPHA,
        "passes_bonferroni": passes_p,
        "effect_size_meets_threshold": passes_effect,
        "verdict": "pass" if (passes_p and passes_effect) else "fail",
        "contingency_table": {"a": a, "b": b, "c": c, "d": d},
        "threats_to_validity": [
            "Two-sided test by design — direction is descriptive, not predictive",
            "Crossing defined by first vs last close only; ignores intraday excursions",
        ],
    }


def _bootstrap_ci(
    values: np.ndarray,
    n_boot: int = 1000,
    alpha: float = 0.05,
    seed: int = 42,
) -> tuple[float, float]:
    """Percentile bootstrap CI for the mean of a binary array."""
    rng = np.random.default_rng(seed)
    if len(values) == 0:
        return (float("nan"), float("nan"))
    boots = rng.choice(values, size=(n_boot, len(values)), replace=True).mean(axis=1)
    lo = float(np.percentile(boots, 100 * alpha / 2))
    hi = float(np.percentile(boots, 100 * (1 - alpha / 2)))
    return (lo, hi)


def plot_wall_reversal(walls_df: pd.DataFrame, out_path: Path) -> None:
    """Bar chart: success rate by distance bucket, real vs sham, with 95% CIs."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    buckets = ["0-3", "3-7", "7-15", "15+"]
    width = 0.35
    x = np.arange(len(buckets))

    fig, ax = plt.subplots(figsize=(9, 5))
    max_rate = 0.0
    for bar_offset, tag, color in (
        (-width / 2, "real", "#1f77b4"),
        (+width / 2, "sham", "#cccccc"),
    ):
        rates: list[float] = []
        los: list[float] = []
        his: list[float] = []
        ns: list[int] = []
        for bucket in buckets:
            subset = walls_df[
                (walls_df["bucket"] == bucket) & (walls_df["real_or_sham"] == tag)
            ]
            success = subset["success"].astype(int).values
            ns.append(len(success))
            if len(success) == 0:
                rates.append(0.0)
                los.append(0.0)
                his.append(0.0)
                continue
            rate = float(success.mean())
            lo, hi = _bootstrap_ci(success)
            rates.append(rate)
            los.append(lo)
            his.append(hi)
        yerr = [
            [r - lo for r, lo in zip(rates, los, strict=False)],
            [hi - r for r, hi in zip(rates, his, strict=False)],
        ]
        ax.bar(
            x + bar_offset,
            rates,
            width,
            yerr=yerr,
            capsize=4,
            color=color,
            edgecolor="black",
            label=tag,
        )
        for i, (r, n) in enumerate(zip(rates, ns, strict=False)):
            ax.annotate(
                f"n={n}",
                xy=(x[i] + bar_offset, r),
                xytext=(0, 4),
                textcoords="offset points",
                ha="center",
                fontsize=8,
            )
        max_rate = max(max_rate, max(rates) if rates else 0.0)

    ax.set_xticks(x)
    ax.set_xticklabels(buckets)
    ax.set_xlabel("Distance bucket (SPX points from spot)")
    ax.set_ylabel("P(touched AND held) — success rate")
    ax.set_title(
        "Periscope gamma-wall reversal rate, real vs sham\n"
        "(success = touched ±1pt AND reversed ≥2pt within 15min)"
    )
    ax.legend()
    ax.set_ylim(0, max(0.5, max_rate * 1.5))
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_distance_distribution(walls_df: pd.DataFrame, out_path: Path) -> None:
    """Histogram of distance_initial for real walls only (sham is mirror)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    real = walls_df[walls_df["real_or_sham"] == "real"]
    fig, ax = plt.subplots(figsize=(8, 5))
    for wall_type, color in (("ceiling", "#d62728"), ("floor", "#2ca02c")):
        d = real.loc[real["wall_type"] == wall_type, "distance_initial"]
        ax.hist(d, bins=20, alpha=0.5, label=wall_type, color=color, edgecolor="black")
    for edge in (3.0, 7.0, 15.0):
        ax.axvline(edge, color="gray", linestyle="--", linewidth=1)
    ax.set_xlabel("Distance from spot at read time (SPX points)")
    ax.set_ylabel("Number of reads")
    ax.set_title(
        "Distribution of gamma_ceiling / gamma_floor distance from spot\n"
        "(dashed lines: 3 / 7 / 15 pt bucket edges)"
    )
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_magnet_quality(magnet_df: pd.DataFrame, out_path: Path) -> None:
    """Scatter of |magnet - spot| vs |close - magnet|; overlay |close - spot|."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if magnet_df.empty:
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5, "No magnet events", ha="center", va="center")
        ax.set_axis_off()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
        return

    abs_dist = (magnet_df["magnet"] - magnet_df["spot_at_read"]).abs()
    abs_err_magnet = (magnet_df["spx_close"] - magnet_df["magnet"]).abs()
    abs_err_naive = (magnet_df["spx_close"] - magnet_df["spot_at_read"]).abs()

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.scatter(
        abs_dist,
        abs_err_magnet,
        alpha=0.6,
        s=30,
        c="#1f77b4",
        label="|close − magnet|",
    )
    ax.scatter(
        abs_dist,
        abs_err_naive,
        alpha=0.4,
        s=30,
        c="#ff7f0e",
        label="|close − spot| (naive)",
        marker="x",
    )
    ax.plot(
        [0, abs_dist.max()],
        [0, abs_dist.max()],
        color="gray",
        linestyle="--",
        label="break-even",
    )
    ax.set_xlabel("|magnet − spot at read| (SPX points)")
    ax.set_ylabel("Prediction error |close − target| (SPX points)")
    ax.set_title(
        "Magnet predictor quality vs naive 'close ≈ spot'\n"
        "Below the dashed line = magnet beats naive"
    )
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_charm_zero(charm_df: pd.DataFrame, out_path: Path) -> None:
    """Bar chart: cross rate real vs sham, stratified by distance bucket."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if charm_df.empty:
        fig, ax = plt.subplots(figsize=(8, 5))
        ax.text(0.5, 0.5, "No charm-zero events", ha="center", va="center")
        ax.set_axis_off()
        fig.savefig(out_path, dpi=120)
        plt.close(fig)
        return

    buckets = ["0-3", "3-7", "7-15", "15+"]
    width = 0.35
    x = np.arange(len(buckets))
    fig, ax = plt.subplots(figsize=(9, 5))

    real_rates: list[float] = []
    sham_rates: list[float] = []
    ns: list[int] = []
    for bucket in buckets:
        subset = charm_df[charm_df["bucket"] == bucket]
        ns.append(len(subset))
        if subset.empty:
            real_rates.append(0.0)
            sham_rates.append(0.0)
            continue
        real_rates.append(float(subset["crossed_real"].astype(int).mean()))
        sham_rates.append(float(subset["crossed_sham"].astype(int).mean()))

    ax.bar(
        x - width / 2,
        real_rates,
        width,
        color="#1f77b4",
        edgecolor="black",
        label="real charm_zero",
    )
    ax.bar(
        x + width / 2,
        sham_rates,
        width,
        color="#cccccc",
        edgecolor="black",
        label="sham (mirror)",
    )
    for i, n in enumerate(ns):
        ax.annotate(
            f"n={n}",
            xy=(x[i], max(real_rates[i], sham_rates[i])),
            xytext=(0, 4),
            textcoords="offset points",
            ha="center",
            fontsize=8,
        )
    ax.set_xticks(x)
    ax.set_xticklabels(buckets)
    ax.set_xlabel("Distance bucket (SPX points from spot)")
    ax.set_ylabel("P(crossed between read and 15:00 CT close)")
    ax.set_title("Charm-zero cross rate, real vs sham (mirror across spot)")
    ax.legend()
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def append_findings(
    findings_path: Path,
    blocks: list[dict],
    data_window: dict,
) -> None:
    """Append a list of result blocks to findings.json under a top-level key.

    Existing findings.json is preserved; we add (or overwrite) the
    'periscope_gamma_wall_edge' key with today's run summary, including
    a data_window block with the date range, distinct-day count, and a
    prominent caveat string when the window is narrow.
    """
    if findings_path.exists():
        existing = json.loads(findings_path.read_text())
    else:
        existing = {}
    existing["periscope_gamma_wall_edge"] = {
        "experiment": "periscope-gamma-wall-edge",
        "run_date_utc": datetime.now(UTC).isoformat(),
        "data_window": data_window,
        "results": blocks,
    }
    findings_path.write_text(json.dumps(existing, indent=2, default=str) + "\n")


def build_data_window(reads: pd.DataFrame) -> dict:
    """Compute date-range stats + emit warnings when the window is narrow.

    Triggers a 'narrow_window_warning' when distinct_days < 20, since per
    the spec design the sensitivity check (one read per (date,mode)) needs
    ~30+ days to be informative.
    """
    distinct_days = int(reads["trading_date"].nunique())
    earliest = str(reads["trading_date"].min())
    latest = str(reads["trading_date"].max())
    warnings = []
    if distinct_days < 20:
        warnings.append(
            f"NARROW WINDOW ({distinct_days} distinct trading days only). "
            "Results reflect a single-regime snapshot. Within-day "
            "correlation across the auto-playbook's ~35 reads/day is "
            "high; the spec's first-read-per-(date,mode) sensitivity "
            "check is underpowered at this N. Re-run after several "
            "more weeks of data accumulate before trading on the result."
        )
    return {
        "distinct_days": distinct_days,
        "earliest": earliest,
        "latest": latest,
        "total_reads_in_window": int(len(reads)),
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="Postgres URL (default: $DATABASE_URL)",
    )
    args = parser.parse_args()
    if not args.database_url:
        print("ERROR: DATABASE_URL not set", file=sys.stderr)
        return 1

    print("Fetching periscope reads with key_levels…")
    reads = fetch_reads(args.database_url)
    print(f"  N reads = {len(reads)}")
    print(
        f"  with both walls = "
        f"{reads.dropna(subset=['wall_ceiling', 'wall_floor']).shape[0]}"
    )
    print(f"  with magnet     = {reads['magnet'].notna().sum()}")
    print(f"  with charm_zero = {reads['charm_zero'].notna().sum()}")

    print("Building events…")
    events = build_events(reads, args.database_url)
    print(f"  walls events  (real+sham, ceiling+floor) = {len(events['walls'])}")
    print(f"  magnet events                            = {len(events['magnet'])}")
    print(f"  charm events                             = {len(events['charm'])}")

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    events["walls"].to_csv(CSV_PATH, index=False)
    print(f"  wrote {CSV_PATH}")

    print("\n=== Test 1: Walls hold (McNemar paired) ===")
    walls_result = test_walls(events["walls"])
    print(json.dumps(walls_result, indent=2, default=str))

    print("\n=== Test 2: Magnet predicts close (Wilcoxon, one-sided less) ===")
    magnet_result = test_magnet(events["magnet"])
    print(json.dumps(magnet_result, indent=2, default=str))

    print("\n=== Test 3: Charm-zero crosses (McNemar paired, two-sided) ===")
    charm_result = test_charm_zero(events["charm"])
    print(json.dumps(charm_result, indent=2, default=str))

    print("\nWriting plots…")
    plot_wall_reversal(events["walls"], PLOT_DIR / "gamma_wall_reversal.png")
    print(f"  wrote {PLOT_DIR / 'gamma_wall_reversal.png'}")
    plot_distance_distribution(
        events["walls"], PLOT_DIR / "gamma_wall_distance_dist.png"
    )
    print(f"  wrote {PLOT_DIR / 'gamma_wall_distance_dist.png'}")
    plot_magnet_quality(events["magnet"], PLOT_DIR / "magnet_predictor_quality.png")
    print(f"  wrote {PLOT_DIR / 'magnet_predictor_quality.png'}")
    plot_charm_zero(events["charm"], PLOT_DIR / "charm_zero_cross_rates.png")
    print(f"  wrote {PLOT_DIR / 'charm_zero_cross_rates.png'}")

    data_window = build_data_window(reads)
    if data_window["warnings"]:
        print("\nDATA WINDOW WARNINGS:")
        for w in data_window["warnings"]:
            print(f"  ! {w}")
    append_findings(
        FINDINGS_PATH,
        [walls_result, magnet_result, charm_result],
        data_window,
    )
    print(f"\nWrote findings to {FINDINGS_PATH}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
