"""Parameter-sweep refinement of the 5 strongest findings.

Targets:
  B1 — Magnet asymmetry: stratify by |γ_post| decile + time-decay profile
  B4 — Vol contraction: sweep |Δγ| threshold (top 0.5/1/2/5% per-day) + TOD
  H  — Charm direction: rank sub-classes (deep_neg / flip_to_neg / ...) by
       effect size and FDR significance to find sharpest single class
  I  — Call lottery: parameter grid over threshold × offset × horizon ×
       concurrent-flow gate × TOD bucket. Pre-compute forward R for the
       broadest candidate set (top-5%-of-day events), then slice.
  L  — Put lottery: same grid but for charm-below events on the put side.

Discipline: when sweeping, ALWAYS report (a) full sample, (b) ex-5/18, (c)
sample size; flag any cell where n<10 as unreliable. Multiple-comparison
correction is impractical for the entire grid; instead report TOP-K cells
ranked by combined (hit_R5 ex-5/18, n_ex_5/18) and call out the consistent
patterns across robustness checks.

Inputs:
  docs/tmp/forensic-multi-day/hypothesis_B_events.csv  (gamma events)
  docs/tmp/forensic-multi-day/hypothesis_B_control.csv (controls)
  docs/tmp/forensic-multi-day/hypothesis_F_charm_vanna.csv (charm events)
  Neon: periscope_snapshots, index_candles_1m
  ~/Desktop/Bot-Eod-parquet/*.parquet (forward R lookups)

Outputs:
  refine_B1.csv, refine_B4.csv, refine_H.csv
  refine_I_call_lottery_grid.csv
  refine_L_put_lottery_grid.csv
  refine_top5_findings.md
"""
from __future__ import annotations

import os
import warnings
from datetime import date
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

# Sweep grids
THRESHOLD_PCTS = [0.005, 0.01, 0.02, 0.05, 0.10, 0.15, 0.20, 0.25]
OFFSETS_CALL = [25, 50, 75, 100, 150]
OFFSETS_PUT = [10, 25, 50, 75, 100, 150]
HORIZONS = [15, 30, 60, 120]
FLOW_GATES = [None, 0.30, 0.40, 0.50]  # min lott_zone ask_pct
TOD_BUCKETS = [None, 'open', 'morning', 'midday', 'close']


# --------------------------- HELPERS --------------------------------------


def cohens_d(a: np.ndarray, b: np.ndarray) -> float:
    pooled = np.sqrt((np.var(a, ddof=1) + np.var(b, ddof=1)) / 2)
    return 0.0 if pooled == 0 else float((a.mean() - b.mean()) / pooled)


def clip_R(s: pd.Series) -> pd.Series:
    return s.dropna().clip(lower=-1.0)


def mw(a: pd.Series, b: pd.Series) -> tuple[float, float, float]:
    a = a.dropna().to_numpy(); b = b.dropna().to_numpy()
    if len(a) < 5 or len(b) < 5:
        return (np.nan, np.nan, np.nan)
    _, p = stats.mannwhitneyu(a, b, alternative='two-sided')
    return (p, cohens_d(a, b), float(np.median(a) - np.median(b)))


def db_query(sql: str) -> pd.DataFrame:
    with psycopg2.connect(DB_URL) as conn:
        return pd.read_sql(sql, conn)


def tod_bucket(h: int) -> str:
    if h < 15: return 'open'
    if h < 17: return 'morning'
    if h < 19: return 'midday'
    return 'close'


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


