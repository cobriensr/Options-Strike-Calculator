"""The research-derive step: per-day research state, built from the landed tape in R2.

Each night, after the tape job, it derives three families of state for every day whose stored
fingerprint is not the one its tape and fires give now, newest first, and keeps them under
`research/` (the research reports read them in place of the tape):

- `chains`: the per-chain EOD aggregates (`_eod_flow.build_chains`), for landed days from
  CHAINS_START. Fingerprint `{tape ETag}|v{CHAINS_VERSION}`.
- `exit-policy` and `flow-timing`: the per-fire policy values and inversion timings of the two
  report scripts (`derive_day` in each), for the days the database has fires for. Fingerprint
  `{tape ETag}|v{DERIVE_VERSION}|{md5}`, the version being the family's own script's. The md5
  is the script's `fingerprint_rows` over the day's fires; its SQL twin, `day_fingerprints`,
  gives the pre-check one query for every day. The stored one is computed from the rows the
  derive used, not copied from the pre-check, so a day whose fires changed in between reads as
  stale once more tomorrow, never as fresh on rows it did not use.

The manifest (`MANIFEST_KEY`) maps family to day to fingerprint. A day is stale when its entry
is not the target. The literal `SEED` in `chains` marks the days seeded from the retired CSV
archive: they are never rebuilt, whatever the tape's ETag does. It is not fresh for any other
family.

Per day: one download (held to FETCH_DEADLINE_SECONDS, or to the step's deadline if nearer),
then the due families in order, then the manifest. The objects are written first and the
manifest once afterwards, so a run killed at any point loses at most the day in flight: its
objects are overwritten by the next night's, and its entries were never saved. A day whose
manifest save fails is a failed day, but its entries stay in the in-memory manifest (its objects
are in R2 and its fingerprints are right), so the next day's save records them.

The database connection of a day opens after its download and its chains, and only for the fire
families: Neon never idles through a download or a DuckDB build. The setup's connection (the
targets) closes before the reader opens. The reader has its own directory (RESEARCH_TAPE_DIR):
a day `enrich-outcomes` fetched earlier in the same run is fetched again, up to 600 s each (the
owner accepted it on 2026-11-06; R2 egress is free).

Failures: an Exception in a day (its download, a build, a derive, an upload, the manifest save)
is counted in `days_failed`, sent once through `capture_exception` tagged with the step and the
day (`monitoring.scrub_event` cuts a data library's text), and the loop goes on, up to
RESEARCH_MAX_DAY_FAILURES; the days after that are `days_left`. A malformed manifest fails the
step before anything is read or written, and is never reset: that covers a stored JSON `null`,
which the store reads back as it does a missing key. A day whose tape is gone from R2 since the
listing is `days_tape_missing`: neither derived nor failed. A cached tape file that will not
delete (an OSError) is logged by class and changes nothing else.

Status: `failed` if a day failed or the manifest is malformed, else `partial` if days are left
(they come first) or the last session's tape has not landed, else `ok`. The details are fixed
phrases: they are part of the Sentry fingerprint. Logs carry one line per day: the date, the
families written, the rows and the seconds, or the exception class. Never an exception's text
(it can carry the Neon host) or row data.

Register it through `pipeline.lazy_step`, and never import it at pipeline load: a failure to
import this module, or the scripts it imports, then fails this step alone and never the tape.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from time import monotonic
from types import MappingProxyType
from typing import TYPE_CHECKING, Literal, get_args

import exit_policy_search
import flow_inversion_timing
import sentry_sdk
from _eod_flow import CHAINS_START, CHAINS_VERSION, build_chains
from _tape_reader import FETCH_DEADLINE_SECONDS

from constants import (
    RESEARCH_DAY_BUDGET_SECONDS,
    RESEARCH_MAX_DAY_FAILURES,
    RESEARCH_TAPE_DIR,
    RESEARCH_WORK_DIR,
)
from r2_store import R2Store
from research_store import ResearchStore
from resources import connect_db, open_reader
from steps import StepContext, StepResult

if TYPE_CHECKING:
    from types import ModuleType

    import pandas as pd
    from _tape_reader import TapeReader
    from psycopg2.extensions import connection

log = logging.getLogger(__name__)

MANIFEST_KEY = "research/_state/derive-manifest.json"
# The manifest entry of a chains day seeded from the retired CSV archive.
SEED = "seed"
_MANIFEST_VERSION = 1

FamilyName = Literal["chains", "exit-policy", "flow-timing"]
FAMILIES: tuple[FamilyName, ...] = get_args(FamilyName)
# D5's three state keys: the object a family keeps for a day.
FAMILY_KEYS: Mapping[FamilyName, Callable[[date], str]] = MappingProxyType(
    {
        "chains": lambda day: f"research/eod-flow/by-day/{day.isoformat()}-chains.parquet",
        "exit-policy": lambda day: f"research/exit-policy/derived/{day.isoformat()}.parquet",
        "flow-timing": lambda day: f"research/flow-timing/derived/{day.isoformat()}.parquet",
    }
)
# The two families the report scripts derive. Their functions are read off the module when
# used, so each family always gets its own script's `DERIVE_VERSION`.
_FIRE_SCRIPTS = MappingProxyType(
    {"exit-policy": exit_policy_search, "flow-timing": flow_inversion_timing}
)


def _exit_policy_derive(
    script: ModuleType, conn: connection, day: date, tape_path: Path, fires: pd.DataFrame
) -> pd.DataFrame:
    return script.derive_day(tape_path, fires)


def _flow_timing_derive(
    script: ModuleType, conn: connection, day: date, tape_path: Path, fires: pd.DataFrame
) -> pd.DataFrame:
    return script.derive_day(conn, day, tape_path, fires)


# How each fire family calls its script's `derive_day`, whose arguments differ: exit-policy
# reads only the tape and the fires, flow-timing also reads the day's net flow through `conn`.
# The function is looked up on the script module when called, so a patch on the module holds.
_FIRE_DERIVES = MappingProxyType(
    {"exit-policy": _exit_policy_derive, "flow-timing": _flow_timing_derive}
)

# The `step` tag on a day's exception: the name pipeline.STEPS registers this step under.
_STEP = "research-derive"
# Fixed phrases: they are part of the `nightly step failed` / `partial` fingerprint.
_FAILED_DETAIL = "a day failed to derive"
_MANIFEST_DETAIL = "derive manifest is malformed"
_PARTIAL_DETAIL = "days left for the next night"
_NOT_LANDED_DETAIL = "latest session tape not landed"

_COUNT_NAMES = (
    "days_planned",
    "days_derived",
    "days_left",
    "days_failed",
    "days_tape_missing",
    "chains_written",
    "exit_policy_written",
    "flow_timing_written",
    "rows_written",
)
_WRITTEN_COUNT: Mapping[FamilyName, str] = MappingProxyType(
    {
        "chains": "chains_written",
        "exit-policy": "exit_policy_written",
        "flow-timing": "flow_timing_written",
    }
)


class ManifestError(Exception):
    """The derive manifest in R2 is not one this step wrote. Messages name the key and a
    fixed reason, never a fingerprint or a body."""


def _malformed(reason: str) -> ManifestError:
    return ManifestError(f"{MANIFEST_KEY}: {reason}")


def _is_iso_day(text: str) -> bool:
    """Whether `text` is a day as `date.isoformat` spells it (`fromisoformat` takes more)."""
    try:
        return date.fromisoformat(text).isoformat() == text
    except ValueError:
        return False


def _checked_families(raw: object) -> dict[str, dict[str, str]]:
    """The `families` of a decoded manifest, or ManifestError for any other shape."""
    if not isinstance(raw, dict) or set(raw) != {"version", "families"}:
        raise _malformed("not a manifest object")
    version = raw["version"]
    if type(version) is not int or version != _MANIFEST_VERSION:
        raise _malformed("unsupported version")
    families = raw["families"]
    if not isinstance(families, dict):
        raise _malformed("families is not an object")
    checked: dict[str, dict[str, str]] = {}
    for name, days in families.items():
        if name not in FAMILY_KEYS:
            raise _malformed("unknown family")
        if not isinstance(days, dict):
            raise _malformed(f"family {name} is not an object")
        for day, fingerprint in days.items():
            if not _is_iso_day(day) or not isinstance(fingerprint, str) or not fingerprint:
                raise _malformed(f"bad entry in family {name}")
        checked[name] = dict(days)
    return checked


@dataclass
class Manifest:
    """family -> day (ISO) -> fingerprint; `{"version": 1, "families": {...}}` in R2."""

    families: dict[str, dict[str, str]] = field(default_factory=dict)

    @classmethod
    def load(cls, store: ResearchStore) -> Manifest:
        """The stored manifest; empty when there is none, ManifestError when it is malformed.

        A read the store cannot make (a refusal, a 5xx) is not a ManifestError: it propagates.
        """
        try:
            raw = store.get_json(MANIFEST_KEY)
        except ValueError:  # the store's: the body is not valid UTF-8 JSON
            raise _malformed("not valid JSON") from None
        if raw is None:
            # `get_json` gives None for a missing key and for a stored JSON `null` alike, and
            # only the first may start an empty manifest: the second would reset it silently.
            if MANIFEST_KEY in store.list(MANIFEST_KEY):
                raise _malformed("body is null")
            return cls()
        return cls(_checked_families(raw))

    def get(self, family: FamilyName, day: date) -> str | None:
        return self.families.get(family, {}).get(day.isoformat())

    def set(self, family: FamilyName, day: date, fp: str) -> None:
        self.families.setdefault(family, {})[day.isoformat()] = fp

    def save(self, store: ResearchStore) -> None:
        """Write the whole manifest as one object, families and days sorted."""
        store.put_json(
            MANIFEST_KEY,
            {
                "version": _MANIFEST_VERSION,
                "families": {
                    family: dict(sorted(days.items()))
                    for family, days in sorted(self.families.items())
                },
            },
        )


def targets(
    conn: connection, etags: Mapping[date, str], last_session: date
) -> dict[FamilyName, dict[date, str]]:
    """The fingerprint each family's day should hold now, for the days it covers.

    `etags` is the tape listing (`R2Store.tape_etags`), so a day without a tape is in no
    family. Days after `last_session` are left out. Chains cover the landed days from
    CHAINS_START; each fire family covers the days its `day_fingerprints` names that have a
    tape. One query per fire family.
    """
    landed = {day: etag for day, etag in etags.items() if day <= last_session}
    wanted: dict[FamilyName, dict[date, str]] = {
        "chains": {
            day: f"{etag}|v{CHAINS_VERSION}" for day, etag in landed.items() if day >= CHAINS_START
        },
        "exit-policy": {},
        "flow-timing": {},
    }
    for family, script in _FIRE_SCRIPTS.items():
        for day, digest in script.day_fingerprints(conn).items():
            etag = landed.get(day)
            if etag is not None:
                wanted[family][day] = f"{etag}|v{script.DERIVE_VERSION}|{digest}"
    return wanted


def _is_fresh(manifest: Manifest, family: FamilyName, day: date, target: str) -> bool:
    stored = manifest.get(family, day)
    return stored == target or (family == "chains" and stored == SEED)


def stale_days(
    manifest: Manifest, targets: Mapping[FamilyName, Mapping[date, str]]
) -> dict[date, tuple[FamilyName, ...]]:
    """The days with something to derive, newest first, each with its stale families.

    The families of a day come in the order of FAMILIES (chains, exit-policy, flow-timing).
    """
    due: dict[date, list[FamilyName]] = {}
    for family in FAMILIES:
        for day, target in targets.get(family, {}).items():
            if not _is_fresh(manifest, family, day, target):
                due.setdefault(day, []).append(family)
    return {day: tuple(due[day]) for day in sorted(due, reverse=True)}


def fresh_days(
    manifest: Manifest, targets: Mapping[FamilyName, Mapping[date, str]], family: FamilyName
) -> list[date]:
    """The days of `family` whose stored state is current, oldest first.

    A seeded chains day counts; a `SEED` in any other family does not.
    """
    return sorted(
        day
        for day, target in targets.get(family, {}).items()
        if _is_fresh(manifest, family, day, target)
    )


@dataclass
class _DayProgress:
    """What one day has stored in R2 so far, which survives the day raising."""

    families: list[FamilyName] = field(default_factory=list)
    rows: int = 0


def run(ctx: StepContext) -> StepResult:
    counts = dict.fromkeys(_COUNT_NAMES, 0)
    store = ResearchStore(ctx.settings)
    try:
        manifest = Manifest.load(store)
    except ManifestError as exc:
        # Nothing is read or written: a manifest that is reset would redo every day, and the
        # seeded chains with them.
        log.error("research-derive: %s", exc)
        return StepResult("failed", counts, _MANIFEST_DETAIL)
    etags = R2Store(ctx.settings).tape_etags()
    # One short connection for the setup; a day opens its own after its download.
    with connect_db(ctx.settings) as conn:
        wanted = targets(conn, etags, ctx.last_session)
    stale = stale_days(manifest, wanted)
    counts["days_planned"] = len(stale)
    if stale:
        _derive_days(ctx, store, manifest, etags, stale, counts)
    return _result(counts, last_session_landed=ctx.last_session in etags)


def _derive_days(
    ctx: StepContext,
    store: ResearchStore,
    manifest: Manifest,
    etags: Mapping[date, str],
    stale: Mapping[date, tuple[FamilyName, ...]],
    counts: dict[str, int],
) -> None:
    """Derive `stale` (newest first) until the budget, the failure cap or the work runs out."""
    RESEARCH_WORK_DIR.mkdir(parents=True, exist_ok=True)
    with open_reader(ctx.settings, RESEARCH_TAPE_DIR) as reader:
        for position, (day, families) in enumerate(stale.items()):
            if _must_stop(ctx, counts):
                counts["days_left"] = len(stale) - position
                return
            _derive_day(ctx, reader, store, manifest, day, families, etags[day], counts)


def _must_stop(ctx: StepContext, counts: dict[str, int]) -> bool:
    """Less than a day's budget left, or the failure cap reached."""
    return (
        ctx.seconds_left() < RESEARCH_DAY_BUDGET_SECONDS
        or counts["days_failed"] >= RESEARCH_MAX_DAY_FAILURES
    )


