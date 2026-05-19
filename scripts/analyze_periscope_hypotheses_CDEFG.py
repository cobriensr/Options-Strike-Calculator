"""
Test Hypotheses C/D/E/F/G surfaced during the A/B analysis.

  C — Sell-vol straddle backtest at top-decile gamma jumps. Hypothesis B4
      found d=-0.36 vol contraction at 60m post-jump; this directly tests
      whether a short-straddle at the event time vs. a 30m later close
      generates positive P&L vs random control.

  D — Event clustering. Did clustered (≥3 nearby-strike events within 20
      min) days produce different forward outcomes than isolated events?

  E — Gamma level vs change. Is |gamma_at_strike| (level) a better
      discriminator than |Δγ| (change)? Test both axes + interaction.

  F — Charm and vanna events. Existing pipeline only used gamma; test
      whether charm (∂Δ/∂t) and vanna (∂Δ/∂σ) panels carry different /
      stronger signal.

  G — Time-of-day × intraday vol regime. Do events fire differently by
      morning vs afternoon × high vs low realized vol regime?

Inputs:
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv  (events + forward returns)
  docs/tmp/forensic-multi-day/hypothesis_B_control.csv (controls + forward returns)
  ~/Desktop/Bot-Eod-parquet/*.parquet
  Neon: periscope_snapshots, index_candles_1m

Outputs (docs/tmp/forensic-multi-day/):
  hypothesis_C_straddle.csv
  hypothesis_D_clustering.csv
  hypothesis_E_level_vs_change.csv
  hypothesis_F_charm_vanna.csv
  hypothesis_G_tod_volregime.csv
  hypothesis_CDEFG_findings.md
  plots/CDEFG_*.png
"""
from __future__ import annotations

import os
import warnings
from datetime import date, timedelta
from pathlib import Path

import matplotlib.pyplot as plt
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
PLOTS = OUT / 'plots'
PLOTS.mkdir(parents=True, exist_ok=True)
DB_URL = os.environ['DATABASE_URL_UNPOOLED']

HORIZONS_MIN = [15, 30, 60]


# --------------------------- HELPERS --------------------------------------


def db_query(sql: str) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn)


def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    pooled = np.sqrt((np.var(a, ddof=1) + np.var(b, ddof=1)) / 2)
    if pooled == 0:
        return 0.0
    return float((np.mean(a) - np.mean(b)) / pooled)


def compare(a: pd.Series, b: pd.Series) -> dict:
    a = a.dropna().to_numpy()
    b = b.dropna().to_numpy()
    if len(a) < 5 or len(b) < 5:
        return {'n_a': len(a), 'n_b': len(b), 'note': 'insufficient'}
    u, p = stats.mannwhitneyu(a, b, alternative='two-sided')
    return {
        'n_a': len(a), 'n_b': len(b),
        'med_a': float(np.median(a)), 'med_b': float(np.median(b)),
        'mean_a': float(np.mean(a)), 'mean_b': float(np.mean(b)),
        'mw_u': float(u), 'mw_p': float(p),
        'cohens_d': cohens_d(a, b),
    }


# --------------------------- HYPOTHESIS C: STRADDLE ----------------------


def first_trade_after_strike(parquet_path: Path, strike: float,
                             option_type: str,
                             ts_from: pd.Timestamp, ts_to: pd.Timestamp,
                             expiry: date) -> float | None:
    """Find first trade at (strike, type) within [ts_from, ts_to]."""
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
        return None
    df = tbl.to_pandas().sort_values('executed_at')
    return float(df.iloc[0]['price'])


