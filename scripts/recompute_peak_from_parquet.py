#!/usr/bin/env python
"""SURGICAL backfill: recompute ONLY peak_ceiling_pct + minutes_to_peak.

Why this exists
---------------
The Vercel cron that enriched these two columns computed the peak via a
string-comparison bug (`"9.50" > "10.50"` is True lexicographically), so
`peak_ceiling_pct` / `minutes_to_peak` are corrupted for every row the
cron touched:
  - lottery_finder_fires : from 2026-05-04 onward
  - silent_boom_alerts   : from 2026-05-14 onward

The Python parquet enrich scripts compute these correctly, but they gate
on `enriched_at IS NULL`, so they skip the already-enriched (corrupted)
rows. This script does a TARGETED recompute of ONLY those two columns,
from the authoritative EOD parquet tape, leaving everything else alone:
realized_* columns, enriched_at, scores, tiers are NEVER written.

Single source of truth
-----------------------
The peak / minutes-to-peak logic is NOT re-implemented here. It is reused
by importing the two proven enrich scripts (both are import-safe — each
has an `if __name__ == '__main__'` guard and does no DB/IO at import):

  LOTTERY (per table, EXACT reuse — imported from enrich_lottery_outcomes):
    - parquet loader        : load_parquet_chain_index  (float64 coercion,
                              canceled filter, price>0, sorted chain dict)
    - entry-time + series   : compute_fire_outcomes
                              (entry_ts = fire.entry_time_ct -> UTC;
                               post = chain_df[executed_at >= entry_ts];
                               prices = post['price'].astype(float).tolist();
                               minutes = (executed_at-entry_ts).secs/60)
    - peak / mtp            : peak_ceiling, minutes_to_peak

  SILENT BOOM (imported from enrich_silent_boom_outcomes):
    - parquet loader        : load_chain_tape  (canceled filter, price>0,
                              sorted; NOTE: NO float64 coercion — mirrors
                              the SB script exactly)
    - entry-time + series   : compute_outcomes
                              ENTRY BASIS IS `bucket_ct`, NOT entry_time_ct.
                              See enrich_silent_boom_outcomes.py line 177:
                                  post = chain_df[chain_df['executed_at'] >= bucket_ts]
                              (bucket_ts = bucket_ct -> UTC, line 174-176).
                              peak/mtp via numpy argmax (lines 186-188):
                                  peak_idx = int(np.argmax(prices))
                                  peak_pct = (prices[peak_idx]-entry)/entry*100
                                  mtp = float(minutes[peak_idx])
                              We call compute_outcomes and take ONLY the
                              first two tuple elements (peak, mtp).

Both tables: we compute peak/mtp through each table's OWN proven path and
only persist those two fields.

Data source (--source)
----------------------
Reads from the AUTHORITATIVE UnusualWhales Full Tape by default
(~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet) — a row-faithful
complete capture. Pass `--source bot_eod` to read the less-complete nightly
bot tape (~/Desktop/Bot-Eod-parquet/{date}-trades.parquet) instead, which is
what produced the spurious "decreases" during diagnosis.

Bug-isolation audit (--audit-bug, READ-ONLY)
--------------------------------------------
Proves the peak corruption is a numeric-vs-lexicographic-max artifact,
INDEPENDENT of any data-source question. For each fire it builds the SAME
post-entry price series the recompute uses (via the table's own entry
alignment), then computes peak TWO ways on that IDENTICAL array:
  - numeric  : the correct numeric max (imported peak_ceiling/minutes_to_peak)
  - string   : the cron bug — format every price as f'{p:.4f}' (Postgres
               NUMERIC(12,4) text), take the LEXICOGRAPHIC max, parse back.
The only variable is numeric-max vs string-max. No DB writes; no comparison
to stored values.

Usage
-----
    # dry-run recompute (default, read-only, full_tape source)
    ml/.venv/bin/python scripts/recompute_peak_from_parquet.py --table lottery --date 2026-06-09
    ml/.venv/bin/python scripts/recompute_peak_from_parquet.py --table silent_boom --date 2026-06-09
    ml/.venv/bin/python scripts/recompute_peak_from_parquet.py            # both, full default range

    # bug-isolation audit (read-only proof)
    ml/.venv/bin/python scripts/recompute_peak_from_parquet.py --table both --audit-bug

    # read from the less-complete bot tape instead of the full tape
    ml/.venv/bin/python scripts/recompute_peak_from_parquet.py --source bot_eod --date 2026-06-05

    # actually write (bulk UPDATE of ONLY the two columns)
    WRITE_DB=1 ml/.venv/bin/python scripts/recompute_peak_from_parquet.py
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass
from datetime import date as DateType, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
from psycopg2.extras import execute_values

# scripts/ is sys.path[0] when run as `ml/.venv/bin/python scripts/...`,
# so the sibling imports below (and the enrich scripts' own
# `from _pipeline_retry import ...` / `sys.path.insert(ml/src)`) resolve.
SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from _pipeline_retry import connect_with_retry  # noqa: E402

# --- Reused logic (single source of truth) ---------------------------------
# IMPORTED, not copied. Both modules are import-safe (main() is guarded and
# nothing touches the DB or parquet at import time).
import enrich_lottery_outcomes as lottery_enrich  # noqa: E402
import enrich_silent_boom_outcomes as sb_enrich  # noqa: E402

# Defaults from the bug background.
LOTTERY_DEFAULT_START = '2026-05-04'
SB_DEFAULT_START = '2026-05-14'

# --- Data source selection ------------------------------------------------
# full_tape : the AUTHORITATIVE UnusualWhales Full Tape — a row-faithful,
#             complete capture (the original tape; columns identical to the
#             bot tape, so the existing loaders work unchanged).
# bot_eod   : the LESS-complete nightly bot tape (ws_option_trades-derived).
#             Recomputing from this produced spurious "decreases" because it
#             is missing ticks the full tape has.
# Both globals (PARQUET_DIR / PARQUET_PATTERN) are set in main() from
# --source and are then mirrored onto each enrich module's parquet globals.
SOURCE_DIRS = {
    'full_tape': Path.home() / 'Desktop' / 'Eod-Full-Tape-parquet',
    'bot_eod': Path.home() / 'Desktop' / 'Bot-Eod-parquet',
}
SOURCE_PATTERNS = {
    'full_tape': '{date}-fulltape.parquet',
    'bot_eod': '{date}-trades.parquet',
}
DEFAULT_SOURCE = 'full_tape'

# Module-level mutable; populated in main() from --source. Defaults to the
# authoritative full tape so an arg-less run sources the correct data.
PARQUET_DIR = SOURCE_DIRS[DEFAULT_SOURCE]
PARQUET_PATTERN = SOURCE_PATTERNS[DEFAULT_SOURCE]
ENV_FILE = SCRIPTS_DIR.parent / '.env.local'
_CT_TZ = ZoneInfo('America/Chicago')

# A peak change smaller than this (in percentage points) is treated as
# float noise, not a real correction.
PEAK_EPS = 0.01


def load_env() -> None:
    """Mirror the enrich scripts' .env.local loader."""
    lottery_enrich.ENV_FILE = ENV_FILE  # keep loaders pointed at the same file
    lottery_enrich.load_env()


