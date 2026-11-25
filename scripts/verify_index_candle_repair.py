#!/usr/bin/env python
"""Check repaired SPX 1-minute candles against the UW Full Tape spot.

READ ONLY. It reads Postgres in a read-only session and one Full Tape day from
R2 through DuckDB, and writes nothing. Run it after the repair tool
(scripts/repair-index-candle-placeholders.mjs) has written a date:

    F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -I \\
        scripts/verify_index_candle_repair.py --symbol SPX --date 2026-03-26 \\
        [--before 17:11Z] [--ratio 10.040707]

What it compares. The candles are the stored `index_candles_1m` rows of the
date with market_time = 'r' (regular hours). The tape spot is the last
`underlying_price` per UTC minute over the day's non-canceled SPXW prints. For
every minute both sides have, d = candle close - tape spot. The gate passes
when the median |d| is at most 2 pt and the p99 |d| at most 5 pt (spec:
docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md, section 4
and the Thresholds table). The gate reads p99 and not the max because a live
day can carry one outlier minute (2026-11-20: median 0.67, max 25.3). A
placeholder day sits at a median of about 25.

`--before 17:11Z` keeps only the candle minutes strictly before that UTC time
of the date. 2026-04-10 is placeholder only before 17:11Z, so the cut keeps
the check to the repaired minutes.

`--ratio` takes the per-day Schwab ratio the repair tool's dry run prints (6
decimals, for example `ratio 10.040707`). It adds a second check: at least 99%
of the minutes that have both an index bar and an SPY bar (`etf_candles_1m`)
must satisfy |index close / SPY close - ratio| <= 1e-6. The method writes the
SPY bar times the ratio, so a repaired minute matches exactly. Use it only
where the SPY rows are final bars (up to 2026-04-27); later days hold frozen
partial SPY bars, and the check would fail on bars the repair did right.

SPX only. UW leaves `underlying_price` NULL on every NDXP and NDX print (on
2026-11-20: 40,526 and 5,823 prints, none with a price), so the tape carries
no NDX price. NDX is verified by the repair tool's own close and ratio checks.

Credentials: the four R2_* names and DATABASE_URL, read from `.env.local` in
the main checkout (found through `git rev-parse --git-common-dir`, so this
works from a worktree) and kept in process memory. No other name in the file
is read, and no value is printed: an error message is redacted first.

Exit codes: 0 PASS, 1 FAIL (including no overlap), 2 usage error or a read
that could not run (no verdict).
"""

from __future__ import annotations

import argparse
import math
import os
import re
import subprocess
import sys
from collections.abc import Mapping
from datetime import UTC, date, datetime
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2

SCRIPT_DIR = Path(__file__).resolve().parent
ML_SRC = SCRIPT_DIR.parent / "ml" / "src"

EXIT_PASS = 0
EXIT_FAIL = 1
EXIT_ERROR = 2

# The gate (spec Thresholds table): SPX candle - tape spot, in index points.
MEDIAN_ABS_MAX = 2.0
P99_ABS_MAX = 5.0
# The ratio check: index close / ETF close within RATIO_TOL of the day's ratio
# on at least RATIO_SHARE_MIN of the minutes both bars exist.
RATIO_TOL = 1e-6
RATIO_SHARE_MIN = 0.99

# The tape read's share of the shared box: DuckDB defaults to every core and
# 80% of RAM.
TAPE_THREADS = 4
TAPE_MEMORY_LIMIT = "3000MiB"

# The only names read from .env.local.
ALLOWED_ENV_NAMES = (
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
    "DATABASE_URL",
)

NO_OVERLAP = "no overlap: no minute is in both the candles and the tape"

# Minutes are the UTC epoch minute, floor(epoch seconds / 60), on both sides.
INDEX_SQL = """
SELECT floor(extract(epoch FROM timestamp) / 60)::bigint AS minute,
       close::float8
FROM index_candles_1m
WHERE symbol = %s AND date = %s AND market_time = 'r'
"""

