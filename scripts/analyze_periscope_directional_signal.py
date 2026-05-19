"""
Hypothesis B: Does Periscope MM gamma positioning predict SPX spot direction?

Distinct from Hypothesis A (which asked about lottery-tail R outcomes at OTM
strikes). Here we ask: when MM gamma deepens/flips/jumps at strike S, what
does the index itself do over the next 5/10/15/30/60 minutes — and does that
move differ systematically from a time-matched control sample?

Sub-hypotheses:
  B1 (magnet):   Spot moves TOWARD the event strike after the event.
  B2 (revert):   Counter-trend events mark spot reversal points.
  B3 (direction):Direction of gamma shift predicts direction of forward spot.
  B4 (magnitude):Events forecast larger-than-baseline absolute moves (vol
                 expansion regardless of direction).

For each sub-hypothesis we compare event distributions to a control sample
using Mann-Whitney U (non-parametric, robust to fat tails) and report
Cohen's d, median difference, and 95% bootstrap CIs. We correct for multiple
comparisons across horizons with Benjamini-Hochberg FDR.

Inputs:
  docs/tmp/forensic-multi-day/events.csv   (1,450 events with features)
  docs/tmp/forensic-multi-day/control.csv  (1,300 random control samples)
  Neon: index_candles_1m for spot lookups

Outputs (docs/tmp/forensic-multi-day/):
  hypothesis_B_events.csv     (events augmented with forward spot returns)
  hypothesis_B_control.csv    (controls augmented same way)
  hypothesis_B_tests.csv      (test statistics for each comparison)
  hypothesis_B_findings.md    (APA-style writeup)
  plots/B_*.png               (boxplots + density + magnet)
"""
from __future__ import annotations

import os
import warnings
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pingouin as pg
import psycopg2
from dotenv import load_dotenv
from scipy import stats

warnings.filterwarnings('ignore')
load_dotenv('.env.local')

OUT = Path('docs/tmp/forensic-multi-day')
PLOTS = OUT / 'plots'
PLOTS.mkdir(parents=True, exist_ok=True)

DB_URL = os.environ['DATABASE_URL_UNPOOLED']
HORIZONS_MIN = [5, 10, 15, 30, 60]


# --------------------------- SPOT LOADING --------------------------------


def load_spot_all_days() -> pd.DataFrame:
    """Pull SPX 1-min closes for all event days at once (efficient)."""
    with psycopg2.connect(DB_URL) as conn:
        df = pd.read_sql(
            """
            SELECT timestamp, close
            FROM index_candles_1m
            WHERE symbol='SPX' AND timestamp >= '2026-04-13' AND timestamp < '2026-05-19'
            ORDER BY timestamp
            """,
            conn,
        )
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    df['close'] = df['close'].astype(float)
    return df.set_index('timestamp')


def forward_returns(ts: pd.Timestamp, spot: pd.DataFrame,
                    horizons: list[int]) -> dict:
    """For event timestamp ts, find spot at T (latest minute ≤ ts) and
    spot at T+h for each horizon. Returns absolute SPX-point moves +
    percent returns.
    """
    out: dict = {}
    if not isinstance(ts, pd.Timestamp):
        ts = pd.Timestamp(ts)
    if ts.tzinfo is None:
        ts = ts.tz_localize('UTC')

    # spot at T = latest bar at or before ts
    try:
        idx_at = spot.index.get_indexer([ts], method='pad')[0]
        if idx_at == -1:
            return {f'spot_t_pts_{h}m': None for h in horizons} | \
                   {f'spot_t_pct_{h}m': None for h in horizons} | \
                   {'spot_at_t': None}
        spot_t = float(spot['close'].iloc[idx_at])
    except (KeyError, IndexError):
        return {f'spot_t_pts_{h}m': None for h in horizons} | \
               {f'spot_t_pct_{h}m': None for h in horizons} | \
               {'spot_at_t': None}

    out['spot_at_t'] = spot_t
    for h in horizons:
        target = ts + pd.Timedelta(minutes=h)
        idx_h = spot.index.get_indexer([target], method='pad')[0]
        if idx_h == -1 or idx_h <= idx_at:
            out[f'spot_t_pts_{h}m'] = None
            out[f'spot_t_pct_{h}m'] = None
            continue
        spot_h = float(spot['close'].iloc[idx_h])
        out[f'spot_t_pts_{h}m'] = spot_h - spot_t
        out[f'spot_t_pct_{h}m'] = (spot_h - spot_t) / spot_t * 100.0
    return out