def configure_source(source: str) -> None:
    """Point this module's parquet globals AND both enrich modules' parquet
    globals at the chosen source's dir + filename pattern.

    The lottery loader (`load_parquet_chain_index`) builds its path from
    `lottery_enrich.PARQUET_DIR` + `lottery_enrich.PARQUET_FILE_PATTERN`, so
    both must be set. The SB loader (`load_chain_tape`) takes an EXPLICIT
    path argument that `recompute_sb` builds via `parquet_path_for` (which
    reads THIS module's PARQUET_DIR/PARQUET_PATTERN), so SB honors the
    pattern through that path — we still set `sb_enrich.PARQUET_DIR` for
    consistency so any incidental glob in that module uses the same dir.
    """
    global PARQUET_DIR, PARQUET_PATTERN
    PARQUET_DIR = SOURCE_DIRS[source]
    PARQUET_PATTERN = SOURCE_PATTERNS[source]

    lottery_enrich.PARQUET_DIR = PARQUET_DIR
    lottery_enrich.PARQUET_FILE_PATTERN = PARQUET_PATTERN
    sb_enrich.PARQUET_DIR = PARQUET_DIR


def today_ct() -> str:
    return datetime.now(_CT_TZ).date().isoformat()


def parquet_path_for(date_str: str) -> Path:
    return PARQUET_DIR / PARQUET_PATTERN.format(date=date_str)


def dates_in_range(start: str, end: str) -> list[str]:
    """All YYYY-MM-DD between start and end (inclusive) that have a parquet.

    Dates with no parquet file are skipped here and logged by the caller —
    we never fabricate ticks for a missing tape.
    """
    out: list[str] = []
    d = DateType.fromisoformat(start)
    end_d = DateType.fromisoformat(end)
    one = pd.Timedelta(days=1)
    cur = pd.Timestamp(d)
    end_ts = pd.Timestamp(end_d)
    while cur <= end_ts:
        out.append(cur.date().isoformat())
        cur = cur + one
    return out


# ---------------------------------------------------------------------------
# Per-table row fetch (rows that ARE already enriched — peak NOT NULL — since
# those are exactly the corrupted ones we are correcting).
# ---------------------------------------------------------------------------


@dataclass
class Row:
    id: int
    chain: str
    entry_ts: pd.Timestamp  # entry_time_ct (lottery) or bucket_ct (SB)
    entry_price: float
    old_peak: float | None
    old_mtp: float | None
    # context for sample lines
    ticker: str
    strike: float | None
    opt_type: str | None
    # realized_eod_pct — only populated by the repair-below-eod fetch
    # (None for the recompute / audit fetch paths). In repair mode the
    # `old_peak` field carries the CURRENT (full-tape) peak we call `ft_peak`.
    eod: float | None = None


def fetch_lottery_rows(conn, target_date: str) -> list[Row]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, entry_time_ct, entry_price,
               peak_ceiling_pct, minutes_to_peak,
               underlying_symbol, strike, option_type
        FROM lottery_finder_fires
        WHERE date = %s AND peak_ceiling_pct IS NOT NULL
        ORDER BY id ASC
        """,
        (target_date,),
    )
    out: list[Row] = []
    for r in cur.fetchall():
        out.append(
            Row(
                id=r[0],
                chain=r[1],
                entry_ts=pd.Timestamp(r[2]),
                entry_price=float(r[3]),
                old_peak=None if r[4] is None else float(r[4]),
                old_mtp=None if r[5] is None else float(r[5]),
                ticker=r[6],
                strike=None if r[7] is None else float(r[7]),
                opt_type=r[8],
            )
        )
    return out


def fetch_sb_rows(conn, target_date: str) -> list[Row]:
    # SB entry basis is bucket_ct (see enrich_silent_boom_outcomes.py L122/L177).
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, bucket_ct, entry_price,
               peak_ceiling_pct, minutes_to_peak,
               underlying_symbol, strike, option_type
        FROM silent_boom_alerts
        WHERE date = %s AND peak_ceiling_pct IS NOT NULL
        ORDER BY id ASC
        """,
        (target_date,),
    )
    out: list[Row] = []
    for r in cur.fetchall():
        out.append(
            Row(
                id=r[0],
                chain=r[1],
                entry_ts=pd.Timestamp(r[2]),
                entry_price=float(r[3]),
                old_peak=None if r[4] is None else float(r[4]),
                old_mtp=None if r[5] is None else float(r[5]),
                ticker=r[6],
                strike=None if r[7] is None else float(r[7]),
                opt_type=r[8],
            )
        )
    return out


