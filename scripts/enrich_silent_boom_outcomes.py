#!/usr/bin/env python
"""Enrich silent_boom_alerts with peak/realized exits from parquet.

For each unenriched alert (enriched_at IS NULL), reads the post-spike
tick stream from the day's parquet and computes:
  - peak_ceiling_pct        (max post-bucket return %, look-ahead reference)
  - minutes_to_peak         (offset of the peak tick from the bucket start)
  - realized_30m_pct        (return at +30m from bucket start)
  - realized_60m_pct        (return at +60m)
  - realized_120m_pct       (return at +120m)
  - realized_eod_pct        (return at last tick of the day)
  - realized_trail30_10_pct (peak-trail exit: activate at +30%, trail 10pp)

Mirrors the lottery_finder enrichment pattern (enrich_lottery_outcomes.py).
Read-only on parquet, writes to silent_boom_alerts.

The Vercel enrich cron writes the same rows, so every write here is
conditional and tagged, and every count is what the database says it wrote.
outcome_source names the archive ('bot_eod' for the Bot-EOD trades archive,
'fulltape' for the Full Tape) and outcome_version says which computation.

The Full Tape has the final say over outcomes (owner, 2026-11-06). The
websocket feed drops and cannot replay, so a cron outcome may be missing
prints. Written from the Full Tape (as the sister script
enrich_silent_boom_outcomes_fulltape.py does), an outcome replaces whatever
another writer left whenever the tape can price the alert, and sets
outcome_tape_version, the marker of the pass that
examined the row (NULL: none has). An alert the tape cannot price (no chain,
no print at or after the bucket, an entry price that is not usable) keeps any
value another writer left: the row is only marked examined, so it is not
picked again until OUTCOME_VERSION changes; the one thing the keep adds is an
enriched_at when the row has none. With no prior outcome it is also tagged
'fulltape' with the outcomes left NULL (tried, not pending). The cron writes
only `enriched_at IS NULL` rows and the tape sets enriched_at, so no cron can
overwrite the tape. The Bot-EOD archive only fills: it writes alerts nobody
has filled, never replaces a value and never sets the marker.

`--backfill-mode` gates the SELECT on `realized_trail30_10_pct IS NULL`
instead of `enriched_at IS NULL`, so rows enriched BEFORE migration #150
landed (which have enriched_at populated but trail NULL) get picked up
without resetting enriched_at on the table. Use this once after the
column is added, then revert to the default flow. Its writes are the
source's like any other, so the Bot-EOD archive no longer re-writes a row
that already holds a peak.

`--select {pending,empty,all}` (default pending) picks the alerts the run
works on and, with --all-unenriched, the dates (see OUTCOME_WORK). It has no
meaning together with --backfill-mode, which has its own select, so only
pending goes with that flag. `--dry-run` computes everything and writes
nothing, and every summary line says "would".

Usage:
    ml/.venv/Scripts/python scripts/enrich_silent_boom_outcomes.py --parquet-dir <bot-eod-dir>
    ml/.venv/Scripts/python scripts/enrich_silent_boom_outcomes.py \\
        --parquet-dir <bot-eod-dir> --date 2026-05-07
    ml/.venv/Scripts/python scripts/enrich_silent_boom_outcomes.py \\
        --parquet-dir <bot-eod-dir> --backfill-mode
    ml/.venv/Scripts/python scripts/enrich_silent_boom_outcomes.py \\
        --r2 --all-unenriched --select all --dry-run

The tape comes from one of two places, and exactly one is required.
--parquet-dir is the Bot-EOD archive, the directory of
{date}-trades.parquet files (no default; the Makefile passes its
PARQUET_DIR). --r2 reads the Full Tape lake in R2 instead (the four R2_*
variables, from the environment or .env.local), one day at a time through a
temp directory that is deleted when the run ends. For a local Full Tape
archive use scripts/enrich_silent_boom_outcomes_fulltape.py.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import shutil
import sys
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd
from psycopg2.extras import execute_values

from _cli_paths import existing_dir, format_dates, load_env_file, warn_missing_archive
from _pipeline_retry import connect_with_retry

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / '.env.local'

PARQUET_FORMATS = {
    'trades': '{date}-trades.parquet',
    'fulltape': '{date}-fulltape.parquet',
}
# Which archive a format reads, as outcome_source names it (migration #201's
# silent_boom_alerts_outcome_source_chk allows these two from a script).
ARCHIVE_SOURCES = {
    'trades': 'bot_eod',
    'fulltape': 'fulltape',
}
# OUTCOME_VERSION is also the value of outcome_tape_version, the marker the
# Full Tape sets on every row it examines: the version of the pass that
# examined it (NULL: none has). The tape's work and guards re-examine a row
# whose marker is older than OUTCOME_VERSION, so a version bump re-derives
# history. Bumping it is a deliberate backfill: the tape is then re-read for
# every day with alerts.
OUTCOME_VERSION = 1
# The source with the final say over outcomes (the Full Tape).
TAPE_SOURCE = ARCHIVE_SOURCES['fulltape']

# Which alerts a run picks up. {a} is a column prefix (e.g. 'a.') for a
# statement that joins the table to itself; {v} is where the version comes
# from (a %s parameter, or v.version in the priced UPDATE, which carries it in
# its VALUES row).
#   pending: enriched_at IS NULL (what a nightly run needs).
#   empty:   marked enriched (before tagging existed) with no outcome and no
#            tag.
#   all:     depends on the source, see OUTCOME_WORK_ALL.
Select = Literal['pending', 'empty', 'all']
OUTCOME_WORK = {
    'pending': '{a}enriched_at IS NULL',
    'empty': (
        '{a}enriched_at IS NOT NULL AND {a}peak_ceiling_pct IS NULL '
        'AND {a}outcome_source IS NULL'
    ),
}
# The 'all' work, by source. It is also the guard on that source's writes.
#   fulltape: every row the tape has not examined at this version, whatever
#             another writer left in it (the parentheses matter: it is ANDed
#             with other tests). Never a row examined at the current version,
#             so the work set shrinks to zero.
#   bot_eod:  fill only: an alert with no outcome and no tag. An alert a
#             writer tagged (outcome_source set, even with the outcome NULL)
#             is tried, not pending.
OUTCOME_WORK_ALL = {
    'fulltape': (
        '({a}outcome_tape_version IS NULL OR {a}outcome_tape_version < {v})'
    ),
    'bot_eod': '{a}peak_ceiling_pct IS NULL AND {a}outcome_source IS NULL',
}
# --backfill-mode's own select (see the module docstring).
BACKFILL_WORK = 'realized_trail30_10_pct IS NULL'
# Rows written per statement: execute_values page size and stamp id chunk.
WRITE_BATCH = 500

# Module-level mutable so functions can read without threading args
# through every call. Populated by configure_archive (main() routes
# --parquet-dir through it, no default);
# scripts/recompute_peak_from_parquet.py assigns PARQUET_DIR directly when it
# reuses the loaders (it never writes).
PARQUET_DIR: Path | None = None
PARQUET_FILE_PATTERN = PARQUET_FORMATS['trades']
SOURCE_TAG = ARCHIVE_SOURCES['trades']

# Import the trail-30/10 exit policy from the shared ml/src module so this
# script stays in sync with the lottery enrichment that uses the same fn.
sys.path.insert(0, str(ROOT / 'ml' / 'src'))
from lottery_exit_policies import realized_trail_act30_trail10  # noqa: E402

# Forward-return horizons in minutes — match the columns we store.
HORIZONS_MIN = [30, 60, 120]


def configure_archive(parquet_dir: Path, parquet_format: str) -> None:
    """Point the loaders at an archive and tag every write with its source."""
    global PARQUET_DIR, PARQUET_FILE_PATTERN, SOURCE_TAG
    PARQUET_DIR = parquet_dir
    PARQUET_FILE_PATTERN = PARQUET_FORMATS[parquet_format]
    SOURCE_TAG = ARCHIVE_SOURCES[parquet_format]


def outcome_work_all(source: str, alias: str = '', version: str = '%s') -> str:
    """The 'all' outcome work for `source`, with `alias` (e.g. 'a.') in front
    of its columns and `version` where the tape's gate compares against
    OUTCOME_VERSION. It doubles as that source's write guard."""
    return OUTCOME_WORK_ALL[source].format(a=alias, v=version)


