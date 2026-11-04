"""Configure pytest to find source modules in ml/src/ and cross-test
helpers in ml/tests/, and to keep a test run from rewriting tracked files.

The takeit suite (test_takeit_export.py) reuses the synthetic-frame
builder from test_takeit_train.py to avoid duplicating the ~30-line
fixture, so the tests dir needs to be importable as well.

The src modules write to ml/findings.json and ml/plots/ by default, so a
test that forgets to redirect those paths to tmp_path dirties the checkout
without failing. The session guard below catches that.
"""

import hashlib
import subprocess
import sys
import warnings
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE / "src"))
sys.path.insert(0, str(_HERE / "tests"))


def _tracked_files() -> list[str] | None:
    """List the files git tracks under ml/, or None when git cannot.

    None covers git not installed, not a checkout, or an unsafe-directory
    refusal, so the guard skips instead of breaking the run.
    """
    try:
        listing = subprocess.run(
            ["git", "ls-files", "-z"],
            cwd=_HERE,
            capture_output=True,
            check=True,
            timeout=60,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    return [name for name in listing.decode().split("\0") if name]


def _digest(path: Path) -> str | None:
    """Hash a file's bytes, so rewriting identical content is no change."""
    try:
        return hashlib.sha1(path.read_bytes(), usedforsecurity=False).hexdigest()
    except OSError:
        return None


@pytest.fixture(scope="session", autouse=True)
def _tests_leave_tracked_files_alone():
    """Fail the session if the run changed or deleted a tracked ml/ file.

    It compares each file before and after the run, so edits made before
    the run never trip it. Untracked and gitignored files are not checked.
    """
    tracked = _tracked_files()
    if tracked is None:
        warnings.warn(
            "tracked-file guard skipped: git could not list the ml/ files",
            stacklevel=1,
        )
        yield
        return
    before = {name: _digest(_HERE / name) for name in tracked}
    yield
    changed = [
        name for name, digest in before.items() if _digest(_HERE / name) != digest
    ]
    if changed:
        listed = "\n".join(f"  ml/{name}" for name in changed)
        pytest.fail(
            f"This test run changed tracked files:\n{listed}\n"
            "Point the path the code under test writes to (ML_ROOT, "
            "REPO_ROOT, PLOT_DIR, ...) at tmp_path with monkeypatch. If you "
            "edited these files during the run, rerun.",
            pytrace=False,
        )
