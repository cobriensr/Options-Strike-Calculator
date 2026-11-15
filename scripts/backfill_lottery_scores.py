#!/usr/bin/env python
"""Rescore every stored lottery fire with one weights version, in one transaction.

This is the one rescore path. The nightly refit's promotion calls
``rescore_all``, and this file's CLI calls it by hand. Both score with
``lottery_weights.score_frame``, the Python twin of the live scorer, so the
quintiles are right-closed: a value on a boundary goes to the lower bucket.
(This script used to cut them left-closed with ``<``.)

``rescore_all`` runs one transaction. It first sets a 60 s ``lock_timeout``: a
run that would wait longer for a lock fails with ``LockNotAvailable`` and rolls
back, having written nothing. It also sets a 120 s
``idle_in_transaction_session_timeout``. A process that is lost without its
socket closing (a failed host) leaves the transaction idle, holding the pointer
and the fires it locked, and Neon may not notice for a long time; past 13:00 UTC
that would block the detect cron's inserts. With the timeout the server rolls the
transaction back and drops the session two minutes after the client stops
talking. The longest legitimate gap is the scoring of one page (seconds). Then:

1. Every writing run locks the ``active`` pointer row ``FOR UPDATE``: a
   promotion, a pinned rescore and an explicit-version one alike. So two
   writes never overlap. The guards in step 3 cover only the fires a run
   writes, so without this lock a write committing mid-scan (a promotion, or
   another hand run) could leave the fires split between versions. A
   promotion (``expect_active`` set) needs the pointer to name
   ``expect_active``. A pinned run (``pin_active``: the CLI rescoring with the
   active version) needs it to name ``to_version``. Any other write only holds
   it. A full rewrite can hold the lock for minutes, so a second write started
   meanwhile waits 60 s and then fails as above: that is safe, and it can be
   run again. Plain reads of the pointer, the Vercel loader's included, are
   never blocked by the lock.
2. It reads the fires in keyset pages of ``PAGE_ROWS`` by id and scores each
   page. A fire changes when its new score differs from ``score`` or its
   ``score_version`` is not ``to_version``. Fires scored before the store
   existed have a NULL ``score_version``, so the first promotion rewrites every
   fire. With ``only_tag`` set, only the fires whose ``score_version`` equals it
   are read at all, so a repair touches exactly the residue it names and leaves
   every other tag, and every NULL one, alone.
3. For each page with a change, it writes one ``lottery_fire_value_snapshots``
   row (the ids, old scores and old tags), then UPDATEs of ``WRITE_ROWS`` rows.
   An UPDATE writes a fire only while its score and score_version still equal
   the ones this run read, and returns the ids it wrote. Fewer ids than the
   batch means another writer changed one of them in between:
   ``ConcurrentScoreWriter``. So the snapshot holds exactly what was replaced.
4. For a promotion, it marks the version ``promoted``, merges into the version's
   ``gate_report`` the version the pointer named (``replaced``, always) and the
   decision it was given (``verdict``, when given), and moves the ``active``
   pointer to it.

Any exception rolls the whole transaction back, so the store holds either every
new score, tag, status and pointer, or none of them. That covers an UPDATE
error, a concurrent writer, a pointer moved by hand, a lock timeout, the step
deadline (``RescoreDeadline``) and the nightly's SIGTERM (a ``SystemExit``).
If the process dies, Postgres rolls back its open transaction. Nothing here
touches the ``takeit`` pointer: only a Take-It retrain moves it.

A dry run reads in a READ ONLY transaction and takes no lock. For a promotion
it also checks that the version is still a shadow. Only a shadow is promoted: a
``passed`` version was judged against the ``active`` version of its day and is
kept as a record, so promoting one by hand would rest on a stale verdict.

``cluster_bonus`` is not rescored. The detect cron computes it at insert from
the inserting version's ``t1`` cutoff and its own scores, and a rescore changes
``score`` and ``score_version`` only, so the column stays on the version that
inserted the fire. Nothing live reads it (only
``scripts/analyze-tag-scorecard-2026-05-29.ts``), but it is not one version
across the table after a promotion.

To undo a rescore, run one ``UPDATE … FROM unnest(fire_ids, old_values,
old_tags)`` over its snapshot rows (plan D5). Writing ``score`` recomputes the
generated ``combined_score``. Never write that column.

CLI (a dry run unless --write is given; it never moves a pointer):

    ml/.venv/Scripts/python scripts/backfill_lottery_scores.py
        [--version VERSION] [--only-tag TAG] [--reason REASON] [--write]

    --version   a stored version to score with (default: the one `active` names)
    --only-tag  rescore only the fires whose score_version is TAG (default: all)
    --reason    the snapshot rows' reason (default: manual)
    --write     write the scores; without it, read every fire and write nothing

Without --version it scores with the version ``active`` names and pins it. If
a promotion moves the pointer between the CLI's read and its rescore, the
rescore stops with ``PointerMoved`` and writes nothing. An explicit --version
is not pinned. It names the scores wanted whatever the pointer says (a restore
or a reshape), so it need not be the active one. Like any write, it still
locks the pointer ``FOR UPDATE``, so it never overlaps a promotion or another
write.

--only-tag is for repairing the fires a live writer left on another version
(nightly/README.md, "Refit"). Without it, a run after the first promotion was
undone would rescore every fire scored before the store existed (NULL tag) with
the seed. With it the run reads, snapshots and rewrites only the fires carrying
TAG, and its dry run shows how many that is.

Run --write outside 13:00-24:00 UTC on weekdays. It locks every fire it
rewrites until it commits. In those hours the detect-lottery-fires cron inserts
fires, and the insert trigger updates the older fires of the same chain and
day: that cron would block on the rescore or deadlock with it, since the two
lock fires in different orders. The takeit-fill-shap, wave2-confirmation and
evaluate-round-trip UPDATEs would block as well. The nightly window (07:15-12:30
UTC) overlaps none of them.

It connects to DATABASE_URL_UNPOOLED, or DATABASE_URL, from the environment or
.env.local. That is the production database.

Spec: docs/superpowers/plans/2026-11-05-nightly-pipeline-phase4.md (D5, Task 15,
Review Focus 1). The nightly image (Python 3.12) carries this file. At module
level it imports only lottery_weights, pandas and psycopg2.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, NamedTuple

import pandas as pd
from psycopg2.errors import LockNotAvailable
from psycopg2.extras import Json, execute_values

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'ml' / 'src'))

from lottery_weights import (  # noqa: E402
    SCORE_COLUMNS,
    WeightsInvalid,
    load_pointer,
    score_frame,
    validate_weights,
)

# Fires per keyset page. A page's changed fires go into one snapshot row, and
# the store allows at most 50,000 ids in a snapshot row, so keep this at or
# below 50,000.
PAGE_ROWS = 50_000
# Fires per UPDATE statement (R5).
WRITE_ROWS = 500

# The snapshot table's reason CHECK. fullmatch, not ^...$: Python's $ also
# matches before a trailing newline, and Postgres's does not.
_REASON = re.compile(r'[a-z][a-z0-9-]{1,40}')

# A run that finds the pointer or a fire locked waits this long, then fails
# with LockNotAvailable and rolls back with nothing written. A legitimate full
# rewrite can hold the pointer for minutes, so a run started meanwhile times
# out: that is safe, and it can be run again. Without a limit the wait would
# last until the watchdog.
_LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '60s'"
# A transaction left idle (the process lost with its socket still open) holds the
# pointer row and up to a million fire locks. Past 13:00 UTC that blocks the detect
# cron's insert trigger, and the database may not notice the dead peer for a long
# time. Two minutes is far above the longest legitimate gap, the scoring of one
# page of PAGE_ROWS fires (seconds), and the server rolls the transaction back.
_IDLE_TIMEOUT_SQL = "SET LOCAL idle_in_transaction_session_timeout = '120s'"
_ACTIVE_SQL = "SELECT version FROM lottery_score_pointers WHERE name = 'active'"
_ACTIVE_FOR_UPDATE_SQL = _ACTIVE_SQL + ' FOR UPDATE'
_STATUS_SQL = 'SELECT status FROM lottery_score_versions WHERE version = %s'
_PAGE_FROM = (
    f"SELECT id, score, score_version, {', '.join(SCORE_COLUMNS)} "
    'FROM lottery_finder_fires WHERE id > %s'
)
_PAGE_SQL = _PAGE_FROM + ' ORDER BY id LIMIT %s'
# `only_tag`: the fires of one tag only. A NULL tag never equals a text, so the
# fires scored before the store existed are left out whatever the tag is.
_PAGE_TAGGED_SQL = _PAGE_FROM + ' AND score_version = %s ORDER BY id LIMIT %s'
_SNAPSHOT_SQL = (
    'INSERT INTO lottery_fire_value_snapshots '
    '(reason, column_name, to_version, fire_ids, old_values, old_tags) '
    "VALUES (%s, 'score', %s, %s::bigint[], %s::float8[], %s::text[])"
)
_UPDATE_SQL = (
    'UPDATE lottery_finder_fires AS f '
    'SET score = v.score, score_version = v.ver '
    'FROM (VALUES %s) AS v(id, score, ver, old, old_ver) '
    'WHERE f.id = v.id AND f.score IS NOT DISTINCT FROM v.old '
    'AND f.score_version IS NOT DISTINCT FROM v.old_ver '
    'RETURNING f.id'
)
_UPDATE_ROW = '(%s::bigint, %s::int, %s::text, %s::int, %s::text)'
# The patch is `{"replaced": <the version the pointer named>}`, plus `"verdict": <the
# decision>` when the caller has one. jsonb `||` keeps the shadow's creation report and
# session records and adds the patch's keys beside them. `replaced` is on every promotion:
# it is the version the by-hand undo (nightly/README.md, "Refit") points `active` back
# to. It is not inside `verdict`, which is the decision summary the refit step hands over.
_PROMOTE_SQL = (
    "UPDATE lottery_score_versions SET status = 'promoted', decided_at = now(), "
    "gate_report = gate_report || %s::jsonb "
    "WHERE version = %s AND status = 'shadow' RETURNING version"
)
_MOVE_ACTIVE_SQL = (
    'UPDATE lottery_score_pointers SET version = %s, updated_at = now() '
    "WHERE name = 'active' AND version = %s RETURNING name"
)
_VERSION_SQL = 'SELECT weights FROM lottery_score_versions WHERE version = %s'


class PointerMoved(RuntimeError):
    """The ``active`` pointer does not name the version this run needs (a
    promotion's ``expect_active``, a pinned rescore's ``to_version``), or the
    version to promote is no longer a shadow."""


class ConcurrentScoreWriter(RuntimeError):
    """Another writer changed a fire's score or score_version after this
    rescore read it."""


class RescoreDeadline(RuntimeError):
    """The deadline passed mid-rescore. By the time a caller sees this, the
    rollback is complete: a failed rollback raises its own error instead."""


@dataclass(frozen=True)
class RescoreResult:
    """What a rescore wrote, or in a dry run would write.

    ``changed`` counts the fires written, from the UPDATEs' RETURNING (in a dry
    run, the fires it would write). ``snapshot_rows`` is one per page with a
    change. ``pointer_moved`` is True once the ``active`` pointer names the
    version, never in a dry run. ``score_changed`` counts the changed fires
    whose score value changed; the rest only took the new ``score_version``.
    """

    scanned: int
    changed: int
    snapshot_rows: int
    pointer_moved: bool
    score_changed: int


class _Change(NamedTuple):
    id: int
    score: int | None
    old: int | None
    old_tag: str | None


def rescore_all(
    conn: Any,
    *,
    to_version: str,
    weights: Mapping[str, Any],
    reason: str,
    expect_active: str | None,
    dry_run: bool,
    deadline: float | None = None,
    pin_active: bool = False,
    verdict: Mapping[str, Any] | None = None,
    only_tag: str | None = None,
) -> RescoreResult:
    """Rescore every fire with ``weights``, tagged ``to_version``, in one
    transaction (the module docstring has the steps).

    ``conn`` is a psycopg2 connection outside a transaction (autocommit, or
    idle). Its autocommit setting is restored on return. ``reason`` goes on the
    snapshot rows. With ``expect_active`` set, this is a promotion: the
    ``active`` pointer must name ``expect_active`` and ``to_version`` must be a
    shadow, else ``PointerMoved``. Every write locks the
    pointer ``FOR UPDATE`` until it commits, and with ``pin_active`` the pointer
    must also name ``to_version``, else ``PointerMoved``. The two are
    exclusive. ``deadline`` is a ``time.monotonic()`` value, checked before
    each page and each UPDATE.

    ``only_tag`` restricts the rescore to the fires whose ``score_version``
    equals it, a non-empty text: the repair of what a live writer left on
    another version. Fires with any other tag, and the NULL ones (scored before
    the store existed), are not read, snapshotted or written. It is for a
    repair, not a promotion: a promotion rewrites the whole table, so it is
    refused with ``expect_active`` (``ValueError``).

    ``verdict`` is the decision a promotion rests on, plain JSON values (the
    nightly refit's verdict summary). It is merged into the version's
    ``gate_report`` under ``verdict`` by the promotion's status UPDATE, so it
    commits, or rolls back, with the scores, the status and the pointer. Only a
    promotion takes one (``expect_active`` set). That same UPDATE merges
    ``expect_active`` under ``replaced``, beside ``verdict`` and with or without
    one: it is the version the pointer named under its lock, and the pointer
    UPDATE re-checks it, so it is right whenever the promotion commits.

    ``dry_run`` runs the same reads and checks in a READ ONLY transaction,
    takes no lock, and returns the counts the write would give, with
    ``pointer_moved`` False.

    The arguments are checked before any statement: ``ValueError`` and
    ``WeightsInvalid``, and for a verdict ``json.dumps(allow_nan=False)``'s
    own ``ValueError`` (NaN or infinity, which jsonb cannot hold) or
    ``TypeError`` (a value JSON cannot hold, a numpy scalar for one). Any later
    exception rolls everything back and propagates.
    """
    if not _REASON.fullmatch(reason):
        raise ValueError(f'reason must match {_REASON.pattern}')
    if pin_active and expect_active is not None:
        raise ValueError('pin_active and expect_active are mutually exclusive')
    if only_tag is not None:
        if not only_tag:
            raise ValueError('only_tag must be a non-empty version')
        if expect_active is not None:
            raise ValueError('only_tag is for a repair, not a promotion')
    if verdict is not None:
        if expect_active is None:
            raise ValueError('a verdict is only for a promotion (expect_active set)')
        # Before any statement: a value jsonb cannot hold would otherwise fail in the
        # status UPDATE, after every fire was rewritten, and lose the whole promotion.
        json.dumps(verdict, allow_nan=False)
    validate_weights(weights)
    previous = conn.autocommit
    # Outside the try: psycopg2 refuses this inside an open transaction, and a
    # rollback there would drop the caller's work.
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            if dry_run:
                # Postgres then refuses any write.
                cur.execute('SET TRANSACTION READ ONLY')
            cur.execute(_LOCK_TIMEOUT_SQL)
            cur.execute(_IDLE_TIMEOUT_SQL)
            # Every write locks the pointer until it commits, so no other write
            # overlaps it: one that tries waits up to the lock timeout, then
            # fails with nothing written. A READ ONLY transaction refuses the
            # lock, so a dry run reads the pointer without one.
            if expect_active is not None:
                _check_active(
                    cur,
                    _ACTIVE_SQL if dry_run else _ACTIVE_FOR_UPDATE_SQL,
                    expect_active,
                )
                if dry_run:
                    _check_candidate(cur, to_version)
            elif not dry_run:
                _check_active(
                    cur, _ACTIVE_FOR_UPDATE_SQL, to_version if pin_active else None
                )
            elif pin_active:
                _check_active(cur, _ACTIVE_SQL, to_version)
            result = _rescore_pages(
                cur,
                to_version=to_version,
                weights=weights,
                reason=reason,
                dry_run=dry_run,
                deadline=deadline,
                only_tag=only_tag,
            )
            if expect_active is not None and not dry_run:
                _promote(cur, to_version, expect_active, verdict)
                result = replace(result, pointer_moved=True)
        if dry_run:
            conn.rollback()
        else:
            conn.commit()
    except BaseException:  # not Exception: the nightly's SIGTERM is SystemExit
        # A connection the server dropped is closed, and its rollback would
        # raise over the real error. Postgres aborts that transaction itself.
        if not conn.closed:
            conn.rollback()
        raise
    finally:
        if not conn.closed:
            conn.autocommit = previous
    return result


def _check_deadline(deadline: float | None, before: str) -> None:
    if deadline is not None and time.monotonic() > deadline:
        raise RescoreDeadline(f'the deadline passed before {before}')


def _check_active(cur: Any, sql: str, expected: str | None) -> None:
    """Read (and, by ``sql``, lock) the active pointer. Unless ``expected`` is
    None, it must name ``expected``."""
    cur.execute(sql)
    row = cur.fetchone()
    found = None if row is None else row[0]
    if expected is not None and found != expected:
        raise PointerMoved(f'the active pointer names {found}, not {expected}')


def _check_candidate(cur: Any, version: str) -> None:
    """The dry run's stand-in for the promotion's conditional status UPDATE."""
    cur.execute(_STATUS_SQL, (version,))
    row = cur.fetchone()
    status = None if row is None else row[0]
    if status != 'shadow':
        raise PointerMoved(f'{version} is {status}, not a shadow')


def _rescore_pages(
    cur: Any,
    *,
    to_version: str,
    weights: Mapping[str, Any],
    reason: str,
    dry_run: bool,
    deadline: float | None,
    only_tag: str | None,
) -> RescoreResult:
    scanned = changed = score_changed = snapshot_rows = 0
    after = 0  # ids are BIGSERIAL, from 1
    while True:
        _check_deadline(deadline, 'a page')
        if only_tag is None:
            cur.execute(_PAGE_SQL, (after, PAGE_ROWS))
        else:
            cur.execute(_PAGE_TAGGED_SQL, (after, only_tag, PAGE_ROWS))
        rows = cur.fetchall()
        scanned += len(rows)
        changes = _changes(rows, to_version, weights)
        if changes:
            snapshot_rows += 1
            score_changed += sum(1 for c in changes if c.score != c.old)
            if dry_run:
                changed += len(changes)
            else:
                changed += _write_page(
                    cur,
                    changes,
                    to_version=to_version,
                    reason=reason,
                    deadline=deadline,
                )
        if len(rows) < PAGE_ROWS:
            break
        after = rows[-1][0]
    return RescoreResult(scanned, changed, snapshot_rows, False, score_changed)


def _changes(
    rows: Sequence[tuple], to_version: str, weights: Mapping[str, Any]
) -> list[_Change]:
    """The fires of one page whose score or tag the rescore changes. A row is
    ``(id, score, score_version, *SCORE_COLUMNS)``."""
    if not rows:
        return []
    frame = pd.DataFrame([row[3:] for row in rows], columns=list(SCORE_COLUMNS))
    new_scores = score_frame(weights, frame)
    changes = []
    for (fire_id, old, old_tag, *_), new in zip(rows, new_scores, strict=True):
        # Python ints and None: psycopg2 cannot send a numpy integer.
        score = None if pd.isna(new) else int(new)
        if score != old or old_tag != to_version:
            changes.append(_Change(fire_id, score, old, old_tag))
    return changes


def _write_page(
    cur: Any,
    changes: Sequence[_Change],
    *,
    to_version: str,
    reason: str,
    deadline: float | None,
) -> int:
    """Snapshot the page's old values, then write it ``WRITE_ROWS`` at a time.
    Returns the fires the UPDATEs returned."""
    # Lists, not tuples: psycopg2 sends a list as an ARRAY, a tuple as a record.
    cur.execute(
        _SNAPSHOT_SQL,
        (
            reason,
            to_version,
            [c.id for c in changes],
            [None if c.old is None else float(c.old) for c in changes],
            [c.old_tag for c in changes],
        ),
    )
    written = 0
    for start in range(0, len(changes), WRITE_ROWS):
        batch = changes[start : start + WRITE_ROWS]
        _check_deadline(deadline, 'a write batch')
        returned = execute_values(
            cur,
            _UPDATE_SQL,
            [(c.id, c.score, to_version, c.old, c.old_tag) for c in batch],
            template=_UPDATE_ROW,
            page_size=len(batch),  # one statement, so RETURNING is this batch's
            fetch=True,
        )
        if len(returned) < len(batch):
            raise ConcurrentScoreWriter(
                f'{len(batch) - len(returned)} of {len(batch)} fires in a write '
                'batch changed score or score_version after this rescore read '
                'them'
            )
        written += len(returned)
    return written


def _promote(
    cur: Any, to_version: str, expect_active: str, verdict: Mapping[str, Any] | None
) -> None:
    patch: dict[str, Any] = {'replaced': expect_active}
    if verdict is not None:
        patch['verdict'] = verdict
    cur.execute(_PROMOTE_SQL, (Json(patch), to_version))
    if len(cur.fetchall()) != 1:
        raise PointerMoved(f'{to_version} is no longer a shadow')
    cur.execute(_MOVE_ACTIVE_SQL, (to_version, expect_active))
    if len(cur.fetchall()) != 1:
        raise PointerMoved(f'the active pointer no longer names {expect_active}')


# ── CLI ─────────────────────────────────────────────────────────────────────


def _reason(value: str) -> str:
    """argparse ``type=``: refuse a bad reason before connecting."""
    if not _REASON.fullmatch(value):
        raise argparse.ArgumentTypeError(f'must match {_REASON.pattern}')
    return value


def _tag(value: str) -> str:
    """argparse ``type=``: refuse an empty tag before connecting."""
    if not value:
        raise argparse.ArgumentTypeError('must not be empty')
    return value


def _load_version(conn: Any, version: str | None) -> tuple[str, Mapping[str, Any]]:
    """The version to score with and its validated weights: ``version`` from
    lottery_score_versions, or the one the ``active`` pointer names."""
    if version is None:
        return load_pointer(conn, 'active')
    with conn.cursor() as cur:
        cur.execute(_VERSION_SQL, (version,))
        row = cur.fetchone()
    if row is None:
        raise LookupError(f'lottery_score_versions has no version {version}')
    validate_weights(row[0])
    return version, row[0]


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description=(
            'Rescore every stored lottery fire with one weights version, in one '
            'transaction, snapshotting each score it replaces. A dry run unless '
            '--write is given. It never moves a pointer.'
        )
    )
    parser.add_argument(
        '--version',
        help=(
            "a stored version to score with, not pinned (default: the one "
            "'active' names, pinned for the run)"
        ),
    )
    parser.add_argument(
        '--only-tag',
        type=_tag,
        help=(
            'rescore only the fires whose score_version is this one, leaving '
            'every other tag and every NULL one alone (default: every fire)'
        ),
    )
    parser.add_argument(
        '--reason',
        type=_reason,
        default='manual',
        help='the snapshot rows\' reason (default: manual)',
    )
    parser.add_argument(
        '--write',
        action='store_true',
        help=(
            'write the scores; without it, read every fire and write nothing. '
            'Write outside 13:00-24:00 UTC on weekdays: it locks every fire it '
            'rewrites, and the live crons that write fires would block or '
            'deadlock on them'
        ),
    )
    args = parser.parse_args(argv)

    # The CLI's helpers. The nightly step imports rescore_all only.
    from _cli_paths import load_env_file
    from _pipeline_retry import connect_with_retry

    load_env_file(ROOT / '.env.local')
    db_url = os.environ.get('DATABASE_URL_UNPOOLED') or os.environ.get(
        'DATABASE_URL'
    )
    if not db_url:
        sys.exit('DATABASE_URL_UNPOOLED / DATABASE_URL not set')

    started = time.monotonic()
    conn = connect_with_retry(db_url)
    try:
        # Each read before the rescore commits on its own, so rescore_all
        # starts outside a transaction.
        conn.autocommit = True
        try:
            version, weights = _load_version(conn, args.version)
        except (LookupError, WeightsInvalid) as exc:
            sys.exit(f'[rescore] {exc}')
        try:
            result = rescore_all(
                conn,
                to_version=version,
                weights=weights,
                reason=args.reason,
                expect_active=None,
                dry_run=not args.write,
                # The module docstring says why an explicit --version is not
                # pinned.
                pin_active=args.version is None,
                only_tag=args.only_tag,
            )
        except (PointerMoved, ConcurrentScoreWriter, LockNotAvailable) as exc:
            # A Postgres message can span lines (its CONTEXT); keep one.
            message = ' '.join(str(exc).split())
            sys.exit(
                f'[rescore] {type(exc).__name__}: {message}. Rolled back, '
                'nothing written.'
            )
    finally:
        conn.close()

    verb = 'wrote' if args.write else 'would write'
    mode = 'written' if args.write else 'dry run, nothing written (pass --write)'
    print(
        f'[rescore] {version}: scanned {result.scanned:,}, {verb} '
        f'{result.changed:,} ({result.score_changed:,} with a new score, the '
        f'rest a new score_version) in {result.snapshot_rows:,} snapshot rows, '
        f'{time.monotonic() - started:.1f} s; {mode}'
    )


if __name__ == '__main__':
    main()
