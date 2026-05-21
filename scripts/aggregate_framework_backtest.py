#!/usr/bin/env python3
"""
Aggregate Framework Backtest (2026-05-21)
==========================================

Composite strategy combining four validated signals discovered in the
2026-05-20/21 forensic study:

  1. PCS Monday pocket: Monday + |node_gex| <= 500k + down-wick rejection,
     gated by B1 ES basis Q4 (top-quartile dbasis = basis holding up) AND
     NOT a flat-gap day (|open_gap| < 0.1%).
  2. E1 up-breakthrough → long call (+gex node breakout + 3-bar hold).
  3. E5 failed reversal → long put (v4 down-wick that fails and breaks 1pt
     below the wick low within 10 min).
  4. (Filter only) B1 Q4 ES basis hold is required for PCS.

D3 flat-gap (<0.1%) acts as an EXCLUSION on the PCS leg only.

The decision tree (per unique event_ts):
  - If failed-reversal confirmation triggers within 10 min → LONG PUT (E5)
  - Else if up-breakthrough fires same minute → LONG CALL (E1)
  - Else if down-wick + Monday + small gex + Q4 basis + non-flat gap → PCS
  - Else: skip

Outputs:
  - docs/tmp/forensic-multi-day/aggregate_framework_findings.md
  - docs/tmp/forensic-multi-day/aggregate_framework_trades.csv

Stats: total trades, trades/month, mean event return, mean (event - control)
delta, per-type win rate, walk-forward (chronological halves), drawdown
(longest losing streak) per trade type.

Run: ml/.venv/bin/python scripts/aggregate_framework_backtest.py
"""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from scipy import stats

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / '.env.local')
DB_URL = os.environ['DATABASE_URL_UNPOOLED']

OUT = ROOT / 'docs/tmp/forensic-multi-day'
V4_CSV = OUT / 'gamma_node_rejection_2026-05-20_v4-vol-crush.csv'
E1_CSV = OUT / 'category_e_e1_breakthroughs.csv'
E5_CSV = OUT / 'category_e_e5_failed_reversal.csv'
TRADES_OUT = OUT / 'aggregate_framework_trades.csv'
MD_OUT = OUT / 'aggregate_framework_findings.md'

GEX_FLOOR_K = 500.0  # |node_gex| <= 500k -> chop pocket
FLAT_GAP_THRESHOLD = 0.001  # |open_gap| < 0.1% = flat (PCS exclusion)
HORIZONS_MIN = [15, 30, 60]
LATEST_EVENT_CT_MINUTES = 14 * 60  # 14:00 CT cutoff
LOOKBACK_PERISCOPE_MIN = 10


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def query_df(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params or ())
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def load_spx_candles(conn):
    q = """
        SELECT timestamp, open, high, low, close, date
        FROM index_candles_1m
        WHERE symbol = 'SPX' AND market_time = 'r'
          AND date >= (
            SELECT (MIN(captured_at) AT TIME ZONE 'UTC')::date
            FROM periscope_snapshots
          )
        ORDER BY timestamp
    """
    df = query_df(conn, q)
    df['timestamp'] = pd.to_datetime(df['timestamp'], utc=True)
    for c in ('open', 'high', 'low', 'close'):
        df[c] = df[c].astype(float)
    df['range'] = df['high'] - df['low']
    return df


def load_es_minute_close(conn):
    """ES front-month close per minute UTC, keyed by ts."""
    q = "SELECT ts, close FROM futures_bars WHERE symbol='ES' ORDER BY ts"
    df = query_df(conn, q)
    if df.empty:
        return {}
    df['ts'] = pd.to_datetime(df['ts'], utc=True)
    return {row.ts: float(row.close) for row in df.itertuples()}


# ---------------------------------------------------------------------------
# Compute daily SPX open gap (for D3 flat-gap exclusion)
# ---------------------------------------------------------------------------