def write_guard() -> tuple[str, tuple]:
    """SOURCE_TAG's write guard (the text its priced UPDATE and its stamp
    carry) and the parameters its placeholders take, in order. SOURCE_TAG is
    read at call time, so callers run configure_archive first; only the
    tape's guard carries a parameter (the version)."""
    params = (OUTCOME_VERSION,) if SOURCE_TAG == TAPE_SOURCE else ()
    return outcome_work_all(SOURCE_TAG), params


def outcome_work(select: Select) -> tuple[str, tuple]:
    """The WHERE predicate for `select` and the parameters its placeholders
    take, in order. 'all' is the write guard of SOURCE_TAG's source."""
    if select == 'all':
        return write_guard()
    return OUTCOME_WORK[select].format(a=''), ()


def load_env() -> None:
    """Fill the process env from ENV_FILE; a missing file is fine (the
    nightly service has none). ENV_FILE is read at call time."""
    load_env_file(ENV_FILE)


def day_archive_path(target_date: str) -> Path:
    """The day's parquet in the configured archive (it may not exist)."""
    return PARQUET_DIR / PARQUET_FILE_PATTERN.format(date=target_date)


def list_parquet_dates(from_date: str | None, to_date: str | None) -> list[str]:
    suffix = PARQUET_FILE_PATTERN.format(date='')
    out: list[str] = []
    for p in sorted(PARQUET_DIR.glob(f'*{suffix}')):
        m = re.match(rf'(\d{{4}}-\d{{2}}-\d{{2}}){re.escape(suffix)}', p.name)
        if not m:
            continue
        d = m.group(1)
        if from_date and d < from_date:
            continue
        if to_date and d > to_date:
            continue
        out.append(d)
    return out