def _derive_day(
    ctx: StepContext,
    reader: TapeReader,
    store: ResearchStore,
    manifest: Manifest,
    day: date,
    families: tuple[FamilyName, ...],
    etag: str,
    counts: dict[str, int],
) -> None:
    """One stale day: its counts join `counts` whether it finished or raised.

    Whatever it stored in R2 before an exception is counted (it is there), but not the day as
    derived.
    """
    iso = day.isoformat()
    started = monotonic()
    progress = _DayProgress()
    error: str | None = None
    missing = False
    try:
        missing = not _write_day(ctx, reader, store, manifest, day, families, etag, progress)
    except Exception as exc:
        # The event is scrubbed in before_send; the log and the counts keep the class only.
        error = type(exc).__name__
        sentry_sdk.capture_exception(exc, tags={"step": _STEP, "day": iso})
    finally:
        _release(reader, day)
    for family in progress.families:
        counts[_WRITTEN_COUNT[family]] += 1
    counts["rows_written"] += progress.rows
    seconds = monotonic() - started
    if error is not None:
        counts["days_failed"] += 1
        log.warning("research-derive %s failed (%s) in %.1fs", iso, error, seconds)
    elif missing:
        counts["days_tape_missing"] += 1
        log.warning("research-derive %s tape missing from R2 in %.1fs", iso, seconds)
    else:
        counts["days_derived"] += 1
        log.info(
            "research-derive %s ok %s rows=%d in %.1fs",
            iso,
            ",".join(progress.families),
            progress.rows,
            seconds,
        )


