"""Sweep subprocess runner + Vercel Blob result uploader.

Phase 1 placeholder — implementation lands in Phase 3. Keeping the file
in the tree now so the Dockerfile's COPY directive matches the final
structure and Phase 3 can be a pure edit rather than a new file.
"""

from __future__ import annotations


def dispatch(script: str, args: dict) -> str:
    """Placeholder. Will spawn a subprocess and return the job_id."""
    raise NotImplementedError("Runner lands in Phase 3")
