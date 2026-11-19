"""
Multi-day EOD option-flow analyzer: the local CLI over scripts/_eod_flow.py.

Builds one per-day chain-aggregate parquet from each UW Full Tape day, then rolls
the by-day files up across the watchlist and cross-asset outliers. The tape comes
from a directory of `{date}-fulltape.parquet` files (--tape-dir) or from the R2
lake (--r2, which needs the R2_* variables in the environment).

Usage:
    # Build every tape day from 2026-04-13 on that has no by-day file, then
    # refresh the rollup
    python analyze.py --tape-dir DIR
    python analyze.py --r2

    # One day, then refresh the rollup
    python analyze.py --day 2026-11-04 --r2

    # Just refresh the rollup (no day processing, no tape needed)
    python analyze.py --rollup-only

    # Rebuild a day (overwrite its by-day parquet)
    python analyze.py --day 2026-06-15 --tape-dir DIR --force

Outputs (under --out-dir, default scripts/eod-flow-analysis/output/):
    by-day/<date>-chains.parquet   — per-chain EOD aggregates (--by-day-dir)
    cumulative-rollup.json         — multi-day metrics
    cumulative-headlines.txt       — human-readable summary
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import tempfile
from collections.abc import Callable, Iterable
from datetime import date, datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
# Run as a script, only this folder is on sys.path; the shared modules sit one level up.
SCRIPTS_DIR = SCRIPT_DIR.parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from _cli_paths import existing_dir  # noqa: E402
from _eod_flow import CHAINS_START, ChainsBuildError, build_chains, rollup, write_headlines  # noqa: E402

OUT_DIR = SCRIPT_DIR / "output"

TAPE_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})-fulltape\.parquet$")


def iso_day(value: str) -> date:
    """argparse ``type=``: a strict YYYY-MM-DD date."""
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a YYYY-MM-DD date: {value!r}") from None


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--day", type=iso_day, help="Process a single date (YYYY-MM-DD)")
    source = parser.add_mutually_exclusive_group()
    source.add_argument(
        "--tape-dir",
        type=existing_dir,
        help="Directory of Full Tape days, named {date}-fulltape.parquet",
    )
    source.add_argument(
        "--r2",
        action="store_true",
        help=(
            "Read the Full Tape from the R2 lake (R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, "
            "R2_SECRET_ACCESS_KEY, R2_BUCKET_FULLTAPE), one day at a time"
        ),
    )
    parser.add_argument(
        "--by-day-dir",
        type=Path,
        help="Where the by-day parquets live (default: <out-dir>/by-day)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=OUT_DIR,
        help="Where the rollup JSON and headlines are written (default: output/ beside this script)",
    )
    parser.add_argument(
        "--rollup-only", action="store_true", help="Skip day processing, just refresh rollup"
    )
    parser.add_argument(
        "--no-rollup", action="store_true", help="Process days but skip rollup refresh"
    )
    parser.add_argument("--force", action="store_true", help="Reprocess existing days")
    args = parser.parse_args(argv)
    if not args.rollup_only and args.tape_dir is None and not args.r2:
        parser.error(
            "day processing needs a tape source: pass --tape-dir DIR or --r2 "
            "(--rollup-only needs neither)"
        )
    if args.by_day_dir is None:
        args.by_day_dir = args.out_dir / "by-day"
    return args


def tape_files(tape_dir: Path) -> dict[date, Path]:
    """Map day -> tape path for every `{date}-fulltape.parquet` in `tape_dir`."""
    found: dict[date, Path] = {}
    for path in tape_dir.iterdir():
        match = TAPE_PATTERN.match(path.name)
        if match is None:
            continue
        try:
            found[date.fromisoformat(match.group(1))] = path
        except ValueError:
            continue  # a name shaped like a date that is not one
    return found


def from_chains_start(days: Iterable[date]) -> list[date]:
    return sorted(day for day in days if day >= CHAINS_START)


def build_days(
    args: argparse.Namespace,
    days: list[date],
    fetch: Callable[[date], Path | None],
    release: Callable[[date], None],
    spill_dir: Path,
) -> int:
    """Build each day's by-day file that is missing (or all with --force). Returns the failures.

    `fetch(day)` gives the day's tape path, or None when the source has none; `release(day)`
    frees it after the build, whatever came of it. A day that fails is reported and the
    rest still run.
    """
    failures = 0
    for day in days:
        out_path = args.by_day_dir / f"{day.isoformat()}-chains.parquet"
        if out_path.exists() and not args.force:
            print(f"[skip]    {day} already processed", file=sys.stderr)
            continue
        tape = fetch(day)
        if tape is None:
            print(f"[error]   {day}: no tape for this day", file=sys.stderr)
            failures += 1
            continue
        print(f"[process] {day}...", file=sys.stderr)
        try:
            count = build_chains(tape, day, out_path, spill_dir)
        except ChainsBuildError as exc:
            print(f"[error]   {day}: {exc}", file=sys.stderr)
            failures += 1
        else:
            print(f"[done]    {day} → {out_path.name} ({count} chains)", file=sys.stderr)
        finally:
            release(day)
    return failures


def build_from_dir(args: argparse.Namespace, spill_dir: Path) -> int:
    available = tape_files(args.tape_dir)
    days = [args.day] if args.day else from_chains_start(available)
    return build_days(args, days, available.get, lambda day: None, spill_dir)


def build_from_r2(args: argparse.Namespace, work_dir: Path, spill_dir: Path) -> int:
    # Imported here, so importing this module never loads boto3.
    from _tape_reader import TapeReader, TapeReadError

    reader = None
    try:
        reader = TapeReader.from_env(work_dir / "tape")
        days = [args.day] if args.day else from_chains_start(reader.landed_days())
        return build_days(args, days, reader.fetch_day, reader.release, spill_dir)
    except TapeReadError as exc:
        # The message holds a key, a count or a variable name, never a value.
        sys.exit(f"[eod-flow] R2 tape read failed: {exc}")
    finally:
        if reader is not None:
            reader.close()


def build_source_days(args: argparse.Namespace) -> int:
    args.by_day_dir.mkdir(parents=True, exist_ok=True)
    # One scratch directory holds the R2 cache and DuckDB's spill files, and goes with the run.
    with tempfile.TemporaryDirectory(prefix="eod-flow-") as scratch:
        work_dir = Path(scratch)
        spill_dir = work_dir / "spill"
        spill_dir.mkdir()
        if args.r2:
            return build_from_r2(args, work_dir, spill_dir)
        return build_from_dir(args, spill_dir)


def refresh_rollup(args: argparse.Namespace) -> None:
    print("[rollup]  Aggregating across all parquets...", file=sys.stderr)
    result = rollup(args.by_day_dir)
    headlines = write_headlines(result)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    rollup_json = args.out_dir / "cumulative-rollup.json"
    headlines_file = args.out_dir / "cumulative-headlines.txt"
    rollup_json.write_text(json.dumps(result, default=str, indent=2), encoding="utf-8")
    headlines_file.write_text(headlines, encoding="utf-8")
    print(headlines)
    print(f"\nFull JSON rollup: {rollup_json}", file=sys.stderr)
    print(f"Headlines:        {headlines_file}", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    failures = 0 if args.rollup_only else build_source_days(args)
    if not args.no_rollup:
        refresh_rollup(args)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
