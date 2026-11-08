"""The nightly image is built from the repo root and carries the shared enrich scripts.

Six places name the same six files and must change together (plan D1): IMAGE_FILES
below, the Dockerfile COPY lines, the .dockerignore re-admits, the nightly paths
filter and the lint step in .github/workflows/ci.yml. A file missing from one builds
an image that fails at import time on Railway, or a CI job that skips the change.
These tests keep the Dockerfile and .dockerignore in step with IMAGE_FILES and import
the scripts as the image lays them out. A real `docker build -f nightly/Dockerfile .`
from the repo root is the only check of the .dockerignore semantics.
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

IMAGE_FILES: tuple[str, ...] = (
    "scripts/_tape_reader.py",
    "scripts/_cli_paths.py",
    "scripts/_pipeline_retry.py",
    "scripts/enrich_lottery_outcomes.py",
    "scripts/enrich_silent_boom_outcomes.py",
    "ml/src/lottery_exit_policies.py",
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
    # Docker keeps the last pattern that matches a path: ignore the directory, admit it,
    # ignore its contents, then admit each file. Any other order drops the files.
    expected = ["scripts/", "!scripts/", "scripts/*", *(f"!{f}" for f in scripts)]

    missing = [pattern for pattern in expected if pattern not in entries]
    assert not missing, f".dockerignore lacks {missing}"
    positions = [entries.index(pattern) for pattern in expected]

    assert positions == sorted(positions), f"patterns are out of order: {positions}"


def _image_pythonpath(root: Path) -> str:
    """The Dockerfile's PYTHONPATH, with the image's /app swapped for root."""
    instructions = _instructions()
    assert "WORKDIR /app" in instructions
    match = re.search(r"\bPYTHONPATH=(\S+)", "\n".join(instructions))
    assert match, "the Dockerfile sets no PYTHONPATH"
    parts = match.group(1).split(":")
    assert all(part.startswith("/app/") for part in parts), parts
    return os.pathsep.join(str(root / part.removeprefix("/app/")) for part in parts)


def test_scripts_import_in_the_image_layout(tmp_path: Path):
    shutil.copytree(
        REPO_ROOT / "nightly" / "src",
        tmp_path / "src",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    for relative in IMAGE_FILES:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / relative, target)

    # -P keeps the working directory and script directory off sys.path, so only the
    # Dockerfile's PYTHONPATH and the installed packages can satisfy an import.
    result = subprocess.run(
        [
            sys.executable,
            "-P",
            "-c",
            "import enrich_lottery_outcomes, enrich_silent_boom_outcomes, _tape_reader",
        ],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": _image_pythonpath(tmp_path)},
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

    assert result.returncode == 0, result.stderr
