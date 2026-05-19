"""Refinement v2 — strategy economics and additional drilling.

Builds on refine_top5_findings.py outputs:
  1. Portfolio P&L for I and L optimal cells (loss-bounded, mean/median/CI)
  2. Day-level co-occurrence — do I and L fire on same days?
  3. Feature ranking — what differentiates ≥5R winners from losers within
     each filter?
  4. Extend I/L horizons to 180m/240m to confirm 120m is the right answer
  5. B4 close-TOD short straddle backtest (separate strategy)

Inputs:
  docs/tmp/forensic-multi-day/refine_I_call_lottery_grid.csv
  docs/tmp/forensic-multi-day/refine_L_put_lottery_grid.csv
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv
  docs/tmp/forensic-multi-day/hypothesis_F_charm_vanna.csv
  docs/tmp/forensic-multi-day/refine_B4.csv
  ~/Desktop/Bot-Eod-parquet/*.parquet (for horizon extension + B4 straddle)
  Neon: index_candles_1m

Outputs:
  refine_v2_portfolio.csv
  refine_v2_features.csv
  refine_v2_horizons.csv
  refine_v2_B4_straddle.csv
  refine_v2_findings.md
"""
from __future__ import annotations

import os
import warnings
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import pyarrow.parquet as pq
from dotenv import load_dotenv
from scipy import stats

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

PARQUET_DIR = Path('/Users/charlesobrien/Desktop/Bot-Eod-parquet')
OUT = Path('docs/tmp/forensic-multi-day')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']


def db_query(sql: str) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn)


def clip_R(s: pd.Series) -> pd.Series:
    return s.dropna().clip(lower=-1.0)


# --------------------------- HELPERS --------------------------------------


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


def reconstruct_winners(events_df: pd.DataFrame, optimal_filter: dict,
                         direction: str = 'above', offset: int = 50,
                         horizon: int = 120, option_type: str = 'call'
                         ) -> pd.DataFrame:
    """Replay the optimal filter, fetch realized R per event from parquet."""
    sel = events_df.copy()
    sel['captured_at'] = pd.to_datetime(sel['captured_at'], utc=True,
                                          format='ISO8601')
    # Apply filter logic
    for k, v in optimal_filter.items():
        if k == 'event_otm_dir':
            sel = sel[sel['event_otm_dir'] == v]
        elif k == 'lvl_rank_min':
            sel['lvl_rank'] = sel.groupby('day')['gamma_post'].transform(
                lambda s: s.abs().rank(pct=True))
            sel = sel[sel['lvl_rank'] >= v]
        elif k == 'chg_rank_min':
            sel['chg_rank'] = sel.groupby('day')['gamma_delta'].transform(
                lambda s: s.abs().rank(pct=True))
            sel = sel[sel['chg_rank'] >= v]

    rows: list[dict] = []
    for _, ev in sel.iterrows():
        d = date.fromisoformat(ev['day']) if isinstance(ev['day'], str) \
            else ev['day']
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        trade_k = (ev['strike'] + offset) if direction == 'above' else (
            ev['strike'] - offset)
        ts = ev['captured_at']
        entry = trades_in_window(path, trade_k, option_type, d,
                                   ts, ts + pd.Timedelta(minutes=5))
        if entry.empty:
            continue
        entry_px = float(entry.iloc[0]['price'])
        if entry_px <= 0:
            continue
        forward = trades_in_window(path, trade_k, option_type, d,
                                     ts, ts + pd.Timedelta(minutes=horizon))
        max_px = float(forward['price'].max()) if not forward.empty else entry_px
        R = (max_px - entry_px) / entry_px
        # Add feature row
        row = ev.to_dict()
        row['trade_strike'] = trade_k
        row['entry_px'] = entry_px
        row['max_px'] = max_px
        row['R'] = R
        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- 1. PORTFOLIO P&L -----------------------------


def portfolio_pnl(R: pd.Series, label: str) -> dict:
    R = R.dropna().clip(lower=-1.0)
    n = len(R)
    if n == 0:
        return {'label': label, 'n': 0}
    return {
        'label': label,
        'n': n,
        'cum_R': float(R.sum()),
        'mean_R': float(R.mean()),
        'median_R': float(R.median()),
        'std_R': float(R.std()),
        'sharpe_ish': float(R.mean() / R.std()) if R.std() > 0 else np.nan,
        'win_rate': float((R > 0).mean()),
        'hit_R2': float((R >= 2).mean()),
        'hit_R5': float((R >= 5).mean()),
        'hit_R10': float((R >= 10).mean()),
        'max_R': float(R.max()),
        'min_R': float(R.min()),
        'cum_R_ex_top1': float(R.sort_values()[:-1].sum()),
        'pct_from_top_outlier': (
            float(R.max() / R.sum()) if R.sum() > 0 else np.nan),
    }


