"""Phase 1 of the futures contract-month repair: rebuild front-month ES/NQ bars.

From 2026-04-05 evening to 2026-06-15 14:11Z, `futures_bars` merged every
contract month of each root into one row per minute. This extract rebuilds the
true front-month (ESM6 / NQM6) 1-minute bars for ES and NQ and writes them to a
file. It is read-only: the archive is local Parquet, Postgres is read in
read-only sessions, and nothing is written to any database. Phase 2 (a
TypeScript apply tool) turns the file into writes.

Spec: docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md.

Sources (UTC, bar-open minutes):

  * Archive span 2026-04-05 22:00 -> 04-17 20:59: the frozen Databento archive's
    `ohlcv_1m`, which carries the raw symbol. Each UTC day's front month is its
    volume leader among the root's outrights; any leader other than ESM6 / NQM6
    stops the run.
  * Tick span 2026-04-20 01:56 -> 06-15 14:11: Postgres `futures_trade_ticks`,
    whose `symbol` is only the root. The contract is recovered from price.

The cluster rule (tick span), per root and minute:

  1. Round every print to the 0.25 tick and sort the minute's prints by price.
  2. Split into clusters wherever two adjacent prices are more than G apart.
  3. Keep the lowest-priced cluster. ES and NQ carry is positive, so the front
     month is the cheapest contract.
  4. Build the bar from that cluster in time order: open = first print, close =
     last, high / low = max / min, volume = sum of sizes. Prints with the same
     timestamp keep the tick table's own `id` order (its insert order, which
     follows `ts`); on the archive the file row order plays that part.

Back-month-only minutes: when the front month didn't print, the lowest cluster
is the next contract, about one carry above the front. Each minute's kept level
(the median of its kept prints) is compared with the median kept level of its
neighbours: the nearest 5 minutes with prints on each side, within 30 minutes.
A minute more than half a carry above that reference sits closer to the next
contract than to the front. It is `front_absent`: it gets no bar and is listed
in front_absent.csv, so Phase 2 can delete that row. The reference uses only
the neighbours' own stateless picks, never an earlier decision, so one wrong
minute can't latch the series onto another contract; it is one value of up to
ten in a median. A minute with no neighbour in the window has no reference and
keeps its pick.

Carry is the next contract's premium over the front, as seen in 5-second slices
of the tick span where both printed: ES 55..62 (60 used), NQ 264..300 (280
used, the spec's ~277). The half-carry threshold (ES 30, NQ 140) replaced G
after the first tick run. With G as the threshold, two sharp NQ rallies in the
front itself were flagged: 06-10 12:30Z, the 08:30 ET data, ~91 above its
neighbours, and 06-11 17:30Z, ~119 above. Neither minute had a back-month-only
print, and a real back-only minute sits about 280 above.

G per root (measured on the ground-truth run below: 13,680 minutes per root).
G has to clear three numbers. On one side are the widest step between adjacent
kept prices, and the furthest a minute's level sat above its neighbours'
median. On the other side is the narrowest step that split the front from the
next contract.

  * ES 25 points, from the investigation (q16 / q18). Widest kept step 12.0,
    level at most 13.5 above the neighbours' median, narrowest split 26.25
    (0.1% quantile 30.6). G = 15, 20 and 25 give the same matches.
  * NQ 87.5 points (team-lead ruling: the middle of the flat 75..100 band seen
    while G was also the front_absent threshold). Widest kept step 25.75 (one
    minute above 20), level at most 60.3 above the neighbours' median (99.9th
    percentile 35.9), narrowest split 104.5 (0.1% quantile 142.3; carry
    188..266, median 229). On the tick span: widest kept step 16.0 outside the
    one mixed minute, narrowest split 87.75 (06-11 17:28Z). The NQ tick bars
    are identical at G = 60 and 87.5.

  Sweep with the half-carry absent rule (no minute is flagged at any G):
  exact-OHLC minutes out of 13,680, by archive clock.

      G      ES ts_recv  ES ts_event | NQ ts_recv  NQ ts_event
      15     13,677      13,660      |
      20     13,677      13,660      |
      25     13,677      13,660      |
      30     13,674      13,657      | 13,680      13,638
      40     13,647      13,631      | 13,680      13,638
      50 .. 100                      | 13,680      13,638
      110, 125                       | 13,679      13,637

  While G was also the absent threshold, NQ below 75 lost good minutes to
  false flags: 1 at G = 60, 3 at 50, 7 at 40, 31 at 30.

Minutes: a print belongs to the minute of its `ts`. The tick table's `ts` is
Databento's ts_event, the only clock the sidecar stored, so tick-span bars use
ts_event. Databento built the archive's `ohlcv_1m` by ts_recv instead. A print
whose two clocks straddle a minute boundary lands one minute earlier here,
which moves that minute's close and the next minute's open by about a tick.
That happened to 43 ES and 48 NQ trades in 04-06..04-17. The output's
`n_clusters` lets Phase 2 rewrite only mixed minutes, so a clean minute keeps
Databento's own bar and the boundary difference never reaches the table.

Usage (from the repo root; the archive lives in the main checkout only):

    ml/.venv/Scripts/python ml/src/futures_contract_repair.py \\
        --archive F:/dev/strike-calculator/ml/data/archive

Outputs (--out-dir, default ml/data/futures-contract-repair/, gitignored):

  * rebuilt_bars.parquet: symbol, ts (UTC bar-open minute), open, high, low,
    close (float64, on the 0.25 tick), volume (int64), n_clusters (int64: the
    contracts the minute's prints held, 1 on the archive), source
    (archive|ticks). Only minutes the source covers: a minute with no ticks
    gets no row.
  * per_day.csv: per root, UTC day and source: the bars built, front_absent
    minutes, multi-cluster minutes, prints, the widest bar, the first and last
    minute, and G's margins (the widest kept step, the narrowest split).
  * front_absent.csv: symbol, ts of each tick minute where only a back month
    printed.
  * ground_truth.csv: the gate below, per root, day and archive clock.

The ground-truth gate runs first: the cluster rule on the archive's TBBO trades
for 04-06..04-17 with the symbol dropped (every month merged, as in the ticks),
compared with the archive's front-month bars. It needs, per root, an exact
open/high/low/close on at least 99.9% of minutes and volume within 1% on at
least 99.9%. Below that the run stops and writes no bars. The gate buckets the
trades by ts_recv, the archive bars' own clock, with ties in file order, so it
tests the cluster rule alone (team-lead ruling, 2026-11-06). The ts_event rows
are written next to it to record the clock effect. By ts_event, the rule scores
about 99.85% (ES) and 99.69% (NQ).

DATABASE_URL comes from --env-file, else this checkout's .env.local, else the
main checkout's. It is never printed.
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import time
import warnings
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# `anchor_backfill_extract` lives beside this file; -I doesn't put it on the path.
_SRC_DIR = str(Path(__file__).resolve().parent)
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

from anchor_backfill_extract import parse_env_file, resolve_env_file  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "ml" / "data" / "futures-contract-repair"


@dataclass(frozen=True)
class Root:
    symbol: str  # the root as futures_bars stores it
    front: str  # the front-month contract for the whole window
    gap: float  # G: a larger gap between adjacent prices splits contracts
    carry: float  # the next contract's premium; half of it marks front_absent
    tick: float = 0.25


ROOTS: dict[str, Root] = {
    "ES": Root("ES", "ESM6", 25.0, 60.0),
    "NQ": Root("NQ", "NQM6", 87.5, 280.0),
}

# [start, end) in UTC; each end is one minute past the last bar-open minute.
ARCHIVE_SPAN = (
    pd.Timestamp("2026-04-05 22:00", tz="UTC"),
    pd.Timestamp("2026-04-17 21:00", tz="UTC"),
)
TICK_SPAN = (
    pd.Timestamp("2026-04-20 01:56", tz="UTC"),
    pd.Timestamp("2026-06-15 14:12", tz="UTC"),
)
GROUND_TRUTH_SPAN = (
    pd.Timestamp("2026-04-06 00:00", tz="UTC"),
    pd.Timestamp("2026-04-18 00:00", tz="UTC"),
)

GATE_RATE = 0.999
VOLUME_TOLERANCE = 0.01
NEIGHBOURS = 5  # per side
NEIGHBOUR_WINDOW_MINUTES = 30
# The archive clock the gate scores; the other one is written for the record.
GATE_CLOCK = "ts_recv"
ARCHIVE_CLOCKS = ("ts_recv", "ts_event")

OUTPUT_COLUMNS = (
    "symbol",
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "n_clusters",
    "source",
)
MINUTE_COLUMNS = (
    "ts",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "level",
    "clusters",
    "prints",
    "kept_gap",
    "split_gap",
)
# Outright month codes; spreads ("ESM6-ESU6") and options ("ESM6 C6475") don't match.
_OUTRIGHT = "^{root}[FGHJKMNQUVXZ][0-9]{{1,2}}$"
_EPOCH = pd.Timestamp("1970-01-01", tz="UTC")


class FrontMonthMismatch(ValueError):
    """The archive's volume leader for a day isn't the expected front month."""


# ── Pure helpers ────────────────────────────────────────────────────────────


def round_to_tick(values: pd.Series, tick: float) -> pd.Series:
    """Prices on the instrument tick (Phase 2 compares them with NUMERIC(12,4))."""
    return (values / tick).round() * tick


def build_minutes(ticks: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """One row per minute with prints: the lowest cluster's bar and its counts.

    `ticks` has ts (tz-aware UTC), seq (the tie-break order), price and size,
    for one root. The result has MINUTE_COLUMNS; `level` is the median kept
    price, `clusters` the minute's cluster count and `prints` every print in it.
    `kept_gap` (the widest step between adjacent kept prices) and `split_gap`
    (the step to the next cluster) show how far each side sat from G.
    """
    if ticks.empty:
        return pd.DataFrame({c: [] for c in MINUTE_COLUMNS})
    t = pd.DataFrame(
        {
            "minute": ticks["ts"].dt.floor("min"),
            "ts": ticks["ts"],
            "seq": ticks["seq"],
            "price": round_to_tick(ticks["price"].astype("float64"), cfg.tick),
            "size": ticks["size"].astype("int64"),
        }
    ).sort_values(["minute", "price"], kind="stable", ignore_index=True)

    minute = t["minute"].dt.tz_localize(None).to_numpy()
    price = t["price"].to_numpy()
    starts = np.r_[True, minute[1:] != minute[:-1]]
    # The step up from the next-lower print in the same minute (NaN for the lowest).
    step = np.where(starts, np.nan, np.r_[np.nan, np.diff(price)])
    new_cluster = starts | (step > cfg.gap)
    cluster = np.cumsum(new_cluster)
    # 0 for the lowest cluster of each minute, 1 for the next, ...
    t["rank"] = cluster - np.maximum.accumulate(np.where(starts, cluster, 0))
    t["step"] = step

    per_minute = t.groupby("minute", sort=True)
    kept = t[t["rank"] == 0].sort_values(["ts", "seq"], kind="stable")
    out = kept.groupby("minute", sort=True).agg(
        open=("price", "first"),
        high=("price", "max"),
        low=("price", "min"),
        close=("price", "last"),
        volume=("size", "sum"),
        level=("price", "median"),
        kept_gap=("step", "max"),
    )
    out["clusters"] = per_minute["rank"].max() + 1
    out["prints"] = per_minute.size()
    # The step that opened the second cluster: G's margin on the split side.
    second = t[(t["rank"] == 1) & new_cluster]
    out["split_gap"] = second.set_index("minute")["step"]
    return out.rename_axis("ts").reset_index()[list(MINUTE_COLUMNS)]


def mark_front_absent(minutes: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """Add `ref` (the neighbours' median level) and `front_absent`.

    A minute is front_absent when its level sits more than half a carry above
    `ref`: the only contract that printed was a back month. See the module
    docstring.
    """
    out = minutes.sort_values("ts", ignore_index=True)
    n = len(out)
    if n == 0:
        return out.assign(ref=pd.Series(dtype="float64"), front_absent=False)
    level = out["level"].to_numpy(dtype="float64")
    minute_no = ((out["ts"] - _EPOCH) // pd.Timedelta(minutes=1)).to_numpy()
    rows = np.arange(n)
    columns = []
    for step in range(1, NEIGHBOURS + 1):
        for other in (rows - step, rows + step):
            inside = (other >= 0) & (other < n)
            other = np.clip(other, 0, n - 1)
            near = inside & (
                np.abs(minute_no[other] - minute_no) <= NEIGHBOUR_WINDOW_MINUTES
            )
            columns.append(np.where(near, level[other], np.nan))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN rows: no ref
        ref = np.nanmedian(np.column_stack(columns), axis=1)
    return out.assign(ref=ref, front_absent=(level - ref) > cfg.carry / 2)


def rebuild_from_ticks(ticks: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """build_minutes then mark_front_absent, for one root's prints."""
    return mark_front_absent(build_minutes(ticks, cfg), cfg)


def bars_output(minutes: pd.DataFrame, symbol: str, source: str) -> pd.DataFrame:
    """The rebuilt_bars.parquet rows: every minute that has a front-month bar.

    n_clusters is how many contracts the minute's prints held (1 on the
    archive): Phase 2 rewrites only mixed minutes, or rows far off the rebuild,
    so a clean minute keeps Databento's own ts_recv-built bar.
    """
    kept = minutes[~minutes["front_absent"].astype(bool)]
    out = pd.DataFrame(
        {
            "symbol": symbol,
            "ts": kept["ts"].astype("datetime64[us, UTC]"),
            "open": kept["open"].astype("float64"),
            "high": kept["high"].astype("float64"),
            "low": kept["low"].astype("float64"),
            "close": kept["close"].astype("float64"),
            "volume": kept["volume"].astype("int64"),
            "n_clusters": kept["clusters"].astype("int64"),
            "source": source,
        }
    )
    return out[list(OUTPUT_COLUMNS)].reset_index(drop=True)


def per_day_summary(minutes: pd.DataFrame, symbol: str, source: str) -> pd.DataFrame:
    """Per UTC day: bars built, front_absent, multi-cluster minutes, prints.

    Archive minutes are one contract each and carry no print counts, so their
    prints column stays empty.
    """
    absent = minutes["front_absent"].astype(bool)
    frame = pd.DataFrame(
        {
            "day": minutes["ts"].dt.strftime("%Y-%m-%d"),
            "bars": (~absent).astype("int64"),
            "front_absent": absent.astype("int64"),
            "multi_cluster": (minutes["clusters"] > 1).astype("int64"),
            "prints": minutes["prints"].astype("Int64"),
            "max_range": (minutes["high"] - minutes["low"]).where(~absent),
            "ts": minutes["ts"],
        }
    )
    grouped = frame.groupby("day", sort=True)
    out = pd.DataFrame(
        {
            "bars": grouped["bars"].sum(),
            "front_absent": grouped["front_absent"].sum(),
            "multi_cluster": grouped["multi_cluster"].sum(),
            "prints": grouped["prints"].sum(min_count=1),
            "max_range": grouped["max_range"].max(),
            "first_minute": grouped["ts"].min(),
            "last_minute": grouped["ts"].max(),
        }
    ).join(_gap_stats(minutes), how="left")
    out = out.rename_axis("day").reset_index()
    out.insert(0, "root", symbol)
    out.insert(2, "source", source)
    return out


def _gap_stats(minutes: pd.DataFrame) -> pd.DataFrame:
    """Per UTC day over the bars built: the widest kept step, the narrowest split."""
    kept = minutes[~minutes["front_absent"].astype(bool)]
    day = kept["ts"].dt.strftime("%Y-%m-%d").rename("day")
    return pd.DataFrame(
        {
            "max_kept_gap": kept["kept_gap"].groupby(day).max(),
            "min_split_gap": kept["split_gap"].groupby(day).min(),
        }
    )


def _outright(symbols: pd.Series, cfg: Root) -> pd.Series:
    return symbols.str.fullmatch(_OUTRIGHT.format(root=cfg.symbol)).astype(bool)


def pick_front_by_day(bars: pd.DataFrame, cfg: Root) -> dict[str, str]:
    """Each UTC day's volume leader among the root's outrights.

    Raises FrontMonthMismatch when a leader isn't `cfg.front`, or when there are
    no outright bars at all: either means the archive isn't what the spec read.
    """
    outright = bars[_outright(bars["symbol"], cfg)]
    if outright.empty:
        raise FrontMonthMismatch(f"no {cfg.symbol} outright bars in the archive span")
    volume = outright.groupby(
        [outright["ts"].dt.strftime("%Y-%m-%d").rename("day"), "symbol"]
    )["volume"].sum()
    leaders = volume.groupby(level="day").idxmax().map(lambda key: key[1]).to_dict()
    wrong = {day: sym for day, sym in leaders.items() if sym != cfg.front}
    if wrong:
        listed = "; ".join(
            f"{day}: the {cfg.symbol} volume leader is {sym}, not the expected "
            f"{cfg.front}"
            for day, sym in sorted(wrong.items())
        )
        raise FrontMonthMismatch(listed)
    return leaders


def archive_front_bars(bars: pd.DataFrame, cfg: Root) -> pd.DataFrame:
    """The leader's bars (ts, OHLC on the tick, volume), checked per day."""
    pick_front_by_day(bars, cfg)
    front = bars[bars["symbol"] == cfg.front].sort_values("ts", ignore_index=True)
    out = pd.DataFrame({"ts": front["ts"]})
    for col in ("open", "high", "low", "close"):
        out[col] = round_to_tick(front[col].astype("float64"), cfg.tick)
    out["volume"] = front["volume"].astype("int64")
    return out


def archive_minutes(front: pd.DataFrame) -> pd.DataFrame:
    """Archive bars in the minutes shape: one contract each, no print counts."""
    return front.assign(
        level=np.nan,
        clusters=1,
        prints=pd.array([pd.NA] * len(front), dtype="Int64"),
        kept_gap=np.nan,
        split_gap=np.nan,
        ref=np.nan,
        front_absent=False,
    )


def compare_with_archive(
    rebuilt: pd.DataFrame, archive: pd.DataFrame, root: str
) -> pd.DataFrame:
    """Per UTC day, rebuilt bars vs the archive's front-month bars.

    `minutes` is the union of both sides' minutes, so a missing or extra bar
    counts against the match rates. front_absent minutes are not bars.
    """
    cols = ["ts", "open", "high", "low", "close", "volume"]
    bars = rebuilt.loc[~rebuilt["front_absent"].astype(bool), cols]
    bars = bars.assign(ts=bars["ts"].astype("datetime64[us, UTC]"))
    archive = archive[cols].assign(ts=archive["ts"].astype("datetime64[us, UTC]"))
    merged = bars.merge(
        archive,
        on="ts",
        how="outer",
        suffixes=("_r", "_a"),
        indicator=True,
        validate="1:1",
    )
    both = merged["_merge"] == "both"
    exact = both.copy()
    for col in ("open", "high", "low", "close"):
        exact &= merged[f"{col}_r"] == merged[f"{col}_a"]
    within = both & (
        (merged["volume_r"] - merged["volume_a"]).abs()
        <= VOLUME_TOLERANCE * merged["volume_a"]
    )
    frame = pd.DataFrame(
        {
            "day": merged["ts"].dt.strftime("%Y-%m-%d"),
            "minutes": 1,
            "exact_ohlc": exact.astype("int64"),
            "volume_within_1pct": within.astype("int64"),
            "rebuilt_only": (merged["_merge"] == "left_only").astype("int64"),
            "archive_only": (merged["_merge"] == "right_only").astype("int64"),
        }
    )
    out = frame.groupby("day", sort=True).sum()
    extras = pd.DataFrame(
        {
            "day": rebuilt["ts"].dt.strftime("%Y-%m-%d"),
            "front_absent": rebuilt["front_absent"].astype("int64"),
            "multi_cluster": (rebuilt["clusters"] > 1).astype("int64"),
        }
    )
    out = out.join(extras.groupby("day").sum(), how="left").fillna(0)
    out = out.astype("int64").join(_gap_stats(rebuilt), how="left").reset_index()
    out.insert(0, "root", root)
    return out


def gate_result(gt: pd.DataFrame) -> dict[str, dict]:
    """Per root: the match rates over all its minutes, and whether it passed."""
    result = {}
    for root, rows in gt.groupby("root", sort=True):
        minutes = int(rows["minutes"].sum())
        exact = int(rows["exact_ohlc"].sum())
        volume = int(rows["volume_within_1pct"].sum())
        # A root with no minutes rates 0 and fails.
        exact_rate = exact / minutes if minutes else 0.0
        volume_rate = volume / minutes if minutes else 0.0
        result[root] = {
            "minutes": minutes,
            "exact_ohlc": exact,
            "volume_within_1pct": volume,
            "exact_rate": exact_rate,
            "volume_rate": volume_rate,
            "passed": exact_rate >= GATE_RATE and volume_rate >= GATE_RATE,
        }
    return result


def tick_pages(
    start: pd.Timestamp, end: pd.Timestamp
) -> list[tuple[pd.Timestamp, pd.Timestamp]]:
    """[start, end) split into UTC days, the unit the tick reads page by."""
    pages = []
    lo = start
    while lo < end:
        hi = min(lo.floor("D") + pd.Timedelta(days=1), end)
        pages.append((lo, hi))
        lo = hi
    return pages


# ── Archive (local Parquet via DuckDB) ──────────────────────────────────────


def _duckdb():
    import duckdb

    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    return con


def read_archive_bars(
    archive: Path, cfg: Root, span: tuple[pd.Timestamp, pd.Timestamp]
) -> pd.DataFrame:
    """Every `ohlcv_1m` row for the root's symbols in [span) (ts, symbol, OHLCV)."""
    path = (archive / "ohlcv_1m" / "year=2026" / "part.parquet").as_posix()
    con = _duckdb()
    try:
        frame = con.execute(
            """SELECT ts_event AS ts, symbol, open, high, low, close, volume
               FROM read_parquet(?)
               WHERE ts_event >= ? AND ts_event < ? AND starts_with(symbol, ?)""",
            [path, span[0].to_pydatetime(), span[1].to_pydatetime(), cfg.symbol],
        ).df()
    finally:
        con.close()
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)
    return frame


