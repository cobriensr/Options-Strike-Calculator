"""SB score comparison — NOW (DB column) vs FUTURE (current code).

Pulls all 63,846 alerts with the populated Phase D-1 features (pre_trade_count,
adj_cofire, first_min_share, spread_in_bucket) and:

  NOW    = silent_boom_alerts.score / score_tier as it sits in the DB.
           Heterogeneous: each row was scored at insert-time under whichever
           weights were live that day (Phase 0 weights for most older rows,
           with the ask=1.0 backfill patched on top).

  FUTURE = score the post-Phase-D-1 code would produce given the row's
           now-fully-populated features. Deterministic recompute via
           backfill_silent_boom_from_parquet.compute_silent_boom_score.

Outputs:
  1. Tier transition matrix (NOW × FUTURE counts).
  2. Per-tier peak ≥50% rate side-by-side.
  3. Score histogram for both states.
  4. Per-feature bucket lift under FUTURE weights (post Phase D-1 cohort
     audit) — drives the Phase D-2 decision on which weights need
     recalibration.

Run:
    ml/.venv/bin/python docs/tmp/sb-now-vs-future-2026-05-18.py \
        2>&1 | tee docs/tmp/sb-now-vs-future-output.txt
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import psycopg2

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / 'scripts'))

# Re-use the canonical Python scoring mirror (matches TS exactly).
from backfill_silent_boom_from_parquet import (  # noqa: E402
    compute_silent_boom_score,
    silent_boom_tier,
    silent_boom_tod_from_minute_ct,
)


def load_env() -> str:
    env = REPO_ROOT / ".env.local"
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip('"').strip("'")
    sys.exit("DATABASE_URL not in .env.local")


def fetch_alerts(conn) -> pd.DataFrame:
    return pd.read_sql(
        """
        SELECT id,
               date::text AS date,
               bucket_ct,
               dte,
               baseline_volume,
               spike_ratio,
               entry_price,
               ask_pct,
               option_type,
               pre_trade_count,
               adj_cofire,
               first_min_share,
               spread_in_bucket,
               peak_ceiling_pct,
               score AS score_now,
               score_tier AS tier_now
          FROM silent_boom_alerts
         WHERE peak_ceiling_pct IS NOT NULL
        """,
        conn,
    )


def recompute_future_score(row) -> int:
    """Apply the post-Phase-D-1 weights to a row."""
    bucket_ts = pd.Timestamp(row['bucket_ct'])
    if bucket_ts.tz is None:
        bucket_ts = bucket_ts.tz_localize('UTC')
    bucket_ct = bucket_ts.tz_convert('America/Chicago')
    ct_min_of_day = bucket_ct.hour * 60 + bucket_ct.minute
    tod = silent_boom_tod_from_minute_ct(ct_min_of_day)
    return compute_silent_boom_score(
        dte=int(row['dte']),
        baseline_volume=float(row['baseline_volume']),
        spike_ratio=float(row['spike_ratio']),
        entry_price=float(row['entry_price']),
        ask_pct=float(row['ask_pct']),
        tod=tod,
        option_type=row['option_type'],
        trading_day=row['date'],
        pre_trade_count=(
            int(row['pre_trade_count'])
            if pd.notna(row['pre_trade_count']) else 0
        ),
        adj_cofire=bool(row['adj_cofire']) if pd.notna(row['adj_cofire']) else False,
        first_min_share=(
            float(row['first_min_share'])
            if pd.notna(row['first_min_share']) else None
        ),
        spread_in_bucket=(
            float(row['spread_in_bucket'])
            if pd.notna(row['spread_in_bucket']) else None
        ),
    )


def main() -> None:
    print("Loading SB alerts…")
    with psycopg2.connect(load_env()) as conn:
        df = fetch_alerts(conn)
    df['bucket_ct'] = pd.to_datetime(df['bucket_ct'], utc=True)
    df['peak_ge_25'] = (df['peak_ceiling_pct'] >= 25).astype(int)
    df['peak_ge_50'] = (df['peak_ceiling_pct'] >= 50).astype(int)
    df['peak_ge_100'] = (df['peak_ceiling_pct'] >= 100).astype(int)
    print(f"  {len(df):,} alerts")
    print(f"  baseline peak ≥50% = {df['peak_ge_50'].mean() * 100:.1f}%")

    print("\nRecomputing FUTURE score with post-Phase-D-1 weights…")
    df['score_future'] = df.apply(recompute_future_score, axis=1)
    df['tier_future'] = df['score_future'].apply(silent_boom_tier)

    # ========================================================
    # 1. Tier distribution + transition
    # ========================================================
    print("\n" + "=" * 72)
    print("Tier distribution: NOW vs FUTURE")
    print("=" * 72)
    now_counts = df['tier_now'].value_counts().reindex(
        ['tier1', 'tier2', 'tier3']
    ).fillna(0).astype(int)
    fut_counts = df['tier_future'].value_counts().reindex(
        ['tier1', 'tier2', 'tier3']
    ).fillna(0).astype(int)
    n = len(df)
    print(f"{'tier':<8} {'NOW':>10} {'NOW %':>8} {'FUTURE':>10} {'FUT %':>8}  Δ")
    for t in ['tier1', 'tier2', 'tier3']:
        nn, nf = now_counts[t], fut_counts[t]
        npct, fpct = 100 * nn / n, 100 * nf / n
        print(
            f"{t:<8} {nn:>10,} {npct:>7.1f}% "
            f"{nf:>10,} {fpct:>7.1f}%  {fpct - npct:+.1f}pp"
        )

    print("\n" + "-" * 72)
    print("Transition matrix (rows = tier NOW, cols = tier FUTURE):")
    print("-" * 72)
    trans = pd.crosstab(df['tier_now'], df['tier_future']).reindex(
        index=['tier1', 'tier2', 'tier3'],
        columns=['tier1', 'tier2', 'tier3'],
    ).fillna(0).astype(int)
    print(trans.to_string())

    # ========================================================
    # 2. Peak performance by tier
    # ========================================================
    print("\n" + "=" * 72)
    print("Peak ≥50% (and ≥100%) hit rate by tier — NOW vs FUTURE")
    print("=" * 72)
    print(
        f"{'tier':<8}  "
        f"{'NOW n':>8} {'NOW≥50':>9} {'NOW≥100':>9}   "
        f"{'FUT n':>8} {'FUT≥50':>9} {'FUT≥100':>9}"
    )
    for t in ['tier1', 'tier2', 'tier3']:
        nrows = df[df['tier_now'] == t]
        frows = df[df['tier_future'] == t]
        n_now, n_fut = len(nrows), len(frows)
        if n_now > 0:
            now_50 = f"{nrows['peak_ge_50'].mean() * 100:5.1f}%"
            now_100 = f"{nrows['peak_ge_100'].mean() * 100:5.1f}%"
        else:
            now_50 = now_100 = '   —'
        if n_fut > 0:
            fut_50 = f"{frows['peak_ge_50'].mean() * 100:5.1f}%"
            fut_100 = f"{frows['peak_ge_100'].mean() * 100:5.1f}%"
        else:
            fut_50 = fut_100 = '   —'
        print(
            f"{t:<8}  {n_now:>8,} {now_50:>9} {now_100:>9}   "
            f"{n_fut:>8,} {fut_50:>9} {fut_100:>9}"
        )

    # ========================================================
    # 3. Score histograms
    # ========================================================
    print("\n" + "=" * 72)
    print("Score distribution histogram")
    print("=" * 72)
    bins = list(range(-30, 50, 5))
    for label, col in (('NOW   ', 'score_now'), ('FUTURE', 'score_future')):
        ser = df[col].dropna()
        cuts = pd.cut(ser, bins=bins, right=False, include_lowest=True)
        counts = cuts.value_counts().sort_index()
        print(f"\n{label} — score: mean={ser.mean():.1f}  std={ser.std():.1f}  "
              f"min={ser.min()}  p50={int(ser.median())}  "
              f"p95={int(ser.quantile(0.95))}  p99={int(ser.quantile(0.99))}  "
              f"max={ser.max()}")
        for interval, c in counts.items():
            pct = 100 * c / len(ser)
            bar = '█' * int(pct / 2)
            print(f"  {str(interval):>14}  {c:>7,} ({pct:>4.1f}%)  {bar}")

    # ========================================================
    # 4. Per-feature bucket lift under FUTURE weights
    # ========================================================
    print("\n" + "=" * 72)
    print("FUTURE peak ≥50% by feature bucket (post Phase D-1 cohort audit)")
    print("=" * 72)
    print("These lifts drive Phase D-2 recalibration decisions. If a")
    print("bucket's empirical lift no longer matches its assumed weight,")
    print("the weight needs to move.")
    base50 = df['peak_ge_50'].mean() * 100

    def report(col: str, label: str) -> None:
        nonlocal base50
        g = df.groupby(col, observed=True).agg(
            n=('peak_ge_50', 'size'),
            peak_ge_50_pct=('peak_ge_50', lambda s: round(s.mean() * 100, 1)),
            median_peak=('peak_ceiling_pct', lambda s: round(s.median(), 1)),
        ).reset_index()
        g['lift_pp'] = (g['peak_ge_50_pct'] - base50).round(1)
        print(f"\n[{label}]  baseline={base50:.1f}%")
        print(g.to_string(index=False))

    # DTE
    df['_dte_bucket'] = pd.cut(
        df['dte'],
        bins=[-1, 0, 3, 7, 30, 9999],
        labels=['0DTE', '1-3D', '4-7D', '8-30D', '30D+'],
    )
    report('_dte_bucket', 'DTE')

    # Baseline volume
    df['_baseline_bucket'] = pd.cut(
        df['baseline_volume'].astype(float),
        bins=[-1, 50, 200, 500, 1_000_000],
        labels=['<50', '50-200', '200-500', '500+'],
    )
    report('_baseline_bucket', 'baseline_volume')

    # Spike ratio
    df['_spike_bucket'] = pd.cut(
        df['spike_ratio'].astype(float),
        bins=[-1, 10, 25, 50, 100, 1e9],
        labels=['5-10x', '10-25x', '25-50x', '50-100x', '100x+'],
    )
    report('_spike_bucket', 'spike_ratio')

    # Entry price
    df['_price_bucket'] = pd.cut(
        df['entry_price'].astype(float),
        bins=[-1, 0.5, 1.0, 5.0, 1e9],
        labels=['<$0.50', '$0.50-1', '$1-5', '$5+'],
    )
    report('_price_bucket', 'entry_price')

    # TOD
    def tod_of(row):
        bucket_ts = pd.Timestamp(row['bucket_ct'])
        if bucket_ts.tz is None:
            bucket_ts = bucket_ts.tz_localize('UTC')
        ct = bucket_ts.tz_convert('America/Chicago')
        return silent_boom_tod_from_minute_ct(ct.hour * 60 + ct.minute)

    df['_tod'] = df.apply(tod_of, axis=1)
    df['_tod'] = pd.Categorical(
        df['_tod'],
        categories=['AM_open', 'MID', 'LUNCH', 'PM', 'LATE'],
        ordered=True,
    )
    report('_tod', 'tod')

    # Ask%
    df['_ask_bucket'] = pd.cut(
        df['ask_pct'].astype(float),
        bins=[-0.01, 0.85, 0.95, 0.999999, 1.001],
        labels=['<0.85', '0.85-0.95', '0.95-<1.0', '=1.0'],
    )
    report('_ask_bucket', 'ask_pct')

    # DOW × option_type
    df['_dow'] = pd.to_datetime(df['date']).dt.day_name()
    df['_dow'] = pd.Categorical(
        df['_dow'],
        categories=['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        ordered=True,
    )
    df['_dow_type'] = (
        df['_dow'].astype(str) + ' × ' + df['option_type']
    )
    report('_dow_type', 'dow × option_type')

    # pre_trade_count
    df['_ptc_bucket'] = pd.cut(
        df['pre_trade_count'].fillna(0).astype(float),
        bins=[-1, 0, 5, 25, 100, 500, 1e9],
        labels=['0', '1-5', '6-25', '26-100', '101-500', '501+'],
    )
    report('_ptc_bucket', 'pre_trade_count')

    # adj_cofire
    df['_cofire'] = df['adj_cofire'].fillna(False).astype(bool)
    report('_cofire', 'adj_cofire')

    # first_min_share
    df['_fms_bucket'] = pd.cut(
        df['first_min_share'].astype(float),
        bins=[-0.01, 0.25, 0.5, 0.75, 1.01],
        labels=['<25% (distributed)', '25-50%', '50-75%', '75-100% (single-block)'],
    )
    report('_fms_bucket', 'first_min_share')

    # spread_in_bucket
    df['_spread_bucket'] = pd.cut(
        df['spread_in_bucket'].astype(float),
        bins=[-0.01, 0.0181, 0.0441, 0.1122, 100],
        labels=['Q0 <0.0181', 'Q1 0.0181-0.0441',
                'Q2 0.0441-0.1122', 'Q3 ≥0.1122'],
    )
    report('_spread_bucket', 'spread_in_bucket')


if __name__ == "__main__":
    main()