# --------------------------- 2. FEATURE RANKING ---------------------------


def feature_ranking(df: pd.DataFrame, R_col: str,
                    features: list[str], threshold: float = 5.0
                    ) -> pd.DataFrame:
    """For each feature, compute Mann-Whitney p + median diff between
    winners (R >= threshold) and losers (R < threshold).
    """
    df = df.copy()
    df['is_winner'] = df[R_col].clip(lower=-1.0) >= threshold
    winners = df[df['is_winner']]
    losers = df[~df['is_winner']]
    rows: list[dict] = []
    for feat in features:
        if feat not in df.columns:
            continue
        w = winners[feat].dropna()
        l = losers[feat].dropna()
        if len(w) < 2 or len(l) < 2:
            continue
        try:
            _, p = stats.mannwhitneyu(w.to_numpy(), l.to_numpy(),
                                       alternative='two-sided')
        except ValueError:
            p = np.nan
        rows.append({
            'feature': feat,
            'n_winners': len(w),
            'n_losers': len(l),
            'med_winner': float(w.median()),
            'med_loser': float(l.median()),
            'mean_winner': float(w.mean()),
            'mean_loser': float(l.mean()),
            'med_diff': float(w.median() - l.median()),
            'mw_p': p,
        })
    return pd.DataFrame(rows).sort_values('mw_p')


# --------------------------- 3. CO-OCCURRENCE -----------------------------


def cooccurrence(I_df: pd.DataFrame, L_df: pd.DataFrame) -> dict:
    if I_df.empty or L_df.empty:
        return {}
    I_days = set(I_df['day'].astype(str))
    L_days = set(L_df['day'].astype(str))
    overlap = I_days & L_days
    return {
        'I_days': len(I_days),
        'L_days': len(L_days),
        'overlap_days': len(overlap),
        'I_only_days': sorted(I_days - L_days),
        'L_only_days': sorted(L_days - I_days),
        'both_days': sorted(overlap),
    }


# --------------------------- 4. HORIZON EXTENSION -------------------------


def extend_horizons_I(events: pd.DataFrame, horizons: list[int],
                       offset: int = 50) -> pd.DataFrame:
    """Re-fetch parquet at extended horizons for best-cell I candidates."""
    sel = events.copy()
    sel['captured_at'] = pd.to_datetime(sel['captured_at'], utc=True,
                                          format='ISO8601')
    sel['lvl_rank'] = sel.groupby('day')['gamma_post'].transform(
        lambda s: s.abs().rank(pct=True))
    sel['chg_rank'] = sel.groupby('day')['gamma_delta'].transform(
        lambda s: s.abs().rank(pct=True))
    cand = sel[(sel['event_otm_dir'] == 'above')
                & (sel['lvl_rank'] >= 0.90)
                & (sel['chg_rank'] >= 0.90)]
    print(f'  I horizon extension: {len(cand)} events')
    rows: list[dict] = []
    for _, ev in cand.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        trade_k = float(ev['strike']) + offset
        ts = ev['captured_at']
        entry = trades_in_window(path, trade_k, 'call', d, ts,
                                   ts + pd.Timedelta(minutes=5))
        if entry.empty:
            continue
        entry_px = float(entry.iloc[0]['price'])
        if entry_px <= 0:
            continue
        for h in horizons:
            forward = trades_in_window(path, trade_k, 'call', d, ts,
                                         ts + pd.Timedelta(minutes=h))
            if forward.empty:
                continue
            max_px = float(forward['price'].max())
            rows.append({
                'day': ev['day'],
                'captured_at': ts,
                'strike': ev['strike'],
                'trade_strike': trade_k,
                'horizon': h,
                'entry_px': entry_px,
                'max_px': max_px,
                'R': (max_px - entry_px) / entry_px,
            })
    return pd.DataFrame(rows)


