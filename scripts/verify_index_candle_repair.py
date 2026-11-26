#!/usr/bin/env python
"""Check repaired SPX 1-minute candles against the UW Full Tape spot.

READ ONLY. It reads Postgres in a read-only session and one Full Tape day from
R2 through DuckDB, and writes nothing, except the price file that
`--export-spots` writes (below). Run it after the repair tool
(scripts/repair-index-candle-placeholders.mjs) has written a date:

    F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -I \\
        scripts/verify_index_candle_repair.py --symbol SPX --date 2026-03-26 \\
        [--before 17:11Z] [--ratio 10.040707] [--fitted]

To write a date's price file instead of checking it:

    F:/dev/strike-calculator/ml/.venv/Scripts/python.exe -I \\
        scripts/verify_index_candle_repair.py --symbol SPX|NDX \\
        --date 2026-03-26 --export-spots <dir>

What it compares. The candles are the stored `index_candles_1m` rows of the
date with market_time = 'r' (regular hours). The tape spot is the last
`underlying_price` per UTC minute over the day's non-canceled SPXW prints. For
every minute both sides have, d = candle close - tape spot. The gate passes
when the median |d| is at most 2 pt and the p99 |d| at most 5 pt (spec:
docs/superpowers/specs/2026-11-24-spx-candle-placeholder-repair.md, section 4
and the Thresholds table). The gate reads p99 and not the max because a live
day can carry one outlier minute (2026-11-20: median 0.67, max 25.3). A
placeholder day sits at a median of about 25. The day also fails when fewer
than 99% of its candle minutes have a tape spot (real days are 390 of 390), so
a thin tape cannot pass on a small sample.

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

`--fitted` is the gate for a day refit to the tape (spec decision 9): the median
|d| still gates at 2 pt, but a p99 over 5 pt prints as a `note:` line and does
not fail the day. The spikes behind it are tape lag in fast markets (13 to 30 pt
on 03-24, 03-31 and 04-02, while ES holds steady), not a wrong candle.

`--export-spots <dir>` writes the date's per-minute index price instead of
checking anything, and reads no candles (so `--before`, `--ratio` and `--fitted`
do not apply). The file is `<dir>/<SYMBOL>-<date>-spots.json`:
`{"symbol", "date", "source", "minutes": {"<utc epoch minute>": price}}`.
SPX gets source `tape`, the minutes above. NDX gets source `parity`: the tape
carries no NDX price, so the level comes from same-day NDXP put-call parity
(strike + call mid - put mid, from the NBBO on each print), the median over the
strikes within 0.5% of the minute's rough level. An existing file is kept, never
rewritten (`kept <path>`, exit 0), so a re-run reuses what it wrote. A date with
no minute exits 2 and writes nothing. The file is written to a temp file and
then hard-linked to its name, so the name never holds a partial file, even if
the run is killed.

The tape check is SPX only. UW leaves `underlying_price` NULL on every NDXP and
NDX print (on 2026-11-20: 40,526 and 5,823 prints, none with a price), so the
tape carries no NDX price to check against. NDX is verified by the repair tool's
own close and ratio checks, and gets a price file only through --export-spots.

Credentials: the four R2_* names and DATABASE_URL, read from `.env.local` in
the main checkout (found through `git rev-parse --git-common-dir`, so this
works from a worktree) and kept in process memory. `--export-spots` reads only
R2, so it needs and loads the four R2_* names and not DATABASE_URL. No other
name in the file is read, and no value is printed: an error message is
redacted first.

Exit codes: 0 PASS, 1 FAIL (including no overlap), 2 usage error or a read
that could not run (no verdict). `--export-spots` exits 0 for a file written or
kept and 2 for anything else.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import subprocess
import sys
import tempfile
from collections.abc import Iterable, Mapping
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
# The coverage floor: the tape must hold a spot for at least this share of the
# candle minutes (real days are 390 of 390; 99% allows 3 missing of 390).
COVERAGE_MIN = 0.99

# The NDX put-call parity level (a price file only): the strikes kept for a
# minute are within PARITY_BAND of its rough level, and at least
# PARITY_MIN_STRIKES of them must be left for the minute to have a level.
PARITY_BAND = 0.005
PARITY_MIN_STRIKES = 2

# The tape read's share of the shared box: DuckDB defaults to every core and
# 80% of RAM.
TAPE_THREADS = 4
TAPE_MEMORY_LIMIT = "3000MiB"

# The only names read from .env.local. The Full Tape read needs the R2 ones;
# the candle check also needs DATABASE_URL.
R2_ENV_NAMES = (
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT_URL",
    "R2_BUCKET_FULLTAPE",
)
ALLOWED_ENV_NAMES = (*R2_ENV_NAMES, "DATABASE_URL")

NO_OVERLAP = "no overlap: no minute is in both the candles and the tape"

# The price file's source per symbol, and why a day can have no minute at all.
SPOT_SOURCES = {
    "SPX": ("tape", "no SPXW print with an underlying_price"),
    "NDX": ("parity", "no minute with two usable same-day NDXP strikes"),
}

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

# The same-day NDXP quotes behind the NDX price file: per UTC minute, strike and
# side ('c' or 'p'), the mid of the NBBO on the last print. `canceled` is
# filtered as in TAPE_SQL. The strike, bid and ask are CAST to DOUBLE: the old
# tape layout stores them as DECIMAL(18,4) (47 of the 61 NDX dates), and a
# Decimal times the float band raises in Python. A quote needs a real, uncrossed
# market (bid > 0, ask > bid).
PARITY_SQL = """
SELECT CAST(floor(epoch(executed_at) / 60) AS BIGINT) AS minute,
       CAST(strike AS DOUBLE) AS strike,
       lower(substr(option_type, 1, 1)) AS side,
       LAST(
         (CAST(nbbo_bid AS DOUBLE) + CAST(nbbo_ask AS DOUBLE)) / 2
         ORDER BY executed_at, id
       ) AS mid
