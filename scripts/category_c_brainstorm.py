#!/usr/bin/env python3
"""
Category C — Post-Event Confirmation Signals (2026-05-21)
=========================================================

Tests 3 confirmation patterns for the v4 down-wick gamma-node rejection
events. The trade idea: don't enter at the wick (real-time un-detectable);
wait 1-10 min for a confirmation pattern, then enter at the confirming
bar's close. You sacrifice some of the early bounce in exchange for a
cleaner setup.

C1. Bullish engulfing / hold-above:
    If ANY of bars T+1, T+2, T+3 closes > event bar's HIGH → confirmed.
    Entry anchor: T+1 close. Forward window: T+1 → T+1+30min.

C2. Volume contraction (5 bars post-wick):
    mean_vol(T+1..T+5) / mean_vol(T-5..T-1) < 0.7 → confirmed.
    Entry anchor: T+5 close. Forward window: T+5 → T+5+30min.

C3. Higher-low within 10 min:
    If ANY low in T+5..T+10 > event bar's LOW + 1pt → confirmed.
    Entry anchor: T+10 close. Forward window: T+10 → T+10+30min.

Methodology:
- Down-wick events only (sell-side gamma rejection, the validated pocket).
- Direction-adjusted return: positive = price moved AWAY from wicked node
  (i.e., back UP for a down-wick, since the trader entered long).
  For down-wick: ret = end_close - anchor_close (price went up = win).
- Control anchor = v4 control_ts + same offset. Forward window from there.
- Each confirmation creates two groups: confirmed vs non-confirmed. Both
  groups are compared against their respective controls (the matched
  control rows from v4 also shifted by the same offset).
- Walk-forward: same equal-n split-by-event-order as
  walkforward_gamma_node_rejection.py.

Inputs:
  - docs/tmp/forensic-multi-day/gamma_node_rejection_2026-05-20_v4-vol-crush.csv
  - index_candles_1m (SPX, market_time='r')

Outputs:
  - docs/tmp/forensic-multi-day/category_c_brainstorm_findings.md
"""

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

load_dotenv('.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']
OUT = Path('docs/tmp/forensic-multi-day')
CSV_PATH = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
MD_PATH = OUT / 'category_c_brainstorm_findings.md'

FORWARD_MIN = 30  # forward window from anchor
VOL_CONFIRM_RATIO = 0.7
HIGHER_LOW_OFFSET_PTS = 1.0


# ============================================================
# DB + candle loading
# ============================================================

def load_candles(start_date, end_date):
    """Load 1-min SPX RTH candles bracketing the event window."""
    conn = psycopg2.connect(DB_URL)
    try:
        q = """
            SELECT timestamp, open, high, low, close, volume, date
            FROM index_candles_1m
            WHERE symbol = 'SPX'
              AND market_time = 'r'
              AND date BETWEEN %s AND %s
            ORDER BY timestamp
        """
        with conn.cursor() as cur:
            cur.execute(q, (start_date, end_date))
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
    finally:
        conn.close()
    df = pd.DataFrame(rows, columns=cols)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for col in ('open', 'high', 'low', 'close', 'volume'):
        df[col] = df[col].astype(float)
    df = df.set_index('timestamp').sort_index()
    return df


# ============================================================
# Bar helpers (work off a candles DataFrame indexed by UTC ts)
# ============================================================

def get_bar(candles, ts):
    """Return the bar at ts, or None if missing."""
    if ts in candles.index:
        return candles.loc[ts]
    return None


def bars_in_range(candles, start_ts, end_ts):
    """Return bars where start_ts <= timestamp <= end_ts (inclusive)."""
    mask = (candles.index >= start_ts) & (candles.index <= end_ts)
    return candles[mask]


def close_at_offset(candles, anchor_ts, offset_min):
    """Close of bar at anchor_ts + offset_min. None if no bar at that ts."""
    target = anchor_ts + pd.Timedelta(minutes=offset_min)
    bar = get_bar(candles, target)
    if bar is None:
        return None
    return float(bar['close'])


def end_close_within(candles, start_ts, end_ts):
    """Last close in (start_ts, end_ts]. None if no bars."""
    fwd = bars_in_range(candles, start_ts + pd.Timedelta(minutes=1), end_ts)
    if fwd.empty:
        return None
    return float(fwd.iloc[-1]['close'])