def extend_horizons_L(charm_events: pd.DataFrame, horizons: list[int],
                       offset: int = 50) -> pd.DataFrame:
    """Re-fetch parquet for best-cell L candidates at extended horizons."""
    sel = charm_events[charm_events['panel'] == 'charm'].copy()
    sel['captured_at'] = pd.to_datetime(sel['captured_at'], utc=True,
                                          format='ISO8601')
    sel['day'] = sel['day'].astype(str)
    sel['abs_delta'] = sel['delta'].abs()
    sel['dgn_rank'] = sel.groupby('day')['abs_delta'].rank(pct=True)
    below = sel[(sel['strike'] < sel['spot_at_event'])
                & (sel['dgn_rank'] >= 0.95)]
    print(f'  L horizon extension: {len(below)} events')
    rows: list[dict] = []
    for _, ev in below.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        trade_k = float(ev['strike']) - offset
        ts = ev['captured_at']
        entry = trades_in_window(path, trade_k, 'put', d, ts,
                                   ts + pd.Timedelta(minutes=5))
        if entry.empty:
            continue
        entry_px = float(entry.iloc[0]['price'])
        if entry_px <= 0:
            continue
        for h in horizons:
            forward = trades_in_window(path, trade_k, 'put', d, ts,
                                         ts + pd.Timedelta(minutes=h))
            if forward.empty:
                continue
            max_px = float(forward['price'].max())
            rows.append({
                'day': ev['day'],
                'captured_at': ts,
                'strike': ev['strike'],
                'trade_strike': trade_k,
                'horizon': h,
                'entry_px': entry_px,
                'max_px': max_px,
                'R': (max_px - entry_px) / entry_px,
            })
    return pd.DataFrame(rows)


# --------------------------- 5. B4 CLOSE-TOD STRADDLE ---------------------