def load_chain_tape(parquet_path: Path, chain_ids: list[str]) -> pd.DataFrame:
    """Load post-canceled price stream for a set of chains."""
    df = pd.read_parquet(
        parquet_path,
        columns=['executed_at', 'option_chain_id', 'price', 'canceled'],
        filters=[('option_chain_id', 'in', chain_ids)] if chain_ids else None,
    )
    if df.empty:
        return df
    if df['canceled'].dtype == bool:
        df = df[~df['canceled']]
    else:
        df = df[df['canceled'].astype(str).str.lower().isin(['f', 'false', '0', ''])]
    df = df[df['price'] > 0]
    if df['executed_at'].dt.tz is None:
        df['executed_at'] = df['executed_at'].dt.tz_localize('UTC')
    return df.sort_values(['option_chain_id', 'executed_at'], kind='stable')


def fetch_unenriched(
    conn,
    target_date: str,
    backfill_mode: bool = False,
    select: Select = 'pending',
) -> list[dict]:
    """The date's alerts that `select` names (see OUTCOME_WORK and
    OUTCOME_WORK_ALL; 'all' follows SOURCE_TAG). Each alert also carries
    whether SOURCE_TAG's write guard lets a write touch it (`writable`: the
    guard evaluated on the row, so a dry run can count what a real run would
    write), and for the Full Tape whether it already holds an outcome
    (`had_outcome`).

    Standard mode: the select, 'pending' by default (enriched_at IS NULL, the
    nightly flow).
    Backfill mode: rows with realized_trail30_10_pct IS NULL (one-shot
    pickup after migration #150 lands, for rows enriched before it). The
    select only picks the rows; the write follows the source's rule, so
    Bot-EOD skips a row that already holds a peak and the Full Tape replaces
    it (see the module docstring).
    It has no select of its own, so only 'pending' goes with it.
    """
    if backfill_mode and select != 'pending':
        raise ValueError(
            f"backfill_mode takes only the 'pending' select, not {select!r}"
        )
    tape = SOURCE_TAG == TAPE_SOURCE
    had_outcome = ', peak_ceiling_pct IS NOT NULL AS had_outcome' if tape else ''
    guard, guard_params = write_guard()
    if backfill_mode:
        work, work_params = BACKFILL_WORK, ()
    else:
        work, work_params = outcome_work(select)
    cur = conn.cursor()
    # Placeholders in order: the guard's (the select list), the day, the work's.
    cur.execute(
        f"""
        SELECT id, option_chain_id, bucket_ct, entry_price,
               ({guard}) AS writable{had_outcome}
        FROM silent_boom_alerts
        WHERE date = %s AND {work}
        ORDER BY bucket_ct ASC
        """,
        (*guard_params, target_date, *work_params),
    )
    rows = cur.fetchall()
    return [
        {
            'id': r[0],
            'chain': r[1],
            'bucket_ct': pd.Timestamp(r[2]),
            'entry_price': float(r[3]),
            'writable': bool(r[4]),
            'had_outcome': bool(r[5]) if tape else False,
        }
        for r in rows
    ]


# The priced UPDATE, one whole statement per source (update_outcomes picks by
# source). execute_values takes exactly one %s, the VALUES list, so the tape's
# version gate reads the version carried in each VALUES row (v.version).
#   - Full Tape: the guard is the marker's version gate alone, so the write
#     replaces whatever outcome another writer left. It joins the table to
#     itself (`prior`) to report the row's outcome as of the statement's
#     snapshot (see update_outcomes for the one case that differs), and sets
#     the marker.
#   - Bot-EOD: fill only: no outcome and no tag, no marker.
_TAPE_UPDATE_SQL = f"""
    UPDATE silent_boom_alerts AS a
    SET peak_ceiling_pct        = v.peak,
        minutes_to_peak         = v.mtp,
        realized_30m_pct        = v.r30,
        realized_60m_pct        = v.r60,
        realized_120m_pct       = v.r120,
        realized_eod_pct        = v.eod,
        realized_trail30_10_pct = v.trail30,
        enriched_at             = NOW(),
        outcome_source          = v.source,
        outcome_version         = v.version,
        outcome_tape_version    = v.version
    FROM (VALUES %s) AS v(id, peak, mtp, r30, r60, r120, eod, trail30, source, version),
         silent_boom_alerts AS prior
    WHERE a.id = v.id
      AND prior.id = a.id
      AND {outcome_work_all(TAPE_SOURCE, 'a.', 'v.version')}
    RETURNING a.id, prior.peak_ceiling_pct IS NOT NULL AS had_outcome
"""
_FILL_UPDATE_SQL = f"""
    UPDATE silent_boom_alerts AS a
    SET peak_ceiling_pct        = v.peak,
        minutes_to_peak         = v.mtp,
        realized_30m_pct        = v.r30,
        realized_60m_pct        = v.r60,
        realized_120m_pct       = v.r120,
        realized_eod_pct        = v.eod,
        realized_trail30_10_pct = v.trail30,
        enriched_at             = NOW(),
        outcome_source          = v.source,
        outcome_version         = v.version
    FROM (VALUES %s) AS v(id, peak, mtp, r30, r60, r120, eod, trail30, source, version)
    WHERE a.id = v.id
      AND {outcome_work_all(ARCHIVE_SOURCES['trades'], 'a.')}
    RETURNING a.id
"""


