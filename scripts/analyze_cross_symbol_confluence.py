#!/usr/bin/env python
"""Cross-symbol confluence analysis on interval_ba_alerts.

Finds time-windowed coincidences of Interval B/A alerts across SPY,
SPXW, and QQQ. The premise (per feedback_hunt_flow_in_spy_qqq): SPY
and QQQ often LEAD SPXW in informed-flow signatures — an ETF burst
followed by an SPXW burst within seconds is the leader-follower
pattern that hedging-driven flow rarely produces.

Two confluence definitions evaluated:

  2-way: ANY pair of distinct tickers fire same-direction (option_type
         CALL or PUT) within a window. Counts pairs.

  3-way: ALL three tickers (SPY + SPXW + QQQ) fire same-direction
         within a window. Counts unique 3-way events keyed on the
         earliest fired_at moment.

Output: docs/tmp/interval-ba-confluence-{stamp}.md with:
  - n events at each window width × confluence size
  - per-day distribution
  - sample 3-way events with timestamps + chains
  - SPY/QQQ → SPXW lead time distribution (median, P25, P75)

Usage:
    python3 scripts/analyze_cross_symbol_confluence.py [--window-sec 90]
"""

from __future__ import annotations

import argparse
import os
import pathlib
import re
import sys
from collections import defaultdict
from datetime import datetime

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'

TICKERS = ('SPY', 'SPXW', 'QQQ')


def load_env() -> None:
    if not ENV_FILE.exists():
        sys.exit(f'Missing env: {ENV_FILE}')
    with ENV_FILE.open() as f:
        for line in f:
            m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line.strip())
            if m:
                os.environ.setdefault(
                    m.group(1), m.group(2).strip('"').strip("'"),
                )


def fetch_alerts(conn) -> list[dict]:
    """All SPY/SPXW/QQQ alerts in fired_at order."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, ticker, option_chain, option_type,
                   fired_at, ratio_pct, total_premium, top_trade_premium
            FROM interval_ba_alerts
            WHERE ticker IN ('SPY', 'SPXW', 'QQQ')
              AND fired_at IS NOT NULL
            ORDER BY fired_at ASC
            """,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]


def find_confluence_events(
    alerts: list[dict],
    window_sec: int,
) -> tuple[list[dict], list[dict]]:
    """Two-pass sweep over chronologically sorted alerts.

    Returns:
      - 2way: list of (anchor_alert, partner_alerts_within_window_same_direction)
              where partners include only OTHER-ticker alerts.
      - 3way: subset of 2way events where the partner-set covers >=2
              other tickers (so the anchor + partners span all 3).
    """
    two_way: list[dict] = []
    three_way: list[dict] = []
    n = len(alerts)
    for i, anchor in enumerate(alerts):
        anchor_t = anchor['fired_at'].timestamp()
        same_dir_partners: list[dict] = []
        # Forward scan only — every confluence is anchored on its
        # earliest member, avoiding double-counting.
        for j in range(i + 1, n):
            other = alerts[j]
            if other['fired_at'].timestamp() - anchor_t > window_sec:
                break
            if other['option_type'] != anchor['option_type']:
                continue
            if other['ticker'] == anchor['ticker']:
                continue
            same_dir_partners.append(other)
        if same_dir_partners:
            event = {
                'anchor': anchor,
                'partners': same_dir_partners,
                'tickers': sorted({anchor['ticker'], *(p['ticker'] for p in same_dir_partners)}),
            }
            two_way.append(event)
            if len(event['tickers']) >= 3:
                three_way.append(event)
    return two_way, three_way


def median(xs: list[float]) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0


def quantile(xs: list[float], q: float) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def fmt_ts(ts: datetime) -> str:
    return ts.strftime('%Y-%m-%d %H:%M:%S CT')


