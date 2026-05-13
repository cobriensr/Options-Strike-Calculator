#!/usr/bin/env python
"""Compare SPX forward-return distribution for SPXW alerts that fired
in cross-symbol confluence vs. SPXW alerts that fired alone.

Premise: a 3-way (SPY + SPXW + QQQ) Interval B/A burst within ~90s is
a stronger informed-flow signature than a single-symbol SPXW alert.
If true, the confluence cohort should beat solo SPXW on hit-rate
and/or magnitude at the same forward horizons.

For every SPXW alert in interval_ba_alerts, we tag it with the
strongest confluence it participated in within a 90s window:

  - 3way: confluence across SPY + SPXW + QQQ
  - 2way: SPXW + (SPY OR QQQ), same option_type
  - solo: no other-ticker alert within the window, same direction

Then we join against the SPX forward-return paths from the
enrich_interval_ba_outcomes CSV and compare distributions at T+15 /
T+30 / T+60 / EOD.

Note: every alert in interval_ba_alerts is 0DTE for its underlying
(backfill applies expiry == executed_at::CT date for SPY/SPXW/QQQ —
all three have daily expiries during this window). The comparison is
0DTE × 0DTE × 0DTE.

Usage:
    python3 scripts/analyze_confluence_vs_solo.py [--window-sec 90]
"""

from __future__ import annotations

import argparse
import csv
import glob
import os
import pathlib
import re
import statistics as st
import sys
from collections import defaultdict
from datetime import datetime

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'


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


def median(xs: list[float]) -> float:
    return st.median(xs) if xs else float('nan')


def mean(xs: list[float]) -> float:
    return st.mean(xs) if xs else float('nan')


