"""DuckDB-backed queries over the seeded Databento archive.

The archive sits on the Railway persistent volume at `ARCHIVE_ROOT`
(default `/data/archive/`), populated by `archive_seeder`. DuckDB reads
Parquet directly — no server, no load step, no sidecar memory overhead
beyond the ~12 MB DuckDB library itself.

Design notes:

- **One module-level connection.** DuckDB is in-process and thread-safe;
  a single shared handle avoids re-planning queries and re-reading
  Parquet footer metadata on every call.
- **Year-partitioned globs.** `read_parquet('year=*/part.parquet')`
  lets DuckDB prune whole files when a query filters by year — e.g.
  a 2024 summary touches exactly one of the 17 year files.
- **Parameters over string interpolation.** Query plans cache by
  text, and SQL injection at this trust boundary would be embarrassing
  even on a single-owner tool. Paths and filters go through `execute(q, params)`.
- **Front-month selection.** On any ES trading day the front-month
  contract dominates volume. We pick "top symbol by volume on that day"
  rather than hardcoding a roll calendar — robust to early/late rolls
  and makes no assumption about the continuous series in the archive.
"""

from __future__ import annotations

import contextlib
import os
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import duckdb

from front_month import front_month_cte
from logger_setup import log

_ROOT = Path(os.environ.get("ARCHIVE_ROOT", "/data/archive"))


# ---------------------------------------------------------------------------
# Concurrency bound for archive query execution (SIDE / AUD-M25)
# ---------------------------------------------------------------------------
#
# The /archive/* routes are unauthenticated and run on an unbounded
# `ThreadingHTTPServer` (one thread per request — see health.py). Each
# DuckDB connection is capped at `memory_limit='500MB'` PLUS up to ~2 GB
# of on-disk temp spill, and those caps are PER thread-local connection.
# So N concurrent /archive/* requests cost N × (500 MB RAM + ~2 GB temp)
# on a 3-vCPU Railway box with a documented OOM history — a trivial
# unauthenticated memory-exhaustion DoS.
#
# This semaphore bounds how many archive queries may execute DuckDB work
# at once. Callers that find the cap saturated must NOT block-and-spawn
# another heavy connection; they acquire the slot non-blocking via
# `archive_query_slot()` and, on failure, surface `ArchiveBusyError` so
# the HTTP layer can return 503 instead of piling on more memory pressure.
#
# 2 is deliberate: it leaves headroom for /health, SHAP and Theta
# while still allowing one backfill request to overlap a single
# interactive analyze-context query. Override via env for ops tuning.
_ARCHIVE_QUERY_CONCURRENCY = int(
    os.environ.get("ARCHIVE_QUERY_CONCURRENCY", "2")
)
_archive_query_semaphore = threading.BoundedSemaphore(_ARCHIVE_QUERY_CONCURRENCY)


class ArchiveBusyError(Exception):
    """Raised when the archive-query concurrency cap is saturated.

    The HTTP layer maps this to 503 (Service Unavailable) rather than
    spawning another heavy DuckDB connection. Distinct from ValueError
    (no-data / bad-input, → 404/400) so the dispatch can branch cleanly.
    """


@contextlib.contextmanager
def archive_query_slot() -> Iterator[None]:
    """Bound concurrent archive DuckDB execution to `_ARCHIVE_QUERY_CONCURRENCY`.

    Non-blocking acquire: if all slots are taken, raise `ArchiveBusyError`
    immediately instead of queueing (which would let an attacker pin
    unbounded request threads waiting behind heavy queries). The slot is
    released on exit even if the wrapped query raises.
    """
    if not _archive_query_semaphore.acquire(blocking=False):
        raise ArchiveBusyError("archive query concurrency limit reached")
    try:
        yield
    finally:
        _archive_query_semaphore.release()


def _ohlcv_glob(root: Path | None = None) -> str:
    """Parquet glob across year partitions. Override `root` for tests."""
    base = root or _ROOT
    return str(base / "ohlcv_1m" / "year=*" / "part.parquet")


def _symbology_path(root: Path | None = None) -> str:
    base = root or _ROOT
    return str(base / "symbology.parquet")


# Thread-local DuckDB connections.
#
# Why thread-local and not a module-level singleton: DuckDB's "thread-
# safe" only guarantees that concurrent access won't crash — it still
# serializes queries on a single connection. Under ThreadingHTTPServer
# (see health.py) every request lands on a fresh thread, so a shared
# connection would serialize all /archive/* queries back into a single
# lane. Giving each handler thread its own connection lets DuckDB run
# queries truly in parallel. Each connection is ~1 MB of Python state
# plus DuckDB's internal buffer; threads are short-lived, so the
# footprint stays bounded by the HTTP server's own threading policy.
_tls = threading.local()