# etf_candles_1m has no date column: the UTC day bounds the rows, and the join
# on the index minutes keeps only the regular ones.
ETF_SQL = """
SELECT floor(extract(epoch FROM timestamp) / 60)::bigint AS minute,
       close::float8
FROM etf_candles_1m
WHERE ticker = 'SPY'
  AND timestamp >= (%s::date)::timestamp AT TIME ZONE 'UTC'
  AND timestamp < ((%s::date) + 1)::timestamp AT TIME ZONE 'UTC'
"""

# epoch(executed_at) reads the pre-05-01 naive-UTC layout and the later
# TIMESTAMPTZ one alike. `canceled` is boolean in one layout and text in the
# other (scripts/_eod_flow.py:168 filters it the same way). A print without a
# spot is skipped, so a later NULL cannot hide the last real spot.
TAPE_SQL = """
SELECT CAST(floor(epoch(executed_at) / 60) AS BIGINT) AS minute,
       LAST(CAST(underlying_price AS DOUBLE) ORDER BY executed_at, id) AS spot
FROM read_parquet({url})
WHERE option_chain_id LIKE 'SPXW%'
  AND lower(CAST(canceled AS VARCHAR)) IN ('false', 'f', '0')
  AND underlying_price IS NOT NULL
GROUP BY minute
"""


# ── The comparison ───────────────────────────────────────────────────────────


def _percentile(sorted_values: list[float], q: float) -> float:
    """The q-quantile (0..1) by linear interpolation, as numpy's default."""
    rank = q * (len(sorted_values) - 1)
    low = math.floor(rank)
    high = math.ceil(rank)
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * (
        rank - low
    )


def minute_stats(candles: Mapping[int, float], tape: Mapping[int, float]) -> dict:
    """Statistics of d = candle - tape over the minutes both maps have.

    Keys: minutes (how many), mean (signed, so a bias shows), and median_abs,
    p95_abs, p99_abs, max_abs of |d|. A minute only one side has is ignored,
    and so is one with a non-finite value. With no common minute every figure
    but `minutes` (0) is None.
    """
    diffs = [
        candles[minute] - tape[minute]
        for minute in candles.keys() & tape.keys()
        if math.isfinite(candles[minute]) and math.isfinite(tape[minute])
    ]
    if not diffs:
        return {
            "minutes": 0,
            "mean": None,
            "median_abs": None,
            "p95_abs": None,
            "p99_abs": None,
            "max_abs": None,
        }
    magnitudes = sorted(abs(d) for d in diffs)
    return {
        "minutes": len(diffs),
        "mean": math.fsum(diffs) / len(diffs),
        "median_abs": _percentile(magnitudes, 0.50),
        "p95_abs": _percentile(magnitudes, 0.95),
        "p99_abs": _percentile(magnitudes, 0.99),
        "max_abs": magnitudes[-1],
    }


def gate(stats: dict) -> tuple[bool, list[str]]:
    """The SPX gate: median |d| <= 2 and p99 |d| <= 5. No overlap fails."""
    if stats["median_abs"] is None:
        return False, [NO_OVERLAP]
    reasons = []
    if stats["median_abs"] > MEDIAN_ABS_MAX:
        reasons.append(
            f"median |d| {stats['median_abs']:.2f} pt is over {MEDIAN_ABS_MAX:g} pt"
        )
    if stats["p99_abs"] > P99_ABS_MAX:
        reasons.append(f"p99 |d| {stats['p99_abs']:.2f} pt is over {P99_ABS_MAX:g} pt")
    return not reasons, reasons


def ratio_share(
    index_closes: Mapping[int, float],
    etf_closes: Mapping[int, float],
    ratio: float,
    tol: float = RATIO_TOL,
) -> float:
    """The share of common minutes where |index / etf - ratio| <= tol.

    Minutes only one side has are ignored. A common minute whose ETF close is
    not positive and finite cannot match, so it counts against the share. No
    common minute gives 0.0.
    """
    common = index_closes.keys() & etf_closes.keys()
    if not common:
        return 0.0
    within = 0
    for minute in common:
        index, etf = index_closes[minute], etf_closes[minute]
        if math.isfinite(index) and math.isfinite(etf) and etf > 0:
            if abs(index / etf - ratio) <= tol:
                within += 1
    return within / len(common)


