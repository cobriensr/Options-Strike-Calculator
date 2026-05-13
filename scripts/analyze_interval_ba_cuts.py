#!/usr/bin/env python
"""Empirical edge analysis on SPXW Interval B/A alerts, 5 cuts deep.

Reads:
  - interval_ba_alerts (DB) for the alert universe (option_type, ratio_pct,
    top_trade_is_sweep, hour-of-day of fired_at)
  - docs/tmp/interval-ba-outcomes-*.csv (latest) for the forward-return
    paths at T+5/15/30/60/EOD

Produces (in docs/tmp/):
  - interval-ba-analysis-{stamp}.md — markdown tables for each cut

Five cuts run sequentially against the alert × forward-return join:

  1. HIT RATE vs UNCONDITIONAL BASELINE
     Compute the fraction of CALL alerts where SPX is up at T+30/T+60/EOD,
     compared against the fraction of any random 5-min window on the same
     trading day that closes up by the same horizon. The "edge" is the
     hit-rate delta over baseline — anything ≥ +3pp is meaningful at
     this sample size.

  2. MAGNITUDE CONDITIONAL ON DIRECTION
     For CALL alerts that ended positive at EOD, median / mean / P90 of
     the positive moves. Similarly for negative PUT outcomes.

  3. HOUR-OF-DAY
     Bin by fired_at CT hour. Does an alert at 09:30 CT outperform one
     at 14:30 CT? (Decay pattern, if any.)

  4. RATIO PERCENTILE
     Bucket by ratio_pct: 70-75 / 75-85 / 85-95 / 95-100. Does extreme
     ratio buy edge or is 70% the saturation point?

  5. SWEEP vs NON-SWEEP TOP TRADE
     Single-actor signature filter — top_trade_is_sweep = True implies
     one buyer reached for size with a sweep. Compare hit rate + magnitude
     vs non-sweep alerts.

Usage:
    python3 scripts/analyze_interval_ba_cuts.py [--csv PATH]
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
from zoneinfo import ZoneInfo

import psycopg2

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'
OUT_DIR = ROOT / 'docs' / 'tmp'
_CT = ZoneInfo('America/Chicago')


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
    frac = pos - lo
    return s[lo] + (s[hi] - s[lo]) * frac


def fmt_pct(n: float, sign: bool = True) -> str:
    if n != n:  # NaN
        return '—'
    fmt = '+.3f' if sign else '.3f'
    return f'{n:{fmt}}%'


def fmt_int(n: float) -> str:
    if n != n:
        return '—'
    return f'{int(n)}'


def load_alert_meta(conn) -> dict[int, dict]:
    """Pull per-alert metadata that the CSV doesn't carry."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, option_chain, option_type, fired_at, ratio_pct,
                   total_premium, top_trade_is_sweep, top_trade_is_floor
            FROM interval_ba_alerts
            """,
        )
        out = {}
        for r in cur.fetchall():
            (alert_id, chain, opt_type, fired_at, ratio_pct, total_prem,
             is_sweep, is_floor) = r
            ct_hour = fired_at.astimezone(_CT).hour if fired_at else None
            out[alert_id] = {
                'chain': chain,
                'option_type': opt_type,
                'fired_at': fired_at,
                'ct_hour': ct_hour,
                'ratio_pct': float(ratio_pct) if ratio_pct is not None else None,
                'total_premium': float(total_prem) if total_prem is not None else 0.0,
                'is_sweep': bool(is_sweep) if is_sweep is not None else False,
                'is_floor': bool(is_floor) if is_floor is not None else False,
            }
        return out


def load_forward_paths(csv_path: pathlib.Path) -> dict[int, dict[int, float]]:
    """Return {alert_id: {t_minutes: pct_change}}."""
    paths: dict[int, dict[int, float]] = defaultdict(dict)
    with csv_path.open() as f:
        r = csv.DictReader(f)
        for row in r:
            alert_id = int(row['alert_id'])
            t = int(row['t_minutes'])
            pct = float(row['pct_change'])
            paths[alert_id][t] = pct
    return paths


def horizon_pct(path: dict[int, float], horizon_min: int) -> float | None:
    """Return pct_change at horizon_min if available, else None."""
    return path.get(horizon_min)


def eod_pct(path: dict[int, float]) -> float | None:
    """Last (largest t) pct_change in the path = end of day."""
    if not path:
        return None
    return path[max(path)]


# ──────────────────────────────────────────────────────────────────
# Cut 1: hit rate vs unconditional baseline
# ──────────────────────────────────────────────────────────────────


def cut_hit_rate_with_baseline(
    alerts: dict[int, dict],
    paths: dict[int, dict[int, float]],
    md: list[str],
) -> None:
    """Hit rate of CALL alerts (SPX up at horizon) vs unconditional baseline.

    Baseline = naive p(SPX up at horizon) computed across all FORWARD-PATH
    samples regardless of alert direction. Sampled from the same alert
    universe so it inherits the same day-of-week / hour-of-day mix.
    """
    md.append('## 1. Hit rate vs unconditional baseline\n')
    md.append(
        '_"hit" = SPX direction matches the option_type bet (CALL → up, '
        'PUT → down). "baseline" = unconditional p(SPX up) across the '
        'same set of forward-path snapshots — sampled from the alert '
        'universe so day-mix and hour-mix wash out. Edge = hit% − '
        'baseline%, anything > +3pp is meaningful at this n._\n',
    )
    md.append('| horizon | type | n | hit % | baseline % | edge (pp) |')
    md.append('|---|---|--:|--:|--:|--:|')

    for horizon_min, label in [(30, 'T+30min'), (60, 'T+60min'), (-1, 'EOD')]:
        # Build the universal baseline: p(SPX up at horizon) across ALL
        # alerts (call + put). Since the SPX path is the same regardless
        # of option_type, the baseline says nothing about edge — it's
        # the "what would random get".
        baseline_xs: list[float] = []
        for alert_id, path in paths.items():
            v = eod_pct(path) if horizon_min < 0 else horizon_pct(path, horizon_min)
            if v is not None:
                baseline_xs.append(v)
        if not baseline_xs:
            continue
        p_baseline_up = sum(1 for x in baseline_xs if x > 0) / len(baseline_xs) * 100

        for opt_type in ('C', 'P'):
            xs: list[float] = []
            for alert_id, a in alerts.items():
                if a['option_type'] != opt_type:
                    continue
                path = paths.get(alert_id)
                if not path:
                    continue
                v = (
                    eod_pct(path)
                    if horizon_min < 0 else horizon_pct(path, horizon_min)
                )
                if v is None:
                    continue
                xs.append(v)
            if not xs:
                continue
            if opt_type == 'C':
                hit = sum(1 for x in xs if x > 0) / len(xs) * 100
                baseline = p_baseline_up
            else:
                hit = sum(1 for x in xs if x < 0) / len(xs) * 100
                baseline = 100 - p_baseline_up
            edge = hit - baseline
            md.append(
                f'| {label} | {opt_type} | {len(xs)} | '
                f'{hit:.1f}% | {baseline:.1f}% | '
                f'{edge:+.1f} |',
            )
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Cut 2: magnitude conditional on direction
# ──────────────────────────────────────────────────────────────────


def cut_magnitude_conditional(
    alerts: dict[int, dict],
    paths: dict[int, dict[int, float]],
    md: list[str],
) -> None:
    md.append('## 2. Magnitude conditional on direction\n')
    md.append(
        '_When the bet works (CALL → SPX up at EOD, PUT → SPX down at '
        'EOD), how big is the move? Median / mean / P90 / max in the '
        '"right" tail._\n',
    )
    md.append('| type | dir | n_right | median | mean | P75 | P90 | P95 | max |')
    md.append('|---|---|--:|--:|--:|--:|--:|--:|--:|')

    for opt_type, direction in (('C', 'up'), ('P', 'down')):
        right_xs: list[float] = []
        wrong_xs: list[float] = []
        for alert_id, a in alerts.items():
            if a['option_type'] != opt_type:
                continue
            path = paths.get(alert_id)
            if not path:
                continue
            v = eod_pct(path)
            if v is None:
                continue
            is_right = (v > 0) if opt_type == 'C' else (v < 0)
            if is_right:
                right_xs.append(v)
            else:
                wrong_xs.append(v)

        if right_xs:
            xs = right_xs if opt_type == 'C' else [-x for x in right_xs]
            md.append(
                f'| {opt_type} | RIGHT ({direction}) | {len(right_xs)} | '
                f'{fmt_pct(median(xs))} | {fmt_pct(mean(xs))} | '
                f'{fmt_pct(quantile(xs, 0.75))} | '
                f'{fmt_pct(quantile(xs, 0.90))} | '
                f'{fmt_pct(quantile(xs, 0.95))} | '
                f'{fmt_pct(max(xs))} |',
            )
        if wrong_xs:
            xs_w = wrong_xs if opt_type == 'C' else [-x for x in wrong_xs]
            md.append(
                f'| {opt_type} | WRONG | {len(wrong_xs)} | '
                f'{fmt_pct(median(xs_w))} | {fmt_pct(mean(xs_w))} | '
                f'{fmt_pct(quantile(xs_w, 0.75))} | '
                f'{fmt_pct(quantile(xs_w, 0.90))} | '
                f'{fmt_pct(quantile(xs_w, 0.95))} | '
                f'{fmt_pct(max(xs_w))} |',
            )
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Cut 3: hour-of-day
# ──────────────────────────────────────────────────────────────────


def cut_hour_of_day(
    alerts: dict[int, dict],
    paths: dict[int, dict[int, float]],
    md: list[str],
) -> None:
    md.append('## 3. Hour-of-day (CT fired_at)\n')
    md.append(
        '_Trading session is 08:30–15:00 CT. Bin alerts by the CT hour '
        'of fire. Median + hit % at EOD. Wide hour ranges combine to '
        'span the whole session; the first row of each option_type is '
        'the all-day baseline._\n',
    )
    md.append('| type | CT hour | n | median EOD | mean EOD | hit % |')
    md.append('|---|---|--:|--:|--:|--:|')

    for opt_type in ('C', 'P'):
        # All-day baseline
        all_xs: list[float] = []
        for alert_id, a in alerts.items():
            if a['option_type'] != opt_type:
                continue
            path = paths.get(alert_id)
            if not path:
                continue
            v = eod_pct(path)
            if v is None:
                continue
            all_xs.append(v)
        if all_xs:
            hit_pct = (
                sum(1 for x in all_xs if x > 0) / len(all_xs) * 100
                if opt_type == 'C'
                else sum(1 for x in all_xs if x < 0) / len(all_xs) * 100
            )
            md.append(
                f'| {opt_type} | ALL | {len(all_xs)} | '
                f'{fmt_pct(median(all_xs))} | {fmt_pct(mean(all_xs))} | '
                f'{hit_pct:.1f}% |',
            )
        # Per-hour
        by_hour: dict[int, list[float]] = defaultdict(list)
        for alert_id, a in alerts.items():
            if a['option_type'] != opt_type:
                continue
            path = paths.get(alert_id)
            if not path:
                continue
            v = eod_pct(path)
            if v is None or a['ct_hour'] is None:
                continue
            by_hour[a['ct_hour']].append(v)
        for hour in sorted(by_hour):
            xs = by_hour[hour]
            if len(xs) < 20:
                continue  # require ≥20 samples for the cell to be meaningful
            hit_pct = (
                sum(1 for x in xs if x > 0) / len(xs) * 100
                if opt_type == 'C'
                else sum(1 for x in xs if x < 0) / len(xs) * 100
            )
            md.append(
                f'| {opt_type} | {hour:02d}:00 CT | {len(xs)} | '
                f'{fmt_pct(median(xs))} | {fmt_pct(mean(xs))} | '
                f'{hit_pct:.1f}% |',
            )
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Cut 4: ratio percentile
# ──────────────────────────────────────────────────────────────────


def cut_ratio_percentile(
    alerts: dict[int, dict],
    paths: dict[int, dict[int, float]],
    md: list[str],
) -> None:
    md.append('## 4. Ratio percentile (does higher ratio = bigger edge?)\n')
    md.append(
        '_Buckets the alert universe by ratio_pct. Does 95%+ ASK ratio '
        'outperform 70-75%, or is 70% already past the saturation '
        'point?_\n',
    )
    md.append('| type | ratio | n | median EOD | mean EOD | P90 | hit % |')
    md.append('|---|---|--:|--:|--:|--:|--:|')

    bands = [
        (70, 75, '70-75%'),
        (75, 85, '75-85%'),
        (85, 95, '85-95%'),
        (95, 100.01, '95-100%'),
    ]
    for opt_type in ('C', 'P'):
        for lo, hi, label in bands:
            xs: list[float] = []
            for alert_id, a in alerts.items():
                if a['option_type'] != opt_type:
                    continue
                if a['ratio_pct'] is None:
                    continue
                if not (lo <= a['ratio_pct'] < hi):
                    continue
                path = paths.get(alert_id)
                if not path:
                    continue
                v = eod_pct(path)
                if v is None:
                    continue
                xs.append(v)
            if len(xs) < 20:
                continue
            hit_pct = (
                sum(1 for x in xs if x > 0) / len(xs) * 100
                if opt_type == 'C'
                else sum(1 for x in xs if x < 0) / len(xs) * 100
            )
            md.append(
                f'| {opt_type} | {label} | {len(xs)} | '
                f'{fmt_pct(median(xs))} | {fmt_pct(mean(xs))} | '
                f'{fmt_pct(quantile(xs, 0.90))} | '
                f'{hit_pct:.1f}% |',
            )
    md.append('')


# ──────────────────────────────────────────────────────────────────
# Cut 5: sweep vs non-sweep
# ──────────────────────────────────────────────────────────────────


def cut_sweep_vs_nonsweep(
    alerts: dict[int, dict],
    paths: dict[int, dict[int, float]],
    md: list[str],
) -> None:
    md.append('## 5. Sweep vs non-sweep top trade\n')
    md.append(
        '_Splits by `top_trade_is_sweep`. A sweep means the dominant '
        'ASK print was a single-actor multi-exchange aggressive lift — '
        'stronger informed-flow signature than a routine block._\n',
    )
    md.append('| type | top trade | n | median EOD | mean EOD | P90 | hit % |')
    md.append('|---|---|--:|--:|--:|--:|--:|')

    for opt_type in ('C', 'P'):
        for sweep_label, want_sweep in [('sweep', True), ('non-sweep', False)]:
            xs: list[float] = []
            for alert_id, a in alerts.items():
                if a['option_type'] != opt_type:
                    continue
                if a['is_sweep'] != want_sweep:
                    continue
                path = paths.get(alert_id)
                if not path:
                    continue
                v = eod_pct(path)
                if v is None:
                    continue
                xs.append(v)
            if len(xs) < 20:
                continue
            hit_pct = (
                sum(1 for x in xs if x > 0) / len(xs) * 100
                if opt_type == 'C'
                else sum(1 for x in xs if x < 0) / len(xs) * 100
            )
            md.append(
                f'| {opt_type} | {sweep_label} | {len(xs)} | '
                f'{fmt_pct(median(xs))} | {fmt_pct(mean(xs))} | '
                f'{fmt_pct(quantile(xs, 0.90))} | '
                f'{hit_pct:.1f}% |',
            )
    md.append('')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--csv',
        type=str,
        default=None,
        help='Path to outcomes CSV. Default: newest under docs/tmp/.',
    )
    args = parser.parse_args()
    load_env()

    if args.csv:
        csv_path = pathlib.Path(args.csv)
    else:
        candidates = sorted(
            glob.glob(str(OUT_DIR / 'interval-ba-outcomes-*.csv')),
            reverse=True,
        )
        if not candidates:
            sys.exit('No outcomes CSV found under docs/tmp/')
        csv_path = pathlib.Path(candidates[0])
    if not csv_path.exists():
        sys.exit(f'CSV missing: {csv_path}')

    print(f'Loading paths from {csv_path.name}…')
    paths = load_forward_paths(csv_path)
    print(f'  {len(paths)} alerts with forward path')

    conn = psycopg2.connect(os.environ['DATABASE_URL'])
    try:
        print('Loading alert metadata from DB…')
        alerts = load_alert_meta(conn)
        print(f'  {len(alerts)} alerts total')
    finally:
        conn.close()

    md: list[str] = []
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    md.append(f'# Interval B/A — empirical edge analysis ({stamp})\n')
    md.append(
        f'_Joined {len(alerts)} alerts against {len(paths)} forward-return '
        f'paths from `{csv_path.name}`._\n',
    )

    cut_hit_rate_with_baseline(alerts, paths, md)
    cut_magnitude_conditional(alerts, paths, md)
    cut_hour_of_day(alerts, paths, md)
    cut_ratio_percentile(alerts, paths, md)
    cut_sweep_vs_nonsweep(alerts, paths, md)

    output = '\n'.join(md)
    out_path = OUT_DIR / f'interval-ba-analysis-{stamp}.md'
    out_path.write_text(output, encoding='utf-8')
    print(f'\nwrote {out_path}')
    print('\n' + output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