def run_hypothesis_C(events_df: pd.DataFrame, control_df: pd.DataFrame
                     ) -> pd.DataFrame:
    """For each top-decile gamma event, compute ATM straddle P&L if sold
    at event time and bought back at event_time + horizon.

    Uses parquet directly per day to fetch ATM call/put prices around the
    event timestamp.
    """
    # Filter events to top-decile |gamma_delta|, above-spot only (the
    # B4-significant subset)
    abs_d = events_df['gamma_delta'].abs()
    threshold = abs_d.quantile(0.90)
    cand = events_df[abs_d >= threshold].copy()
    cand['captured_at'] = pd.to_datetime(cand['captured_at'], utc=True,
                                          format='ISO8601')
    print(f'  Hypothesis C candidates: {len(cand)} (|Δγ| top-decile)')

    rows: list[dict] = []
    days_done = set()
    for _, ev in cand.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        spot = ev.get('spot_at_event')
        if pd.isna(spot):
            continue
        atm = round(spot / 5) * 5
        ts = ev['captured_at']
        # Entry window: [ts, ts+5min], Exit window: [ts+30min, ts+35min]
        # and [ts+60min, ts+65min]
        for horizon in [30, 60]:
            entry_c = first_trade_after_strike(
                path, atm, 'call', ts, ts + pd.Timedelta(minutes=5), d)
            entry_p = first_trade_after_strike(
                path, atm, 'put', ts, ts + pd.Timedelta(minutes=5), d)
            exit_c = first_trade_after_strike(
                path, atm, 'call',
                ts + pd.Timedelta(minutes=horizon),
                ts + pd.Timedelta(minutes=horizon + 5), d)
            exit_p = first_trade_after_strike(
                path, atm, 'put',
                ts + pd.Timedelta(minutes=horizon),
                ts + pd.Timedelta(minutes=horizon + 5), d)
            if (entry_c is None or entry_p is None
                    or exit_c is None or exit_p is None):
                continue
            entry_strad = entry_c + entry_p
            exit_strad = exit_c + exit_p
            pnl_short = entry_strad - exit_strad  # >0 = short-straddle profit
            rows.append({
                'group': 'event',
                'day': ev['day'], 'captured_at': ts, 'strike_atm': atm,
                'spot_at_event': spot, 'horizon_min': horizon,
                'entry_call': entry_c, 'entry_put': entry_p,
                'entry_straddle': entry_strad,
                'exit_call': exit_c, 'exit_put': exit_p,
                'exit_straddle': exit_strad,
                'pnl_short': pnl_short,
                'pnl_short_pct': pnl_short / entry_strad if entry_strad > 0 else None,
            })
        days_done.add(d)

    # Random control sample — same approach for control rows on the same days
    ctrl = control_df.copy()
    ctrl['captured_at'] = pd.to_datetime(ctrl['captured_at'], utc=True,
                                          format='ISO8601')
    # Sample 200 control timestamps from days_done
    ctrl_sub = ctrl[ctrl['day'].apply(
        lambda x: date.fromisoformat(x) in days_done)]
    n_ctrl = min(200, len(ctrl_sub))
    ctrl_sample = ctrl_sub.sample(n=n_ctrl,
                                   random_state=42).reset_index(drop=True)
    print(f'  Hypothesis C control samples: {len(ctrl_sample)}')
    for _, ev in ctrl_sample.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        spot = ev.get('spot_at_event')
        if pd.isna(spot):
            continue
        atm = round(spot / 5) * 5
        ts = ev['captured_at']
        for horizon in [30, 60]:
            entry_c = first_trade_after_strike(
                path, atm, 'call', ts, ts + pd.Timedelta(minutes=5), d)
            entry_p = first_trade_after_strike(
                path, atm, 'put', ts, ts + pd.Timedelta(minutes=5), d)
            exit_c = first_trade_after_strike(
                path, atm, 'call',
                ts + pd.Timedelta(minutes=horizon),
                ts + pd.Timedelta(minutes=horizon + 5), d)
            exit_p = first_trade_after_strike(
                path, atm, 'put',
                ts + pd.Timedelta(minutes=horizon),
                ts + pd.Timedelta(minutes=horizon + 5), d)
            if (entry_c is None or entry_p is None
                    or exit_c is None or exit_p is None):
                continue
            entry_strad = entry_c + entry_p
            exit_strad = exit_c + exit_p
            pnl_short = entry_strad - exit_strad
            rows.append({
                'group': 'control',
                'day': ev['day'], 'captured_at': ts, 'strike_atm': atm,
                'spot_at_event': spot, 'horizon_min': horizon,
                'entry_call': entry_c, 'entry_put': entry_p,
                'entry_straddle': entry_strad,
                'exit_call': exit_c, 'exit_put': exit_p,
                'exit_straddle': exit_strad,
                'pnl_short': pnl_short,
                'pnl_short_pct': pnl_short / entry_strad if entry_strad > 0 else None,
            })
    return pd.DataFrame(rows)