def fmt_premium(n: float) -> str:
    if n >= 1_000_000:
        return f'${n/1_000_000:.2f}M'
    return f'${n/1_000:.0f}K'


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--window-sec',
        type=int,
        default=90,
        help='Confluence time window in seconds (default: %(default)s).',
    )
    parser.add_argument(
        '--also',
        type=str,
        default='60,180',
        help='Comma-separated additional windows for the counts table.',
    )
    args = parser.parse_args()

    load_env()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        alerts = fetch_alerts(conn)
    finally:
        conn.close()
    print(f'Loaded {len(alerts)} alerts across {sorted({a["ticker"] for a in alerts})}')

    # Counts by ticker
    by_ticker: dict[str, int] = defaultdict(int)
    for a in alerts:
        by_ticker[a['ticker']] += 1
    print('Per-ticker:', dict(by_ticker))

    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    md.append(f'# Cross-symbol confluence analysis ({stamp})\n')
    md.append(
        f'_Joined {len(alerts)} Interval B/A alerts across SPY / SPXW / '
        f'QQQ ({", ".join(f"{k}={v}" for k, v in sorted(by_ticker.items()))})._\n',
    )

    # Counts table: 2-way + 3-way at multiple window widths
    md.append('## 1. Confluence event counts by window width\n')
    md.append(
        '_2-way = anchor + ≥1 partner (other ticker, same direction) '
        'within window. 3-way = anchor + partners span all 3 tickers. '
        'Each event keyed on its earliest member, no double counting._\n',
    )
    md.append('| window | 2-way events | 3-way events |')
    md.append('|---|--:|--:|')
    windows = sorted({args.window_sec, *(int(w) for w in args.also.split(',') if w.strip())})
    primary_two: list[dict] = []
    primary_three: list[dict] = []
    for w in windows:
        two, three = find_confluence_events(alerts, w)
        md.append(f'| {w}s | {len(two):,} | {len(three):,} |')
        if w == args.window_sec:
            primary_two = two
            primary_three = three
    md.append('')
    md.append(f'_(Primary window: **{args.window_sec}s** — used for sections below.)_\n')

    # Direction split for the primary window
    md.append('## 2. Direction split at primary window\n')
    call_two = [e for e in primary_two if e['anchor']['option_type'] == 'C']
    put_two = [e for e in primary_two if e['anchor']['option_type'] == 'P']
    call_three = [e for e in primary_three if e['anchor']['option_type'] == 'C']
    put_three = [e for e in primary_three if e['anchor']['option_type'] == 'P']
    md.append('| direction | 2-way | 3-way |')
    md.append('|---|--:|--:|')
    md.append(f'| CALL (bullish) | {len(call_two):,} | {len(call_three):,} |')
    md.append(f'| PUT  (bearish) | {len(put_two):,} | {len(put_three):,} |')
    md.append('')

    # Per-day distribution
    md.append('## 3. Per-day 3-way confluence count (top 15)\n')
    by_day: dict[str, list[dict]] = defaultdict(list)
    for e in primary_three:
        d = e['anchor']['fired_at'].astimezone().date().isoformat()
        by_day[d].append(e)
    top_days = sorted(by_day.items(), key=lambda kv: len(kv[1]), reverse=True)[:15]
    md.append('| date | 3-way events | sample direction |')
    md.append('|---|--:|---|')
    for d, events in top_days:
        dirs = ', '.join(
            f"{sum(1 for e in events if e['anchor']['option_type']==t)} {t}"
            for t in ('C', 'P')
        )
        md.append(f'| {d} | {len(events)} | {dirs} |')
    md.append('')

    # Sample 3-way events
    md.append('## 4. Sample 3-way events (10 newest)\n')
    samples = sorted(
        primary_three,
        key=lambda e: e['anchor']['fired_at'],
        reverse=True,
    )[:10]
    for e in samples:
        anchor = e['anchor']
        partners = e['partners']
        md.append(
            f'**{fmt_ts(anchor["fired_at"])} — '
            f'{anchor["option_type"]} confluence ({"/".join(e["tickers"])})**',
        )
        md.append(
            f'  - anchor: {anchor["ticker"]} {anchor["option_chain"]} '
            f'ratio={float(anchor["ratio_pct"]):.0f}% '
            f'prem={fmt_premium(float(anchor["total_premium"]))}',
        )
        for p in partners:
            offset_s = (p['fired_at'] - anchor['fired_at']).total_seconds()
            md.append(
                f'  - +{offset_s:.1f}s: {p["ticker"]} {p["option_chain"]} '
                f'ratio={float(p["ratio_pct"]):.0f}% '
                f'prem={fmt_premium(float(p["total_premium"]))}',
            )
        md.append('')

    # Leader analysis: when 3-way fires, which ticker tends to lead?
    md.append('## 5. Leader-follower distribution in 3-way events\n')
    md.append(
        '_For every 3-way event, the **anchor** (earliest member) is '
        'the leader. Count how often each ticker is in that role._\n',
    )
    leader_counts: dict[str, int] = defaultdict(int)
    follower_lag: dict[str, list[float]] = defaultdict(list)
    for e in primary_three:
        leader_counts[e['anchor']['ticker']] += 1
        for p in e['partners']:
            lag_s = (p['fired_at'] - e['anchor']['fired_at']).total_seconds()
            follower_lag[p['ticker']].append(lag_s)
    md.append('| ticker | n_leader | n_follower | follower lag median (s) | follower lag P75 (s) |')
    md.append('|---|--:|--:|--:|--:|')
    for t in TICKERS:
        n_leader = leader_counts.get(t, 0)
        lags = follower_lag.get(t, [])
        med = f'{median(lags):.1f}' if lags else '—'
        p75 = f'{quantile(lags, 0.75):.1f}' if lags else '—'
        md.append(
            f'| {t} | {n_leader} | {len(lags)} | {med} | {p75} |',
        )
    md.append('')
    md.append(
        '_Reading this: a ticker with high n_leader + low n_follower '
        '**leads** the others. A ticker with low n_leader + high '
        'n_follower + small lag is the **reactive** one (consistent '
        'with the SPX-as-reaction-surface thesis if SPXW dominates the '
        'follower column)._\n',
    )

    text = '\n'.join(md)
    out_path = OUT_DIR / f'interval-ba-confluence-{stamp}.md'
    out_path.write_text(text, encoding='utf-8')
    print(f'\nwrote {out_path}')
    print('\n' + text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
