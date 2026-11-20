"""The nightly image is built from the repo root and carries shared scripts and ml modules.

Six places name the same twenty-one files and must change together (plan D1): the Dockerfile
COPY lines, the Railway watch paths of the `nightly` service, the .dockerignore
re-admits, IMAGE_FILES below, the `nightly` paths filter in .github/workflows/ci.yml
and the watch-path list in nightly/README.md. A file missing from one builds an image
that fails at import time on Railway, or a CI job that skips the change.

These tests keep the Dockerfile and .dockerignore in step with IMAGE_FILES, import
the modules as the image lays them out, and check that no module name exists twice
across the directories on its path. They read text, so a later .dockerignore pattern
that re-excludes a file passes them. The last step of the nightly job in ci.yml,
`docker build -f nightly/Dockerfile .`, catches that: a COPY of an ignored path fails
the build.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "nightly" / "Dockerfile"
DOCKERIGNORE = REPO_ROOT / ".dockerignore"
README = REPO_ROOT / "nightly" / "README.md"
REQUIREMENTS = REPO_ROOT / "nightly" / "requirements.txt"

NIGHTLY_SRC = REPO_ROOT / "nightly" / "src"

IMAGE_FILES: tuple[str, ...] = (
    "scripts/_tape_reader.py",
    "scripts/_cli_paths.py",
    "scripts/_pipeline_retry.py",
    "scripts/backfill_lottery_scores.py",
    "scripts/enrich_lottery_outcomes.py",
    "scripts/enrich_silent_boom_outcomes.py",
    # The research reports (phase 3). _report_weights is the loader they share.
    "scripts/_eod_flow.py",
    "scripts/_report_weights.py",
    "scripts/exit_policy_search.py",
    "scripts/flow_inversion_timing.py",
    "scripts/feature_audit.py",
    "scripts/daily_tracker.py",
    "scripts/mine_outcome_patterns.py",
    "scripts/score_lineage_audit.py",
    "ml/src/lottery_exit_policies.py",
    "ml/src/lottery_refit_gates.py",
    "ml/src/lottery_scoring.py",
    "ml/src/lottery_weights.py",
    "ml/src/whale_plots.py",
    "ml/src/takeit_drift_monitor.py",
    "ml/src/score_components.py",
)
# What the report scripts need beyond the phase 1 and 2 requirements, pinned as the
# nightly image installs them (the ml pins; nightly/requirements.txt says why).
REPORT_REQUIREMENTS: tuple[str, ...] = ("duckdb>=1.5.6,<1.6", "matplotlib>=3.10.8,<3.11")
# The ml stack the image leaves out. The report scripts never need it, and each costs
# image size and build time.
ABSENT_PACKAGES: tuple[str, ...] = ("scikit-learn", "scipy", "sqlalchemy", "xgboost")
# The watch paths of the Railway `nightly` service besides IMAGE_FILES and .dockerignore.
NIGHTLY_WATCH_PATHS: tuple[str, ...] = (
    "/nightly/Dockerfile",
    "/nightly/requirements.txt",
    "/nightly/src/**",
)


def _instructions() -> list[str]:
    """Dockerfile instructions: comments and blank lines dropped, continuations joined."""
    joined: list[str] = []
    pending = ""
    for raw in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.endswith("\\"):
            pending += line.removesuffix("\\") + " "
            continue
        joined.append(pending + line)
        pending = ""
    assert not pending, "Dockerfile ends inside a line continuation"
    return joined


def _context_copies() -> list[tuple[str, str]]:
    """(source, destination) for each source of every COPY that reads the build context."""
    pairs: list[tuple[str, str]] = []
    for line in _instructions():
        keyword, _, rest = line.partition(" ")
        if keyword.upper() != "COPY":
            continue
        words = rest.split()
        if any(w.startswith("--from=") for w in words):
            continue
        args = [w for w in words if not w.startswith("--")]
        pairs.extend((source, args[-1]) for source in args[:-1])
    return pairs


def test_dockerfile_copies_exactly_the_image_files():
    shared = [(src, dest) for src, dest in _context_copies() if not src.startswith("nightly/")]

    assert sorted(src for src, _ in shared) == sorted(IMAGE_FILES)
    for src, dest in shared:
        assert (REPO_ROOT / src).is_file(), f"{src} does not exist"
        # Lands where PYTHONPATH and the scripts' own ROOT / "ml" / "src" expect it.
        assert dest == f"./{PurePosixPath(src).parent}/", f"{src} is copied to {dest}"


def test_dockerfile_copies_nightly_sources_from_the_repo_root():
    # A bare `COPY src/ ./src/` (the layout of a nightly/ build context) would pull
    # the frontend's src/ under a repo-root context.
    nightly = [(src, dest) for src, dest in _context_copies() if src.startswith("nightly/")]

    assert sorted(nightly) == [("nightly/requirements.txt", "./"), ("nightly/src/", "./src/")]


def test_dockerignore_readmits_image_files():
    entries = [
        line.strip()
        for line in DOCKERIGNORE.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    scripts = [f for f in IMAGE_FILES if f.startswith("scripts/")]
    # The repo's convention, as for src/data in .dockerignore: ignore the directory,
    # admit it, ignore its contents, then admit each file. This pins that text and its
    # order. Whether the files get into the build is the CI docker build's job.
    expected = ["scripts/", "!scripts/", "scripts/*", *(f"!{f}" for f in scripts)]

    missing = [pattern for pattern in expected if pattern not in entries]
    assert not missing, f".dockerignore lacks {missing}"
    positions = [entries.index(pattern) for pattern in expected]

    assert positions == sorted(positions), f"patterns are out of order: {positions}"


def _env_vars() -> dict[str, str]:
    """Every KEY=value pair the Dockerfile's ENV instructions set."""
    env: dict[str, str] = {}
    for line in _instructions():
        keyword, _, rest = line.partition(" ")
        if keyword.upper() != "ENV":
            continue
        for word in rest.split():
            key, separator, value = word.partition("=")
            assert separator, f"ENV word {word!r} is not KEY=value"
            env[key] = value
    return env