FROM read_parquet({url})
WHERE option_chain_id LIKE 'NDXP%'
  AND expiry = DATE '{day}'
  AND lower(CAST(canceled AS VARCHAR)) IN ('false', 'f', '0')
  AND nbbo_bid > 0
  AND nbbo_ask > nbbo_bid
GROUP BY 1, 2, 3
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


def _gate_lines(stats: dict, fitted: bool) -> tuple[list[str], list[str]]:
    """The gate's failure reasons and its notes, kept apart."""
    if stats["median_abs"] is None:
        return [NO_OVERLAP], []
    reasons = []
    notes = []
    if stats["median_abs"] > MEDIAN_ABS_MAX:
        reasons.append(
            f"median |d| {stats['median_abs']:.2f} pt is over {MEDIAN_ABS_MAX:g} pt"
        )
    if stats["p99_abs"] > P99_ABS_MAX:
        p99 = f"p99 |d| {stats['p99_abs']:.2f} pt is over {P99_ABS_MAX:g} pt"
        if fitted:
            notes.append(f"note: {p99} (tape lag, not gated on a fitted day)")
        else:
            reasons.append(p99)
    return reasons, notes


def gate(stats: dict, fitted: bool = False) -> tuple[bool, list[str]]:
    """The SPX gate: median |d| <= 2 and p99 |d| <= 5. No overlap fails.

    With `fitted` (a day refit to the tape) a p99 over 5 is not a failure: it
    comes back as a `note:` line after the reasons, and the verdict is the
    median's alone. The lines are the reasons the gate failed, then any note.
    """
    reasons, notes = _gate_lines(stats, fitted)
    return not reasons, reasons + notes


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


def evaluate(
    stats: dict, share: float | None, candle_minutes: int, fitted: bool = False
) -> tuple[bool, list[str]]:
    """The verdict: the gate, the tape coverage floor and the ratio check.

    The floor: the compared minutes must be at least COVERAGE_MIN of the
    `candle_minutes`, or a tape holding a few of the day's minutes would pass
    on that sample. No common minute is already "no overlap" and gets no
    second reason. The ratio check runs only when a share was computed.
    `fitted` is the gate's: a p99 over 5 pt becomes a note. The lines are every
    failure reason first, then any note, so a note never sits between reasons.
    """
    reasons, notes = _gate_lines(stats, fitted)
    compared = stats["minutes"]
    if compared and compared / candle_minutes < COVERAGE_MIN:
        reasons.append(
            f"only {compared} of {candle_minutes} candle minutes have a tape spot "
            f"(under {COVERAGE_MIN:.0%})"
        )
    if share is not None and share < RATIO_SHARE_MIN:
        reasons.append(
            f"ratio share {share:.1%} is under {RATIO_SHARE_MIN:.0%} "
            f"(within {RATIO_TOL:g} of the day's ratio)"
        )
    return not reasons, reasons + notes