def augment_with_forward_returns(df: pd.DataFrame, ts_col: str,
                                 spot: pd.DataFrame) -> pd.DataFrame:
    """Append forward-return columns to df."""
    df = df.copy()
    fr_rows = [forward_returns(t, spot, HORIZONS_MIN)
               for t in pd.to_datetime(df[ts_col], utc=True, format='ISO8601')]
    fr_df = pd.DataFrame(fr_rows, index=df.index)
    return pd.concat([df, fr_df], axis=1)


# --------------------------- HYPOTHESIS TESTS -----------------------------


def bootstrap_ci(data: np.ndarray, stat_fn=np.median, n_boot: int = 2000,
                 ci: float = 0.95) -> tuple[float, float]:
    rng = np.random.default_rng(20260518)
    boots = np.array([stat_fn(rng.choice(data, size=len(data), replace=True))
                      for _ in range(n_boot)])
    lo = float(np.quantile(boots, (1 - ci) / 2))
    hi = float(np.quantile(boots, 1 - (1 - ci) / 2))
    return lo, hi


def compare_distributions(event_vals: pd.Series, control_vals: pd.Series,
                          label: str, horizon: int) -> dict:
    """Mann-Whitney U + Welch's t-test + Cohen's d + bootstrap medians."""
    ev = event_vals.dropna().to_numpy()
    cv = control_vals.dropna().to_numpy()
    if len(ev) < 5 or len(cv) < 5:
        return {'label': label, 'horizon_min': horizon, 'n_event': len(ev),
                'n_control': len(cv), 'note': 'insufficient data'}

    # Mann-Whitney U (two-sided)
    u_stat, u_p = stats.mannwhitneyu(ev, cv, alternative='two-sided')
    # Welch's t-test
    t_stat, t_p = stats.ttest_ind(ev, cv, equal_var=False)
    # Cohen's d
    pooled_std = np.sqrt((np.var(ev, ddof=1) + np.var(cv, ddof=1)) / 2)
    d = (np.mean(ev) - np.mean(cv)) / pooled_std if pooled_std > 0 else 0.0
    # Rank-biserial correlation (effect size for Mann-Whitney)
    rb = 1.0 - (2.0 * u_stat) / (len(ev) * len(cv))
    # Bootstrap medians
    ev_med_lo, ev_med_hi = bootstrap_ci(ev, np.median)
    cv_med_lo, cv_med_hi = bootstrap_ci(cv, np.median)

    return {
        'label': label,
        'horizon_min': horizon,
        'n_event': len(ev),
        'n_control': len(cv),
        'event_mean': float(np.mean(ev)),
        'event_median': float(np.median(ev)),
        'event_std': float(np.std(ev, ddof=1)),
        'event_median_ci_lo': ev_med_lo,
        'event_median_ci_hi': ev_med_hi,
        'control_mean': float(np.mean(cv)),
        'control_median': float(np.median(cv)),
        'control_std': float(np.std(cv, ddof=1)),
        'control_median_ci_lo': cv_med_lo,
        'control_median_ci_hi': cv_med_hi,
        'mw_u': float(u_stat),
        'mw_p': float(u_p),
        'welch_t': float(t_stat),
        'welch_p': float(t_p),
        'cohens_d': float(d),
        'rank_biserial_r': float(rb),
    }