def test_dockerfile_sets_matplotlib_env():
    # Agg draws to files and needs no display. The cache directory has to be writable by
    # the image's non-root user: the in-process drift step imports matplotlib in the
    # job's own process (the report subprocesses get their own directory).
    env = _env_vars()

    assert env.get("MPLBACKEND") == "Agg"
    assert env.get("MPLCONFIGDIR") == "/tmp/matplotlib"


def _requirement_lines() -> list[str]:
    return [
        line.strip()
        for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _package_name(requirement: str) -> str:
    """The normalised distribution name at the start of a requirement line."""
    match = re.match(r"[A-Za-z0-9][A-Za-z0-9._-]*", requirement)
    assert match, f"not a requirement line: {requirement!r}"
    return re.sub(r"[-_.]+", "-", match.group()).lower()


def test_requirements_carry_no_sklearn_stack():
    names = {_package_name(line) for line in _requirement_lines()}

    assert not names & set(ABSENT_PACKAGES), sorted(names & set(ABSENT_PACKAGES))


def test_requirements_pin_the_report_dependencies():
    lines = _requirement_lines()

    missing = [pin for pin in REPORT_REQUIREMENTS if pin not in lines]

    assert not missing, f"nightly/requirements.txt lacks {missing}"


def test_package_name_normalises_and_ignores_extras_and_markers():
    assert _package_name("Scikit_Learn>=1.5") == "scikit-learn"
    assert _package_name("SQLAlchemy[asyncio]==2.0.1") == "sqlalchemy"
    assert _package_name("scipy ; python_version >= '3.12'") == "scipy"


def test_readme_lists_every_watch_path():
    # One backticked path per bullet, so a path named only in prose does not count: the
    # list is what the owner copies into the Railway service's watch paths.
    listed = set(
        re.findall(r"^\s*- `(/[^`\s]+)`", README.read_text(encoding="utf-8"), re.MULTILINE)
    )
    expected = [*NIGHTLY_WATCH_PATHS, "/.dockerignore", *(f"/{f}" for f in IMAGE_FILES)]

    missing = [path for path in expected if path not in listed]

    assert not missing, f"nightly/README.md's watch-path list lacks {missing}"


def _image_pythonpath(root: Path) -> str:
    """The Dockerfile's PYTHONPATH, with the image's /app swapped for root."""
    instructions = _instructions()
    assert "WORKDIR /app" in instructions
    match = re.search(r"\bPYTHONPATH=(\S+)", "\n".join(instructions))
    assert match, "the Dockerfile sets no PYTHONPATH"
    parts = match.group(1).split(":")
    assert all(part.startswith("/app/") for part in parts), parts
    return os.pathsep.join(str(root / part.removeprefix("/app/")) for part in parts)


# The first two come before any script is imported: enrich_silent_boom_outcomes,
# backfill_lottery_scores and _report_weights each put <ROOT>/ml/src on sys.path when they
# load, so a module from there that is imported later resolves without the Dockerfile's
# PYTHONPATH entry.
# weights_store and lottery_scoring import from ml/src at load and must work first.
# The steps follow: lazy_step defers refit_step, so a missing file would go unseen until
# 07:15. The research reports come next: a missing file or dependency there fails a
# report step at 07:15, not the boot. The three research step modules close the list:
# pipeline registers them lazily (lazy_step and lazy_group_step import nothing at load), so
# a missing file or dependency would go unseen until a run here too. The venv has no scipy,
# scikit-learn or SQLAlchemy, so the closing loop holds where they are installed too: the
# reports import lottery_weights and lottery_scoring, and a module-level import of one of
# the three would make the image need a package it does not install.
IMAGE_IMPORT_CHECK = "\n".join(
    [
        "import sys",
        "import weights_store, lottery_scoring",
        "import pipeline, outcome_check, enrich_step, refit_step",
        "import enrich_lottery_outcomes, enrich_silent_boom_outcomes, _tape_reader",
        "import backfill_lottery_scores",
        "import _eod_flow, _report_weights, exit_policy_search, flow_inversion_timing",
        "import feature_audit, daily_tracker, mine_outcome_patterns, score_lineage_audit",
        "import whale_plots, takeit_drift_monitor, score_components",
        "import research_derive, research_reports, research_db_steps",
        "for heavy in ('sklearn', 'scipy', 'sqlalchemy'):",
        "    assert heavy not in sys.modules, f'importing the image modules loaded {heavy}'",
    ]
)


def test_scripts_import_in_the_image_layout(tmp_path: Path):
    shutil.copytree(
        NIGHTLY_SRC,
        tmp_path / "src",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    for relative in IMAGE_FILES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, target)

    # -P keeps the working directory and script directory off sys.path, so only the
    # Dockerfile's PYTHONPATH and the installed packages can satisfy an import.
    # MPLCONFIGDIR keeps matplotlib's cache out of the home directory.
    result = subprocess.run(
        [sys.executable, "-P", "-c", IMAGE_IMPORT_CHECK],
        cwd=tmp_path,
        env={
            **os.environ,
            "PYTHONPATH": _image_pythonpath(tmp_path),
            "MPLCONFIGDIR": str(tmp_path / "matplotlib"),
        },
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def _top_level_names(directory: Path) -> set[str]:
    """What `import` finds directly in directory: *.py stems and package directories.

    Every directory counts, with or without an `__init__.py`. A namespace directory (none)
    loses to a regular module of the same name elsewhere on the path, so the collision check
    can over-report one. That is harmless: a false alarm, never a miss.
    """
    names = {path.stem for path in directory.glob("*.py")}
    names.update(path.name for path in directory.iterdir() if path.is_dir())
    return {name for name in names if name.isidentifier()} - {"__init__", "__pycache__"}


def test_top_level_names_are_modules_and_packages(tmp_path: Path):
    (tmp_path / "steps.py").write_text("", encoding="utf-8")
    (tmp_path / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "not-a-module.py").write_text("", encoding="utf-8")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "__pycache__").mkdir()
    (tmp_path / ".pytest_cache").mkdir()
    (tmp_path / "pkg" / "inner.py").write_text("", encoding="utf-8")

    assert _top_level_names(tmp_path) == {"steps", "pkg"}


def test_no_image_module_name_collides():
    # The image puts nightly/src, scripts/ and ml/src on one path. A name in two of them
    # resolves to whichever comes first, and the enrich script and backfill_lottery_scores
    # move ml/src to the front when they load, so the Dockerfile's order does not decide it.
    places: dict[str, list[str]] = {}
    for name in _top_level_names(NIGHTLY_SRC):
        places.setdefault(name, []).append(f"nightly/src/{name}")
    for relative in IMAGE_FILES:
        places.setdefault(PurePosixPath(relative).stem, []).append(relative)

    collisions = {name: found for name, found in places.items() if len(found) > 1}

    assert not collisions, f"a module name appears twice in the image: {collisions}"


def test_no_nightly_module_is_shadowed_in_the_test_layout():
    # nightly/conftest.py puts the whole of scripts/ and ml/src on sys.path, not only the
    # files the image copies, and backfill_lottery_scores then moves ml/src to the front. A
    # new ml/src/steps.py would make the tests import it in place of nightly/src/steps.py
    # while the image, which copies twenty-one files, stays fine.
    nightly = _top_level_names(NIGHTLY_SRC)
    shadowed = {
        f"{directory.relative_to(REPO_ROOT).as_posix()}/{name}"
        for directory in (REPO_ROOT / "scripts", REPO_ROOT / "ml" / "src")
        for name in nightly & _top_level_names(directory)
    }

    assert not shadowed, f"a nightly/src module name also exists in the test layout: {shadowed}"