# ── The price file ───────────────────────────────────────────────────────────


def parity_levels(
    quotes: Iterable[tuple[int, float, str, float]],
    band: float = PARITY_BAND,
    min_strikes: int = PARITY_MIN_STRIKES,
) -> dict[int, float]:
    """The index level per minute from same-day put-call parity.

    `quotes` are (minute, strike, side 'c' or 'p', mid). A strike with both a
    call and a put implies the level `strike + call mid - put mid` (the options
    are European and expire that day, so carry is under a point). The minute's
    rough level is the median of those; the strikes kept are those with
    |strike - rough| <= band * rough (the bound is inclusive), and with at
    least `min_strikes` of them the level is their median. A minute with fewer
    has no level and is left out. A quote whose strike or mid is NULL (None) or
    non-finite is skipped, as `minute_stats` skips a non-finite value.
    """
    by_minute: dict[int, dict[float, dict[str, float]]] = {}
    for minute, strike, side, mid in quotes:
        if strike is None or mid is None:
            continue
        if math.isfinite(strike) and math.isfinite(mid):
            by_minute.setdefault(minute, {}).setdefault(strike, {})[side] = mid
    levels: dict[int, float] = {}
    for minute, strikes in by_minute.items():
        implied = [
            (strike, strike + sides["c"] - sides["p"])
            for strike, sides in strikes.items()
            if "c" in sides and "p" in sides
        ]
        if not implied:
            continue
        rough = statistics.median(level for _, level in implied)
        near = [
            level for strike, level in implied if abs(strike - rough) <= band * rough
        ]
        if len(near) >= min_strikes:
            levels[minute] = statistics.median(near)
    return levels


def spots_document(
    symbol: str, day: date, source: str, minutes: Mapping[int, float]
) -> dict:
    """The price file's content. JSON keys are strings, so a minute is one."""
    return {
        "symbol": symbol,
        "date": day.isoformat(),
        "source": source,
        "minutes": {str(minute): minutes[minute] for minute in sorted(minutes)},
    }


def spots_path(out_dir: Path, symbol: str, day: date | str) -> Path:
    return out_dir / f"{symbol}-{day}-spots.json"


