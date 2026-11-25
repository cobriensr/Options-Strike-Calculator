"""Replay of today's live Interval B/A detector over one day of the UW Full Tape.

One implementation of the rule uw-stream runs live (uw-stream/src/handlers/interval_ba.py),
for two callers: the nightly `interval-ba-tape` step, on the day it downloaded, and the one-off
tool scripts/interval_ba_tape.py, over R2 with httpfs. Spec:
docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, section 6.3. The validated
reference query it follows matched live on 1,053 of 1,053 rows over six sessions.

What it never does:
- open R2 or Neon. The caller hands in a DuckDB connection, a tape location (a local path or an
  s3:// URL) and, for the insert, a psycopg2 cursor; the caller commits;
- set DuckDB limits. The caller sets memory_limit, threads and temp_directory;
- fetch a TIMESTAMP or TIMESTAMPTZ column. Every time leaves DuckDB as an epoch_us integer and
  becomes an aware UTC datetime here: DuckDB needs pytz to hand over a TIMESTAMPTZ, and the
  nightly image has none;
- import anything but duckdb, psycopg2 and the standard library. The tool loads this file by
  path, so a nightly import (constants, config, resources) would break it.

Both tape layouts read the same way. Before 2026-05-04 executed_at is a naive TIMESTAMP holding
UTC, prices are DECIMAL(18,4), and tags and report_flags are bare comma lists; from then on
TIMESTAMPTZ, DOUBLE and brace-wrapped lists. epoch_us and epoch give the true instant of either
time type, a DOUBLE cast evens out the numbers, and the token patterns accept either list form.

The rule, as live runs it:
- the scan reads underlying_symbol IN (SPXW, SPY, QQQ, SPX), so the filter pushes down to the
  file, then keeps a row by its OCC root, as the live guard does. The websocket labels SPXW
  prints SPX, and SPX-root contracts are another product. Kept rows whose label is not their
  root are counted (`root_label_mismatch`), never dropped;
- a row is kept when price > 0 and size > 0, canceled or not, at any hour, when its contract
  expires on the CT date of its instant (0DTE);
- per contract, ticks fall in 300 s buckets on the UTC epoch, in executed_at order and then
  the file's row order;
- premiums are integer cents. A bucket fires on the first tick after which, over its ticks so
  far, total >= $250,000, ask / total >= 0.75 and multi-leg / total < 0.5; later ticks in that
  bucket are ignored. The ask side is the first side token in tags, as `_derive_side` reads it;
  a multi-leg print carries one of the nine trade codes;
- the alert is the bucket at that crossing tick: its sums and tick count, the largest ask print
  so far (the earliest wins a tie), the crossing tick's own spot and its time as fired_at.

Where the replay differs from what live writes, by design (spec 6.3):
- fired_at is the crossing tick's time, not the wall clock of live's drain loop;
- sweep and floor come from the top trade's report_flags (`intermarket_sweep`, `futures_floor`),
  the rule live runs since its 2026-11-24 fix; older live rows hold false for both;
- an SPXW crossing tick with no spot (the opening seconds on some days) takes the first kept
  SPXW print with a spot after it; live writes NULL for every SPXW row;
- confluence is computed over the day's complete set of replay fires (section 4.3 of the
  detector spec) on the live window: other tickers with a same-type fire 0 to 90 s back,
  inclusive at both ends. Live's own tags come from its wall clock and its in-memory registry.
"""

from __future__ import annotations

import bisect
from collections.abc import Sequence
from dataclasses import dataclass, fields, replace
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Context, Decimal

import duckdb
import psycopg2.extras

# The live detector's rule. tests/test_interval_ba_drift.py pins each against uw-stream.
TICKERS: tuple[str, ...] = ("SPXW", "SPY", "QQQ")
RATIO_THRESHOLD = Decimal("0.75")
PREMIUM_FLOOR_DOLLARS = 250_000
WINDOW_SEC = 300
MULTI_LEG_SHARE_MAX = Decimal("0.5")
MULTI_LEG_CODES: frozenset[str] = frozenset(
    {"mlat", "mlet", "mlft", "masl", "mesl", "mfsl", "mlct", "cbmo", "mctp"}
)
CONFLUENCE_WINDOW_SEC = 90

