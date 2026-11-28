"""The Interval B/A study readers' shared source layer: the replay day files, and the plumbing that
the three readers (enrich_interval_ba_outcomes.py, analyze_interval_ba_cuts.py and
analyze_confluence_vs_solo.py) would otherwise each carry a copy of.

Spec: docs/superpowers/specs/2026-11-26-interval-ba-replay-days-design.md, "Readers".

Sources (`--source`):

- days (the default): the replay day files in R2, `research/interval-ba/replay/{date}.parquet`,
  one per session, written each morning by the nightly `interval-ba-tape` step. The reader checks
  them first (`ensure_day_files`) and repairs before it refuses.
- export: the one-time snapshot `research/interval-ba/replay-{end}.parquet` (`--export-end`).
- table: `interval_ba_alerts` in Neon, read only, with the live feed's gaps.

The check. The days a run needs are the NYSE trading days of its range (nightly's calendar):
enrich's `--from-date` to `--to-date`, by default 2026-01-02 through the newest landed tape;
analyze's the days its outcomes CSV covers. A needed day is
- missing: it has no file, and its tape landed;
- stale: its file is older than its tape (a re-landed tape on a night the step does not run keeps
  its marker, so the step never rewrites the file);
- empty: its file's footer says it holds no alerts. No session fires fewer than 19, so a zero-row
  file is a replay or tape-read fault, and the nightly never rewrites a marked day: it is no good
  day, and the study would go ahead without that day's alerts. It is the third reason for a
  repair;
- not a gap when UW marked it unavailable (`fulltape/_unavailable/{day}.json`): it is printed,
  named in the report's header and skipped.
A missing, stale or empty day is repaired by the tool's per-day writer (`write_replay_days` in
interval_ba_tape.py, imported only then), and the run goes on over the files it lists again. The
repair is refused, with a message and no study, when a missing day has no tape, when the local
replay rule is not the files', when more than MAX_REPAIR_DAYS days need it (a broken nightly
write: the message prints the one `export --per-day` command that fills them; with no day file
at all it names the prefix and the backfill instead), inside the nightly window 07:15-12:30 UTC
(the message names the time to retry), when the writer's deployed-code guard would refuse (the
replay module is not origin/main's), or when a file it wrote holds no alerts, which a rerun meets
again for as long as the replay finds nothing.

`--dry-run` is a check, not a run: it never writes, lists the days a repair would write and the
problems that would refuse it and exits non-zero when there are any, and otherwise says the day
files are present and current. The readers stop there: no alert or tape is read.

More than one rule across the files read is refused too, naming the days on each rule (an empty
file's footer is still on a rule, so it counts). A footer that is missing, unreadable or names
another day is refused. Errors from R2 and DuckDB show their class only: their text can name the
account host.

Run as a script, scripts/ is on sys.path, so interval_ba_tape_runs and interval_ba_tape import
from here. They are imported inside the functions that need them, so a `--source table` or
`--source export` run loads neither.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, NoReturn
from zoneinfo import ZoneInfo

import duckdb

DAYS, EXPORT, TABLE = "days", "export", "table"
SOURCES = (DAYS, EXPORT, TABLE)

# The day files' prefix is nightly/src/interval_ba_replay.py's REPLAY_DAYS_PREFIX
# (test_interval_ba_days.py holds the copy to it). The tapes are `fulltape/{day}-fulltape.parquet`,
# and UW's not posting one is `fulltape/_unavailable/{day}.json` (nightly/src/r2_store.py).
DAYS_PREFIX = "research/interval-ba/replay/"
TAPE_PREFIX = "fulltape/"
STUDY_START = date(2026, 1, 2)  # the first session of the rebuilt record
# More days than this needing a repair point to a broken nightly write, not to a lagging one.
MAX_REPAIR_DAYS = 10

_CT = ZoneInfo("America/Chicago")
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_ISO_DAY = r"(\d{4}-\d{2}-\d{2})"
# A whole R2 key (fullmatch), against the end of whatever name DuckDB gives back (search).
_DAY_FILE = re.compile(re.escape(DAYS_PREFIX) + _ISO_DAY + r"\.parquet")
_TAPE = re.compile(re.escape(TAPE_PREFIX) + _ISO_DAY + r"-fulltape\.parquet")
_UNAVAILABLE = re.compile(re.escape(TAPE_PREFIX) + r"_unavailable/" + _ISO_DAY + r"\.json")
_DAY_SUFFIX = re.compile(_ISO_DAY + r"\.parquet$")
_R2_NAMES = ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT_URL", "R2_BUCKET_FULLTAPE")
_BACKFILL = "ml/.venv/Scripts/python.exe -I scripts/interval_ba_tape.py export --per-day"
_FROM_ORIGIN_MAIN = "run from a checkout at origin/main"


def _runs() -> Any:
    import interval_ba_tape_runs

    return interval_ba_tape_runs


def _tool() -> Any:
    import interval_ba_tape

    return interval_ba_tape


# --- The source arguments ---------------------------------------------------------------------


def iso_date(text: str) -> str:
    try:
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a YYYY-MM-DD date") from None


def add_source_arguments(parser: argparse.ArgumentParser) -> None:
    """--source, --export-end and --dry-run, the same on the three readers."""
    parser.add_argument(
        "--source",
        choices=SOURCES,
        default=None,
        help=(
            "Where the alerts come from: days, the replay day files in R2 (the default; a "
            "missing, stale or empty day is repaired first), export, the one-time snapshot "
            "replay-<end>.parquet in R2, or table, interval_ba_alerts in Neon (read only), which "
            "has the live feed's gaps."
        ),
    )
    parser.add_argument(
        "--export-end",
        type=iso_date,
        default=None,
        help=(
            "The snapshot to read, research/interval-ba/replay-<date>.parquet. Given alone it "
            "means --source export; with --source export and no date the newest in R2 is taken."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Write nothing. With the day files it is a check, not a run: it lists the days a "
            "repair would write, and what would refuse it, and exits non-zero when there are "
            "any; otherwise it says the day files are present and current and stops, reading no "
            "alert or tape. With the snapshot or the table it runs and skips the output files."
        ),
    )


def check_source_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Settle `args.source`: the day files, or the snapshot when only --export-end is given.
    --export-end with another source is a usage error (exit 2)."""
    if args.source is None:
        args.source = EXPORT if args.export_end is not None else DAYS
    elif args.source != EXPORT and args.export_end is not None:
        parser.error("--export-end goes with --source export")


