#!/usr/bin/env python
"""Exhaustive exit-policy search across all enriched lottery fires.

For every fire in lottery_finder_fires (date 2026-04-13 → today), pulls
the post-entry tick stream from the day's EOD parquet and computes:

  Existing policies (already in DB — used as baselines):
    - realized_trail30_10_pct   (activate +30%, exit -10pp drop)
    - realized_hard30m_pct      (last tick ≤ 30 min)
    - realized_tier50_holdeod_pct
    - realized_eod_pct
    - realized_flow_inversion_pct

  New candidates (computed here from parquet):
    - exit_at_N for N ∈ {15, 30, 45, 60, 90, 120, 180} min
    - trail_25_10  (activate +25%, exit -10pp)
    - trail_50_15  (activate +50%, exit -15pp)
    - trail_75_25  (activate +75%, exit -25pp — high-conviction only)
    - cap25_floor10 (give-back stop: track peak, exit when ≥+25% peak
                     drops to peak−10pp; otherwise EOD hold)
    - flow_inv_or_trail50_15 (HYBRID: whichever fires first — flow
                              inversion signal time OR a trail_50/15 on
                              top of it)

Outputs an aggregate comparison + per-mode/tier/TOD breakdown to
docs/tmp/.

Read-only — does not modify the DB.

Usage:
    ml/.venv/bin/python scripts/exit_policy_search.py
"""

from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
PARQUET_DIR = Path.home() / 'Desktop' / 'Bot-Eod-parquet'


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env file: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'")
                )


# ============================================================
# Per-fire policy computations
# ============================================================


def exit_at_minute(prices: np.ndarray, minutes: np.ndarray, n: float, entry: float) -> float | None:
    """Return at the last tick whose minutes_since_entry ≤ n. None if no
    such tick (e.g., entry was the last print)."""
    if entry <= 0 or len(prices) == 0:
        return None
    mask = minutes <= n
    if not mask.any():
        return None
    last_idx = int(np.nonzero(mask)[0][-1])
    return ((prices[last_idx] - entry) / entry) * 100.0


def trail_pp(prices: np.ndarray, entry: float, act: float, drop_pp: float) -> float:
    """Trailing-stop with absolute-pp drawdown. Mirrors realized_trail
    helpers in api/_lib/lottery-exit-policies.ts."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    activated = False
    peak = -np.inf
    for px in prices:
        r = (px - entry) / entry * 100.0
        if not activated:
            if r >= act:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            elif r <= peak - drop_pp:
                return r
    return (prices[-1] - entry) / entry * 100.0


def cap_floor(prices: np.ndarray, entry: float, cap: float, floor_pp: float) -> float:
    """Give-back stop without an activation gate — once the peak ever
    crosses `cap`, exit on a `floor_pp` drawdown from peak. Designed to
    catch fires that briefly print a winner then fade."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    armed = False
    peak = -np.inf
    for px in prices:
        r = (px - entry) / entry * 100.0
        if r > peak:
            peak = r
        if not armed and peak >= cap:
            armed = True
        if armed and r <= peak - floor_pp:
            return r
    return (prices[-1] - entry) / entry * 100.0


def flow_inv_or_trail(
    prices: np.ndarray,
    minutes: np.ndarray,
    entry: float,
    flow_inv_min: float | None,
    act: float,
    drop_pp: float,
) -> float:
    """Hybrid: take whichever signal fires first — the flow_inv exit
    timestamp (in minutes since entry) or a trailing stop with the
    given (act, drop_pp). If flow_inv_min is None, falls back to pure
    trail; if neither triggers, holds to last tick."""
    if entry <= 0 or len(prices) == 0:
        return 0.0
    activated = False
    peak = -np.inf
    for i, px in enumerate(prices):
        r = (px - entry) / entry * 100.0
        # Flow inversion fires at this tick or earlier: take exit here.
        if flow_inv_min is not None and minutes[i] >= flow_inv_min:
            return r
        if not activated:
            if r >= act:
                activated = True
                peak = r
        else:
            if r > peak:
                peak = r
            elif r <= peak - drop_pp:
                return r
    return (prices[-1] - entry) / entry * 100.0


# ============================================================
# Per-day driver
# ============================================================