# The first live row is 2026-05-13 15:55:37Z. Live ran today's nine codes from the 2026-10-29
# session on, so only from then may the replay add the alerts live missed.
LIVE_START = date(2026, 5, 13)
INSERT_MISSED_FROM = date(2026, 10, 29)

# The fire test in integers: ask / total >= 3/4 is 4 * ask >= 3 * total, and multi-leg / total
# < 1/2 is 2 * multi-leg < total.
_FLOOR_CENTS = PREMIUM_FLOOR_DOLLARS * 100
_RATIO_NUM, _RATIO_DEN = RATIO_THRESHOLD.as_integer_ratio()
_SHARE_NUM, _SHARE_DEN = MULTI_LEG_SHARE_MAX.as_integer_ratio()

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_CENT = Decimal("0.01")
# The live handler divides in Python's default decimal context; this one is the same, and
# immune to a caller changing the thread's context.
_LIVE_DECIMAL = Context(prec=28, rounding=ROUND_HALF_EVEN)
# Rows per INSERT statement.
_PAGE_ROWS = 500


@dataclass(frozen=True)
class TapeAlert:
    """One replay alert, in the column order of `interval_ba_alerts`."""

    option_chain: str
    ticker: str
    option_type: str  # 'C' or 'P'
    strike: Decimal
    expiry: date
    bucket_start: datetime
    bucket_end: datetime
    fired_at: datetime  # aware UTC, milliseconds
    ratio_pct: Decimal
    ask_premium: Decimal
    total_premium: Decimal
    trade_count: int
    top_trade_premium: Decimal
    top_trade_size: int
    top_trade_executed_at: datetime  # aware UTC, milliseconds
    top_trade_is_sweep: bool
    top_trade_is_floor: bool
    underlying_price: Decimal | None
    confluence_tickers: tuple[str, ...]

    @property
    def key(self) -> tuple[str, datetime]:
        """The table's unique key."""
        return (self.option_chain, self.bucket_start)


ALERT_INSERT_COLUMNS: tuple[str, ...] = (*(f.name for f in fields(TapeAlert)), "source")


@dataclass(frozen=True)
class Replay:
    """A day's alerts, sorted by (fired_at, ticker, option_chain), and the kept rows whose
    underlying_symbol is not their OCC root."""

    alerts: tuple[TapeAlert, ...]
    root_label_mismatch: int


@dataclass(frozen=True)
class LiveRow:
    """An `interval_ba_alerts` row as the tape pass reads it."""

    id: int
    option_chain: str
    ticker: str
    bucket_start: datetime
    fired_at: datetime
    trade_count: int
    ratio_pct: Decimal
    ask_premium: Decimal
    total_premium: Decimal
    top_trade_premium: Decimal | None
    top_trade_size: int | None
    top_trade_executed_at: datetime | None
    top_trade_is_sweep: bool | None
    top_trade_is_floor: bool | None
    underlying_price: Decimal | None
    source: str


def _sql_list(values: Sequence[str]) -> str:
    """A SQL list of string literals, for the module's own constants only."""
    return ", ".join(f"'{value}'" for value in values)


# The SQL pieces both readers share. The token patterns hold braces, so these four are plain
# strings; the queries below take them as f-string values, which are never parsed for braces.
_ROOT = "left(option_chain_id, length(option_chain_id) - 15)"
_PREMIUM_CENTS = "CAST(round(CAST(price AS DOUBLE) * 10000) AS BIGINT) * CAST(size AS BIGINT)"
# The first of ask_side, bid_side and mid_side in tags, as a whole token, is the side.
_IS_ASK = (
    "coalesce(regexp_extract(tags, '(?:^|[{,])(ask_side|bid_side|mid_side)(?:[},]|$)', 1)"
    " = 'ask_side', false)"
)
_IS_SWEEP = "coalesce(regexp_matches(report_flags, '(?:^|[{,])intermarket_sweep(?:[},]|$)'), false)"
_IS_FLOOR = "coalesce(regexp_matches(report_flags, '(?:^|[{,])futures_floor(?:[},]|$)'), false)"
# The rows that reach the live detector. The CT date comes from the instant, which is right on
# both layouts under any session time zone: `executed_at AT TIME ZONE` misdates a naive column.
_KEPT = f"""
    underlying_symbol IN ({_sql_list((*TICKERS, "SPX"))})
    AND expiry = $day
    AND price > 0 AND size > 0
    AND expiry = CAST(to_timestamp(epoch(executed_at)) AT TIME ZONE 'America/Chicago' AS DATE)
    AND {_ROOT} IN ({_sql_list(TICKERS)})
"""