# --- The outcomes CSV: its name, and how its alert ids read -----------------------------------

_KIND = {DAYS: "-days", EXPORT: "-export", TABLE: ""}


def kind_of(source: str) -> str:
    """What a source adds to the names of the files a run writes: `-days`, `-export`, or nothing
    for the table, whose names are the original ones."""
    return _KIND[source]


def outcomes_prefix(ticker: str, source: str) -> str:
    """The start of an outcomes CSV's name: interval-ba-outcomes[-days|-export][-<ticker>]-.

    SPXW from the table keeps the original name with no ticker, so existing CSVs and the analyze
    scripts' discovery need no migration; the other tickers carry a slug. The day files and the
    snapshot each write their own names, so a run never reads the paths of another source."""
    slug = "" if ticker == "SPXW" else f"-{ticker.lower()}"
    return f"interval-ba-outcomes{_KIND[source]}{slug}-"


def newest_outcomes_csv(out_dir: Path, ticker: str, source: str) -> Path | None:
    """The newest outcomes CSV the outcome script wrote for that ticker and source, or None.

    The stamp (digits) follows the prefix right away, which keeps the files of a longer prefix
    out: "-spy-", "-export-" and "-days-" files share the SPXW table prefix up to there."""
    prefix = outcomes_prefix(ticker, source)
    for path in sorted(out_dir.glob(f"{prefix}*.csv"), reverse=True):
        if path.name[len(prefix) :].split("-")[0].isdigit():
            return path
    return None


_TABLE_ID = re.compile(r"\d+")
_EXPORT_ID = re.compile(r"\S+@\d+")