def _release(reader: TapeReader, day: date) -> None:
    """Delete the day's cached tape. A file that will not go is logged by class and goes on:
    it must not replace the day's outcome, or a kill, or lose the counts of the run."""
    try:
        reader.release(day)
    except OSError as exc:
        log.warning(
            "research-derive %s tape file not released (%s)", day.isoformat(), type(exc).__name__
        )


def _write_day(
    ctx: StepContext,
    reader: TapeReader,
    store: ResearchStore,
    manifest: Manifest,
    day: date,
    families: tuple[FamilyName, ...],
    etag: str,
    progress: _DayProgress,
) -> bool:
    """Fetch the day, store each due family, then record them; False when R2 has no tape."""
    # The download comes first: no connection may idle through it.
    path = reader.fetch_day(day, deadline=_fetch_deadline(ctx))
    if path is None:
        return False
    stamps: dict[FamilyName, str] = {}
    if "chains" in families:
        with _work_file(day, "chains") as out:
            rows = build_chains(path, day, out, temp_dir=RESEARCH_WORK_DIR)
            _put(store, "chains", day, out, rows, progress)
        stamps["chains"] = f"{etag}|v{CHAINS_VERSION}"
    fire_families = [family for family in families if family != "chains"]
    if fire_families:
        with connect_db(ctx.settings) as conn:
            for family in fire_families:
                stamps[family] = _derive_fire_family(conn, store, family, day, path, etag, progress)
    # The objects are all stored: the day is recorded, once.
    for family, fingerprint in stamps.items():
        manifest.set(family, day, fingerprint)
    manifest.save(store)
    return True