def compute_daily_gaps(candles: pd.DataFrame) -> dict:
    """Return {date -> open_gap_pct} where open_gap = day_open / prev_close - 1."""
    candles = candles.sort_values('timestamp').copy()
    candles['date'] = pd.to_datetime(candles['date'])
    daily = candles.groupby('date').agg(
        day_open=('open', 'first'),
        day_close=('close', 'last'),
    ).reset_index()
    daily = daily.sort_values('date').reset_index(drop=True)
    daily['prev_close'] = daily['day_close'].shift(1)
    daily['open_gap'] = daily['day_open'] / daily['prev_close'] - 1
    return {row.date.date(): float(row.open_gap)
            for row in daily.itertuples()
            if pd.notna(row.open_gap)}


# ---------------------------------------------------------------------------
# Compute B1 ES basis delta per event_ts (5-min window into wick)
# ---------------------------------------------------------------------------

def compute_basis_delta(event_min_set: set, es_close: dict,
                         spx_close: dict) -> dict:
    """For each event_min, basis_t0 - basis_t5b. NaN if either side missing."""
    out = {}
    for ts in event_min_set:
        ts5b = ts - pd.Timedelta(minutes=5)
        es0 = es_close.get(ts)
        es5 = es_close.get(ts5b)
        sp0 = spx_close.get(ts)
        sp5 = spx_close.get(ts5b)
        if any(v is None or pd.isna(v) for v in (es0, es5, sp0, sp5)):
            out[ts] = np.nan
            continue
        basis0 = es0 - sp0
        basis5b = es5 - sp5
        out[ts] = basis0 - basis5b
    return out


# ---------------------------------------------------------------------------
# Control returns for an arbitrary trade (uses same-day non-event bar)
# ---------------------------------------------------------------------------

def build_controls(candles: pd.DataFrame, event_ts_set: set,
                    range_threshold: float, seed: int = 42) -> dict:
    in_band = candles[candles['range'] >= range_threshold].copy()
    ct = in_band['timestamp'].dt.tz_convert('America/Chicago')
    minutes = ct.dt.hour * 60 + ct.dt.minute
    in_band = in_band[(minutes < LATEST_EVENT_CT_MINUTES)
                      & (~in_band['timestamp'].isin(event_ts_set))].copy()
    in_band['ct_date'] = in_band['timestamp'].dt.tz_convert(
        'America/Chicago').dt.date

    rng = np.random.default_rng(seed)
    out = {}
    for ev_ts in event_ts_set:
        ev_date = ev_ts.tz_convert('America/Chicago').date()
        pool = in_band[in_band['ct_date'] == ev_date]
        if pool.empty:
            continue
        idx = int(rng.integers(0, len(pool)))
        out[ev_ts] = pool.iloc[idx]
    return out


def control_forward_signed(ts_to_idx: dict, candles_sorted: pd.DataFrame,
                            ctrl_ts: pd.Timestamp, ctrl_close: float,
                            trade_type: str) -> dict:
    """Forward returns from a control bar, signed in the trade-type's
    profit direction.

    trade_type 'pcs'       → positive return = price moved AWAY from wicked
                              node (use direction-adjusted sign — encoded as
                              "down-wick wants up move").
    trade_type 'long_call' → positive return = price up.
    trade_type 'long_put'  → positive return = price down.
    """
    out = {}
    idx = ts_to_idx.get(ctrl_ts)
    if idx is None:
        return {f'control_ret_{h}m': np.nan for h in HORIZONS_MIN}
    for h in HORIZONS_MIN:
        ti = idx + h
        if ti >= len(candles_sorted):
            out[f'control_ret_{h}m'] = np.nan
            continue
        end_close = candles_sorted.iloc[ti]['close']
        delta = end_close - ctrl_close
        # PCS down-wick: positive ret = bounce up (price up)
        # PCS up-wick:   positive ret = fade down (price down) — handled
        #                via direction column in caller.
        # long_call → +delta; long_put → -delta; pcs handled separately.
        if trade_type == 'long_call':
            out[f'control_ret_{h}m'] = delta
        elif trade_type == 'long_put':
            out[f'control_ret_{h}m'] = -delta
        else:
            # pcs returns are direction-adjusted by caller (passes its own
            # sign via the dict key).
            out[f'control_ret_{h}m'] = delta
    return out