def evaluate(stats: dict, share: float | None) -> tuple[bool, list[str]]:
    """The verdict: the gate, plus the ratio check when a share was computed."""
    ok, reasons = gate(stats)
    if share is not None and share < RATIO_SHARE_MIN:
        ok = False
        reasons.append(
            f"ratio share {share:.1%} is under {RATIO_SHARE_MIN:.0%} "
            f"(within {RATIO_TOL:g} of the day's ratio)"
        )
    return ok, reasons


# ── Arguments ────────────────────────────────────────────────────────────────

_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_BEFORE_RE = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])Z")


def _symbol(value: str) -> str:
    symbol = value.strip().upper()
    if symbol == "NDX":
        raise argparse.ArgumentTypeError(
            "NDX cannot be checked against the tape: UW leaves underlying_price "
            "NULL on every NDXP and NDX print, so the tape carries no NDX price. "
            "NDX is verified by the repair tool's own close and ratio checks."
        )
    if symbol != "SPX":
        raise argparse.ArgumentTypeError(
            f"only SPX can be checked against the tape, got {value!r}"
        )
    return symbol


def _date(value: str) -> date:
    if not _DATE_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value!r}")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a real date: {value!r}") from None


def _before(value: str) -> str:
    if not _BEFORE_RE.fullmatch(value):
        raise argparse.ArgumentTypeError(f"not a HH:MMZ UTC time: {value!r}")
    return value


def _ratio(value: str) -> float:
    try:
        ratio = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {value!r}") from None
    if not math.isfinite(ratio) or ratio <= 0:
        raise argparse.ArgumentTypeError(f"not a positive finite ratio: {value!r}")
    return ratio


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check repaired SPX 1-minute candles against the Full Tape spot "
        "(read only)."
    )
    parser.add_argument("--symbol", required=True, type=_symbol, help="SPX only")
    parser.add_argument("--date", required=True, type=_date, help="YYYY-MM-DD")
    parser.add_argument(
        "--before",
        type=_before,
        help="HH:MMZ: only candle minutes strictly before this UTC time of the date",
    )
    parser.add_argument(
        "--ratio",
        type=_ratio,
        help="the day's Schwab ratio from the repair dry run (6 decimals); adds "
        "the index / SPY ratio check. Only where the SPY rows are final bars.",
    )
    return parser.parse_args(argv)


def before_minute(day: date, hhmmz: str) -> int:
    """The UTC epoch minute of `HH:MMZ` on `day`."""
    stamp = datetime(
        day.year, day.month, day.day, int(hhmmz[0:2]), int(hhmmz[3:5]), tzinfo=UTC
    )
    return int(stamp.timestamp()) // 60


def apply_cut(closes: Mapping[int, float], cut: int | None) -> dict[int, float]:
    """The minutes strictly before `cut` (all of them when there is no cut)."""
    if cut is None:
        return dict(closes)
    return {minute: close for minute, close in closes.items() if minute < cut}


# ── Credentials ──────────────────────────────────────────────────────────────

_ASSIGNMENT_RE = re.compile(r"^([A-Z_][A-Z0-9_]*)=(.*)$")