def precompute_forward_R(events: pd.DataFrame, option_type: str,
                          offsets: list[int],
                          horizons: list[int],
                          direction: str = 'above') -> pd.DataFrame:
    """Pre-compute forward R for each (event, offset, horizon).
    direction: 'above' means trade strike = event_strike + offset (call lottery)
               'below' means trade strike = event_strike - offset (put lottery)
    """
    rows: list[dict] = []
    n_events = len(events)
    print(f'  pre-computing forward R for {n_events} events × {len(offsets)} '
          f'offsets × {len(horizons)} horizons...')
    last_pct = -1
    for i, ev in enumerate(events.itertuples(index=False)):
        pct = int(100 * i / n_events)
        if pct >= last_pct + 10:
            print(f'    {pct}%')
            last_pct = pct
        d = date.fromisoformat(ev.day) if isinstance(ev.day, str) \
            else ev.day
        path = PARQUET_DIR / f'{d.isoformat()}-trades.parquet'
        if not path.exists():
            continue
        ts = pd.Timestamp(ev.captured_at)
        if ts.tzinfo is None:
            ts = ts.tz_localize('UTC')
        for off in offsets:
            trade_k = (ev.strike + off) if direction == 'above' else (
                ev.strike - off)
            entry_df = trades_in_window(
                path, trade_k, option_type, d,
                ts, ts + pd.Timedelta(minutes=5))
            if entry_df.empty:
                continue
            entry_px = float(entry_df.iloc[0]['price'])
            if entry_px <= 0:
                continue
            for h in horizons:
                forward = trades_in_window(
                    path, trade_k, option_type, d,
                    ts, ts + pd.Timedelta(minutes=h))
                if forward.empty:
                    continue
                max_px = float(forward['price'].max())
                R = (max_px - entry_px) / entry_px
                rows.append({
                    'event_id': i,
                    'day': str(ev.day),
                    'captured_at': ts,
                    'event_strike': float(ev.strike),
                    'trade_strike': float(trade_k),
                    'offset': off,
                    'horizon': h,
                    'entry_px': entry_px,
                    'max_px': max_px,
                    'R': R,
                })
    return pd.DataFrame(rows)


# --------------------------- REFINE B1 (MAGNET) ---------------------------


def refine_B1(events: pd.DataFrame) -> pd.DataFrame:
    """Stratify magnet effect (closed_pct) by |γ_post| decile + time."""
    ev = events.copy()
    ev['abs_gamma_post'] = ev['gamma_post'].abs()
    # Per-day decile
    ev['gamma_post_decile'] = ev.groupby('day')['abs_gamma_post'].transform(
        lambda s: pd.qcut(s.rank(method='first'), 10, labels=False,
                          duplicates='drop'))

    # Compute closed_pct at multiple horizons
    rows = []
    for _, e in ev.iterrows():
        spot_t = e.get('spot_at_event')
        strike = e.get('strike')
        if pd.isna(spot_t) or pd.isna(strike):
            continue
        dist_t = strike - spot_t
        if abs(dist_t) < 1e-6:
            continue
        for h in HORIZONS:
            pts = e.get(f'spot_t_pts_{h}m')
            if pd.isna(pts):
                continue
            dist_h = strike - (spot_t + pts)
            closed = (abs(dist_t) - abs(dist_h)) / abs(dist_t)
            rows.append({
                'day': e['day'],
                'event_otm_dir': e['event_otm_dir'],
                'abs_gamma_post': e['abs_gamma_post'],
                'gamma_post_decile': e['gamma_post_decile'],
                'horizon': h,
                'closed_pct': closed,
            })
    return pd.DataFrame(rows)


# --------------------------- REFINE B4 (VOL CONTRACTION) -----------------


