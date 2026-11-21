"""The one-time seed: the research state that lives only on the owner's machine, into R2.

The research steps read their state from `research/` in the bucket and extend it: the per-day
chains aggregates, the lottery-tracking CSV, the dated reports. Until this runs, that state
exists only in the owner's checkout (`scripts/` and `docs/tmp/`, the take-it drift plots under
`ml/plots/`). It is a local tool, run once, by hand. The nightly job never calls it. Run it
outside the nightly job's window (Tue-Sat, about 07:15-12:30 UTC): it writes the same keys and
the derive manifest, and takes no lock, so an overlap could overwrite a night's object or drop
its manifest entries.

    PYTHONPATH=nightly/src:scripts:ml/src python -m seed_research --repo-root <checkout> [--dry-run]

The path is the image's (`Dockerfile`; `;` between the folders on Windows): the modules import
each other flat, and `research_derive` pulls in the shared scripts. Settings are
`config.load_settings()` as the nightly job reads them, so the whole nightly environment is
needed, not only `R2_*`. Run it against the main checkout, which holds the owner's untracked
reports: a worktree holds only the tracked files, a subset of `docs/tmp/`, so it seeds a
fraction of them and still exits 0, and since a run never overwrites, whatever it puts at the
tracking state key first stays there.

What it does (`SEED_RULES` is the table of what goes where):

- Never overwrites. A key that already exists in R2 is skipped, whatever the local file holds:
  the nightly steps own those objects from their first run on (the tracking CSV most of all).
- Existence is read with one listing per rule's key prefix, never one request per file.
- A name must carry exactly one YYYY-MM-DD when its key uses `{date}`, and for the chains
  files, whose seed mark needs the day; a chains file must be named exactly
  `YYYY-MM-DD-chains.parquet`, the name the derive step keys by day. Every name is checked
  before anything uploads (`plan_seed`), so a bad name stops the run with nothing written.
- Each chains day whose object is in R2 after the run and that has no manifest entry is
  marked `SEED` (the derive step never rebuilds a seeded chains day). An entry already there,
  a fingerprint the derive step wrote, is never replaced. The manifest is read before the
  first upload, so a malformed one stops the run with nothing written, and written once, only
  when a day was marked.
- `--dry-run` writes nothing, no object and no manifest, and reports what a real run would do.

A run is safe to repeat: a failure part-way leaves what was uploaded in place, and the rerun
skips it and goes on from there, marks included. Each rule runs on its own, in table order, so
a rule's counts print as it finishes. Exit codes: 0 ok; 1 an upload, a store read or a file
read failed; 2 a bad file name, bad arguments, a root with no file for any rule, or invalid
settings. The output is counts per rule and in total, and an error is its class name: never a
path, a file's content or a setting's value, which is why no logging is configured here
either.
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from botocore.exceptions import BotoCoreError, ClientError
from pydantic import ValidationError

from config import load_settings
from r2_store import R2VerifyError
from research_derive import SEED, Manifest, ManifestError
from research_store import ResearchKeyError, ResearchStore, _check

# A date is YYYY-MM-DD and not part of a longer run of digits.
_DATE = re.compile(r"(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)")
_CHAINS_KEY = "research/eod-flow/by-day/{name}"
# A chains file's whole name, and the chains object of a day: as
# `research_derive.FAMILY_KEYS["chains"]` names it, one per day.
_CHAINS_NAME = r"(\d{4}-\d{2}-\d{2})-chains\.parquet"
_CHAINS_FILE = re.compile(_CHAINS_NAME)
_CHAINS_OBJECT = re.compile(_CHAINS_KEY.format(name=_CHAINS_NAME))


@dataclass(frozen=True)
class SeedRule:
    """Which local files go to which key.

    `pattern` is a glob relative to the repo root. `key` is a template: `{name}` is the file's
    name, `{date}` the session date its name carries (YYYY-MM-DD).
    """

    pattern: str
    key: str


# The takeit-drift row of the table has two patterns, so two rules share its key template.
SEED_RULES: tuple[SeedRule, ...] = (
    SeedRule("scripts/eod-flow-analysis/output/by-day/*-chains.parquet", _CHAINS_KEY),
    SeedRule(
        "docs/tmp/lottery-tracking.csv", "research/lottery-tracking/state/lottery-tracking.csv"
    ),
    SeedRule("docs/tmp/lottery-exit-policy-search-*.md", "research/exit-policy/{date}/{name}"),
    SeedRule("docs/tmp/flow-inversion-timing-*.md", "research/flow-timing/{date}/{name}"),
    SeedRule("docs/tmp/lottery-feature-audit-*.md", "research/feature-audit/{date}/{name}"),
    SeedRule("docs/tmp/lottery-composite-candidates-*.md", "research/outcome-mining/{date}/{name}"),
    SeedRule("docs/tmp/lottery-score-lineage-*.md", "research/score-lineage/{date}/{name}"),
    SeedRule("docs/tmp/lottery-quality-sim-*.csv", "research/quality-sim/{date}/{name}"),
    SeedRule("docs/tmp/takeit-drift-*.md", "research/takeit-drift/{date}/{name}"),
    SeedRule("ml/plots/takeit-drift/reliability_*_*.png", "research/takeit-drift/{date}/{name}"),
)


@dataclass(frozen=True)
class SeedItem:
    path: Path
    key: str


@dataclass(frozen=True)
class SeedResult:
    """What a run did (a dry run: would do) with a set of items."""

    uploaded: int
    skipped_existing: int
    chains_marked_seed: int


class SeedNameError(ValueError):
    """A file that cannot be seeded: the message names it."""


def _static_prefix(template: str) -> str:
    """The part of a key template before its first placeholder: where its keys are listed."""
    return template.split("{", 1)[0]


# One entry per row of the table: a rule's keys all start with its prefix, and no prefix
# starts with another.
_PREFIXES: tuple[str, ...] = tuple(dict.fromkeys(_static_prefix(rule.key) for rule in SEED_RULES))


def _prefix_of(key: str) -> str:
    for prefix in _PREFIXES:
        if key.startswith(prefix):
            return prefix
    raise ValueError(f"{key!r} is not under any seed rule's key prefix")


def _session_day(label: str, name: str) -> date:
    """The one valid date `name` carries, else SeedNameError naming `label`."""
    found = _DATE.findall(name)
    if len(found) != 1:
        raise SeedNameError(
            f"{label}: the name must carry exactly one YYYY-MM-DD, not {len(found)}"
        )
    try:
        return date.fromisoformat(found[0])
    except ValueError:
        raise SeedNameError(f"{label}: {found[0]} is not a calendar date") from None


def _plan_rule(repo_root: Path, rule: SeedRule) -> list[SeedItem]:
    # The chains files need the day for the seed mark, though their key has no {date}.
    needs_date = "{date}" in rule.key or rule.key == _CHAINS_KEY
    items: list[SeedItem] = []
    for path in sorted(repo_root.glob(rule.pattern)):
        if not path.is_file():
            continue
        label = path.relative_to(repo_root).as_posix()
        day = _session_day(label, path.name).isoformat() if needs_date else ""
        if rule.key == _CHAINS_KEY and _CHAINS_FILE.fullmatch(path.name) is None:
            # `*-chains.parquet` also takes `x-2026-04-13-chains.parquet`: it would upload under
            # a key the derive step never looks up, and no seed mark could name its day.
            raise SeedNameError(f"{label}: the name must be exactly YYYY-MM-DD-chains.parquet")
        key = rule.key.format(name=path.name, date=day)
        # The store's own key rule (under `research/`, no `..`, no backslash), applied now so
        # that a name it would refuse stops the run before the first upload, not in the middle.
        try:
            _check(key)
        except ResearchKeyError:
            raise SeedNameError(f"{label}: its key would not be a valid research key") from None
        items.append(SeedItem(path, key))
    return items


def plan_seed(repo_root: Path) -> list[SeedItem]:
    """Every file the rules take under `repo_root`, with its key: rule order, then name.

    Reads no R2 and writes nothing. The first file whose name cannot be seeded raises
    SeedNameError, so the plan is complete and valid or there is none.
    """
    return [item for rule in SEED_RULES for item in _plan_rule(repo_root, rule)]


def _existing_keys(store: ResearchStore, items: Sequence[SeedItem]) -> set[str]:
    """Which of the items' keys exist: one listing per rule prefix the items fall under."""
    existing: set[str] = set()
    for prefix in dict.fromkeys(_prefix_of(item.key) for item in items):
        existing.update(store.list(prefix))
    return existing