# ============================================================
# Confirmation tag computers
# ============================================================

def c1_confirm(candles, event_ts, event_high):
    """C1: any of T+1..T+3 closes > event bar's HIGH?

    Returns (confirmed: bool, anchor_close: float|None) where anchor_close
    is bar T+1's close (entry point regardless of confirmation — we use
    the same anchor for both confirmed and non-confirmed so the only
    thing varying is the confirmation tag).
    """
    confirmed = False
    for off in (1, 2, 3):
        bar = get_bar(candles, event_ts + pd.Timedelta(minutes=off))
        if bar is not None and float(bar['close']) > event_high:
            confirmed = True
            break
    anchor_close = close_at_offset(candles, event_ts, 1)
    return confirmed, anchor_close


def c2_confirm(candles, event_ts):
    """C2: mean(vol T+1..T+5) / mean(vol T-5..T-1) < 0.7?

    Anchor = bar T+5's close.
    """
    pre = bars_in_range(candles,
                        event_ts - pd.Timedelta(minutes=5),
                        event_ts - pd.Timedelta(minutes=1))
    post = bars_in_range(candles,
                         event_ts + pd.Timedelta(minutes=1),
                         event_ts + pd.Timedelta(minutes=5))
    if len(pre) < 3 or len(post) < 3:
        return None, None  # not enough data to compute ratio
    pre_vol = pre['volume'].mean()
    post_vol = post['volume'].mean()
    if pre_vol <= 0:
        return None, None
    ratio = post_vol / pre_vol
    confirmed = ratio < VOL_CONFIRM_RATIO
    anchor_close = close_at_offset(candles, event_ts, 5)
    return confirmed, anchor_close


def c3_confirm(candles, event_ts, event_low):
    """C3: any low in T+5..T+10 > event_low + 1pt?

    Anchor = bar T+10's close.
    """
    window = bars_in_range(candles,
                           event_ts + pd.Timedelta(minutes=5),
                           event_ts + pd.Timedelta(minutes=10))
    if window.empty:
        return None, None
    confirmed = bool((window['low'] > event_low + HIGHER_LOW_OFFSET_PTS).any())
    anchor_close = close_at_offset(candles, event_ts, 10)
    return confirmed, anchor_close


# ============================================================
# Forward returns from new anchor (down-wick: positive = price up)
# ============================================================

def fwd_ret_from_anchor(candles, anchor_ts, anchor_close, offset_min,
                        direction):
    """Direction-adjusted forward return from anchor_ts over
    FORWARD_MIN minutes.

    anchor_ts = event_ts + offset_min (or control_ts + offset_min for
    controls). anchor_close = close of that bar. We then look at the bar
    at anchor_ts + FORWARD_MIN.

    For down-wick: positive = end_close > anchor_close (price moved up).
    For up-wick: positive = anchor_close > end_close (price moved down).
    """
    if anchor_close is None:
        return None
    end_ts = anchor_ts + pd.Timedelta(minutes=FORWARD_MIN)
    end_close = end_close_within(candles, anchor_ts, end_ts)
    if end_close is None:
        return None
    if direction == 'down':
        return end_close - anchor_close
    return anchor_close - end_close


# ============================================================
# Build the enriched per-event table
# ============================================================