def refine_B4(events: pd.DataFrame, control: pd.DataFrame) -> pd.DataFrame:
    """Sweep |Δγ| threshold × TOD bucket. Compare |forward move| medians."""
    ev = events.copy()
    ev['abs_delta'] = ev['gamma_delta'].abs()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                         format='ISO8601')
    ev['hour'] = ev['captured_at'].dt.hour
    ev['tod'] = ev['hour'].apply(tod_bucket)

    ct = control.copy()
    ct['captured_at'] = pd.to_datetime(ct['captured_at'], utc=True,
                                         format='ISO8601')
    ct['hour'] = ct['captured_at'].dt.hour
    ct['tod'] = ct['hour'].apply(tod_bucket)

    rows: list[dict] = []
    for pct in THRESHOLD_PCTS:
        ev['day_threshold'] = ev.groupby('day')['abs_delta'].transform(
            lambda s: s.quantile(1.0 - pct))
        cand = ev[ev['abs_delta'] >= ev['day_threshold']]
        for h in HORIZONS:
            col = f'spot_t_pts_{h}m'
            if col not in cand.columns:
                continue
            for tod_name in [None, 'open', 'morning', 'midday', 'close']:
                cand_sub = cand if tod_name is None else cand[cand['tod'] == tod_name]
                ct_sub = ct if tod_name is None else ct[ct['tod'] == tod_name]
                if cand_sub.empty or ct_sub.empty:
                    continue
                ev_abs = cand_sub[col].abs().dropna()
                ct_abs = ct_sub[col].abs().dropna()
                p, d, med_diff = mw(ev_abs, ct_abs)
                rows.append({
                    'pct_threshold': pct,
                    'horizon': h,
                    'tod': tod_name or 'all',
                    'n_ev': len(ev_abs),
                    'n_ct': len(ct_abs),
                    'med_ev': float(ev_abs.median()) if len(ev_abs) else np.nan,
                    'med_ct': float(ct_abs.median()) if len(ct_abs) else np.nan,
                    'mw_p': p,
                    'cohens_d': d,
                })
    return pd.DataFrame(rows)


# --------------------------- REFINE H (CHARM SUB-CLASSES) ----------------


def refine_H(charm_events: pd.DataFrame, control: pd.DataFrame
             ) -> pd.DataFrame:
    """Rank charm sub-classes by effect size on signed forward return."""
    charm = charm_events[charm_events['panel'] == 'charm'].copy()
    charm['captured_at'] = pd.to_datetime(charm['captured_at'], utc=True,
                                            format='ISO8601')
    charm['hour'] = charm['captured_at'].dt.hour
    charm['tod'] = charm['hour'].apply(tod_bucket)
    ct = control.copy()
    ct['captured_at'] = pd.to_datetime(ct['captured_at'], utc=True,
                                         format='ISO8601')

    sub_classes: dict[str, pd.DataFrame] = {
        'all': charm,
        'deep_neg': charm[(charm['value'] < 0) & (charm['delta'] < 0)],
        'deep_pos': charm[(charm['value'] > 0) & (charm['delta'] > 0)],
        'flip_to_neg': charm[(charm['value'] < 0)
                              & (charm['delta'].abs() > charm['value'].abs())],
        'flip_to_pos': charm[(charm['value'] > 0)
                              & (charm['delta'].abs() > charm['value'].abs())],
        'large_negative_post': charm[charm['value']
                                      < charm['value'].quantile(0.10)],
        'large_positive_post': charm[charm['value']
                                      > charm['value'].quantile(0.90)],
        'tod_open': charm[charm['tod'] == 'open'],
        'tod_morning': charm[charm['tod'] == 'morning'],
        'tod_midday': charm[charm['tod'] == 'midday'],
        'tod_close': charm[charm['tod'] == 'close'],
        'above_spot': charm[charm['strike'] > charm['spot_at_event']],
        'below_spot': charm[charm['strike'] < charm['spot_at_event']],
    }
    rows: list[dict] = []
    for label, sub in sub_classes.items():
        for h in HORIZONS:
            col = f'spot_pts_{h}m'
            ct_col = f'spot_t_pts_{h}m'
            if col not in sub.columns or ct_col not in ct.columns:
                continue
            ev_v = sub[col].dropna()
            ct_v = ct[ct_col].dropna()
            if len(ev_v) < 10:
                continue
            p, d, med_diff = mw(ev_v, ct_v)
            rows.append({
                'sub_class': label,
                'horizon': h,
                'n_ev': len(ev_v),
                'n_ct': len(ct_v),
                'med_ev': float(ev_v.median()),
                'med_ct': float(ct_v.median()),
                'mw_p': p,
                'cohens_d': d,
            })
    return pd.DataFrame(rows)