def alert_id_reader(source: str, csv_name: str) -> Callable[[str], int | str]:
    """How the analyze scripts read an outcomes CSV's alert_id column.

    The table writes integer ids, the day files and the snapshot `<chain>@<bucket epoch>`. The
    CSV of the wrong kind is a named exit, not a raw ValueError from int('SPXW...@epoch') or a
    join of nothing; a blank or garbled id says that, instead of naming the other kind. The day
    files and the snapshot share an id format, so their CSVs are told apart by name: a day-file
    run never joins the paths of a snapshot's."""
    export_ids = source != TABLE
    other = {DAYS: EXPORT, EXPORT: DAYS}.get(source)
    if other is not None and csv_name.startswith(f"interval-ba-outcomes{_KIND[other]}-"):
        sys.exit(
            f"{csv_name} was written for --source {other}, not --source {source}: pass "
            f"--source {other}, or a {source} CSV with --csv."
        )
    expected = (
        "an export alert id (<chain>@<epoch>)" if export_ids else "a table alert id (an integer)"
    )

    def read(raw: str) -> int | str:
        is_export, is_table = _EXPORT_ID.fullmatch(raw), _TABLE_ID.fullmatch(raw)
        if export_ids and is_export:
            return raw
        if not export_ids and is_table:
            return int(raw)
        if is_table:
            sys.exit(
                f"{csv_name} holds table alert ids (integers such as {raw!r}), not export alert "
                f"ids (<chain>@<epoch>): pass --source table, or an export CSV with --csv."
            )
        if is_export:
            sys.exit(
                f"{csv_name} holds export alert ids ({raw!r}: <chain>@<epoch>), not table ids: "
                f"pass --source export (or days, for a day-files CSV), or a table CSV with --csv."
            )
        if not raw.strip():
            sys.exit(f"{csv_name} has a blank alert_id: expected {expected}.")
        sys.exit(f"{csv_name} has an alert_id that is not {expected}: {raw!r}.")

    return read


def csv_days(csv_path: Path) -> tuple[date, date]:
    """The first and last session date (CT) of an outcomes CSV's `fired_at` column: the days an
    analysis of it needs. Exits when the CSV has no rows."""
    first = last = None
    previous = ""
    with csv_path.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["fired_at"] == previous:  # a path's rows share its alert's fired_at
                continue
            previous = row["fired_at"]
            day = datetime.fromisoformat(previous).astimezone(_CT).date()
            first = day if first is None else min(first, day)
            last = day if last is None else max(last, day)
    if first is None or last is None:
        sys.exit(f"{csv_path.name} has no rows, so there are no days to read.")
    return first, last


# --- The method banner of the generated reports -----------------------------------------------

# The rebuild's methodology changes, one line each (owner rule: no silent methodology changes).
# The two analysis reports open with it, and the three scripts' headers say the same.
METHOD_BANNER = "\n".join(
    [
        "> **Method change (2026-11-26, the Interval B/A rebuild).** These numbers follow the "
        "rebuilt method and are not comparable with reports from before it:",
        ">",
        "> - (a) t=0 is the root's last print at or before `fired_at`.",
        "> - (b) The forward steps are `fired_at` + 5k min.",
        "> - (c) The default source is the replay day files, not the live table.",
        "> - (d) Confluence looks backward only, and a partner at the same instant counts.",
        "> - (e) Half-day paths end at the early close.",
    ]
)


# --- Reading the alerts of a parquet source ---------------------------------------------------

# The columns the scripts read, in the replay module's order (nightly/src/interval_ba_replay.py
# EXPORT_COLUMNS, which test_interval_ba_days.py holds this copy to). The scripts import nothing
# of nightly: a production run hashes the tool's files.
ALERT_COLUMNS = (
    "option_chain",
    "ticker",
    "option_type",
    "strike",
    "expiry",
    "bucket_start",
    "fired_at",
    "ratio_pct",
    "total_premium",
    "trade_count",
    "top_trade_is_sweep",
    "top_trade_is_floor",
    "underlying_price",
)


def check_columns(con: Any, url: str | list[str], label: str) -> None:
    """Exit naming any column the scripts read that the parquet (one file, or the list) lacks."""
    have = {
        c[0]
        for c in con.execute("SELECT * FROM read_parquet($url) LIMIT 0", {"url": url}).description
    }
    missing = [c for c in ALERT_COLUMNS if c not in have]
    if missing:
        sys.exit(f"{label} lacks column(s) this script reads: {', '.join(missing)}")