def _connection() -> duckdb.DuckDBPyConnection:
    conn: duckdb.DuckDBPyConnection | None = getattr(_tls, "conn", None)
    if conn is None:
        conn = duckdb.connect()
        # Force session TimeZone to UTC on every new connection. DuckDB's
        # `date_trunc('day', <TIMESTAMPTZ>)` honors the SESSION TimeZone,
        # which DuckDB initializes from the host's TZ env var. A Railway
        # container without `TZ=UTC` set inherits whatever the base image
        # defaults to — currently UTC on `python:3.12-slim`, but that is
        # implementation-defined, not contractual. On a Chicago-locale
        # laptop a trade at 2025-10-16 00:30 UTC would bucket into the
        # 2025-10-15 CT date, silently shifting a whole calendar day of
        # activity into the wrong per-day aggregate. The Phase 4c ML
        # pipeline (`ml/src/features/microstructure.py::_new_connection`)
        # was patched with the exact same hook; this is the sidecar
        # counterpart. The single-date queries (`es_day_summary`,
        # `analog_days`, `day_summary_text`, `day_features_vector`,
        # `day_summary_prediction`) bucket with `date_trunc('day',
        # ts_event)` and depend on it. The `*_batch` variants bucket by
        # CME session date via `front_month.session_date_expr`, which is
        # session-TZ independent.
        #
        # Validating the TZ name requires the `pytz` package in DuckDB's
        # native path, which is why it is an explicit sidecar dep —
        # see `sidecar/requirements.txt`. There is a TZ-boundary
        # regression test at `tests/test_archive_query.py` that runs
        # under `TZ=America/Chicago` and would fail loudly if this SET
        # is ever removed.
        conn.execute("SET TimeZone = 'UTC'")
        # SIDE-017: cap DuckDB memory and spill to disk rather than
        # OOM-killing the container. Without this, a cold-cache scan of the
        # OHLCV archive can allocate unbounded RAM until Railway kills the
        # process (the cap was sized for the since-removed 3.9 GB TBBO OFI
        # queries). With memory_limit set, DuckDB writes intermediate results to
        # temp_directory when it would otherwise exceed the limit.
        # 500 MB leaves headroom for Python + the SHAP model bundles +
        # the cached _option_definitions dict within typical Railway
        # tier memory. Latency may rise modestly on spill but
        # correctness and process stability take priority.
        conn.execute("SET memory_limit = '500MB'")
        conn.execute("SET temp_directory = '/tmp/duckdb'")
        # SIDE-Phase6: cap the on-disk spill too. memory_limit forces DuckDB
        # to spill to temp_directory, but the temp directory itself defaults
        # to unlimited — a cold scan can then fill the container's
        # overlay filesystem and crash the process just as surely as an OOM.
        # 2 GB is comfortably larger than any single intermediate the current
        # queries produce yet well under the Railway volume / overlay budget.
        conn.execute("SET max_temp_directory_size = '2GB'")
        # SIDE: the since-removed long-horizon TBBO OFI query (horizon_days=252
        # over a 1h rolling window) built large minute-grain window-function
        # intermediates that spilled to temp. On the Railway
        # container the effective temp ceiling is ~1.8 GiB (actual free disk,
        # below the 2GB setting above), and the spill blew past it
        # ("failed to offload data block ... 1.8 GiB/1.8 GiB used"). DuckDB's
        # own remedy for that error is to drop insertion-order preservation,
        # which lets the engine pipeline + aggregate without buffering rows to
        # preserve input order — a large temp-footprint reduction. Kept after
        # the TBBO removal because it still shrinks spill for the remaining
        # queries and is safe: every analytical query in this module ends with
        # an explicit ORDER BY, so output ordering does not depend on
        # insertion order.
        conn.execute("SET preserve_insertion_order = false")
        _tls.conn = conn
        log.debug(
            "DuckDB connection initialized for thread %s",
            threading.current_thread().name,
        )
    return conn


def reset_connection_for_tests() -> None:
    """Drop the current thread's connection. Test-only hook.

    Tests are single-threaded (pytest default), so clearing the calling
    thread's connection is enough to reset state between runs.
    """
    conn: duckdb.DuckDBPyConnection | None = getattr(_tls, "conn", None)
    if conn is not None:
        conn.close()
        del _tls.conn


# ---------------------------------------------------------------------------
# Public queries
# ---------------------------------------------------------------------------


