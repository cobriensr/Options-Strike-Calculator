"""Per-day EOD option-flow chains, built from the UW Full Tape, and their multi-day rollup.

One by-day file holds one row per option chain (strike, expiry, type) that traded
heavily that day: every kept print summed into sizes, premium, first and last
price and time. It replaces the retired bot-eod CSV as the source: side and
equity type, which the CSV carried as columns, come from each print's `tags`
(`{ask_side,bullish,etf}`). The output keeps the legacy 22 columns and types
exactly, so days built from the tape and the seeded days read as one set.

- `build_chains` turns one tape day into a by-day parquet.
- `rollup` aggregates every by-day file in a directory.
- `write_headlines` renders the rollup as text.

DuckDB runs every query in a UTC session (`connect`), so no result depends on the
host's zone. The open-auction window is 09:30-10:00 ET, computed from the first
print's instant; the headlines show times in CT.

Shared code: it runs on Python 3.12 (the nightly image) and 3.14 (the ml venv).
DuckDB hands a TIMESTAMPTZ to Python through `pytz`, which the nightly image does
not have, so `rollup` fetches instants as epoch microseconds and rebuilds the
datetimes itself.

Errors and logs carry column names and counts only, never a row of tape data.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

# Detector ticker watchlist (post 2026-04-24 expansion). The rollup's SQL spells the
# same tickers out; this list is carried over as it was.
WATCHLIST = ["SPXW", "NDXP", "SPY", "QQQ", "IWM", "NVDA", "SNDK"]

# Per-day parquet filters (keep file size small)
MIN_VOL_OI_RATIO = 5.0
MIN_PREMIUM = 100_000  # $100K floor for parquet inclusion

# A print's side and equity type, from its tags. The first tag that matches wins.
SIDE_TAGS: Mapping[str, str] = {"ask_side": "ask", "bid_side": "bid", "mid_side": "mid"}
NO_SIDE = "no_side"
EQUITY_TYPE_TAGS: tuple[tuple[str, str], ...] = (("index", "Index"), ("etf", "ETF"))

# The legacy by-day layout, with DuckDB types: the 22 columns and their order.
CHAINS_COLUMNS: tuple[tuple[str, str], ...] = (
    ("trade_date", "VARCHAR"),
    ("option_chain_id", "VARCHAR"),
    ("ticker", "VARCHAR"),
    ("underlying_symbol", "VARCHAR"),
    ("strike", "DOUBLE"),
    ("option_type", "VARCHAR"),
    ("expiry", "DATE"),
    ("equity_type", "VARCHAR"),
    ("sector", "VARCHAR"),
    ("total_size", "DOUBLE"),
    ("total_premium", "DOUBLE"),
    ("day_volume", "BIGINT"),
    ("day_oi", "BIGINT"),
    ("ask_size", "DOUBLE"),
    ("bid_size", "DOUBLE"),
    ("first_ts", "TIMESTAMPTZ"),
    ("last_ts", "TIMESTAMPTZ"),
    ("first_price", "DOUBLE"),
    ("last_price", "DOUBLE"),
    ("first_underlying", "DOUBLE"),
    ("last_underlying", "DOUBLE"),
    ("trade_count", "BIGINT"),
)

# Bumped when the chains' content or schema changes, so a by-day file built under
# the old rules reads as stale.
CHAINS_VERSION = 1

# The first session with a by-day file (the bot-eod archive starts here).
CHAINS_START = date(2026, 4, 13)

# 09:30-10:00 ET as minutes of the ET day, both ends inclusive: the whole 10:00 minute counts.
OPEN_WINDOW_ET_MINUTES = (570, 600)

# The tape columns `build_chains` reads. Any other column, whatever the day's layout, is ignored.
REQUIRED_TAPE_COLUMNS = frozenset(
    {
        "id",
        "underlying_symbol",
        "executed_at",
        "price",
        "option_chain_id",
        "tags",
        "expiry",
        "option_type",
        "open_interest",
        "strike",
        "premium",
        "volume",
        "underlying_price",
        "size",
        "canceled",
    }
)

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class ChainsBuildError(Exception):
    """A tape day could not be turned into chains. Messages name columns and counts only."""


def _literal(text: str) -> str:
    """`text` as a DuckDB string literal."""
    return "'" + text.replace("'", "''") + "'"


def connect(temp_dir: Path | None = None) -> duckdb.DuckDBPyConnection:
    """An in-memory DuckDB connection with the session every query here assumes.

    - UTC, so a naive timestamp reads as UTC and no result follows the host's zone.
    - 4 threads, the Dockerfile's POLARS_MAX_THREADS, and a 4 GB memory limit, so a
      1.7 GB tape day cannot take the container's memory.
    - `temp_dir` as the spill directory when given. The image's working directory
      (/app) is not writable, so DuckDB would fail there instead of spilling.
    """
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        con.execute("SET threads = 4")
        con.execute("SET memory_limit = '4GB'")
        if temp_dir is not None:
            con.execute(f"SET temp_directory = {_literal(str(temp_dir))}")
    except BaseException:
        con.close()
        raise
    return con


def _side_sql() -> str:
    whens = " ".join(
        f"WHEN list_contains(tag_list, {_literal(tag)}) THEN {_literal(side)}"
        for tag, side in SIDE_TAGS.items()
    )
    return f"CASE {whens} ELSE {_literal(NO_SIDE)} END"


def _equity_type_sql() -> str:
    whens = " ".join(
        f"WHEN list_contains(tag_list, {_literal(tag)}) THEN {_literal(equity_type)}"
        for tag, equity_type in EQUITY_TYPE_TAGS
    )
    return f"CASE {whens} ELSE NULL END"


def _chains_sql(tape_path: Path, day: date, tmp_path: Path) -> str:
    """The COPY that writes `tmp_path`: kept prints, summed per chain, cast to CHAINS_COLUMNS."""
    casts = ", ".join(f'CAST("{name}" AS {sql_type}) AS "{name}"' for name, sql_type in CHAINS_COLUMNS)
    return f"""
        COPY (
            WITH kept AS (
                SELECT
                    option_chain_id,
                    underlying_symbol,
                    CAST(strike AS DOUBLE) AS strike,
                    option_type,
                    expiry,
                    id,
                    CAST(executed_at AS TIMESTAMPTZ) AS ts,
                    CAST(price AS DOUBLE) AS price,
                    CAST(underlying_price AS DOUBLE) AS underlying_price,
                    CAST(size AS DOUBLE) AS size,
                    CAST(premium AS DOUBLE) AS premium,
                    volume,
                    open_interest,
                    string_split(trim(coalesce(tags, ''), '{{}}'), ',') AS tag_list
                FROM read_parquet({_literal(str(tape_path))})
                WHERE lower(CAST(canceled AS VARCHAR)) IN ('false', 'f', '0')
                  AND open_interest > 0
                  AND CAST(volume AS DOUBLE) / open_interest >= {MIN_VOL_OI_RATIO}
                  AND CAST(premium AS DOUBLE) >= {MIN_PREMIUM}
            ),
            sided AS (
                SELECT *, {_side_sql()} AS side, {_equity_type_sql()} AS equity_type
                FROM kept
            ),
            chains AS (
                SELECT
                    {_literal(day.isoformat())} AS trade_date,
                    option_chain_id,
                    CASE
                        WHEN option_chain_id LIKE 'SPXW%' THEN 'SPXW'
                        WHEN option_chain_id LIKE 'NDXP%' THEN 'NDXP'
                        ELSE FIRST(underlying_symbol ORDER BY ts, id)
                    END AS ticker,
                    FIRST(underlying_symbol ORDER BY ts, id) AS underlying_symbol,
                    FIRST(strike ORDER BY ts, id) AS strike,
                    FIRST(option_type ORDER BY ts, id) AS option_type,
                    FIRST(expiry ORDER BY ts, id) AS expiry,
                    FIRST(equity_type ORDER BY ts, id) AS equity_type,
                    NULL::VARCHAR AS sector,
                    SUM(size) AS total_size,
                    SUM(premium) AS total_premium,
                    MAX(volume) AS day_volume,
                    MAX(open_interest) AS day_oi,
                    SUM(CASE WHEN side = 'ask' THEN size ELSE 0 END) AS ask_size,
                    SUM(CASE WHEN side = 'bid' THEN size ELSE 0 END) AS bid_size,
                    MIN(ts) AS first_ts,
                    MAX(ts) AS last_ts,
                    FIRST(price ORDER BY ts, id) AS first_price,
                    LAST(price ORDER BY ts, id) AS last_price,
                    FIRST(underlying_price ORDER BY ts, id) AS first_underlying,
                    LAST(underlying_price ORDER BY ts, id) AS last_underlying,
                    COUNT(*) AS trade_count
                FROM sided
                GROUP BY option_chain_id
            )
            SELECT {casts} FROM chains ORDER BY option_chain_id
        ) TO {_literal(str(tmp_path))} (FORMAT PARQUET)
    """


def build_chains(tape_path: Path, day: date, out_path: Path, temp_dir: Path | None = None) -> int:
    """Write `day`'s by-day chains file from its tape to `out_path`; the chain rows written.

    The tape may be in any layout the lake holds (decimal or Float64 numerics, naive or
    tz-aware `executed_at`, Boolean or text `canceled`, any extra columns): the output
    is always CHAINS_COLUMNS. A day with no kept print writes an empty file and returns 0.

    The file is written to `<out_path>.tmp` and renamed, so `out_path` is never half
    written and a failed build leaves an earlier file as it was. A required column the
    tape lacks, or any DuckDB failure, raises ChainsBuildError naming the columns or the
    exception class, never a value from the tape.
    """
    tmp_path = out_path.with_name(out_path.name + ".tmp")
    con = connect(temp_dir)
    try:
        described = con.execute(
            f"DESCRIBE SELECT * FROM read_parquet({_literal(str(tape_path))})"
        ).fetchall()
        missing = sorted(REQUIRED_TAPE_COLUMNS - {row[0] for row in described})
        if missing:
            raise ChainsBuildError(
                f"tape for {day.isoformat()} lacks required columns: {', '.join(missing)}"
            )
        out_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path.unlink(missing_ok=True)
        written = con.execute(_chains_sql(tape_path, day, tmp_path)).fetchone()
        if written is None:
            raise ChainsBuildError(f"chains for {day.isoformat()}: the write reported no count")
        os.replace(tmp_path, out_path)
        return int(written[0])
    except duckdb.Error as exc:
        # Not chained, and only the class named: DuckDB's text can quote a value from the tape.
        raise ChainsBuildError(
            f"chains for {day.isoformat()} could not be built ({type(exc).__name__})"
        ) from None
    finally:
        con.close()
        tmp_path.unlink(missing_ok=True)


def _fetch_dicts(con: duckdb.DuckDBPyConnection, sql: str) -> list[dict]:
    cursor = con.execute(sql)
    columns = [column[0] for column in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def _utc_instants(rows: list[dict]) -> list[dict]:
    """Turn each row's `first_ts`, fetched as epoch microseconds, into a UTC datetime."""
    for row in rows:
        micros = row["first_ts"]
        row["first_ts"] = None if micros is None else _EPOCH + timedelta(microseconds=micros)
    return rows