# --------------------------- REFINE I (CALL LOTTERY GRID) ----------------


def refine_I(events: pd.DataFrame) -> pd.DataFrame:
    """Pre-compute forward R for broadest candidate set (top-5%-of-day
    above-spot events). Then slice by threshold × offset × horizon ×
    flow_gate × TOD.
    """
    ev = events.copy()
    ev['captured_at'] = pd.to_datetime(ev['captured_at'], utc=True,
                                         format='ISO8601')
    ev['abs_gamma_post'] = ev['gamma_post'].abs()
    ev['abs_delta'] = ev['gamma_delta'].abs()
    ev['hour'] = ev['captured_at'].dt.hour
    ev['tod'] = ev['hour'].apply(tod_bucket)

    # Compute per-day percentile ranks for both axes
    ev['lvl_rank'] = ev.groupby('day')['abs_gamma_post'].rank(pct=True)
    ev['chg_rank'] = ev.groupby('day')['abs_delta'].rank(pct=True)

    # Broadest candidate set: above-spot AND (lvl_rank >= 0.75 OR chg_rank >= 0.75)
    # (sweeping AND-thresholds 75%/80%/85%/90%/95% inside the grid)
    cand = ev[(ev['event_otm_dir'] == 'above')
              & ((ev['lvl_rank'] >= 0.75) | (ev['chg_rank'] >= 0.75))]
    print(f'  I candidate set: {len(cand)} events')

    # Pre-compute forward R
    fr = precompute_forward_R(cand, 'call', OFFSETS_CALL, HORIZONS,
                                direction='above')
    if fr.empty:
        return pd.DataFrame()

    # Join back to candidate features
    cand_id = cand.reset_index().rename(columns={'index': 'event_id'})
    cand_id['event_id'] = range(len(cand_id))
    cand_features = cand_id[
        ['event_id', 'spot_at_event', 'gamma_post', 'gamma_delta',
         'abs_gamma_post', 'abs_delta', 'lvl_rank', 'chg_rank',
         'is_counter_trend', 'lott_ask_pct', 'lott_total', 'tod']
    ]
    # fr already has day/captured_at/strike; just join the extra features
    merged = fr.merge(cand_features, on='event_id', how='left')

    # Now sweep the grid
    rows: list[dict] = []
    for pct in THRESHOLD_PCTS:
        lvl_thresh = 1.0 - pct
        chg_thresh = 1.0 - pct
        sub_thresh = merged[
            (merged['lvl_rank'] >= lvl_thresh)
            & (merged['chg_rank'] >= chg_thresh)
        ]
        for off in OFFSETS_CALL:
            for h in HORIZONS:
                base = sub_thresh[(sub_thresh['offset'] == off)
                                  & (sub_thresh['horizon'] == h)]
                for flow_gate in FLOW_GATES:
                    bf = base if flow_gate is None else base[
                        base['lott_ask_pct'].fillna(0) >= flow_gate]
                    for tod_name in [None, 'open', 'morning', 'midday', 'close']:
                        bft = bf if tod_name is None else bf[bf['tod'] == tod_name]
                        if len(bft) < 3:
                            continue
                        R = clip_R(bft['R'])
                        R_ex518 = clip_R(bft[bft['day'] != '2026-05-18']['R'])
                        rows.append({
                            'threshold_pct': pct,
                            'offset': off,
                            'horizon': h,
                            'flow_gate': flow_gate if flow_gate else 0.0,
                            'tod': tod_name or 'all',
                            'n': len(bft),
                            'n_ex518': len(R_ex518),
                            'mean_R': float(R.mean()),
                            'median_R': float(R.median()),
                            'hit_R2': float((R >= 2).mean()),
                            'hit_R5': float((R >= 5).mean()),
                            'hit_R10': float((R >= 10).mean()),
                            'max_R': float(R.max()),
                            'mean_R_ex518': float(R_ex518.mean()) if len(R_ex518) else np.nan,
                            'hit_R5_ex518': float((R_ex518 >= 5).mean()) if len(R_ex518) else np.nan,
                            'hit_R10_ex518': float((R_ex518 >= 10).mean()) if len(R_ex518) else np.nan,
                            'max_R_ex518': float(R_ex518.max()) if len(R_ex518) else np.nan,
                        })
    return pd.DataFrame(rows)