def read_archive_trades(
    archive: Path,
    cfg: Root,
    span: tuple[pd.Timestamp, pd.Timestamp],
    clock: str = GATE_CLOCK,
) -> pd.DataFrame:
    """The root's outright TBBO trades in [span), symbol dropped (ts, seq, price, size).

    `clock` picks the timestamp that places a trade in its minute: ts_recv, as
    Databento built the archive bars, or ts_event, as the ticks carry it.
    seq is the file row number: the file is in order of both clocks, and
    DuckDB's microsecond timestamps tie where Databento's nanoseconds didn't.
    """
    if clock not in ARCHIVE_CLOCKS:
        raise ValueError(f"unknown clock {clock!r}; want one of {ARCHIVE_CLOCKS}")
    path = (archive / "tbbo" / "year=2026" / "part.parquet").as_posix()
    con = _duckdb()
    try:
        # `clock` is one of two column names, checked above.
        frame = con.execute(
            f"""SELECT {clock} AS ts, file_row_number AS seq, price, size
               FROM read_parquet(?, file_row_number = true)
               WHERE {clock} >= ? AND {clock} < ? AND regexp_full_match(symbol, ?)""",
            [
                path,
                span[0].to_pydatetime(),
                span[1].to_pydatetime(),
                _OUTRIGHT.format(root=cfg.symbol),
            ],
        ).df()
    finally:
        con.close()
    frame["ts"] = pd.to_datetime(frame["ts"], utc=True)
    return frame