# ---------------------------------------------------------------------------
# Main composite build
# ---------------------------------------------------------------------------

def main():
    print('Loading master v4 CSV...')
    v4 = pd.read_csv(V4_CSV)
    v4['event_ts'] = pd.to_datetime(v4['event_ts'], utc=True)
    v4['control_ts'] = pd.to_datetime(v4['control_ts'], utc=True)
    print(f'  v4 rows: {len(v4):,} ({(v4.direction=="down").sum()} down, '
          f'{(v4.direction=="up").sum()} up)')

    print('Loading E1 breakthroughs CSV...')
    e1 = pd.read_csv(E1_CSV)
    e1['event_ts'] = pd.to_datetime(e1['event_ts'], utc=True)
    e1['control_ts'] = pd.to_datetime(e1['control_ts'], utc=True)
    print(f'  E1 rows: {len(e1):,} ({(e1.direction=="up").sum()} up, '
          f'{(e1.direction=="down").sum()} down)')

    print('Loading E5 failed-reversal CSV...')
    e5 = pd.read_csv(E5_CSV)
    e5['event_ts'] = pd.to_datetime(e5['event_ts'], utc=True)
    e5['confirm_ts'] = pd.to_datetime(e5['confirm_ts'], utc=True)
    print(f'  E5 rows: {len(e5):,}')

    print('Connecting to DB for SPX candles, ES futures, gap calc...')
    conn = psycopg2.connect(DB_URL)
    try:
        candles = load_spx_candles(conn)
        es_close = load_es_minute_close(conn)
    finally:
        conn.close()
    print(f'  SPX candles: {len(candles):,}, ES minutes: {len(es_close):,}')

    # SPX close lookup
    spx_close = {row.timestamp: float(row.close)
                 for row in candles.itertuples()}

    # Daily gap
    daily_gaps = compute_daily_gaps(candles)
    print(f'  Daily gaps computed: {len(daily_gaps):,} sessions')

    # Index helpers for control returns
    candles_sorted = candles.sort_values('timestamp').reset_index(drop=True)
    ts_to_idx = {ts: i for i, ts in enumerate(candles_sorted['timestamp'])}

    # ------------------------------------------------------------------
    # E5: rebuild controls for failed-reversal CSV (it lacks them today)
    # ------------------------------------------------------------------
    print('\n[E5] Rebuilding controls for failed-reversal events...')
    p75_range = float(np.percentile(candles['range'], 75))
    e5_confirm_ts_set = set(pd.to_datetime(e5['confirm_ts'], utc=True))
    e5_controls = build_controls(candles, e5_confirm_ts_set, p75_range, seed=42)
    print(f'  E5 controls matched: {len(e5_controls):,}/{len(e5):,}')
    for h in HORIZONS_MIN:
        e5[f'control_ret_{h}m'] = np.nan
    for i, row in e5.iterrows():
        ctrl = e5_controls.get(row['confirm_ts'])
        if ctrl is None:
            continue
        ctrl_metrics = control_forward_signed(
            ts_to_idx, candles_sorted, ctrl['timestamp'],
            float(ctrl['close']), 'long_put',
        )
        for h in HORIZONS_MIN:
            e5.at[i, f'control_ret_{h}m'] = ctrl_metrics[f'control_ret_{h}m']

    # ------------------------------------------------------------------
    # PCS filter: Monday + |gex|<=500 + down + B1 Q4 + NOT flat gap
    # ------------------------------------------------------------------
    print('\n[PCS] Building Monday pocket with B1 + D3 gating...')
    pcs_pool = v4[v4['direction'] == 'down'].copy()
    pcs_pool['event_min'] = pcs_pool['event_ts'].dt.floor('min')
    pcs_pool['weekday'] = pcs_pool['event_ts'].dt.dayofweek
    pcs_pool['abs_gex'] = pcs_pool['node_gex'].abs()
    pcs_pool['event_date'] = pcs_pool['event_ts'].dt.tz_convert(
        'America/Chicago').dt.date

    # Compute B1 dbasis on the full down-wick pool (for quartile cutoff
    # consistent with category_b_brainstorm Q4 result)
    print('  Computing B1 dbasis for full down-wick pool...')
    down_all_min = set(pcs_pool['event_min'])
    basis_map = compute_basis_delta(down_all_min, es_close, spx_close)
    pcs_pool['dbasis'] = pcs_pool['event_min'].map(basis_map)
    basis_valid = pcs_pool.dropna(subset=['dbasis'])
    if len(basis_valid) >= 4:
        # Q4 cutoff: top quartile = best (basis holding up)
        q75_cut = float(np.quantile(basis_valid['dbasis'], 0.75))
    else:
        q75_cut = np.nan
    pcs_pool['b1_q4'] = pcs_pool['dbasis'] >= q75_cut

    # D3 flat-gap exclusion
    pcs_pool['open_gap'] = pcs_pool['event_date'].map(daily_gaps)
    pcs_pool['flat_gap'] = pcs_pool['open_gap'].abs() < FLAT_GAP_THRESHOLD

    # Apply Monday + low-gex pocket
    pcs_pool['monday_lowgex'] = (
        (pcs_pool['weekday'] == 0) & (pcs_pool['abs_gex'] <= GEX_FLOOR_K)
    )

    pcs_qualified = pcs_pool[
        pcs_pool['monday_lowgex']
        & pcs_pool['b1_q4']
        & (~pcs_pool['flat_gap'])
    ].copy()
    print(f'  Monday + |gex|<=500: {pcs_pool["monday_lowgex"].sum()}')
    print(f'  After B1 Q4 gate:    {(pcs_pool["monday_lowgex"] & pcs_pool["b1_q4"]).sum()}')
    print(f'  After NOT flat gap:  {len(pcs_qualified)}')

    # ------------------------------------------------------------------
    # Decision-tree priority:
    #   1. E5 failed-reversal (long put) — anchored on confirm_ts
    #   2. E1 up-breakthrough (long call) — anchored on bar that broke +γ
    #   3. PCS qualified — anchored on the wick bar
    # E5 and PCS can share an event_ts (E5 is a v4 down-wick that failed):
    # if the same event_ts qualifies for both, prefer E5 since the
    # failed-bounce trigger overrides the bounce thesis.
    # ------------------------------------------------------------------
    print('\n[Composite] Assembling trades with decision tree...')
    trades = []

    # E5 trades: dedupe by confirm_ts (one trade per confirmation bar)
    e5_used_event_ts = set()
    for _, r in e5.iterrows():
        if r['confirm_ts'] in e5_used_event_ts:
            continue
        e5_used_event_ts.add(r['confirm_ts'])
        trades.append({
            'trade_type': 'long_put_e5',
            'anchor_ts': r['confirm_ts'],
            'origin_event_ts': r['event_ts'],
            'entry_close': float(r['confirm_close']),
            'ret_15m': r.get('ret_15m', np.nan),
            'ret_30m': r.get('ret_30m', np.nan),
            'ret_60m': r.get('ret_60m', np.nan),
            'control_ret_15m': r.get('control_ret_15m', np.nan),
            'control_ret_30m': r.get('control_ret_30m', np.nan),
            'control_ret_60m': r.get('control_ret_60m', np.nan),
        })
    print(f'  E5 trades: {len(trades)}')

    # E1 trades: include only up-breakthrough (long call) to match validated
    # walk-forward signal. Skip down-breakthroughs (E1 down was unstable).
    e1_used_anchor_ts = set()
    e1_count_before = len(trades)
    e1_up = e1[e1['direction'] == 'up'].copy()
    for _, r in e1_up.iterrows():
        # Avoid double-trading if E5 already took this anchor (unlikely; E5
        # anchors on confirm_ts after a down-wick, E1 anchors on a bar that
        # closed above a node — orthogonal).
        if r['event_ts'] in e1_used_anchor_ts:
            continue
        e1_used_anchor_ts.add(r['event_ts'])
        trades.append({
            'trade_type': 'long_call_e1',
            'anchor_ts': r['event_ts'],
            'origin_event_ts': r['event_ts'],
            'entry_close': float(r['bar_close']),
            'ret_15m': r.get('ret_15m', np.nan),
            'ret_30m': r.get('ret_30m', np.nan),
            'ret_60m': r.get('ret_60m', np.nan),
            'control_ret_15m': r.get('control_ret_15m', np.nan),
            'control_ret_30m': r.get('control_ret_30m', np.nan),
            'control_ret_60m': r.get('control_ret_60m', np.nan),
        })
    print(f'  E1 trades (up only): {len(trades) - e1_count_before}')

    # PCS trades: skip events that also became E5 (same origin event_ts)
    pcs_origin_blocked = set(pd.to_datetime(e5['event_ts'], utc=True))
    pcs_count_before = len(trades)
    for _, r in pcs_qualified.iterrows():
        if r['event_ts'] in pcs_origin_blocked:
            continue
        trades.append({
            'trade_type': 'pcs_monday',
            'anchor_ts': r['event_ts'],
            'origin_event_ts': r['event_ts'],
            'entry_close': float(r['bar_close']),
            # PCS direction-adjusted returns are already in v4 CSV: down-wick
            # positive ret = bounce away from pierced node (PCS profit).
            'ret_15m': r.get('ret_15m', np.nan),
            'ret_30m': r.get('ret_30m', np.nan),
            'ret_60m': r.get('ret_60m', np.nan),
            'control_ret_15m': r.get('control_ret_15m', np.nan),
            'control_ret_30m': r.get('control_ret_30m', np.nan),
            'control_ret_60m': r.get('control_ret_60m', np.nan),
        })
    print(f'  PCS trades: {len(trades) - pcs_count_before}')

    trades_df = pd.DataFrame(trades)
    trades_df = trades_df.sort_values('anchor_ts').reset_index(drop=True)
    trades_df.to_csv(TRADES_OUT, index=False)
    print(f'\nWrote {TRADES_OUT} ({len(trades_df):,} rows)')

    # ------------------------------------------------------------------
    # Composite statistics
    # ------------------------------------------------------------------
    write_findings(trades_df)


