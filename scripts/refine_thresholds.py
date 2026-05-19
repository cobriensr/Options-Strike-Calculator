"""Threshold refinement for I (gamma call lottery) and L (charm put lottery).

The user wants to display both filters in a UI panel and trade them with low
take-profit exits (peak ≥ 150% counts as a win). This script:

  1. Pre-computes forward R for a broad candidate set on both filters at
     offsets {25, 50, 75, 100} and horizons {60, 120, 180} min.
  2. Sweeps per-day percentile thresholds + sign-conditioning + level/change
     combinations.
  3. For each cell, computes realistic strategy P&L at multiple TP rules
     (peak ≥ 150%, 200%, 300%, 500%, 1100%) assuming option goes to 0
     if TP never reached.
  4. Identifies sweet-spot thresholds for the UI panel.

Inputs:
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv (gamma events)
  docs/tmp/forensic-multi-day/hypothesis_F_charm_vanna.csv (charm events)
  ~/Desktop/Bot-Eod-parquet/*.parquet

Outputs:
  refine_thresholds_I.csv
  refine_thresholds_L.csv
  refine_thresholds.md
"""
from __future__ import annotations

import os
import warnings
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from dotenv import load_dotenv

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

PARQUET_DIR = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
OUT = Path('docs/tmp/forensic-multi-day')

OFFSETS = [25, 50, 75, 100]
HORIZONS = [60, 120, 180]
PCT_THRESHOLDS = [0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.25, 0.50]
TP_RULES = [0.5, 1.0, 1.5, 2.0, 5.0, 10.0]


def trades_in_window(parquet_path: Path, strike: float, option_type: str,
                     expiry: date, ts_from: pd.Timestamp,
                     ts_to: pd.Timestamp) -> pd.DataFrame:
    tbl = pq.read_table(
        parquet_path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', expiry),
            ('option_type', '=', option_type),
            ('strike', '=', float(strike)),
            ('executed_at', '>=', ts_from.to_pydatetime()),
            ('executed_at', '<=', ts_to.to_pydatetime()),
        ],
        columns=['executed_at', 'price'],
    )
    if tbl.num_rows == 0:
        return pd.DataFrame()
    df = tbl.to_pandas().sort_values('executed_at').reset_index(drop=True)
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    return df


def realistic_R(R: float, TP: float) -> float:
    """Hard take-profit model: realize +TP if peak >= TP, else -1."""
    return TP if R >= TP else -1.0


def precompute_R(events: pd.DataFrame, option_type: str, direction: str,
                 ) -> pd.DataFrame:
    """Pre-compute R for each (event, offset, horizon)."""
    rows: list[dict] = []
    n = len(events)
    print(f'  pre-computing R for {n} events...')
    last_pct = -1
    for i, ev in enumerate(events.itertuples(index=False)):
        pct = int(100 * i / n)
        if pct >= last_pct + 10:
            print(f'    {pct}%')
            last_pct = pct
        d = date.fromisoformat(ev.day) if isinstance(ev.day, str) else ev.day
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        ts = pd.Timestamp(ev.captured_at)
        if ts.tzinfo is None:
            ts = ts.tz_localize('UTC')
        for off in OFFSETS:
            trade_k = (ev.strike + off) if direction == 'above' else (
                ev.strike - off)
            entry = trades_in_window(path, trade_k, option_type, d, ts,
                                       ts + pd.Timedelta(minutes=5))
            if entry.empty:
                continue
            entry_px = float(entry.iloc[0]['price'])
            if entry_px <= 0:
                continue
            for h in HORIZONS:
                forward = trades_in_window(path, trade_k, option_type, d,
                                             ts, ts + pd.Timedelta(minutes=h))
                if forward.empty:
                    continue
                max_px = float(forward['price'].max())
                rows.append({
                    'event_id': i,
                    'day': str(ev.day),
                    'captured_at': ts,
                    'strike': float(ev.strike),
                    'offset': off,
                    'horizon': h,
                    'entry_px': entry_px,
                    'max_px': max_px,
                    'R': (max_px - entry_px) / entry_px,
                })
    return pd.DataFrame(rows)


# --------------------------- I SWEEP -------------------------------------