# --------------------------- HYPOTHESIS D: CLUSTERING --------------------


def run_hypothesis_D(events: pd.DataFrame) -> pd.DataFrame:
    """For each event, count nearby same-day events (strike within ±25,
    time within ±20 min). Classify into isolated / small / large clusters
    and report forward outcomes per class.
    """
    ev = events.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                        format='ISO8601')
    counts: list[int] = []
    for _, e in ev.iterrows():
        same_day = ev[ev['day'] == e['day']]
        near = same_day[
            (same_day['strike'].between(e['strike'] - 25,
                                         e['strike'] + 25))
            & (same_day['captured_at'].between(
                e['captured_at'] - pd.Timedelta(minutes=20),
                e['captured_at'] + pd.Timedelta(minutes=20)))
        ]
        counts.append(len(near))
    ev['cluster_size'] = counts
    ev['cluster_class'] = pd.cut(
        ev['cluster_size'],
        bins=[0, 1, 3, 6, 999],
        labels=['isolated', 'small', 'medium', 'large'],
    )
    return ev


# --------------------------- HYPOTHESIS E: LEVEL vs CHANGE ---------------


def run_hypothesis_E(events: pd.DataFrame) -> pd.DataFrame:
    ev = events.copy()
    # Per-day level decile of |gamma_post|
    ev['abs_gamma_post'] = ev['gamma_post'].abs()
    ev['level_decile'] = ev.groupby('day')['abs_gamma_post'].transform(
        lambda s: pd.qcut(s.rank(method='first'), 10,
                          labels=False, duplicates='drop'))
    ev['abs_gamma_delta'] = ev['gamma_delta'].abs()
    ev['change_decile'] = ev.groupby('day')['abs_gamma_delta'].transform(
        lambda s: pd.qcut(s.rank(method='first'), 10,
                          labels=False, duplicates='drop'))
    return ev


# --------------------------- HYPOTHESIS F: CHARM / VANNA -----------------


def run_hypothesis_F() -> dict:
    """Compute charm and vanna events for all 26 days, same top-1% per-day
    magnitude-jump definition as gamma. Then join with forward spot returns
    and compare to control.
    """
    print('  Loading charm + vanna snapshots...')
    df = db_query("""
        SELECT captured_at, expiry::date AS day, panel, strike, value
        FROM periscope_snapshots
        WHERE panel IN ('charm', 'vanna')
          AND expiry BETWEEN '2026-04-13' AND '2026-05-18'
        ORDER BY day, panel, strike, captured_at
    """)
    df['captured_at'] = pd.to_datetime(df['captured_at'], utc=True)
    df['strike'] = df['strike'].astype(float)
    df['value'] = df['value'].astype(float)

    print('  Computing per-day events per panel...')
    events_list: list[pd.DataFrame] = []
    for (day, panel), g in df.groupby(['day', 'panel']):
        g = g.sort_values(['strike', 'captured_at']).copy()
        g['prior_value'] = g.groupby('strike')['value'].shift(1)
        g['delta'] = g['value'] - g['prior_value']
        g = g.dropna(subset=['delta'])
        if g.empty:
            continue
        threshold = float(g['delta'].abs().quantile(0.99))
        g['event'] = g['delta'].abs() >= threshold
        events_list.append(g[g['event']])

    events_df = pd.concat(events_list, ignore_index=True) if events_list else pd.DataFrame()
    print(f'  Charm events: {(events_df["panel"]=="charm").sum()}')
    print(f'  Vanna events: {(events_df["panel"]=="vanna").sum()}')

    # Load spot for forward returns
    spot = db_query("""
        SELECT timestamp, close
        FROM index_candles_1m
        WHERE symbol='SPX'
          AND timestamp >= '2026-04-13' AND timestamp < '2026-05-19'
        ORDER BY timestamp
    """)
    spot['timestamp'] = pd.to_datetime(spot['timestamp'], utc=True)
    spot['close'] = spot['close'].astype(float)
    spot = spot.set_index('timestamp')

    print('  Augmenting with forward spot returns...')
    rows: list[dict] = []
    for _, ev in events_df.iterrows():
        ts = ev['captured_at']
        idx_at = spot.index.get_indexer([ts], method='pad')[0]
        if idx_at == -1:
            continue
        spot_t = float(spot['close'].iloc[idx_at])
        row = {'day': ev['day'].isoformat() if hasattr(ev['day'], 'isoformat')
               else str(ev['day']),
               'captured_at': ts, 'panel': ev['panel'], 'strike': ev['strike'],
               'value': ev['value'], 'delta': ev['delta'],
               'spot_at_event': spot_t}
        for h in HORIZONS_MIN:
            target = ts + pd.Timedelta(minutes=h)
            idx_h = spot.index.get_indexer([target], method='pad')[0]
            if idx_h <= idx_at:
                row[f'spot_pts_{h}m'] = None
                row[f'spot_abs_{h}m'] = None
            else:
                spot_h = float(spot['close'].iloc[idx_h])
                row[f'spot_pts_{h}m'] = spot_h - spot_t
                row[f'spot_abs_{h}m'] = abs(spot_h - spot_t)
        rows.append(row)
    f_events = pd.DataFrame(rows)
    return {'events': f_events, 'spot': spot}


