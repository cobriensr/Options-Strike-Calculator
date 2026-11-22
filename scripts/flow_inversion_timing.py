#!/usr/bin/env python
"""Per-ticker analysis of time-to-flow-inversion.

Re-runs `simulate_flow_inversion` against the parquet+flow inputs for
every enriched fire, capturing the inversion timestamp directly so we
can compute (inversion_ts − trigger_ts) in minutes. Aggregates per
ticker / mode / tier / dte and writes a markdown report to
docs/tmp/flow-inversion-timing-{LATEST_DATE}.md (or --out-dir).

Useful for: knowing how long after a fire to start watching for the
exit signal on a given ticker, and spotting fast-vs-slow tape regimes.

Tiers are the feed's: each fire's quality-adjusted score (qas = GREATEST(0,
score) + inversion bonus, no round-trip deduct) against the feed cutoffs of the
ACTIVE lottery weights, read from the store. A failed read of the weights ends
the run before any report is written. (Owner ruling, 2026-11-19: the bare-score
split this report used to apply is gone. Owner decision, 2026-11-17: the feed
fixes its tier at the fire, so the deduct is not in the qas.)

Read-only — does not modify the DB or production code.

The per-day numbers come from `derive_day`, which turns one tape day into one
small frame (`DERIVED_COLUMNS`: the fire id, minutes to the inversion and the
exit pct). The report joins those rows to the fires on id, so the ticker, mode,
tier, dte and option type always come from the fire as it is now. Two ways to
run, one of which is required:

  --parquet-dir DIR   derive every fire date from {date}-trades.parquet in DIR
                      (the Bot-EOD archive; `make update` passes the Makefile's
                      PARQUET_DIR). A day whose file is missing is skipped with
                      one line naming it.
  --derived-dir DIR   read {date}.parquet, the files `derive_day` wrote, from
                      DIR. A day without one is skipped, listed as "not
                      derived yet".

The skipped days are listed at the end. When no day had a file, the run says
so and exits 0, so `make update` carries on; a run that read days but timed
no inversion still exits non-zero.

Usage:
    ml/.venv/Scripts/python scripts/flow_inversion_timing.py --parquet-dir <bot-eod-dir>
    ml/.venv/Scripts/python scripts/flow_inversion_timing.py --derived-dir <derived-dir>
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys
import time
from collections.abc import Iterable
from datetime import date, datetime
from pathlib import Path

import pandas as pd
import psycopg2

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

# Reuse the production port from the enrichment script — single
# source of truth for the algorithm.
sys.path.insert(0, str(ROOT / 'scripts'))
from _cli_paths import (  # noqa: E402
    existing_dir,
    format_dates,
    load_env_file,
    warn_missing_archive,
)
from _report_weights import (  # noqa: E402
    FeedCutoffs,
    load_active_weights,
    tier_header,
    tier_labels,
)
from enrich_lottery_outcomes import (  # noqa: E402
    load_matched_flow,
    simulate_flow_inversion,
    resample_minute_mid,
)

# Bump when derive_day's numbers change: the nightly re-derives every day.
DERIVE_VERSION = 1
DERIVED_COLUMNS: tuple[str, ...] = ('id', 'minutes_to_inversion', 'realized_pct')
DERIVED_DTYPES = {c: ('int64' if c == 'id' else 'float64') for c in DERIVED_COLUMNS}

# Every fire with a flow-inversion value, with the two columns the feed's qas
# reads besides the score: GREATEST(0, score) + the inversion bonus, with no
# round-trip deduct (the feed fixes its tier at the fire). The join is the
# feed's own: nightly/src/refit_step.py, api/lottery-finder.ts. No ORDER BY:
# each caller adds its own.
FIRES_SQL = """
SELECT f.id, f.date, f.option_chain_id, f.underlying_symbol, f.option_type,
       f.trigger_time_ct, f.entry_price, f.mode, f.dte, f.score,
       f.realized_flow_inversion_pct AS flow_inv,
       f.direction_gated, s.inversion_quintile