def run_I(events_b: pd.DataFrame) -> pd.DataFrame:
    """Sweep gamma thresholds × sign conditioning × axis logic."""
    ev = events_b.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                         format='ISO8601')
    ev['day'] = ev['day'].astype(str)
    ev['abs_gamma_post'] = ev['gamma_post'].abs()
    ev['abs_delta'] = ev['gamma_delta'].abs()
    # Per-day percentile ranks
    ev['lvl_rank'] = ev.groupby('day')['abs_gamma_post'].rank(pct=True)
    ev['chg_rank'] = ev.groupby('day')['abs_delta'].rank(pct=True)

    # Broad candidate set: above-spot AND (level OR change in top 50%)
    cand = ev[(ev['event_otm_dir'] == 'above')
              & ((ev['lvl_rank'] >= 0.50) | (ev['chg_rank'] >= 0.50))]
    print(f'  I candidate set (broad): {len(cand)}')

    fr = precompute_R(cand, 'call', 'above')
    # Join features back
    cand_id = cand.reset_index(drop=True).copy()
    cand_id['event_id'] = range(len(cand_id))
    feat = cand_id[['event_id', 'gamma_post', 'gamma_delta', 'lvl_rank',
                     'chg_rank']]
    merged = fr.merge(feat, on='event_id', how='left')

    # Sweep threshold combinations
    rows: list[dict] = []
    for pct in PCT_THRESHOLDS:
        cut = 1.0 - pct
        # AND on both axes
        for sign_label, sign_filter in [
            ('all', merged),
            ('deep_neg', merged[merged['gamma_post'] < 0]),
            ('deep_pos', merged[merged['gamma_post'] > 0]),
        ]:
            for axis_label, axis_filter in [
                ('and',
                 sign_filter[(sign_filter['lvl_rank'] >= cut)
                              & (sign_filter['chg_rank'] >= cut)]),
                ('level_only', sign_filter[sign_filter['lvl_rank'] >= cut]),
                ('change_only', sign_filter[sign_filter['chg_rank'] >= cut]),
                ('or',
                 sign_filter[(sign_filter['lvl_rank'] >= cut)
                              | (sign_filter['chg_rank'] >= cut)]),
            ]:
                for off in OFFSETS:
                    for h in HORIZONS:
                        sub = axis_filter[(axis_filter['offset'] == off)
                                          & (axis_filter['horizon'] == h)]
                        if len(sub) < 5:
                            continue
                        R = sub['R'].clip(lower=-1)
                        R_ex518 = sub[sub['day'] != '2026-05-18']['R'].clip(lower=-1)
                        row = {
                            'threshold_pct': pct,
                            'sign_filter': sign_label,
                            'axis_logic': axis_label,
                            'offset': off,
                            'horizon': h,
                            'n': len(R),
                            'n_ex518': len(R_ex518),
                            'mean_R': float(R.mean()),
                            'mean_R_ex518': float(R_ex518.mean())
                            if len(R_ex518) else float('nan'),
                            'max_R': float(R.max()),
                        }
                        # Hit rates + realistic P&L at multiple TPs
                        for TP in TP_RULES:
                            row[f'hit_R{TP}'] = float((R >= TP).mean())
                            real = pd.Series([realistic_R(r, TP) for r in R])
                            row[f'realR_TP{TP}'] = float(real.mean())
                            real_ex = pd.Series(
                                [realistic_R(r, TP) for r in R_ex518])
                            row[f'realR_TP{TP}_ex518'] = float(real_ex.mean()) \
                                if len(real_ex) else float('nan')
                        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- L SWEEP -------------------------------------


def run_L(charm_events: pd.DataFrame) -> pd.DataFrame:
    """Sweep charm thresholds × sign conditioning."""
    charm = charm_events[charm_events['panel'] == 'charm'].copy()
    charm['captured_at'] = pd.to_datetime(charm['captured_at'], utc=True,
                                            format='ISO8601')
    charm['day'] = charm['day'].astype(str)
    charm['abs_delta'] = charm['delta'].abs()
    charm['dgn_rank'] = charm.groupby('day')['abs_delta'].rank(pct=True)
    # Below-spot AND broad candidate set
    below = charm[(charm['strike'] < charm['spot_at_event'])
                   & (charm['dgn_rank'] >= 0.50)]
    print(f'  L candidate set (broad): {len(below)}')

    fr = precompute_R(below, 'put', 'below')
    cand_id = below.reset_index(drop=True).copy()
    cand_id['event_id'] = range(len(cand_id))
    feat = cand_id[['event_id', 'value', 'delta', 'dgn_rank']]
    merged = fr.merge(feat, on='event_id', how='left')

    rows: list[dict] = []
    for pct in PCT_THRESHOLDS:
        cut = 1.0 - pct
        for sign_label, sign_filter in [
            ('all', merged),
            ('charm_deep_neg', merged[(merged['value'] < 0)
                                       & (merged['delta'] < 0)]),
            ('charm_deep_pos', merged[(merged['value'] > 0)
                                       & (merged['delta'] > 0)]),
            ('charm_post_neg', merged[merged['value'] < 0]),
            ('charm_post_pos', merged[merged['value'] > 0]),
        ]:
            sub_pct = sign_filter[sign_filter['dgn_rank'] >= cut]
            for off in OFFSETS:
                for h in HORIZONS:
                    sub = sub_pct[(sub_pct['offset'] == off)
                                   & (sub_pct['horizon'] == h)]
                    if len(sub) < 5:
                        continue
                    R = sub['R'].clip(lower=-1)
                    row = {
                        'threshold_pct': pct,
                        'sign_filter': sign_label,
                        'offset': off,
                        'horizon': h,
                        'n': len(R),
                        'mean_R': float(R.mean()),
                        'max_R': float(R.max()),
                    }
                    for TP in TP_RULES:
                        row[f'hit_R{TP}'] = float((R >= TP).mean())
                        real = pd.Series([realistic_R(r, TP) for r in R])
                        row[f'realR_TP{TP}'] = float(real.mean())
                    rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- DRIVER --------------------------------------


def main() -> None:
    print('Loading events...')
    events_b = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    charm = pd.read_csv(OUT / 'hypothesis_F_charm_vanna.csv')
    print(f'  gamma events: {len(events_b)}, charm/vanna: {len(charm)}')

    print('\n=== I gamma threshold sweep ===')
    i_df = run_I(events_b)
    i_df.to_csv(OUT / 'refine_thresholds_I.csv', index=False)

    print('\n=== L charm threshold sweep ===')
    l_df = run_L(charm)
    l_df.to_csv(OUT / 'refine_thresholds_L.csv', index=False)

    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