def process_date(
    target_date: str,
    fires_for_date: pd.DataFrame,
) -> pd.DataFrame:
    path = PARQUET_DIR / f'{target_date}-trades.parquet'
    if not path.exists():
        print(f'  [{target_date}] parquet missing — skipping')
        return pd.DataFrame()

    chains = fires_for_date['option_chain_id'].unique().tolist()
    # `canceled` was bool in older parquets and string ('f'/'t') in newer
    # ones — push only the chain filter, post-filter canceled in pandas.
    df = pd.read_parquet(
        path,
        columns=['executed_at', 'option_chain_id', 'price', 'canceled'],
        filters=[('option_chain_id', 'in', chains)],
    )
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')
    chain_idx = dict(iter(df.groupby('option_chain_id', sort=False)))

    N_VALUES = [15, 30, 45, 60, 90, 120, 180]
    out_rows: list[dict] = []

    for _, fire in fires_for_date.iterrows():
        chain_df = chain_idx.get(fire['option_chain_id'])
        if chain_df is None:
            continue
        entry_ts = fire['entry_time_ct']
        if entry_ts.tz is None:
            entry_ts = entry_ts.tz_localize('UTC')
        post = chain_df[chain_df['executed_at'] >= entry_ts]
        if len(post) == 0:
            continue
        prices = post['price'].astype(float).values
        delta_min = (
            (post['executed_at'] - entry_ts).dt.total_seconds() / 60.0
        ).values
        entry_price = float(fire['entry_price'])

        rec = {'id': int(fire['id'])}
        for n in N_VALUES:
            v = exit_at_minute(prices, delta_min, n, entry_price)
            rec[f'at_{n}m'] = v if v is not None else np.nan
        rec['trail_25_10'] = trail_pp(prices, entry_price, 25, 10)
        rec['trail_50_15'] = trail_pp(prices, entry_price, 50, 15)
        rec['trail_75_25'] = trail_pp(prices, entry_price, 75, 25)
        rec['cap25_floor10'] = cap_floor(prices, entry_price, 25, 10)

        # Hybrid: need flow_inversion exit time (minutes since entry).
        # Approximate it from the existing realized_flow_inversion_pct
        # value: when the column is non-null, the price at the inversion
        # is (1 + pct/100) * entry — we re-find the matching tick and
        # extract its minute. If we can't, hybrid degenerates to pure
        # trail.
        fi = fire.get('flow_inv')
        flow_inv_min = None
        if pd.notna(fi):
            target_price = entry_price * (1 + float(fi) / 100.0)
            close_idx = int(np.argmin(np.abs(prices - target_price)))
            flow_inv_min = float(delta_min[close_idx])
        rec['flow_inv_or_trail50_15'] = flow_inv_or_trail(
            prices, delta_min, entry_price, flow_inv_min, 50, 15
        )
        out_rows.append(rec)

    return pd.DataFrame(out_rows)


# ============================================================
# Main
# ============================================================


def latest_fire_date(conn) -> str:
    cur = conn.cursor()
    cur.execute('SELECT MAX(date) FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL')
    row = cur.fetchone()
    if row is None or row[0] is None:
        return 'unknown'
    return row[0].isoformat() if hasattr(row[0], 'isoformat') else str(row[0])[:10]


