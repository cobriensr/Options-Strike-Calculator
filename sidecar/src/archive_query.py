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

import os
from pathlib import Path
from typing import Any

import duckdb

from logger_setup import log

_ROOT = Path(os.environ.get("ARCHIVE_ROOT", "/data/archive"))


def _ohlcv_glob(root: Path | None = None) -> str:
    """Parquet glob across year partitions. Override `root` for tests."""
    base = root or _ROOT
    return str(base / "ohlcv_1m" / "year=*" / "part.parquet")


def _symbology_path(root: Path | None = None) -> str:
    base = root or _ROOT
    return str(base / "symbology.parquet")


# Lazy module-level connection — built on first use so tests that point
# at a different root can construct their own.
_conn: duckdb.DuckDBPyConnection | None = None


def _connection() -> duckdb.DuckDBPyConnection:
    global _conn
    if _conn is None:
        _conn = duckdb.connect()
        log.info("DuckDB connection initialized for archive queries")
    return _conn


def reset_connection_for_tests() -> None:
    """Drop the shared connection so a new one is built on next use.

    Tests that swap `_ROOT` or test_duckdb bindings call this so state
    doesn't leak across tests.
    """
    global _conn
    if _conn is not None:
        _conn.close()
        _conn = None


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

    tgt_symbol, tgt_open, tgt_high, tgt_low, tgt_close, tgt_vol, tgt_win, tgt_delta = target_row

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