FROM lottery_finder_fires f
LEFT JOIN lottery_ticker_stats s ON s.ticker = f.underlying_symbol
WHERE f.realized_flow_inversion_pct IS NOT NULL
"""

# A day's fingerprint covers what the derived rows depend on besides the tape:
# which fires have an inversion value.
_FINGERPRINT_EXPR = "md5(string_agg(id::text, ',' ORDER BY id))"
DAY_FINGERPRINT_SQL = f"""
SELECT date, {_FINGERPRINT_EXPR} AS fingerprint
FROM lottery_finder_fires
WHERE realized_flow_inversion_pct IS NOT NULL
GROUP BY date
"""


def latest_fire_date(conn) -> str:
    cur = conn.cursor()
    cur.execute(
        'SELECT MAX(date) FROM lottery_finder_fires WHERE peak_ceiling_pct IS NOT NULL'
    )
    row = cur.fetchone()
    if row is None or row[0] is None:
        return 'unknown'
    return row[0].isoformat() if hasattr(row[0], 'isoformat') else str(row[0])[:10]


# ============================================================
# Per-day driver
# ============================================================


def _derived_frame(rows: list[dict]) -> pd.DataFrame:
    """`rows` as DERIVED_COLUMNS with pinned dtypes (id int64, the rest
    float64), ordered by id. No rows is a valid frame."""
    frame = pd.DataFrame(rows, columns=list(DERIVED_COLUMNS)).astype(DERIVED_DTYPES)
    return frame.sort_values('id', kind='stable', ignore_index=True)


def derive_day(
    conn, day: date, tape_path: Path, fires_for_date: pd.DataFrame
) -> pd.DataFrame:
    """The inversion timings of one day's fires, from the day's tape file and
    the day's net flow (read through `conn`).

    Returns DERIVED_COLUMNS exactly: `id` int64, the rest float64, one row per
    fire whose simulation ended in a true inversion (so possibly none),
    ordered by id. An EOD fallback is not a timing: it would skew the
    distribution toward 15:00. The tape may be either layout: float or
    decimal128 numerics, a bool or a text `canceled`, a tz-aware or a
    naive-UTC `executed_at`.
    """
    if fires_for_date.empty:
        return _derived_frame([])
    date_str = day.isoformat()
    sub = fires_for_date

    chains = sub['option_chain_id'].unique().tolist()
    df = pd.read_parquet(
        tape_path,
        columns=['executed_at', 'option_chain_id', 'price',
                 'canceled', 'nbbo_bid', 'nbbo_ask', 'size'],
        filters=[('option_chain_id', 'in', chains)],
    )
    # January-April tapes store the numerics as decimal128, which pandas reads
    # as Python Decimal objects; coerce to float64 at the boundary.
    for col in ('price', 'nbbo_bid', 'nbbo_ask', 'size'):
        df[col] = pd.to_numeric(df[col]).astype('float64')
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f','false','0',''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    df = df.sort_values(['option_chain_id', 'executed_at'], kind='stable')
    chain_idx = dict(iter(df.groupby('option_chain_id', sort=False)))

    # Per-chain minute mids cache.
    minute_cache: dict[str, list[tuple]] = {}
    # Per (ticker, type) flow cache, from the enrichment script's own
    # loader so the window is the one its values are written from.
    flow_cache: dict[tuple[str, str], list[tuple]] = {}
    for ticker in sub['underlying_symbol'].unique():
        for opt_type in ('C', 'P'):
            flow_cache[(ticker, opt_type)] = load_matched_flow(
                conn, date_str, ticker, opt_type
            )

    timings: list[dict] = []
    for _, fire in sub.iterrows():
        chain_df = chain_idx.get(fire['option_chain_id'])
        if chain_df is None:
            continue
        if fire['option_chain_id'] not in minute_cache:
            minute_cache[fire['option_chain_id']] = resample_minute_mid(chain_df)
        minutes = minute_cache[fire['option_chain_id']]
        flow = flow_cache.get((fire['underlying_symbol'], fire['option_type']), [])

        trigger_ts = fire['trigger_time_ct']
        if hasattr(trigger_ts, 'tz_localize') and trigger_ts.tz is None:
            trigger_ts = trigger_ts.tz_localize('UTC')
        if hasattr(trigger_ts, 'to_pydatetime'):
            trigger_ts = trigger_ts.to_pydatetime()

        exit_pct, exit_ts, status = simulate_flow_inversion(
            minutes, flow, float(fire['entry_price']), trigger_ts
        )
        # Only record true inversion exits — EOD fallbacks have a
        # different meaning and would skew the timing toward 15:00.
        if status != 'inversion' or exit_ts is None:
            continue
        mins_to_inv = (exit_ts - trigger_ts).total_seconds() / 60.0
        timings.append({
            'id': int(fire['id']),
            'minutes_to_inversion': mins_to_inv,
            'realized_pct': float(exit_pct),
        })
    return _derived_frame(timings)


def fires_for_day(conn, day: date) -> pd.DataFrame:
    """One day's fires, the same rows (and columns) as the whole-population
    read."""
    return pd.read_sql(
        FIRES_SQL + ' AND f.date = %s ORDER BY f.trigger_time_ct',
        conn,
        params=(day,),
    )


def fingerprint_rows(fires: pd.DataFrame) -> str:
    """md5 hex of the day's canonical fire list: the ids joined by commas,
    ascending numeric. The SQL twin is DAY_FINGERPRINT_SQL, which reads the
    fires that have an inversion value; `fires` is already that set."""
    text = ','.join(str(int(fire_id)) for fire_id in fires['id'].sort_values())
    return hashlib.md5(text.encode('utf-8'), usedforsecurity=False).hexdigest()


def _as_date(value) -> date:
    """A date from what a driver may hand back: a date, a datetime or ISO text."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def day_fingerprints(conn) -> dict[date, str]:
    """Each day's fingerprint, as the database computes it."""
    cur = conn.cursor()
    cur.execute(DAY_FINGERPRINT_SQL)
    return {_as_date(day): str(digest) for day, digest in cur.fetchall()}


