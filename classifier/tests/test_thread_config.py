"""Guards the polars thread-pool cap that bounds per-request peak memory.

The classifier OOM-looped because polars sized its thread pool to the box's
core count (24 vCPU), fanning each join into ~24 parallel build/probe
partitions that each held a slice of the intermediate — so scaling the box
UP raised the peak that killed it. ``POLARS_MAX_THREADS=2`` caps that. This is
the single highest-leverage line in the whole OOM fix; protect it from a
future Dockerfile rewrite. See
docs/superpowers/specs/classifier-oom-rework-2026-06-11.md
"""

from pathlib import Path

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"


def test_dockerfile_caps_polars_threads() -> None:
    text = _DOCKERFILE.read_text()
    assert "POLARS_MAX_THREADS=2" in text, (
        "POLARS_MAX_THREADS=2 missing from Dockerfile — peak memory will "
        "scale with the host core count and the box will OOM again."
    )


def test_dockerfile_exposes_streaming_chunk_size_env() -> None:
    # The streaming engine reads this at module import (rework Phase 3); the
    # Dockerfile sets a default and documents the ops-tuning hook.
    text = _DOCKERFILE.read_text()
    assert "POLARS_STREAMING_CHUNK_SIZE" in text
