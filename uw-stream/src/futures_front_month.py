"""The per-session front-month rule for the futures_trades handler.

Python copy of ``api/_lib/futures-contracts.ts`` (the pure rule) and
``api/_lib/futures-front-month.ts`` (the store). Both copies run the
``cmeTradeDate`` and ``decideFrontMonth`` lists of
``api/__tests__/fixtures/futures-roll-cases.json``, so the rule cannot drift
apart. Its third list, ``pickScheduledFront``, is TypeScript-only: it is the
REST minute builder, which picks the larger-volume spelling's row, where the
live handler folds both spellings' prints into one bar. The SQL here is run
on PGlite by ``api/__tests__/futures-front-month-python-sql-pglite.test.ts``.
Plan: ``docs/superpowers/specs/2026-11-06-futures-session-front-month.md``.

A bar's contract is one contract per root per CME trade date. A session runs
from 17:00 America/Chicago on the evening before its trade date to 17:00 on
it, so ``trade_date`` is the Chicago date of the instant plus seven hours. The
contract of a date is decided once, from the latest earlier decision (the
incumbent) and the per-contract volume of the latest earlier date that has
any, and stored in ``futures_front_month``. It only ever rolls forward: a
contract that expires on or before the incumbent is never chosen.

Every contract is handled under one canonical name, root + CME month code +
last year digit (``ESZ26`` is ``ESZ6``). A symbol with no canonical name (a
spread, another root, a two-digit year outside the window) is ignored.

``ensure_front`` is the live writer (``source = 'live'``). It is written for
many writers at once (this service, the gap cron, scripts), so:

- the stored row is read first and only a missing one is decided;
- the insert is ``ON CONFLICT DO NOTHING`` and the row is read back, so a
  writer that lost the race returns the winner's contract;
- a row is never updated.

The series stays forward-only whatever order dates are asked for in, and
``ensure_front`` itself enforces it:

- Fill forward: a date is decided from the latest earlier decision, so the
  sessions in between that have volume rows but no decision are decided
  first, oldest first. With no earlier decision there is nothing to fill from.
  The fill stops at ``FILL_CAP`` dates a call (each filled date is three round
  trips, and the caller is a flush that must not stall): past the cap
  ``ensure_front`` returns None, the caller treats the minute as a gap, and
  the next call carries on from the dates now stored.
- Ceiling: a date decided after a later one (an old gap, volume rows that
  landed late) is never later than the earliest decision after it. A clamp is
  logged at error level, so it reaches Sentry.

Renew, fail, expire: there is no lease and nothing to expire. A writer that
dies before its insert leaves nothing; one that dies mid-fill leaves the
decisions it wrote, each a valid one. The next call decides the rest again
from the same inputs, or from newer volume rows if some landed, and either
answer is a valid one for a date nobody has decided.

Accepted risk, a window of one round trip: the inputs are read in one
statement and the decision is inserted in another. A volume row that lands in
between, while a second process decides a different date, can leave one
out-of-order pair, and the ceiling cannot help: it bounds a date by the rows
that exist when it is read, not by one inserted after. It needs a late volume
writer and two processes deciding two dates within the same few tens of
milliseconds. The TypeScript copy has the same window. Closing it would take a
conditional insert; it is left open.

``load_tally`` and ``save_tally`` read and write the live tally in
``futures_contract_volume``. One source per (product, trade date): a session
that already has ``candles`` rows takes no live row, in the same statement.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import NamedTuple
from zoneinfo import ZoneInfo

import db
from logger_setup import log, rate_limited_log

_SCOPE = "futures_front_month"

# Dates a single ensure_front call fills before it gives up and returns None.
FILL_CAP = 10

# ----------------------------------------------------------------------
# Contract names
# ----------------------------------------------------------------------

# CME month codes, January to December.
MONTH_CODES = "FGHJKMNQUVXZ"

# Contract months each root's front month moves through, in calendar order:
# quarterly for the equity indexes and ZN, every month for CL, the even months
# for GC (its odd months never lead). The keys are the six roots the handler
# writes.
CONTRACT_CYCLE: dict[str, str] = {
    "ES": "HMUZ",
    "NQ": "HMUZ",
    "RTY": "HMUZ",
    "ZN": "HMUZ",
    "CL": MONTH_CODES,
    "GC": "GJMQVZ",
}

# Months before its contract month that a root stops trading. CL stops in the
# month before (CLZ6 stops in November); the rest trade through it.
_MONTHS_STOPPED_EARLY: dict[str, int] = {
    "ES": 0,
    "NQ": 0,
    "RTY": 0,
    "CL": 1,
    "GC": 0,
    "ZN": 0,
}

# A one-digit year is the one year in [ref - 1, ref + 8] ending in that digit.
_YEARS_BEFORE_REF = 1

# An outright contract sym: the root, one CME month code and a one- or
# two-digit year (ESZ6, ESZ26). This is also the acceptance test of the CHECK
# on futures_bars.contract (migration #204). ``fullmatch`` rather than
# ``^...$``: ``$`` also matches before a trailing newline. ``[0-9]`` rather
# than ``\d``, which matches any Unicode digit.
OUTRIGHT_SYM: dict[str, re.Pattern[str]] = {
    root: re.compile(rf"{re.escape(root)}[{MONTH_CODES}][0-9]{{1,2}}") for root in CONTRACT_CYCLE
}


class ParsedContract(NamedTuple):
    """A contract's expiry. Tuple order is expiry order: ``a < b`` when ``a``
    expires first, which is the TypeScript ``compareExpiry``."""

    year: int
    month: int


def is_outright(root: str, sym: str) -> bool:
    """True when ``sym`` is an outright contract of ``root`` (ESZ6, ESZ26).

    The websocket frames carry no ``is_spread`` key (frame capture,
    2026-10-28), so this shape test is what keeps spread syms (ESZ6-ESH7,
    ESZ6:ESH7, UD:...) out of the bars.
    """
    pattern = OUTRIGHT_SYM.get(root)
    return pattern is not None and pattern.fullmatch(sym) is not None


def _decode(root: str, sym: str, ref_year: int) -> ParsedContract:
    """``sym`` must already pass ``is_outright``."""
    month = MONTH_CODES.index(sym[len(root)]) + 1
    digits = sym[len(root) + 1 :]
    value = int(digits)
    if len(digits) == 2:
        return ParsedContract(2000 + value, month)
    first = ref_year - _YEARS_BEFORE_REF
    return ParsedContract(first + ((value - first % 10 + 10) % 10), month)


def parse_contract(root: str, sym: str, ref: date) -> ParsedContract | None:
    """The expiry of a dated outright, or None unless ``sym`` is exactly
    ``root`` + one CME month code + one or two ASCII digits.

    A two-digit year is 20YY. A one-digit year is the one year in
    [ref - 1, ref + 8] that ends in that digit, ref being the year of ``ref``
    (the trade date): at 2026, ``Z6`` is 2026, ``H7`` is 2027, ``H0`` is 2030
    and ``Z5`` is 2025.
    """
    return _decode(root, sym, ref.year) if is_outright(root, sym) else None


def _canonical_at(root: str, sym: str, ref_year: int) -> str | None:
    if not is_outright(root, sym):
        return None
    name = sym[: len(root) + 1] + sym[-1]
    same_year = _decode(root, sym, ref_year).year == _decode(root, name, ref_year).year
    return name if same_year else None


def canonical_contract(root: str, sym: str, ref: date) -> str | None:
    """The one name a contract has everywhere (stored ``contract`` values, the
    tally, the bar): the one-digit form, so ``ESZ26`` is ``ESZ6``.

    None where ``parse_contract`` is None, or where the year is outside the
    one-digit window [ref - 1, ref + 8]: one digit cannot name that year
    without colliding with a nearer contract (at 2026, ``CLZ36`` would fold
    onto ``CLZ6``).
    """
    return _canonical_at(root, sym, ref.year)


def _format(root: str, contract: ParsedContract) -> str:
    return f"{root}{MONTH_CODES[contract.month - 1]}{contract.year % 10}"


def _first_live_contract(root: str, ref: date) -> ParsedContract:
    """The first contract in the root's cycle whose last-trade month is not
    before ``ref``'s month. One always exists within a year."""
    ref_index = ref.year * 12 + ref.month - 1
    early = _MONTHS_STOPPED_EARLY[root]
    year = ref.year
    while True:
        for code in CONTRACT_CYCLE[root]:
            month = MONTH_CODES.index(code) + 1
            if year * 12 + month - 1 - early >= ref_index:
                return ParsedContract(year, month)
        year += 1


