#!/usr/bin/env python
"""Silent → Boom pattern detector — empirical validation.

Tests whether the temporal-discontinuity pattern (chain trades silently
for 15-20 min, then a single 5-min bar shows a huge ask-side block
relative to its own baseline) has predictive value for forward
option returns.

Distinct from:
  - lottery_finder (sustained 5-min cumulative bursts) — looks at the
    aggregate flow shape, not the step-change anomaly.
  - UW Flow Alerts (day-cumulative criteria) — fires once per day per
    chain, not per intraday spike event.

Read-only — no DB writes, no production deps. Output to docs/tmp/.

Usage:
    ml/.venv/bin/python scripts/silent_boom_audit.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'
OUT_PATH = ROOT / 'docs' / 'tmp' / 'silent-boom-audit-2026-05-07.md'

# Pattern parameters — tunable. Picked from the SPY 727P chart shape:
# baseline ~1-2K vol per 5-min, then ~30K spike (>10x baseline) at 73%
# ask. We start a notch looser than that case to allow generalization.
BASELINE_BUCKETS = 4         # 4 × 5min = 20-min trailing baseline window
BASELINE_MEDIAN_MAX = 500    # baseline median vol must be ≤ this (silence)
MIN_SPIKE_VOL = 1_000        # absolute volume floor for the spike bar
SPIKE_MULTIPLIER = 5.0       # spike must be ≥ this × baseline median
ASK_PCT_MIN = 0.70           # ask-side dominance in the spike bar
VOL_OI_MIN = 0.25            # spike volume / max OI seen for chain
COOLDOWN_BUCKETS = 12        # 60-min cooldown between fires on same chain

# Forward-return horizons (in 5-min buckets).
FORWARD_BUCKETS = [6, 12, 24]  # 30 min, 60 min, 120 min
HORIZON_LABELS = ['30m', '60m', '120m']

# Min OI to consider a chain (avoid trades on empty chains).
MIN_OI = 100


def load_env() -> None:
    if not ENV_FILE.exists():
        return
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


def list_parquet_dates() -> list[str]:
    out: list[str] = []
    for p in sorted(PARQUET_DIR.glob('*-trades.parquet')):
        m = re.match(r'(\d{4}-\d{2}-\d{2})-trades\.parquet', p.name)
        if m:
            out.append(m.group(1))
    return out


def load_parquet_for_audit(date_str: str) -> pd.DataFrame:
    """Load + bucket the day's parquet to per-(chain, 5min) rows."""
    path = PARQUET_DIR / f'{date_str}-trades.parquet'
    if not path.exists():
        return pd.DataFrame()
    df = pd.read_parquet(
        path,
        columns=[
            'executed_at', 'underlying_symbol', 'option_chain_id',
            'option_type', 'strike', 'expiry', 'price', 'size', 'side',
            'open_interest', 'canceled',
        ],
    )
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')

    df['bucket'] = df['executed_at'].dt.floor('5min')
    df['ask_size'] = np.where(df['side'] == 'ask', df['size'], 0)
    df['bid_size'] = np.where(df['side'] == 'bid', df['size'], 0)
    df['notional'] = df['size'] * df['price']

    grouped = df.groupby(['option_chain_id', 'bucket'], sort=True).agg(
        ticker=('underlying_symbol', 'first'),
        option_type=('option_type', 'first'),
        strike=('strike', 'first'),
        expiry=('expiry', 'first'),
        size=('size', 'sum'),
        ask_size=('ask_size', 'sum'),
        bid_size=('bid_size', 'sum'),
        max_oi=('open_interest', 'max'),
        last_price=('price', 'last'),
        vwap_num=('notional', 'sum'),
        vwap_den=('size', 'sum'),
    ).reset_index()
    grouped['vwap'] = grouped['vwap_num'] / grouped['vwap_den']
    grouped = grouped.drop(columns=['vwap_num', 'vwap_den'])
    return grouped