def _chains_days(items: Sequence[SeedItem]) -> list[date]:
    matches = (_CHAINS_OBJECT.fullmatch(item.key) for item in items)
    return [date.fromisoformat(match[1]) for match in matches if match is not None]


def run_seed(store: ResearchStore, items: Sequence[SeedItem], *, dry_run: bool) -> SeedResult:
    """Upload the items whose key is not in R2, then mark the chains days seeded.

    With `dry_run`, only reads: the result is what a real run would be. An error raised by
    the store propagates, with whatever was uploaded before it left in place.
    """
    existing = _existing_keys(store, items)
    days = _chains_days(items)
    # Read before the first upload: a malformed manifest must stop the run with nothing written.
    manifest = Manifest.load(store) if days else None
    uploaded = skipped = 0
    for item in items:
        if item.key in existing:
            skipped += 1
            continue
        if not dry_run:
            store.put_file(item.key, item.path)
        uploaded += 1
    marked = 0
    if manifest is not None:
        # Every chains item is in R2 now, uploaded or already there.
        for day in days:
            if manifest.get("chains", day) is None:
                manifest.set("chains", day, SEED)
                marked += 1
        if marked and not dry_run:
            manifest.save(store)
    return SeedResult(uploaded, skipped, marked)


def _count_line(label: str, result: SeedResult) -> str:
    return (
        f"{label}: uploaded={result.uploaded} skipped_existing={result.skipped_existing} "
        f"chains_marked_seed={result.chains_marked_seed}"
    )