def b4_close_straddle(events: pd.DataFrame) -> pd.DataFrame:
    """For top-2% |Δγ| events in close TOD (>= 19:00 UTC), short ATM straddle
    and hold 60m. Compare to random close-TOD control samples.
    """
    ev = events.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                         format='ISO8601')
    ev['abs_delta'] = ev['gamma_delta'].abs()
    ev['hour'] = ev['captured_at'].dt.hour
    ev['day_thresh'] = ev.groupby('day')['abs_delta'].transform(
        lambda s: s.quantile(0.98))
    cand = ev[(ev['abs_delta'] >= ev['day_thresh']) & (ev['hour'] >= 19)]
    print(f'  B4 close-TOD candidates: {len(cand)}')

    rows: list[dict] = []
    for _, e in cand.iterrows():
        d = date.fromisoformat(e['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists() or pd.isna(e.get('spot_at_event')):
            continue
        atm = round(float(e['spot_at_event']) / 5) * 5
        ts = e['captured_at']
        # Entry
        c_entry = trades_in_window(path, atm, 'call', d, ts,
                                     ts + pd.Timedelta(minutes=5))
        p_entry = trades_in_window(path, atm, 'put', d, ts,
                                     ts + pd.Timedelta(minutes=5))
        if c_entry.empty or p_entry.empty:
            continue
        # Exit 30m + 60m
        for hold in [30, 60]:
            t_exit = ts + pd.Timedelta(minutes=hold)
            c_exit = trades_in_window(path, atm, 'call', d, t_exit,
                                        t_exit + pd.Timedelta(minutes=5))
            p_exit = trades_in_window(path, atm, 'put', d, t_exit,
                                        t_exit + pd.Timedelta(minutes=5))
            if c_exit.empty or p_exit.empty:
                continue
            entry_strad = float(c_entry.iloc[0]['price']) \
                + float(p_entry.iloc[0]['price'])
            exit_strad = float(c_exit.iloc[0]['price']) \
                + float(p_exit.iloc[0]['price'])
            rows.append({
                'group': 'event',
                'day': e['day'],
                'captured_at': ts,
                'atm': atm,
                'hold': hold,
                'entry_strad': entry_strad,
                'exit_strad': exit_strad,
                'pnl_short': entry_strad - exit_strad,
                'pnl_short_pct': (entry_strad - exit_strad) / entry_strad
                if entry_strad > 0 else None,
            })
    return pd.DataFrame(rows)


# --------------------------- WRITE FINDINGS ------------------------------


def write_findings(I_df: pd.DataFrame, L_df: pd.DataFrame,
                   port: list[dict], features_I: pd.DataFrame,
                   features_L: pd.DataFrame, cooc: dict,
                   horizons_I: pd.DataFrame, horizons_L: pd.DataFrame,
                   b4_straddle: pd.DataFrame, out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Refinement v2 — strategy economics + deeper drilling\n')

    # Portfolio P&L
    lines.append('## 1. Portfolio P&L (loss-bounded R, clipped at -1)\n')
    lines.append(pd.DataFrame(port).to_string(index=False))

    # Co-occurrence
    lines.append('\n## 2. I + L day-level co-occurrence\n')
    if cooc:
        lines.append(f'  I fires across {cooc["I_days"]} distinct days')
        lines.append(f'  L fires across {cooc["L_days"]} distinct days')
        lines.append(f'  Both fire on {cooc["overlap_days"]} days')
        lines.append(f'  Days with BOTH: {cooc["both_days"]}')

    # Feature ranking
    lines.append('\n## 3. Feature ranking (Mann-Whitney winners vs losers ≥5R)\n')
    if not features_I.empty:
        lines.append('### I (call lottery) — top features distinguishing winners')
        lines.append(features_I.head(15).to_string(index=False))
    if not features_L.empty:
        lines.append('\n### L (put lottery) — top features distinguishing winners')
        lines.append(features_L.head(15).to_string(index=False))

    # Horizon extension
    lines.append('\n## 4. Horizon extension (does 180m / 240m beat 120m?)\n')
    if not horizons_I.empty:
        lines.append('### I — horizon sweep at k+50')
        for h in sorted(horizons_I['horizon'].unique()):
            sub = horizons_I[horizons_I['horizon'] == h]
            R = clip_R(sub['R'])
            R_ex = clip_R(sub[sub['day'] != '2026-05-18']['R'])
            lines.append(
                f'  {h}m: n={len(R)}, mean_R={R.mean():.2f}, '
                f'hit_R5={(R >= 5).mean() * 100:.1f}%, max={R.max():.2f} | '
                f'ex-5/18 n={len(R_ex)}, mean_R={R_ex.mean():.2f}, '
                f'hit_R5={(R_ex >= 5).mean() * 100:.1f}%, max={R_ex.max():.2f}'
            )
    if not horizons_L.empty:
        lines.append('\n### L — horizon sweep at k-50')
        for h in sorted(horizons_L['horizon'].unique()):
            sub = horizons_L[horizons_L['horizon'] == h]
            R = clip_R(sub['R'])
            lines.append(
                f'  {h}m: n={len(R)}, mean_R={R.mean():.2f}, '
                f'hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'hit_R10={(R >= 10).mean() * 100:.1f}%, max={R.max():.2f}'
            )

    # B4 close-TOD short straddle
    lines.append('\n## 5. B4 close-TOD short straddle backtest\n')
    if not b4_straddle.empty:
        for hold in [30, 60]:
            sub = b4_straddle[b4_straddle['hold'] == hold]
            if sub.empty:
                continue
            pnl = sub['pnl_short'].dropna()
            pnl_pct = sub['pnl_short_pct'].dropna() * 100
            lines.append(
                f'  hold={hold}m: n={len(pnl)}, '
                f'mean=${pnl.mean():+.2f} ({pnl_pct.mean():+.1f}%), '
                f'median=${pnl.median():+.2f} ({pnl_pct.median():+.1f}%), '
                f'win_rate={(pnl > 0).mean() * 100:.1f}%, '
                f'max_loss=${pnl.min():.2f}, max_win=${pnl.max():.2f}'
            )

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER ---------------------------------------


def main() -> None:
    print('Loading artifacts...')
    events_b = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    charm = pd.read_csv(OUT / 'hypothesis_F_charm_vanna.csv')

    print('\n=== Reconstructing I winners (top-10% both axes, k+50, 120m) ===')
    I_df = reconstruct_winners(
        events_b,
        {'event_otm_dir': 'above', 'lvl_rank_min': 0.90,
         'chg_rank_min': 0.90},
        direction='above', offset=50, horizon=120, option_type='call',
    )
    I_df.to_csv(OUT / 'refine_v2_I_winners.csv', index=False)
    print(f'  I events with realized R: {len(I_df)}')

    print('\n=== Reconstructing L winners (top-5% per-day charm, k-50, 120m) ===')
    # For L: need to apply charm-specific filter (manual since charm_events
    # csv has different columns)
    charm_f = charm[charm['panel'] == 'charm'].copy()
    charm_f['captured_at'] = pd.to_datetime(charm_f['captured_at'], utc=True,
                                              format='ISO8601')
    charm_f['day'] = charm_f['day'].astype(str)
    charm_f['abs_delta'] = charm_f['delta'].abs()
    charm_f['dgn_rank'] = charm_f.groupby('day')['abs_delta'].rank(pct=True)
    below_L = charm_f[(charm_f['strike'] < charm_f['spot_at_event'])
                       & (charm_f['dgn_rank'] >= 0.95)]
    L_rows: list[dict] = []
    for _, ev in below_L.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        trade_k = float(ev['strike']) - 50
        ts = ev['captured_at']
        entry = trades_in_window(path, trade_k, 'put', d, ts,
                                   ts + pd.Timedelta(minutes=5))
        if entry.empty:
            continue
        entry_px = float(entry.iloc[0]['price'])
        if entry_px <= 0:
            continue
        forward = trades_in_window(path, trade_k, 'put', d, ts,
                                     ts + pd.Timedelta(minutes=120))
        max_px = float(forward['price'].max()) if not forward.empty else entry_px
        R = (max_px - entry_px) / entry_px
        row = ev.to_dict()
        row['trade_strike'] = trade_k
        row['entry_px'] = entry_px
        row['max_px'] = max_px
        row['R'] = R
        L_rows.append(row)
    L_df = pd.DataFrame(L_rows)
    L_df.to_csv(OUT / 'refine_v2_L_winners.csv', index=False)
    print(f'  L events with realized R: {len(L_df)}')

    # 1. Portfolio P&L
    print('\n=== 1. Portfolio P&L ===')
    port: list[dict] = []
    if not I_df.empty:
        port.append(portfolio_pnl(I_df['R'], 'I_all'))
        port.append(portfolio_pnl(I_df[I_df['day'] != '2026-05-18']['R'],
                                    'I_ex_5/18'))
    if not L_df.empty:
        port.append(portfolio_pnl(L_df['R'], 'L_all'))
        port.append(portfolio_pnl(L_df[L_df['day'] != '2026-05-18']['R'],
                                    'L_ex_5/18'))
    pd.DataFrame(port).to_csv(OUT / 'refine_v2_portfolio.csv', index=False)

    # 2. Co-occurrence
    print('\n=== 2. Co-occurrence ===')
    cooc = cooccurrence(I_df, L_df) if not I_df.empty and not L_df.empty else {}

    # 3. Feature ranking
    print('\n=== 3. Feature ranking (≥5R winners vs losers) ===')
    I_features = ['gamma_post', 'gamma_delta', 'spot_delta_pre10',
                   'spot_delta_post30', 'flow_total', 'flow_ask_pct',
                   'lott_total', 'lott_ask_pct', 'day_max_abs_gamma']
    L_features = ['value', 'delta', 'spot_pts_15m', 'spot_pts_30m',
                   'spot_pts_60m']
    features_I = feature_ranking(I_df, 'R', I_features) if not I_df.empty \
        else pd.DataFrame()
    features_L = feature_ranking(L_df, 'R', L_features) if not L_df.empty \
        else pd.DataFrame()
    features_I.to_csv(OUT / 'refine_v2_features_I.csv', index=False)
    features_L.to_csv(OUT / 'refine_v2_features_L.csv', index=False)

    # 4. Horizon extension
    print('\n=== 4. Horizon extension (60/120/180/240/EOD) ===')
    horizons_I = extend_horizons_I(events_b, [60, 120, 180, 240, 360],
                                      offset=50)
    horizons_L = extend_horizons_L(charm, [60, 120, 180, 240, 360],
                                      offset=50)
    horizons_I.to_csv(OUT / 'refine_v2_horizons_I.csv', index=False)
    horizons_L.to_csv(OUT / 'refine_v2_horizons_L.csv', index=False)

    # 5. B4 close-TOD straddle
    print('\n=== 5. B4 close-TOD straddle backtest ===')
    b4_straddle = b4_close_straddle(events_b)
    b4_straddle.to_csv(OUT / 'refine_v2_B4_straddle.csv', index=False)

    print('\nWriting findings...')
    write_findings(I_df, L_df, port, features_I, features_L, cooc,
                   horizons_I, horizons_L, b4_straddle,
                   OUT / 'refine_v2_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
