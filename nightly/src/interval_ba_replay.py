"""Replay of today's live Interval B/A detector over one day of the UW Full Tape.

One implementation of the rule uw-stream runs live (uw-stream/src/handlers/interval_ba.py),
for two callers: the nightly `interval-ba-tape` step, on the day it downloaded, and the one-off
tool scripts/interval_ba_tape.py, over R2 with httpfs. Spec:
docs/superpowers/specs/2026-11-24-interval-ba-rebuild-design.md, sections 6.3 and 6.4. The
validated reference query it follows matched live on 1,053 of 1,053 rows over six sessions.

`heal_day` is one live day's pass (6.4): it corrects the sweep and floor flags and a blank SPXW
spot on the live rows from the tape, and from 2026-10-29 adds the alerts live missed, when the
live settings that cover the day ran this rule.

What it never does:
- open R2 or Neon. The caller hands in a DuckDB connection, a tape location (a local path or an
  s3:// URL) and a psycopg2 cursor or connection. `insert_alerts` leaves the commit to its
  caller; `heal_day` owns one transaction on the connection it is given;
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
import contextlib
import hashlib
import json
from collections.abc import Callable, Sequence
from dataclasses import dataclass, fields, replace
from datetime import UTC, date, datetime, time, timedelta
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Context, Decimal
from typing import Any
from zoneinfo import ZoneInfo

import duckdb
import psycopg2
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
    """An `interval_ba_alerts` row as the tape pass reads it, of either source."""

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
    source: str  # 'live' or 'replay'

    @property
    def key(self) -> tuple[str, datetime]:
        """The table's unique key. An aware datetime hashes by its instant, so a row read in any
        session time zone meets the tape alert at the same key."""
        return (self.option_chain, self.bucket_start)


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
-- One row even on a day with no fires, so the kept and mismatch counts always come back.
SELECT
    m.kept, m.mislabeled, f.chain, f.root, f.bucket, f.us, f.seq, f.ask, f.tot,
    coalesce(f.spot, filled.spot) AS spot,
    top.prem_c, top.size, top.us, top.is_sweep, top.is_floor
FROM (
    SELECT count(*) AS kept, count(*) FILTER (WHERE mislabeled) AS mislabeled FROM ticks
) m
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

    Raises what DuckDB raises for a tape it cannot read or that lacks a column, and ValueError
    when the tape holds no kept row for `day`. Every session has millions of 0DTE prints on the
    three, and a quiet day still has kept rows with no fire, so zero kept rows means the wrong
    day or a broken tape. Returning an empty Replay then would read as a day with no alerts, and
    a caller that replaces a day's replay rows would delete them.
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
    kept, mislabeled = int(rows[0][0]), int(rows[0][1])
    if kept == 0:
        raise ValueError(f"{tape}: no 0DTE SPXW/SPY/QQQ rows for {day}: wrong day or broken tape")
    alerts: list[TapeAlert] = []
    for (
        _,
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


# --- One live day's pass (spec 6.4) -------------------------------------------------------------


@dataclass(frozen=True)
class LiveSettings:
    """An `interval_ba_live_settings` row: what one uw-stream process ran with (spec 6.1b).

    `tickers` are the ones that process had a detector for. `enabled` is its master switch, so
    a row with it off had no ticker on, whatever `tickers` lists.
    """

    booted_at: datetime | None  # None only in default_settings()
    enabled: bool
    tickers: tuple[str, ...]
    ratio_threshold: Decimal
    premium_floor: Decimal
    window_sec: int
    multi_leg_share_max: Decimal
    multi_leg_codes: frozenset[str]
    confluence_window_sec: int


def default_settings() -> LiveSettings:
    """This module's rule with the detector on for all three tickers, and no boot time: for a
    day before the first settings row (the tool's --assume-default-settings)."""
    return LiveSettings(
        booted_at=None,
        enabled=True,
        tickers=tuple(sorted(TICKERS)),
        ratio_threshold=RATIO_THRESHOLD,
        premium_floor=Decimal(PREMIUM_FLOOR_DOLLARS),
        window_sec=WINDOW_SEC,
        multi_leg_share_max=MULTI_LEG_SHARE_MAX,
        multi_leg_codes=MULTI_LEG_CODES,
        confluence_window_sec=CONFLUENCE_WINDOW_SEC,
    )


def _runs_tape_rule(settings: LiveSettings) -> bool:
    """Whether a live process ran this module's rule. Decimals compare by value, so the scale a
    NUMERIC column returns (0.7500, 250000.00) does not matter."""
    return (
        settings.ratio_threshold == RATIO_THRESHOLD
        and settings.premium_floor == PREMIUM_FLOOR_DOLLARS
        and settings.window_sec == WINDOW_SEC
        and settings.multi_leg_share_max == MULTI_LEG_SHARE_MAX
        and settings.multi_leg_codes == MULTI_LEG_CODES
        and settings.confluence_window_sec == CONFLUENCE_WINDOW_SEC
    )


_SETTINGS_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(LiveSettings))
# The latest row that booted before the day's 00:00 CT, which covers the day's start, and every
# row that booted before the session's end. With no earlier row the lower bound is the day's
# start.
_COVERING_SETTINGS_SQL = (
    f"SELECT {', '.join(_SETTINGS_COLUMNS)} FROM interval_ba_live_settings"
    " WHERE booted_at >= coalesce("
    "(SELECT max(booted_at) FROM interval_ba_live_settings WHERE booted_at < %(start)s),"
    " %(start)s)"
    " AND booted_at < %(session_end)s"
    " ORDER BY booted_at"
)