def bh_fdr(p_values: list[float], q: float = 0.05) -> list[bool]:
    """Benjamini-Hochberg FDR correction. Returns list of significance flags."""
    n = len(p_values)
    if n == 0:
        return []
    sorted_idx = np.argsort(p_values)
    sorted_p = np.array(p_values)[sorted_idx]
    crit = (np.arange(1, n + 1) / n) * q
    below = sorted_p <= crit
    if not below.any():
        return [False] * n
    max_idx = np.where(below)[0].max()
    threshold = sorted_p[max_idx]
    return [p <= threshold for p in p_values]


# --------------------------- ANALYSIS DRIVERS -----------------------------


def run_b3_directional(events: pd.DataFrame, control: pd.DataFrame) -> list[dict]:
    """B3: Does the gamma shift direction predict forward spot direction?

    Comparisons:
      - deepened_negative + above-spot: predicts UP move? (whales want spot up)
      - deepened_negative + below-spot: predicts DOWN move? (whales want spot down)
      - flipped_to_negative + above: predicts UP?
      - flipped_to_negative + below: predicts DOWN?

    For each, we compare the event subset's signed forward spot return to
    the control's signed forward spot return.
    """
    results: list[dict] = []
    subsets = {
        'deep_neg_above':     events[events['deepened_negative'] & (events['event_otm_dir'] == 'above')],
        'deep_neg_below':     events[events['deepened_negative'] & (events['event_otm_dir'] == 'below')],
        'deep_pos_above':     events[events['deepened_positive'] & (events['event_otm_dir'] == 'above')],
        'deep_pos_below':     events[events['deepened_positive'] & (events['event_otm_dir'] == 'below')],
        'flip_to_neg_above':  events[events['flipped_to_negative'] & (events['event_otm_dir'] == 'above')],
        'flip_to_neg_below':  events[events['flipped_to_negative'] & (events['event_otm_dir'] == 'below')],
        'flip_to_pos_above':  events[events['flipped_to_positive'] & (events['event_otm_dir'] == 'above')],
        'flip_to_pos_below':  events[events['flipped_to_positive'] & (events['event_otm_dir'] == 'below')],
        'counter_trend':      events[events['is_counter_trend']],
        'ct_above':           events[events['is_counter_trend'] & (events['event_otm_dir'] == 'above')],
        'ct_below':           events[events['is_counter_trend'] & (events['event_otm_dir'] == 'below')],
        'all_events':         events,
    }
    for label, sub in subsets.items():
        for h in HORIZONS_MIN:
            col = f'spot_t_pts_{h}m'
            r = compare_distributions(sub[col], control[col], label, h)
            results.append(r)
    return results


def run_b4_magnitude(events: pd.DataFrame, control: pd.DataFrame) -> list[dict]:
    """B4: Do events forecast larger absolute moves (vol expansion)?

    Compare |forward return| distribution of events vs control.
    """
    results: list[dict] = []
    subsets = {
        'all_events':     events,
        'counter_trend':  events[events['is_counter_trend']],
        'ct_above':       events[events['is_counter_trend'] & (events['event_otm_dir'] == 'above')],
        'ct_below':       events[events['is_counter_trend'] & (events['event_otm_dir'] == 'below')],
        'deep_neg_above': events[events['deepened_negative'] & (events['event_otm_dir'] == 'above')],
        'deep_neg_below': events[events['deepened_negative'] & (events['event_otm_dir'] == 'below')],
        'top_decile_mag': events[events['gamma_delta'].abs() >=
                                  events['gamma_delta'].abs().quantile(0.90)],
    }
    for label, sub in subsets.items():
        for h in HORIZONS_MIN:
            col = f'spot_t_pts_{h}m'
            r = compare_distributions(sub[col].abs(),
                                       control[col].abs(),
                                       f'abs_{label}', h)
            results.append(r)
    return results


