"""Step 1 of the anchor-column history backfill: extract from the UW Full Tape.

For each landed tape day, read the lottery_finder_fires and silent_boom_alerts
rows that still lack an anchor (read-only, Neon), pick each row's anchor print
and its same-millisecond multi-leg siblings out of that day's tape in R2, and
write one NDJSON file per date. Step 2 (scripts/backfill-anchor-legs.ts) feeds
those lines to the production `describeAnchor` and writes the columns.

The selection is a translation of the two queries in `lookupAnchorLegs`
(api/_lib/anchor-legs.ts), run against the tape instead of ws_option_trades:

  * executed_at is truncated to the millisecond before any comparison (the
    live table stores milliseconds; the tape has microseconds).
  * Anchor: same option chain AND ticker, inside the window [start, end),
    canceled = false, price > 0. Highest notional first, then earliest
    millisecond, then earliest microsecond, then id. Notional is the exact
    integer round(price * 10000) * size: a DOUBLE product could flip a tie
    that the live NUMERIC product would not.
  * Siblings, for an anchor whose trade code is a multi-leg code only: same
    ticker, same millisecond, canceled = false, multi-leg code, no price
    filter (a zero-priced wing is still a leg). The anchor may be included.

Design: docs/superpowers/specs/2026-10-28-classifier-replacement-design.md
("History backfill from the full tape").

Usage (from the repo root):

    ml/.venv/Scripts/python ml/src/anchor_backfill_extract.py \\
        --dates 2026-10-27 2026-10-28
    ml/.venv/Scripts/python ml/src/anchor_backfill_extract.py \\
        --from 2026-01-02 --to 2026-10-28 --workers 4

Secrets come from .env.local (DATABASE_URL, R2_*). A worktree has none, so the
file is resolved from --env-file, then the repo's own .env.local, then the
main checkout's. Values are never printed. The extract refuses to connect when
the DATABASE_URL it would use (a repo-root .env overrides the environment in
utils.load_env) differs from the one in that file, which the apply step loads.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Iterable
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pandas as pd

# Mirrors MULTI_LEG_TRADE_CODES in api/_lib/multileg-codes.ts. A pytest drift
# guard (test_anchor_backfill_extract.py) fails when the two differ.
MULTI_LEG_TRADE_CODES: tuple[str, ...] = (
    "mlat",
    "mlet",
    "mlft",
    "masl",
    "mesl",
    "mfsl",
    "mlct",
    "cbmo",
    "mctp",
)

LOTTERY_TABLE = "lottery_finder_fires"
SILENT_BOOM_TABLE = "silent_boom_alerts"

# Window arithmetic, the same windows the crons build (detect-lottery-fires.ts
# ~L806: trigger ± 30 s; detect-silent-boom.ts ~L948: bucket + 5 min).
LOTTERY_HALF_WINDOW = timedelta(seconds=30)
SILENT_BOOM_WINDOW = timedelta(minutes=5)

# `utils.r2` lives beside this file; -I and spawned workers don't put it on the path.
_SRC_DIR = str(Path(__file__).resolve().parent)
if _SRC_DIR not in sys.path:
    sys.path.insert(0, _SRC_DIR)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = REPO_ROOT / "docs" / "tmp" / "anchor-backfill" / "out"

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_LANDED_KEY_RE = re.compile(r"^fulltape/(\d{4}-\d{2}-\d{2})-fulltape\.parquet$")
_TICKER_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_SELECT_LOTTERY = (
    "SELECT id, underlying_symbol, option_chain_id, trigger_time_ct "
    "FROM lottery_finder_fires "
    "WHERE date = %s AND anchor_ws_trade_id IS NULL AND anchor_leg_kind IS NULL "
    "ORDER BY id"
)
_SELECT_SILENT_BOOM = (
    "SELECT id, underlying_symbol, option_chain_id, bucket_ct "
    "FROM silent_boom_alerts "
    "WHERE date = %s AND anchor_ws_trade_id IS NULL AND anchor_leg_kind IS NULL "
    "ORDER BY id"
)


# ── Pure helpers ────────────────────────────────────────────────────────────


def landed_dates(keys: Iterable[str]) -> list[str]:
    """Dates of the landed-day keys, ascending.

    Only `fulltape/YYYY-MM-DD-fulltape.parquet` counts. `_superseded/` and
    `_unavailable/` objects, and anything else under the prefix, do not.
    """
    found = set()
    for key in keys:
        match = _LANDED_KEY_RE.match(key)
        if match:
            found.add(match.group(1))
    return sorted(found)


def _epoch_us(moment: datetime) -> int:
    """Integer microseconds since the epoch (no float rounding)."""
    if moment.tzinfo is None:
        raise ValueError(f"naive datetime {moment!r}: Neon timestamps are tz-aware")
    return (moment - _EPOCH) // timedelta(microseconds=1)


def _ceil_ms(micros: int) -> int:
    return -((-micros) // 1000)


def window_ms(start: datetime, end: datetime) -> tuple[int, int]:
    """[start, end) as millisecond bounds over ms-truncated executed_at.

    The live table holds executed_at truncated to the millisecond, so
    `stored >= start` is `ms >= ceil(start_ms)` and `stored < end` is
    `ms < ceil(end_ms)` when the bounds carry sub-millisecond precision.
    """
    return _ceil_ms(_epoch_us(start)), _ceil_ms(_epoch_us(end))


def iso_ms(epoch_ms: int) -> str:
    """ISO 8601 with millisecond precision and a Z, as the TS TapePrint wants."""
    moment = _EPOCH + timedelta(milliseconds=epoch_ms)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{epoch_ms % 1000:03d}Z"


def is_multi_leg(code: str | None) -> bool:
    return code is not None and code.lower() in MULTI_LEG_TRADE_CODES


def build_requests(
    lottery_rows: Iterable[tuple], silent_boom_rows: Iterable[tuple]
) -> pd.DataFrame:
    """One request row per alert: (req_idx, tbl, row_id, ticker, chain, bounds)."""
    records = []
    for row_id, ticker, chain, trigger in lottery_rows:
        start, end = window_ms(
            trigger - LOTTERY_HALF_WINDOW, trigger + LOTTERY_HALF_WINDOW
        )
        records.append((LOTTERY_TABLE, int(row_id), ticker, chain, start, end))
    for row_id, ticker, chain, bucket in silent_boom_rows:
        start, end = window_ms(bucket, bucket + SILENT_BOOM_WINDOW)
        records.append((SILENT_BOOM_TABLE, int(row_id), ticker, chain, start, end))
    frame = pd.DataFrame(
        records,
        columns=["tbl", "row_id", "ticker", "chain", "start_ms", "end_ms"],
    )
    frame.insert(0, "req_idx", range(len(frame)))
    return frame.astype({"start_ms": "int64", "end_ms": "int64", "row_id": "int64"})


def _sql_str_list(values: Iterable[str]) -> str:
    """A SQL string-literal list for values already validated as safe."""
    return ", ".join("'" + v.replace("'", "''") + "'" for v in values)


# ── Selection (DuckDB over one day's tape) ──────────────────────────────────

_PRINT_COLS = """
    id, underlying_symbol AS ticker, option_chain_id AS chain,
    CASE option_type WHEN 'call' THEN 'C' WHEN 'put' THEN 'P' ELSE option_type END
      AS option_type,
    strike, CAST(expiry AS VARCHAR) AS expiry,
    epoch_us(executed_at) AS us, epoch_us(executed_at) // 1000 AS ms,
    price, size, nullif(upstream_condition_detail, '') AS code