def update_outcomes(conn, updates: list[tuple], source: str) -> tuple[int, int]:
    """Bulk UPDATE via VALUES + UPDATE FROM, tagged with `source`. Returns
    (written, replaced): the rows the database says it wrote, and how many of
    them already held an outcome.

    - Full Tape (_TAPE_UPDATE_SQL): the guard is the marker's version gate
      (outcome_tape_version IS NULL or older than this pass), so the write
      replaces whatever outcome another writer left, the crons' and untagged
      history included, and sets the marker. The only way to write fewer rows
      than sent is another tape run examining an alert first.
    - Bot-EOD (_FILL_UPDATE_SQL): fill only. The guard is no outcome and no
      tag, so it never replaces a value and never sets the marker; replaced
      is 0.

    Which rows held an outcome is read inside the statement: the tape's UPDATE
    joins the table to itself (`prior`) and RETURNING reports
    `prior.peak_ceiling_pct IS NOT NULL`. `prior` is the row as of the
    statement's snapshot, taken when it started, so the count follows the row
    and not the earlier SELECT: a cron write that committed after the SELECT
    but before the statement started is counted as replaced.

    A cron write that commits while the statement is running is a different
    case. The UPDATE still overwrites it (it waits for the writer, then
    re-checks the guard on the newest row version), but `prior`, a non-target
    relation, is not re-read: it still shows the version it was joined at, from
    the snapshot, so that row is counted as not replaced. That is one count of
    drift per raced row, never data.

    Every numeric in the VALUES template is cast: r30, r60 and r120 are None
    when no print falls inside their horizon, and a VALUES column that is all
    NULL has type text, which the NUMERIC column refuses.
    """
    if not updates:
        return 0, 0
    tape = source == TAPE_SOURCE
    cur = conn.cursor()
    returned = execute_values(
        cur,
        _TAPE_UPDATE_SQL if tape else _FILL_UPDATE_SQL,
        [(*u, source, OUTCOME_VERSION) for u in updates],
        template=(
            '(%s::bigint, %s::numeric, %s::numeric, %s::numeric, %s::numeric, '
            '%s::numeric, %s::numeric, %s::numeric, %s::text, %s::smallint)'
        ),
        page_size=WRITE_BATCH,
        fetch=True,
    )
    conn.commit()
    replaced = sum(1 for row in returned if row[1]) if tape else 0
    return len(returned), replaced


# The Full Tape's stamp for an alert it cannot price. It decides per row,
# inside the statement, from the row's current peak_ceiling_pct (never from the
# SELECT), so a value written after the SELECT is kept, not erased:
#   - no prior outcome: tag it (source, version, enriched_at) as tried but
#     unpriced, the realized columns staying NULL;
#   - prior outcome: leave the values, outcome_source and outcome_version
#     exactly as they were, and leave enriched_at alone unless it is NULL. The
#     column is nullable and nothing in the schema forbids a value with a NULL
#     enriched_at, so the keep branch fills it defensively: such a row would
#     otherwise stay in the cron's `enriched_at IS NULL` pool, and a cron write
#     there would overwrite a row the tape examined.
# Either way the marker is set to this pass's version, so the row is not
# examined again until the version changes. The realized columns are not in
# the SET at all. RETURNING reports the branch taken: the stamp changes no
# realized column, so the post-update peak_ceiling_pct IS NOT NULL is the
# row's prior outcome. The version gate comes before the ids so the ids stay
# the last parameter.
_TAPE_STAMP_SQL = f"""
    UPDATE silent_boom_alerts AS a
    SET outcome_source  = CASE WHEN a.peak_ceiling_pct IS NULL
                               THEN %s::text ELSE a.outcome_source END,
        outcome_version = CASE WHEN a.peak_ceiling_pct IS NULL
                               THEN %s::smallint ELSE a.outcome_version END,
        enriched_at     = CASE WHEN a.peak_ceiling_pct IS NULL
                               THEN NOW() ELSE COALESCE(a.enriched_at, NOW()) END,
        outcome_tape_version = %s::smallint
    WHERE {outcome_work_all(TAPE_SOURCE, 'a.')}
      AND a.id = ANY(%s::bigint[])
    RETURNING a.peak_ceiling_pct IS NOT NULL AS had_outcome
"""
# Bot-EOD's stamp is fill only: tag an alert nobody has filled, nothing else.
_FILL_STAMP_SQL = f"""
    UPDATE silent_boom_alerts
    SET enriched_at = NOW(), outcome_source = %s, outcome_version = %s
    WHERE id = ANY(%s::bigint[])
      AND {outcome_work_all(ARCHIVE_SOURCES['trades'])}
"""