_REPLAY_SQL = f"""
WITH ticks AS MATERIALIZED (
    SELECT *,
        row_number() OVER bucket_so_far AS seq,
        CAST(sum(prem_c) OVER bucket_so_far AS BIGINT) AS tot,
        CAST(sum(CASE WHEN is_ask THEN prem_c ELSE 0 END) OVER bucket_so_far AS BIGINT) AS ask,
        CAST(sum(CASE WHEN is_ml THEN prem_c ELSE 0 END) OVER bucket_so_far AS BIGINT) AS ml
    FROM (
        SELECT
            option_chain_id AS chain,
            {_ROOT} AS root,
            underlying_symbol <> {_ROOT} AS mislabeled,
            epoch_us(executed_at) AS us,
            file_row_number AS frn,
            epoch_us(executed_at) // $window_us * $window_sec AS bucket,
            CAST(size AS BIGINT) AS size,
            {_PREMIUM_CENTS} AS prem_c,
            {_IS_ASK} AS is_ask,
            coalesce(list_contains($codes, lower(upstream_condition_detail)), false) AS is_ml,
            {_IS_SWEEP} AS is_sweep,
            {_IS_FLOOR} AS is_floor,
            CAST(underlying_price AS DOUBLE) AS spot
        FROM read_parquet($tape, file_row_number = true)
        WHERE {_KEPT}
    )
    WINDOW bucket_so_far AS (
        PARTITION BY chain, bucket ORDER BY us, frn
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
),
-- The crossing tick: the first tick of its bucket after which all three conditions hold.
fires AS MATERIALIZED (
    SELECT * FROM ticks
    WHERE tot >= $floor_cents
      AND ask * $ratio_den >= tot * $ratio_num
      AND ml * $share_den < tot * $share_num
    QUALIFY row_number() OVER (PARTITION BY chain, bucket ORDER BY seq) = 1
),
-- The largest ask print up to and including the crossing tick; the earliest wins a tie.
top AS (
    SELECT chain, bucket, prem_c, size, us, is_sweep, is_floor FROM (
        SELECT t.*,
            row_number() OVER (PARTITION BY t.chain, t.bucket ORDER BY t.prem_c DESC, t.seq)
                AS place
        FROM ticks t JOIN fires f ON t.chain = f.chain AND t.bucket = f.bucket
        WHERE t.is_ask AND t.seq <= f.seq
    )
    WHERE place = 1
),
-- An SPXW crossing tick with no spot takes the first kept SPXW print with one after it.
filled AS (
    SELECT f.chain, f.bucket, arg_min(t.spot, {{'us': t.us, 'frn': t.frn}}) AS spot
    FROM fires f JOIN ticks t
      ON t.root = 'SPXW' AND t.spot IS NOT NULL
     AND (t.us > f.us OR (t.us = f.us AND t.frn > f.frn))
    WHERE f.root = 'SPXW' AND f.spot IS NULL
    GROUP BY f.chain, f.bucket
)
-- One row even on a day with no fires, so the mismatch count always comes back.
SELECT
    m.mislabeled, f.chain, f.root, f.bucket, f.us, f.seq, f.ask, f.tot,
    coalesce(f.spot, filled.spot) AS spot,
    top.prem_c, top.size, top.us, top.is_sweep, top.is_floor
FROM (SELECT count(*) FILTER (WHERE mislabeled) AS mislabeled FROM ticks) m
LEFT JOIN fires f ON true
LEFT JOIN top ON top.chain = f.chain AND top.bucket = f.bucket
LEFT JOIN filled ON filled.chain = f.chain AND filled.bucket = f.bucket
"""