def fetch_alerts(
    con: Any,
    url: str | list[str],
    ticker: str | None,
    from_date: str | None,
    to_date: str | None,
    limit_alerts: int | None,
) -> list[dict[str, Any]]:
    """The alerts of a parquet source (one file, or a list of them), shaped like the table's
    rows: the same keys and Python types.

    `ticker` None reads every ticker in one call. The files have no ids, so `id` is the table's
    unique key, the contract and its bucket. Times leave DuckDB as epoch microseconds (a
    TIMESTAMPTZ needs pytz to come out as a datetime) and become aware UTC datetimes here."""
    where = ["true"]
    params: dict[str, object] = {"url": url}
    if ticker is not None:
        where.append("ticker = $ticker")
        params["ticker"] = ticker
    if from_date:
        where.append("expiry >= CAST($from_date AS DATE)")
        params["from_date"] = from_date
    if to_date:
        where.append("expiry <= CAST($to_date AS DATE)")
        params["to_date"] = to_date
    sql = (
        "SELECT option_chain, ticker, option_type, strike, expiry, "
        "epoch_us(fired_at) AS fired_us, ratio_pct, total_premium, trade_count, "
        "underlying_price, top_trade_is_sweep, top_trade_is_floor, "
        "epoch_us(bucket_start) AS bucket_us "
        "FROM read_parquet($url) WHERE "
        + " AND ".join(where)
        + " ORDER BY fired_at ASC, option_chain ASC"
    )
    if limit_alerts is not None:
        sql += f" LIMIT {int(limit_alerts)}"
    cur = con.execute(sql, params)
    cols = [c[0] for c in cur.description]
    alerts = []
    for row in cur.fetchall():
        r = dict(zip(cols, row, strict=True))
        fired_us = r.pop("fired_us")
        bucket_us = r.pop("bucket_us")
        alerts.append(
            {
                "id": f"{r['option_chain']}@{bucket_us // 1_000_000}",
                **r,
                "fired_at": _EPOCH + timedelta(microseconds=fired_us),
            }
        )
    return alerts


# --- The day files: what is there, what a run needs, what is missing --------------------------


def day_url(day: date) -> str:
    bucket = os.environ.get("R2_BUCKET_FULLTAPE", "").strip()
    if not bucket:
        sys.exit("Missing env var R2_BUCKET_FULLTAPE (set it in .env.local)")
    return f"s3://{bucket}/{DAYS_PREFIX}{day.isoformat()}.parquet"


@dataclass(frozen=True)
class Listing:
    """What R2 holds: each day file's and each tape's LastModified, and the days UW has marked
    unavailable."""

    files: Mapping[date, datetime]
    tapes: Mapping[date, datetime]
    unavailable: frozenset[date]


def _days_of(objects: Mapping[str, datetime], pattern: re.Pattern[str]) -> dict[date, datetime]:
    found: dict[date, datetime] = {}
    for key, modified in objects.items():
        match = pattern.fullmatch(key)
        if match is None:
            continue
        try:
            found[date.fromisoformat(match[1])] = modified
        except ValueError:  # a date the calendar does not have: not a day file
            continue
    return found


def parse_listing(
    day_objects: Mapping[str, datetime], tape_objects: Mapping[str, datetime]
) -> Listing:
    """The two prefix listings as days. Only the exact key shapes count: `fulltape/` also holds
    `_superseded/` copies and the `_unavailable/` markers, and the day prefix may hold anything."""
    return Listing(
        files=_days_of(day_objects, _DAY_FILE),
        tapes=_days_of(tape_objects, _TAPE),
        unavailable=frozenset(_days_of(tape_objects, _UNAVAILABLE)),
    )


@dataclass(frozen=True)
class Plan:
    """A run's needed days, sorted into: `keep` (a file, not older than its tape), `missing` (no
    file, a tape landed), `stale` (a file older than its tape), `no_tape` (no file and no tape,
    and UW has not said so), `unavailable` (no file and no tape, which UW marked as not posted:
    not a gap) and `empty` (a kept file whose footer says it holds no alerts: `with_empty` moves
    it out of `keep`, once the footers are read)."""

    keep: tuple[date, ...]
    missing: tuple[date, ...]
    stale: tuple[date, ...]
    no_tape: tuple[date, ...]
    unavailable: tuple[date, ...]
    empty: tuple[date, ...] = ()

    @property
    def to_repair(self) -> list[date]:
        return sorted((*self.missing, *self.stale, *self.empty))


def plan(needed: Sequence[date], listing: Listing) -> Plan:
    keep, missing, stale, no_tape, unavailable = [], [], [], [], []
    for day in needed:
        file_at, tape_at = listing.files.get(day), listing.tapes.get(day)
        if file_at is not None:
            (stale if tape_at is not None and file_at < tape_at else keep).append(day)
        elif tape_at is not None:
            missing.append(day)
        elif day in listing.unavailable:
            unavailable.append(day)
        else:
            no_tape.append(day)
    return Plan(*(tuple(group) for group in (keep, missing, stale, no_tape, unavailable)))


