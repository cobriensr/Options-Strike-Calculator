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
from pathlib import Path

# sys.path mutation must precede the `periscope_gamma_wall_lib` import below;
# ml/conftest.py handles this for pytest, but scripts run directly need to add
# ml/src/ themselves.
_HERE = Path(__file__).resolve().parent
_ML_SRC = _HERE.parent
sys.path.insert(0, str(_ML_SRC))

import pandas as pd  # noqa: E402
import psycopg2  # noqa: E402
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
        verdict, threats_to_validity, notes
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

    return 0


if __name__ == "__main__":
    sys.exit(main())