def _derive_fire_family(
    conn: connection,
    store: ResearchStore,
    family: FamilyName,
    day: date,
    tape_path: Path,
    etag: str,
    progress: _DayProgress,
) -> str:
    """Derive and store one fire family's day; its fingerprint, from the rows it was derived on."""
    script = _FIRE_SCRIPTS[family]
    fires = script.fires_for_day(conn, day)
    fingerprint = f"{etag}|v{script.DERIVE_VERSION}|{script.fingerprint_rows(fires)}"
    derived = _FIRE_DERIVES[family](script, conn, day, tape_path, fires)
    with _work_file(day, family) as out:
        # Written even with no rows: the day is derived, and the empty file says so.
        derived.to_parquet(out, index=False)
        _put(store, family, day, out, len(derived), progress)
    return fingerprint


def _put(
    store: ResearchStore,
    family: FamilyName,
    day: date,
    path: Path,
    rows: int,
    progress: _DayProgress,
) -> None:
    store.put_file(FAMILY_KEYS[family](day), path)
    progress.families.append(family)
    progress.rows += rows


@contextmanager
def _work_file(day: date, family: FamilyName) -> Iterator[Path]:
    """A path in the work directory for one family's file of a day, removed on exit."""
    path = RESEARCH_WORK_DIR / f"{day.isoformat()}-{family}.parquet"
    try:
        yield path
    finally:
        path.unlink(missing_ok=True)


def _fetch_deadline(ctx: StepContext) -> float:
    """The deadline for one download: FETCH_DEADLINE_SECONDS from now, or the step's if sooner.

    RESEARCH_DAY_BUDGET_SECONDS assumes a download of at most that long; without the bound a
    slow one could spend everything up to the step's deadline. "Now" is read off
    `ctx.seconds_left()`, the clock the step's own deadline is on.
    """
    now = ctx.deadline - ctx.seconds_left()
    return min(ctx.deadline, now + FETCH_DEADLINE_SECONDS)


def _result(counts: dict[str, int], *, last_session_landed: bool) -> StepResult:
    if counts["days_failed"]:
        return StepResult("failed", counts, _FAILED_DETAIL)
    if counts["days_left"]:
        return StepResult("partial", counts, _PARTIAL_DETAIL)
    if not last_session_landed:
        return StepResult("partial", counts, _NOT_LANDED_DETAIL)
    return StepResult("ok", counts)