def _seed(store: ResearchStore, items: Sequence[SeedItem], *, dry_run: bool) -> None:
    """Run each rule's items and print its counts as it finishes, then the totals."""
    groups: dict[str, list[SeedItem]] = {prefix: [] for prefix in _PREFIXES}
    for item in items:
        groups[_prefix_of(item.key)].append(item)
    if dry_run:
        print("dry run: nothing is written; the counts are what a real run would do", flush=True)
    results: list[SeedResult] = []
    for prefix, group in groups.items():
        results.append(run_seed(store, group, dry_run=dry_run))
        print(_count_line(prefix, results[-1]), flush=True)
    total = SeedResult(
        uploaded=sum(r.uploaded for r in results),
        skipped_existing=sum(r.skipped_existing for r in results),
        chains_marked_seed=sum(r.chains_marked_seed for r in results),
    )
    print(_count_line("total", total), flush=True)


def _invalid_settings(exc: ValidationError) -> str:
    """The invalid fields by name and error type: never a value, which may be a secret."""
    errors = exc.errors(include_input=False, include_url=False, include_context=False)
    return ", ".join(f"{'.'.join(map(str, e['loc']))} ({e['type']})" for e in errors)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="seed_research",
        description="Seed R2 with the local research state, once. Never overwrites a key.",
    )
    parser.add_argument(
        "--repo-root",
        type=Path,
        required=True,
        help="the checkout that holds the files (scripts/, docs/tmp/, ml/plots/)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="write nothing; report what a run would do"
    )
    args = parser.parse_args(argv)
    # A typo'd root, or one with none of the files (an empty folder, say), would match nothing
    # and report a clean run of zeros: both stop here, before settings and the store. A worktree
    # root is not caught: it holds the tracked subset, so it matches and seeds only that.
    if not args.repo_root.is_dir():
        print("error: --repo-root is not a directory", file=sys.stderr)
        return 2
    try:
        items = plan_seed(args.repo_root)
    except SeedNameError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    if not items:
        print("error: no file under --repo-root matches a seed rule", file=sys.stderr)
        return 2
    try:
        settings = load_settings()
    except ValidationError as exc:
        print(f"error: invalid settings: {_invalid_settings(exc)}", file=sys.stderr)
        return 2
    try:
        _seed(ResearchStore(settings), items, dry_run=args.dry_run)
    except (BotoCoreError, ClientError, OSError, R2VerifyError, ManifestError) as exc:
        # The class only: an endpoint error's message carries the endpoint.
        print(f"error: {type(exc).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