def read_allowed_env(path: Path) -> dict[str, str]:
    """The ALLOWED_ENV_NAMES assignments in an env file, and nothing else.

    `scripts/_cli_paths.load_env_file` copies every name in the file into
    os.environ; this tool is allowed five. Same line rules: `NAME=value` after
    strip(), surrounding quotes removed, first assignment of a name wins, a
    missing file gives {}.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    found: dict[str, str] = {}
    for line in text.splitlines():
        match = _ASSIGNMENT_RE.match(line.strip())
        if match and match.group(1) in ALLOWED_ENV_NAMES:
            found.setdefault(match.group(1), match.group(2).strip('"').strip("'"))
    return found


def main_checkout_from_common_dir(git_output: str) -> Path:
    """The main checkout, from `git rev-parse --path-format=absolute --git-common-dir`.

    Run in a worktree it names the main checkout's .git, where .env.local lives.
    """
    git_dir = git_output.strip().rstrip("/\\")
    if Path(git_dir).name != ".git":
        raise ValueError(f"not a .git directory: {git_dir!r}")
    return Path(git_dir).parent


def main_checkout_dir() -> Path:
    out = subprocess.run(
        [
            "git",
            "-C",
            str(SCRIPT_DIR),
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return main_checkout_from_common_dir(out)


def load_credentials(path: Path | None = None) -> None:
    """Put the five allowed names from .env.local into os.environ.

    A name already set (non-empty) in the shell keeps its value. Raises with
    the names still missing, never a value.
    """
    env_path = path if path is not None else main_checkout_dir() / ".env.local"
    for name, value in read_allowed_env(env_path).items():
        if value and not os.environ.get(name):
            os.environ[name] = value
    missing = [name for name in ALLOWED_ENV_NAMES if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            f"missing credentials: {', '.join(missing)} (looked in {env_path} and the environment)"
        )


def redact(text: str) -> str:
    """`text` with every credential value in the environment replaced by ***."""
    secrets = {os.environ.get(name) or "" for name in ALLOWED_ENV_NAMES}
    password = urlsplit(os.environ.get("DATABASE_URL") or "").password
    secrets.add(password or "")
    for secret in sorted(secrets - {""}, key=len, reverse=True):
        text = text.replace(secret, "***")
    return text


# ── Reads ────────────────────────────────────────────────────────────────────


def _read_minutes(conn, sql: str, params: tuple) -> dict[int, float]:
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return {int(minute): float(close) for minute, close in cur.fetchall()}
    finally:
        cur.close()


def fetch_index_and_etf(
    symbol: str, day: date
) -> tuple[dict[int, float], dict[int, float]]:
    """The day's regular-minute index closes and SPY closes, by UTC minute.

    One read-only session: every transaction starts READ ONLY, so a write is
    refused by Postgres whatever the SQL says.
    """
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        conn.set_session(readonly=True)
        index = _read_minutes(conn, INDEX_SQL, (symbol, day))
        etf = _read_minutes(conn, ETF_SQL, (day, day))
    finally:
        conn.close()
    return index, etf


def fetch_tape_spots(day: date) -> dict[int, float]:
    """The last SPXW underlying_price per UTC minute of the day's Full Tape."""
    if str(ML_SRC) not in sys.path:
        sys.path.insert(0, str(ML_SRC))
    from utils import r2

    con = r2.fulltape_connection(threads=TAPE_THREADS, memory_limit=TAPE_MEMORY_LIMIT)
    try:
        url = r2.r2_url(day.isoformat()).replace("'", "''")
        rows = con.execute(TAPE_SQL.format(url=f"'{url}'")).fetchall()
    finally:
        con.close()
    return {int(minute): float(spot) for minute, spot in rows}


# ── The run ──────────────────────────────────────────────────────────────────


def _pt(value: float) -> str:
    return f"{value:.2f}"


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        load_credentials()
        candles, etf = fetch_index_and_etf(args.symbol, args.date)
        tape = fetch_tape_spots(args.date)
    except Exception as exc:  # the CLI boundary: name it, redacted, no verdict
        print(f"error: {type(exc).__name__}: {redact(str(exc))}", file=sys.stderr)
        return EXIT_ERROR

    cut = before_minute(args.date, args.before) if args.before else None
    candles = apply_cut(candles, cut)
    stats = minute_stats(candles, tape)
    share = ratio_share(candles, etf, args.ratio) if args.ratio is not None else None
    ok, reasons = evaluate(stats, share)

    scope = f" (minutes before {args.before} only)" if args.before else ""
    print(f"{args.symbol} {args.date} vs the Full Tape SPXW spot{scope}")
    print(
        f"candles: {len(candles)} regular minutes; tape: {len(tape)} minutes; "
        f"compared: {stats['minutes']} (candle - tape)"
    )
    if stats["minutes"]:
        print(
            f"mean {stats['mean']:+.2f} pt; median |d| {_pt(stats['median_abs'])}; "
            f"p95 {_pt(stats['p95_abs'])}; p99 {_pt(stats['p99_abs'])}; "
            f"max {_pt(stats['max_abs'])}"
        )
    if share is not None:
        both = len(candles.keys() & etf.keys())
        print(
            f"ratio {args.ratio:.6f}: {share:.1%} of {both} index and SPY minutes "
            f"within {RATIO_TOL:g}"
        )
    print("PASS" if ok else "FAIL")
    for reason in reasons:
        print(f"  - {reason}")
    return EXIT_PASS if ok else EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
