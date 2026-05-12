#!/usr/bin/env python
"""Audit which fire-row features add Sharpe lift on flow_inversion.

For every column already on lottery_finder_fires, compute the Sharpe of
realized_flow_inversion_pct in each bin (discrete fields) or quintile
(continuous fields) and report the spread between best and worst bin.
Highlights the levers worth turning into entry filters.

Read-only, no DB writes.

Usage:
    ml/.venv/bin/python scripts/feature_audit.py
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'


def load_env():
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def stats(s: pd.Series):
    """Return (n, mean, median, win%, sharpe) on a returns series."""
    s = pd.to_numeric(s, errors='coerce').dropna()
    n = len(s)
    if n < 50:
        return n, np.nan, np.nan, np.nan, np.nan
    mean = float(s.mean())
    med = float(s.median())
    win = float((s > 0).mean()) * 100.0
    std = float(s.std(ddof=1)) if n > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    return n, mean, med, win, sharpe


def bin_continuous(series: pd.Series, q: int = 5) -> pd.Series:
    """Quantile-bin a continuous Series, returning labels q1..q5."""
    s = pd.to_numeric(series, errors='coerce')
    try:
        return pd.qcut(s, q=q, labels=[f'Q{i}' for i in range(1, q + 1)],
                       duplicates='drop')
    except Exception:
        return pd.Series([np.nan] * len(s), index=s.index)


def latest_fire_date(conn) -> str:
    cur = conn.cursor()
    cur.execute(
        'SELECT MAX(date) FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL'
    )
    row = cur.fetchone()
    if row is None or row[0] is None:
        return 'unknown'
    return row[0].isoformat() if hasattr(row[0], 'isoformat') else str(row[0])[:10]


def main():
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    out_path = ROOT / 'docs' / 'tmp' / f'lottery-feature-audit-{latest_fire_date(conn)}.md'
    df = pd.read_sql(
        """
        SELECT
          underlying_symbol AS ticker, mode, tod, option_type, dte,
          score, alert_seq, reload_tagged, cheap_call_pm_tagged,
          burst_ratio_vs_prev, entry_drop_pct_vs_prev,
          entry_price, trigger_iv, trigger_delta, trigger_ask_pct,
          trigger_vol_to_oi_window,
          mkt_tide_diff, mkt_tide_otm_diff, spx_flow_diff,
          spy_etf_diff, qqq_etf_diff, zero_dte_diff,
          spx_spot_gamma_oi, spx_spot_gamma_vol,
          spx_spot_charm_oi, spx_spot_vanna_oi,
          gex_strike_call_minus_put, gex_strike_call_ask_minus_bid,
          gex_strike_put_ask_minus_bid,
          realized_flow_inversion_pct AS flow_inv
        FROM lottery_finder_fires
        WHERE realized_flow_inversion_pct IS NOT NULL
        """,
        conn,
    )
    print(f'[audit] {len(df):,} fires with flow_inversion populated')

    df['tier'] = df['score'].apply(
        lambda s: 'T1' if pd.notna(s) and s >= 18
        else ('T2' if pd.notna(s) and s >= 12 else 'T3')
    )

    # Build alert_seq buckets — first fire vs reload-cluster vs hot-chain.
    def aseq_bucket(s):
        if pd.isna(s): return 'unknown'
        s = int(s)
        if s == 1: return 'first'
        if s <= 5: return 'early(2-5)'
        if s <= 20: return 'mid(6-20)'
        return 'late(21+)'
    df['alert_seq_bucket'] = df['alert_seq'].apply(aseq_bucket)

    # Baselines: full set, Tier2+ Mode B, Tier2+ Mode A.
    def baseline(label, sub):
        n, mean, _med, _win, sh = stats(sub['flow_inv'])
        return f'{label:<35} n={n:>6,}  mean={mean:>+6.2f}%  Sharpe={sh:>+6.4f}'

    lines = ['# Fire-row feature audit — flow-inversion Sharpe by feature\n']
    lines.append(f'Dataset: {len(df):,} fires with flow_inv populated.\n')
    lines.append('## Baselines\n')
    lines.append('    ' + baseline('all fires', df))
    lines.append('    ' + baseline('Tier 2+', df[df['tier'].isin(['T1','T2'])]))
    lines.append('    ' + baseline('Tier 2+ Mode B',
                                   df[(df['tier'].isin(['T1','T2'])) & (df['mode'] == 'B_multi_day_DTE1_3')]))
    lines.append('    ' + baseline('Tier 2+ Mode A',
                                   df[(df['tier'].isin(['T1','T2'])) & (df['mode'] == 'A_intraday_0DTE')]))

    DISCRETE = [
        ('reload_tagged',          ['False','True']),
        ('cheap_call_pm_tagged',   ['False','True']),
        ('option_type',            ['C','P']),
        ('tod',                    ['AM_open','MID','LUNCH','PM']),
        ('alert_seq_bucket',       ['first','early(2-5)','mid(6-20)','late(21+)']),
        ('dte',                    [0,1,2,3,4,5,6,7]),
    ]
    CONTINUOUS = [
        'burst_ratio_vs_prev', 'entry_drop_pct_vs_prev',
        'entry_price', 'trigger_iv', 'trigger_delta',
        'trigger_ask_pct', 'trigger_vol_to_oi_window',
        'mkt_tide_diff', 'mkt_tide_otm_diff', 'spx_flow_diff',
        'spy_etf_diff', 'qqq_etf_diff', 'zero_dte_diff',
        'spx_spot_gamma_oi', 'spx_spot_gamma_vol',
        'spx_spot_charm_oi', 'spx_spot_vanna_oi',
        'gex_strike_call_minus_put', 'gex_strike_call_ask_minus_bid',
        'gex_strike_put_ask_minus_bid',
    ]

    # Stratify on the most actionable subset: Tier 2+ across both modes.
    base = df[df['tier'].isin(['T1','T2'])].copy()
    print(f'[audit] Tier 2+ subset: {len(base):,}')

    feature_lifts = []  # (feature, best_sharpe, worst_sharpe, lift, best_label, n_best)

    lines.append('\n## Discrete features (Tier 2+ subset)\n')
    for col, _ in DISCRETE:
        lines.append(f'### {col}\n')
        lines.append(f'    {"value":<12} {"n":>7} {"mean%":>7} {"med%":>7} {"win%":>5} {"Sharpe":>8}')
        rows = []
        for val, sub in base.groupby(col, dropna=False):
            label = str(val) if not pd.isna(val) else 'null'
            n, mean, med, win, sh = stats(sub['flow_inv'])
            if n >= 50:
                rows.append((label, n, mean, med, win, sh))
        rows.sort(key=lambda r: -r[5] if not np.isnan(r[5]) else 1)
        for r in rows:
            lines.append(f'    {r[0]:<12} {r[1]:>7,} {r[2]:>+6.2f}% {r[3]:>+6.2f}% {r[4]:>4.1f}% {r[5]:>+8.4f}')
        if len(rows) >= 2:
            best, worst = rows[0], rows[-1]
            lines.append(f'    → spread: {best[0]} → {worst[0]} = {best[5] - worst[5]:+.4f} Sharpe')
            feature_lifts.append((col, best[5], worst[5], best[5] - worst[5], best[0], best[1]))
        lines.append('')

    lines.append('\n## Continuous features (Tier 2+ subset, quintile bins)\n')
    for col in CONTINUOUS:
        if col not in base.columns:
            continue
        col_q = bin_continuous(base[col], q=5)
        if col_q.isna().all():
            continue
        rows = []
        for val, idx in col_q.groupby(col_q, observed=True).groups.items():
            label = str(val)
            sub = base.loc[idx]
            n, mean, med, win, sh = stats(sub['flow_inv'])
            if n >= 50:
                # Range of the bin for context
                vals = pd.to_numeric(sub[col], errors='coerce').dropna()
                lo = vals.min() if len(vals) else np.nan
                hi = vals.max() if len(vals) else np.nan
                rows.append((label, n, mean, med, win, sh, lo, hi))
        if len(rows) < 2:
            continue
        # Sort by quintile label for readability
        rows.sort(key=lambda r: r[0])
        sharpes = [r[5] for r in rows if not np.isnan(r[5])]
        if len(sharpes) < 2:
            continue
        best_idx = max(range(len(rows)), key=lambda i, rs=rows: rs[i][5] if not np.isnan(rs[i][5]) else -1e9)
        worst_idx = min(range(len(rows)), key=lambda i, rs=rows: rs[i][5] if not np.isnan(rs[i][5]) else 1e9)
        spread = rows[best_idx][5] - rows[worst_idx][5]
        feature_lifts.append((col, rows[best_idx][5], rows[worst_idx][5], spread,
                              rows[best_idx][0], rows[best_idx][1]))
        lines.append(f'### {col}  (best={rows[best_idx][0]}, worst={rows[worst_idx][0]}, spread={spread:+.4f})\n')
        lines.append(f'    {"q":<3} {"n":>6} {"range":>22} {"mean%":>7} {"win%":>5} {"Sharpe":>8}')
        for r in rows:
            rng = f'{r[6]:>10.3f}…{r[7]:<10.3f}'
            lines.append(f'    {r[0]:<3} {r[1]:>6,} {rng:>22} {r[2]:>+6.2f}% {r[4]:>4.1f}% {r[5]:>+8.4f}')
        lines.append('')

    # Ranked headline
    lines.append('\n## Ranked feature lift (best-bin Sharpe − worst-bin Sharpe)\n')
    lines.append(f'    {"feature":<32} {"spread":>8}  {"best bin":<12} {"best Sharpe":>11}  {"best n":>7}')
    feature_lifts.sort(key=lambda r: -r[3] if not np.isnan(r[3]) else 1)
    for col, best_sh, worst_sh, spread, best_label, best_n in feature_lifts:
        lines.append(f'    {col:<32} {spread:>+7.4f}  {str(best_label):<12} {best_sh:>+11.4f}  {best_n:>7,}')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print('\n'.join(lines))
    print(f'\n[audit] report → {out_path}')


if __name__ == '__main__':
    main()