def with_empty(p: Plan, footers: Mapping[date, Footer]) -> Plan:
    """`p` with every kept day whose footer holds no alerts moved from `keep` to `empty`, the
    third reason for a repair. A zero-row file is a replay or tape-read fault, and a rerun must
    not read it as a good day: the replay either finds the alerts now, or the repair's own
    zero-row refusal meets it again on every run."""
    empty = tuple(day for day in p.keep if footers[day].rows == 0)
    return replace(p, keep=tuple(day for day in p.keep if day not in empty), empty=empty)


# --- The footers: each file's rule and row count ----------------------------------------------


@dataclass(frozen=True)
class Footer:
    day: date
    rows: int
    rule: dict[str, str]


def _quiet_duckdb(what: str, exc: duckdb.Error) -> NoReturn:
    """Exit with a DuckDB error's class alone: over httpfs its text carries the endpoint host,
    which is the R2 account id."""
    sys.exit(
        f"{what} failed: {type(exc).__name__} (its text is not shown: it can name the R2 host)."
    )


def _parse_footer(text: object) -> Footer | None:
    try:
        meta = json.loads(text)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not isinstance(meta, dict):
        return None
    day, rule, rows = meta.get("day"), meta.get("rule"), meta.get("rows")
    if not isinstance(rule, dict) or isinstance(rows, bool) or not isinstance(rows, int):
        return None
    if not isinstance(day, str):
        return None
    try:
        return Footer(date.fromisoformat(day), rows, rule)
    except ValueError:
        return None


def read_footers(con: Any, urls: Mapping[date, str]) -> dict[date, Footer]:
    """The `interval_ba` footer of each day file, read from the Parquet metadata alone (no
    rows). Exits naming every file whose footer is missing or unreadable (a file the nightly
    step or the tool wrote always has one), and every one whose footer names another day than
    its key (it was copied to the wrong key, and would be read twice)."""
    if not urls:
        return {}
    try:
        found = con.execute(
            "SELECT file_name, decode(value) FROM parquet_kv_metadata($urls)"
            " WHERE decode(key) = 'interval_ba'",
            {"urls": list(urls.values())},
        ).fetchall()
    except duckdb.Error as exc:
        _quiet_duckdb("Reading the day files' footers", exc)
    texts = {m[1]: text for name, text in found if (m := _DAY_SUFFIX.search(name))}
    footers: dict[date, Footer] = {}
    damaged: list[date] = []
    misplaced: dict[date, date] = {}
    for day in sorted(urls):
        footer = _parse_footer(texts.get(day.isoformat()))
        if footer is None:
            damaged.append(day)
        elif footer.day != day:
            misplaced[day] = footer.day
        else:
            footers[day] = footer
    fix = f"`{_BACKFILL} --from <day> --to <day>`, {_FROM_ORIGIN_MAIN}"
    if damaged:
        sys.exit(
            f"{_name_days(damaged)}: the day file has no readable `interval_ba` footer (its day, "
            f"rows and rule), so it was not written by the nightly step or the tool. Rewrite it "
            f"with {fix}."
        )
    if misplaced:
        names = ", ".join(footer_day.isoformat() for _, footer_day in sorted(misplaced.items()))
        sys.exit(
            f"{_name_days(list(misplaced))}: the day file's footer names another day ({names}), "
            f"so the file sits under the wrong key and its alerts would be read twice. Rewrite "
            f"the day with {fix}."
        )
    return footers


def _canonical(rule: Mapping[str, str]) -> str:
    return json.dumps(rule, sort_keys=True)


def _differing(rules: Sequence[Mapping[str, str]]) -> list[str]:
    """The names of the rule entries that are not the same in every one of `rules`."""
    names = sorted({name for rule in rules for name in rule})
    return [name for name in names if len({rule.get(name) for rule in rules}) > 1]


def _name_days(days: Sequence[date]) -> str:
    """The days, all of them when there are twelve or fewer, else the count and the span and
    the first twelve, so scattered days are not read as every session of their span."""
    shown = sorted(days)
    if len(shown) <= 12:
        return ", ".join(day.isoformat() for day in shown)
    first = ", ".join(day.isoformat() for day in shown[:12])
    return (
        f"{len(shown)} days between {shown[0]} and {shown[-1]}: {first}, and {len(shown) - 12} more"
    )