def quantile(xs: list[float], q: float) -> float:
    if not xs:
        return float('nan')
    s = sorted(xs)
    pos = (len(s) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def fmt(x: float) -> str:
    if x != x:
        return '—'
    return f'{x:+.3f}%'


def load_alerts(conn) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, ticker, option_type, fired_at
            FROM interval_ba_alerts
            WHERE ticker IN ('SPY', 'SPXW', 'QQQ')
              AND fired_at IS NOT NULL
            ORDER BY fired_at ASC
            """,
        )
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]


def tag_spxw_alerts_by_confluence(
    alerts: list[dict],
    window_sec: int,
) -> dict[int, str]:
    """Return {spxw_alert_id: 'solo' | '2way' | '3way'}.

    For each SPXW alert, scans the ±window_sec band of alerts for
    same-direction OTHER-ticker alerts. The tag reflects the maximum
    cross-ticker coverage seen in that band:
      - 3way: at least one SPY AND at least one QQQ
      - 2way: at least one SPY OR QQQ (not both)
      - solo: neither SPY nor QQQ within the window
    """
    out: dict[int, str] = {}
    n = len(alerts)
    # Index alerts by their epoch for binary-search style scan, but at
    # this scale (~18k alerts) a linear sweep is fine.
    epochs = [a['fired_at'].timestamp() for a in alerts]

    for i, a in enumerate(alerts):
        if a['ticker'] != 'SPXW':
            continue
        t = epochs[i]
        opt = a['option_type']
        has_spy = False
        has_qqq = False
        # Scan backwards
        j = i - 1
        while j >= 0 and t - epochs[j] <= window_sec:
            b = alerts[j]
            if b['option_type'] == opt and b['ticker'] != 'SPXW':
                if b['ticker'] == 'SPY':
                    has_spy = True
                elif b['ticker'] == 'QQQ':
                    has_qqq = True
            j -= 1
        # Scan forwards
        j = i + 1
        while j < n and epochs[j] - t <= window_sec:
            b = alerts[j]
            if b['option_type'] == opt and b['ticker'] != 'SPXW':
                if b['ticker'] == 'SPY':
                    has_spy = True
                elif b['ticker'] == 'QQQ':
                    has_qqq = True
            j += 1
        if has_spy and has_qqq:
            out[a['id']] = '3way'
        elif has_spy or has_qqq:
            out[a['id']] = '2way'
        else:
            out[a['id']] = 'solo'
    return out


def load_paths(csv_path: pathlib.Path) -> dict[int, dict[int, float]]:
    paths: dict[int, dict[int, float]] = defaultdict(dict)
    with csv_path.open() as f:
        r = csv.DictReader(f)
        for row in r:
            paths[int(row['alert_id'])][int(row['t_minutes'])] = float(
                row['pct_change']
            )
    return paths


def eod(path: dict[int, float]) -> float | None:
    return path[max(path)] if path else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--window-sec', type=int, default=90)
    parser.add_argument('--csv', type=str, default=None)
    args = parser.parse_args()
    load_env()

    csv_path = (
        pathlib.Path(args.csv)
        if args.csv
        else pathlib.Path(
            sorted(
                glob.glob(str(OUT_DIR / 'interval-ba-outcomes-*.csv')),
                reverse=True,
            )[0]
        )
    )
    print(f'Loading paths from {csv_path.name}…')
    paths = load_paths(csv_path)
    print(f'  {len(paths)} alerts with forward path')

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        alerts = load_alerts(conn)
    finally:
        conn.close()
    print(f'Loaded {len(alerts)} alerts across all three tickers')

    spxw_tags = tag_spxw_alerts_by_confluence(alerts, args.window_sec)
    print(f'Tagged {len(spxw_tags)} SPXW alerts:')
    counts: dict[str, int] = defaultdict(int)
    for t in spxw_tags.values():
        counts[t] += 1
    for k in ('3way', '2way', 'solo'):
        print(f'  {k}: {counts.get(k, 0):,}')

    # Group SPXW alerts by tag, also by option_type
    by_cohort: dict[tuple[str, str, int], list[float]] = defaultdict(list)
    eod_by_cohort: dict[tuple[str, str], list[float]] = defaultdict(list)
    for alert_id, tag in spxw_tags.items():
        path = paths.get(alert_id)
        if not path:
            continue
        opt = next(
            (a['option_type'] for a in alerts if a['id'] == alert_id),
            None,
        )
        if opt is None:
            continue
        for t in (15, 30, 60):
            v = path.get(t)
            if v is not None:
                by_cohort[(tag, opt, t)].append(v)
        v_eod = eod(path)
        if v_eod is not None:
            eod_by_cohort[(tag, opt)].append(v_eod)

    # Build markdown
    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    md.append(f'# SPXW confluence vs solo — SPX forward-return comparison ({stamp})\n')
    md.append(
        f'_Joined {len(spxw_tags)} SPXW alerts against the forward-return '
        f'paths in `{csv_path.name}`. Confluence-window = {args.window_sec}s '
        f'around each SPXW fired_at moment. All cohorts 0DTE × 0DTE × 0DTE._\n',
    )
    md.append('## Cohort counts\n')
    md.append('| cohort | n SPXW alerts |')
    md.append('|---|--:|')
    for k in ('3way', '2way', 'solo'):
        md.append(f'| {k} | {counts.get(k, 0):,} |')
    md.append('')

    def hit_pct(xs: list[float], opt: str) -> float:
        if not xs:
            return float('nan')
        if opt == 'C':
            return sum(1 for x in xs if x > 0) / len(xs) * 100
        return sum(1 for x in xs if x < 0) / len(xs) * 100

    md.append('## Hit rate by cohort (SPX direction matches option_type)\n')
    md.append('| cohort | type | n | T+15 hit | T+30 hit | T+60 hit | EOD hit |')
    md.append('|---|---|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            row = [tag, opt]
            xs_eod = eod_by_cohort.get((tag, opt), [])
            n = len(xs_eod)
            if n < 30:
                continue
            row.append(str(n))
            for t in (15, 30, 60):
                xs = by_cohort.get((tag, opt, t), [])
                row.append(f'{hit_pct(xs, opt):.1f}%' if xs else '—')
            row.append(f'{hit_pct(xs_eod, opt):.1f}%')
            md.append('| ' + ' | '.join(row) + ' |')
    md.append('')

    md.append('## Median EOD % change by cohort\n')
    md.append('| cohort | type | n | median EOD | mean EOD | P75 | P90 | max |')
    md.append('|---|---|--:|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            xs = eod_by_cohort.get((tag, opt), [])
            if len(xs) < 30:
                continue
            md.append(
                f'| {tag} | {opt} | {len(xs)} | '
                f'{fmt(median(xs))} | {fmt(mean(xs))} | '
                f'{fmt(quantile(xs, 0.75))} | {fmt(quantile(xs, 0.90))} | '
                f'{fmt(max(xs))} |',
            )
    md.append('')

    md.append('## Magnitude conditional on direction (EOD)\n')
    md.append(
        '_For each cohort, when the bet works (CALL → up, PUT → down), '
        'how big is the move? Comparing the WINNERS across cohorts._\n',
    )
    md.append('| cohort | type | n_right | median | mean | P75 | P90 |')
    md.append('|---|---|--:|--:|--:|--:|--:|')
    for tag in ('3way', '2way', 'solo'):
        for opt in ('C', 'P'):
            xs_eod = eod_by_cohort.get((tag, opt), [])
            if opt == 'C':
                right = [x for x in xs_eod if x > 0]
            else:
                right = [-x for x in xs_eod if x < 0]
            if len(right) < 20:
                continue
            md.append(
                f'| {tag} | {opt} | {len(right)} | '
                f'{fmt(median(right))} | {fmt(mean(right))} | '
                f'{fmt(quantile(right, 0.75))} | '
                f'{fmt(quantile(right, 0.90))} |',
            )
    md.append('')

    text = '\n'.join(md)
    out_path = OUT_DIR / f'interval-ba-confluence-vs-solo-{stamp}.md'
    out_path.write_text(text, encoding='utf-8')
    print(f'\nwrote {out_path}')
    print('\n' + text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