# ---------------------------------------------------------------------------
# Stats + findings
# ---------------------------------------------------------------------------

def per_type_stats(sub: pd.DataFrame) -> dict:
    paired = sub.dropna(subset=['ret_30m', 'control_ret_30m'])
    n = len(sub)
    n_paired = len(paired)
    if n == 0:
        return {'n': 0}
    out = {
        'n': n,
        'n_paired': n_paired,
        'event_mean_30m': float(sub['ret_30m'].mean()),
        'win_rate_30m': float((sub['ret_30m'] > 0).mean()),
    }
    if n_paired >= 5:
        ev_mean = float(paired['ret_30m'].mean())
        ct_mean = float(paired['control_ret_30m'].mean())
        delta = ev_mean - ct_mean
        diffs = paired['ret_30m'] - paired['control_ret_30m']
        t_stat, p = stats.ttest_1samp(diffs, 0)
        out.update({
            'paired_event_mean': ev_mean,
            'paired_ctrl_mean': ct_mean,
            'delta': delta,
            't': float(t_stat),
            'p': float(p),
        })
    return out


def walk_forward(sub: pd.DataFrame) -> dict:
    s = sub.sort_values('anchor_ts').reset_index(drop=True)
    if len(s) < 10:
        return {'note': f'n={len(s)} too small'}
    mid = len(s) // 2
    h1 = per_type_stats(s.iloc[:mid])
    h2 = per_type_stats(s.iloc[mid:])
    return {'h1': h1, 'h2': h2}


