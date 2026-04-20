"""One-shot: stamp the current git HEAD SHA into acceptance.yml.

The acceptance.yml field `commit_hash_when_locked` starts as `null` to
flag that the thresholds haven't been officially locked yet. This script
reads the file, looks up the current git HEAD SHA, and writes it back.

Run exactly once per significant acceptance-version bump. The resulting
stamped YAML should be committed separately (no behavior change, just
the lock transaction).

Usage:
    ml/.venv/bin/python ml/scripts/stamp_acceptance_hash.py

Idempotent: if commit_hash_when_locked is already set, the script prints
the existing value and exits 0 without overwriting. Use `--force` to
re-stamp (e.g. after bumping `version:`).

Why this exists:
    Per Harvey (2017) and the spec's overfitting-defense contract, the
    commit hash at the moment of lock is the immutable anchor that lets
    any later acceptance.yml edit be detected. Without it, a silent
    post-hoc tightening or loosening leaves no audit trail.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

# Run preserves line structure with ruamel; stdlib yaml would reformat.
# Falling back to stdlib for simplicity — the cost is YAML formatting
# may change slightly on first stamp. Acceptable for a one-shot.
import yaml

_ACCEPTANCE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "pac_backtest"
    / "acceptance.yml"
)


def git_head_sha() -> str:
    """Return current git HEAD SHA (full, not short)."""
    out = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return out.stdout.strip()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Stamp commit_hash_when_locked into acceptance.yml."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite an existing stamp (use after acceptance version bump).",
    )
    args = parser.parse_args(argv)

    if not _ACCEPTANCE_PATH.exists():
        print(f"acceptance.yml not found at {_ACCEPTANCE_PATH}", file=sys.stderr)
        return 1

    with _ACCEPTANCE_PATH.open() as f:
        data = yaml.safe_load(f)

    existing = data.get("commit_hash_when_locked")
    if existing and not args.force:
        print(f"acceptance.yml already stamped: {existing}")
        print("Use --force to overwrite (e.g. after bumping `version:`).")
        return 0

    sha = git_head_sha()
    data["commit_hash_when_locked"] = sha

    with _ACCEPTANCE_PATH.open("w") as f:
        yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)

    print(f"Stamped commit_hash_when_locked = {sha}")
    print(f"File: {_ACCEPTANCE_PATH}")
    print()
    print("Next step: git add + commit this change on a chore branch.")
    print("The resulting commit itself will have a different SHA — that's")
    print("fine. The stamped SHA records WHICH state the lock was frozen at.")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