# ── Postgres (read-only) ────────────────────────────────────────────────────

# 5 minutes per statement: a full ES day is up to ~2M rows over COPY.
_STATEMENT_TIMEOUT_MS = 300_000
_PAGE_ATTEMPTS = 3
# COPY takes no bind parameters, so the SELECT is mogrified first.
_SELECT_TICKS = (
    "SELECT id, (extract(epoch FROM ts) * 1000000)::bigint, price::float8, size "
    "FROM futures_trade_ticks WHERE symbol = %s AND ts >= %s AND ts < %s "
    "ORDER BY ts, id"
)


def connect_readonly(env_file: Path):
    """A connection holding one open read-only transaction with a statement timeout.

    Use it for one read, then close it (which rolls back). Neon's pooler runs
    in transaction mode, so a session-level SET may land on another server
    connection, and it refuses statement_timeout as a startup option.
    Everything therefore lives in one transaction: the session default
    (startup option), psycopg2's BEGIN READ ONLY, SET LOCAL statement_timeout,
    and a check that the transaction really is read-only. Never prints the URL.
    """
    import psycopg2

    url = parse_env_file(env_file).get("DATABASE_URL")
    if not url:
        raise RuntimeError(f"no DATABASE_URL in {env_file}")
    con = psycopg2.connect(url, options="-c default_transaction_read_only=on")
    con.set_session(readonly=True, autocommit=False)
    with con.cursor() as cur:
        cur.execute("SET default_transaction_read_only = on")
        cur.execute(f"SET LOCAL statement_timeout = {_STATEMENT_TIMEOUT_MS}")
        cur.execute("SHOW transaction_read_only")
        if cur.fetchone()[0] != "on":
            con.close()
            raise RuntimeError("the transaction is not read-only; not reading")
    return con