# --------------------------- HYPOTHESIS G: TOD x VOL REGIME --------------


def realized_vol_so_far(spot: pd.DataFrame, day: str, ts: pd.Timestamp) -> float:
    """Compute realized vol (sum of squared 1m returns) from market open
    (13:30 UTC) to ts on the given day."""
    open_ts = pd.Timestamp(f'{day} 13:30:00+00:00')
    sub = spot.loc[open_ts:ts]
    if len(sub) < 2:
        return float('nan')
    rets = sub['close'].pct_change().dropna()
    if rets.empty:
        return float('nan')
    return float(np.sqrt((rets ** 2).sum()) * 100)  # in pct points


def run_hypothesis_G(events: pd.DataFrame, spot: pd.DataFrame
                     ) -> pd.DataFrame:
    ev = events.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                        format='ISO8601')
    ev['hour_utc'] = ev['captured_at'].dt.hour
    # Time-of-day buckets (CT)
    def tod_bucket(h: int) -> str:
        if h < 15: return 'open'       # 9:30-10:00 ET, 8:30-10:00 CT
        if h < 17: return 'morning'    # 10:00-12:00 ET
        if h < 19: return 'midday'     # 12:00-2:00 ET
        return 'close'                  # 2:00-3:00 ET (RTH ends ~20:00 UTC)
    ev['tod_bucket'] = ev['hour_utc'].apply(tod_bucket)
    # Realized vol so far today
    rvs = []
    for _, e in ev.iterrows():
        rvs.append(realized_vol_so_far(spot, e['day'], e['captured_at']))
    ev['rv_so_far_pct'] = rvs
    # Stratify rv into terciles per day
    ev['rv_tercile'] = pd.qcut(ev['rv_so_far_pct'],
                                 q=3, labels=['low_vol', 'mid_vol', 'high_vol'],
                                 duplicates='drop')
    return ev


# --------------------------- REPORT ---------------------------------------