def longest_losing_streak(sub: pd.DataFrame) -> int:
    """Longest consecutive run of ret_30m <= 0 in chronological order."""
    s = sub.sort_values('anchor_ts').reset_index(drop=True)
    rets = s['ret_30m'].fillna(0)
    longest = 0
    cur = 0
    for r in rets:
        if r <= 0:
            cur += 1
            longest = max(longest, cur)
        else:
            cur = 0
    return longest


def fmt_pct(v):
    return f'{v:.1%}' if pd.notna(v) else 'n/a'


def fmt_float(v, sign=False):
    if pd.isna(v):
        return 'n/a'
    return f'{v:+.2f}' if sign else f'{v:.2f}'


def write_findings(trades: pd.DataFrame):
    lines = []
    lines.append('# Aggregate Framework Backtest (2026-05-21)\n\n')
    lines.append('Composite strategy combining four signals validated in '
                 'the 2026-05-20/21 forensic study. Per-trade decision '
                 'tree:\n\n')
    lines.append('1. **E5 long put** (failed-reversal confirmation) — '
                 'highest priority; overrides PCS on the same down-wick.\n')
    lines.append('2. **E1 long call** (up-breakthrough + 3-bar hold).\n')
    lines.append('3. **PCS Monday pocket** — down-wick + Monday + '
                 '|node_gex|≤500k, gated by B1 Q4 ES basis hold AND '
                 'excluding D3 flat-gap days (|open_gap|<0.1%).\n\n')

    # Coverage window
    if not trades.empty:
        first = trades['anchor_ts'].min()
        last = trades['anchor_ts'].max()
        cal_days = (last.date() - first.date()).days + 1
        months = cal_days / 30.0
        lines.append(f'**Sample window**: {first.date()} → {last.date()} '
                     f'({cal_days} cal days ≈ {months:.1f} months)\n\n')
    else:
        lines.append('**Sample is empty.**\n')
        MD_OUT.write_text(''.join(lines))
        return

    # -- Per-type table
    lines.append('## Per-trade-type performance (paired vs control @ +30m)\n\n')
    lines.append('| Type | n | win% | event 30m | ctrl 30m | Δ '
                 '| paired t / p |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---|\n')

    overall_rows = []
    type_order = ['pcs_monday', 'long_call_e1', 'long_put_e5']
    per_type_results = {}
    for t in type_order:
        sub = trades[trades['trade_type'] == t]
        st = per_type_stats(sub)
        per_type_results[t] = st
        if st.get('n', 0) == 0:
            lines.append(f'| {t} | 0 | n/a | n/a | n/a | n/a | n/a |\n')
            continue
        win = fmt_pct(st.get('win_rate_30m'))
        ev = fmt_float(st.get('event_mean_30m'), sign=True)
        if 'delta' in st:
            cm = fmt_float(st['paired_ctrl_mean'], sign=True)
            dl = fmt_float(st['delta'], sign=True)
            tp = f"t={st['t']:+.2f}, p={st['p']:.4f}"
        else:
            cm = dl = tp = 'n/a'
        lines.append(
            f'| {t} | {st["n"]} | {win} | {ev} | {cm} | {dl} | {tp} |\n'
        )
        overall_rows.append(sub)

    # -- Portfolio aggregate
    lines.append('\n## Portfolio aggregate (all trades pooled)\n\n')
    all_st = per_type_stats(trades)
    if not trades.empty:
        first = trades['anchor_ts'].min()
        last = trades['anchor_ts'].max()
        cal_days = (last.date() - first.date()).days + 1
        per_month = len(trades) * 30.0 / cal_days
    else:
        per_month = 0
    lines.append(f'- Total trades: **{len(trades):,}**\n')
    lines.append(f'- Trades / month rate: **{per_month:.1f}**\n')
    lines.append(f'- Pooled win% (ret_30m > 0): '
                 f'**{fmt_pct(all_st.get("win_rate_30m"))}**\n')
    lines.append(f'- Pooled mean event ret_30m: '
                 f'**{fmt_float(all_st.get("event_mean_30m"), sign=True)} pts**\n')
    if 'delta' in all_st:
        lines.append(f'- Pooled Δ vs control: '
                     f'**{fmt_float(all_st["delta"], sign=True)} pts** '
                     f'(t={all_st["t"]:+.2f}, p={all_st["p"]:.4f})\n')

    # -- Walk-forward
    lines.append('\n## Walk-forward (chronological halves) per trade type\n\n')
    lines.append('| Type | H1 n | H1 win% | H1 event | H1 Δ | H2 n | H2 win% '
                 '| H2 event | H2 Δ |\n')
    lines.append('|---|---:|---:|---:|---:|---:|---:|---:|---:|\n')
    for t in type_order:
        sub = trades[trades['trade_type'] == t]
        wf = walk_forward(sub)
        if 'note' in wf:
            lines.append(f'| {t} | {wf["note"]} | | | | | | | |\n')
            continue
        h1, h2 = wf['h1'], wf['h2']
        def cell(st, key, sign=False):
            v = st.get(key)
            if v is None or (isinstance(v, float) and pd.isna(v)):
                return 'n/a'
            if key == 'win_rate_30m':
                return fmt_pct(v)
            return fmt_float(v, sign=sign)
        lines.append(
            f'| {t} | {h1["n"]} | {cell(h1, "win_rate_30m")} '
            f'| {cell(h1, "event_mean_30m", True)} '
            f'| {cell(h1, "delta", True)} '
            f'| {h2["n"]} | {cell(h2, "win_rate_30m")} '
            f'| {cell(h2, "event_mean_30m", True)} '
            f'| {cell(h2, "delta", True)} |\n'
        )

    # -- Walk-forward composite
    lines.append('\n### Composite walk-forward (all types pooled)\n\n')
    comp_wf = walk_forward(trades)
    if 'note' not in comp_wf:
        h1, h2 = comp_wf['h1'], comp_wf['h2']
        for label, st in (('H1', h1), ('H2', h2)):
            lines.append(
                f'- **{label}**: n={st["n"]}, '
                f'win%={fmt_pct(st.get("win_rate_30m"))}, '
                f'event_mean={fmt_float(st.get("event_mean_30m"), True)}'
            )
            if 'delta' in st:
                lines.append(
                    f', Δ={fmt_float(st["delta"], True)} '
                    f'(t={st["t"]:+.2f}, p={st["p"]:.4f})'
                )
            lines.append('\n')

    # -- Drawdown
    lines.append('\n## Drawdown (longest consecutive losing streak @ +30m)\n\n')
    lines.append('| Type | n | longest losing streak |\n|---|---:|---:|\n')
    for t in type_order:
        sub = trades[trades['trade_type'] == t]
        if sub.empty:
            lines.append(f'| {t} | 0 | n/a |\n')
            continue
        streak = longest_losing_streak(sub)
        lines.append(f'| {t} | {len(sub)} | {streak} |\n')
    overall_streak = longest_losing_streak(trades)
    lines.append(f'| **composite** | {len(trades)} | {overall_streak} |\n')

    # -- Trade frequency by month
    lines.append('\n## Trade frequency by month\n\n')
    trades['anchor_month'] = trades['anchor_ts'].dt.tz_convert(
        'UTC').dt.tz_localize(None).dt.to_period('M')
    monthly = trades.groupby(['anchor_month', 'trade_type']).size().unstack(
        fill_value=0)
    lines.append('```\n' + monthly.to_string() + '\n```\n')

    # -- Verdict (data-driven recommendations)
    lines.append('\n## Verdict / recommendations\n\n')
    # Build a short interpretation
    bullet_lines = []
    for t in type_order:
        st = per_type_results[t]
        if st.get('n', 0) == 0:
            bullet_lines.append(f'- **{t}**: no trades fired — '
                                'check filter inputs.')
            continue
        delta = st.get('delta')
        win = st.get('win_rate_30m')
        wf = walk_forward(trades[trades['trade_type'] == t])
        if 'note' in wf:
            verdict = f'walk-forward inconclusive ({wf["note"]})'
        else:
            h2_delta = wf['h2'].get('delta')
            if h2_delta is None or pd.isna(h2_delta):
                verdict = 'H2 inconclusive'
            elif h2_delta > 0:
                verdict = f'H2 Δ={h2_delta:+.2f} HOLDS UP'
            else:
                verdict = f'H2 Δ={h2_delta:+.2f} BREAKS DOWN — consider DROP'
        bullet_lines.append(
            f'- **{t}**: n={st["n"]}, win%={fmt_pct(win)}, '
            f'Δ={fmt_float(delta, True)}, {verdict}'
        )
    lines.append('\n'.join(bullet_lines) + '\n')

    MD_OUT.write_text(''.join(lines))
    print(f'\nWrote findings → {MD_OUT}')


if __name__ == '__main__':
    main()