def fetch_tick_page(
    env_file: Path, cfg: Root, lo: pd.Timestamp, hi: pd.Timestamp
) -> pd.DataFrame:
    """The root's ticks in [lo, hi) as (ts, seq, price, size); seq is the row id."""
    import psycopg2

    params = (cfg.symbol, lo.to_pydatetime(), hi.to_pydatetime())
    for attempt in range(1, _PAGE_ATTEMPTS + 1):
        try:
            con = connect_readonly(env_file)
            try:
                buf = io.StringIO()
                with con.cursor() as cur:
                    select = cur.mogrify(_SELECT_TICKS, params).decode()
                    cur.copy_expert(f"COPY ({select}) TO STDOUT WITH (FORMAT csv)", buf)
            finally:
                con.close()
            break
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            if attempt == _PAGE_ATTEMPTS:
                raise
            time.sleep(2 * attempt)
    buf.seek(0)
    frame = pd.read_csv(
        buf,
        names=["seq", "us", "price", "size"],
        dtype={"seq": "int64", "us": "int64", "price": "float64", "size": "int64"},
    )
    frame.insert(0, "ts", pd.to_datetime(frame.pop("us"), unit="us", utc=True))
    return frame


# ── Run ─────────────────────────────────────────────────────────────────────


def _log(message: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {message}", flush=True)


def run_ground_truth(archive: Path) -> pd.DataFrame:
    """The per-day table for both roots under both archive clocks.

    The gate scores the GATE_CLOCK rows; the others record the clock effect.
    """
    tables = []
    for cfg in ROOTS.values():
        front = archive_front_bars(
            read_archive_bars(archive, cfg, GROUND_TRUTH_SPAN), cfg
        )
        for clock in ARCHIVE_CLOCKS:
            trades = read_archive_trades(archive, cfg, GROUND_TRUTH_SPAN, clock)
            rebuilt = rebuild_from_ticks(trades, cfg)
            table = compare_with_archive(rebuilt, front, cfg.symbol)
            table.insert(2, "clock", clock)
            tables.append(table)
            _log(
                f"ground truth {cfg.symbol} by {clock}: {len(trades):,} trades, "
                f"{len(front):,} bars"
            )
    return pd.concat(tables, ignore_index=True)


def run_archive_span(archive: Path, cfg: Root) -> pd.DataFrame:
    front = archive_front_bars(read_archive_bars(archive, cfg, ARCHIVE_SPAN), cfg)
    return archive_minutes(front)


def run_tick_span(env_file: Path, cfg: Root, workers: int) -> pd.DataFrame:
    """Every tick page of the root, built per page, then checked as one series."""
    pages = tick_pages(*TICK_SPAN)

    def one(page: tuple[pd.Timestamp, pd.Timestamp]) -> pd.DataFrame:
        started = time.monotonic()
        try:
            ticks = fetch_tick_page(env_file, cfg, *page)
        except Exception as err:
            raise RuntimeError(f"{cfg.symbol} page {page[0]:%Y-%m-%d} failed") from err
        minutes = build_minutes(ticks, cfg)
        _log(
            f"{cfg.symbol} {page[0]:%Y-%m-%d}: {len(ticks):,} ticks, "
            f"{len(minutes):,} minutes, {time.monotonic() - started:.1f}s"
        )
        return minutes

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        parts = [p for p in pool.map(one, pages) if not p.empty]
    if not parts:
        raise RuntimeError(f"no {cfg.symbol} ticks in the tick span")
    return mark_front_absent(pd.concat(parts, ignore_index=True), cfg)


def _write_atomic(path: Path, write: Callable[[Path], None]) -> None:
    tmp = path.with_name(path.name + ".tmp")
    write(tmp)
    os.replace(tmp, path)


def _write_csv(path: Path, frame: pd.DataFrame) -> None:
    _write_atomic(path, lambda p: frame.to_csv(p, index=False, lineterminator="\n"))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--archive", type=Path, required=True, help="the archive dir (ml/data/archive)"
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--env-file", help="path to .env.local")
    parser.add_argument("--workers", type=int, default=3, help="parallel tick pages")
    parser.add_argument(
        "--ground-truth-only", action="store_true", help="stop after the gate"
    )
    args = parser.parse_args(argv)
    started = time.monotonic()

    env_file = None
    if not args.ground_truth_only:
        env_file = resolve_env_file(args.env_file)
        if env_file is None:
            print("no .env.local found; pass --env-file", file=sys.stderr)
            return 2
    args.out_dir.mkdir(parents=True, exist_ok=True)

    gt = run_ground_truth(args.archive)
    _write_csv(args.out_dir / "ground_truth.csv", gt)
    for clock in ARCHIVE_CLOCKS:
        scored = "gate" if clock == GATE_CLOCK else "record"
        for root, res in gate_result(gt[gt["clock"] == clock]).items():
            verdict = "PASS" if res["passed"] else "FAIL"
            _log(
                f"{scored} {root} by {clock}: {res['exact_ohlc']:,}/"
                f"{res['minutes']:,} exact OHLC ({res['exact_rate']:.4%}), "
                f"{res['volume_within_1pct']:,} volume within 1% "
                f"({res['volume_rate']:.4%}) -> {verdict}"
            )
    gate = gate_result(gt[gt["clock"] == GATE_CLOCK])
    if not all(res["passed"] for res in gate.values()) or set(gate) != set(ROOTS):
        print("ground-truth gate failed; no bars written", file=sys.stderr)
        return 1
    if args.ground_truth_only:
        return 0

    bars, summaries, absent = [], [], []
    for cfg in ROOTS.values():
        archived = run_archive_span(args.archive, cfg)
        ticked = run_tick_span(env_file, cfg, args.workers)
        for minutes, source in ((archived, "archive"), (ticked, "ticks")):
            bars.append(bars_output(minutes, cfg.symbol, source))
            summaries.append(per_day_summary(minutes, cfg.symbol, source))
        flagged = ticked[ticked["front_absent"]]
        absent.append(pd.DataFrame({"symbol": cfg.symbol, "ts": flagged["ts"]}))
        _log(
            f"{cfg.symbol}: {len(archived):,} archive bars, "
            f"{int((~ticked['front_absent']).sum()):,} tick bars, "
            f"{len(flagged):,} front_absent"
        )

    out = pd.concat(bars, ignore_index=True).sort_values(
        ["symbol", "ts"], ignore_index=True
    )
    if out.duplicated(["symbol", "ts"]).any():
        raise RuntimeError("duplicate (symbol, ts) rows in the rebuild")
    _write_atomic(
        args.out_dir / "rebuilt_bars.parquet",
        lambda p: out.to_parquet(p, index=False),
    )
    _write_csv(args.out_dir / "per_day.csv", pd.concat(summaries, ignore_index=True))
    _write_csv(args.out_dir / "front_absent.csv", pd.concat(absent, ignore_index=True))
    _log(
        f"wrote {len(out):,} bars to {args.out_dir} in "
        f"{time.monotonic() - started:.0f}s"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