def run_b1_magnet(events: pd.DataFrame) -> pd.DataFrame:
    """B1: Does spot move TOWARD the event strike post-event?

    For each event with spot_at_event known:
      Calculate distance_to_strike at T = strike - spot_at_event (signed)
      Distance at T+h = strike - spot_at_T+h
      Movement TOWARD strike = |dist_T| - |dist_T+h|  (positive = moved closer)
      Normalize by initial distance to compare across events.
    """
    rows: list[dict] = []
    for _, ev in events.iterrows():
        if pd.isna(ev.get('spot_at_event')) or pd.isna(ev.get('strike')):
            continue
        strike = float(ev['strike'])
        spot_t = float(ev['spot_at_event'])
        dist_t = strike - spot_t  # signed; positive = strike above spot
        if abs(dist_t) < 1e-6:
            continue
        row = {'day': ev['day'], 'captured_at': ev['captured_at'],
               'strike': strike, 'spot_at_event': spot_t, 'dist_t': dist_t,
               'event_otm_dir': ev['event_otm_dir'],
               'deepened_negative': ev['deepened_negative'],
               'is_counter_trend': ev['is_counter_trend']}
        for h in HORIZONS_MIN:
            spot_h = ev.get(f'spot_at_t')  # already at T from earlier
            pts_h = ev.get(f'spot_t_pts_{h}m')
            if pts_h is None or pd.isna(pts_h):
                row[f'dist_{h}m'] = None
                row[f'closed_pct_{h}m'] = None
                continue
            spot_at_h = spot_t + pts_h
            dist_h = strike - spot_at_h
            row[f'dist_{h}m'] = dist_h
            # closed_pct: 1 = fully closed (spot reached strike); 0 = unchanged;
            # negative = moved further away. Use signed gap reduction.
            row[f'closed_pct_{h}m'] = (abs(dist_t) - abs(dist_h)) / abs(dist_t)
        rows.append(row)
    return pd.DataFrame(rows)


# --------------------------- PLOTS ----------------------------------------


def plot_b3_distributions(events: pd.DataFrame, control: pd.DataFrame,
                          out_path: Path) -> None:
    """Boxplots of forward spot return (pts) for key event classes at 30m."""
    classes = [
        ('control', control['spot_t_pts_30m']),
        ('all events', events['spot_t_pts_30m']),
        ('CT above', events[events['is_counter_trend']
                            & (events['event_otm_dir'] == 'above')]['spot_t_pts_30m']),
        ('CT below', events[events['is_counter_trend']
                            & (events['event_otm_dir'] == 'below')]['spot_t_pts_30m']),
        ('deep_neg above', events[events['deepened_negative']
                                  & (events['event_otm_dir'] == 'above')]['spot_t_pts_30m']),
        ('deep_neg below', events[events['deepened_negative']
                                  & (events['event_otm_dir'] == 'below')]['spot_t_pts_30m']),
        ('top_decile_|Δγ|', events[events['gamma_delta'].abs() >=
                                    events['gamma_delta'].abs().quantile(0.90)]['spot_t_pts_30m']),
    ]
    data = [s.dropna().to_numpy() for _, s in classes]
    labels = [name for name, _ in classes]

    fig, ax = plt.subplots(figsize=(13, 6))
    bp = ax.boxplot(data, labels=labels, showmeans=True,
                    meanprops={'marker': 'D', 'markerfacecolor': 'red', 'markersize': 6},
                    medianprops={'color': 'orange', 'linewidth': 2})
    ax.axhline(0, color='k', lw=0.5)
    ax.set_title('Forward SPX spot move at 30-min horizon (pts, signed) — events vs control')
    ax.set_ylabel('Spot return (pts)')
    ax.set_ylim(-20, 20)  # clip extreme outliers for vis
    ax.grid(alpha=0.3, axis='y')
    plt.xticks(rotation=15, ha='right')
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_b4_volexp(events: pd.DataFrame, control: pd.DataFrame,
                   out_path: Path) -> None:
    """Compare |forward move| distributions: do events forecast vol expansion?"""
    fig, axes = plt.subplots(1, len(HORIZONS_MIN), figsize=(20, 4.5), sharey=True)
    for ax, h in zip(axes, HORIZONS_MIN):
        col = f'spot_t_pts_{h}m'
        ev_abs = events[col].abs().dropna()
        ct_abs = control[col].abs().dropna()
        bins = np.linspace(0, max(float(ev_abs.quantile(0.95)),
                                  float(ct_abs.quantile(0.95))), 30)
        ax.hist(ct_abs, bins=bins, color='#888', alpha=0.6, density=True,
                label=f'control (n={len(ct_abs)})')
        ax.hist(ev_abs, bins=bins, color='#1f77b4', alpha=0.6, density=True,
                label=f'events (n={len(ev_abs)})')
        ax.axvline(ct_abs.median(), color='#888', ls='--', lw=1)
        ax.axvline(ev_abs.median(), color='#1f77b4', ls='--', lw=1)
        ax.set_title(f'|Spot move| at {h}min (pts)')
        ax.set_xlabel('|Spot move| (pts)')
        if ax is axes[0]:
            ax.set_ylabel('Density')
        ax.legend(fontsize=8)
        ax.grid(alpha=0.3)
    fig.suptitle('Hypothesis B4: do events forecast larger spot moves (vol expansion)?')
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