def null_seed_contract(root: str, ref: date) -> str:
    """The seed when there is no incumbent and no volume: the first contract in
    the root's ``CONTRACT_CYCLE`` whose last-trade month is not before the
    month of ``ref``, in the one-digit form. ES on 2026-12-20 is still
    ``ESZ6``: it has expired, and the rule moves on from there, late.

    Why the cycle and not the earliest contract seen printing: a cold start has
    no candidate list, and the session's first print can be a back month. A
    seed that is too early can only make the roll late. One that is too late
    can never come back.
    """
    return _format(root, _first_live_contract(root, ref))


# ----------------------------------------------------------------------
# The per-session rule
# ----------------------------------------------------------------------

_CT = ZoneInfo("America/Chicago")

# Seven hours: the 17:00 CT open of a session is 00:00 of its date.
_TRADE_DATE_OFFSET = timedelta(hours=7)


def trade_date(ts: datetime) -> date:
    """The CME trade date of an instant: the America/Chicago calendar date of
    ``ts`` + 7 hours. A session runs from 17:00 CT on the evening before its
    trade date to 17:00 on it, so the instant that opens a session (23:00Z in
    winter, 22:00Z in summer) is already on its date.

    The seven hours are added to the UTC instant, not to a wall clock, so an
    input in any zone gives the same answer. Raises ValueError for a naive
    datetime, which would otherwise be read as the machine's local time.
    """
    if ts.tzinfo is None:
        raise ValueError(f"trade_date needs a timezone-aware datetime, got {ts!r}")
    return (ts.astimezone(UTC) + _TRADE_DATE_OFFSET).astimezone(_CT).date()