# ---------------------------------------------------------------------------
# Repair-below-eod fetch: rows where the full-tape peak ended up BELOW the
# realized EOD return (peak_ceiling_pct < realized_eod_pct - 0.01) — logically
# impossible (the close price was reached, so the true peak must be >= eod).
# Caused by the full tape missing the closing tick. We target ONLY these rows.
# In the returned Row, `old_peak`/`old_mtp` carry the CURRENT full-tape values
# (ft_peak / ft_mtp) and `eod` carries realized_eod_pct.
# ---------------------------------------------------------------------------


def fetch_lottery_below_eod_rows(conn, target_date: str) -> list[Row]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, entry_time_ct, entry_price,
               peak_ceiling_pct, minutes_to_peak,
               underlying_symbol, strike, option_type,
               realized_eod_pct
        FROM lottery_finder_fires
        WHERE date = %s
          AND peak_ceiling_pct IS NOT NULL
          AND realized_eod_pct IS NOT NULL
          AND peak_ceiling_pct < realized_eod_pct - %s
        ORDER BY id ASC
        """,
        (target_date, PEAK_EPS),
    )
    out: list[Row] = []
    for r in cur.fetchall():
        out.append(
            Row(
                id=r[0],
                chain=r[1],
                entry_ts=pd.Timestamp(r[2]),
                entry_price=float(r[3]),
                old_peak=None if r[4] is None else float(r[4]),
                old_mtp=None if r[5] is None else float(r[5]),
                ticker=r[6],
                strike=None if r[7] is None else float(r[7]),
                opt_type=r[8],
                eod=None if r[9] is None else float(r[9]),
            )
        )
    return out


def fetch_sb_below_eod_rows(conn, target_date: str) -> list[Row]:
    # SB entry basis is bucket_ct (see enrich_silent_boom_outcomes.py L122/L177).
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, option_chain_id, bucket_ct, entry_price,
               peak_ceiling_pct, minutes_to_peak,
               underlying_symbol, strike, option_type,
               realized_eod_pct
        FROM silent_boom_alerts
        WHERE date = %s
          AND peak_ceiling_pct IS NOT NULL
          AND realized_eod_pct IS NOT NULL
          AND peak_ceiling_pct < realized_eod_pct - %s
        ORDER BY id ASC
        """,
        (target_date, PEAK_EPS),
    )
    out: list[Row] = []
    for r in cur.fetchall():
        out.append(
            Row(
                id=r[0],
                chain=r[1],
                entry_ts=pd.Timestamp(r[2]),
                entry_price=float(r[3]),
                old_peak=None if r[4] is None else float(r[4]),
                old_mtp=None if r[5] is None else float(r[5]),
                ticker=r[6],
                strike=None if r[7] is None else float(r[7]),
                opt_type=r[8],
                eod=None if r[9] is None else float(r[9]),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Per-table recompute of (peak, mtp). Each delegates to the table's OWN
# proven loader + compute path so the alignment matches the live enrich.
# ---------------------------------------------------------------------------


def recompute_lottery(
    rows: list[Row], target_date: str
) -> dict[int, tuple[float, float]]:
    """chain_id -> sorted DataFrame via the lottery loader, then peak/mtp via
    compute_fire_outcomes (entry_time_ct basis). Returns {id: (peak, mtp)}
    only for rows with post-entry ticks; rows with no ticks are omitted.

    Parquet globals are set once in configure_source(); this delegates to
    lottery_enrich.load_parquet_chain_index which reads those globals.
    """
    chains = {r.chain for r in rows}
    chain_index = lottery_enrich.load_parquet_chain_index(target_date, chains)

    result: dict[int, tuple[float, float]] = {}
    for r in rows:
        chain_df = chain_index.get(r.chain)
        if chain_df is None:
            continue
        fire = lottery_enrich.Fire(
            id=r.id,
            option_chain_id=r.chain,
            entry_time_ct=r.entry_ts,
            entry_price=r.entry_price,
        )
        res = lottery_enrich.compute_fire_outcomes(fire, chain_df)
        if res is None:
            continue
        # compute_fire_outcomes -> (trail, hard30, tier50, eod, peak, mtp)
        _, _, _, _, peak, mtp = res
        result[r.id] = (peak, mtp)
    return result


def recompute_sb(
    rows: list[Row], target_date: str
) -> dict[int, tuple[float, float]]:
    """SB tape via load_chain_tape, peak/mtp via compute_outcomes
    (bucket_ct basis, numpy-argmax peak). Returns {id: (peak, mtp)}.

    The path is built from THIS module's PARQUET_DIR/PARQUET_PATTERN
    (set in configure_source) and passed explicitly to load_chain_tape,
    so SB reads the chosen source's file (e.g. the fulltape) directly.
    """
    path = parquet_path_for(target_date)
    chain_ids = list({r.chain for r in rows})
    tape = sb_enrich.load_chain_tape(path, chain_ids)
    chain_index = dict(iter(tape.groupby('option_chain_id', sort=False)))

    result: dict[int, tuple[float, float]] = {}
    for r in rows:
        chain_df = chain_index.get(r.chain)
        if chain_df is None:
            continue
        res = sb_enrich.compute_outcomes(chain_df, r.entry_ts, r.entry_price)
        if res is None:
            continue
        # compute_outcomes -> (peak, mtp, r30, r60, r120, eod, trail30)
        peak, mtp = res[0], res[1]
        result[r.id] = (peak, mtp)
    return result


# ---------------------------------------------------------------------------
# Bug-isolation AUDIT (read-only): prove the peak corruption is a
# numeric-vs-lexicographic-max artifact, independent of any data-source
# question. For each fire we build the SAME post-entry price series the
# recompute uses (via the table's own entry alignment), then compute peak
# TWO ways on that IDENTICAL array — the ONLY variable is numeric-max vs
# string(lexicographic)-max. No DB writes, no comparison to stored values.
# ---------------------------------------------------------------------------


@dataclass
class AuditRow:
    """One fire audited two ways on an identical price series."""

    id: int
    entry_price: float
    peak_numeric: float
    peak_string: float
    mtp_numeric: float
    mtp_string: float
    n_ticks: int
    ticker: str
    strike: float | None
    opt_type: str | None
    date: str


def _string_bug_peak(
    prices: list[float], minutes: list[float], entry: float
) -> tuple[float, float]:
    """Replicate the Vercel cron's bug EXACTLY on the given price series.

    The cron read ws_option_trades.price, a NUMERIC(12,4) that Neon returns
    as a STRING (e.g. "9.5000"), and compared with bare `>` — which in
    JS/Postgres-text is LEXICOGRAPHIC, not numeric. We reproduce that by
    formatting every price to its 4-decimal text form (what NUMERIC(12,4)
    serialises to), taking Python's `max()` over those strings (Python str
    max == lexicographic), then parsing the winning string back to float.

    Returns (peak_pct, minutes_to_peak) for the lexicographic-max tick.
    """
    if entry <= 0 or len(prices) == 0:
        return 0.0, 0.0
    # 4dp text form == Postgres NUMERIC(12,4) serialisation.
    str_prices = [f'{p:.4f}' for p in prices]
    lex_max = max(str_prices)  # Python string max == lexicographic
    # First tick whose 4dp string equals the lexicographic max (the cron
    # picked the first occurrence on a strict `>` scan — ties don't advance).
    lex_idx = str_prices.index(lex_max)
    peak_px = float(lex_max)
    peak_pct = ((peak_px - entry) / entry) * 100.0
    mtp = minutes[lex_idx] if lex_idx < len(minutes) else 0.0
    return peak_pct, mtp


def _lottery_series(
    r: Row, chain_df: pd.DataFrame
) -> tuple[list[float], list[float]] | None:
    """Replicate compute_fire_outcomes' EXACT post-entry alignment for the
    lottery table (entry_time_ct basis): post = chain[executed_at >= entry],
    prices = post.price as float, minutes = (executed_at - entry)/60.
    Returns (prices, minutes) built ONCE so both peak computations share it.
    """
    entry_ts = r.entry_ts
    if entry_ts.tz is None:
        entry_ts = entry_ts.tz_localize('UTC')
    post = chain_df[chain_df['executed_at'] >= entry_ts]
    if len(post) == 0:
        return None
    prices = post['price'].astype(float).tolist()
    minutes = (
        (post['executed_at'] - entry_ts).dt.total_seconds() / 60.0
    ).tolist()
    return prices, minutes


def _sb_series(
    r: Row, chain_df: pd.DataFrame
) -> tuple[list[float], list[float]] | None:
    """Replicate compute_outcomes' EXACT post-entry alignment for the SB
    table (bucket_ct basis): post = chain[executed_at >= bucket], prices =
    post.price as float, minutes = (executed_at - bucket)/60.
    Returns (prices, minutes) built ONCE so both peak computations share it.
    """
    if r.entry_price <= 0 or chain_df.empty:
        return None
    bucket_ts = r.entry_ts
    if bucket_ts.tz is None:
        bucket_ts = bucket_ts.tz_localize('UTC')
    post = chain_df[chain_df['executed_at'] >= bucket_ts]
    if post.empty:
        return None
    prices = post['price'].astype(float).tolist()
    minutes = (
        (post['executed_at'] - bucket_ts).dt.total_seconds() / 60.0
    ).tolist()
    return prices, minutes


def audit_lottery(rows: list[Row], target_date: str) -> list[AuditRow]:
    """Per-fire string-vs-numeric peak audit for lottery_finder_fires."""
    chains = {r.chain for r in rows}
    chain_index = lottery_enrich.load_parquet_chain_index(target_date, chains)
    out: list[AuditRow] = []
    for r in rows:
        chain_df = chain_index.get(r.chain)
        if chain_df is None:
            continue
        series = _lottery_series(r, chain_df)
        if series is None:
            continue
        out.append(_audit_one(r, series, target_date))
    return out


def audit_sb(rows: list[Row], target_date: str) -> list[AuditRow]:
    """Per-fire string-vs-numeric peak audit for silent_boom_alerts."""
    path = parquet_path_for(target_date)
    chain_ids = list({r.chain for r in rows})
    tape = sb_enrich.load_chain_tape(path, chain_ids)
    if tape.empty:
        return []
    chain_index = dict(iter(tape.groupby('option_chain_id', sort=False)))
    out: list[AuditRow] = []
    for r in rows:
        chain_df = chain_index.get(r.chain)
        if chain_df is None:
            continue
        series = _sb_series(r, chain_df)
        if series is None:
            continue
        out.append(_audit_one(r, series, target_date))
    return out


def _audit_one(
    r: Row, series: tuple[list[float], list[float]], target_date: str
) -> AuditRow:
    """Compute peak TWO ways on the IDENTICAL (prices, minutes) series.

    Numeric side reuses the imported peak_ceiling / minutes_to_peak (the
    proven, correct path). String side replicates the cron's lexicographic
    bug. Only the comparison (numeric-max vs string-max) differs.
    """
    prices, minutes = series
    peak_num = lottery_enrich.peak_ceiling(prices, r.entry_price)
    mtp_num = lottery_enrich.minutes_to_peak(prices, minutes)
    peak_str, mtp_str = _string_bug_peak(prices, minutes, r.entry_price)
    return AuditRow(
        id=r.id,
        entry_price=r.entry_price,
        peak_numeric=peak_num,
        peak_string=peak_str,
        mtp_numeric=mtp_num,
        mtp_string=mtp_str,
        n_ticks=len(prices),
        ticker=r.ticker,
        strike=r.strike,
        opt_type=r.opt_type,
        date=target_date,
    )


def report_audit(table_key: str, audited: list[AuditRow]) -> None:
    """Print the clean string-vs-numeric proof for one table."""
    print(f'\n[{table_key}] --- BUG AUDIT (string-vs-numeric peak) ---')
    n = len(audited)
    if n == 0:
        print('  no rows audited (no post-entry ticks in source)')
        return

    affected = [
        a for a in audited if abs(a.peak_numeric - a.peak_string) > PEAK_EPS
    ]
    n_aff = len(affected)
    # Direction: the bug should make string PEAK <= numeric PEAK always
    # (lexicographic max of 4dp strings can never exceed the true numeric
    # max). Count any violations explicitly so we'd notice a logic error.
    str_lt = sum(1 for a in affected if a.peak_string < a.peak_numeric)
    str_gt = sum(1 for a in affected if a.peak_string > a.peak_numeric)

    print(f'  rows audited         : {n:,}')
    print(
        f'  bug-changed rows     : {n_aff:,}  '
        f'({100.0 * n_aff / n:.1f}% of audited)'
    )
    print(f'    string  < numeric  : {str_lt:,}  (understated — expected)')
    print(f'    string  > numeric  : {str_gt:,}  (OVERSTATED — unexpected!)')

    if affected:
        understated = sorted(
            a.peak_numeric - a.peak_string for a in affected
        )
        m = len(understated)
        median = understated[m // 2]
        p90 = understated[min(m - 1, int(round(0.9 * (m - 1))))]
        mx = understated[-1]
        print(
            f'  understatement (pp)  : '
            f'median {median:.2f}  p90 {p90:.2f}  max {mx:.2f}'
        )
        # How often the bug also moved minutes_to_peak.
        mtp_moved = sum(
            1 for a in affected if abs(a.mtp_numeric - a.mtp_string) > 1e-9
        )
        print(
            f'  mtp also moved       : {mtp_moved:,} of {n_aff:,} '
            f'bug-changed rows'
        )

    samples = affected[:12]
    if samples:
        print(f'\n[{table_key}] sample bug-changed rows (up to 12):')
        for a in samples:
            strike_s = f'{a.strike:g}' if a.strike is not None else '?'
            typ = a.opt_type or '?'
            delta = a.peak_numeric - a.peak_string
            print(
                f'    {a.ticker} {strike_s}{typ}: '
                f'string {a.peak_string:.2f}% vs numeric {a.peak_numeric:.2f}% '
                f'(Δ {delta:+.2f} understated), {a.date}'
            )


def run_audit_table(
    conn, table_key: str, start: str, end: str
) -> list[AuditRow]:
    """READ-ONLY audit driver for one table over a date range. Returns the
    full list of AuditRows so the caller can aggregate across tables/dates.
    """
    if table_key == 'lottery':
        db_table = 'lottery_finder_fires'
        fetch = fetch_lottery_rows
        audit = audit_lottery
    else:
        db_table = 'silent_boom_alerts'
        fetch = fetch_sb_rows
        audit = audit_sb

    print(f'\n{"=" * 68}')
    print(f'[{table_key}] AUDIT {db_table}  range {start} .. {end}')
    print('=' * 68)

    all_audited: list[AuditRow] = []
    missing_parquet_dates: list[str] = []
    for date_str in dates_in_range(start, end):
        path = parquet_path_for(date_str)
        if not path.exists():
            missing_parquet_dates.append(date_str)
            continue
        rows = fetch(conn, date_str)
        if not rows:
            continue
        audited = audit(rows, date_str)
        all_audited.extend(audited)

    if missing_parquet_dates:
        print(
            f'  dates w/o parquet    : {len(missing_parquet_dates)} '
            f'(skipped): {", ".join(missing_parquet_dates)}'
        )

    report_audit(table_key, all_audited)
    return all_audited


# ---------------------------------------------------------------------------
# Diff + write
# ---------------------------------------------------------------------------


@dataclass
class Change:
    id: int
    new_peak: float
    new_mtp: float
    old_peak: float | None
    old_mtp: float | None
    ticker: str
    strike: float | None
    opt_type: str | None


def is_change(
    old_peak: float | None,
    old_mtp: float | None,
    new_peak: float,
    new_mtp: float,
) -> bool:
    # The string-compare bug corrupts the peak VALUE and minutes_to_peak
    # TOGETHER (both come from the same argmax over the price tape): if the
    # string max equals the numeric max, both peak and mtp are already
    # correct. So a row whose peak is UNCHANGED was not bug-corrupted, and
    # its mtp differs (if at all) only by sub-second float jitter from the
    # parquet-vs-ws data source -- not corruption. We therefore rewrite ONLY
    # rows whose peak actually moved, and for those write BOTH columns (the
    # corrected peak and its matching mtp). This keeps the backfill surgical:
    # exactly the corrupted rows, nothing else churned.
    return old_peak is None or abs(new_peak - old_peak) > PEAK_EPS


def write_updates(conn, table: str, changes: list[Change]) -> int:
    """Bulk UPDATE of ONLY peak_ceiling_pct + minutes_to_peak.

    Never touches enriched_at, realized_*, scores, or tiers.
    """
    if not changes:
        return 0
    cur = conn.cursor()
    payload = [(c.id, c.new_peak, c.new_mtp) for c in changes]
    execute_values(
        cur,
        f"""
        UPDATE {table} AS t
        SET peak_ceiling_pct = v.peak,
            minutes_to_peak  = v.mtp
        FROM (VALUES %s) AS v(id, peak, mtp)
        WHERE t.id = v.id
        """,
        payload,
        template='(%s::bigint, %s::numeric, %s::numeric)',
        page_size=500,
    )
    conn.commit()
    return cur.rowcount


# ---------------------------------------------------------------------------
# Per-table driver
# ---------------------------------------------------------------------------


def run_table(
    conn,
    table_key: str,  # 'lottery' | 'silent_boom'
    start: str,
    end: str,
    write_db: bool,
) -> None:
    if table_key == 'lottery':
        db_table = 'lottery_finder_fires'
        fetch = fetch_lottery_rows
        recompute = recompute_lottery
    else:
        db_table = 'silent_boom_alerts'
        fetch = fetch_sb_rows
        recompute = recompute_sb

    print(f'\n{"=" * 68}')
    print(f'[{table_key}] {db_table}  range {start} .. {end}')
    print('=' * 68)

    examined = 0
    would_change = 0
    peak_up = 0
    peak_down = 0
    only_mtp = 0
    no_parquet_ticks = 0
    missing_parquet_dates: list[str] = []
    samples: list[Change] = []
    updated_total = 0

    for date_str in dates_in_range(start, end):
        path = parquet_path_for(date_str)
        if not path.exists():
            missing_parquet_dates.append(date_str)
            continue

        rows = fetch(conn, date_str)
        if not rows:
            # Free nothing; just move on.
            continue

        # Recompute peak/mtp for the day, then free the parquet frame by
        # letting the chain_index go out of scope at the end of the call.
        recomputed = recompute(rows, date_str)

        date_changes: list[Change] = []
        for r in rows:
            examined += 1
            got = recomputed.get(r.id)
            if got is None:
                # Chain missing in parquet OR no post-entry ticks. Leave as-is.
                no_parquet_ticks += 1
                continue
            new_peak, new_mtp = got
            if not is_change(r.old_peak, r.old_mtp, new_peak, new_mtp):
                continue
            would_change += 1
            ch = Change(
                id=r.id,
                new_peak=new_peak,
                new_mtp=new_mtp,
                old_peak=r.old_peak,
                old_mtp=r.old_mtp,
                ticker=r.ticker,
                strike=r.strike,
                opt_type=r.opt_type,
            )
            date_changes.append(ch)

            # Direction breakdown (the "bug corrected upward" signal).
            if r.old_peak is not None and abs(new_peak - r.old_peak) > PEAK_EPS:
                if new_peak > r.old_peak:
                    peak_up += 1
                else:
                    peak_down += 1
            else:
                only_mtp += 1

            if len(samples) < 12:
                samples.append(ch)

        if write_db and date_changes:
            n = write_updates(conn, db_table, date_changes)
            updated_total += n
            print(f'  [{date_str}] UPDATED {n} rows')
        elif date_changes:
            print(
                f'  [{date_str}] would change {len(date_changes)} '
                f'of {len(rows)} examined'
            )

    # ---- report ----
    print(f'\n[{table_key}] --- summary ---')
    print(f'  rows examined        : {examined:,}')
    print(f'  would-change         : {would_change:,}')
    print(f'    peak increased     : {peak_up:,}  (bug corrected upward)')
    print(f'    peak decreased     : {peak_down:,}')
    print(f'    only mtp changed   : {only_mtp:,}')
    print(f'  no_parquet_ticks     : {no_parquet_ticks:,}  (left as-is)')
    if missing_parquet_dates:
        print(
            f'  dates w/o parquet    : {len(missing_parquet_dates)} '
            f'(skipped): {", ".join(missing_parquet_dates)}'
        )

    if samples:
        print(f'\n[{table_key}] sample changes (up to 12):')
        for c in samples:
            strike_s = (
                f'{c.strike:g}' if c.strike is not None else '?'
            )
            typ = c.opt_type or '?'
            op = '?' if c.old_peak is None else f'{c.old_peak:.2f}'
            np_ = f'{c.new_peak:.2f}'
            delta = (
                '   n/a'
                if c.old_peak is None
                else f'{c.new_peak - c.old_peak:+.2f}'
            )
            om = 'NULL' if c.old_mtp is None else f'{c.old_mtp:g}'
            nm = f'{c.new_mtp:g}'
            print(
                f'    {c.ticker} {strike_s}{typ}: '
                f'peak {op}->{np_} ({delta}), mtp {om}->{nm}'
            )

    if write_db:
        print(f'\n[{table_key}] WROTE {updated_total:,} rows to {db_table}')
    else:
        print(f'\n[{table_key}] DRY RUN — no writes')


# ---------------------------------------------------------------------------
# Repair-below-eod driver. For the small set of rows whose full-tape peak is
# below the realized EOD return, recompute peak/mtp from the BOT-EOD tape (it
# had the higher closing tick the full tape was missing) and keep whichever
# peak is HIGHER — closest to the true intraday high. Only rows where bot-eod
# wins become writes; everything else is left untouched. Writes ONLY the two
# peak columns via the shared write_updates path.
# ---------------------------------------------------------------------------


@dataclass
class StillBelow:
    """A targeted row that remains below EOD even after the bot-eod max
    (the closing tick was missing from BOTH tapes). Reported, never auto-floored.
    """

    id: int
    ticker: str
    strike: float | None
    opt_type: str | None
    date: str
    ft_peak: float
    bot_eod_peak: float | None  # None == chain absent from bot-eod tape
    eod: float


@dataclass
class RepairSample:
    id: int
    ticker: str
    strike: float | None
    opt_type: str | None
    date: str
    ft_peak: float
    bot_eod_peak: float | None
    eod: float
    chosen: str  # 'bot_eod' (write) | 'full_tape' (keep)


def run_repair_table(
    conn,
    table_key: str,  # 'lottery' | 'silent_boom'
    start: str,
    end: str,
    write_db: bool,
) -> None:
    """Repair the peak<eod rows for one table by maxing full-tape vs bot-eod.

    Source is FORCED to bot_eod here (configure_source('bot_eod') is called by
    main() before this runs), regardless of --source. We only ever touch rows
    returned by the peak<eod fetch — never any other row.
    """
    if table_key == 'lottery':
        db_table = 'lottery_finder_fires'
        fetch = fetch_lottery_below_eod_rows
        recompute = recompute_lottery
    else:
        db_table = 'silent_boom_alerts'
        fetch = fetch_sb_below_eod_rows
        recompute = recompute_sb

    print(f'\n{"=" * 68}')
    print(f'[{table_key}] REPAIR peak<eod  {db_table}  range {start} .. {end}')
    print('=' * 68)

    targeted = 0
    bot_eod_wins = 0  # bot-eod raised peak above full-tape -> a write
    kept_full_tape = 0  # full-tape peak still >= bot-eod -> no change
    no_bot_eod_ticks = 0  # chain absent from bot-eod tape -> unchanged
    missing_parquet_dates: list[str] = []
    still_below: list[StillBelow] = []
    samples: list[RepairSample] = []
    updated_total = 0

    for date_str in dates_in_range(start, end):
        path = parquet_path_for(date_str)
        if not path.exists():
            missing_parquet_dates.append(date_str)
            # A missing bot-eod tape means every targeted row that date has no
            # bot-eod ticks; fetch so we can count + report them as such.
            rows = fetch(conn, date_str)
            for r in rows:
                targeted += 1
                no_bot_eod_ticks += 1
                ft_peak = r.old_peak if r.old_peak is not None else 0.0
                eod = r.eod if r.eod is not None else 0.0
                if eod - ft_peak > PEAK_EPS:
                    still_below.append(
                        StillBelow(
                            id=r.id,
                            ticker=r.ticker,
                            strike=r.strike,
                            opt_type=r.opt_type,
                            date=date_str,
                            ft_peak=ft_peak,
                            bot_eod_peak=None,
                            eod=eod,
                        )
                    )
            continue

        rows = fetch(conn, date_str)
        if not rows:
            continue

        # Recompute peak/mtp from the bot-eod tape for ONLY these ids via the
        # SAME proven path. {id: (peak, mtp)}; ids whose chain isn't in the
        # bot-eod tape are omitted from the dict.
        bot_eod_vals = recompute(rows, date_str)

        date_changes: list[Change] = []
        for r in rows:
            targeted += 1
            ft_peak = r.old_peak if r.old_peak is not None else 0.0
            ft_mtp = r.old_mtp if r.old_mtp is not None else 0.0
            eod = r.eod if r.eod is not None else 0.0

            got = bot_eod_vals.get(r.id)
            if got is None:
                # Chain absent from the bot-eod tape — leave unchanged.
                no_bot_eod_ticks += 1
                bot_eod_peak: float | None = None
                final_peak = ft_peak
                chosen = 'full_tape'
            else:
                bot_eod_peak, bot_eod_mtp = got
                if bot_eod_peak > ft_peak + PEAK_EPS:
                    bot_eod_wins += 1
                    final_peak = bot_eod_peak
                    chosen = 'bot_eod'
                    date_changes.append(
                        Change(
                            id=r.id,
                            new_peak=bot_eod_peak,
                            new_mtp=bot_eod_mtp,
                            old_peak=ft_peak,
                            old_mtp=ft_mtp,
                            ticker=r.ticker,
                            strike=r.strike,
                            opt_type=r.opt_type,
                        )
                    )
                else:
                    kept_full_tape += 1
                    final_peak = ft_peak
                    chosen = 'full_tape'

            # Even after taking the max, does this row STILL sit below EOD?
            # (Neither tape had the closing tick.) Report, do NOT auto-floor.
            if eod - final_peak > PEAK_EPS:
                still_below.append(
                    StillBelow(
                        id=r.id,
                        ticker=r.ticker,
                        strike=r.strike,
                        opt_type=r.opt_type,
                        date=date_str,
                        ft_peak=ft_peak,
                        bot_eod_peak=bot_eod_peak,
                        eod=eod,
                    )
                )

            if len(samples) < 15:
                samples.append(
                    RepairSample(
                        id=r.id,
                        ticker=r.ticker,
                        strike=r.strike,
                        opt_type=r.opt_type,
                        date=date_str,
                        ft_peak=ft_peak,
                        bot_eod_peak=bot_eod_peak,
                        eod=eod,
                        chosen=chosen,
                    )
                )

        if write_db and date_changes:
            n = write_updates(conn, db_table, date_changes)
            updated_total += n
            print(f'  [{date_str}] UPDATED {n} rows (bot-eod raised peak)')
        elif date_changes:
            print(
                f'  [{date_str}] would write {len(date_changes)} '
                f'of {len(rows)} targeted (bot-eod raised peak)'
            )

    # ---- report ----
    print(f'\n[{table_key}] --- repair summary ---')
    print(f'  rows targeted (peak<eod) : {targeted:,}')
    print(
        f'  bot-eod raised peak      : {bot_eod_wins:,}  '
        f'(= writes)'
    )
    print(f'  kept full-tape value     : {kept_full_tape:,}')
    print(f'  no_bot_eod_ticks         : {no_bot_eod_ticks:,}  (left as-is)')
    print(
        f'  STILL < eod after max    : {len(still_below):,}  '
        f'(reported below, NOT auto-floored)'
    )
    if missing_parquet_dates:
        print(
            f'  dates w/o bot-eod tape   : {len(missing_parquet_dates)} '
            f'(skipped): {", ".join(missing_parquet_dates)}'
        )

    if still_below:
        print(
            f'\n[{table_key}] rows STILL below eod after bot-eod max '
            f'(owner decides separately):'
        )
        for s in still_below:
            strike_s = f'{s.strike:g}' if s.strike is not None else '?'
            typ = s.opt_type or '?'
            be = 'no-tape' if s.bot_eod_peak is None else f'{s.bot_eod_peak:.2f}'
            print(
                f'    id={s.id} {s.ticker} {strike_s}{typ} {s.date}: '
                f'ft_peak {s.ft_peak:.2f} / bot_eod {be} / eod {s.eod:.2f}'
            )

    if samples:
        print(f'\n[{table_key}] sample targeted rows (up to 15):')
        for s in samples:
            strike_s = f'{s.strike:g}' if s.strike is not None else '?'
            typ = s.opt_type or '?'
            be = 'no-tape' if s.bot_eod_peak is None else f'{s.bot_eod_peak:.2f}'
            print(
                f'    id={s.id} {s.ticker} {strike_s}{typ} {s.date}: '
                f'{s.ft_peak:.2f} / {be} / {s.eod:.2f} -> {s.chosen}'
            )

    if write_db:
        print(f'\n[{table_key}] WROTE {updated_total:,} rows to {db_table}')
    else:
        print(f'\n[{table_key}] DRY RUN — no writes')


def report_audit_aggregate(audited: list[AuditRow]) -> None:
    """Cross-table aggregate of the bug audit (the headline proof numbers)."""
    print(f'\n{"=" * 68}')
    print('[AUDIT] AGGREGATE across all tables / dates')
    print('=' * 68)
    n = len(audited)
    if n == 0:
        print('  no rows audited')
        return
    affected = [
        a for a in audited if abs(a.peak_numeric - a.peak_string) > PEAK_EPS
    ]
    n_aff = len(affected)
    str_lt = sum(1 for a in affected if a.peak_string < a.peak_numeric)
    str_gt = sum(1 for a in affected if a.peak_string > a.peak_numeric)
    print(f'  total audited        : {n:,}')
    print(
        f'  total bug-affected   : {n_aff:,}  '
        f'({100.0 * n_aff / n:.1f}% of audited)'
    )
    print(f'  direction split      : string<numeric {str_lt:,}, '
          f'string>numeric {str_gt:,}')
    if affected:
        understated = sorted(a.peak_numeric - a.peak_string for a in affected)
        m = len(understated)
        median = understated[m // 2]
        p90 = understated[min(m - 1, int(round(0.9 * (m - 1))))]
        mx = understated[-1]
        print(
            f'  understatement (pp)  : '
            f'median {median:.2f}  p90 {p90:.2f}  max {mx:.2f}'
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--table',
        choices=['lottery', 'silent_boom', 'both'],
        default='both',
    )
    parser.add_argument('--start-date', help='YYYY-MM-DD (per-table default)')
    parser.add_argument('--end-date', help='YYYY-MM-DD (default: today CT)')
    parser.add_argument(
        '--date',
        help='YYYY-MM-DD single-date override (sets start == end).',
    )
    parser.add_argument(
        '--source',
        choices=sorted(SOURCE_DIRS.keys()),
        default=DEFAULT_SOURCE,
        help=(
            'Parquet data source. full_tape = authoritative UW Full Tape '
            '(default); bot_eod = the less-complete nightly bot tape.'
        ),
    )
    parser.add_argument(
        '--audit-bug',
        action='store_true',
        help=(
            'READ-ONLY bug-isolation mode. For each fire, build the SAME '
            'post-entry price series the recompute uses, then compute peak '
            'TWO ways on that identical array (numeric-max vs cron string '
            'lexicographic-max) and report how many rows the bug changed, '
            'the understatement magnitude, and direction. No DB writes; no '
            'comparison to stored values.'
        ),
    )
    parser.add_argument(
        '--repair-below-eod',
        action='store_true',
        help=(
            'TARGETED repair mode for rows whose full-tape peak ended up '
            'BELOW realized_eod_pct (peak_ceiling_pct < realized_eod_pct '
            '- 0.01) — logically impossible. Forces the bot_eod source '
            '(regardless of --source) and, for ONLY those rows, recomputes '
            'peak/mtp from the bot-eod tape and keeps whichever peak is '
            'HIGHER. Only rows where bot-eod wins are written (peak + mtp '
            'columns only). Dry-run unless WRITE_DB=1.'
        ),
    )
    args = parser.parse_args()

    if args.date:
        DateType.fromisoformat(args.date)  # validate
    if args.start_date:
        DateType.fromisoformat(args.start_date)
    if args.end_date:
        DateType.fromisoformat(args.end_date)

    if args.repair_below_eod and args.audit_bug:
        sys.exit('--repair-below-eod and --audit-bug are mutually exclusive.')

    # The repair mode is ONLY meaningful against the bot-eod tape (it holds
    # the closing tick the full tape was missing), so force it regardless of
    # --source — the recompute path reads these globals.
    effective_source = 'bot_eod' if args.repair_below_eod else args.source
    if args.repair_below_eod and args.source != 'bot_eod':
        print(
            f'[recompute-peak] --repair-below-eod forces source=bot_eod '
            f'(ignoring --source {args.source})'
        )

    # Wire the chosen source's dir + pattern onto this module AND both
    # enrich modules' parquet globals before any load happens.
    configure_source(effective_source)
    print(
        f'[recompute-peak] source={effective_source}  '
        f'dir={PARQUET_DIR}  pattern={PARQUET_PATTERN}'
    )

    write_db = bool(int(os.environ.get('WRITE_DB', '0')))
    if args.audit_bug and write_db:
        # The audit is the clean read-only proof; never let WRITE_DB leak in.
        sys.exit('--audit-bug is read-only; do not set WRITE_DB with it.')

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    tables = (
        ['lottery', 'silent_boom'] if args.table == 'both' else [args.table]
    )
    end_default = args.end_date or today_ct()

    def range_for(tk: str) -> tuple[str, str]:
        if args.date:
            return args.date, args.date
        if args.start_date:
            start = args.start_date
        else:
            start = (
                LOTTERY_DEFAULT_START if tk == 'lottery' else SB_DEFAULT_START
            )
        return start, end_default

    conn = connect_with_retry(db_url)
    audited_all: list[AuditRow] = []
    try:
        for tk in tables:
            start, end = range_for(tk)
            if args.audit_bug:
                audited_all.extend(run_audit_table(conn, tk, start, end))
            elif args.repair_below_eod:
                run_repair_table(conn, tk, start, end, write_db)
            else:
                run_table(conn, tk, start, end, write_db)
    finally:
        conn.close()

    if args.audit_bug:
        if len(tables) > 1:
            report_audit_aggregate(audited_all)
        print('\n[recompute-peak] AUDIT complete — read-only, no writes.')
    elif args.repair_below_eod and not write_db:
        print(
            '\n[recompute-peak] REPAIR DRY RUN complete — '
            'set WRITE_DB=1 to persist.'
        )
    elif not write_db:
        print('\n[recompute-peak] DRY RUN complete — set WRITE_DB=1 to persist.')


if __name__ == '__main__':
    main()