"""


def _print(row: tuple) -> dict:
    """A tape row (id, chain, type, strike, expiry, ms, price, size, code) as
    the TS `TapePrint`."""
    ws_id, chain, option_type, strike, expiry, ms, price, size, code = row
    return {
        "wsTradeId": ws_id,
        "optionChain": chain,
        "optionType": option_type,
        "strike": float(strike),
        "expiry": expiry,
        "executedAt": iso_ms(int(ms)),
        "price": float(price),
        "size": int(size),
        "tradeCode": code,
    }


def select_anchors(con, tape_path: str, requests: pd.DataFrame) -> list[dict]:
    """The NDJSON records (one per request) for one day's tape.

    `con` is a DuckDB connection, `tape_path` a local or s3:// parquet path.
    """
    if requests.empty:
        return []
    tickers = sorted(set(requests["ticker"]))
    bad = [t for t in tickers if not _TICKER_RE.match(t)]
    if bad:
        raise ValueError(f"unexpected ticker characters: {bad[:3]}")
    ticker_list = _sql_str_list(tickers)

    con.register("req", requests[["req_idx", "ticker", "chain", "start_ms", "end_ms"]])
    # Only the columns the selection needs, and a ticker filter DuckDB can
    # push into the parquet scan to skip row groups.
    anchor_rows = con.execute(
        f"""
        WITH tape AS (
          SELECT {_PRINT_COLS}
          FROM read_parquet(?)
          WHERE underlying_symbol IN ({ticker_list}) AND canceled = false AND price > 0
        )
        SELECT r.req_idx, t.id, t.chain, t.option_type, t.strike, t.expiry, t.ms,
               t.price, t.size, t.code
        FROM req r
        JOIN tape t ON t.chain = r.chain AND t.ticker = r.ticker
                   AND t.ms >= r.start_ms AND t.ms < r.end_ms
        QUALIFY row_number() OVER (
          PARTITION BY r.req_idx
          ORDER BY (round(t.price * 10000)::BIGINT) * t.size::BIGINT DESC,
                   t.ms ASC, t.us ASC, t.id ASC
        ) = 1
        """,
        [tape_path],
    ).fetchall()

    anchors: dict[int, dict] = {}
    for req_idx, *rest in anchor_rows:
        anchors[int(req_idx)] = _print(tuple(rest))

    # Distinct (ticker, ms) pairs of multi-leg anchors, like the live query.
    ticker_of = dict(zip(requests["req_idx"], requests["ticker"], strict=True))
    pairs = sorted(
        {
            (ticker_of[i], _anchor_ms(a))
            for i, a in anchors.items()
            if is_multi_leg(a["tradeCode"])
        }
    )
    siblings_by_pair: dict[tuple[str, int], list[dict]] = {}
    if pairs:
        pair_frame = pd.DataFrame(pairs, columns=["ticker", "ms"]).astype(
            {"ms": "int64"}
        )
        con.register("pairs", pair_frame)
        codes = _sql_str_list(MULTI_LEG_TRADE_CODES)
        sibling_rows = con.execute(
            f"""
            WITH tape AS (
              SELECT {_PRINT_COLS}
              FROM read_parquet(?)
              WHERE underlying_symbol IN ({ticker_list}) AND canceled = false
                AND lower(upstream_condition_detail) IN ({codes})
            )
            SELECT p.ticker, p.ms, t.id, t.chain, t.option_type, t.strike, t.expiry,
                   t.ms, t.price, t.size, t.code
            FROM pairs p
            JOIN tape t ON t.ticker = p.ticker AND t.ms = p.ms
            ORDER BY p.ticker, p.ms, t.us, t.id
            """,
            [tape_path],
        ).fetchall()
        for ticker, ms, *rest in sibling_rows:
            siblings_by_pair.setdefault((ticker, int(ms)), []).append(
                _print(tuple(rest))
            )

    records = []
    for row in requests.itertuples(index=False):
        anchor = anchors.get(int(row.req_idx))
        siblings = []
        if anchor is not None and is_multi_leg(anchor["tradeCode"]):
            siblings = siblings_by_pair.get((row.ticker, _anchor_ms(anchor)), [])
        records.append(
            {
                "table": row.tbl,
                "id": int(row.row_id),
                "anchor": anchor,
                "siblings": siblings,
            }
        )
    return records


def _anchor_ms(print_: dict) -> int:
    """Epoch ms back out of a TapePrint's ISO string (exact: ms precision)."""
    stamp = datetime.strptime(print_["executedAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    return _epoch_us(stamp.replace(tzinfo=UTC)) // 1000


def write_ndjson_atomic(path: Path, records: Iterable[dict]) -> None:
    """Write via a tmp file and a rename, LF line endings on every platform."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="") as handle:
        for record in records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")
    os.replace(tmp, path)


# ── Environment, Neon, R2 ───────────────────────────────────────────────────


def parse_env_file(path: Path) -> dict[str, str]:
    """KEY=VALUE pairs of an env file, the first occurrence of a key winning.

    Quotes and a trailing ' #' comment are stripped from each value.
    """
    pairs: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        comment_idx = val.find(" #")
        if comment_idx >= 0:
            val = val[:comment_idx].rstrip()
        if key:
            pairs.setdefault(key, val)
    return pairs


def load_env_local(path: Path) -> None:
    """Load KEY=VALUE pairs into os.environ without overwriting, never printing."""
    for key, val in parse_env_file(path).items():
        if key not in os.environ:
            os.environ[key] = val


def resolve_env_file(cli_path: str | None) -> Path | None:
    """--env-file, then this checkout's .env.local, then the main checkout's."""
    candidates: list[Path] = []
    if cli_path:
        candidates.append(Path(cli_path))
    candidates.append(REPO_ROOT / ".env.local")
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        candidates.append(Path(common).parent / ".env.local")
    except (OSError, subprocess.CalledProcessError):
        pass
    return next((p for p in candidates if p.is_file()), None)


def connect_neon(env_file: Path):
    """A read-only connection via utils.get_connection (Neon connect retries).

    Refuses to connect when the DATABASE_URL the connection would use differs
    from the one in `env_file`, the file the apply step loads. utils.load_env
    lets a repo-root .env override the environment, so the two can disagree and
    the extract would read one database while the apply step writes another.
    Neither URL is ever printed or put in the message.

    get_connection exits the process when DATABASE_URL is missing or its
    retries run out (it prints why first); a worker must raise instead, so the
    failed date is named by the caller.
    """
    from utils import ML_ROOT, get_connection, load_env

    used = load_env().get("DATABASE_URL") or None
    wanted = parse_env_file(env_file).get("DATABASE_URL") or None
    if used != wanted:
        dotenv = ML_ROOT.parent / ".env"
        override = "utils.load_env, which overrides the environment"
        if not dotenv.is_file():
            override = "absent: the environment's own DATABASE_URL is the one in use"
        raise RuntimeError(
            f"the env files disagree on DATABASE_URL: {env_file} (loaded by the "
            f"apply step) and {dotenv} ({override}). Not connecting, because the "
            "extract and the apply step could use different databases. Make them "
            "agree. The values are not shown."
        )
    try:
        con = get_connection()
    except SystemExit as exit_:
        raise RuntimeError(
            "could not connect to Neon (see the output above)"
        ) from exit_
    con.set_session(readonly=True, autocommit=True)
    return con


def fetch_requests(date: str, env_file: Path) -> tuple[list[tuple], list[tuple]]:
    """The rows that still need an anchor on `date` (read-only SELECTs)."""
    con = connect_neon(env_file)
    try:
        with con.cursor() as cur:
            cur.execute(_SELECT_LOTTERY, (date,))
            lottery = cur.fetchall()
            cur.execute(_SELECT_SILENT_BOOM, (date,))
            silent_boom = cur.fetchall()
    finally:
        con.close()
    return lottery, silent_boom


def fulltape_connection(threads: int | None = None, memory_limit: str | None = None):
    from utils.r2 import fulltape_connection as _connect

    return _connect(threads=threads, memory_limit=memory_limit)


def tape_url(date: str) -> str:
    from utils.r2 import r2_url

    return r2_url(date)


def list_landed_dates() -> list[str]:
    """Landed days in R2, via DuckDB glob (no boto3)."""
    bucket = os.environ["R2_BUCKET_FULLTAPE"]
    con = fulltape_connection()
    rows = con.execute(
        "SELECT file FROM glob(?)", [f"s3://{bucket}/fulltape/*-fulltape.parquet"]
    ).fetchall()
    prefix = f"s3://{bucket}/"
    return landed_dates(r[0].removeprefix(prefix) for r in rows)


# ── Per-worker DuckDB resources ─────────────────────────────────────────────

# DuckDB's default memory_limit is 80% of physical RAM; the extract's workers
# together use this share of it (leaving room for Python, pandas and the OS).
_RAM_SHARE = 0.6
_DUCKDB_DEFAULT_RAM_SHARE = 0.8
_MIN_MEMORY_MIB = 512
_SIZE_UNITS = {
    "KB": 10**3, "MB": 10**6, "GB": 10**9, "TB": 10**12,
    "KIB": 2**10, "MIB": 2**20, "GIB": 2**30, "TIB": 2**40,
}  # fmt: skip
_SIZE_RE = re.compile(r"^\s*([\d.]+)\s*([KMGT]i?B)\s*$", re.IGNORECASE)


def parse_size(text: str) -> int:
    """'24.9 GiB' (DuckDB's memory_limit format) -> bytes."""
    match = _SIZE_RE.match(text)
    if not match:
        raise ValueError(f"cannot parse size {text!r}")
    return int(float(match.group(1)) * _SIZE_UNITS[match.group(2).upper()])


def total_ram_bytes() -> int:
    """Physical RAM, read back from DuckDB's default limit (80% of RAM)."""
    import duckdb

    con = duckdb.connect()
    try:
        limit = con.execute("SELECT current_setting('memory_limit')").fetchone()[0]
    finally:
        con.close()
    return int(parse_size(limit) / _DUCKDB_DEFAULT_RAM_SHARE)


def worker_resources(workers: int) -> tuple[int, str]:
    """(threads, memory_limit) for one of `workers` parallel DuckDB workers.

    Threads split the cores evenly (at least 1); memory splits _RAM_SHARE of
    physical RAM evenly (at least _MIN_MEMORY_MIB). Without the split each
    worker claims every core and 80% of RAM and they thrash: 6 workers took
    ~115 s per date against ~25 s at 2.
    """
    workers = max(1, workers)
    cores = os.cpu_count() or 1
    threads = max(1, cores // workers)
    mib = max(_MIN_MEMORY_MIB, int(total_ram_bytes() * _RAM_SHARE / workers) // 2**20)
    return threads, f"{mib}MiB"


# ── Per-date run and CLI ────────────────────────────────────────────────────


def output_path(out_dir: Path, date: str) -> Path:
    return out_dir / f"{date}.ndjson"


def extract_date(
    date: str,
    out_dir: Path,
    env_file: Path,
    force: bool = False,
    threads: int | None = None,
    memory_limit: str | None = None,
) -> dict:
    """Extract one date. Returns its stats; raises on any failure.

    `env_file` is the resolved .env.local (see connect_neon's guard).
    `threads` and `memory_limit` are this worker's share of the machine.
    """
    target = output_path(out_dir, date)
    if target.exists() and not force:
        return {"date": date, "skipped": True}
    started = time.monotonic()
    lottery, silent_boom = fetch_requests(date, env_file)
    requests = build_requests(lottery, silent_boom)
    records: list[dict] = []
    if len(requests) > 0:
        con = fulltape_connection(threads=threads, memory_limit=memory_limit)
        try:
            records = select_anchors(con, tape_url(date), requests)
        finally:
            con.close()
    write_ndjson_atomic(target, records)
    return {
        "date": date,
        "skipped": False,
        "lf": len(lottery),
        "sb": len(silent_boom),
        "anchors": sum(r["anchor"] is not None for r in records),
        "multi_leg": sum(
            r["anchor"] is not None and is_multi_leg(r["anchor"]["tradeCode"])
            for r in records
        ),
        "siblings": sum(len(r["siblings"]) for r in records),
        "secs": round(time.monotonic() - started, 1),
    }


def format_stats(stats: dict) -> str:
    if stats["skipped"]:
        return f"{stats['date']} skipped (output exists)"
    return (
        f"{stats['date']} lf={stats['lf']} sb={stats['sb']} "
        f"anchors={stats['anchors']} multi_leg={stats['multi_leg']} "
        f"siblings={stats['siblings']} secs={stats['secs']}"
    )


def _run_date(args: tuple[str, str, str, bool, int, str]) -> dict:
    date, out_dir, env_file, force, threads, memory_limit = args
    return extract_date(
        date, Path(out_dir), Path(env_file), force, threads, memory_limit
    )


def select_dates(
    landed: list[str],
    dates: list[str] | None,
    start: str | None,
    end: str | None,
) -> list[str]:
    """Requested dates restricted to landed days; a date not landed is an error."""
    if dates:
        for d in dates:
            if not _DATE_RE.match(d):
                raise ValueError(f"bad date {d!r}, want YYYY-MM-DD")
        missing = sorted(set(dates) - set(landed))
        if missing:
            raise ValueError(f"no landed tape for: {', '.join(missing)}")
        return sorted(set(dates))
    return [
        d for d in landed if (start is None or d >= start) and (end is None or d <= end)
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dates", nargs="+", help="explicit YYYY-MM-DD dates")
    parser.add_argument("--from", dest="start", help="first date (inclusive)")
    parser.add_argument("--to", dest="end", help="last date (inclusive)")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--force", action="store_true", help="redo existing outputs")
    parser.add_argument("--env-file", help="path to .env.local")
    args = parser.parse_args(argv)
    if not (args.dates or args.start or args.end):
        parser.error("give --dates or --from/--to")

    env_file = resolve_env_file(args.env_file)
    if env_file is None:
        print("no .env.local found; pass --env-file", file=sys.stderr)
        return 2
    load_env_local(env_file)

    try:
        dates = select_dates(list_landed_dates(), args.dates, args.start, args.end)
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 2
    print(f"{len(dates)} date(s), workers={args.workers}, out={args.out}", flush=True)

    failed: list[str] = []
    threads, memory_limit = worker_resources(args.workers)
    print(f"per worker: threads={threads} memory_limit={memory_limit}", flush=True)
    jobs = [
        (d, str(args.out), str(env_file), args.force, threads, memory_limit)
        for d in dates
    ]
    with ProcessPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [(job[0], pool.submit(_run_date, job)) for job in jobs]
        for date, future in futures:
            try:
                print(format_stats(future.result()), flush=True)
            except Exception as err:  # noqa: BLE001 - named per date below
                failed.append(date)
                print(f"{date} FAILED: {type(err).__name__}: {err}", file=sys.stderr)
    if failed:
        print(f"failed dates: {', '.join(failed)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