@dataclass
class _Traded:
    name: str
    expiry: ParsedContract
    volume: int


def _most_traded(candidates: Sequence[_Traded]) -> _Traded | None:
    """The most volume; a tie goes to the earlier expiry, whatever the order."""
    best: _Traded | None = None
    for c in candidates:
        if (
            best is None
            or c.volume > best.volume
            or (c.volume == best.volume and c.expiry < best.expiry)
        ):
            best = c
    return best


def decide_front(
    incumbent: str | None,
    volumes: Mapping[str, int],
    product: str,
    trade_date: date,
) -> str:
    """The front month for ``trade_date``, decided once from what the previous
    date left behind. ``incumbent`` is the contract of the latest earlier
    decision (None: none), ``volumes`` the per-contract volume of the latest
    earlier date that has any. With C the contract that expires after the
    incumbent and has the most volume (a tie goes to the earlier expiry):

    - the front is C when C's volume is larger than the incumbent's (0 for a
      contract missing from ``volumes``), else the incumbent: a tie keeps it;
    - with no incumbent, the contract with the most volume (a tie goes to the
      earlier expiry);
    - with no incumbent and no volume, ``null_seed_contract``.

    A contract expiring on or before the incumbent is never chosen, so the
    series only moves forward, and a false lead can roll it one session early
    at most.

    Every name, the incumbent's included, is first made canonical against
    ``trade_date`` (``ESZ26`` is ``ESZ6``; their volumes sum), and the answer
    is canonical. A volume key that is not an outright of ``product`` is
    dropped. A bad incumbent raises ValueError: it comes from a table only
    this rule writes, so treating it as none would reseed over a corrupt row.
    """
    ref_year = trade_date.year
    traded: dict[str, _Traded] = {}
    for sym, volume in volumes.items():
        name = _canonical_at(product, sym, ref_year)
        if name is None:
            continue
        seen = traded.get(name)
        if seen is None:
            traded[name] = _Traded(name, _decode(product, name, ref_year), volume)
        else:
            seen.volume += volume

    if incumbent is None:
        best = _most_traded(list(traded.values()))
        return best.name if best is not None else null_seed_contract(product, trade_date)

    held = _canonical_at(product, incumbent, ref_year)
    if held is None:
        raise ValueError(
            f"decide_front: incumbent {incumbent!r} is not an outright {product} "
            f"contract on {trade_date}"
        )
    held_expiry = _decode(product, held, ref_year)
    challenger = _most_traded([c for c in traded.values() if c.expiry > held_expiry])
    held_volume = traded[held].volume if held in traded else 0
    return challenger.name if challenger is not None and challenger.volume > held_volume else held


