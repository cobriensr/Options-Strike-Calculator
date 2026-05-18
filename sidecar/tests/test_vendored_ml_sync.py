"""Byte-equality check between sidecar/_vendored_ml/ and ml/src/.

Railway builds the sidecar with build context ``sidecar/``, so the
Dockerfile cannot reach ``../ml/src/``. The two multileg modules are
vendored into ``sidecar/_vendored_ml/`` and shipped inside the image.

This test fails if either file drifts so the next ``make review`` (or
CI) catches it before deploy. Re-vendor with ``make sync-ml``.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SIDECAR_ROOT.parent
ML_SRC = REPO_ROOT / "ml" / "src"
VENDORED = SIDECAR_ROOT / "_vendored_ml"

MODULES = ["multileg_assembler.py", "multileg_patterns.py"]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("name", MODULES)
def test_vendored_matches_ml_src(name: str) -> None:
    source = ML_SRC / name
    vendored = VENDORED / name
    assert source.exists(), f"missing source-of-truth: {source}"
    assert vendored.exists(), f"missing vendored copy: {vendored}"
    if _sha256(source) != _sha256(vendored):
        pytest.fail(
            f"{name} differs between ml/src/ and sidecar/_vendored_ml/. "
            f"Run `cd sidecar && make sync-ml` and commit both files."
        )