def detect_silent_boom_per_chain(
    chain_df: pd.DataFrame, ticker: str, chain_id: str
) -> list[dict]:
    """Walk forward through one chain's 5-min buckets, fire on
    silent→boom pattern."""
    fires: list[dict] = []
    if len(chain_df) < BASELINE_BUCKETS + 1:
        return fires
    chain_df = chain_df.sort_values('bucket').reset_index(drop=True)
    last_fire_idx = -COOLDOWN_BUCKETS - 1

    sizes = chain_df['size'].to_numpy()
    ask_sizes = chain_df['ask_size'].to_numpy()
    bid_sizes = chain_df['bid_size'].to_numpy()
    max_ois = chain_df['max_oi'].to_numpy()
    vwaps = chain_df['vwap'].to_numpy()
    last_prices = chain_df['last_price'].to_numpy()
    buckets_arr = chain_df['bucket'].to_numpy()

    for i in range(BASELINE_BUCKETS, len(chain_df)):
        if i - last_fire_idx < COOLDOWN_BUCKETS:
            continue

        # Baseline = median of prior N buckets (silence test)
        baseline = float(np.median(sizes[i - BASELINE_BUCKETS:i]))
        if baseline > BASELINE_MEDIAN_MAX:
            continue

        cur_vol = float(sizes[i])
        if cur_vol < MIN_SPIKE_VOL:
            continue
        # Use max(baseline, 100) to avoid divide-by-near-zero
        if cur_vol < SPIKE_MULTIPLIER * max(baseline, 100):
            continue

        ab = float(ask_sizes[i] + bid_sizes[i])
        if ab == 0:
            continue
        ask_pct = float(ask_sizes[i]) / ab
        if ask_pct < ASK_PCT_MIN:
            continue

        oi = float(max_ois[i])
        if oi < MIN_OI:
            continue
        vol_oi = cur_vol / oi
        if vol_oi < VOL_OI_MIN:
            continue

        # Entry = vwap of the spike bucket (what you'd realistically pay
        # if you saw the print and hit the ask).
        entry = float(vwaps[i]) if not np.isnan(vwaps[i]) else float(last_prices[i])
        if entry <= 0:
            continue

        # Forward returns at each horizon — last price at bucket i+H
        # (or final available bucket if shorter than H). Peak = max
        # last_price across i+1 to end-of-day.
        forward = {}
        for h, label in zip(FORWARD_BUCKETS, HORIZON_LABELS):
            target = i + h
            if target < len(chain_df):
                p = float(last_prices[target])
            else:
                p = float(last_prices[-1])
            forward[f'ret_{label}_pct'] = (p - entry) / entry * 100.0 if entry > 0 else 0.0

        post_prices = last_prices[i + 1:]
        if len(post_prices) > 0:
            peak = float(np.max(post_prices))
            peak_pct = (peak - entry) / entry * 100.0 if entry > 0 else 0.0
        else:
            peak_pct = 0.0
        eod = float(last_prices[-1])
        eod_pct = (eod - entry) / entry * 100.0 if entry > 0 else 0.0

        fires.append({
            'ticker': ticker,
            'chain_id': chain_id,
            'bucket': pd.Timestamp(buckets_arr[i]),
            'spike_vol': cur_vol,
            'baseline_vol': baseline,
            'spike_ratio': cur_vol / max(baseline, 1),
            'ask_pct': ask_pct,
            'vol_oi': vol_oi,
            'entry_price': entry,
            'peak_pct': peak_pct,
            'eod_pct': eod_pct,
            **forward,
        })
        last_fire_idx = i

    return fires


def stats(s: pd.Series) -> tuple[int, float, float, float, float]:
    s = s.dropna()
    n = len(s)
    if n < 10:
        return n, np.nan, np.nan, np.nan, np.nan
    mean = float(s.mean())
    med = float(s.median())
    win = float((s > 0).mean()) * 100.0
    std = float(s.std(ddof=1)) if n > 1 else 0.0
    sharpe = mean / std if std > 0 else 0.0
    return n, mean, med, win, sharpe