_FLAGS_SQL = f"""
WITH wanted AS (
    SELECT unnest($ids) AS id, unnest($chains) AS chain, unnest($ms) AS ms,
        unnest($sizes) AS size, unnest($cents) AS prem_c
),
prints AS (
    SELECT
        option_chain_id AS chain,
        epoch_us(executed_at) // 1000 AS ms,
        CAST(size AS BIGINT) AS size,
        {_PREMIUM_CENTS} AS prem_c,
        {_IS_SWEEP} AS is_sweep,
        {_IS_FLOOR} AS is_floor
    FROM read_parquet($tape)
    WHERE {_KEPT} AND {_IS_ASK}
)
SELECT w.id, count(p.chain),
    bool_or(p.is_sweep), bool_and(p.is_sweep), bool_or(p.is_floor), bool_and(p.is_floor)
FROM wanted w LEFT JOIN prints p
  ON p.chain = w.chain AND p.ms = w.ms AND p.size = w.size AND p.prem_c = w.prem_c
GROUP BY w.id
"""


def _utc(us: int) -> datetime:
    """An aware UTC datetime from epoch microseconds, truncated to the millisecond."""
    return _EPOCH + timedelta(microseconds=us - us % 1000)


def _dollars(cents: int) -> Decimal:
    return Decimal(cents).scaleb(-2)


def _ratio_pct(ask_cents: int, total_cents: int) -> Decimal:
    """ask / total as a percentage, rounded half-even to 2 places, the way live computes it."""
    ratio = _LIVE_DECIMAL.divide(Decimal(ask_cents), Decimal(total_cents))
    return _LIVE_DECIMAL.multiply(ratio, Decimal(100)).quantize(_CENT, rounding=ROUND_HALF_EVEN)


def _spot(value: float | None) -> Decimal | None:
    """The tape spot as NUMERIC(10,2) stores live's string: rounded half-up to 2 places."""
    if value is None:
        return None
    return Decimal(str(value)).quantize(_CENT, rounding=ROUND_HALF_UP)


def _confluence(fires: Sequence[tuple[datetime, str, str]]) -> list[tuple[str, ...]]:
    """Each fire's partners under the live rule (uw-stream recent_fires.lookup_confluence).

    `fires` is (fired_at, ticker, option_type), sorted by fired_at. A fire's partners are the
    other tickers with a same-type fire at fired_at - 90 s <= t <= fired_at: backward only and
    inclusive at both ends. Sorted, and empty when there are none.
    """
    times = [fired_at for fired_at, _, _ in fires]
    window = timedelta(seconds=CONFLUENCE_WINDOW_SEC)
    partners: list[tuple[str, ...]] = []
    for fired_at, ticker, option_type in fires:
        start = bisect.bisect_left(times, fired_at - window)
        end = bisect.bisect_right(times, fired_at)
        partners.append(
            tuple(
                sorted(
                    {
                        other
                        for _, other, other_type in fires[start:end]
                        if other != ticker and other_type == option_type
                    }
                )
            )
        )
    return partners


def replay_day(con: duckdb.DuckDBPyConnection, tape: str, day: date) -> Replay:
    """Every alert today's detector fires on `day`'s 0DTE SPXW, SPY and QQQ contracts.

    Raises what DuckDB raises for a tape it cannot read or that lacks a column.
    """
    rows = con.execute(
        _REPLAY_SQL,
        {
            "tape": tape,
            "day": day,
            "codes": sorted(MULTI_LEG_CODES),
            "window_us": WINDOW_SEC * 1_000_000,
            "window_sec": WINDOW_SEC,
            "floor_cents": _FLOOR_CENTS,
            "ratio_num": _RATIO_NUM,
            "ratio_den": _RATIO_DEN,
            "share_num": _SHARE_NUM,
            "share_den": _SHARE_DEN,
        },
    ).fetchall()
    mislabeled = int(rows[0][0])
    alerts: list[TapeAlert] = []
    for (
        _,
        chain,
        root,
        bucket,
        us,
        seq,
        ask,
        tot,
        spot,
        top_cents,
        top_size,
        top_us,
        top_sweep,
        top_floor,
    ) in rows:
        if chain is None:  # the single row of a day with no fires
            continue
        bucket_start = _EPOCH + timedelta(seconds=bucket)
        alerts.append(
            TapeAlert(
                option_chain=chain,
                ticker=root,
                option_type=chain[-9],
                strike=Decimal(int(chain[-8:])).scaleb(-3),
                expiry=day,
                bucket_start=bucket_start,
                bucket_end=bucket_start + timedelta(seconds=WINDOW_SEC),
                fired_at=_utc(us),
                ratio_pct=_ratio_pct(ask, tot),
                ask_premium=_dollars(ask),
                total_premium=_dollars(tot),
                trade_count=seq,
                top_trade_premium=_dollars(top_cents),
                top_trade_size=top_size,
                top_trade_executed_at=_utc(top_us),
                top_trade_is_sweep=top_sweep,
                top_trade_is_floor=top_floor,
                underlying_price=_spot(spot),
                confluence_tickers=(),
            )
        )
    alerts.sort(key=lambda a: (a.fired_at, a.ticker, a.option_chain))
    partners = _confluence([(a.fired_at, a.ticker, a.option_type) for a in alerts])
    return Replay(
        alerts=tuple(
            replace(alert, confluence_tickers=tags)
            for alert, tags in zip(alerts, partners, strict=True)
        ),
        root_label_mismatch=mislabeled,
    )