def write_spots(out_dir: Path, doc: dict) -> Path:
    """Write the price file to <out_dir>/<SYMBOL>-<date>-spots.json, exclusively.

    The final name only ever appears whole. The document is written and synced
    to a temp file in the same directory (its name does not end in
    `-spots.json`), then hard-linked to the final name: `os.link` raises
    FileExistsError when the final file exists, which leaves it as it was, so
    the create is still exclusive. The temp file is removed afterwards, on the
    error path too. A kill mid-write leaves at most a stray temp file, never a
    truncated price file for a later run to "keep". The document is serialized
    first, so a price that is not JSON (NaN) raises before any file exists.
    """
    text = json.dumps(doc, allow_nan=False) + "\n"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = spots_path(out_dir, doc["symbol"], doc["date"])
    fd, temp_name = tempfile.mkstemp(
        dir=out_dir, prefix=f".{path.name}.", suffix=".tmp"
    )
    temp = Path(temp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(temp, path)
    finally:
        temp.unlink(missing_ok=True)
    return path


# ── Arguments ────────────────────────────────────────────────────────────────

_DATE_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_BEFORE_RE = re.compile(r"([01][0-9]|2[0-3]):([0-5][0-9])Z")


NDX_REFUSAL = (
    "NDX cannot be checked against the tape: UW leaves underlying_price "
    "NULL on every NDXP and NDX print, so the tape carries no NDX price. "
    "NDX is verified by the repair tool's own close and ratio checks."
)


def _symbol(value: str) -> str:
    # NDX parses here and is refused in parse_args unless --export-spots is
    # given: a type function cannot see the other arguments.
    symbol = value.strip().upper()
    if symbol not in ("SPX", "NDX"):
        raise argparse.ArgumentTypeError(
            f"unknown symbol {value!r}: SPX can be checked against the tape, "
            "and NDX is priced only with --export-spots"
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
    parser.add_argument(
        "--symbol",
        required=True,
        type=_symbol,
        help="SPX; NDX only with --export-spots",
    )
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
    parser.add_argument(
        "--fitted",
        action="store_true",
        help="a day refit to the tape: a p99 over 5 pt is a note, not a failure "
        "(the median still gates)",
    )
    parser.add_argument(
        "--export-spots",
        type=Path,
        metavar="DIR",
        help="write the date's per-minute index price (SPX: the tape spot; NDX: "
        "same-day NDXP put-call parity) to DIR/<SYMBOL>-<date>-spots.json "
        "instead of checking; reads no candles; keeps an existing file",
    )
    args = parser.parse_args(argv)
    if args.export_spots is None:
        if args.symbol == "NDX":
            parser.error(NDX_REFUSAL)
    else:
        # The export reads no candles, so these cannot apply. Refused, not
        # ignored: a --before that did not cut the file would look as if it had.
        unused = [
            flag
            for flag, given in (
                ("--before", args.before is not None),
                ("--ratio", args.ratio is not None),
                ("--fitted", args.fitted),
            )
            if given
        ]
        if unused:
            parser.error(
                f"{', '.join(unused)} cannot be combined with --export-spots: "
                "the export reads no candles"
            )
    return args


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


def read_allowed_env(
    path: Path, names: tuple[str, ...] = ALLOWED_ENV_NAMES
) -> dict[str, str]:
    """The assignments of `names` in an env file (the allowed five by default).

    `scripts/_cli_paths.load_env_file` copies every name in the file into
    os.environ; this tool is allowed five, and an export reads four. Same line
    rules: `NAME=value` after strip(), surrounding quotes removed, first
    assignment of a name wins, a missing file gives {}.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return {}
    found: dict[str, str] = {}
    for line in text.splitlines():
        match = _ASSIGNMENT_RE.match(line.strip())
        if match and match.group(1) in names:
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


def load_credentials(
    env_path: Path, names: tuple[str, ...] = ALLOWED_ENV_NAMES
) -> None:
    """Put `names` from the env file into os.environ (default: the five allowed).

    A name already set (non-empty) in the shell keeps its value. A name outside
    `names` is neither loaded nor required: the price-file export passes the R2
    names and so needs no DATABASE_URL. Raises with the names still missing,
    never a value.
    """
    for name, value in read_allowed_env(env_path, names).items():
        if value and not os.environ.get(name):
            os.environ[name] = value
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            f"missing credentials: {', '.join(missing)} "
            f"(looked in {env_path} and the environment)"
        )


def _url_parts(value: str) -> set[str]:
    """The user, password and host of a URL; empty when it does not parse."""
    try:
        parts = urlsplit(value)
        return {parts.username or "", parts.password or "", parts.hostname or ""}
    except ValueError:
        return set()


def redact(text: str) -> str:
    """`text` with every credential value in the environment replaced by ***.

    Besides the five values, it hides what a driver prints of a URL on its
    own: the user, password and host of DATABASE_URL (libpq: `connection to
    server at "<host>" ... for user "<user>"`) and the host of R2_ENDPOINT_URL
    (`Could not resolve host <host>`). The match ignores case, because
    urlsplit lowercases a host the driver prints as written, and tries the
    longest value first, so a value that starts another is replaced whole.
    """
    values = {os.environ.get(name) or "" for name in ALLOWED_ENV_NAMES}
    for url_name in ("DATABASE_URL", "R2_ENDPOINT_URL"):
        values |= _url_parts(os.environ.get(url_name) or "")
    secrets = sorted(values - {""}, key=len, reverse=True)
    if not secrets:
        return text
    pattern = re.compile("|".join(re.escape(s) for s in secrets), re.IGNORECASE)
    return pattern.sub("***", text)


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


def _tape_rows(sql: str, day: date) -> list[tuple]:
    """The rows of `sql` over the day's Full Tape object in R2.

    `sql` is TAPE_SQL or PARITY_SQL: `{url}` takes the quoted object URL and
    `{day}` the ISO date. One DuckDB connection, closed whatever happens.
    """
    if str(ML_SRC) not in sys.path:
        sys.path.insert(0, str(ML_SRC))
    from utils import r2

    con = r2.fulltape_connection(threads=TAPE_THREADS, memory_limit=TAPE_MEMORY_LIMIT)
    try:
        url = r2.r2_url(day.isoformat()).replace("'", "''")
        return con.execute(sql.format(url=f"'{url}'", day=day.isoformat())).fetchall()
    finally:
        con.close()


def fetch_tape_spots(day: date) -> dict[int, float]:
    """The last SPXW underlying_price per UTC minute of the day's Full Tape."""
    rows = _tape_rows(TAPE_SQL, day)
    return {int(minute): float(spot) for minute, spot in rows}


def fetch_parity_quotes(day: date) -> list[tuple[int, float, str, float]]:
    """The day's same-day NDXP (minute, strike, side, mid) quotes, from PARITY_SQL.

    The strike and mid come back as DOUBLE already, so they are used as they are.
    """
    return [
        (int(minute), strike, side, mid)
        for minute, strike, side, mid in _tape_rows(PARITY_SQL, day)
    ]


def fetch_parity_levels(day: date) -> dict[int, float]:
    """The NDX level per UTC minute of the day, from same-day NDXP parity."""
    return parity_levels(fetch_parity_quotes(day))


# ── The run ──────────────────────────────────────────────────────────────────


def _pt(value: float) -> str:
    return f"{value:.2f}"


def export_spots(symbol: str, day: date, out_dir: Path) -> int:
    """Write the day's per-minute index price file; no candles are read.

    SPX is the tape spot (source `tape`), NDX the same-day NDXP parity level
    (source `parity`). An existing file is kept before anything is read, so a
    re-run costs no R2 read. No minute at all exits 2 and writes nothing.
    """
    path = spots_path(out_dir, symbol, day)
    if path.exists():
        print(f"kept {path}")
        return EXIT_PASS
    source, why_empty = SPOT_SOURCES[symbol]
    try:
        # An export reads only R2: it needs no DATABASE_URL.
        load_credentials(main_checkout_dir() / ".env.local", R2_ENV_NAMES)
        minutes = fetch_tape_spots(day) if symbol == "SPX" else fetch_parity_levels(day)
        if not minutes:
            print(
                f"error: {symbol} {day}: no minute has a {source} price "
                f"({why_empty}); nothing written",
                file=sys.stderr,
            )
            return EXIT_ERROR
        written = write_spots(out_dir, spots_document(symbol, day, source, minutes))
    except Exception as exc:  # the CLI boundary: name it, redacted, no verdict
        print(f"error: {type(exc).__name__}: {redact(str(exc))}", file=sys.stderr)
        return EXIT_ERROR
    count = f"{len(minutes)} minute" + ("" if len(minutes) == 1 else "s")
    print(f"{symbol} {day} {source}: {count} -> {written}")
    return EXIT_PASS


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.export_spots is not None:
        return export_spots(args.symbol, args.date, args.export_spots)
    try:
        load_credentials(main_checkout_dir() / ".env.local")
        candles, etf = fetch_index_and_etf(args.symbol, args.date)
        tape = fetch_tape_spots(args.date)
    except Exception as exc:  # the CLI boundary: name it, redacted, no verdict
        print(f"error: {type(exc).__name__}: {redact(str(exc))}", file=sys.stderr)
        return EXIT_ERROR

    cut = before_minute(args.date, args.before) if args.before else None
    candles = apply_cut(candles, cut)
    stats = minute_stats(candles, tape)
    share = ratio_share(candles, etf, args.ratio) if args.ratio is not None else None
    ok, reasons = evaluate(stats, share, len(candles), args.fitted)

    scope = f" (minutes before {args.before} only)" if args.before else ""
    scope += " (fitted gate: p99 is a note)" if args.fitted else ""
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