def read_covering_settings(conn: psycopg2.extensions.connection, day: date) -> list[LiveSettings]:
    """The settings rows that cover `day`'s session, oldest first: the latest that booted before
    the day's 00:00 CT, and every one that booted before 16:00 CT that day.

    SPXW 0DTE prints end at 15:59 CT, so a settings change deployed after the close belongs to
    the next session and never rewrites this one's rule. The bounds come from zoneinfo, so they
    hold across DST. It returns [] only for a day before the first row ever written.
    """
    ct = ZoneInfo("America/Chicago")
    bounds = {
        "start": datetime.combine(day, time(), tzinfo=ct),
        "session_end": datetime.combine(day, time(16), tzinfo=ct),
    }
    with conn.cursor() as cur:
        cur.execute(_COVERING_SETTINGS_SQL, bounds)
        rows = cur.fetchall()
    return [
        LiveSettings(
            booted_at=booted_at,
            enabled=enabled,
            tickers=tuple(tickers),
            ratio_threshold=ratio,
            premium_floor=floor,
            window_sec=window,
            multi_leg_share_max=share,
            multi_leg_codes=frozenset(codes),
            confluence_window_sec=confluence,
        )
        for booted_at, enabled, tickers, ratio, floor, window, share, codes, confluence in rows
    ]


_LIVE_ROW_COLUMNS: tuple[str, ...] = tuple(f.name for f in fields(LiveRow))
_LIVE_ROWS_SQL = (
    f"SELECT {', '.join(_LIVE_ROW_COLUMNS)} FROM interval_ba_alerts WHERE expiry = %(day)s"
    " ORDER BY id"
)


def read_live_rows(conn: psycopg2.extensions.connection, day: date) -> list[LiveRow]:
    """Every `interval_ba_alerts` row on `day`, live and replay, by id. The rows are 0DTE, so a
    row's expiry is its session."""
    with conn.cursor() as cur:
        cur.execute(_LIVE_ROWS_SQL, {"day": day})
        return [LiveRow(*row) for row in cur.fetchall()]