def stamp_no_outcome(conn, alert_ids: list[int], source: str) -> tuple[int, int]:
    """Stamp alerts the tape cannot price (no chain, no print at or after the
    bucket, or an entry price that gives no finite outcome). Returns (stamped,
    kept), counted from what the database returned.

    - Full Tape (_TAPE_STAMP_SQL): stamped is a row with no prior outcome, now
      tagged 'fulltape' with its outcomes NULL (tried, not pending). kept is a
      row that held an outcome, which stays as it was ("keep the feed's values
      for now") with the marker set, and an enriched_at if it had none.
    - Bot-EOD (_FILL_STAMP_SQL): tags an alert nobody has filled and counts
      rowcount; kept is 0.

    Fewer rows than ids is normal: another tape run examined them first."""
    if not alert_ids:
        return 0, 0
    cur = conn.cursor()
    stamped = kept = 0
    for i in range(0, len(alert_ids), WRITE_BATCH):
        chunk = alert_ids[i : i + WRITE_BATCH]
        if source == TAPE_SOURCE:
            # (source, outcome version, marker, version gate, ids)
            cur.execute(
                _TAPE_STAMP_SQL,
                (source, OUTCOME_VERSION, OUTCOME_VERSION, OUTCOME_VERSION, chunk),
            )
            returned = cur.fetchall()
            chunk_kept = sum(1 for (had_outcome,) in returned if had_outcome)
            kept += chunk_kept
            stamped += len(returned) - chunk_kept
        else:
            cur.execute(_FILL_STAMP_SQL, (source, OUTCOME_VERSION, chunk))
            stamped += cur.rowcount
    conn.commit()
    return stamped, kept


def compute_outcomes(
    chain_df: pd.DataFrame, bucket_ct: pd.Timestamp, entry_price: float
) -> tuple[
    float, float, float | None, float | None, float | None, float, float
] | None:
    # entry_price is NUMERIC NOT NULL, which can hold NaN or Infinity; neither
    # is a price to divide by (and Infinity would only warn its way to NaN).
    if not math.isfinite(entry_price) or entry_price <= 0 or chain_df.empty:
        return None
    bucket_ts = bucket_ct
    if bucket_ts.tz is None:
        bucket_ts = bucket_ts.tz_localize('UTC')
    post = chain_df[chain_df['executed_at'] >= bucket_ts]
    if post.empty:
        return None
    prices = post['price'].astype(float).to_numpy()
    minutes = (
        (post['executed_at'] - bucket_ts).dt.total_seconds() / 60.0
    ).to_numpy()

    # Peak (look-ahead reference) + minutes-to-peak.
    peak_idx = int(np.argmax(prices))
    peak_pct = float((prices[peak_idx] - entry_price) / entry_price * 100.0)
    mtp = float(minutes[peak_idx])

    # Forward fixed-horizon returns — last price at or before the
    # horizon's offset. Returns None when no tick falls inside the
    # horizon so the column stays NULL in the DB; coding "no data"
    # as 0% would silently inflate win rates for sparse chains.
    def at_horizon(h_min: float) -> float | None:
        mask = minutes <= h_min
        if not mask.any():
            return None
        last_idx = int(np.nonzero(mask)[0][-1])
        return float((prices[last_idx] - entry_price) / entry_price * 100.0)

    r30 = at_horizon(30.0)
    r60 = at_horizon(60.0)
    r120 = at_horizon(120.0)
    eod = float((prices[-1] - entry_price) / entry_price * 100.0)
    # Trail-30/10: activate trailing stop at +30%, exit on 10pp giveback
    # from running peak. Bounded between (-100%, peak_pct]; equals EoD
    # return when peak never crossed +30%. Shared with lottery enrichment.
    trail30 = float(
        realized_trail_act30_trail10(prices.tolist(), entry_price)
    )
    outcomes = (peak_pct, mtp, r30, r60, r120, eod, trail30)
    # `price > 0` in the loaders lets an infinite print through. Written, a
    # non-finite value would count as an outcome and the alert would never be
    # picked again, so such an alert is unpriced and goes to the stamp. (None,
    # a horizon with no tick, is a NULL outcome and stays legitimate.)
    if not all(v is None or math.isfinite(v) for v in outcomes):
        return None
    return outcomes