def ceiling_contract(
    product: str, trade_date: date, wanted: str, ceiling: str | None
) -> tuple[str, bool]:
    """``wanted``, unless it expires after ``ceiling``, the contract of the
    earliest decision stored after the date (None: none): then ``ceiling`` in
    its canonical name, with ``clamped`` True. A decision is write-once, so a
    date decided after a later one must not be later than it, or the series
    would step back. Raises ValueError on a ceiling that is no outright of the
    product (a corrupt row; fail, don't guess).
    """
    if ceiling is None:
        return wanted, False
    cap = canonical_contract(product, ceiling, trade_date)
    cap_expiry = None if cap is None else parse_contract(product, cap, trade_date)
    wanted_expiry = parse_contract(product, wanted, trade_date)
    if cap is None or cap_expiry is None or wanted_expiry is None:
        raise ValueError(
            f"{product} front month for {trade_date}: the next stored decision, "
            f"{ceiling!r}, is not an outright {product} contract"
        )
    return (wanted, False) if wanted_expiry <= cap_expiry else (cap, True)


# ----------------------------------------------------------------------
# The store
# ----------------------------------------------------------------------


def _now() -> datetime:
    return datetime.now(UTC)


def current_trade_date() -> date:
    """The CME trade date of the clock now."""
    return trade_date(_now())


# root -> (kind, exception class name) of the last ``ensure_front`` that came
# back None, cleared by its next success. At most one entry per root (six), so
# the handler can say WHY a session has no contract when it logs the gap.
_last_failure: dict[str, tuple[str, str]] = {}


def last_failure(product: str) -> tuple[str, str] | None:
    """The cause of the last ``ensure_front`` for ``product`` that returned
    None, as (kind, exception class name; empty for a cause with none), or
    None when its last call succeeded."""
    return _last_failure.get(product)


def _fail(
    kind: str,
    product: str,
    day: date,
    message: str,
    exc: BaseException | None = None,
    *,
    warn: bool = False,
    **extra,
) -> None:
    """Record and report one ``ensure_front`` failure, per root.

    A transient database error (a timeout, a dropped connection) is a warning,
    and so is a failure the caller passes ``warn=True`` for: the caller asks
    again, and the handler escalates the minutes it costs. Any other failure (a
    bad row, a rejected statement, the fill cap) is an error, so it reaches
    Sentry before the next open turns it into a day of gaps. Throttled per
    root, so six roots failing at once are six lines.
    """
    err_type = type(exc).__name__ if exc is not None else ""
    _last_failure[product] = (kind, err_type)
    report = (
        rate_limited_log.warning
        if warn or (exc is not None and db.is_transient_db_error(exc))
        else rate_limited_log.error
    )
    detail = {"err_type": err_type, "err": str(exc)} if exc is not None else {}
    report(
        scope=_SCOPE,
        kind=kind,
        message=message,
        extra={"product": product, "trade_date": day.isoformat(), **detail, **extra},
        key=product,
    )


@dataclass
class _Inputs:
    """What the decision for one date starts from."""

    incumbent: str | None
    # The contract of the earliest decision after the date, the most the date
    # may take. None: nothing is decided after it.
    ceiling: str | None
    volumes: dict[str, int] = field(default_factory=dict)
    # The sessions between the incumbent and the date that have volume rows and
    # so no decision, oldest first. Empty with no incumbent.
    undecided: list[date] = field(default_factory=list)


_STORED_SQL = """
SELECT contract
FROM futures_front_month
WHERE product = $1 AND trade_date = $2::date
"""

# Four arms of one UNION ALL, in one round trip, as in readInputs:
#   incumbent: the contract of the latest decision before the date;
#   ceiling:   the contract of the earliest decision after it;
#   volume:    every volume row of the latest earlier trade date that has any
#              (a weekend or holiday has none);
#   undecided: the trade dates with volume rows after the incumbent's date and
#              before this one. The incumbent is the latest decision before the
#              date, so none of them has a decision row. With no incumbent the
#              comparison is against NULL and the arm is empty: a cold start
#              must not walk the whole volume history.
_INPUTS_SQL = """
(SELECT 'incumbent' AS kind, contract, NULL::bigint AS volume, NULL::date AS day
   FROM futures_front_month
  WHERE product = $1 AND trade_date < $2::date
  ORDER BY trade_date DESC
  LIMIT 1)
UNION ALL
(SELECT 'ceiling', contract, NULL::bigint, NULL::date
   FROM futures_front_month
  WHERE product = $1 AND trade_date > $2::date
  ORDER BY trade_date
  LIMIT 1)
UNION ALL
SELECT 'volume', v.contract, v.volume, NULL::date
  FROM futures_contract_volume v
 WHERE v.product = $1
   AND v.trade_date = (SELECT max(trade_date)
                         FROM futures_contract_volume
                        WHERE product = $1
                          AND trade_date < $2::date)
UNION ALL
SELECT DISTINCT 'undecided', NULL::text, NULL::bigint, v.trade_date
  FROM futures_contract_volume v
 WHERE v.product = $1
   AND v.trade_date < $2::date
   AND v.trade_date > (SELECT max(trade_date)
                         FROM futures_front_month
                        WHERE product = $1
                          AND trade_date < $2::date)
"""