def top_trade_flags(
    con: duckdb.DuckDBPyConnection, tape: str, day: date, rows: Sequence[LiveRow]
) -> dict[int, tuple[bool, bool] | None]:
    """The (sweep, floor) flags of each live row's top trade, found on the tape, by row id.

    A row's top trade is an ask print on its contract with the row's top-trade millisecond, size
    and premium. Matches that all agree give their flags. No match, matches that disagree, or a
    row with no top trade give None: the caller leaves that row's flags as they are. No detector
    rule is used, so this serves a live row of any day under any rule live ran.
    """
    flags: dict[int, tuple[bool, bool] | None] = {row.id: None for row in rows}
    # (id, chain, epoch ms, size, premium in cents) of each row that has a top trade.
    wanted: list[tuple[int, str, int, int, int]] = []
    for row in rows:
        at, size, premium = row.top_trade_executed_at, row.top_trade_size, row.top_trade_premium
        if at is None or size is None or premium is None:
            continue
        ms = (at - _EPOCH) // timedelta(milliseconds=1)
        wanted.append((row.id, row.option_chain, ms, size, int(premium.scaleb(2))))
    if not wanted:
        return flags
    ids, chains, ms_list, sizes, cents = (list(column) for column in zip(*wanted, strict=True))
    matches = con.execute(
        _FLAGS_SQL,
        {
            "tape": tape,
            "day": day,
            "ids": ids,
            "chains": chains,
            "ms": ms_list,
            "sizes": sizes,
            "cents": cents,
        },
    ).fetchall()
    for row_id, found, any_sweep, all_sweep, any_floor, all_floor in matches:
        if found and any_sweep == all_sweep and any_floor == all_floor:
            flags[row_id] = (any_sweep, any_floor)
    return flags


_INSERT_SQL = (
    "INSERT INTO interval_ba_alerts ("
    + ", ".join(ALERT_INSERT_COLUMNS)
    + ") VALUES %s ON CONFLICT (option_chain, bucket_start) DO NOTHING RETURNING id"
)


def _insert_row(alert: TapeAlert) -> tuple[object, ...]:
    """The alert's values in ALERT_INSERT_COLUMNS order.

    confluence_tickers goes in as a list: psycopg2 adapts a list to an ARRAY and a tuple to a
    row constructor, which a TEXT[] column rejects.
    """
    values = {f.name: getattr(alert, f.name) for f in fields(TapeAlert)}
    values["confluence_tickers"] = list(alert.confluence_tickers)
    return (*values.values(), "replay")


def insert_alerts(cur: psycopg2.extensions.cursor, alerts: Sequence[TapeAlert]) -> int:
    """Insert tape alerts as source 'replay', 500 rows a statement, and return how many landed.

    A key that already has a row (live or replay) is skipped by ON CONFLICT and not counted.
    The caller owns the transaction. A database error propagates.
    """
    inserted = psycopg2.extras.execute_values(
        cur,
        _INSERT_SQL,
        [_insert_row(alert) for alert in alerts],
        page_size=_PAGE_ROWS,
        fetch=True,
    )
    return len(inserted)