def plot_b1_magnet(magnet_df: pd.DataFrame, out_path: Path) -> None:
    """Median closed_pct across event classes at multiple horizons."""
    classes = ['all', 'CT', 'CT_above', 'CT_below', 'deep_neg_above', 'deep_neg_below']
    rows = []
    for cls in classes:
        if cls == 'all':
            sub = magnet_df
        elif cls == 'CT':
            sub = magnet_df[magnet_df['is_counter_trend']]
        elif cls == 'CT_above':
            sub = magnet_df[magnet_df['is_counter_trend']
                            & (magnet_df['event_otm_dir'] == 'above')]
        elif cls == 'CT_below':
            sub = magnet_df[magnet_df['is_counter_trend']
                            & (magnet_df['event_otm_dir'] == 'below')]
        elif cls == 'deep_neg_above':
            sub = magnet_df[magnet_df['deepened_negative']
                            & (magnet_df['event_otm_dir'] == 'above')]
        elif cls == 'deep_neg_below':
            sub = magnet_df[magnet_df['deepened_negative']
                            & (magnet_df['event_otm_dir'] == 'below')]
        for h in HORIZONS_MIN:
            col = f'closed_pct_{h}m'
            s = sub[col].dropna()
            if len(s):
                rows.append({'class': cls, 'horizon': h,
                             'n': len(s), 'median_closed_pct': s.median(),
                             'mean_closed_pct': s.mean()})
    df = pd.DataFrame(rows).pivot(index='class', columns='horizon',
                                   values='median_closed_pct')
    fig, ax = plt.subplots(figsize=(11, 5))
    df.plot.bar(ax=ax)
    ax.axhline(0, color='k', lw=0.5)
    ax.set_title('Hypothesis B1 (magnet): median fraction of strike-gap closed post-event')
    ax.set_ylabel('Median (|dist_T| - |dist_T+h|) / |dist_T|\n>0 = spot moved toward strike')
    ax.set_xlabel('Event class')
    ax.legend(title='Horizon (min)', loc='upper right')
    ax.grid(alpha=0.3, axis='y')
    plt.xticks(rotation=15, ha='right')
    fig.tight_layout()
    fig.savefig(out_path, dpi=120)
    plt.close(fig)


# --------------------------- REPORT ---------------------------------------