def main() -> None:
    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    out_path = ROOT / 'docs' / 'tmp' / f'lottery-exit-policy-search-{latest_fire_date(conn)}.md'
    print('[search] loading fires…')
    fires = pd.read_sql(
        """
        SELECT id, date, option_chain_id, entry_time_ct, entry_price,
               mode, tod, score,
               peak_ceiling_pct      AS peak,
               realized_trail30_10_pct   AS trail,
               realized_hard30m_pct      AS hard30,
               realized_tier50_holdeod_pct AS tier50,
               realized_eod_pct          AS eod,
               realized_flow_inversion_pct AS flow_inv
        FROM lottery_finder_fires
        WHERE peak_ceiling_pct IS NOT NULL
        """,
        conn,
    )
    print(f'[search] {len(fires):,} enriched fires across '
          f'{fires["date"].nunique()} dates')

    # Pre-compute tier label.
    fires['tier'] = fires['score'].apply(
        lambda s: 'T1' if pd.notna(s) and s >= 18 else
                  ('T2' if pd.notna(s) and s >= 12 else 'T3')
    )

    t0 = time.time()
    derived_chunks: list[pd.DataFrame] = []
    for d, sub in fires.groupby('date', sort=True):
        date_str = d.isoformat() if hasattr(d, 'isoformat') else str(d)[:10]
        print(f'  [{date_str}] processing {len(sub):,} fires…')
        chunk = process_date(date_str, sub)
        derived_chunks.append(chunk)
    derived = pd.concat(derived_chunks, ignore_index=True) if derived_chunks else pd.DataFrame()
    print(f'[search] derived in {time.time() - t0:.1f}s; rows={len(derived):,}')

    # Merge derived back onto fires for the comparison.
    df = fires.merge(derived, on='id', how='left')

    POLICIES = [
        ('flow_inv', 'flow_inv (existing)'),
        ('trail', 'trail30/10 (existing)'),
        ('hard30', 'hard30m (existing)'),
        ('tier50', 'tier50_hold (existing)'),
        ('eod', 'EOD_hold (existing)'),
        ('at_15m', 'exit at 15 min'),
        ('at_30m', 'exit at 30 min'),
        ('at_45m', 'exit at 45 min'),
        ('at_60m', 'exit at 60 min'),
        ('at_90m', 'exit at 90 min'),
        ('at_120m', 'exit at 120 min'),
        ('at_180m', 'exit at 180 min'),
        ('trail_25_10', 'trail 25/10'),
        ('trail_50_15', 'trail 50/15'),
        ('trail_75_25', 'trail 75/25'),
        ('cap25_floor10', 'cap25_floor10'),
        ('flow_inv_or_trail50_15', 'HYBRID flow_inv OR trail50/15'),
        ('peak', 'peak_ceiling* (look-ahead)'),
    ]

    def stats(s: pd.Series) -> tuple[int, float, float, float, float]:
        s = s.dropna()
        n = len(s)
        if n == 0:
            return 0, np.nan, np.nan, np.nan, np.nan
        mean = s.mean(); med = s.median()
        std = s.std(ddof=1) if n > 1 else 0.0
        win = (s > 0).mean() * 100
        sharpe = mean / std if std > 0 else 0.0
        return n, mean, med, win, sharpe

    lines: list[str] = []
    lines.append('# Lottery exit-policy search (parquet-derived candidates)\n')
    lines.append(f'Dataset: {len(df):,} enriched fires across '
                 f'{df["date"].nunique()} trading days '
                 f'({df["date"].min()} → {df["date"].max()}), '
                 f'{df["ticker"].nunique() if "ticker" in df.columns else "?"} tickers.\n'.replace('"',""))

    lines.append('## Aggregate comparison (all fires)\n')
    lines.append(f'    {"policy":<32} {"n":>7}  {"mean%":>8}  {"med%":>7}  {"win%":>6}  {"Sharpe":>7}')
    rows = []
    for col, label in POLICIES:
        if col not in df.columns:
            continue
        n, mean, med, win, sh = stats(df[col])
        rows.append((label, col, n, mean, med, win, sh))
    # Sort by mean (excluding peak which is look-ahead)
    rows_sortable = [r for r in rows if r[1] != 'peak']
    rows_sortable.sort(key=lambda r: -r[3])
    for label, col, n, mean, med, win, sh in rows_sortable:
        lines.append(
            f'    {label:<32} {n:>7,}  {mean:>+7.2f}%  {med:>+6.2f}%  {win:>5.1f}%  {sh:>+7.4f}'
        )
    # Append peak last as ceiling reference
    for label, col, n, mean, med, win, sh in rows:
        if col == 'peak':
            lines.append(
                f'    {label:<32} {n:>7,}  {mean:>+7.2f}%  {med:>+6.2f}%  {win:>5.1f}%  {sh:>+7.4f}'
            )

    # Per-tier breakdown (where the alpha lives)
    lines.append('\n## Per-tier comparison\n')
    for tlbl in ['T1', 'T2', 'T3']:
        sub = df[df['tier'] == tlbl]
        if len(sub) == 0:
            continue
        lines.append(f'### {tlbl}  (n={len(sub):,})\n')
        rows = []
        for col, label in POLICIES:
            if col not in sub.columns:
                continue
            n, mean, med, win, sh = stats(sub[col])
            rows.append((label, col, n, mean, med, win, sh))
        rows_sortable = [r for r in rows if r[1] != 'peak']
        rows_sortable.sort(key=lambda r: -r[3])
        lines.append(f'    {"policy":<32} {"n":>7}  {"mean%":>8}  {"med%":>7}  {"win%":>6}  {"Sharpe":>7}')
        for label, col, n, mean, med, win, sh in rows_sortable[:12]:  # top 12
            lines.append(
                f'    {label:<32} {n:>7,}  {mean:>+7.2f}%  {med:>+6.2f}%  {win:>5.1f}%  {sh:>+7.4f}'
            )
        lines.append('')

    # Per-mode breakdown
    lines.append('## Per-mode comparison\n')
    for mode, sub in df.groupby('mode'):
        lines.append(f'### {mode}  (n={len(sub):,})\n')
        rows = []
        for col, label in POLICIES:
            if col not in sub.columns:
                continue
            n, mean, med, win, sh = stats(sub[col])
            rows.append((label, col, n, mean, med, win, sh))
        rows_sortable = [r for r in rows if r[1] != 'peak']
        rows_sortable.sort(key=lambda r: -r[3])
        lines.append(f'    {"policy":<32} {"n":>7}  {"mean%":>8}  {"med%":>7}  {"win%":>6}  {"Sharpe":>7}')
        for label, col, n, mean, med, win, sh in rows_sortable[:10]:
            lines.append(
                f'    {label:<32} {n:>7,}  {mean:>+7.2f}%  {med:>+6.2f}%  {win:>5.1f}%  {sh:>+7.4f}'
            )
        lines.append('')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print('\n'.join(lines))
    print(f'\n[search] report written to {out_path}')


if __name__ == '__main__':
    main()