def es_day_summary(
    date_iso: str,
    *,
    root: Path | None = None,
) -> dict[str, Any]:
    """Return a day-level summary of ES futures activity.

    Picks the top ES contract by volume for `date_iso` (de facto front
    month) and returns its OHLC + volume + bar count. `date_iso` is a
    `YYYY-MM-DD` string in UTC.

    Raises ValueError if the date has no ES bars in the archive.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Step 1 — pick the top ES contract by volume on this date.
    # Symbology uses 'ESH5' etc. for futures; options carry 'ES <date> C<strike>'
    # (note the space), which we exclude by forbidding spaces in the symbol.
    top_row = conn.execute(
        """
        SELECT sym.symbol
        FROM read_parquet(?) AS bars
        JOIN read_parquet(?) AS sym USING (instrument_id)
        WHERE sym.symbol LIKE 'ES%'
          AND strpos(sym.symbol, ' ') = 0
          AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        GROUP BY sym.symbol
        ORDER BY SUM(bars.volume) DESC
        LIMIT 1
        """,
        [ohlcv, symbology, date_iso],
    ).fetchone()

    if top_row is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    top_symbol = top_row[0]

    # Step 2 — aggregate OHLC for just that contract on that day.
    summary = conn.execute(
        """
        WITH filtered AS (
            SELECT bars.ts_event, bars.open, bars.high, bars.low,
                   bars.close, bars.volume
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        )
        SELECT FIRST(open ORDER BY ts_event) AS day_open,
               MAX(high)                     AS day_high,
               MIN(low)                      AS day_low,
               LAST(close ORDER BY ts_event) AS day_close,
               SUM(volume)                   AS day_volume,
               COUNT(*)                      AS bar_count
        FROM filtered
        """,
        [ohlcv, symbology, top_symbol, date_iso],
    ).fetchone()

    assert summary is not None  # filtered is non-empty by construction
    day_open, day_high, day_low, day_close, day_volume, bar_count = summary

    return {
        "date": date_iso,
        "symbol": top_symbol,
        "open": float(day_open),
        "high": float(day_high),
        "low": float(day_low),
        "close": float(day_close),
        "volume": int(day_volume),
        "bar_count": int(bar_count),
    }


# ---------------------------------------------------------------------------
# analog_days
# ---------------------------------------------------------------------------


_ANALOG_MAX_K = 50
_ANALOG_MIN_WINDOW = 10
_ANALOG_MAX_WINDOW = 390  # one regular session


def _front_month_symbol(
    conn: duckdb.DuckDBPyConnection,
    ohlcv: str,
    symbology: str,
    date_iso: str,
) -> str | None:
    """Top-ES-by-volume on a date, or None if the date has no ES bars."""
    row = conn.execute(
        """
        SELECT sym.symbol
        FROM read_parquet(?) AS bars
        JOIN read_parquet(?) AS sym USING (instrument_id)
        WHERE sym.symbol LIKE 'ES%'
          AND strpos(sym.symbol, ' ') = 0
          AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        GROUP BY sym.symbol
        ORDER BY SUM(bars.volume) DESC
        LIMIT 1
        """,
        [ohlcv, symbology, date_iso],
    ).fetchone()
    return row[0] if row else None


def analog_days(
    date_iso: str,
    *,
    until_minute: int = 60,
    k: int = 20,
    root: Path | None = None,
) -> dict[str, Any]:
    """Find historical trading days whose early-session ES path best matches `date_iso`.

    Similarity is measured by absolute difference in the delta (close at
    `until_minute` minutes into the session minus the day's open) between
    each historical day and `date_iso`. `until_minute` bounded [10, 390].

    Returns {target, analogs:[{...}]} where each analog also carries the
    eventual day close and high/low so the caller can answer "what usually
    happens after a morning like this?".

    Raises ValueError if `date_iso` has no ES bars OR if `k`/`until_minute`
    are out of range.
    """
    if k < 1 or k > _ANALOG_MAX_K:
        raise ValueError(f"k must be in 1..{_ANALOG_MAX_K}, got {k}")
    if until_minute < _ANALOG_MIN_WINDOW or until_minute > _ANALOG_MAX_WINDOW:
        raise ValueError(
            f"until_minute must be in {_ANALOG_MIN_WINDOW}..{_ANALOG_MAX_WINDOW}"
        )

    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Single SQL computes target + all candidates + ordering in one pass.
    # `per_day` derives open and close-at-window for every ES front-month
    # contract-day in the archive; the outer query joins the target row
    # to compute |delta - target_delta| and sorts.
    #
    # "Session open" = the minute ts of the first bar of each contract-day
    # (not 08:30 CT) so Globex overnight activity is captured cleanly and
    # the function stays TZ-agnostic.
    rows = conn.execute(
        """
        WITH es_bars AS (
            SELECT bars.ts_event,
                   bars.open,
                   bars.high,
                   bars.low,
                   bars.close,
                   bars.volume,
                   sym.symbol,
                   CAST(date_trunc('day', bars.ts_event) AS DATE) AS day
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol LIKE 'ES%'
              AND strpos(sym.symbol, ' ') = 0
        ),
        day_front AS (
            SELECT day,
                   symbol,
                   SUM(volume) AS day_volume,
                   ROW_NUMBER() OVER (
                       PARTITION BY day ORDER BY SUM(volume) DESC
                   ) AS rank
            FROM es_bars
            GROUP BY day, symbol
        ),
        front_only AS (
            SELECT b.*
            FROM es_bars b
            JOIN day_front f
              ON b.day = f.day AND b.symbol = f.symbol AND f.rank = 1
        ),
        per_day AS (
            SELECT day,
                   symbol,
                   FIRST(ts_event ORDER BY ts_event) AS session_open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open,
                   MAX(high) AS day_high,
                   MIN(low) AS day_low,
                   LAST(close ORDER BY ts_event) AS day_close,
                   SUM(volume) AS day_volume
            FROM front_only
            GROUP BY day, symbol
        ),
        window_closes AS (
            SELECT f.day,
                   LAST(f.close ORDER BY f.ts_event) AS close_at_window
            FROM front_only f
            JOIN per_day p USING (day, symbol)
            WHERE f.ts_event
                  <= p.session_open_ts + CAST(? AS INTEGER) * INTERVAL 1 MINUTE
            GROUP BY f.day
        ),
        path AS (
            SELECT p.day,
                   p.symbol,
                   p.day_open,
                   p.day_high,
                   p.day_low,
                   p.day_close,
                   p.day_volume,
                   w.close_at_window,
                   w.close_at_window - p.day_open AS delta
            FROM per_day p
            JOIN window_closes w USING (day)
        ),
        target AS (
            SELECT delta AS target_delta
            FROM path
            WHERE day = ?::DATE
        )
        SELECT p.day, p.symbol, p.day_open, p.day_high, p.day_low,
               p.day_close, p.day_volume, p.close_at_window, p.delta,
               abs(p.delta - t.target_delta) AS distance
        FROM path p, target t
        WHERE p.day <> ?::DATE
        ORDER BY distance
        LIMIT ?
        """,
        [ohlcv, symbology, until_minute, date_iso, date_iso, k],
    ).fetchall()

    # target row — separate query to keep the main one focused on k-nearest
    # (LIMIT k would otherwise bump the target out of the top rows when it
    # fully matches itself, giving a confusing API shape).
    target_row = conn.execute(
        """
        WITH es_bars AS (
            SELECT bars.ts_event, bars.open, bars.high, bars.low,
                   bars.close, bars.volume, sym.symbol,
                   CAST(date_trunc('day', bars.ts_event) AS DATE) AS day
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol LIKE 'ES%'
              AND strpos(sym.symbol, ' ') = 0
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        ),
        top AS (
            SELECT symbol
            FROM es_bars
            GROUP BY symbol
            ORDER BY SUM(volume) DESC
            LIMIT 1
        ),
        f AS (
            SELECT b.*
            FROM es_bars b
            JOIN top USING (symbol)
        ),
        agg AS (
            SELECT FIRST(ts_event ORDER BY ts_event) AS session_open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open,
                   MAX(high) AS day_high,
                   MIN(low) AS day_low,
                   LAST(close ORDER BY ts_event) AS day_close,
                   SUM(volume) AS day_volume,
                   (SELECT symbol FROM top) AS symbol
            FROM f
        ),
        win AS (
            SELECT LAST(close ORDER BY ts_event) AS close_at_window
            FROM f
            WHERE ts_event
                  <= (SELECT session_open_ts FROM agg)
                     + CAST(? AS INTEGER) * INTERVAL 1 MINUTE
        )
        SELECT a.symbol, a.day_open, a.day_high, a.day_low, a.day_close,
               a.day_volume, w.close_at_window,
               w.close_at_window - a.day_open AS delta
        FROM agg a, win w
        """,
        [ohlcv, symbology, date_iso, until_minute],
    ).fetchone()

    if target_row is None or target_row[0] is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    tgt_symbol, tgt_open, tgt_high, tgt_low, tgt_close, tgt_vol, tgt_win, tgt_delta = (
        target_row
    )

    analogs = [
        {
            "date": r[0].isoformat(),
            "symbol": r[1],
            "open": float(r[2]),
            "high": float(r[3]),
            "low": float(r[4]),
            "close": float(r[5]),
            "volume": int(r[6]),
            "close_at_window": float(r[7]),
            "delta": float(r[8]),
            "distance": float(r[9]),
        }
        for r in rows
    ]

    return {
        "target": {
            "date": date_iso,
            "symbol": tgt_symbol,
            "open": float(tgt_open),
            "high": float(tgt_high),
            "low": float(tgt_low),
            "close": float(tgt_close),
            "volume": int(tgt_vol),
            "close_at_window": float(tgt_win),
            "delta": float(tgt_delta),
        },
        "window_minutes": until_minute,
        "analogs": analogs,
    }


# ---------------------------------------------------------------------------
# day_summary_text — input to the embedding pipeline
# ---------------------------------------------------------------------------


def _format_volume(v: float) -> str:
    """Render volume as a short string: 3.25M, 1.07K, 421."""
    if v >= 1_000_000:
        return f"{v / 1_000_000:.2f}M"
    if v >= 1_000:
        return f"{v / 1_000:.1f}K"
    return str(int(v))


def day_summary_text(
    date_iso: str,
    *,
    root: Path | None = None,
) -> str:
    """Return a compact, deterministic text summary of ES front-month activity.

    The output is the *sole* input to the embedding pipeline — any change
    here invalidates previously-stored embeddings. Keep it stable; add
    new fields at the end rather than reordering.

    Format (pipe-separated, human-readable):
        YYYY-MM-DD SYM | open 5324.00 | 1h delta -20.50 | 2h delta -65.00
        | 3h delta -50.00 | range 204.50 | vol 3.25M | close 5273.75 (-50.25)

    Raises ValueError if the date has no ES bars in the archive.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    top_symbol = _front_month_symbol(conn, ohlcv, symbology, date_iso)
    if top_symbol is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    # One pass: compute open, closes at 60/120/180 minutes from session
    # start, day high/low/close, volume. ts_event index is nanosecond,
    # so the +60 minute boundary is captured by "<= start + 60 min".
    row = conn.execute(
        """
        WITH f AS (
            SELECT bars.ts_event, bars.open, bars.high, bars.low,
                   bars.close, bars.volume
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        ),
        bounds AS (
            SELECT MIN(ts_event) AS open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open,
                   MAX(high) AS day_high,
                   MIN(low) AS day_low,
                   LAST(close ORDER BY ts_event) AS day_close,
                   SUM(volume) AS day_volume
            FROM f
        )
        SELECT b.day_open,
               b.day_high,
               b.day_low,
               b.day_close,
               b.day_volume,
               (SELECT LAST(close ORDER BY ts_event) FROM f
                 WHERE ts_event <= b.open_ts + INTERVAL 60 MINUTE)
                 AS close_60,
               (SELECT LAST(close ORDER BY ts_event) FROM f
                 WHERE ts_event <= b.open_ts + INTERVAL 120 MINUTE)
                 AS close_120,
               (SELECT LAST(close ORDER BY ts_event) FROM f
                 WHERE ts_event <= b.open_ts + INTERVAL 180 MINUTE)
                 AS close_180
        FROM bounds b
        """,
        [ohlcv, symbology, top_symbol, date_iso],
    ).fetchone()

    assert row is not None
    (
        day_open,
        day_high,
        day_low,
        day_close,
        day_volume,
        close_60,
        close_120,
        close_180,
    ) = row

    d1 = float(close_60) - float(day_open) if close_60 is not None else None
    d2 = float(close_120) - float(day_open) if close_120 is not None else None
    d3 = float(close_180) - float(day_open) if close_180 is not None else None

    def fmt_delta(d: float | None) -> str:
        return f"{d:+.2f}" if d is not None else "n/a"

    return (
        f"{date_iso} {top_symbol} | "
        f"open {float(day_open):.2f} | "
        f"1h delta {fmt_delta(d1)} | "
        f"2h delta {fmt_delta(d2)} | "
        f"3h delta {fmt_delta(d3)} | "
        f"range {float(day_high) - float(day_low):.2f} | "
        f"vol {_format_volume(float(day_volume))} | "
        f"close {float(day_close):.2f} "
        f"({(float(day_close) - float(day_open)):+.2f})"
    )


# ---------------------------------------------------------------------------
# day_features_vector — engineered numeric feature vector (Phase C)
# ---------------------------------------------------------------------------

DAY_FEATURES_DIM = 60


def day_features_vector(
    date_iso: str,
    *,
    root: Path | None = None,
) -> list[float]:
    """Return a 60-dim feature vector: percent-change from open at each
    of the first 60 minutes of the session.

    Shape of first-hour price path. Directly comparable across days and
    regimes because it's a scale-free percentage. Front-month ES
    selection matches the other archive_query functions — top contract
    by volume for the date.

    Returns exactly 60 floats (forward-fill when bars are missing — rare
    because ES trades nearly 24h, but possible on halts). Fails with
    ValueError if the date has no ES bars OR if fewer than 10 bars exist
    in the first-hour window (implausible data; refuse rather than
    pad-with-zeros a bad vector into the archive).
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    top_symbol = _front_month_symbol(conn, ohlcv, symbology, date_iso)
    if top_symbol is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    # One pass: pull the first 60 minutes of the front-month bars,
    # numbered 1..N where N ≤ 60. Anything beyond minute 60 is ignored.
    # Minute number is `(ts_event - session_open) / 60s`.
    rows = conn.execute(
        """
        WITH f AS (
            SELECT bars.ts_event, bars.open, bars.close
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        ),
        agg AS (
            SELECT FIRST(open ORDER BY ts_event)  AS day_open,
                   MIN(ts_event)                  AS open_ts
            FROM f
        )
        SELECT CAST(
                 EXTRACT(EPOCH FROM (f.ts_event - agg.open_ts)) / 60.0
                 AS INTEGER
               ) AS minute_idx,
               f.close,
               agg.day_open AS day_open
        FROM f, agg
        WHERE f.ts_event > agg.open_ts
          AND f.ts_event
              <= agg.open_ts + CAST(? AS INTEGER) * INTERVAL 1 MINUTE
        ORDER BY f.ts_event
        """,
        [ohlcv, symbology, top_symbol, date_iso, DAY_FEATURES_DIM],
    ).fetchall()

    if len(rows) < 10:
        raise ValueError(
            f"Insufficient first-hour bars for {date_iso}: got {len(rows)}"
        )

    day_open = float(rows[0][2])
    # Build bucket keyed on minute index; forward-fill gaps.
    by_minute: dict[int, float] = {}
    for minute_idx, close, _ in rows:
        idx = int(minute_idx)
        if 1 <= idx <= DAY_FEATURES_DIM:
            by_minute[idx] = float(close)

    vector: list[float] = []
    last_seen = day_open
    for m in range(1, DAY_FEATURES_DIM + 1):
        if m in by_minute:
            last_seen = by_minute[m]
        # Percent change from open — scale-free, cosine-friendly.
        vector.append((last_seen - day_open) / day_open)

    return vector


# ---------------------------------------------------------------------------
# Prediction-time summary (leakage-free, first-hour only)
# ---------------------------------------------------------------------------
#
# The "close (delta)" field in day_summary_text embeds an EOD outcome
# into the query text. When we use that summary as OpenAI embedding
# input, analog retrieval for a target day effectively filters by
# future knowledge — target closed +20 pulls analogs that also
# closed +20, even though at analyze time we wouldn't have known that.
#
# The prediction variant only uses information available by +60 min
# from session open: same time-cut as `day_features_vector`, so text
# and feature embeddings become apples-to-apples.


def day_summary_prediction(
    date_iso: str,
    *,
    root: Path | None = None,
) -> str:
    """Return a prediction-time text summary (no future leakage).

    Fields: date, symbol, open, 1h delta, first-hour high/low/range/vol.
    All extracted from the first 60 minutes of the front-month ES bars.

    Format stability matters: this is the deterministic input to the
    OpenAI embedding call. Reordering fields invalidates stored rows.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    top_symbol = _front_month_symbol(conn, ohlcv, symbology, date_iso)
    if top_symbol is None:
        raise ValueError(f"No ES bars found for {date_iso}")

    row = conn.execute(
        """
        WITH f AS (
            SELECT bars.ts_event, bars.open, bars.high, bars.low,
                   bars.close, bars.volume
            FROM read_parquet(?) AS bars
            JOIN read_parquet(?) AS sym USING (instrument_id)
            WHERE sym.symbol = ?
              AND CAST(date_trunc('day', bars.ts_event) AS DATE) = ?::DATE
        ),
        bounds AS (
            SELECT MIN(ts_event) AS open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open
            FROM f
        ),
        first_hour AS (
            SELECT f.*
            FROM f, bounds b
            WHERE f.ts_event > b.open_ts
              AND f.ts_event <= b.open_ts + INTERVAL 60 MINUTE
        )
        SELECT
            b.day_open,
            (SELECT LAST(close ORDER BY ts_event) FROM first_hour) AS close_60,
            (SELECT MAX(high) FROM first_hour) AS hour_high,
            (SELECT MIN(low)  FROM first_hour) AS hour_low,
            (SELECT SUM(volume) FROM first_hour) AS hour_volume,
            (SELECT COUNT(*) FROM first_hour) AS hour_bars
        FROM bounds b
        """,
        [ohlcv, symbology, top_symbol, date_iso],
    ).fetchone()

    assert row is not None
    day_open, close_60, hour_high, hour_low, hour_volume, hour_bars = row

    if hour_bars is None or hour_bars < 10:
        raise ValueError(
            f"Insufficient first-hour bars for {date_iso}: got {hour_bars}"
        )

    d1 = float(close_60) - float(day_open)

    return (
        f"{date_iso} {top_symbol} | "
        f"open {float(day_open):.2f} | "
        f"1h delta {d1:+.2f} | "
        f"1h high {float(hour_high):.2f} | "
        f"1h low {float(hour_low):.2f} | "
        f"1h range {float(hour_high) - float(hour_low):.2f} | "
        f"1h vol {_format_volume(float(hour_volume))}"
    )


# ---------------------------------------------------------------------------
# Batched variants — amortize Parquet scan across many dates in one query
# ---------------------------------------------------------------------------


def day_features_batch(
    start_date: str,
    end_date: str,
    *,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Compute 60-dim feature vectors for every ES trading day in
    [start_date, end_date]. Returns list of {date, symbol, vector}.

    Single DuckDB query amortizes Parquet scan/metadata cost across
    the whole range. On the production 476 MB archive this cuts
    per-date cost from ~2-10 s (per-row variant) to ~50-200 ms.

    Dates with fewer than 10 bars in the first hour are skipped (same
    threshold as `day_features_vector`). Dates with no ES bars at all
    are simply absent from the returned list — caller decides whether
    to treat as a gap or an error.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Standardized via `front_month_cte` (Phase 2b). Behavior change vs
    # pre-refactor: tied-volume contracts now resolve to the
    # lexicographically-smaller name instead of whichever row DuckDB
    # happened to surface first. Real-volume ties between two ES outright
    # contracts on the same day are vanishingly rare in production data;
    # the determinism guarantee is the win.
    rows = conn.execute(
        front_month_cte(
            symbol_like="'ES%'",
            parquet_path_param="?",
            symbology_path_param="?",
            date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
            extra_select_cols=("bars.open", "bars.close"),
        )
        + """
        per_day AS (
            SELECT day,
                   symbol,
                   MIN(ts_event) AS session_open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open,
                   COUNT(*) AS total_bars
            FROM fb
            GROUP BY day, symbol
        ),
        first_hour AS (
            SELECT fb.day,
                   fb.symbol,
                   pd.day_open,
                   pd.total_bars,
                   CAST(
                       EXTRACT(EPOCH FROM (fb.ts_event - pd.session_open_ts))
                       / 60.0 AS INTEGER
                   ) AS minute_idx,
                   fb.close
            FROM fb
            JOIN per_day pd USING (day, symbol)
            WHERE fb.ts_event > pd.session_open_ts
              AND fb.ts_event
                  <= pd.session_open_ts + CAST(? AS INTEGER) * INTERVAL 1 MINUTE
        )
        SELECT day, symbol, day_open, minute_idx, close, total_bars
        FROM first_hour
        ORDER BY day, minute_idx
        """,
        [ohlcv, symbology, start_date, end_date, DAY_FEATURES_DIM],
    ).fetchall()

    # Group rows by day, compute forward-filled percent-change vector.
    by_day: dict[Any, dict[str, Any]] = {}
    for day, symbol, day_open, minute_idx, close, total_bars in rows:
        state = by_day.setdefault(
            day,
            {
                "symbol": symbol,
                "day_open": float(day_open),
                "minutes": {},
                "total_bars": int(total_bars),
            },
        )
        idx = int(minute_idx)
        if 1 <= idx <= DAY_FEATURES_DIM:
            state["minutes"][idx] = float(close)

    out: list[dict[str, Any]] = []
    for day, state in sorted(by_day.items()):
        if state["total_bars"] < 10:
            # Caller can treat this as a gap (same policy as scalar path).
            continue
        day_open = state["day_open"]
        last_seen = day_open
        minutes = state["minutes"]
        vec: list[float] = []
        for m in range(1, DAY_FEATURES_DIM + 1):
            if m in minutes:
                last_seen = minutes[m]
            vec.append((last_seen - day_open) / day_open)
        out.append(
            {
                "date": day.isoformat() if hasattr(day, "isoformat") else str(day),
                "symbol": state["symbol"],
                "vector": vec,
            }
        )
    return out


def day_summary_batch(
    start_date: str,
    end_date: str,
    *,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Compute canonical text summaries for every ES trading day in
    [start_date, end_date]. Returns list of {date, symbol, summary}.

    Single DuckDB query amortizes Parquet cost. Output matches the
    per-date `day_summary_text` format byte-for-byte — same deltas,
    same precision, same field order — so rows emitted here can flow
    straight into `upsertDayEmbedding` without format drift.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Standardized via `front_month_cte` (Phase 2b). Tied-volume
    # contracts now resolve deterministically by `symbol ASC` rather
    # than relying on DuckDB row order — see day_features_batch comment.
    rows = conn.execute(
        front_month_cte(
            symbol_like="'ES%'",
            parquet_path_param="?",
            symbology_path_param="?",
            date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
            extra_select_cols=(
                "bars.open",
                "bars.high",
                "bars.low",
                "bars.close",
            ),
        )
        + """
        base AS (
            SELECT day,
                   symbol,
                   MIN(ts_event) AS session_open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open,
                   MAX(high) AS day_high,
                   MIN(low) AS day_low,
                   LAST(close ORDER BY ts_event) AS day_close,
                   SUM(volume) AS day_volume
            FROM fb
            GROUP BY day, symbol
        )
        SELECT b.day, b.symbol,
               b.day_open, b.day_high, b.day_low, b.day_close, b.day_volume,
               (SELECT LAST(close ORDER BY ts_event) FROM fb
                 WHERE fb.day = b.day
                   AND fb.ts_event <= b.session_open_ts + INTERVAL 60 MINUTE) AS c60,
               (SELECT LAST(close ORDER BY ts_event) FROM fb
                 WHERE fb.day = b.day
                   AND fb.ts_event <= b.session_open_ts + INTERVAL 120 MINUTE) AS c120,
               (SELECT LAST(close ORDER BY ts_event) FROM fb
                 WHERE fb.day = b.day
                   AND fb.ts_event <= b.session_open_ts + INTERVAL 180 MINUTE) AS c180
        FROM base b
        ORDER BY b.day
        """,
        [ohlcv, symbology, start_date, end_date],
    ).fetchall()

    def fmt_delta(d: float | None) -> str:
        return f"{d:+.2f}" if d is not None else "n/a"

    out: list[dict[str, Any]] = []
    for row in rows:
        (
            day,
            symbol,
            day_open,
            day_high,
            day_low,
            day_close,
            day_volume,
            c60,
            c120,
            c180,
        ) = row
        d1 = float(c60) - float(day_open) if c60 is not None else None
        d2 = float(c120) - float(day_open) if c120 is not None else None
        d3 = float(c180) - float(day_open) if c180 is not None else None
        date_str = day.isoformat() if hasattr(day, "isoformat") else str(day)
        summary = (
            f"{date_str} {symbol} | "
            f"open {float(day_open):.2f} | "
            f"1h delta {fmt_delta(d1)} | "
            f"2h delta {fmt_delta(d2)} | "
            f"3h delta {fmt_delta(d3)} | "
            f"range {float(day_high) - float(day_low):.2f} | "
            f"vol {_format_volume(float(day_volume))} | "
            f"close {float(day_close):.2f} "
            f"({(float(day_close) - float(day_open)):+.2f})"
        )
        # Structured OHLC fields in addition to the text summary. The
        # compare-analog-backends experiment needs these raw numbers to
        # compute asymmetric excursion (high-open vs open-low) for
        # iron-condor strike placement. Text summary stays byte-for-byte
        # stable so the embedding pipeline is unaffected.
        out.append(
            {
                "date": date_str,
                "symbol": symbol,
                "summary": summary,
                "open": float(day_open),
                "high": float(day_high),
                "low": float(day_low),
                "close": float(day_close),
                "range": float(day_high) - float(day_low),
                "up_excursion": float(day_high) - float(day_open),
                "down_excursion": float(day_open) - float(day_low),
            }
        )
    return out


def day_summary_prediction_batch(
    start_date: str,
    end_date: str,
    *,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Batched leakage-free summaries. Byte-identical format to
    `day_summary_prediction`. Single DuckDB query per call.
    """
    conn = _connection()
    ohlcv = _ohlcv_glob(root)
    symbology = _symbology_path(root)

    # Standardized via `front_month_cte` (Phase 2b). Tied-volume
    # contracts now resolve deterministically by `symbol ASC` rather
    # than relying on DuckDB row order — see day_features_batch comment.
    rows = conn.execute(
        front_month_cte(
            symbol_like="'ES%'",
            parquet_path_param="?",
            symbology_path_param="?",
            date_filter_sql="BETWEEN ?::DATE AND ?::DATE",
            extra_select_cols=(
                "bars.open",
                "bars.high",
                "bars.low",
                "bars.close",
            ),
        )
        + """
        day_bounds AS (
            SELECT day, symbol,
                   MIN(ts_event) AS open_ts,
                   FIRST(open ORDER BY ts_event) AS day_open
            FROM fb
            GROUP BY day, symbol
        ),
        first_hour AS (
            SELECT fb.day, fb.symbol, fb.ts_event, fb.high, fb.low,
                   fb.close, fb.volume,
                   db.day_open, db.open_ts
            FROM fb
            JOIN day_bounds db USING (day, symbol)
            WHERE fb.ts_event > db.open_ts
              AND fb.ts_event <= db.open_ts + INTERVAL 60 MINUTE
        )
        SELECT
            db.day,
            db.symbol,
            db.day_open,
            LAST(fh.close ORDER BY fh.ts_event) AS close_60,
            MAX(fh.high) AS hour_high,
            MIN(fh.low)  AS hour_low,
            SUM(fh.volume) AS hour_volume,
            COUNT(*) AS hour_bars
        FROM day_bounds db
        JOIN first_hour fh USING (day, symbol)
        GROUP BY db.day, db.symbol, db.day_open
        ORDER BY db.day
        """,
        [ohlcv, symbology, start_date, end_date],
    ).fetchall()

    out: list[dict[str, Any]] = []
    for row in rows:
        day, symbol, day_open, close_60, hour_high, hour_low, hour_volume, hour_bars = (
            row
        )
        if hour_bars < 10:
            continue
        d1 = float(close_60) - float(day_open)
        date_str = day.isoformat() if hasattr(day, "isoformat") else str(day)
        summary = (
            f"{date_str} {symbol} | "
            f"open {float(day_open):.2f} | "
            f"1h delta {d1:+.2f} | "
            f"1h high {float(hour_high):.2f} | "
            f"1h low {float(hour_low):.2f} | "
            f"1h range {float(hour_high) - float(hour_low):.2f} | "
            f"1h vol {_format_volume(float(hour_volume))}"
        )
        out.append({"date": date_str, "symbol": symbol, "summary": summary})
    return out