_INSERT_DECISION_SQL = """
INSERT INTO futures_front_month (product, trade_date, contract, source)
VALUES ($1, $2::date, $3, 'live')
ON CONFLICT (product, trade_date) DO NOTHING
"""

_LOAD_TALLY_SQL = """
SELECT contract, volume
FROM futures_contract_volume
WHERE product = $1 AND trade_date = $2::date
"""

# Upsert the live tally. The volume only ever rises (GREATEST), so a restart
# that recounts from a lower number cannot lower a stored one. The NOT EXISTS
# is the one-source rule from this side (Phase 5a): a session that already has
# candle rows, for any contract, takes no live row.
_SAVE_TALLY_SQL = """
INSERT INTO futures_contract_volume (product, trade_date, contract, volume, source)
SELECT t.product, t.trade_date, t.contract, t.volume, 'live'
FROM unnest($1::text[], $2::date[], $3::text[], $4::bigint[])
  AS t(product, trade_date, contract, volume)
WHERE NOT EXISTS (
  SELECT 1 FROM futures_contract_volume v
  WHERE v.product = t.product
    AND v.trade_date = t.trade_date
    AND v.source = 'candles'
)
ON CONFLICT (product, trade_date, contract) DO UPDATE
SET volume = GREATEST(futures_contract_volume.volume, EXCLUDED.volume),
    source = 'live',
    updated_at = now()
"""


async def _read_stored(product: str, day: date) -> str | None:
    """The stored contract for one date, or None."""
    rows = await db.fetch("front_month:stored", _STORED_SQL, product, day)
    return rows[0]["contract"] if rows else None


async def _read_inputs(product: str, day: date) -> _Inputs:
    rows = await db.fetch("front_month:inputs", _INPUTS_SQL, product, day)
    inputs = _Inputs(incumbent=None, ceiling=None)
    for r in rows:
        kind = r["kind"]
        if kind == "incumbent":
            inputs.incumbent = r["contract"]
        elif kind == "ceiling":
            inputs.ceiling = r["contract"]
        elif kind == "volume" and r["contract"] is not None:
            inputs.volumes[r["contract"]] = int(r["volume"])
        elif kind == "undecided" and r["day"] is not None:
            inputs.undecided.append(r["day"])
    # SELECT DISTINCT promises no order, and the fill must run oldest first.
    inputs.undecided.sort()
    return inputs


async def _insert_decision(product: str, day: date, contract: str) -> None:
    await db.execute("front_month:insert", _INSERT_DECISION_SQL, product, day, contract)


def _stored_canonical(product: str, day: date, stored: str) -> str:
    """A stored name under its canonical spelling; a bad one is corrupt."""
    name = canonical_contract(product, stored, day)
    if name is None:
        raise ValueError(
            f"{product} front month stored for {day}, {stored!r}, is not an outright "
            f"{product} contract"
        )
    return name


async def _decide_and_store(product: str, day: date, inputs: _Inputs) -> str:
    """Decide one date from ``inputs`` and store it: the cycle-seed warning,
    ``decide_front``, the ceiling, then the insert with ON CONFLICT DO NOTHING
    and a read back, which returns the winner's contract if another writer got
    there first."""
    if inputs.incumbent is None and not inputs.volumes:
        log.warning(
            "No earlier front-month decision and no earlier volume: using the listing-cycle seed",
            extra={
                "scope": _SCOPE,
                "kind": "front_month_cycle_seed",
                "product": product,
                "trade_date": day.isoformat(),
            },
        )
    wanted = decide_front(inputs.incumbent, inputs.volumes, product, day)
    decided, clamped = ceiling_contract(product, day, wanted, inputs.ceiling)
    if clamped:
        # Error, not warning: once the seed has run, a clamp means a late volume
        # row or a date decided out of order, and a log line alone goes unseen.
        log.error(
            "Front-month decision is later than the next stored decision: "
            "using the next stored decision",
            extra={
                "scope": _SCOPE,
                "kind": "front_month_clamped",
                "product": product,
                "trade_date": day.isoformat(),
                "wanted": wanted,
                "ceiling": decided,
                "incumbent": inputs.incumbent,
            },
        )
    await _insert_decision(product, day, decided)
    winner = await _read_stored(product, day)
    if winner is None:
        raise RuntimeError(f"{product} front month for {day} is missing after its insert")
    return _stored_canonical(product, day, winner)