def refuse_mixed_rules(footers: Mapping[date, Footer]) -> None:
    """Exit when the files are not all on one rule, naming the days on each and how the rules
    differ. The fix is a hand step: the tool writes the rule of the replay module at origin/main,
    so every day not on it is written again from a checkout there."""
    groups: dict[str, list[date]] = defaultdict(list)
    for day, footer in sorted(footers.items()):
        groups[_canonical(footer.rule)].append(day)
    if len(groups) < 2:
        return
    rules = [footers[group[0]].rule for group in groups.values()]
    differing = _differing(rules)
    lines = [f"The day files are not one study: they hold {len(groups)} different rules."]
    for n, (group_days, rule) in enumerate(zip(groups.values(), rules, strict=True), start=1):
        how = ", ".join(f"{name} {rule.get(name)}" for name in differing)
        lines.append(f"  rule {n} ({how}): {_name_days(group_days)}")
    lines.append(
        "Write every day that is not on the rule of the replay module at origin/main again, with "
        f"`{_BACKFILL} --from <first day> --to <last day>`, {_FROM_ORIGIN_MAIN}."
    )
    sys.exit("\n".join(lines))


# --- The check and the repair -----------------------------------------------------------------


@dataclass(frozen=True)
class DayFiles:
    """The day files a run reads: their days and URLs, ascending, and what the check did.

    `repaired` days were missing, stale or empty and have been written again; `unavailable`
    days are ones UW did not post, skipped. No day read holds no alerts: such a file is repaired,
    or the run is refused."""

    days: tuple[date, ...]
    urls: tuple[str, ...]
    repaired: tuple[date, ...]
    unavailable: tuple[date, ...]
    replay_version: str | None

    @property
    def first(self) -> date:
        return self.days[0]

    @property
    def last(self) -> date:
        return self.days[-1]

    @property
    def count(self) -> int:
        return len(self.days)

    def describe(self) -> str:
        """One sentence for a report's header: the source, its span, and what this run did."""
        version = f"; replay version {self.replay_version}" if self.replay_version else ""
        unit = "day" if self.count == 1 else "days"
        text = (
            f"the replay day files in `{DAYS_PREFIX}` "
            f"({self.count} {unit}, {self.first} to {self.last}{version})"
        )
        if self.repaired:
            text += (
                f". This run repaired {_name_days(self.repaired)}: the nightly should have "
                "written them"
            )
        if self.unavailable:
            text += f". Skipped, UW posted no tape: {_name_days(self.unavailable)}"
        return text

    def analysis_note(self) -> str:
        """For an analysis run: the days repaired after its outcomes CSV was priced, if any. That
        CSV was built from the day files as they were, so a rewritten day may differ from what
        enrich saw. Empty when nothing was repaired."""
        if not self.repaired:
            return ""
        return (
            f"Rewritten after the outcomes CSV was priced: {_name_days(self.repaired)}. Re-run "
            "enrich_interval_ba_outcomes.py for those days."
        )


def _r2_env() -> dict[str, str]:
    env = {name: os.environ.get(name, "").strip() for name in _R2_NAMES}
    missing = [name for name, value in env.items() if not value]
    if missing:
        sys.exit(f"Missing env var(s) {', '.join(missing)} (set them in .env.local)")
    return env


def _list_prefix(runs: Any, r2: Any, prefix: str) -> dict[str, datetime]:
    try:
        return runs.list_objects(r2, prefix)
    except runs.QUIET_ERRORS as exc:
        sys.exit(
            f"Listing {prefix} in R2 failed ({type(exc).__name__}; its text is not shown, as it "
            "can name the account). Check the R2_* values in .env.local and the token's list "
            "permission."
        )


def _trading_days(runs: Any, first: date, last: date) -> list[date]:
    if first > last:
        sys.exit(f"Nothing to read: {first} is after {last}.")
    try:
        needed = runs.trading_days(first, last)
    except runs.UsageError as exc:  # a range past the years the calendar covers
        sys.exit(str(exc))
    if not needed:
        sys.exit(f"No trading day from {first} to {last}.")
    return needed