# The spot at each SPXW live row's crossing tick (spec 6.3), with no detector rule: tick number
# trade_count of the row's bucket, in tape order with canceled ticks counted, which is where live
# fired whenever it saw every tick. With no spot on that tick, the first kept SPXW print with one
# after it (the opening seconds); when the bucket has fewer ticks, the last kept SPXW print with a
# spot at or before the row's fired_at.
_LIVE_SPOT_SQL = f"""
WITH wanted AS (
    SELECT unnest($ids) AS id, unnest($chains) AS chain, unnest($buckets) AS bucket,
        unnest($counts) AS seq, unnest($fired_us) AS fired_us
),
ticks AS MATERIALIZED (
    SELECT *,
        row_number() OVER (PARTITION BY chain, bucket ORDER BY us, frn) AS seq,
        first_value(spot IGNORE NULLS) OVER (
            ORDER BY us, frn ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
        ) AS next_spot
    FROM (
        SELECT
            option_chain_id AS chain,
            epoch_us(executed_at) AS us,
            file_row_number AS frn,
            epoch_us(executed_at) // $window_us * $window_sec AS bucket,
            CAST(underlying_price AS DOUBLE) AS spot
        FROM read_parquet($tape, file_row_number = true)
        WHERE {_KEPT} AND {_ROOT} = 'SPXW'
    )
),
-- Each row's fired_at joins the print stream after every print of its microsecond (kind 1).
as_of AS (
    SELECT id,
        last_value(spot IGNORE NULLS) OVER (
            ORDER BY us, kind, frn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS spot
    FROM (
        SELECT CAST(NULL AS BIGINT) AS id, us, 0 AS kind, frn, spot FROM ticks
        UNION ALL
        SELECT id, fired_us, 1, NULL, NULL FROM wanted
    )
    QUALIFY id IS NOT NULL
)
SELECT w.id, CASE WHEN t.seq IS NULL THEN as_of.spot ELSE coalesce(t.spot, t.next_spot) END
FROM wanted w
LEFT JOIN ticks t ON t.chain = w.chain AND t.bucket = w.bucket AND t.seq = w.seq
LEFT JOIN as_of ON as_of.id = w.id
"""


