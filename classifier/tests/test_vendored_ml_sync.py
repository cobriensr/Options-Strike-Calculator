"""Byte-equality check between ``classifier/_vendored_ml/`` and ``ml/src/``.

Railway builds the classifier with build context ``classifier/``, so the
Dockerfile cannot reach ``../ml/src/``. ``multileg_assembler.py`` and
``multileg_patterns.py`` are vendored into ``classifier/_vendored_ml/``
and shipped inside the container.

This test fails if either file drifts. The fix is documented in
``classifier/_vendored_ml/README.md``: copy from ``ml/src/`` and commit
both sides.

Ported from ``sidecar/tests/test_vendored_ml_sync.py`` with the paths
adapted for ``classifier/``.
"""

from __future__ import annotations

import filecmp
import hashlib
from pathlib import Path

import pytest

CLASSIFIER_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = CLASSIFIER_ROOT.parent
ML_SRC = REPO_ROOT / "ml" / "src"
VENDORED = CLASSIFIER_ROOT / "_vendored_ml"

MODULES = ["multileg_assembler.py", "multileg_patterns.py"]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", MODULES)
def test_vendored_matches_ml_src(name: str) -> None:
    source = ML_SRC / name
    vendored = VENDORED / name
    assert source.exists(), f"missing source-of-truth: {source}"
    assert vendored.exists(), f"missing vendored copy: {vendored}"

    # filecmp.cmp(shallow=False) reads both files fully and compares
    # bytes — equivalent to SHA256 here but with a slightly nicer fail
    # message in pytest. We add the SHA values to the failure message
    # because filecmp doesn't surface them.
    if not filecmp.cmp(source, vendored, shallow=False):
        pytest.fail(
            f"{name} differs between ml/src/ and classifier/_vendored_ml/.\n"
            f"  ml/src/{name}                       sha256={_sha256(source)}\n"
            f"  classifier/_vendored_ml/{name}      sha256={_sha256(vendored)}\n"
            f"Re-vendor: copy the source-of-truth from ml/src/ into\n"
            f"classifier/_vendored_ml/ and commit both files. See\n"
            f"classifier/_vendored_ml/README.md for the procedure."
        )