def _problems(
    runs: Any, p: Plan, footers: Mapping[date, Footer], *, no_day_file_at_all: bool
) -> list[str]:
    """Why a repair cannot go ahead, one message each, in the order the owner would fix them.
    `no_day_file_at_all`: the day-file prefix holds nothing, whatever days this run needs."""
    problems: list[str] = []
    if p.no_tape:
        problems.append(
            f"No tape in R2 for {_name_days(p.no_tape)}, and no unavailable marker, so the day "
            "file cannot be rebuilt: wait for the nightly run to land the tape, or use "
            "--source table."
        )
    repair = p.to_repair
    if not repair:
        return problems
    local = runs.ibr.rule()
    for rule in {_canonical(f.rule): f.rule for f in footers.values()}.values():
        if rule != local:
            gap = ", ".join(
                f"{name}: {rule.get(name)} in the files, {local.get(name)} here"
                for name in _differing([rule, local])
            )
            problems.append(
                f"The replay rule here is not the day files' ({gap}), so a repair would leave "
                f"two studies in one prefix. Write every day again with `{_BACKFILL} --from "
                f"<first day> --to <last day>`, {_FROM_ORIGIN_MAIN}."
            )
    fill = f"{_FROM_ORIGIN_MAIN}: {_BACKFILL} --from {repair[0]} --to {repair[-1]}"
    if len(repair) > MAX_REPAIR_DAYS and no_day_file_at_all:
        # Before the backfill, or after one into the wrong bucket: not a broken nightly write.
        problems.append(
            f"No day file under {DAYS_PREFIX} in R2, and the tapes of {len(repair)} days have "
            f"landed, so the backfill has not run (or wrote to another bucket). Write them with "
            f"one command, {fill}"
        )
    elif len(repair) > MAX_REPAIR_DAYS:
        problems.append(
            f"{len(repair)} day files need a repair, more than {MAX_REPAIR_DAYS}: that points to "
            f"a broken nightly write, so none is repaired here. Fill them with one command, "
            f"{fill}"
        )
    now = runs.utc_now()
    window_end = runs.nightly_window_end(now)
    if window_end is not None:
        problems.append(
            f"No repair now: {now:%H:%M} UTC is inside 07:15-12:30 UTC, the nightly run's "
            f"window, where the step may write a day file. Retry after {window_end:%H:%M} UTC "
            f"({window_end.astimezone(_CT):%H:%M} CT)."
        )
    try:  # the writer's own first check: asked here, so a dry run does not promise what it won't do
        runs.refuse_unless_deployed_code()
    except runs.RefusedError as exc:
        problems.append(f"The repair would be refused: {exc}")
    return problems


def _dry_run_report(p: Plan, listing: Listing, problems: Sequence[str]) -> str:
    def at(moment: datetime) -> str:
        return f"{moment:%Y-%m-%d %H:%M} UTC"

    lines = ["--dry-run: nothing was written."]
    if p.to_repair:
        lines.append(f"{len(p.to_repair)} day file(s) would be repaired:")
    for day in p.to_repair:
        if day in p.stale:
            lines.append(
                f"  {day}  stale: its file ({at(listing.files[day])}) is older than its tape "
                f"({at(listing.tapes[day])})"
            )
        elif day in p.empty:
            lines.append(
                f"  {day}  no alerts: its file holds no alerts (a replay or tape-read fault), "
                "so the day would be replayed again"
            )
        else:
            lines.append(f"  {day}  missing: its tape landed ({at(listing.tapes[day])})")
    lines.extend(problems)
    return "\n".join(lines)


def _write(runs: Any, to_repair: list[date]) -> list[Any]:
    """The tool's per-day writer over the days, with its refusals as exits. It never touches
    Neon, and it refuses unless the replay module is origin/main's."""
    tool = _tool()
    try:
        return tool.write_replay_days(to_repair, allow_market_hours=True)
    except runs.RefusedError as exc:
        sys.exit(f"The repair was refused: {exc}")
    except runs.UsageError as exc:
        sys.exit(f"The repair cannot run: {exc}")
    except runs.CheckFailedError as exc:  # its text names days, keys, ids and counts only
        sys.exit(f"The repair stopped: {exc}")
    except ValueError as exc:  # replay_day's: no 0DTE rows, a damaged tape; names the tape key
        sys.exit(f"The repair stopped: {exc}")
    except runs.QUIET_ERRORS as exc:
        sys.exit(
            f"The repair failed: {type(exc).__name__} (its text is not shown: it can name a host)."
        )
    except duckdb.Error as exc:
        _quiet_duckdb("The repair", exc)