def write_findings(b3_results: list[dict], b4_results: list[dict],
                   magnet_df: pd.DataFrame, out_path: Path) -> None:
    lines: list[str] = []
    lines.append('# Hypothesis B: Periscope MM gamma positioning → SPX spot direction\n')
    lines.append('Tests: Mann-Whitney U (non-parametric, two-sided) on forward SPX spot move (pts)')
    lines.append('vs random control. Effect sizes: Cohen\'s d + rank-biserial r.')
    lines.append('Multiple-comparison correction: Benjamini-Hochberg FDR @ q=0.05.\n')

    # B3 table
    lines.append('## B3 (direction): signed forward spot return by event class\n')
    df_b3 = pd.DataFrame(b3_results)
    if not df_b3.empty:
        # FDR correction across B3 tests
        ps = df_b3['mw_p'].fillna(1.0).tolist()
        df_b3['sig_fdr'] = bh_fdr(ps, q=0.05)
        # Compact table at 30m horizon
        view_cols = ['label', 'horizon_min', 'n_event', 'event_median',
                     'event_median_ci_lo', 'event_median_ci_hi',
                     'control_median', 'mw_p', 'cohens_d', 'sig_fdr']
        show = df_b3[df_b3['horizon_min'] == 30][view_cols].copy()
        for c in ['event_median', 'event_median_ci_lo', 'event_median_ci_hi',
                  'control_median', 'cohens_d']:
            show[c] = show[c].apply(lambda x: f'{x:+.3f}' if pd.notna(x) else 'na')
        show['mw_p'] = show['mw_p'].apply(lambda p: f'{p:.4f}' if pd.notna(p) else 'na')
        lines.append('### Results at 30-min horizon (sorted by Cohen\'s d magnitude)\n')
        # Use abs cohens_d for sort
        df_b3['abs_d'] = df_b3['cohens_d'].abs()
        show_sorted = df_b3[df_b3['horizon_min'] == 30].sort_values('abs_d', ascending=False)[view_cols]
        for c in ['event_median', 'event_median_ci_lo', 'event_median_ci_hi',
                  'control_median', 'cohens_d']:
            show_sorted[c] = show_sorted[c].apply(lambda x: f'{x:+.3f}' if pd.notna(x) else 'na')
        show_sorted['mw_p'] = show_sorted['mw_p'].apply(lambda p: f'{p:.4f}' if pd.notna(p) else 'na')
        lines.append(show_sorted.to_string(index=False))

        # Direction summary across all horizons for key classes
        lines.append('\n### Signed forward return by horizon (median, pts)\n')
        for label in ['ct_above', 'ct_below', 'deep_neg_above',
                       'deep_neg_below', 'all_events']:
            row = df_b3[df_b3['label'] == label]
            if not row.empty:
                summary = ' | '.join([
                    f'{int(r["horizon_min"])}m: median={r["event_median"]:+.2f} '
                    f'(p={r["mw_p"]:.3f}, d={r["cohens_d"]:+.2f})'
                    for _, r in row.iterrows()
                ])
                lines.append(f'  {label}: {summary}')

    # B4 table
    lines.append('\n## B4 (magnitude / vol expansion): |forward spot move|\n')
    df_b4 = pd.DataFrame(b4_results)
    if not df_b4.empty:
        ps = df_b4['mw_p'].fillna(1.0).tolist()
        df_b4['sig_fdr'] = bh_fdr(ps, q=0.05)
        df_b4['abs_d'] = df_b4['cohens_d'].abs()
        view_cols = ['label', 'horizon_min', 'n_event', 'event_median',
                     'event_median_ci_lo', 'event_median_ci_hi',
                     'control_median', 'mw_p', 'cohens_d', 'sig_fdr']
        show = df_b4[df_b4['horizon_min'] == 30].sort_values('abs_d', ascending=False)[view_cols]
        for c in ['event_median', 'event_median_ci_lo', 'event_median_ci_hi',
                  'control_median', 'cohens_d']:
            show[c] = show[c].apply(lambda x: f'{x:+.3f}' if pd.notna(x) else 'na')
        show['mw_p'] = show['mw_p'].apply(lambda p: f'{p:.4f}' if pd.notna(p) else 'na')
        lines.append('### Absolute forward move at 30-min horizon\n')
        lines.append(show.to_string(index=False))

        # Multi-horizon view
        lines.append('\n### Absolute forward move by horizon (median, pts)\n')
        for label in ['abs_ct_above', 'abs_ct_below', 'abs_deep_neg_above',
                       'abs_top_decile_mag', 'abs_all_events']:
            row = df_b4[df_b4['label'] == label]
            if not row.empty:
                summary = ' | '.join([
                    f'{int(r["horizon_min"])}m: med_ev={r["event_median"]:.2f} '
                    f'vs ctl={r["control_median"]:.2f} (p={r["mw_p"]:.4f}, '
                    f'd={r["cohens_d"]:+.2f}, sig={"Y" if r["sig_fdr"] else "n"})'
                    for _, r in row.iterrows()
                ])
                lines.append(f'  {label}: {summary}')

    # B1 (magnet)
    lines.append('\n## B1 (magnet): does spot move TOWARD event strike?\n')
    lines.append('closed_pct = (|dist_T| - |dist_T+h|) / |dist_T|.')
    lines.append('Positive median => spot moved toward strike. Zero => no effect.\n')
    for cls_name, mask in [
        ('all', None),
        ('CT', magnet_df['is_counter_trend']),
        ('CT above', magnet_df['is_counter_trend'] & (magnet_df['event_otm_dir'] == 'above')),
        ('CT below', magnet_df['is_counter_trend'] & (magnet_df['event_otm_dir'] == 'below')),
        ('deep_neg above', magnet_df['deepened_negative'] & (magnet_df['event_otm_dir'] == 'above')),
        ('deep_neg below', magnet_df['deepened_negative'] & (magnet_df['event_otm_dir'] == 'below')),
    ]:
        sub = magnet_df if mask is None else magnet_df[mask]
        if len(sub) < 5:
            continue
        bits = []
        for h in HORIZONS_MIN:
            col = f'closed_pct_{h}m'
            s = sub[col].dropna()
            if len(s) >= 5:
                # 1-sample Wilcoxon vs 0 (median test)
                try:
                    _, p = stats.wilcoxon(s, alternative='two-sided')
                except ValueError:
                    p = float('nan')
                bits.append(f'{h}m: median={s.median():+.3f}, mean={s.mean():+.3f}, '
                            f'n={len(s)}, p={p:.4f}')
        lines.append(f'  {cls_name}: ' + ' | '.join(bits))

    out_path.write_text('\n'.join(lines))