# --------------------------- REFINE L (PUT LOTTERY GRID) -----------------


def refine_L(charm_events: pd.DataFrame, spot: pd.DataFrame
             ) -> pd.DataFrame:
    """Same shape as refine_I but for charm-below-spot events on the put side.
    Sweep: threshold × offset × horizon × CT filter × TOD.
    """
    charm = charm_events[charm_events['panel'] == 'charm'].copy()
    charm['captured_at'] = pd.to_datetime(charm['captured_at'], utc=True,
                                            format='ISO8601')
    charm['day'] = charm['day'].astype(str)
    charm['abs_delta'] = charm['delta'].abs()
    charm['hour'] = charm['captured_at'].dt.hour
    charm['tod'] = charm['hour'].apply(tod_bucket)
    charm['dgn_rank'] = charm.groupby('day')['abs_delta'].rank(pct=True)
    # Below-spot only
    below = charm[(charm['strike'] < charm['spot_at_event'])
                   & (charm['dgn_rank'] >= 0.95)].copy()
    print(f'  L candidate set (charm below-spot, top-5% per day): {len(below)}')

    # Add 10-min prior spot direction (for CT filter)
    spot_dir = []
    for _, e in below.iterrows():
        ts = e['captured_at']
        start = ts - pd.Timedelta(minutes=10)
        win = spot.loc[start:ts]
        if len(win) >= 2:
            spot_dir.append(float(win['close'].iloc[-1])
                            - float(win['close'].iloc[0]))
        else:
            spot_dir.append(np.nan)
    below = below.reset_index(drop=True)
    below['spot_delta_pre10'] = spot_dir
    # Counter-trend for put-side = spot UP ≥ 2pts in prior 10m
    below['is_ct_put'] = below['spot_delta_pre10'].fillna(0) >= 2.0

    # Pre-compute forward R for put lottery at offsets
    fr = precompute_forward_R(below, 'put', OFFSETS_PUT, HORIZONS,
                                direction='below')
    if fr.empty:
        return pd.DataFrame()

    below_id = below.reset_index().rename(columns={'index': 'event_id'})
    below_id['event_id'] = range(len(below_id))
    feat = below_id[['event_id', 'spot_at_event', 'value', 'delta',
                      'abs_delta', 'dgn_rank', 'is_ct_put', 'tod',
                      'spot_delta_pre10']]
    merged = fr.merge(feat, on='event_id', how='left')

    rows: list[dict] = []
    for pct in THRESHOLD_PCTS:
        sub_thresh = merged[merged['dgn_rank'] >= (1.0 - pct)]
        for off in OFFSETS_PUT:
            for h in HORIZONS:
                base = sub_thresh[(sub_thresh['offset'] == off)
                                  & (sub_thresh['horizon'] == h)]
                for ct_flag in [None, True, False]:
                    bf = base if ct_flag is None else base[
                        base['is_ct_put'] == ct_flag]
                    for tod_name in [None, 'open', 'morning', 'midday', 'close']:
                        bft = bf if tod_name is None else bf[bf['tod'] == tod_name]
                        if len(bft) < 3:
                            continue
                        R = clip_R(bft['R'])
                        rows.append({
                            'threshold_pct': pct,
                            'offset': off,
                            'horizon': h,
                            'ct_filter': 'all' if ct_flag is None else ('ct' if ct_flag else 'not_ct'),
                            'tod': tod_name or 'all',
                            'n': len(bft),
                            'mean_R': float(R.mean()),
                            'median_R': float(R.median()),
                            'hit_R2': float((R >= 2).mean()),
                            'hit_R5': float((R >= 5).mean()),
                            'hit_R10': float((R >= 10).mean()),
                            'max_R': float(R.max()),
                        })
    return pd.DataFrame(rows)


