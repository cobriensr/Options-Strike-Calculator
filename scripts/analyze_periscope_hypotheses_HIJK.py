"""Test Hypotheses H / I / J / K — the remaining surfaced threads.

  H — Charm event directional rigor.  Hypothesis F showed charm 15m median
      -0.58 vs gamma's +0.11.  Test with Mann-Whitney U + Cohen's d + FDR
      across multiple charm subsets and horizons.

  I — Deep-γ catalyst (no counter-trend required).  Hypothesis E found
      the 4/23 75x event was top-decile-both-axes but NOT counter-trend.
      Characterize the deep-γ catalyst as its own setup class.

  J — Short straddle with hard stop.  Hypothesis C showed shorter max
      losses for event-conditioned straddles.  Add a hard stop at 2.5x
      entry and measure realized P&L vs no-stop and vs control.

  K — Pair sub-structure (simultaneous vs sequential).  Hypothesis D
      found pair-clusters carry the signal.  Sub-classify pairs as
      SIMULTANEOUS (same slice) vs SEQUENTIAL (different slices) and
      compare outcomes.

Inputs:
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv     (events + forward returns)
  docs/tmp/forensic-multi-day/hypothesis_B_control.csv    (controls + forward returns)
  docs/tmp/forensic-multi-day/hypothesis_F_charm_vanna.csv
  docs/tmp/forensic-multi-day/hypothesis_E_level_vs_change.csv
  ~/Desktop/Bot-Eod-parquet/*.parquet (for J intra-window prices)

Outputs:
  hypothesis_H_charm_rigor.csv
  hypothesis_I_deep_gamma.csv
  hypothesis_J_straddle_stop.csv
  hypothesis_K_pair_substructure.csv
  hypothesis_HIJK_findings.md
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
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
HORIZONS_MIN = [5, 10, 15, 30, 60]


# --------------------------- HELPERS --------------------------------------


def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    pooled = np.sqrt((np.var(a, ddof=1) + np.var(b, ddof=1)) / 2)
    return 0.0 if pooled == 0 else float((a.mean() - b.mean()) / pooled)


def mw(a: pd.Series, b: pd.Series) -> dict:
    a = a.dropna().to_numpy(); b = b.dropna().to_numpy()
    if len(a) < 5 or len(b) < 5:
        return {'n_a': len(a), 'n_b': len(b), 'mw_p': np.nan, 'cohens_d': np.nan,
                'med_a': float(np.median(a)) if len(a) else np.nan,
                'med_b': float(np.median(b)) if len(b) else np.nan}
    u, p = stats.mannwhitneyu(a, b, alternative='two-sided')
    return {'n_a': len(a), 'n_b': len(b), 'mw_u': float(u), 'mw_p': float(p),
            'med_a': float(np.median(a)), 'med_b': float(np.median(b)),
            'mean_a': float(np.mean(a)), 'mean_b': float(np.mean(b)),
            'cohens_d': cohens_d(a, b)}


def bh_fdr(ps: list[float], q: float = 0.05) -> list[bool]:
    n = len(ps)
    if n == 0: return []
    order = np.argsort(ps)
    sorted_p = np.array(ps)[order]
    crit = (np.arange(1, n + 1) / n) * q
    below = sorted_p <= crit
    if not below.any(): return [False] * n
    threshold = sorted_p[np.where(below)[0].max()]
    return [p <= threshold for p in ps]


# --------------------------- HYPOTHESIS H: CHARM RIGOR -------------------


def run_H(charm_vanna_df: pd.DataFrame, control: pd.DataFrame) -> pd.DataFrame:
    """Mann-Whitney tests on signed + |forward spot move| for charm and
    vanna events at multiple horizons + sub-classes.
    """
    rows: list[dict] = []
    for panel in ['charm', 'vanna']:
        sub = charm_vanna_df[charm_vanna_df['panel'] == panel]
        if sub.empty:
            continue
        # Determine event sign (positive value = MMs net long; negative = short)
        deep_neg = sub[(sub['value'] < 0) & (sub['delta'] < 0)]  # deepened negative
        deep_pos = sub[(sub['value'] > 0) & (sub['delta'] > 0)]  # deepened positive
        flip_neg = sub[(sub['value'] < 0) & (sub['delta'].abs() > sub['value'].abs())]  # rough sign flip to neg
        flip_pos = sub[(sub['value'] > 0) & (sub['delta'].abs() > sub['value'].abs())]
        for label, df in [(f'{panel}_all', sub),
                          (f'{panel}_deep_neg', deep_neg),
                          (f'{panel}_deep_pos', deep_pos),
                          (f'{panel}_flip_to_neg', flip_neg),
                          (f'{panel}_flip_to_pos', flip_pos)]:
            for h in HORIZONS_MIN:
                signed_col = f'spot_pts_{h}m'
                if signed_col not in df.columns:
                    continue
                # Signed test
                res = mw(df[signed_col], control[f'spot_t_pts_{h}m'])
                res.update({'label': label, 'horizon_min': h, 'metric': 'signed'})
                rows.append(res)
                # Absolute (vol)
                ev_abs = df[signed_col].abs()
                ct_abs = control[f'spot_t_pts_{h}m'].abs()
                res_abs = mw(ev_abs, ct_abs)
                res_abs.update({'label': label, 'horizon_min': h, 'metric': '|abs|'})
                rows.append(res_abs)
    out = pd.DataFrame(rows)
    # FDR-correct within (panel, metric, horizon-set) — broadly across all tests
    if not out.empty:
        out['sig_fdr'] = bh_fdr(out['mw_p'].fillna(1.0).tolist(), q=0.05)
    return out


# --------------------------- HYPOTHESIS I: DEEP-γ CATALYST ---------------


def run_I(e_df: pd.DataFrame) -> pd.DataFrame:
    """Characterize deep-γ catalyst events (top-both-axes, regardless of
    counter-trend). Compare:
      - top_both + CT (Wonce-class)
      - top_both + NOT CT (the 4/23 catalyst class)
      - top_both unfiltered
    """
    ev = e_df.copy()
    top_both = ev[(ev['level_decile'] == 9) & (ev['change_decile'] == 9)]
    tb_ct = top_both[top_both['is_counter_trend']]
    tb_no_ct = top_both[~top_both['is_counter_trend'].astype(bool)]
    # Above/below split within tb_no_ct
    tb_no_ct_above = tb_no_ct[tb_no_ct['event_otm_dir'] == 'above']
    tb_no_ct_below = tb_no_ct[tb_no_ct['event_otm_dir'] == 'below']

    rows: list[dict] = []
    for label, df in [('top_both', top_both),
                      ('top_both_CT', tb_ct),
                      ('top_both_NOT_CT', tb_no_ct),
                      ('top_both_NOT_CT_above', tb_no_ct_above),
                      ('top_both_NOT_CT_below', tb_no_ct_below)]:
        n = len(df)
        if n == 0:
            continue
        for off in [25, 50, 75, 100]:
            col = f'k{off}_R_30m'
            if col not in df.columns:
                continue
            R = df[col].dropna().clip(lower=-1)
            if R.empty:
                continue
            row = {'group': label, 'n': n, 'otm_offset': off, 'n_R': len(R),
                   'mean_R': float(R.mean()),
                   'median_R': float(R.median()),
                   'hit_R2': float((R >= 2).mean()),
                   'hit_R5': float((R >= 5).mean()),
                   'hit_R10': float((R >= 10).mean()),
                   'hit_R20': float((R >= 20).mean()),
                   'max_R': float(R.max())}
            # ex-5/18 versions
            no = df[df['day'] != '2026-05-18']
            R_no = no[col].dropna().clip(lower=-1) if col in no.columns else pd.Series([])
            row['n_R_ex518'] = len(R_no)
            row['mean_R_ex518'] = float(R_no.mean()) if len(R_no) else np.nan
            row['hit_R5_ex518'] = float((R_no >= 5).mean()) if len(R_no) else np.nan
            row['max_R_ex518'] = float(R_no.max()) if len(R_no) else np.nan
            rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- HYPOTHESIS J: STRADDLE w/ STOP ---------------


def get_straddle_path(parquet_path: Path, strike: float, expiry: date,
                       ts_from: pd.Timestamp, ts_to: pd.Timestamp,
                       sample_freq_sec: int = 60) -> pd.DataFrame:
    """Pull call+put trades for strike in window, sample at sample_freq."""
    tbl = pq.read_table(
        parquet_path,
        filters=[
            ('underlying_symbol', '=', 'SPXW'),
            ('expiry', '=', expiry),
            ('strike', '=', float(strike)),
            ('executed_at', '>=', ts_from.to_pydatetime()),
            ('executed_at', '<=', ts_to.to_pydatetime()),
        ],
        columns=['executed_at', 'option_type', 'price'],
    )
    if tbl.num_rows == 0:
        return pd.DataFrame()
    df = tbl.to_pandas().sort_values('executed_at').reset_index(drop=True)
    df['executed_at'] = pd.to_datetime(df['executed_at'], utc=True)
    return df


def simulate_straddle(parquet_path: Path, strike: float, expiry: date,
                       entry_ts: pd.Timestamp, hold_minutes: int,
                       stop_mult: float = 2.5) -> dict | None:
    """Short ATM straddle at entry_ts. Compute entry premium, intra-window
    max straddle (upper bound), exit premium at entry_ts + hold_minutes.
    Apply stop_mult: if max_straddle >= stop_mult * entry, position stopped
    out at -(stop_mult - 1) * entry P&L; else realized exit P&L.
    """
    # Entry window (small forward window for first trade)
    entry_window_to = entry_ts + pd.Timedelta(minutes=5)
    entry_df = get_straddle_path(parquet_path, strike, expiry,
                                  entry_ts, entry_window_to)
    if entry_df.empty:
        return None
    first_call = entry_df[entry_df['option_type'] == 'call']
    first_put = entry_df[entry_df['option_type'] == 'put']
    if first_call.empty or first_put.empty:
        return None
    entry_call = float(first_call.iloc[0]['price'])
    entry_put = float(first_put.iloc[0]['price'])
    entry_strad = entry_call + entry_put
    if entry_strad <= 0:
        return None

    # Hold window (entry to entry + hold_minutes)
    hold_to = entry_ts + pd.Timedelta(minutes=hold_minutes)
    hold_df = get_straddle_path(parquet_path, strike, expiry, entry_ts, hold_to)
    if hold_df.empty:
        return None
    # Forward-fill prices to 1-min grid; dedupe by taking last trade per
    # timestamp (parquet can have multiple prints at the same μs).
    grid = pd.date_range(entry_ts, hold_to, freq='1min', tz='UTC')
    call_path = (hold_df[hold_df['option_type'] == 'call']
                 .groupby('executed_at')['price'].last())
    put_path = (hold_df[hold_df['option_type'] == 'put']
                .groupby('executed_at')['price'].last())
    if call_path.empty or put_path.empty:
        return None
    call_ser = call_path.reindex(call_path.index.union(grid)).sort_index()\
        .ffill().reindex(grid)
    put_ser = put_path.reindex(put_path.index.union(grid)).sort_index()\
        .ffill().reindex(grid)
    strad_ser = (call_ser + put_ser).dropna()
    if strad_ser.empty:
        return None
    max_strad = float(strad_ser.max())
    exit_strad = float(strad_ser.iloc[-1])

    # Stop check: stopped if max ever exceeded stop_mult * entry
    stop_level = stop_mult * entry_strad
    stopped = max_strad >= stop_level
    if stopped:
        realized_pnl = entry_strad - stop_level
    else:
        realized_pnl = entry_strad - exit_strad

    return {'entry_call': entry_call, 'entry_put': entry_put,
            'entry_strad': entry_strad, 'max_strad': max_strad,
            'exit_strad': exit_strad,
            'pnl_short_no_stop': entry_strad - exit_strad,
            'pnl_short_with_stop': realized_pnl,
            'stopped': stopped,
            'stop_mult': stop_mult,
            'stop_level': stop_level}


def run_J(events_df: pd.DataFrame, control_df: pd.DataFrame) -> pd.DataFrame:
    abs_d = events_df['gamma_delta'].abs()
    threshold = abs_d.quantile(0.90)
    cand = events_df[abs_d >= threshold].copy()
    cand['captured_at'] = pd.to_datetime(cand['captured_at'], utc=True, format='ISO8601')
    print(f'  J event candidates: {len(cand)}')

    rows: list[dict] = []
    for _, ev in cand.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists() or pd.isna(ev.get('spot_at_event')):
            continue
        atm = round(float(ev['spot_at_event']) / 5) * 5
        for hold in [30, 60]:
            for stop_mult in [2.0, 2.5, 3.0]:
                result = simulate_straddle(
                    path, atm, d, ev['captured_at'], hold, stop_mult)
                if result is None:
                    continue
                result.update({'group': 'event', 'day': ev['day'],
                               'captured_at': ev['captured_at'], 'atm': atm,
                               'hold': hold})
                rows.append(result)

    # Control matched
    ctrl = control_df.copy()
    ctrl['captured_at'] = pd.to_datetime(ctrl['captured_at'], utc=True, format='ISO8601')
    days_done = {date.fromisoformat(r['day']) for r in rows}
    ctrl_sub = ctrl[ctrl['day'].apply(lambda x: date.fromisoformat(x) in days_done)]
    n_ctrl = min(150, len(ctrl_sub))
    ctrl_sample = ctrl_sub.sample(n=n_ctrl, random_state=42).reset_index(drop=True)
    print(f'  J control samples: {n_ctrl}')
    for _, ev in ctrl_sample.iterrows():
        d = date.fromisoformat(ev['day'])
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists() or pd.isna(ev.get('spot_at_event')):
            continue
        atm = round(float(ev['spot_at_event']) / 5) * 5
        for hold in [30, 60]:
            for stop_mult in [2.0, 2.5, 3.0]:
                result = simulate_straddle(
                    path, atm, d, ev['captured_at'], hold, stop_mult)
                if result is None:
                    continue
                result.update({'group': 'control', 'day': ev['day'],
                               'captured_at': ev['captured_at'], 'atm': atm,
                               'hold': hold})
                rows.append(result)
    return pd.DataFrame(rows)


# --------------------------- HYPOTHESIS K: PAIR SUB-STRUCTURE -------------


def run_K(events_df: pd.DataFrame) -> pd.DataFrame:
    """Classify each above-spot CT event by pair sub-type. A 'pair' = 2
    events within ±10 strikes and ±10 min. Sub-types:
      - simultaneous: both events have same captured_at (same Periscope slice)
      - sequential:   different slices, one slice apart
      - non-pair:     not in pair-cluster
    """
    ev = events_df.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True, format='ISO8601')
    pair_type: list[str] = []
    for _, e in ev.iterrows():
        same_day = ev[ev['day'] == e['day']]
        nearby = same_day[
            (same_day['strike'].between(e['strike'] - 10, e['strike'] + 10))
            & (same_day['captured_at'].between(
                e['captured_at'] - pd.Timedelta(minutes=10),
                e['captured_at'] + pd.Timedelta(minutes=10)))
            & (same_day.index != _)
        ]
        if len(nearby) == 0:
            pair_type.append('non_pair')
            continue
        if len(nearby) == 1:
            other = nearby.iloc[0]
            if other['captured_at'] == e['captured_at']:
                pair_type.append('simultaneous')
            else:
                pair_type.append('sequential')
        else:
            pair_type.append('multi')
    ev['pair_type'] = pair_type
    return ev


# --------------------------- REPORT --------------------------------------


def write_findings(h_df: pd.DataFrame, i_df: pd.DataFrame, j_df: pd.DataFrame,
                   k_df: pd.DataFrame, out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Hypotheses H / I / J / K — additional research threads\n')

    # ---- H ----
    lines.append('## H — Charm and Vanna directional rigor\n')
    if not h_df.empty:
        for panel in ['charm', 'vanna']:
            lines.append(f'### {panel} signed return at multiple horizons')
            sub = h_df[(h_df['label'] == f'{panel}_all')
                       & (h_df['metric'] == 'signed')]
            for _, r in sub.iterrows():
                lines.append(
                    f'  {int(r["horizon_min"])}m: med_ev={r["med_a"]:+.2f}, '
                    f'med_ctl={r["med_b"]:+.2f}, p={r["mw_p"]:.4f}, '
                    f'd={r["cohens_d"]:+.2f}, sig={"Y" if r["sig_fdr"] else "n"}'
                )
            lines.append(f'### {panel} |abs| (vol)')
            sub = h_df[(h_df['label'] == f'{panel}_all')
                       & (h_df['metric'] == '|abs|')]
            for _, r in sub.iterrows():
                lines.append(
                    f'  {int(r["horizon_min"])}m: med_|ev|={r["med_a"]:.2f}, '
                    f'med_|ctl|={r["med_b"]:.2f}, p={r["mw_p"]:.4f}, '
                    f'd={r["cohens_d"]:+.2f}, sig={"Y" if r["sig_fdr"] else "n"}'
                )

        # Sub-classes (deep_neg vs deep_pos)
        lines.append('\n### Sub-class summary (30m signed, FDR-significant only)')
        sig = h_df[(h_df['horizon_min'] == 30) & (h_df['metric'] == 'signed')
                   & h_df['sig_fdr']]
        if sig.empty:
            lines.append('  No FDR-significant directional results at 30m.')
        else:
            for _, r in sig.iterrows():
                lines.append(f'  {r["label"]}: med={r["med_a"]:+.2f}, '
                              f'd={r["cohens_d"]:+.2f}, p={r["mw_p"]:.4f}')

    # ---- I ----
    lines.append('\n## I — Deep-γ catalyst (top-both-axes, with/without CT)\n')
    if not i_df.empty:
        # 30m k+50 view as the main metric
        for off in [25, 50, 75, 100]:
            lines.append(f'### k+{off}pt OTM, 30m horizon')
            view = i_df[i_df['otm_offset'] == off]
            cols = ['group', 'n', 'n_R', 'mean_R', 'hit_R5', 'max_R',
                    'n_R_ex518', 'mean_R_ex518', 'hit_R5_ex518', 'max_R_ex518']
            v = view[cols].copy()
            for c in ['mean_R', 'max_R', 'mean_R_ex518', 'max_R_ex518']:
                v[c] = v[c].apply(lambda x: f'{x:.2f}' if pd.notna(x) else 'na')
            for c in ['hit_R5', 'hit_R5_ex518']:
                v[c] = v[c].apply(
                    lambda x: f'{x*100:.1f}%' if pd.notna(x) else 'na')
            lines.append(v.to_string(index=False))

    # ---- J ----
    lines.append('\n## J — Short straddle with hard stop (vol-contraction monetization)\n')
    if not j_df.empty:
        for hold in [30, 60]:
            for stop_mult in [2.0, 2.5, 3.0]:
                lines.append(f'### Hold {hold}m, stop at {stop_mult}x entry')
                for grp in ['event', 'control']:
                    sub = j_df[(j_df['group'] == grp) & (j_df['hold'] == hold)
                               & (j_df['stop_mult'] == stop_mult)]
                    if sub.empty:
                        continue
                    pnl = sub['pnl_short_with_stop'].dropna()
                    pnl_pct = (sub['pnl_short_with_stop']
                               / sub['entry_strad']).dropna() * 100
                    no_stop = sub['pnl_short_no_stop'].dropna()
                    stopped_rate = sub['stopped'].mean()
                    lines.append(
                        f'  {grp}: n={len(sub)}, stop_rate={stopped_rate*100:.1f}%, '
                        f'mean_pnl_w_stop=${pnl.mean():+.2f} ({pnl_pct.mean():+.1f}%), '
                        f'median=${pnl.median():+.2f} ({pnl_pct.median():+.1f}%), '
                        f'win_rate={(pnl > 0).mean() * 100:.1f}%, '
                        f'max_loss=${pnl.min():.2f}, '
                        f'mean_pnl_no_stop=${no_stop.mean():+.2f}'
                    )
                # MW comparison
                ev = j_df[(j_df['group'] == 'event') & (j_df['hold'] == hold)
                          & (j_df['stop_mult'] == stop_mult)]['pnl_short_with_stop']
                ct = j_df[(j_df['group'] == 'control') & (j_df['hold'] == hold)
                          & (j_df['stop_mult'] == stop_mult)]['pnl_short_with_stop']
                cmp = mw(ev, ct)
                lines.append(
                    f'  Mann-Whitney: p={cmp.get("mw_p", np.nan):.4f}, '
                    f'd={cmp.get("cohens_d", np.nan):+.2f}'
                )

    # ---- K ----
    lines.append('\n## K — Pair sub-structure (simultaneous vs sequential)\n')
    if not k_df.empty:
        # Restrict to above-spot CT events (Wonce-class universe)
        ct_above = k_df[(k_df['event_otm_dir'] == 'above')
                        & k_df['is_counter_trend']]
        for sub_type in ['simultaneous', 'sequential', 'multi', 'non_pair']:
            sub = ct_above[ct_above['pair_type'] == sub_type]
            if sub.empty:
                continue
            R = sub['k50_R_30m'].dropna().clip(lower=-1)
            sub_ex = sub[sub['day'] != '2026-05-18']
            R_ex = sub_ex['k50_R_30m'].dropna().clip(lower=-1)
            lines.append(
                f'  {sub_type}: n={len(sub)}, n_R={len(R)}, mean_R={R.mean():.2f}, '
                f'hit_R5={(R >= 5).mean() * 100:.1f}%, max_R={R.max():.1f} | '
                f'ex-5/18: n={len(R_ex)}, mean_R={R_ex.mean():.2f}, '
                f'hit_R5={(R_ex >= 5).mean() * 100:.1f}%, max_R={R_ex.max():.1f}'
            )

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER --------------------------------------


def main() -> None:
    print('Loading B + F + E artifacts...')
    events_b = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    control_b = pd.read_csv(OUT / 'hypothesis_B_control.csv')
    charm_vanna = pd.read_csv(OUT / 'hypothesis_F_charm_vanna.csv')
    e_df = pd.read_csv(OUT / 'hypothesis_E_level_vs_change.csv')

    print('\n=== H: Charm/Vanna rigor ===')
    h_df = run_H(charm_vanna, control_b)
    h_df.to_csv(OUT / 'hypothesis_H_charm_rigor.csv', index=False)
    print(f'  H tests: {len(h_df)}')

    print('\n=== I: Deep-γ catalyst ===')
    i_df = run_I(e_df)
    i_df.to_csv(OUT / 'hypothesis_I_deep_gamma.csv', index=False)
    print(f'  I rows: {len(i_df)}')

    print('\n=== J: Straddle with stops (parquet scans, will take a few min) ===')
    j_df = run_J(events_b, control_b)
    j_df.to_csv(OUT / 'hypothesis_J_straddle_stop.csv', index=False)
    print(f'  J rows: {len(j_df)}')

    print('\n=== K: Pair sub-structure ===')
    k_df = run_K(events_b)
    k_df.to_csv(OUT / 'hypothesis_K_pair_substructure.csv', index=False)

    print('\nWriting findings...')
    write_findings(h_df, i_df, j_df, k_df, OUT / 'hypothesis_HIJK_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