def live_spot(
    con: duckdb.DuckDBPyConnection, tape: str, day: date, rows: Sequence[LiveRow]
) -> dict[int, Decimal | None]:
    """The tape spot at each SPXW live row's crossing tick, by row id; None where the tape has
    none to give. Rows of other tickers are left out: live writes their spot.

    No detector rule is used, so it serves a live day of any rule. With no SPXW row the tape is
    not read.
    """
    spxw = [row for row in rows if row.ticker == "SPXW"]
    if not spxw:
        return {}
    found = con.execute(
        _LIVE_SPOT_SQL,
        {
            "tape": tape,
            "day": day,
            "window_us": WINDOW_SEC * 1_000_000,
            "window_sec": WINDOW_SEC,
            "ids": [row.id for row in spxw],
            "chains": [row.option_chain for row in spxw],
            "buckets": [(row.bucket_start - _EPOCH) // timedelta(seconds=1) for row in spxw],
            "counts": [row.trade_count for row in spxw],
            "fired_us": [(row.fired_at - _EPOCH) // timedelta(microseconds=1) for row in spxw],
        },
    ).fetchall()
    return {row_id: _spot(spot) for row_id, spot in found}


@dataclass(frozen=True)
class DayPlan:
    """One live day's pass (spec 6.4): what it found, and the exact write set.

    The comparison counts (tape_alerts, live_rows, live_missed, live_only, value_mismatched,
    matched) and the inserts cover the on tickers: those on in every covering settings row (none
    when a covering row has the detector off), or all three when insert_missed is False or no
    row covers the day. The removals, flags and spots cover every row of the day. The write
    counts (inserted, removed, flags_changed, spot_filled) are the rows planned in a dry run and
    the rows the database reports on apply. sha256 is over the day and the four write lists, in
    canonical order, so a stored plan can be checked against a fresh one.
    """

    day: date
    root_label_mismatch: int
    tape_alerts: int
    live_rows: int
    live_missed: int
    live_only: int
    value_mismatched: int
    inserted: int
    inserts_held: str | None
    removed: int
    flags_changed: int
    flags_unmatched: int
    spot_filled: int
    matched: int
    inserts: tuple[TapeAlert, ...]
    removes: tuple[int, ...]
    flag_updates: tuple[tuple[int, bool, bool], ...]
    spot_updates: tuple[tuple[int, Decimal], ...]
    sha256: str

    def to_json(self) -> dict[str, Any]:
        """The plan as JSON values: the day and times in ISO form, Decimals as strings."""
        return {
            "day": self.day.isoformat(),
            **{name: getattr(self, name) for name in _PLAN_COUNTS},
            **_write_set_json(self.inserts, self.removes, self.flag_updates, self.spot_updates),
            "sha256": self.sha256,
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> DayPlan:
        """The plan `to_json` gave. Raises ValueError when its write lists do not hash to its
        sha256: an edited or damaged plan file is refused."""
        inserts = tuple(_alert_from_json(alert) for alert in d["inserts"])
        removes = tuple(d["removes"])
        flag_updates = tuple((row_id, sweep, floor) for row_id, sweep, floor in d["flag_updates"])
        spot_updates = tuple((row_id, Decimal(price)) for row_id, price in d["spot_updates"])
        day = date.fromisoformat(d["day"])
        sha256 = _write_set_sha(day, inserts, removes, flag_updates, spot_updates)
        if sha256 != d["sha256"]:
            raise ValueError(f"DayPlan {d['day']}: the day and write lists do not match its sha256")
        return cls(
            day=day,
            **{name: d[name] for name in _PLAN_COUNTS},
            inserts=inserts,
            removes=removes,
            flag_updates=flag_updates,
            spot_updates=spot_updates,
            sha256=sha256,
        )


# A DayPlan's count fields: all but the day, the four write lists and the sha.
_PLAN_COUNTS: tuple[str, ...] = tuple(
    f.name
    for f in fields(DayPlan)
    if f.name not in {"day", "inserts", "removes", "flag_updates", "spot_updates", "sha256"}
)


def _alert_json(alert: TapeAlert) -> dict[str, Any]:
    """A TapeAlert as JSON values: Decimals as strings (exact, scale kept), times as UTC ISO."""
    out: dict[str, Any] = {}
    for f in fields(TapeAlert):
        value = getattr(alert, f.name)
        if isinstance(value, Decimal):
            value = str(value)
        elif isinstance(value, datetime):
            value = value.astimezone(UTC).isoformat()
        elif isinstance(value, date):
            value = value.isoformat()
        elif isinstance(value, tuple):
            value = list(value)
        out[f.name] = value
    return out


# How a TapeAlert field comes back from JSON, by its annotation, which is a string under
# `from __future__ import annotations`. A field of a new type fails the round trip with KeyError.
_FROM_JSON: dict[str, Callable[[Any], Any]] = {
    "str": str,
    "int": int,
    "bool": bool,
    "Decimal": Decimal,
    "Decimal | None": lambda value: None if value is None else Decimal(value),
    "date": date.fromisoformat,
    "datetime": datetime.fromisoformat,
    "tuple[str, ...]": tuple,
}


def _alert_from_json(d: dict[str, Any]) -> TapeAlert:
    return TapeAlert(**{f.name: _FROM_JSON[str(f.type)](d[f.name]) for f in fields(TapeAlert)})


def _write_set_json(
    inserts: Sequence[TapeAlert],
    removes: Sequence[int],
    flag_updates: Sequence[tuple[int, bool, bool]],
    spot_updates: Sequence[tuple[int, Decimal]],
) -> dict[str, list[Any]]:
    return {
        "inserts": [_alert_json(alert) for alert in inserts],
        "removes": list(removes),
        "flag_updates": [list(update) for update in flag_updates],
        "spot_updates": [[row_id, str(price)] for row_id, price in spot_updates],
    }


def _write_set_sha(
    day: date,
    inserts: Sequence[TapeAlert],
    removes: Sequence[int],
    flag_updates: Sequence[tuple[int, bool, bool]],
    spot_updates: Sequence[tuple[int, Decimal]],
) -> str:
    """sha256 of the day and its four write lists, as canonical JSON (keys sorted, no spaces).
    The inserts are hashed in key order, so the sha does not depend on replay_day's sort; the
    other three lists are built sorted by row id."""
    payload = {
        "day": day.isoformat(),
        **_write_set_json(
            sorted(inserts, key=lambda alert: alert.key), removes, flag_updates, spot_updates
        ),
    }
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _on_tickers(settings: Sequence[LiveSettings]) -> frozenset[str]:
    """The tickers on in every covering row. A row with the detector off has none on, so a day
    with one counts nothing (its inserts are held as well). All three when no row covers the
    day, which holds the inserts too."""
    on = frozenset(TICKERS)
    for row in settings:
        on &= frozenset(row.tickers) if row.enabled else frozenset()
    return on


def _hold_reason(settings: Sequence[LiveSettings]) -> str | None:
    """Why the day's inserts are held (spec 6.4 step 2), the first that applies, or None. The
    detector off in any covering row holds them: live fired nothing while it was off."""
    if not settings:
        return "no live settings record"
    if not all(_runs_tape_rule(row) for row in settings):
        return "live settings differ from the tape rule"
    if not all(row.enabled for row in settings):
        return "live detector off"
    return None


# Step 1's diagnostic: a matched key whose live row differs from the tape in any of these.
_COMPARED_COLUMNS = (
    "ratio_pct",
    "ask_premium",
    "total_premium",
    "trade_count",
    "top_trade_premium",
    "top_trade_size",
)

# Step 4. Only a replay row is ever deleted.
_REMOVE_SQL = (
    "DELETE FROM interval_ba_alerts AS a USING (VALUES %s) AS v(id)"
    " WHERE a.id = v.id AND a.source = 'replay'"
    " RETURNING a.id"
)
# Step 5. The two flags on a live row, only where they change.
_FLAGS_UPDATE_SQL = (
    "UPDATE interval_ba_alerts AS a"
    " SET top_trade_is_sweep = v.sweep, top_trade_is_floor = v.floor"
    " FROM (VALUES %s) AS v(id, sweep, floor)"
    " WHERE a.id = v.id AND a.source = 'live'"
    " AND (a.top_trade_is_sweep, a.top_trade_is_floor) IS DISTINCT FROM (v.sweep, v.floor)"
    " RETURNING a.id"
)
# Step 6. A blank SPXW spot on a live row; a spot already there is never replaced.
_SPOT_UPDATE_SQL = (
    "UPDATE interval_ba_alerts AS a"
    " SET underlying_price = v.price"
    " FROM (VALUES %s) AS v(id, price)"
    " WHERE a.id = v.id AND a.source = 'live' AND a.ticker = 'SPXW'"
    " AND a.underlying_price IS NULL"
    " RETURNING a.id"
)
# Step 7. The day's done marker and health record; a redone day replaces its counts.
_TAPE_DAY_COLUMNS: tuple[str, ...] = (
    "day",
    "tape_alerts",
    "live_rows",
    "live_missed",
    "live_only",
    "value_mismatched",
    "inserted",
    "inserts_held",
    "removed",
    "flags_changed",
    "flags_unmatched",
    "spot_filled",
)
_MARK_DAY_SQL = (
    f"INSERT INTO interval_ba_tape_days ({', '.join(_TAPE_DAY_COLUMNS)}) VALUES ("
    + ", ".join(f"%({column})s" for column in _TAPE_DAY_COLUMNS)
    + ") ON CONFLICT (day) DO UPDATE SET done_at = now(), "
    + ", ".join(f"{column} = EXCLUDED.{column}" for column in _TAPE_DAY_COLUMNS[1:])
)


def _plan_day(
    conn: psycopg2.extensions.connection,
    con: duckdb.DuckDBPyConnection,
    tape: str,
    day: date,
    settings: Sequence[LiveSettings],
    *,
    insert_missed: bool,
) -> DayPlan:
    """Steps 1 to 6 as a plan: the counts and what each write would send."""
    replay = replay_day(con, tape, day)
    rows = read_live_rows(conn, day)
    live = [row for row in rows if row.source == "live"]
    if insert_missed:
        on, held = _on_tickers(settings), _hold_reason(settings)
    else:
        on, held = frozenset(TICKERS), None

    # Step 1: compare on the key, over the on tickers.
    tape_on = {alert.key: alert for alert in replay.alerts if alert.ticker in on}
    live_on = {row.key: row for row in live if row.ticker in on}
    matched = tape_on.keys() & live_on.keys()
    mismatched = sum(
        1
        for key in matched
        if any(getattr(tape_on[key], c) != getattr(live_on[key], c) for c in _COMPARED_COLUMNS)
    )

    # Step 3: the on tickers' tape alerts at keys with no row of either source.
    taken = {row.key for row in rows}
    inserts: tuple[TapeAlert, ...] = ()
    if insert_missed and held is None:
        inserts = tuple(alert for alert in tape_on.values() if alert.key not in taken)

    # Step 4: replay rows the replay no longer fires. An empty replay with rows present means
    # the tape read broke, not that the alerts went away, so it removes nothing.
    fired = {alert.key for alert in replay.alerts}
    removes: tuple[int, ...] = ()
    if fired:
        removes = tuple(
            sorted(row.id for row in rows if row.source == "replay" and row.key not in fired)
        )

    # Step 5: the flags of every live row whose top trade the tape names, where they change.
    flags = top_trade_flags(con, tape, day, live)
    changed: list[tuple[int, bool, bool]] = []
    for row in live:
        found = flags[row.id]
        if found is not None and found != (row.top_trade_is_sweep, row.top_trade_is_floor):
            changed.append((row.id, found[0], found[1]))
    flag_updates = tuple(sorted(changed))

    # Step 6: a blank SPXW spot.
    spots = live_spot(con, tape, day, [row for row in live if row.underlying_price is None])
    spot_updates = tuple(
        sorted((row_id, spot) for row_id, spot in spots.items() if spot is not None)
    )

    return DayPlan(
        day=day,
        root_label_mismatch=replay.root_label_mismatch,
        tape_alerts=len(tape_on),
        live_rows=len(live_on),
        live_missed=len(tape_on.keys() - live_on.keys()),
        live_only=len(live_on.keys() - tape_on.keys()),
        value_mismatched=mismatched,
        inserted=len(inserts),
        inserts_held=held,
        removed=len(removes),
        flags_changed=len(flag_updates),
        flags_unmatched=sum(1 for row in live if flags[row.id] is None),
        spot_filled=len(spot_updates),
        matched=len(matched),
        inserts=inserts,
        removes=removes,
        flag_updates=flag_updates,
        spot_updates=spot_updates,
        sha256=_write_set_sha(day, inserts, removes, flag_updates, spot_updates),
    )


def _write_ids(
    cur: psycopg2.extensions.cursor,
    sql: str,
    template: str,
    rows: Sequence[tuple[object, ...]],
) -> int:
    """Run a batched write whose RETURNING gives one id per row it touched; return the count."""
    touched = psycopg2.extras.execute_values(
        cur, sql, rows, template=template, page_size=_PAGE_ROWS, fetch=True
    )
    return len(touched)


def _write_day(conn: psycopg2.extensions.connection, plan: DayPlan) -> DayPlan:
    """Steps 3 to 7 in the open transaction. The write counts become what the database reports:
    a row another writer changed first is not counted."""
    with conn.cursor() as cur:
        inserted = insert_alerts(cur, plan.inserts)
        removed = _write_ids(
            cur, _REMOVE_SQL, "(%s::bigint)", [(row_id,) for row_id in plan.removes]
        )
        flags_changed = _write_ids(
            cur, _FLAGS_UPDATE_SQL, "(%s::bigint, %s::boolean, %s::boolean)", plan.flag_updates
        )
        spot_filled = _write_ids(
            cur, _SPOT_UPDATE_SQL, "(%s::bigint, %s::numeric)", plan.spot_updates
        )
        done = replace(
            plan,
            inserted=inserted,
            removed=removed,
            flags_changed=flags_changed,
            spot_filled=spot_filled,
        )
        cur.execute(_MARK_DAY_SQL, {column: getattr(done, column) for column in _TAPE_DAY_COLUMNS})
    return done


class PlanChanged(ValueError):  # noqa: N818 - name fixed by the task interface
    """heal_day's fresh plan for a day is not the one the caller expected: the day's rows, the
    tape or the code moved since that plan was made. Nothing was written."""


def heal_day(
    conn: psycopg2.extensions.connection,
    con: duckdb.DuckDBPyConnection,
    tape: str,
    day: date,
    settings: Sequence[LiveSettings],
    *,
    insert_missed: bool,
    apply: bool,
    expect_sha256: str | None = None,
) -> DayPlan:
    """One live day's pass over its rows (spec 6.4), in one transaction.

    1. Replay the day, read its rows, and compare the two on the key over the on tickers.
    2. With insert_missed, hold the inserts when no settings row covers the day, a covering row
       ran another rule, or any covering row had the detector off.
    3. With insert_missed and nothing held, insert the on tickers' tape alerts at keys with no
       row of either source, as source 'replay'.
    4. Delete the replay rows whose key the replay no longer fires (a re-landed tape), unless
       the replay fired nothing.
    5. Correct the sweep and floor flags on live rows from their top trade on the tape.
    6. Fill a blank SPXW spot on live rows (live_spot).
    7. Upsert the day's interval_ba_tape_days row.

    `settings` are what read_covering_settings gives for the day; with insert_missed False they
    are not consulted and all three tickers count. A live row is never deleted, and the only
    columns written on one are the two flags and a NULL SPXW underlying_price.

    With apply False nothing is written. With apply True steps 3 to 7 commit together, and any
    error rolls the whole day back, marker included, and propagates, so the day is retried.
    With expect_sha256, a fresh plan whose sha256 differs raises PlanChanged before any write,
    on a dry run as well, so a plan the owner approved is applied exactly or not at all.

    `conn` must be idle when called: autocommit on, or committed or rolled back after any read
    (read_covering_settings included). psycopg2 refuses to switch autocommit inside a
    transaction. Autocommit is off for the call and restored after.

    Raises ValueError for a day before LIVE_START, for insert_missed before INSERT_MISSED_FROM
    (live ran another rule then), and, from replay_day, for a tape with no row for the day: a
    failed day, never a day with no alerts.
    """
    if day < LIVE_START:
        raise ValueError(f"{day} is before the first live day {LIVE_START}: no live rows to heal")
    if insert_missed and day < INSERT_MISSED_FROM:
        raise ValueError(
            f"insert_missed on {day}: {day} is before {INSERT_MISSED_FROM}, the first session"
            " live ran this rule"
        )
    previous = conn.autocommit
    conn.autocommit = False
    try:
        plan = _plan_day(conn, con, tape, day, settings, insert_missed=insert_missed)
        if expect_sha256 is not None and plan.sha256 != expect_sha256:
            raise PlanChanged(
                f"{day}: the fresh plan's sha256 {plan.sha256} is not the expected {expect_sha256}"
            )
        if apply:
            plan = _write_day(conn, plan)
            conn.commit()
        else:
            conn.rollback()  # ends the transaction the reads opened
        return plan
    except BaseException:
        # A rollback that fails as well (a dead connection) must not hide the error that got
        # here; the server drops the transaction with the connection.
        with contextlib.suppress(psycopg2.Error):
            conn.rollback()
        raise
    finally:
        # Nor may restoring autocommit, which psycopg2 refuses on a closed connection and inside
        # the transaction a failed rollback left open.
        with contextlib.suppress(psycopg2.Error):
            conn.autocommit = previous