async def _ensure_front(product: str, day: date) -> str | None:
    stored = await _read_stored(product, day)
    if stored is not None:
        return _stored_canonical(product, day, stored)

    first = await _read_inputs(product, day)
    for filled, gap_day in enumerate(first.undecided):
        if filled >= FILL_CAP:
            _fail(
                "front_month_fill_capped",
                product,
                day,
                "front-month fill hit its cap; the date stays undecided until the next call",
                undecided=len(first.undecided),
                filled=filled,
            )
            return None
        await _decide_and_store(product, gap_day, await _read_inputs(product, gap_day))
    # The date's own incumbent is the last row filled.
    inputs = await _read_inputs(product, day) if first.undecided else first
    return await _decide_and_store(product, day, inputs)


async def ensure_front(product: str, trade_date: date) -> str | None:
    """The canonical contract for one root and trade date: the stored row when
    there is one, else decided now (see the module docstring) with
    ``source = 'live'``.

    None means "unknown, ask again", and ``last_failure(product)`` says why:

    - ``date_after_current_trade_date``: a stamp a little ahead of our clock at
      the open, which clears itself (a warning);
    - ``front_month_fill_capped``: ten or more sessions to fill first (an error);
    - ``ensure_front_failed``: a database error (a warning when transient, an
      error otherwise), or a stored row, incumbent or ceiling that is no
      outright of the product, or a row missing after its insert (errors).

    Each is logged through ``rate_limited_log``, one window per root and
    level, because the caller asks again and the log must not grow with it. A
    cancel is not swallowed (the handler's time box relies on it).
    """
    current = current_trade_date()
    if trade_date > current:
        _fail(
            "date_after_current_trade_date",
            product,
            trade_date,
            "front-month date is after the current trade date; asked again later",
            # A date later than the current one has no volume to decide from,
            # and a clock behind the feed corrects itself: not an error.
            warn=True,
            current_trade_date=current.isoformat(),
        )
        return None
    try:
        contract = await _ensure_front(product, trade_date)
    except Exception as exc:
        _fail(
            "ensure_front_failed",
            product,
            trade_date,
            "front-month lookup failed; the date stays undecided",
            exc,
        )
        return None
    if contract is not None:
        _last_failure.pop(product, None)
    return contract


async def load_tally(product: str, trade_date: date) -> dict[str, int]:
    """The live tally stored for one root and trade date, contract -> volume,
    under canonical names (spellings sum; a name no outright could have is
    dropped). A restarted process carries on from it. Raises on a database
    error."""
    rows = await db.fetch("front_month:load_tally", _LOAD_TALLY_SQL, product, trade_date)
    tally: dict[str, int] = {}
    for r in rows:
        name = canonical_contract(product, r["contract"], trade_date)
        if name is not None:
            tally[name] = tally.get(name, 0) + int(r["volume"])
    return tally


async def save_tally(rows: Sequence[tuple[str, date, str, int]]) -> None:
    """Upsert (product, trade date, contract, volume) rows in one statement,
    ``source = 'live'``, the volume only ever rising. A (product, trade date)
    that already has ``candles`` rows is skipped whole. Raises on a database
    error.

    A repeated key is collapsed to its larger volume first: Postgres rejects
    one ``ON CONFLICT DO UPDATE`` that reaches a row twice. The batch is one
    statement however large: a tally is at most about 20 contracts for each of
    six roots and two sessions.
    """
    if not rows:
        return
    merged: dict[tuple[str, date, str], int] = {}
    for product, day, contract, volume in rows:
        key = (product, day, contract)
        merged[key] = max(merged.get(key, volume), volume)
    await db.execute(
        "front_month:save_tally",
        _SAVE_TALLY_SQL,
        [k[0] for k in merged],
        [k[1] for k in merged],
        [k[2] for k in merged],
        list(merged.values()),
    )