# --------------------------- DRIVER ---------------------------------------


def main() -> None:
    print('Loading events + controls...')
    events = pd.read_csv(OUT / 'events.csv')
    control = pd.read_csv(OUT / 'control.csv')
    print(f'  events: {len(events):,}, controls: {len(control):,}')

    print('Loading SPX 1-min closes for all 26 days...')
    spot = load_spot_all_days()
    print(f'  spot bars: {len(spot):,}')

    print('Augmenting events with forward spot returns...')
    events = augment_with_forward_returns(events, 'captured_at', spot)
    print('Augmenting controls...')
    control = augment_with_forward_returns(control, 'captured_at', spot)
    events.to_csv(OUT / 'hypothesis_B_events.csv', index=False)
    control.to_csv(OUT / 'hypothesis_B_control.csv', index=False)

    # Drop ATM events (sign / direction ambiguous)
    events_nonatm = events[events['event_otm_dir'] != 'ATM'].copy()

    print('Running B3 (direction)...')
    b3 = run_b3_directional(events_nonatm, control)
    print(f'  {len(b3)} comparisons')

    print('Running B4 (vol expansion)...')
    b4 = run_b4_magnitude(events_nonatm, control)
    print(f'  {len(b4)} comparisons')

    print('Computing B1 (magnet) data...')
    magnet_df = run_b1_magnet(events_nonatm)
    magnet_df.to_csv(OUT / 'hypothesis_B_magnet.csv', index=False)
    print(f'  {len(magnet_df)} magnet rows')

    pd.DataFrame(b3 + b4).to_csv(OUT / 'hypothesis_B_tests.csv', index=False)

    print('Plotting...')
    plot_b3_distributions(events_nonatm, control, PLOTS / 'B_03_direction_boxplot.png')
    plot_b4_volexp(events_nonatm, control, PLOTS / 'B_04_volexp_density.png')
    plot_b1_magnet(magnet_df, PLOTS / 'B_01_magnet.png')

    print('Writing findings...')
    write_findings(b3, b4, magnet_df, OUT / 'hypothesis_B_findings.md')
    print(f'\nOutputs -> {OUT}/')


if __name__ == '__main__':
    main()