# --------------------------- WRITE FINDINGS ------------------------------


def write_findings(b1: pd.DataFrame, b4: pd.DataFrame, h: pd.DataFrame,
                   i: pd.DataFrame, l: pd.DataFrame, out_path: Path
                   ) -> None:
    lines: list[str] = []
    lines.append('# Refinement of the 5 strongest findings\n')

    # B1
    lines.append('## B1 — Magnet by |γ_post| decile × horizon\n')
    if not b1.empty:
        for d_str in ['above', 'below']:
            lines.append(f'### {d_str}-spot')
            sub = b1[b1['event_otm_dir'] == d_str]
            piv = sub.pivot_table(index='gamma_post_decile',
                                    columns='horizon', values='closed_pct',
                                    aggfunc='median')
            lines.append(piv.to_string(float_format=lambda x: f'{x:+.3f}'))

    # B4
    lines.append('\n## B4 — Vol contraction sweep (|forward move| medians)\n')
    if not b4.empty:
        lines.append('### Cohen\'s d sorted: top-20 (negative d = stronger contraction)')
        view = b4.sort_values('cohens_d').head(20)
        cols = ['pct_threshold', 'horizon', 'tod', 'n_ev', 'med_ev',
                'med_ct', 'mw_p', 'cohens_d']
        v = view[cols].copy()
        v['med_ev'] = v['med_ev'].apply(lambda x: f'{x:.2f}')
        v['med_ct'] = v['med_ct'].apply(lambda x: f'{x:.2f}')
        v['mw_p'] = v['mw_p'].apply(lambda x: f'{x:.4f}')
        v['cohens_d'] = v['cohens_d'].apply(lambda x: f'{x:+.2f}')
        lines.append(v.to_string(index=False))

    # H
    lines.append('\n## H — Charm sub-class sharpening (signed forward, sorted by |d|)\n')
    if not h.empty:
        h['abs_d'] = h['cohens_d'].abs()
        view = h.sort_values('abs_d', ascending=False).head(25)
        cols = ['sub_class', 'horizon', 'n_ev', 'med_ev', 'med_ct',
                'mw_p', 'cohens_d']
        v = view[cols].copy()
        v['med_ev'] = v['med_ev'].apply(lambda x: f'{x:+.2f}')
        v['med_ct'] = v['med_ct'].apply(lambda x: f'{x:+.2f}')
        v['mw_p'] = v['mw_p'].apply(lambda x: f'{x:.4f}')
        v['cohens_d'] = v['cohens_d'].apply(lambda x: f'{x:+.2f}')
        lines.append(v.to_string(index=False))

    # I — top filters
    lines.append('\n## I — Call lottery: top filter cells (above-spot)\n')
    if not i.empty:
        # Best by hit_R5_ex518 with n_ex518 >= 10
        eligible = i[(i['n_ex518'] >= 10) & i['hit_R5_ex518'].notna()]
        if len(eligible):
            lines.append('### Top 20 by hit_R5_ex518 (n_ex518 >= 10)')
            view = eligible.sort_values('hit_R5_ex518',
                                          ascending=False).head(20)
            cols = ['threshold_pct', 'offset', 'horizon', 'flow_gate',
                    'tod', 'n', 'n_ex518', 'hit_R5_ex518', 'hit_R10_ex518',
                    'mean_R_ex518', 'max_R_ex518']
            v = view[cols].copy()
            for c in ['hit_R5_ex518', 'hit_R10_ex518']:
                v[c] = v[c].apply(lambda x: f'{x*100:.1f}%' if pd.notna(x) else 'na')
            for c in ['mean_R_ex518', 'max_R_ex518']:
                v[c] = v[c].apply(lambda x: f'{x:.2f}' if pd.notna(x) else 'na')
            lines.append(v.to_string(index=False))
        # Also: best by max_R_ex518
        lines.append('\n### Top 10 by max_R_ex518 (catches the rare 75x type)')
        view = eligible.sort_values('max_R_ex518', ascending=False).head(10)
        cols = ['threshold_pct', 'offset', 'horizon', 'flow_gate', 'tod',
                'n_ex518', 'hit_R5_ex518', 'max_R_ex518']
        v = view[cols].copy()
        for c in ['hit_R5_ex518']:
            v[c] = v[c].apply(lambda x: f'{x*100:.1f}%' if pd.notna(x) else 'na')
        for c in ['max_R_ex518']:
            v[c] = v[c].apply(lambda x: f'{x:.2f}' if pd.notna(x) else 'na')
        lines.append(v.to_string(index=False))

    # L — top filters
    lines.append('\n## L — Put lottery: top filter cells (charm-below-spot)\n')
    if not l.empty:
        eligible = l[l['n'] >= 10]
        lines.append('### Top 20 by hit_R5 (n >= 10)')
        view = eligible.sort_values('hit_R5', ascending=False).head(20)
        cols = ['threshold_pct', 'offset', 'horizon', 'ct_filter', 'tod',
                'n', 'hit_R5', 'hit_R10', 'mean_R', 'max_R']
        v = view[cols].copy()
        for c in ['hit_R5', 'hit_R10']:
            v[c] = v[c].apply(lambda x: f'{x*100:.1f}%')
        for c in ['mean_R', 'max_R']:
            v[c] = v[c].apply(lambda x: f'{x:.2f}')
        lines.append(v.to_string(index=False))

        lines.append('\n### Top 10 by mean_R (n >= 10)')
        view = eligible.sort_values('mean_R', ascending=False).head(10)
        v = view[cols].copy()
        for c in ['hit_R5', 'hit_R10']:
            v[c] = v[c].apply(lambda x: f'{x*100:.1f}%')
        for c in ['mean_R', 'max_R']:
            v[c] = v[c].apply(lambda x: f'{x:.2f}')
        lines.append(v.to_string(index=False))

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER --------------------------------------


