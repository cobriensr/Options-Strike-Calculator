"""PAC sweep service — FastAPI entry point.

Runs on Railway as a sibling to the sidecar. Accepts on-demand sweep
requests via HTTP, dispatches them in a background subprocess, and uploads
result JSONs to Vercel Blob when done. See
docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md.

Phase 2 (current):
  - /hydrate + /hydrate/status endpoints wired. Downloads the Databento
    archive from Vercel Blob to /data/archive on demand, matching the
    sidecar's seeder semantics (SHA-resumable, single-flight).
  - /run remains echo-only — Phase 3 wires the actual sweep subprocess.
"""

from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

from archive_seeder import (
    SeedBusyError,
    SeedResult,
    count_archive_files,
    is_seeding,
    seed_from_manifest,
)

# Configure module-level logging so uvicorn captures seed progress lines.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger(__name__)

app = FastAPI(
    title="PAC Sweep Service",
    version="0.2.0-phase2",
    description="On-demand CPCV/Optuna backtests. Single-owner, bearer-auth gated.",
)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def require_auth(authorization: str = Header(default="")) -> None:
    """Gate mutation endpoints with a bearer token."""
    expected = os.environ.get("AUTH_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="AUTH_TOKEN not configured")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=403, detail="invalid token")


# ---------------------------------------------------------------------------
# Module-level hydrate job state
# ---------------------------------------------------------------------------
#
# The hydrate run is long (~100 sec for 5 GB at ~50 MB/s on Railway's
# network). We spawn it in a background thread and track the latest run's
# state here. Only one hydrate can be in flight at a time — enforced by
# archive_seeder's internal `_seed_lock`. The state here is for surfacing
# progress via /hydrate/status; it doesn't replace the seeder's lock.

_hydrate_state: dict[str, Any] = {
    "last_job_id": None,
    "last_status": "never_run",  # never_run | running | succeeded | failed
    "last_error": None,
    "last_result": None,  # SeedResult.as_dict() when complete
}
_hydrate_state_lock = threading.Lock()


def _run_hydrate(job_id: str, manifest_url: str, dest_root: str, token: str) -> None:
    """Background worker: runs the seeder and writes outcome to state."""
    log.info("Hydrate job %s starting: manifest=%s dest=%s", job_id, manifest_url, dest_root)
    try:
        result: SeedResult = seed_from_manifest(manifest_url, dest_root, token)
        with _hydrate_state_lock:
            _hydrate_state["last_status"] = "succeeded"
            _hydrate_state["last_result"] = result.as_dict()
            _hydrate_state["last_error"] = None
        log.info("Hydrate job %s succeeded: %s", job_id, result.as_dict())
    except SeedBusyError as exc:
        # Another hydrate was already in flight — treat this job as noop.
        with _hydrate_state_lock:
            _hydrate_state["last_status"] = "failed"
            _hydrate_state["last_error"] = f"busy: {exc}"
        log.warning("Hydrate job %s: %s", job_id, exc)
    except Exception as exc:  # noqa: BLE001
        with _hydrate_state_lock:
            _hydrate_state["last_status"] = "failed"
            _hydrate_state["last_error"] = f"{type(exc).__name__}: {exc}"
        log.error("Hydrate job %s failed: %s", job_id, exc, exc_info=True)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class RunRequest(BaseModel):
    script: str
    args: dict[str, Any] = {}


class RunResponse(BaseModel):
    job_id: str
    status: str
    message: str


class StatusResponse(BaseModel):
    job_id: str
    status: str
    message: str
    result_url: str | None = None


class HydrateResponse(BaseModel):
    job_id: str
    status: str
    message: str


class HydrateStatusResponse(BaseModel):
    last_job_id: str | None
    last_status: str
    last_error: str | None
    last_result: dict[str, Any] | None
    is_seeding: bool
    archive: dict[str, Any]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
def health() -> dict[str, Any]:
    """Railway health-probe target. No auth."""
    return {"ok": True, "version": app.version, "phase": 2}


@app.post("/run", response_model=RunResponse)
def run(req: RunRequest, _auth: None = Depends(require_auth)) -> RunResponse:
    """Phase 2 still echoes — Phase 3 wires real subprocess execution."""
    job_id = str(uuid.uuid4())
    return RunResponse(
        job_id=job_id,
        status="echo-only-phase2",
        message=f"Received request to run {req.script!r}. "
        "Not executed — Phase 3 will wire the sweep dispatcher.",
    )


@app.get("/status/{job_id}", response_model=StatusResponse)
def run_status(job_id: str, _auth: None = Depends(require_auth)) -> StatusResponse:
    """Phase 2 stub — Phase 3 will persist job records to blob + look up here."""
    return StatusResponse(
        job_id=job_id,
        status="unknown",
        message="Phase 3 will wire job persistence.",
    )


@app.post("/hydrate", response_model=HydrateResponse, status_code=status.HTTP_202_ACCEPTED)
def hydrate(_auth: None = Depends(require_auth)) -> HydrateResponse:
    """Kick off a background archive hydration from Vercel Blob.

    Returns 202 Accepted immediately with a job_id. Poll /hydrate/status
    to observe progress. Returns 423 Locked if a hydrate is already
    running (the seeder's module-level lock enforces single-flight).
    Returns 500 if required env vars (ARCHIVE_MANIFEST_URL, ARCHIVE_SEED_TOKEN,
    ARCHIVE_ROOT) are missing.
    """
    manifest_url = os.environ.get("ARCHIVE_MANIFEST_URL", "").strip()
    token = os.environ.get("ARCHIVE_SEED_TOKEN", "").strip()
    dest_root = os.environ.get("ARCHIVE_ROOT", "").strip()

    missing = [
        name
        for name, value in (
            ("ARCHIVE_MANIFEST_URL", manifest_url),
            ("ARCHIVE_SEED_TOKEN", token),
            ("ARCHIVE_ROOT", dest_root),
        )
        if not value
    ]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Missing required env vars: {', '.join(missing)}",
        )

    if is_seeding():
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="A hydrate is already in progress",
        )

    job_id = str(uuid.uuid4())
    with _hydrate_state_lock:
        _hydrate_state["last_job_id"] = job_id
        _hydrate_state["last_status"] = "running"
        _hydrate_state["last_error"] = None
        _hydrate_state["last_result"] = None

    # Spawn the seed in a daemon thread so it doesn't block uvicorn's
    # request loop and is torn down on process exit.
    threading.Thread(
        target=_run_hydrate,
        args=(job_id, manifest_url, dest_root, token),
        daemon=True,
        name=f"hydrate-{job_id[:8]}",
    ).start()

    return HydrateResponse(
        job_id=job_id,
        status="accepted",
        message="Hydration started in background. Poll /hydrate/status for progress.",
    )


@app.get("/hydrate/status", response_model=HydrateStatusResponse)
def hydrate_status(_auth: None = Depends(require_auth)) -> HydrateStatusResponse:
    """Report the latest hydrate job state + on-disk archive summary."""
    dest_root = os.environ.get("ARCHIVE_ROOT", "/data/archive").strip() or "/data/archive"
    with _hydrate_state_lock:
        state = dict(_hydrate_state)  # Snapshot while holding the lock.
    return HydrateStatusResponse(
        last_job_id=state["last_job_id"],
        last_status=state["last_status"],
        last_error=state["last_error"],
        last_result=state["last_result"],
        is_seeding=is_seeding(),
        archive=count_archive_files(dest_root),
    )