def main() -> None:
    load_env()
    dates = list_parquet_dates()
    print(f'[silent-boom] scanning {len(dates)} parquet days')

    all_fires: list[dict] = []
    t0 = time.time()
    for date_str in dates:
        td = time.time()
        bucketed = load_parquet_for_audit(date_str)
        if bucketed.empty:
            continue
        per_date_fires = 0
        for chain_id, sub in bucketed.groupby('option_chain_id', sort=False):
            ticker = sub['ticker'].iloc[0]
            fires = detect_silent_boom_per_chain(sub, ticker, chain_id)
            for f in fires:
                f['date'] = date_str
                f['option_type'] = sub['option_type'].iloc[0]
                f['strike'] = float(sub['strike'].iloc[0])
            all_fires.extend(fires)
            per_date_fires += len(fires)
        print(f'  [{date_str}] chains={bucketed["option_chain_id"].nunique():>5,} '
              f'fires={per_date_fires:>5,} '
              f'({time.time() - td:.1f}s)')
    print(f'\n[silent-boom] total fires across {len(dates)} days: {len(all_fires):,} '
          f'in {time.time() - t0:.1f}s')

    if not all_fires:
        sys.exit('[silent-boom] no fires detected — try loosening parameters')

    df = pd.DataFrame(all_fires)

    lines = ['# Silent → Boom pattern audit\n']
    lines.append(f'Scanned {len(dates)} parquet days '
                 f'({dates[0]} → {dates[-1]}).\n')
    lines.append('## Detection parameters\n')
    lines.append(f'    BASELINE_BUCKETS    = {BASELINE_BUCKETS}  (× 5min = '
                 f'{BASELINE_BUCKETS * 5}min trailing window)')
    lines.append(f'    BASELINE_MEDIAN_MAX = {BASELINE_MEDIAN_MAX}  (silence threshold)')
    lines.append(f'    MIN_SPIKE_VOL       = {MIN_SPIKE_VOL:,}')
    lines.append(f'    SPIKE_MULTIPLIER    = {SPIKE_MULTIPLIER}× of baseline')
    lines.append(f'    ASK_PCT_MIN         = {ASK_PCT_MIN}')
    lines.append(f'    VOL_OI_MIN          = {VOL_OI_MIN}')
    lines.append(f'    COOLDOWN_BUCKETS    = {COOLDOWN_BUCKETS}  '
                 f'(× 5min = {COOLDOWN_BUCKETS * 5}min between fires/chain)')
    lines.append(f'    MIN_OI              = {MIN_OI}')

    lines.append(f'\n## Aggregate forward returns (n={len(df):,})\n')
    lines.append(
        f'    {"horizon":<10} {"n":>6} {"mean%":>8} {"med%":>7} {"win%":>5} {"Sharpe":>7}'
    )
    for label in [*HORIZON_LABELS, 'peak', 'eod']:
        col = (f'ret_{label}_pct' if label not in ('peak', 'eod')
               else f'{label}_pct')
        if col not in df.columns:
            continue
        n, mean, med, win, sh = stats(df[col])
        if n == 0:
            continue
        lines.append(
            f'    {label:<10} {n:>6,} {mean:>+7.2f}%  {med:>+6.2f}%  {win:>4.1f}% {sh:>+7.4f}'
        )

    # By option type
    lines.append('\n## By option type\n')
    for ot in ['C', 'P']:
        sub = df[df['option_type'] == ot]
        if len(sub) < 10:
            continue
        lines.append(f'### {ot} (n={len(sub):,})')
        for label in HORIZON_LABELS:
            col = f'ret_{label}_pct'
            n, mean, med, win, sh = stats(sub[col])
            lines.append(
                f'    {label:<6} n={n:>5,} mean={mean:>+6.2f}% '
                f'med={med:>+5.2f}% win={win:>4.1f}% Sharpe={sh:>+6.4f}'
            )
        n, mean, med, win, sh = stats(sub['peak_pct'])
        lines.append(
            f'    peak  n={n:>5,} mean={mean:>+6.2f}% '
            f'med={med:>+5.2f}% win={win:>4.1f}% Sharpe={sh:>+6.4f}'
        )

    # Top tickers by fire count
    lines.append('\n## Top 25 tickers by fire count\n')
    lines.append(
        f'    {"ticker":<7} {"fires":>6} {"mean_60m%":>10} {"win_60m%":>9} {"mean_peak%":>11}'
    )
    by_ticker = df.groupby('ticker').agg(
        n=('chain_id', 'count'),
        mean_60m=('ret_60m_pct', 'mean'),
        win_60m=('ret_60m_pct', lambda s: (s > 0).mean() * 100),
        mean_peak=('peak_pct', 'mean'),
    ).sort_values('n', ascending=False).head(25)
    for ticker, row in by_ticker.iterrows():
        lines.append(
            f'    {ticker:<7} {int(row["n"]):>6,} {row["mean_60m"]:>+9.2f}%  '
            f'{row["win_60m"]:>7.1f}%  {row["mean_peak"]:>+10.2f}%'
        )

    # Sharpest individual fires (top 20 by peak)
    lines.append('\n## Top 20 fires by peak realized %\n')
    lines.append(
        f'    {"date":<11} {"ticker":<7} {"otype":<5} {"bucket_ct":<10} '
        f'{"entry":>7} {"peak%":>8} {"60m%":>7} {"eod%":>7} {"spike_ratio":>11}'
    )
    top = df.sort_values('peak_pct', ascending=False).head(20)
    for r in top.itertuples(index=False):
        ct = pd.Timestamp(r.bucket).tz_convert('America/Chicago').strftime('%H:%M')
        lines.append(
            f'    {r.date:<11} {r.ticker:<7} {r.option_type:<5} {ct:<10} '
            f'${r.entry_price:>6.2f} {r.peak_pct:>+7.1f}% '
            f'{r.ret_60m_pct:>+6.1f}% {r.eod_pct:>+6.1f}% '
            f'{r.spike_ratio:>10.1f}×'
        )

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text('\n'.join(lines))
    print('\n'.join(lines[-30:]))
    print(f'\n[silent-boom] full report → {OUT_PATH}')


if __name__ == '__main__':
    main()
