#!/usr/bin/env python
"""Per-ticker analysis of time-to-flow-inversion.

Re-runs `simulate_flow_inversion` against the parquet+flow inputs for
every enriched fire, capturing the inversion timestamp directly so we
can compute (inversion_ts − trigger_ts) in minutes. Aggregates per
ticker / mode / tier / dte and writes a markdown report to
docs/tmp/flow-inversion-timing-{LATEST_DATE}.md.

Useful for: knowing how long after a fire to start watching for the
exit signal on a given ticker, and spotting fast-vs-slow tape regimes.

Read-only — does not modify the DB or production code.

Usage:
    ml/.venv/bin/python scripts/flow_inversion_timing.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'

# Reuse the production port from the enrichment script — single
# source of truth for the algorithm.
sys.path.insert(0, str(ROOT / 'scripts'))
from enrich_lottery_outcomes import (  # noqa: E402
    simulate_flow_inversion,
    resample_minute_mid,
)

_CT_TZ = ZoneInfo('America/Chicago')


def load_env() -> None:
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def latest_fire_date(conn) -> str:
    cur = conn.cursor()
    cur.execute(
        'SELECT MAX(date) FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL'
    )
    row = cur.fetchone()
    if row is None or row[0] is None:
        return 'unknown'
    return row[0].isoformat() if hasattr(row[0], 'isoformat') else str(row[0])[:10]


def main() -> None:
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    out_path = ROOT / 'docs' / 'tmp' / f'flow-inversion-timing-{latest_fire_date(conn)}.md'

    print('[timing] loading fires…')
    fires = pd.read_sql(
        """
        SELECT id, date, option_chain_id, underlying_symbol, option_type,
               trigger_time_ct, entry_price, mode, dte, score,
               realized_flow_inversion_pct AS flow_inv
        FROM lottery_finder_fires
        WHERE realized_flow_inversion_pct IS NOT NULL
        ORDER BY date, trigger_time_ct
        """,
        conn,
    )
    fires['tier'] = fires['score'].apply(
        lambda s: 'T1' if pd.notna(s) and s >= 18
        else ('T2' if pd.notna(s) and s >= 12 else 'T3')
    )
    print(f'[timing] {len(fires):,} fires with non-null flow_inv across '
          f'{fires["date"].nunique()} dates')

    # Bucket by date so we load each parquet once.
    timings = []  # list of dicts (one per fire)
    t0 = time.time()
    for d, sub in fires.groupby('date', sort=True):
        date_str = d.isoformat() if hasattr(d, 'isoformat') else str(d)[:10]
        path = PARQUET_DIR / f'{date_str}-trades.parquet'
        if not path.exists():
            continue

        chains = sub['option_chain_id'].unique().tolist()
        df = pd.read_parquet(
            path,
            columns=['executed_at', 'option_chain_id', 'price',
                     'canceled', 'nbbo_bid', 'nbbo_ask', 'size'],
            filters=[('option_chain_id', 'in', chains)],
        )
        if df['canceled'].dtype == bool:
            df = df[~df['canceled']]
        else:
            df = df[df['canceled'].astype(str).str.lower().isin(['f','false','0',''])]
        df = df[df['price'] > 0]
        if df['executed_at'].dt.tz is None:
            df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
        df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')
        chain_idx = dict(iter(df.groupby('option_chain_id', sort=False)))

        # Per-chain minute mids cache.
        minute_cache: dict[str, list[tuple]] = {}
        # Per (ticker, type) flow cache.
        flow_cache: dict[tuple[str, str], list[tuple]] = {}
        cur = conn.cursor()
        for ticker in sub['underlying_symbol'].unique():
            for opt_type, col in [('C', 'net_call_prem'), ('P', 'net_put_prem')]:
                cur.execute(
                    f"""
                    SELECT ts, {col} FROM net_flow_per_ticker_history
                    WHERE ticker = %s
                      AND ts >= %s::timestamptz
                      AND ts <  %s::timestamptz + INTERVAL '1 day'
                    ORDER BY ts ASC
                    """,
                    (ticker, f'{date_str}T00:00:00Z', f'{date_str}T00:00:00Z'),
                )
                rows = []
                for ts, val in cur.fetchall():
                    if val is None:
                        continue
                    try:
                        v = float(val)
                    except (TypeError, ValueError):
                        continue
                    if np.isfinite(v):
                        rows.append((ts, v))
                flow_cache[(ticker, opt_type)] = rows

        for _, fire in sub.iterrows():
            chain_df = chain_idx.get(fire['option_chain_id'])
            if chain_df is None:
                continue
            if fire['option_chain_id'] not in minute_cache:
                minute_cache[fire['option_chain_id']] = resample_minute_mid(chain_df)
            minutes = minute_cache[fire['option_chain_id']]
            flow = flow_cache.get((fire['underlying_symbol'], fire['option_type']), [])

            trigger_ts = fire['trigger_time_ct']
            if hasattr(trigger_ts, 'tz_localize') and trigger_ts.tz is None:
                trigger_ts = trigger_ts.tz_localize('UTC')
            if hasattr(trigger_ts, 'to_pydatetime'):
                trigger_ts = trigger_ts.to_pydatetime()

            exit_pct, exit_ts, status = simulate_flow_inversion(
                minutes, flow, float(fire['entry_price']), trigger_ts
            )
            # Only record true inversion exits — EOD fallbacks have a
            # different meaning and would skew the timing toward 15:00.
            if status != 'inversion' or exit_ts is None:
                continue
            mins_to_inv = (exit_ts - trigger_ts).total_seconds() / 60.0
            timings.append({
                'id': int(fire['id']),
                'ticker': fire['underlying_symbol'],
                'mode': fire['mode'],
                'tier': fire['tier'],
                'dte': int(fire['dte']),
                'option_type': fire['option_type'],
                'minutes_to_inversion': mins_to_inv,
                'realized_pct': float(exit_pct),
            })
        print(f'  [{date_str}] {len(sub):,} fires → {len([t for t in timings if t.get("id") in set(sub["id"])]):,} inversion timings')

    print(f'[timing] computed in {time.time() - t0:.1f}s; {len(timings):,} inversions')

    if not timings:
        sys.exit('[timing] no inversion timings collected — nothing to report')

    df = pd.DataFrame(timings)

    def fmt_stats(s: pd.Series) -> str:
        s = s.dropna()
        if len(s) < 30:
            return f'n={len(s)} (insufficient)'
        return (f'n={len(s):>5,}  '
                f'median={s.median():>5.1f}min  '
                f'p25={s.quantile(0.25):>5.1f}  '
                f'p75={s.quantile(0.75):>5.1f}  '
                f'p90={s.quantile(0.90):>5.1f}  '
                f'mean={s.mean():>5.1f}')

    lines = ['# Flow-inversion timing analysis\n']
    lines.append(f'Dataset: {len(df):,} fires where flow_inversion fired '
                 f'(EOD-fallback excluded — those would skew distribution).\n')
    lines.append('## Aggregate (all fires with true inversion)\n')
    lines.append('    ' + fmt_stats(df['minutes_to_inversion']))

    lines.append('\n## By mode\n')
    for mode, sub in df.groupby('mode'):
        lines.append(f'    {mode:<22} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By tier\n')
    for tlbl in ['T1', 'T2', 'T3']:
        sub = df[df['tier'] == tlbl]
        lines.append(f'    {tlbl:<5} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By DTE\n')
    for dte, sub in df.groupby('dte'):
        lines.append(f'    DTE {dte}  {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By option type\n')
    for ot, sub in df.groupby('option_type'):
        lines.append(f'    {ot:<3} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## Per-ticker (n ≥ 100, sorted by median time-to-inversion)\n')
    lines.append(f'    {"ticker":<7} {"n":>6} {"median":>7} {"p25":>5} {"p75":>5} {"p90":>5} {"mean":>5}  {"avg_pct%":>8}')
    rows = []
    for ticker, sub in df.groupby('ticker'):
        if len(sub) < 100:
            continue
        s = sub['minutes_to_inversion']
        rows.append({
            'ticker': ticker,
            'n': len(sub),
            'median': float(s.median()),
            'p25': float(s.quantile(0.25)),
            'p75': float(s.quantile(0.75)),
            'p90': float(s.quantile(0.90)),
            'mean': float(s.mean()),
            'avg_pct': float(sub['realized_pct'].mean()),
        })
    rows.sort(key=lambda r: r['median'])
    for r in rows:
        lines.append(
            f'    {r["ticker"]:<7} {r["n"]:>6,} {r["median"]:>6.1f}m '
            f'{r["p25"]:>4.0f} {r["p75"]:>4.0f} {r["p90"]:>4.0f} {r["mean"]:>4.0f}  '
            f'{r["avg_pct"]:>+7.2f}%'
        )

    lines.append('\n## Distribution buckets (across all fires)\n')
    bins = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 1000]
    labels = ['0-5', '5-10', '10-15', '15-20', '20-30', '30-45',
              '45-60', '60-90', '90-120', '120-180', '180-240', '240+']
    binned = pd.cut(df['minutes_to_inversion'], bins=bins, labels=labels, right=False)
    counts = binned.value_counts().sort_index()
    cum = 0
    total = counts.sum()
    lines.append(f'    {"bucket":<10} {"n":>6} {"pct":>5} {"cum%":>5}')
    for label, n in counts.items():
        cum += n
        lines.append(f'    {label:<10} {n:>6,} {100*n/total:>4.1f}% {100*cum/total:>4.1f}%')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print('\n'.join(lines))
    print(f'\n[timing] report → {out_path}')


if __name__ == '__main__':
    main()