def build_rows(events_df, candles):
    """For each down-wick event, compute all 3 confirmations + new
    anchored forward returns (event AND control)."""
    rows = []
    for _, ev in events_df.iterrows():
        ev_ts = ev['event_ts']
        ctrl_ts = ev['control_ts']
        ev_bar = get_bar(candles, ev_ts)
        if ev_bar is None:
            continue
        # C1
        c1_flag, c1_anchor = c1_confirm(candles, ev_ts, float(ev['bar_high']))
        c1_ret = fwd_ret_from_anchor(candles,
                                     ev_ts + pd.Timedelta(minutes=1),
                                     c1_anchor, 1, 'down')
        c1_ctrl_anchor = (close_at_offset(candles, ctrl_ts, 1)
                          if pd.notna(ctrl_ts) else None)
        c1_ctrl_ret = fwd_ret_from_anchor(candles,
                                          ctrl_ts + pd.Timedelta(minutes=1)
                                          if pd.notna(ctrl_ts) else None,
                                          c1_ctrl_anchor, 1, 'down') \
            if pd.notna(ctrl_ts) else None
        # C2
        c2_flag, c2_anchor = c2_confirm(candles, ev_ts)
        c2_ret = fwd_ret_from_anchor(candles,
                                     ev_ts + pd.Timedelta(minutes=5),
                                     c2_anchor, 5, 'down')
        c2_ctrl_anchor = (close_at_offset(candles, ctrl_ts, 5)
                          if pd.notna(ctrl_ts) else None)
        c2_ctrl_ret = fwd_ret_from_anchor(candles,
                                          ctrl_ts + pd.Timedelta(minutes=5)
                                          if pd.notna(ctrl_ts) else None,
                                          c2_ctrl_anchor, 5, 'down') \
            if pd.notna(ctrl_ts) else None
        # C3
        c3_flag, c3_anchor = c3_confirm(candles, ev_ts, float(ev['bar_low']))
        c3_ret = fwd_ret_from_anchor(candles,
                                     ev_ts + pd.Timedelta(minutes=10),
                                     c3_anchor, 10, 'down')
        c3_ctrl_anchor = (close_at_offset(candles, ctrl_ts, 10)
                          if pd.notna(ctrl_ts) else None)
        c3_ctrl_ret = fwd_ret_from_anchor(candles,
                                          ctrl_ts + pd.Timedelta(minutes=10)
                                          if pd.notna(ctrl_ts) else None,
                                          c3_ctrl_anchor, 10, 'down') \
            if pd.notna(ctrl_ts) else None

        rows.append({
            'event_ts': ev_ts,
            'event_date': ev_ts.date(),
            'control_ts': ctrl_ts,
            'node_strike': ev['node_strike'],
            'node_gex': ev['node_gex'],
            'abs_gex': abs(float(ev['node_gex'])),
            'bar_low': ev['bar_low'],
            'bar_high': ev['bar_high'],
            # C1
            'c1_confirmed': c1_flag,
            'c1_ret_30m': c1_ret,
            'c1_ctrl_ret_30m': c1_ctrl_ret,
            # C2
            'c2_confirmed': c2_flag,
            'c2_ret_30m': c2_ret,
            'c2_ctrl_ret_30m': c2_ctrl_ret,
            # C3
            'c3_confirmed': c3_flag,
            'c3_ret_30m': c3_ret,
            'c3_ctrl_ret_30m': c3_ctrl_ret,
        })
    return pd.DataFrame(rows)


# ============================================================
# Stats helpers
# ============================================================

def paired_stats(sub, ev_col, ctrl_col):
    """Paired t-test (event vs control) at +30m."""
    paired = sub[[ev_col, ctrl_col]].dropna()
    n = len(paired)
    if n < 5:
        return {'n': n, 'event': np.nan, 'control': np.nan,
                'delta': np.nan, 't': np.nan, 'p': np.nan}
    ev = paired[ev_col].mean()
    ct = paired[ctrl_col].mean()
    delta = ev - ct
    diffs = paired[ev_col] - paired[ctrl_col]
    t, p = stats.ttest_1samp(diffs, 0)
    return {'n': n, 'event': float(ev), 'control': float(ct),
            'delta': float(delta), 't': float(t), 'p': float(p)}


def split_h1_h2(df):
    """Equal-n event-order split (same as walkforward script)."""
    df_sorted = df.sort_values('event_ts').reset_index(drop=True)
    mid = len(df_sorted) // 2
    return df_sorted.iloc[:mid].copy(), df_sorted.iloc[mid:].copy()


def fmt_stats_row(label, r):
    if np.isnan(r['delta']):
        return f"| {label} | {r['n']} | n/a | n/a | n/a | n/a | n/a |"
    return (f"| {label} | {r['n']} | {r['event']:+.2f} "
            f"| {r['control']:+.2f} | {r['delta']:+.2f} "
            f"| {r['t']:+.2f} | {r['p']:.4f} |")


def hit_rate(sub, ev_col):
    """% of rows where event return > 0 (price moved correct direction)."""
    vals = sub[ev_col].dropna()
    if len(vals) == 0:
        return np.nan
    return float((vals > 0).mean())


# ============================================================
# Report writer
# ============================================================