def rollup(by_day_dir: Path) -> dict:
    """Aggregate across every `*-chains.parquet` in `by_day_dir`."""
    if not any(by_day_dir.glob("*-chains.parquet")):
        return {"days": [], "stats": {}, "tickers": [], "repeat_strikes": []}

    parquet_glob = str(by_day_dir / "*-chains.parquet")
    window_start, window_end = OPEN_WINDOW_ET_MINUTES
    con = connect()
    try:
        # union_by_name: seeded days and tape-built days may differ in column order.
        # first_ts is a UTC instant; the ET clock is read from it, not from the session zone.
        con.execute(
            f"""
            CREATE TABLE chains AS
            SELECT *,
                CASE WHEN total_size > 0 THEN ask_size::DOUBLE / total_size ELSE NULL END AS ask_pct,
                CASE WHEN total_size > 0 THEN bid_size::DOUBLE / total_size ELSE NULL END AS bid_pct,
                CASE WHEN day_oi > 0 THEN day_volume::DOUBLE / day_oi ELSE NULL END AS vol_oi_ratio,
                CASE WHEN first_price > 0 THEN (last_price - first_price) / first_price ELSE NULL END AS opt_return,
                CASE WHEN first_underlying > 0
                     THEN (last_underlying - first_underlying) / first_underlying
                     ELSE NULL END AS und_return,
                EXTRACT(HOUR FROM timezone('America/New_York', first_ts)) * 60
                    + EXTRACT(MINUTE FROM timezone('America/New_York', first_ts)) AS first_minute_et
            FROM read_parquet({_literal(parquet_glob)}, union_by_name = true)
        """
        )

        days = sorted({r[0] for r in con.execute("SELECT DISTINCT trade_date FROM chains").fetchall()})

        # ── Per-ticker rollup ──
        tickers = _fetch_dicts(
            con,
            """
            SELECT
                ticker,
                COUNT(*) AS chains,
                COUNT(DISTINCT trade_date) AS active_days,
                SUM(total_premium) AS total_premium,
                AVG(vol_oi_ratio) AS avg_ratio,
                MAX(vol_oi_ratio) AS peak_ratio,
                -- Directional bets and their outcomes
                SUM(CASE WHEN ask_pct >= 0.65 THEN 1 ELSE 0 END) AS ask_dominant_chains,
                SUM(CASE WHEN ask_pct >= 0.65 AND opt_return > 0.10 THEN 1 ELSE 0 END) AS ask_winners,
                SUM(CASE WHEN ask_pct >= 0.65 AND opt_return < -0.10 THEN 1 ELSE 0 END) AS ask_losers,
                -- Bid-side
                SUM(CASE WHEN bid_pct >= 0.65 THEN 1 ELSE 0 END) AS bid_dominant_chains,
                -- Calls vs puts split for ASK-side directional
                SUM(CASE WHEN ask_pct >= 0.65 AND option_type='call' THEN 1 ELSE 0 END) AS ask_call_chains,
                SUM(CASE WHEN ask_pct >= 0.65 AND option_type='put' THEN 1 ELSE 0 END) AS ask_put_chains
            FROM chains
            GROUP BY ticker
            ORDER BY total_premium DESC
            LIMIT 50
        """,
        )

        # ── Repeat strikes (same ticker × strike × side × expiry across multiple days) ──
        repeat_strikes = _fetch_dicts(
            con,
            """
            SELECT
                ticker,
                strike,
                option_type,
                expiry,
                COUNT(DISTINCT trade_date) AS days_active,
                SUM(total_premium) AS total_premium,
                AVG(vol_oi_ratio) AS avg_ratio,
                AVG(ask_pct) AS avg_ask_pct,
                AVG(opt_return) AS avg_opt_return,
                STRING_AGG(DISTINCT trade_date::VARCHAR, ',' ORDER BY trade_date) AS dates
            FROM chains
            GROUP BY ticker, strike, option_type, expiry
            HAVING COUNT(DISTINCT trade_date) >= 2
            ORDER BY total_premium DESC
            LIMIT 30
        """,
        )

        # ── Per-day stats ──
        # Session open/close use SPX/SPXW chains as benchmark — first_underlying is
        # per-chain (the underlying price at THAT chain's first trade), so mixing
        # tickers (e.g. SNDK at $35 with SPXW at $7160) breaks arg_min/arg_max.
        # SPXW gives the densest 8:30-15:00 CT timestamp coverage.
        daily = _fetch_dicts(
            con,
            """
            SELECT
                trade_date,
                COUNT(*) AS chains,
                SUM(total_premium) AS total_premium,
                -- Bullish-call ratio (sign of macro tape)
                SUM(CASE WHEN option_type='call' AND ask_pct >= 0.65 THEN total_premium ELSE 0 END) AS bullish_call_prem,
                SUM(CASE WHEN option_type='put'  AND ask_pct >= 0.65 THEN total_premium ELSE 0 END) AS bearish_put_prem,
                -- SPX session open→close from SPX/SPXW chains only (consistent underlying)
                arg_min(CASE WHEN ticker IN ('SPXW','SPX') THEN first_underlying END,
                        CASE WHEN ticker IN ('SPXW','SPX') THEN first_ts END) AS spx_open,
                arg_max(CASE WHEN ticker IN ('SPXW','SPX') THEN last_underlying END,
                        CASE WHEN ticker IN ('SPXW','SPX') THEN last_ts END) AS spx_close,
                CASE WHEN arg_min(CASE WHEN ticker IN ('SPXW','SPX') THEN first_underlying END,
                                  CASE WHEN ticker IN ('SPXW','SPX') THEN first_ts END) > 0 THEN
                    (arg_max(CASE WHEN ticker IN ('SPXW','SPX') THEN last_underlying END,
                             CASE WHEN ticker IN ('SPXW','SPX') THEN last_ts END)
                     - arg_min(CASE WHEN ticker IN ('SPXW','SPX') THEN first_underlying END,
                               CASE WHEN ticker IN ('SPXW','SPX') THEN first_ts END))
                    / arg_min(CASE WHEN ticker IN ('SPXW','SPX') THEN first_underlying END,
                              CASE WHEN ticker IN ('SPXW','SPX') THEN first_ts END)
                END AS spx_return
            FROM chains
            GROUP BY trade_date
            ORDER BY trade_date
        """,
        )

        # ── Top 30 single-name (non-ETF/Index) chains by premium across all days ──
        single_names = _utc_instants(
            _fetch_dicts(
                con,
                """
                SELECT
                    trade_date, ticker, strike, option_type, expiry,
                    day_volume, day_oi, vol_oi_ratio, total_premium,
                    ask_pct, bid_pct, opt_return, und_return, epoch_us(first_ts) AS first_ts
                FROM chains
                WHERE (equity_type NOT IN ('ETF', 'Index') OR equity_type IS NULL)
                  AND total_premium >= 1000000
                ORDER BY total_premium DESC
                LIMIT 30
            """,
            )
        )

        # ── Watchlist directional ASK winners + losers across all days ──
        watch_winners = _utc_instants(
            _fetch_dicts(
                con,
                """
                SELECT
                    trade_date, ticker, strike, option_type, expiry,
                    vol_oi_ratio, total_premium, ask_pct, opt_return, und_return,
                    epoch_us(first_ts) AS first_ts
                FROM chains
                WHERE ticker IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK')
                  AND ask_pct >= 0.65
                  AND opt_return >= 0.30
                ORDER BY opt_return DESC
                LIMIT 30
            """,
            )
        )

        watch_losers = _utc_instants(
            _fetch_dicts(
                con,
                """
                SELECT
                    trade_date, ticker, strike, option_type, expiry,
                    vol_oi_ratio, total_premium, ask_pct, opt_return, und_return,
                    epoch_us(first_ts) AS first_ts
                FROM chains
                WHERE ticker IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK')
                  AND ask_pct >= 0.65
                  AND opt_return <= -0.30
                ORDER BY opt_return ASC
                LIMIT 30
            """,
            )
        )

        # ── Out-of-watchlist tickers (candidates for future addition) ──
        candidates = _fetch_dicts(
            con,
            """
            SELECT
                ticker,
                COUNT(*) AS chains,
                COUNT(DISTINCT trade_date) AS active_days,
                SUM(total_premium) AS total_premium,
                AVG(vol_oi_ratio) AS avg_ratio,
                SUM(CASE WHEN ask_pct >= 0.65 THEN 1 ELSE 0 END) AS dir_chains,
                SUM(CASE WHEN ask_pct >= 0.65 AND opt_return > 0.10 THEN 1 ELSE 0 END) AS ask_winners
            FROM chains
            WHERE ticker NOT IN ('SPXW','NDXP','SPY','QQQ','IWM','NVDA','SNDK','SPX','NDX')
              AND (equity_type NOT IN ('ETF','Index') OR equity_type IS NULL)
            GROUP BY ticker
            HAVING COUNT(DISTINCT trade_date) >= 2
               AND SUM(total_premium) >= 5000000
            ORDER BY total_premium DESC
            LIMIT 25
        """,
        )

        # ── Open-auction clustering check: first print in 09:30-10:00 ET ──
        morning_stats = _fetch_dicts(
            con,
            f"""
            SELECT
                trade_date,
                SUM(CASE WHEN first_minute_et BETWEEN {window_start} AND {window_end} THEN 1 ELSE 0 END) AS first_30min,
                SUM(CASE WHEN first_minute_et BETWEEN {window_start} AND {window_end} AND ask_pct >= 0.65 THEN 1 ELSE 0 END) AS first_30min_directional,
                COUNT(*) AS total_chains
            FROM chains
            WHERE ask_pct >= 0.65
            GROUP BY trade_date
            ORDER BY trade_date
        """,
        )
    finally:
        con.close()

    return {
        "days": days,
        "daily_stats": daily,
        "tickers": tickers,
        "repeat_strikes": repeat_strikes,
        "single_names": single_names,
        "watchlist_winners": watch_winners,
        "watchlist_losers": watch_losers,
        "out_of_watchlist_candidates": candidates,
        "morning_clustering": morning_stats,
    }