def write_findings(c_df: pd.DataFrame, d_df: pd.DataFrame, e_df: pd.DataFrame,
                   f_dict: dict, g_df: pd.DataFrame, out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Hypotheses C / D / E / F / G — additional research threads\n')

    # ---- Hypothesis C: Sell-vol straddle backtest ---------------------
    lines.append('## C — Short ATM straddle at top-decile |Δγ| events\n')
    if not c_df.empty:
        for h in [30, 60]:
            ev = c_df[(c_df['group'] == 'event')
                      & (c_df['horizon_min'] == h)]
            ct = c_df[(c_df['group'] == 'control')
                      & (c_df['horizon_min'] == h)]
            lines.append(f'### Horizon: {h} min')
            for label, df in [('event', ev), ('control', ct)]:
                if df.empty:
                    continue
                pnl = df['pnl_short'].dropna()
                pnl_pct = df['pnl_short_pct'].dropna() * 100
                lines.append(
                    f'  {label}: n={len(pnl)}, '
                    f'mean P&L=${pnl.mean():+.2f} ({pnl_pct.mean():+.1f}%), '
                    f'median=${pnl.median():+.2f} ({pnl_pct.median():+.1f}%), '
                    f'win_rate={(pnl > 0).mean() * 100:.1f}%, '
                    f'max_loss=${pnl.min():.2f}, max_win=${pnl.max():.2f}'
                )
            cmp = compare(ev['pnl_short'], ct['pnl_short'])
            lines.append(f"  Mann-Whitney: U={cmp.get('mw_u', 'na')}, "
                          f"p={cmp.get('mw_p', 'na'):.4f}, "
                          f"d={cmp.get('cohens_d', 'na'):+.2f}")

    # ---- Hypothesis D: Clustering -------------------------------------
    lines.append('\n## D — Event clustering (≤±25 strike, ≤±20 min)\n')
    if not d_df.empty:
        cluster_counts = d_df['cluster_class'].value_counts()
        lines.append(f'Cluster class counts: {dict(cluster_counts)}\n')
        # Forward 30m return by cluster class
        for cls in ['isolated', 'small', 'medium', 'large']:
            sub = d_df[d_df['cluster_class'] == cls]
            if sub.empty:
                continue
            for h in [30]:
                col = f'spot_t_pts_{h}m'
                if col in sub.columns:
                    s = sub[col].dropna()
                    abs_s = s.abs()
                    if len(s):
                        lines.append(
                            f'  {cls} cluster (n={len(s)}): {h}m '
                            f'med_signed={s.median():+.2f} | '
                            f'med_|move|={abs_s.median():.2f}'
                        )
        # Also check call-lottery R outcomes by cluster
        lines.append('\n  Call-lottery R at k+50/30m by cluster (above-spot CT events only):')
        sub_ct = d_df[(d_df['event_otm_dir'] == 'above')
                      & d_df['is_counter_trend']]
        for cls in ['isolated', 'small', 'medium', 'large']:
            s = sub_ct[sub_ct['cluster_class'] == cls]['k50_R_30m']
            s = s.dropna().clip(lower=-1)
            if len(s) >= 3:
                lines.append(
                    f'    {cls}: n={len(s)}, mean_R={s.mean():.2f}, '
                    f'median_R={s.median():.2f}, '
                    f'hit_R5={(s >= 5).mean() * 100:.1f}%, '
                    f'max_R={s.max():.1f}'
                )

    # ---- Hypothesis E: Level vs Change --------------------------------
    lines.append('\n## E — Level (|γ at strike|) vs Change (|Δγ|)\n')
    if not e_df.empty:
        # Tabulate by level_decile and change_decile
        for dim, col in [('level_decile', 'abs_gamma_post'),
                          ('change_decile', 'abs_gamma_delta')]:
            lines.append(f'### Stratify by {dim}\n')
            grouped = e_df.groupby(dim).agg(
                n=(col, 'count'),
                med_R_call=('k50_R_30m', lambda s: s.clip(lower=-1).median()),
                hit_R5=('k50_R_30m',
                         lambda s: ((s.clip(lower=-1) >= 5).sum()
                                    / max(s.count(), 1))),
                med_spot=('spot_t_pts_30m', 'median'),
                med_abs_spot=('spot_t_pts_30m', lambda s: s.abs().median()),
            )
            grouped['hit_R5'] = grouped['hit_R5'] * 100
            lines.append(grouped.to_string())

        # Interaction: top-decile of BOTH level and change
        lines.append('\n### Interaction (top decile both axes)')
        both = e_df[(e_df['level_decile'] == 9)
                    & (e_df['change_decile'] == 9)]
        only_lvl = e_df[(e_df['level_decile'] == 9)
                        & (e_df['change_decile'] != 9)]
        only_chg = e_df[(e_df['level_decile'] != 9)
                        & (e_df['change_decile'] == 9)]
        for name, sub in [('top_both', both),
                          ('top_level_only', only_lvl),
                          ('top_change_only', only_chg)]:
            if sub.empty:
                continue
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            abs_spot = sub['spot_t_pts_30m'].abs().dropna()
            lines.append(
                f'  {name}: n={len(sub)}, '
                f'mean_R_call={R.mean():.2f}, hit_R5={(R >= 5).mean() * 100:.1f}%, '
                f'med_|spot_30m|={abs_spot.median():.2f}'
            )

    # ---- Hypothesis F: Charm and Vanna --------------------------------
    lines.append('\n## F — Charm and Vanna events (independent signal channels)\n')
    f_events = f_dict.get('events', pd.DataFrame())
    if not f_events.empty:
        for panel in ['charm', 'vanna']:
            sub = f_events[f_events['panel'] == panel]
            if sub.empty:
                continue
            lines.append(f'### {panel.title()} events (top-1% per day): n={len(sub)}')
            for h in HORIZONS_MIN:
                signed_col = f'spot_pts_{h}m'
                abs_col = f'spot_abs_{h}m'
                if signed_col not in sub.columns:
                    continue
                s = sub[signed_col].dropna()
                abs_s = sub[abs_col].dropna()
                if len(s):
                    lines.append(
                        f'  {h}m: n={len(s)}, '
                        f'med_signed={s.median():+.2f} pts, '
                        f'med_|move|={abs_s.median():.2f} pts'
                    )

    # ---- Hypothesis G: TOD × Vol Regime -------------------------------
    lines.append('\n## G — Time-of-day × intraday realized vol\n')
    if not g_df.empty:
        for tod in ['open', 'morning', 'midday', 'close']:
            for rv in ['low_vol', 'mid_vol', 'high_vol']:
                sub = g_df[(g_df['tod_bucket'] == tod)
                           & (g_df['rv_tercile'] == rv)]
                if len(sub) < 5:
                    continue
                R = sub[(sub['event_otm_dir'] == 'above')
                        & sub['is_counter_trend']]['k50_R_30m']
                R = R.dropna().clip(lower=-1)
                spot = sub['spot_t_pts_30m'].dropna()
                mean_R_str = f'{R.mean():.2f}' if len(R) else 'na'
                med_spot_str = f'{spot.median():+.2f}' if len(spot) else 'na'
                lines.append(
                    f'  {tod} × {rv}: n={len(sub)} events, '
                    f'CT_above_subset={len(R)}, '
                    f'mean_R={mean_R_str}, '
                    f'med_spot_30m={med_spot_str}'
                )

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER ---------------------------------------


def main() -> None:
    print('Loading existing artifacts...')
    events = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    control = pd.read_csv(OUT / 'hypothesis_B_control.csv')
    print(f'  events: {len(events):,}, control: {len(control):,}')

    print('\n=== Hypothesis C: short-straddle backtest ===')
    c_df = run_hypothesis_C(events, control)
    c_df.to_csv(OUT / 'hypothesis_C_straddle.csv', index=False)
    print(f'  Hypothesis C rows: {len(c_df)}')

    print('\n=== Hypothesis D: event clustering ===')
    d_df = run_hypothesis_D(events)
    d_df.to_csv(OUT / 'hypothesis_D_clustering.csv', index=False)

    print('\n=== Hypothesis E: level vs change ===')
    e_df = run_hypothesis_E(events)
    e_df.to_csv(OUT / 'hypothesis_E_level_vs_change.csv', index=False)

    print('\n=== Hypothesis F: charm and vanna ===')
    f_dict = run_hypothesis_F()
    f_dict['events'].to_csv(OUT / 'hypothesis_F_charm_vanna.csv', index=False)

    print('\n=== Hypothesis G: time-of-day x vol regime ===')
    g_df = run_hypothesis_G(events, f_dict['spot'])
    g_df.to_csv(OUT / 'hypothesis_G_tod_volregime.csv', index=False)

    print('\nWriting findings...')
    write_findings(c_df, d_df, e_df, f_dict, g_df,
                   OUT / 'hypothesis_CDEFG_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