def section(label, df, ev_col, ctrl_col, flag_col, lines):
    """Write a full confirmation section to lines."""
    lines.append(f'## {label}\n\n')

    coverage = df[flag_col].notna().sum()
    lines.append(f'- Total down-wick events: {len(df)}\n')
    lines.append(f'- Events with computable confirmation flag: {coverage}\n')

    valid = df[df[flag_col].notna()].copy()
    confirmed = valid[valid[flag_col].astype(bool)]
    nonconfirmed = valid[~valid[flag_col].astype(bool)]
    lines.append(f'- Confirmed (signal present): {len(confirmed)}\n')
    lines.append(f'- Non-confirmed: {len(nonconfirmed)}\n\n')

    # Headline table — event vs control for each group
    lines.append('### Headline: event vs control (+30m from new anchor)\n\n')
    lines.append('| Group | n | Event | Control | Δ | t | p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
    all_r = paired_stats(valid, ev_col, ctrl_col)
    conf_r = paired_stats(confirmed, ev_col, ctrl_col)
    nonconf_r = paired_stats(nonconfirmed, ev_col, ctrl_col)
    lines.append(fmt_stats_row('All (valid)', all_r) + '\n')
    lines.append(fmt_stats_row('Confirmed', conf_r) + '\n')
    lines.append(fmt_stats_row('Non-confirmed', nonconf_r) + '\n\n')

    # Hit rate (directional accuracy)
    lines.append('### Hit rate (event ret > 0)\n\n')
    lines.append('| Group | n | Hit rate |\n|---|---:|---:|\n')
    lines.append(f"| All | {valid[ev_col].notna().sum()} "
                 f"| {hit_rate(valid, ev_col):.1%} |\n")
    lines.append(f"| Confirmed | {confirmed[ev_col].notna().sum()} "
                 f"| {hit_rate(confirmed, ev_col):.1%} |\n")
    lines.append(f"| Non-confirmed | {nonconfirmed[ev_col].notna().sum()} "
                 f"| {hit_rate(nonconfirmed, ev_col):.1%} |\n\n")

    # Walk-forward H1/H2 on the CONFIRMED set
    if len(confirmed) >= 20:
        h1, h2 = split_h1_h2(confirmed)
        r_h1 = paired_stats(h1, ev_col, ctrl_col)
        r_h2 = paired_stats(h2, ev_col, ctrl_col)
        lines.append('### Walk-forward (Confirmed only, equal-n split)\n\n')
        lines.append(f"- H1: {h1['event_date'].min()} → "
                     f"{h1['event_date'].max()} (n={len(h1)})\n")
        lines.append(f"- H2: {h2['event_date'].min()} → "
                     f"{h2['event_date'].max()} (n={len(h2)})\n\n")
        lines.append('| Half | n | Event | Control | Δ | t | p |\n')
        lines.append('|---|---:|---:|---:|---:|---:|---:|\n')
        lines.append(fmt_stats_row('H1', r_h1) + '\n')
        lines.append(fmt_stats_row('H2', r_h2) + '\n\n')

        h1_ok = (not np.isnan(r_h1['delta']) and r_h1['delta'] > 0
                 and r_h1['p'] < 0.10)
        h2_ok = (not np.isnan(r_h2['delta']) and r_h2['delta'] > 0
                 and r_h2['p'] < 0.10)
        verdict = 'PASS' if (h1_ok and h2_ok) else 'FAIL'
        lines.append(f'**Walk-forward verdict: {verdict}** '
                     f'(criterion: Δ>0 AND p<0.10 in both halves)\n\n')
    else:
        lines.append('### Walk-forward: SKIPPED — confirmed n < 20\n\n')

    # Baseline reference (v4 down-wick at original anchor)
    lines.append('### Reference: v4 baseline\n\n')
    lines.append('Compare against v4 down-wick at original (T+0) anchor: '
                 'n=295 Δ=+3.72 p=0.0018 (per `candle_pattern_findings.md`).\n\n')
    lines.append('---\n\n')


def main():
    print('Loading v4 master CSV...')
    df_v4 = pd.read_csv(CSV_PATH, parse_dates=['event_ts', 'control_ts'])
    down = df_v4[df_v4['direction'] == 'down'].copy()
    down['event_ts'] = pd.to_datetime(down['event_ts'], utc=True)
    down['control_ts'] = pd.to_datetime(down['control_ts'], utc=True)
    print(f'  {len(down):,} down-wick events')

    # Need candles covering events + 11 min forward + 30 min anchor window
    # i.e., event_ts + 41 min. Same for controls. Pad by 1 day on each side.
    earliest = min(down['event_ts'].min(), down['control_ts'].min())
    latest = max(down['event_ts'].max(), down['control_ts'].max())
    min_date = (earliest - pd.Timedelta(days=1)).date()
    max_date = (latest + pd.Timedelta(days=1)).date()
    print(f'Loading 1-min SPX candles {min_date} → {max_date}...')
    candles = load_candles(min_date, max_date)
    print(f'  {len(candles):,} bars loaded')

    print('Computing confirmations + anchored forward returns...')
    rows = build_rows(down, candles)
    print(f'  {len(rows):,} usable rows')

    # Persist intermediate table (optional debug aid)
    debug_csv = OUT / 'category_c_brainstorm.csv'
    rows.to_csv(debug_csv, index=False)
    print(f'  Debug CSV → {debug_csv}')

    # Write findings
    lines = []
    lines.append('# Category C — Post-Event Confirmation Signals\n\n')
    lines.append(f'Date: 2026-05-21 · Source: v4 down-wick events '
                 f'(n={len(down)}) · Forward window: 30 min from new '
                 f'anchor · Direction-adjusted return: positive = price '
                 f'moved UP (correct for down-wick rejection).\n\n')
    lines.append('Anchors:\n')
    lines.append('- **C1** entry at T+1 close → window T+1..T+31\n')
    lines.append('- **C2** entry at T+5 close → window T+5..T+35\n')
    lines.append('- **C3** entry at T+10 close → window T+10..T+40\n\n')
    lines.append('Controls: v4 `control_ts` shifted by the same offset.\n\n')
    lines.append('---\n\n')

    section('C1 — Bullish engulfing / hold-above (T+1..T+3 close > event high)',
            rows, 'c1_ret_30m', 'c1_ctrl_ret_30m', 'c1_confirmed', lines)
    section('C2 — Volume contraction (post/pre < 0.7 over 5 bars)',
            rows, 'c2_ret_30m', 'c2_ctrl_ret_30m', 'c2_confirmed', lines)
    section('C3 — Higher-low within 10 min (any low T+5..T+10 > event low + 1pt)',
            rows, 'c3_ret_30m', 'c3_ctrl_ret_30m', 'c3_confirmed', lines)

    # Summary table
    lines.append('## Summary table — all three confirmations\n\n')
    lines.append('| Test | Anchor | Conf n | Conf Δ | Conf p | Conf hit | '
                 'Non-conf n | Non-conf Δ | Non-conf p |\n')
    lines.append('|---|:--|---:|---:|---:|---:|---:|---:|---:|\n')
    for label, ev_col, ctrl_col, flag_col, anchor in (
        ('C1', 'c1_ret_30m', 'c1_ctrl_ret_30m', 'c1_confirmed', 'T+1'),
        ('C2', 'c2_ret_30m', 'c2_ctrl_ret_30m', 'c2_confirmed', 'T+5'),
        ('C3', 'c3_ret_30m', 'c3_ctrl_ret_30m', 'c3_confirmed', 'T+10'),
    ):
        valid = rows[rows[flag_col].notna()].copy()
        conf = valid[valid[flag_col].astype(bool)]
        nonconf = valid[~valid[flag_col].astype(bool)]
        cr = paired_stats(conf, ev_col, ctrl_col)
        nr = paired_stats(nonconf, ev_col, ctrl_col)
        ch = hit_rate(conf, ev_col)
        ch_s = f"{ch:.1%}" if not np.isnan(ch) else 'n/a'

        def fmt(v, p=False):
            if np.isnan(v):
                return 'n/a'
            return f"{v:.4f}" if p else f"{v:+.2f}"

        lines.append(
            f"| {label} | {anchor} | {cr['n']} | {fmt(cr['delta'])} "
            f"| {fmt(cr['p'], p=True)} | {ch_s} "
            f"| {nr['n']} | {fmt(nr['delta'])} | {fmt(nr['p'], p=True)} |\n"
        )
    lines.append('\n')

    MD_PATH.write_text(''.join(lines))
    print(f'Wrote findings → {MD_PATH}')


if __name__ == '__main__':
    main()