def _ct_clock(first: datetime | None) -> str:
    """HH:MM Central time of an instant; a naive datetime is read as UTC, never as the host's zone."""
    if first is None:
        return "?"
    if first.tzinfo is None:
        first = first.replace(tzinfo=UTC)
    return first.astimezone(ZoneInfo("America/Chicago")).strftime("%H:%M")


def write_headlines(rollup: dict) -> str:
    """Generate human-readable summary."""
    lines: list[str] = []
    days = rollup.get("days", [])
    lines.append(f"# EOD Option-Flow Multi-Day Rollup ({len(days)} days)")
    lines.append(f"  Date range: {days[0] if days else '?'} → {days[-1] if days else '?'}")
    lines.append("")

    # Daily stats — SPX session open→close from SPXW chains
    lines.append("## Per-day summary")
    lines.append(
        f"  {'Date':<12} {'Chains':>7} {'Premium':>14} {'Bullish $':>14} {'Bearish $':>14} "
        f"{'SpxOpen':>9} {'SpxClose':>9} {'SpxRet':>7}"
    )
    for d in rollup.get("daily_stats", []):
        prem = d.get("total_premium") or 0
        bcp = d.get("bullish_call_prem") or 0
        bpp = d.get("bearish_put_prem") or 0
        spx_open = d.get("spx_open") or 0
        spx_close = d.get("spx_close") or 0
        spx_ret = d.get("spx_return") or 0
        lines.append(
            f"  {str(d['trade_date']):<12} {d['chains']:>7} ${prem:>12,.0f} "
            f"${bcp:>12,.0f} ${bpp:>12,.0f} {spx_open:>9.2f} {spx_close:>9.2f} "
            f"{spx_ret*100:>+6.2f}%"
        )

    # Top tickers
    lines.append("")
    lines.append("## Top tickers by total outsized premium (across all days)")
    lines.append(f"  {'Ticker':<8} {'Chains':>7} {'Days':>5} {'Premium':>14} "
                 f"{'AvgRatio':>9} {'PeakRatio':>9} {'AskDom':>7} {'AskWins':>8} {'AskLoses':>8}")
    for t in rollup.get("tickers", [])[:20]:
        prem = t.get("total_premium") or 0
        avg_r = t.get("avg_ratio") or 0
        peak_r = t.get("peak_ratio") or 0
        lines.append(
            f"  {t['ticker']:<8} {t['chains']:>7} {t['active_days']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {peak_r:>8.1f}× {t['ask_dominant_chains']:>7} "
            f"{t['ask_winners']:>8} {t['ask_losers']:>8}"
        )

    # Repeat strikes
    lines.append("")
    lines.append("## Repeat strikes — same contract showing up on multiple days (persistent positioning)")
    lines.append(f"  {'Ticker':<8} {'Strike':>10} {'C/P':<3} {'Expiry':<11} {'Days':>5} "
                 f"{'Premium':>14} {'AvgRatio':>9} {'AvgAsk%':>7} {'AvgRet':>7}  Dates")
    for r in rollup.get("repeat_strikes", [])[:15]:
        side = "C" if r["option_type"] == "call" else "P"
        prem = r.get("total_premium") or 0
        avg_r = r.get("avg_ratio") or 0
        avg_a = r.get("avg_ask_pct") or 0
        avg_o = r.get("avg_opt_return") or 0
        lines.append(
            f"  {r['ticker']:<8} {float(r['strike']):>10.1f} {side:<3} "
            f"{str(r['expiry']):<11} {r['days_active']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {avg_a*100:>6.0f}% {avg_o*100:>+6.1f}%  {r['dates']}"
        )

    # Out-of-watchlist candidates
    lines.append("")
    lines.append("## OUT-OF-WATCHLIST single-name candidates (worth considering)")
    lines.append("  Filter: ≥2 active days, ≥$5M total outsized premium, single-name (not ETF/Index)")
    lines.append(f"  {'Ticker':<8} {'Chains':>7} {'Days':>5} {'Premium':>14} "
                 f"{'AvgRatio':>9} {'DirChains':>10} {'AskWins':>8}")
    for c in rollup.get("out_of_watchlist_candidates", [])[:20]:
        prem = c.get("total_premium") or 0
        avg_r = c.get("avg_ratio") or 0
        lines.append(
            f"  {c['ticker']:<8} {c['chains']:>7} {c['active_days']:>5} ${prem:>12,.0f} "
            f"{avg_r:>8.1f}× {c['dir_chains']:>10} {c['ask_winners']:>8}"
        )

    # Watchlist winners
    lines.append("")
    lines.append("## Watchlist ASK-side WINNERS (≥30% option return, ≥65% ask, vol/OI≥5×)")
    lines.append(f"  {'Date':<12} {'Ticker':<7} {'Strike':>9} {'C/P':<3} {'Exp':<6} "
                 f"{'Ratio':>7} {'Premium':>11} {'Ask%':>5} {'OptRet':>8} {'UndRet':>7} {'First CT':<8}")
    for w in rollup.get("watchlist_winners", [])[:20]:
        side = "C" if w["option_type"] == "call" else "P"
        first_str = _ct_clock(w.get("first_ts"))
        ratio = w.get("vol_oi_ratio") or 0
        prem = w.get("total_premium") or 0
        ap = w.get("ask_pct") or 0
        opt_r = w.get("opt_return") or 0
        und_r = w.get("und_return") or 0
        lines.append(
            f"  {str(w['trade_date']):<12} {w['ticker']:<7} {float(w['strike']):>9.1f} {side:<3} "
            f"{str(w['expiry'])[-5:]:<6} {ratio:>6.1f}× ${prem:>10,.0f} "
            f"{ap*100:>4.0f}% {opt_r*100:>+7.1f}% {und_r*100:>+6.2f}% {first_str:<8}"
        )

    # Watchlist losers
    lines.append("")
    lines.append("## Watchlist ASK-side LOSERS (≤-30% option return)")
    lines.append(f"  {'Date':<12} {'Ticker':<7} {'Strike':>9} {'C/P':<3} {'Exp':<6} "
                 f"{'Ratio':>7} {'Premium':>11} {'Ask%':>5} {'OptRet':>8} {'UndRet':>7} {'First CT':<8}")
    for loser in rollup.get("watchlist_losers", [])[:20]:
        side = "C" if loser["option_type"] == "call" else "P"
        first_str = _ct_clock(loser.get("first_ts"))
        ratio = loser.get("vol_oi_ratio") or 0
        prem = loser.get("total_premium") or 0
        ap = loser.get("ask_pct") or 0
        opt_r = loser.get("opt_return") or 0
        und_r = loser.get("und_return") or 0
        lines.append(
            f"  {str(loser['trade_date']):<12} {loser['ticker']:<7} {float(loser['strike']):>9.1f} {side:<3} "
            f"{str(loser['expiry'])[-5:]:<6} {ratio:>6.1f}× ${prem:>10,.0f} "
            f"{ap*100:>4.0f}% {opt_r*100:>+7.1f}% {und_r*100:>+6.2f}% {first_str:<8}"
        )

    # Open-auction clustering
    lines.append("")
    lines.append("## 9:30-10:00 ET (8:30-9:00 CT) open-auction window directional flow %")
    lines.append("  Hypothesis: institutional desks place day's directional bets at the open.")
    lines.append(f"  {'Date':<12} {'TotalDir':>9} {'First30m':>10} {'%InOpen':>9}")
    for m in rollup.get("morning_clustering", []):
        f30 = m.get("first_30min_directional", 0)
        tot = m.get("total_chains", 0)
        pct = (f30 / tot * 100) if tot > 0 else 0
        lines.append(
            f"  {str(m['trade_date']):<12} {tot:>9} {f30:>10} {pct:>8.1f}%"
        )

    return "\n".join(lines)