def load_derived(
    derived_dir: Path, days: Iterable[str]
) -> tuple[pd.DataFrame, list[str]]:
    """The derived rows of `days` (ISO dates), and the days with no file.

    A day's file is `{day}.parquet`; one that holds no rows is a derived day.
    The rows come back as DERIVED_COLUMNS with pinned dtypes. A file that
    lacks a column raises ValueError naming it.
    """
    frames: list[pd.DataFrame] = []
    missing: list[str] = []
    for day in days:
        path = derived_dir / f'{day}.parquet'
        if not path.exists():
            missing.append(day)
            continue
        frame = pd.read_parquet(path)
        absent = [c for c in DERIVED_COLUMNS if c not in frame.columns]
        if absent:
            raise ValueError(f'{path.name}: derived file lacks columns {", ".join(absent)}')
        frames.append(frame[list(DERIVED_COLUMNS)])
    rows = pd.concat(frames, ignore_index=True) if frames else _derived_frame([])
    return rows.astype(DERIVED_DTYPES), missing


# ============================================================
# Main
# ============================================================


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        '--parquet-dir',
        type=existing_dir,
        help='Bot-EOD archive: the directory of {date}-trades.parquet files.',
    )
    source.add_argument(
        '--derived-dir',
        type=existing_dir,
        help='Per-day derived files: the directory of {date}.parquet files.',
    )
    parser.add_argument(
        '--out-dir',
        type=Path,
        default=ROOT / 'docs' / 'tmp',
        help='Where the report is written (default: docs/tmp under the repo root).',
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    load_env_file(ENV_FILE)
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ['DATABASE_URL']
    conn = psycopg2.connect(db_url)
    version, weights = load_active_weights(conn, 'timing')
    cutoffs = FeedCutoffs.from_weights(weights)
    out_path = args.out_dir / f'flow-inversion-timing-{latest_fire_date(conn)}.md'

    print('[timing] loading fires…')
    fires = pd.read_sql(FIRES_SQL + ' ORDER BY f.date, f.trigger_time_ct', conn)
    fires['tier'] = tier_labels(fires, cutoffs)
    print(f'[timing] {len(fires):,} fires with non-null flow_inv across '
          f'{fires["date"].nunique()} dates')

    # Bucket by date so we load each parquet once.
    t0 = time.time()
    day_groups = [(_as_date(d), sub) for d, sub in fires.groupby('date', sort=True)]
    chunks: list[pd.DataFrame] = []
    missing: list[str] = []
    if args.derived_dir is not None:
        derived, missing = load_derived(
            args.derived_dir, [day.isoformat() for day, _ in day_groups]
        )
        days_read = len(day_groups) - len(missing)
        skipped_why = 'not derived yet'
        skipped_summary = f'{len(missing)} day(s) skipped, not derived yet'
        no_day_note = 'no derived day to read — no report written'
    else:
        days_read = 0
        for day, sub in day_groups:
            date_str = day.isoformat()
            path = args.parquet_dir / f'{date_str}-trades.parquet'
            if not path.exists():
                warn_missing_archive(
                    '[timing]', date_str, path, f'{len(sub):,} fires not timed'
                )
                missing.append(date_str)
                continue
            days_read += 1
            chunk = derive_day(conn, day, path, sub)
            chunks.append(chunk)
            print(f'  [{date_str}] {len(sub):,} fires → {len(chunk):,} inversion timings')
        derived = pd.concat(chunks, ignore_index=True) if chunks else _derived_frame([])
        skipped_why = 'archive missing'
        skipped_summary = f'{len(missing)} day(s) skipped for a missing archive'
        no_day_note = 'no archive day to read — no report written'

    # The fire is the source of ticker, mode, tier, dte and option type: a
    # derived row whose fire has since left the population is left out.
    attrs = fires[['id', 'underlying_symbol', 'mode', 'tier', 'dte', 'option_type']]
    attrs = attrs.rename(columns={'underlying_symbol': 'ticker'}).astype({'dte': 'int64'})
    df = derived.merge(attrs, on='id', how='inner', validate='1:1')

    print(f'[timing] computed in {time.time() - t0:.1f}s; {len(df):,} inversions')
    print(f'[timing] {days_read} day(s) read, {skipped_summary}')
    if missing:
        line = f'[timing] skipped ({skipped_why}): {format_dates(missing)}'
        print(line)
        print(line, file=sys.stderr)

    if df.empty:
        if days_read == 0 and missing:
            # Missing archives are a skip, not a failure (owner rule
            # 2026-10-29): say so and let `make update` carry on.
            print(f'[timing] {no_day_note}')
            return
        sys.exit('[timing] no inversion timings collected — nothing to report')

    def fmt_stats(s: pd.Series) -> str:
        s = s.dropna()
        if len(s) < 30:
            return f'n={len(s)} (insufficient)'
        return (f'n={len(s):>5,}  '
                f'median={s.median():>5.1f}min  '
                f'p25={s.quantile(0.25):>5.1f}  '
                f'p75={s.quantile(0.75):>5.1f}  '
                f'p90={s.quantile(0.90):>5.1f}  '
                f'mean={s.mean():>5.1f}')

    lines = ['# Flow-inversion timing analysis\n']
    lines.append(tier_header(version, cutoffs))
    lines.append(f'Dataset: {len(df):,} fires where flow_inversion fired '
                 f'(EOD-fallback excluded — those would skew distribution).\n')
    if missing:
        lines.append(
            f'{len(missing)} day(s) skipped ({skipped_why}): '
            f'{format_dates(missing)}. Their fires are not timed here.\n'
        )
    lines.append('## Aggregate (all fires with true inversion)\n')
    lines.append('    ' + fmt_stats(df['minutes_to_inversion']))

    lines.append('\n## By mode\n')
    for mode, sub in df.groupby('mode'):
        lines.append(f'    {mode:<22} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By tier\n')
    for tlbl in ['T1', 'T2', 'T3']:
        sub = df[df['tier'] == tlbl]
        lines.append(f'    {tlbl:<5} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By DTE\n')
    for dte, sub in df.groupby('dte'):
        lines.append(f'    DTE {dte}  {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## By option type\n')
    for ot, sub in df.groupby('option_type'):
        lines.append(f'    {ot:<3} {fmt_stats(sub["minutes_to_inversion"])}')

    lines.append('\n## Per-ticker (n ≥ 100, sorted by median time-to-inversion)\n')
    lines.append(f'    {"ticker":<7} {"n":>6} {"median":>7} {"p25":>5} {"p75":>5} {"p90":>5} {"mean":>5}  {"avg_pct%":>8}')
    rows = []
    for ticker, sub in df.groupby('ticker'):
        if len(sub) < 100:
            continue
        s = sub['minutes_to_inversion']
        rows.append({
            'ticker': ticker,
            'n': len(sub),
            'median': float(s.median()),
            'p25': float(s.quantile(0.25)),
            'p75': float(s.quantile(0.75)),
            'p90': float(s.quantile(0.90)),
            'mean': float(s.mean()),
            'avg_pct': float(sub['realized_pct'].mean()),
        })
    rows.sort(key=lambda r: r['median'])
    for r in rows:
        lines.append(
            f'    {r["ticker"]:<7} {r["n"]:>6,} {r["median"]:>6.1f}m '
            f'{r["p25"]:>4.0f} {r["p75"]:>4.0f} {r["p90"]:>4.0f} {r["mean"]:>4.0f}  '
            f'{r["avg_pct"]:>+7.2f}%'
        )

    lines.append('\n## Distribution buckets (across all fires)\n')
    bins = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 1000]
    labels = ['0-5', '5-10', '10-15', '15-20', '20-30', '30-45',
              '45-60', '60-90', '90-120', '120-180', '180-240', '240+']
    binned = pd.cut(df['minutes_to_inversion'], bins=bins, labels=labels, right=False)
    counts = binned.value_counts().sort_index()
    cum = 0
    total = counts.sum()
    lines.append(f'    {"bucket":<10} {"n":>6} {"pct":>5} {"cum%":>5}')
    for label, n in counts.items():
        cum += n
        lines.append(f'    {label:<10} {n:>6,} {100*n/total:>4.1f}% {100*cum/total:>4.1f}%')

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text('\n'.join(lines), encoding='utf-8')
    print('\n'.join(lines))
    print(f'\n[timing] report → {out_path}')


if __name__ == '__main__':
    main()