def list_work_dates(
    conn,
    select: Select,
    since: str | None = None,
    through: str | None = None,
) -> list[str]:
    """Distinct YYYY-MM-DD dates with outcome work for `select` (see
    OUTCOME_WORK and OUTCOME_WORK_ALL; 'all' follows SOURCE_TAG), ascending,
    within [since, through] when given.

    Used by --all-unenriched so post-nightly manual backfills don't get
    stranded with enriched_at NULL.
    """
    bounds = ''
    bound_params: list[str] = []
    if since is not None:
        bounds += ' AND date >= %s::date'
        bound_params.append(since)
    if through is not None:
        bounds += ' AND date <= %s::date'
        bound_params.append(through)

    work, work_params = outcome_work(select)
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT DISTINCT date::text
        FROM silent_boom_alerts
        WHERE {work}{bounds}
        ORDER BY 1
        """,
        (*work_params, *bound_params),
    )
    return [r[0] for r in cur.fetchall()]


def list_backfill_dates(conn) -> list[str]:
    """Distinct YYYY-MM-DD dates with at least one alert whose
    realized_trail30_10_pct is NULL — matches the --backfill-mode semantics of
    fetch_unenriched."""
    cur = conn.cursor()
    cur.execute(
        f"""
        SELECT DISTINCT date::text
        FROM silent_boom_alerts
        WHERE {BACKFILL_WORK}
        ORDER BY date ASC
        """
    )
    return [r[0] for r in cur.fetchall()]


@dataclass
class DayResult:
    """What enrich_one_date did for one date."""

    archive_missing: bool = False
    # Alerts selected; outcome rows written (the database's count, at most the
    # priced alerts); of those, how many replaced a prior outcome (Full Tape
    # only); unpriced alerts tagged with no prior outcome; unpriced alerts that
    # held an outcome, kept with only the marker set (Full Tape only: the feed
    # values the tape could not confirm).
    alerts_selected: int = 0
    outcomes_written: int = 0
    alerts_replaced: int = 0
    stamped_no_outcome: int = 0
    alerts_kept: int = 0


def enrich_one_date(
    conn,
    target_date: str,
    select: Select = 'pending',
    dry_run: bool = False,
    backfill_mode: bool = False,
) -> DayResult:
    """Compute and write one date's outcomes.

    Every write is tagged with SOURCE_TAG (see configure_archive) and guarded
    by that source's work predicate, so the counts are what the database
    wrote. The Full Tape replaces an outcome it can price and keeps one it
    cannot; Bot-EOD only fills (see the module docstring). With dry_run
    nothing is written and the counts are what would be: the fetch's
    `writable` keeps out the alerts the source's guard would refuse (a
    --backfill-mode alert that already holds a peak, for Bot-EOD), and
    `had_outcome` gives the replaced and kept ones.

    A day with work to do whose archive file is missing is skipped: one line
    names it (warn_missing_archive) and nothing is written for it, so its
    alerts keep enriched_at NULL for a later run with the file in place. Every
    other failure (DB, unreadable parquet) still raises.
    """
    td = time.time()
    alerts = fetch_unenriched(conn, target_date, backfill_mode, select)
    if not alerts:
        print(f'  [{target_date}] no unenriched alerts')
        return DayResult()
    path = day_archive_path(target_date)
    if not path.exists():
        # Loud, on stdout and stderr — distinct from the
        # chain-not-in-parquet skip below. Nothing is written for the
        # day, so its alerts keep enriched_at NULL for a later run.
        warn_missing_archive(
            '[enrich-silent-boom]',
            target_date,
            path,
            f'{len(alerts):,} alerts left unenriched',
        )
        return DayResult(archive_missing=True)

    chain_ids = list({a['chain'] for a in alerts})
    tape = load_chain_tape(path, chain_ids)
    chain_index = dict(iter(tape.groupby('option_chain_id', sort=False)))
    updates: list[tuple] = []
    unpriced_ids: list[int] = []
    skipped_chain_missing = 0
    skipped_no_outcome = 0
    # From the fetch, for a dry run: what the guarded statements would touch.
    # Only a writable alert counts, as the guard's WHERE would let only it
    # through: a priced one is written (and replaces an outcome it holds), an
    # unpriced one is stamped (and kept if it holds one).
    would_write = would_replace = would_stamp = would_keep = 0
    for a in alerts:
        chain_df = chain_index.get(a['chain'])
        res = (
            None
            if chain_df is None
            else compute_outcomes(chain_df, a['bucket_ct'], a['entry_price'])
        )
        if res is None:
            if chain_df is None:
                skipped_chain_missing += 1
            else:
                skipped_no_outcome += 1
            unpriced_ids.append(a['id'])
            if a['writable']:
                would_keep += a['had_outcome']
                would_stamp += not a['had_outcome']
            continue
        peak, mtp, r30, r60, r120, eod, trail30 = res
        updates.append((a['id'], peak, mtp, r30, r60, r120, eod, trail30))
        if a['writable']:
            would_write += 1
            would_replace += a['had_outcome']

    result = DayResult(alerts_selected=len(alerts))
    if dry_run:
        result.outcomes_written = would_write
        result.alerts_replaced = would_replace
        result.stamped_no_outcome = would_stamp
        result.alerts_kept = would_keep
    else:
        result.outcomes_written, result.alerts_replaced = update_outcomes(
            conn, updates, SOURCE_TAG
        )
        result.stamped_no_outcome, result.alerts_kept = stamp_no_outcome(
            conn, unpriced_ids, SOURCE_TAG
        )
    # Nothing was written on a dry run, so its counts read "would".
    if dry_run:
        counts = (
            f'would_update={result.outcomes_written:>4,} '
            f'would_replace={result.alerts_replaced} '
            f'would_tag={result.stamped_no_outcome} '
            f'would_keep={result.alerts_kept} '
        )
    else:
        counts = (
            f'updated={result.outcomes_written:>4,} '
            f'alerts_replaced={result.alerts_replaced} '
            f'tagged={result.stamped_no_outcome} '
            f'alerts_kept={result.alerts_kept} '
        )
    print(
        f'  [{target_date}] {"(dry run) " if dry_run else ""}'
        f'alerts={len(alerts):>4,} '
        f'{counts}'
        f'skipped_chain={skipped_chain_missing} '
        f'skipped_no_outcome={skipped_no_outcome} '
        f'in {time.time() - td:.1f}s'
    )
    return result


def alerts_updated(result: DayResult) -> int:
    """Alerts a day wrote to: outcome rows plus unpriced alerts tagged."""
    return result.outcomes_written + result.stamped_no_outcome


def print_run_summary(
    results: dict[str, DayResult],
    dry_run: bool = False,
    not_landed: list[str] | None = None,
) -> None:
    """Days enriched, alerts written, and the days skipped for a missing
    archive or, with --r2, not landed in the lake (both also on stderr, so
    they can't scroll past unseen). On a dry run nothing was written, so
    every count reads "would"."""
    missing = [d for d, r in results.items() if r.archive_missing]
    done = [r for r in results.values() if r.alerts_selected]
    updated = sum(alerts_updated(r) for r in done)
    replaced = sum(r.alerts_replaced for r in done)
    kept = sum(r.alerts_kept for r in done)
    if dry_run:
        head = '[enrich-silent-boom] summary (dry run, nothing written):'
        print(
            f'{head} {len(done)} day(s) would be enriched, '
            f'{updated:,} alerts would be updated; '
            f'{len(missing)} day(s) skipped for a missing archive'
        )
        print(
            f'{head} alerts_would_replace={replaced:,} '
            f'alerts_would_keep={kept:,}'
        )
    else:
        print(
            f'[enrich-silent-boom] summary: {len(done)} day(s) enriched, '
            f'{updated:,} alerts updated; '
            f'{len(missing)} day(s) skipped for a missing archive'
        )
        print(
            f'[enrich-silent-boom] summary: '
            f'alerts_replaced={replaced:,} '
            f'alerts_kept={kept:,}'
        )
    if missing:
        line = (
            '[enrich-silent-boom] skipped (archive missing, alerts left '
            f'unenriched): {format_dates(missing)}'
        )
        print(line)
        print(line, file=sys.stderr)
    if not_landed:
        line = (
            '[enrich-silent-boom] skipped (not landed in R2, alerts left '
            f'unenriched): {format_dates(not_landed)}'
        )
        print(line)
        print(line, file=sys.stderr)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument(
        '--parquet-dir',
        type=existing_dir,
        help='Bot-EOD archive: the directory of {date}-trades.parquet files.',
    )
    source.add_argument(
        '--r2',
        action='store_true',
        help=(
            'Read the Full Tape from the R2 lake (R2_ENDPOINT_URL, '
            'R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_FULLTAPE), '
            'one day at a time through a temp directory. --from-date / '
            '--to-date then pick among the landed days that have alerts to '
            'enrich.'
        ),
    )
    parser.add_argument('--date', help='YYYY-MM-DD; single-day mode')
    parser.add_argument('--from-date')
    parser.add_argument('--to-date')
    parser.add_argument(
        '--backfill-mode',
        action='store_true',
        help=(
            'Gate the row fetch on realized_trail30_10_pct IS NULL instead '
            'of enriched_at IS NULL. Use once after migration #150 to '
            'fill the new column on previously-enriched rows without '
            'resetting enriched_at on the table. Takes no --select other '
            'than pending.'
        ),
    )
    parser.add_argument(
        '--all-unenriched',
        action='store_true',
        help=(
            'Enumerate dates from silent_boom_alerts with outcome work for '
            '--select (pending, the default: enriched_at IS NULL; with '
            '--backfill-mode, realized_trail30_10_pct IS NULL) and process '
            'only those; with --r2, only the dates the lake holds (the rest '
            'are listed at the end). Overrides --date / --from-date / '
            '--to-date. '
            "Used by `make enrich` so post-nightly manual backfills don't get "
            'stranded with enriched_at NULL.'
        ),
    )
    parser.add_argument(
        '--select',
        choices=['pending', 'empty', 'all'],
        default='pending',
        help=(
            'Which alerts the run works on: pending = enriched_at IS NULL '
            '(default); empty = marked enriched with no outcome and no tag; '
            'all = every alert the source may still write (Full Tape: every '
            'alert it has not examined at this version, whatever another '
            'writer left; Bot-EOD: alerts nobody has filled). Not with '
            '--backfill-mode.'
        ),
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Compute and report what would be written; write nothing.',
    )
    args = parser.parse_args(argv)
    if args.backfill_mode and args.select != 'pending':
        parser.error(
            f'--select {args.select} cannot be used with --backfill-mode: '
            'backfill mode has its own select (only pending goes with it)'
        )
    return args


@contextmanager
def r2_reader():
    """A TapeReader on a fresh temp directory, for the length of the run.

    Leaving the block, however it ends, closes the reader (which deletes every
    day it cached) and removes the directory. A TapeReadError from from_env or
    from anything inside the block ends the run with a non-zero exit; its
    message holds a key, a count or a variable name, never a value. Imported
    here, so importing this module never loads boto3.
    """
    from _tape_reader import TapeReader, TapeReadError

    cache_dir = Path(tempfile.mkdtemp(prefix='enrich-'))
    reader = None
    try:
        reader = TapeReader.from_env(cache_dir)
        yield reader
    except TapeReadError as exc:
        sys.exit(f'[enrich-silent-boom] R2 tape read failed: {exc}')
    finally:
        try:
            if reader is not None:
                reader.close()
        finally:
            shutil.rmtree(cache_dir, ignore_errors=True)


def work_dates(conn, args: argparse.Namespace) -> list[str]:
    """Dates with outcome work for the run (--backfill-mode has its own)."""
    if args.backfill_mode:
        return list_backfill_dates(conn)
    return list_work_dates(conn, args.select)


def select_dates(conn, args: argparse.Namespace, reader) -> tuple[list[str], list[str]]:
    """The dates to process, and the dates with work the lake does not hold.

    --all-unenriched overrides --date and the range. With --r2 a range names
    landed days that have alerts to enrich: the lake holds every session
    since the tape began, and a day with nothing to do is not worth a
    download of up to 2 GB.
    """
    if args.date and not args.all_unenriched:
        return [args.date], []
    if reader is None:
        if args.all_unenriched:
            return work_dates(conn, args), []
        return list_parquet_dates(args.from_date, args.to_date), []
    landed = {day.isoformat() for day in reader.landed_days()}
    dates = work_dates(conn, args)
    if not args.all_unenriched:
        dates = [
            d
            for d in dates
            if (not args.from_date or d >= args.from_date)
            and (not args.to_date or d <= args.to_date)
        ]
    return [d for d in dates if d in landed], [d for d in dates if d not in landed]


def enrich_day(conn, target_date: str, args: argparse.Namespace, reader) -> DayResult:
    """One date. With --r2 its tape is fetched into the reader's cache first
    and released afterwards, so one day is on disk at a time."""
    if reader is None:
        return enrich_one_date(
            conn,
            target_date,
            select=args.select,
            dry_run=args.dry_run,
            backfill_mode=args.backfill_mode,
        )
    day = date.fromisoformat(target_date)
    # No object (None) leaves no file, so enrich_one_date takes its
    # missing-archive skip: the day is named, counted and left alone.
    reader.fetch_day(day)
    try:
        return enrich_one_date(
            conn,
            target_date,
            select=args.select,
            dry_run=args.dry_run,
            backfill_mode=args.backfill_mode,
        )
    finally:
        reader.release(day)


def run(args: argparse.Namespace, db_url: str, reader) -> None:
    """The date loop and the summary. `reader` is None for --parquet-dir."""
    conn = connect_with_retry(db_url)
    try:
        dates, not_landed = select_dates(conn, args, reader)
        mode_label = 'backfill' if args.backfill_mode else 'standard'
        if args.all_unenriched:
            scope = 'all-unenriched'
        else:
            scope = 'lake-list' if reader is not None else 'parquet-list'
        print(
            f'[enrich-silent-boom] {len(dates)} dates '
            f'(mode={mode_label}, scope={scope})'
        )

        results: dict[str, DayResult] = {}
        t0 = time.time()
        try:
            for date_str in dates:
                results[date_str] = enrich_day(conn, date_str, args, reader)
        except BaseException:
            # The days already done are committed: summarize them before the
            # run ends, as it ends (a failed read, a database error, Ctrl-C).
            print(
                f'[enrich-silent-boom] stopped after {len(results)} of '
                f'{len(dates)} day(s); summary of the days done:'
            )
            print_run_summary(results, args.dry_run, not_landed)
            raise

        done = [r for r in results.values() if r.alerts_selected]
        updated = sum(alerts_updated(r) for r in done)
        elapsed = time.time() - t0
        if args.dry_run:
            print(
                f'\n[enrich-silent-boom] DONE (dry run, nothing written) '
                f'would update {updated:,} in {elapsed:.1f}s'
            )
        else:
            print(
                f'\n[enrich-silent-boom] DONE '
                f'updated={updated:,} '
                f'in {elapsed:.1f}s'
            )
        print_run_summary(results, args.dry_run, not_landed)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)

    load_env()
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    if not args.r2:
        configure_archive(args.parquet_dir, 'trades')
        run(args, db_url, None)
        return
    # load_env came first: the R2_* values are normally in .env.local.
    with r2_reader() as reader:
        configure_archive(reader.cache_dir, 'fulltape')
        run(args, db_url, reader)


if __name__ == '__main__':
    main()