def main() -> None:
    print('Loading artifacts...')
    events_b = pd.read_csv(OUT / 'hypothesis_B_events.csv')
    control_b = pd.read_csv(OUT / 'hypothesis_B_control.csv')
    charm = pd.read_csv(OUT / 'hypothesis_F_charm_vanna.csv')
    print(f'  events: {len(events_b)}, control: {len(control_b)}, '
          f'charm/vanna: {len(charm)}')

    print('\nLoading SPX 1m closes...')
    spot = db_query("""
        SELECT timestamp, close FROM index_candles_1m
        WHERE symbol='SPX' AND timestamp >= '2026-04-13'
          AND timestamp < '2026-05-19'
        ORDER BY timestamp
    """)
    spot['timestamp'] = pd.to_datetime(spot['timestamp'], utc=True)
    spot['close'] = spot['close'].astype(float)
    spot = spot.set_index('timestamp')

    print('\n=== Refine B1 (magnet stratification) ===')
    b1 = refine_B1(events_b)
    b1.to_csv(OUT / 'refine_B1.csv', index=False)

    print('\n=== Refine B4 (vol contraction sweep) ===')
    b4 = refine_B4(events_b, control_b)
    b4.to_csv(OUT / 'refine_B4.csv', index=False)

    print('\n=== Refine H (charm sub-classes) ===')
    h_df = refine_H(charm, control_b)
    h_df.to_csv(OUT / 'refine_H.csv', index=False)

    print('\n=== Refine I (call lottery grid) ===')
    i_df = refine_I(events_b)
    i_df.to_csv(OUT / 'refine_I_call_lottery_grid.csv', index=False)

    print('\n=== Refine L (put lottery grid) ===')
    l_df = refine_L(charm, spot)
    l_df.to_csv(OUT / 'refine_L_put_lottery_grid.csv', index=False)

    print('\nWriting findings...')
    write_findings(b1, b4, h_df, i_df, l_df,
                   OUT / 'refine_top5_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