def _repair(runs: Any, r2: Any, listing: Listing, needed: Sequence[date], p: Plan) -> None:
    """Write each missing or stale day, then list the prefix again: every one must be there, and
    none may hold no alerts, or no study runs."""
    written = _write(runs, p.to_repair)
    empty = [done.day for done in written if done.rows == 0]
    if empty:
        sys.exit(
            f"The repair wrote a day file with no alerts for {_name_days(empty)}. No session "
            "fires fewer than 19, so the replay or the tape read is at fault, and no study runs "
            f"on it. Fix the cause, then write the day again with `{_BACKFILL} --from "
            f"{min(empty)} --to {max(empty)}`, {_FROM_ORIGIN_MAIN}."
        )
    files = _days_of(_list_prefix(runs, r2, DAYS_PREFIX), _DAY_FILE)
    after = plan(needed, replace(listing, files=files))
    if after.missing or after.stale:
        sys.exit(
            f"The repair wrote {len(written)} day file(s), but {_name_days(after.to_repair)} "
            "still read as missing or stale in R2's listing. Check the interval-ba-tape step, "
            "and try again."
        )


def ensure_day_files(con: Any, first: date | None, last: date | None, *, dry_run: bool) -> DayFiles:
    """The day files a run needs, checked and, where it can be, repaired; see the module's
    header. `first` and `last` bound the trading days needed: by default 2026-01-02 through the
    newest landed tape. Exits, with the message, on any refusal; with `dry_run` it never writes,
    and exits non-zero when anything needs a repair or would refuse one, else says the files are
    present and current and returns, for the reader to stop. Returns the files to read."""
    runs = _runs()
    r2 = runs.r2_bucket(_r2_env())
    day_objects = _list_prefix(runs, r2, DAYS_PREFIX)
    tape_objects = _list_prefix(runs, r2, TAPE_PREFIX)
    listing = parse_listing(day_objects, tape_objects)
    if last is None:
        if not listing.tapes:
            sys.exit(
                f"No day file under {DAYS_PREFIX} in R2, and no tape under {TAPE_PREFIX} to "
                "build one from."
            )
        last = max(listing.tapes)
    needed = _trading_days(runs, first or STUDY_START, last)
    p = plan(needed, listing)
    # Every kept file's footer is read first, so the rule check sees them all (an empty file is
    # still on a rule) and the empty ones count toward the limit of ten.
    footers = read_footers(con, {day: day_url(day) for day in p.keep})
    refuse_mixed_rules(footers)
    p = with_empty(p, footers)
    problems = _problems(runs, p, footers, no_day_file_at_all=not listing.files)
    if dry_run and (p.to_repair or problems):
        sys.exit(_dry_run_report(p, listing, problems))
    if problems:
        sys.exit("\n".join(problems))
    if p.to_repair:
        _repair(runs, r2, listing, needed, p)
        for day in p.to_repair:
            how = (
                "stale: its tape landed after it"
                if day in p.stale
                else "its file held no alerts"
                if day in p.empty
                else "missing"
            )
            print(
                f"  {day}  repaired ({how}): the nightly should have written it; check the "
                "interval-ba-tape step"
            )
    days = sorted({*p.keep, *p.to_repair})
    if not days:
        sys.exit(
            f"No day file under {DAYS_PREFIX} in R2 for {first or STUDY_START} to {last}: UW has "
            "posted no tape for any of those days."
        )
    if p.unavailable:
        print(f"  skipped, UW has not posted a tape for: {_name_days(p.unavailable)}")
    rules = [footers[day].rule for day in p.keep] or [runs.ibr.rule()]
    files = DayFiles(
        days=tuple(days),
        urls=tuple(day_url(day) for day in days),
        repaired=tuple(p.to_repair),
        unavailable=p.unavailable,
        replay_version=rules[0].get("replay-version"),
    )
    print(f"Day files: {files.describe()}")
    if dry_run:
        unit = "day file" if files.count == 1 else "day files"
        verb = "is" if files.count == 1 else "are"
        print(
            f"--dry-run: the {files.count} {unit}, {files.first} to {files.last}, {verb} present "
            "and current; nothing to repair."
        )
    return files


def read_day_alerts(
    con: Any,
    files: DayFiles,
    ticker: str | None,
    from_date: str | None = None,
    to_date: str | None = None,
    limit_alerts: int | None = None,
) -> list[dict[str, Any]]:
    """The alerts of the day files, shaped like the table's rows. `ticker` None takes all three.
    Exits, naming the prefix, when the files lack a column the scripts read, and with the class
    of a DuckDB error alone (its text can name the R2 host)."""
    urls = list(files.urls)
    try:
        check_columns(con, urls, DAYS_PREFIX)
        return fetch_alerts(con, urls, ticker, from_date, to_date, limit_alerts)
    except duckdb.Error as exc:
        _quiet_duckdb("Reading the day files", exc)
