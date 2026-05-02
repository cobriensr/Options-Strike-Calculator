"""Phase 5 — Time-stop exit policy sweep.

Tests combinations of:
  - TP threshold: 1.25, 1.5, 1.75, 2.0, 2.5, 3.0
  - Time stop:    5, 10, 15, 30, 60, 120 min, EoD

Exit logic per trade (assumes price-tick visibility so TP can fire mid-window):
  IF max_price_during_window >= TP × entry → exit at TP × entry
  ELSE → exit at price at the time-stop horizon (or EoD)

Uses p4_exits.csv data which has post-entry trajectory.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

OUT = Path(__file__).resolve().parents[1]


def main():
    df = pd.read_csv(OUT / 'outputs' / 'p4_exits.csv')
    print(f'Loaded {len(df):,} v3 trigger trajectories')

    TPS = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 5.0]
    HORIZONS = [5, 10, 15, 30, 60, 120, 240, 'EoD']

    # Helper: did max within first N minutes hit TP?
    # We know `max_mult` is overall max but we don't have max-by-window.
    # Approximation: assume TP trigger requires max within window. We have
    # mult_at_Xm which is the price AT time X — we don't have max-up-to-X.
    # For first cut, use mult_at_X for both: exit at min(TP, mult_at_X) × entry.
    # This UNDERSTATES TP-fires (because intraday max > price-at-X) but is a
    # safe lower bound.
    #
    # Better approximation: use cumulative max across the horizons we have.
    # We have mult_at_{1,2,5,10,15,30,60,90,120,240}. The cum-max across these
    # gives us a reasonable proxy for "max within the window".

    # Build cum_max columns
    horizons_min = [1, 2, 5, 10, 15, 30, 60, 90, 120, 240]
    mult_cols = [f'mult_at_{h}m' for h in horizons_min]
    df_mults = df[mult_cols].copy()
    cum_max = df_mults.cummax(axis=1)
    cum_max.columns = [f'cmax_at_{h}m' for h in horizons_min]
    df = pd.concat([df, cum_max], axis=1)

    # Build a small grid of P&L outcomes
    print('\n=== EXIT POLICY GRID: avg P&L per $100 trade ===')
    print(f'{"TP":<8}', end='')
    for h in HORIZONS:
        h_label = f'{h}m' if h != 'EoD' else 'EoD'
        print(f'{h_label:>10}', end='')
    print()
    print('-' * (8 + 10 * len(HORIZONS)))

    grid_total = {}
    grid_avg = {}
    grid_winrate = {}
    grid_tp_hit = {}

    for tp in TPS:
        line = f'{tp:>4.2f}x  '
        for h in HORIZONS:
            if h == 'EoD':
                exit_mult = df['eod_mult']
                cmax_in_window = df['max_mult']  # full-day max
            else:
                # Need cum-max up to horizon h
                cmax_col = f'cmax_at_{h}m'
                if cmax_col not in df.columns:
                    raise ValueError(f'no col {cmax_col}')
                cmax_in_window = df[cmax_col]
                exit_mult = df[f'mult_at_{h}m']

            tp_hit = cmax_in_window >= tp
            # If TP hit within the window, exit at TP. Otherwise exit at horizon price.
            realized_mult = np.where(tp_hit, tp, exit_mult)
            pnl = (realized_mult - 1) * 100
            pnl = np.clip(pnl, -100, None)  # premium floor
            avg = pnl.mean()
            grid_total[(tp, h)] = pnl.sum()
            grid_avg[(tp, h)] = avg
            grid_winrate[(tp, h)] = (pnl > 0).mean() * 100
            grid_tp_hit[(tp, h)] = tp_hit.mean() * 100
            line += f'  ${avg:>5.0f}  '
        print(line)

    # Find best
    best = max(grid_avg.items(), key=lambda kv: kv[1])
    print(f'\nBest avg P&L: TP@{best[0][0]}x + horizon={best[0][1]}m → ${best[1]:.0f}/trade')

    # Detailed top 10
    print('\n=== TOP 10 EXIT POLICIES BY AVG P&L ===')
    sorted_policies = sorted(grid_avg.items(), key=lambda kv: kv[1], reverse=True)[:10]
    print(f'{"TP":<6} {"Horizon":<10} {"avg P&L":<10} {"total P&L":<14} {"Win rate":<10} {"TP-hit %"}')
    for (tp, h), avg in sorted_policies:
        total = grid_total[(tp, h)]
        wr = grid_winrate[(tp, h)]
        tph = grid_tp_hit[(tp, h)]
        h_label = f'{h}m' if h != 'EoD' else 'EoD'
        print(f'{tp:>4.2f}x  {h_label:<8}  ${avg:>5.0f}     ${total:>8,.0f}      {wr:>5.1f}%     {tph:>5.1f}%')

    # Apply best policy to per-ticker analysis
    best_tp, best_h = best[0]
    cmax_col = 'max_mult' if best_h == 'EoD' else f'cmax_at_{best_h}m'
    exit_col = 'eod_mult' if best_h == 'EoD' else f'mult_at_{best_h}m'
    df['best_tp_hit'] = df[cmax_col] >= best_tp
    df['best_realized_mult'] = np.where(df['best_tp_hit'], best_tp, df[exit_col])
    df['best_pnl'] = ((df['best_realized_mult'] - 1) * 100).clip(lower=-100)

    # Need ticker info — re-load from p3_triggers
    p3 = pd.read_csv(OUT / 'outputs' / 'p3_triggers.csv', usecols=['option_chain_id','underlying_symbol','option_type','strike','date'])
    p3['date'] = pd.to_datetime(p3['date']).dt.strftime('%Y-%m-%d')
    df = df.merge(p3, on=['option_chain_id', 'date'], how='left').drop_duplicates(subset=['option_chain_id','date'])

    print()
    print(f'=== Best policy applied: TP@{best_tp}x + {best_h}min stop ===')
    print(f'Total trades: {len(df):,}')
    print(f'Total P&L:    ${df["best_pnl"].sum():,.0f}')
    print(f'Avg/trade:    ${df["best_pnl"].mean():.0f}')
    print(f'Win rate:     {(df["best_pnl"]>0).mean()*100:.1f}%')

    print('\n=== Per-ticker (sorted by total P&L) ===')
    by_tk = df.groupby('underlying_symbol').agg(
        trades=('best_pnl','size'),
        avg_pnl=('best_pnl','mean'),
        total_pnl=('best_pnl','sum'),
        win_rate=('best_pnl', lambda s: (s>0).mean()*100),
        tp_hit=('best_tp_hit','mean'),
    ).sort_values('total_pnl', ascending=False)
    by_tk['avg_pnl'] = by_tk['avg_pnl'].round(0).astype(int)
    by_tk['total_pnl'] = by_tk['total_pnl'].round(0).astype(int)
    by_tk['win_rate'] = by_tk['win_rate'].round(1)
    by_tk['tp_hit'] = (by_tk['tp_hit']*100).round(1)
    print(by_tk.to_string())

    # Per-day P&L
    print('\n=== Per-day P&L under best policy ===')
    daily = df.groupby('date').agg(
        trades=('best_pnl','size'),
        avg_pnl=('best_pnl','mean'),
        total_pnl=('best_pnl','sum'),
        tp_hits=('best_tp_hit','sum'),
    )
    daily['avg_pnl'] = daily['avg_pnl'].round(0).astype(int)
    daily['total_pnl'] = daily['total_pnl'].round(0).astype(int)
    print(daily.to_string())

    # Save
    df.to_csv(OUT / 'outputs' / 'p5_best_policy.csv', index=False)
    print(f'\nSaved → outputs/p5_best_policy.csv')


if __name__ == '__main__':
    main()
