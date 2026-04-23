"""PAC sweep service — FastAPI entry point.

Runs on Railway as a sibling to the sidecar. Three pillars:
  - /health          : Railway probe, no auth
  - /hydrate + /hydrate/status : Phase 2 — pull the Databento archive
                                 from Vercel Blob to the mounted volume
  - /run + /status/{id}        : Phase 3 — spawn a whitelisted sweep
                                 subprocess, upload JSON result to blob

See docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md.
"""

from __future__ import annotations

import logging
import os
import threading
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel

import runner
from archive_seeder import (
    SeedBusyError,
    SeedResult,
    count_archive_files,
    is_seeding,
    seed_from_manifest,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger(__name__)

app = FastAPI(
    title="PAC Sweep Service",
    version="0.4.0-phase4",
    description="On-demand CPCV/Optuna backtests. Single-owner, bearer-auth gated.",
)


@app.on_event("startup")
def _recover_orphans_on_startup() -> None:
    """On fresh container boot, mark any stale `running` jobs as failed.

    Railway restarts (OOM, maintenance, crash) kill in-flight subprocesses
    without giving the runner thread a chance to update meta.json. Without
    this hook, /status returns ghost `running` state forever. See
    runner.recover_orphaned_jobs for the detection rule.
    """
    try:
        recovered = runner.recover_orphaned_jobs()
        if recovered:
            log.warning(
                "Startup recovery flipped %d orphaned jobs to failed: %s",
                len(recovered),
                recovered,
            )
    except Exception as exc:  # noqa: BLE001 — must not kill startup
        log.error("Startup recovery crashed: %s", exc, exc_info=True)


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


def require_auth(authorization: str = Header(default="")) -> None:
    expected = os.environ.get("AUTH_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="AUTH_TOKEN not configured")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=403, detail="invalid token")


# ---------------------------------------------------------------------------
# Hydrate state (Phase 2)
# ---------------------------------------------------------------------------

_hydrate_state: dict[str, Any] = {
    "last_job_id": None,
    "last_status": "never_run",
    "last_error": None,
    "last_result": None,
}
_hydrate_state_lock = threading.Lock()


def _run_hydrate(job_id: str, manifest_url: str, dest_root: str, token: str) -> None:
    log.info("Hydrate job %s starting: manifest=%s dest=%s", job_id, manifest_url, dest_root)
    try:
        result: SeedResult = seed_from_manifest(manifest_url, dest_root, token)
        with _hydrate_state_lock:
            _hydrate_state["last_status"] = "succeeded"
            _hydrate_state["last_result"] = result.as_dict()
            _hydrate_state["last_error"] = None
        log.info("Hydrate job %s succeeded: %s", job_id, result.as_dict())
    except SeedBusyError as exc:
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
    status: str  # queued | running | succeeded | failed | rejected | unknown
    script: str | None = None
    args: dict[str, Any] | None = None
    queued_at: str | None = None
    started_at: str | None = None
    heartbeat_at: str | None = None  # last liveness tick from the runner's Popen loop
    finished_at: str | None = None
    recovered_at: str | None = None  # set when startup recovery flipped it to failed
    returncode: int | None = None
    pid: int | None = None
    result_url: str | None = None
    download_url: str | None = None
    result_bytes: int | None = None
    blob_path: str | None = None
    message: str | None = None
    log_tail: str | None = None


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
    return {"ok": True, "version": app.version, "phase": 4}


@app.post("/run", response_model=RunResponse, status_code=status.HTTP_202_ACCEPTED)
def run(req: RunRequest, _auth: None = Depends(require_auth)) -> RunResponse:
    """Spawn a sweep subprocess in a daemon thread.

    Returns 202 Accepted immediately with a job_id. Poll /status/{job_id}
    for progress. Returns 429 if another job is already running (one job
    at a time is enforced by runner._run_lock).
    """
    if req.script not in runner.WHITELIST:
        raise HTTPException(
            status_code=400,
            detail=f"Script {req.script!r} not whitelisted. "
            f"Available: {list(runner.WHITELIST)}",
        )

    if runner.is_running():
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Another sweep is already running. Poll /status/{job_id} until it finishes.",
        )

    job_id = str(uuid.uuid4())
    runner.create_job_record(job_id, req.script, req.args)

    threading.Thread(
        target=runner.dispatch,
        args=(job_id, req.script, req.args),
        daemon=True,
        name=f"sweep-{job_id[:8]}",
    ).start()

    return RunResponse(
        job_id=job_id,
        status="accepted",
        message=f"Sweep started: script={req.script!r}, args={req.args}. "
        "Poll /status/{job_id} for completion.",
    )


@app.get("/status/{job_id}", response_model=StatusResponse)
def run_status(job_id: str, _auth: None = Depends(require_auth)) -> StatusResponse:
    """Read the job meta file from the volume + surface current state.

    Opportunistically runs recover_orphaned_jobs() before the read so a
    stale `running` meta gets flipped to `failed` the next time any
    client polls, even if the startup hook missed it (rare edge case
    where a crash happened after startup recovery already ran).
    """
    try:
        runner.recover_orphaned_jobs()
    except Exception as exc:  # noqa: BLE001
        log.warning("Opportunistic recovery during /status failed: %s", exc)

    meta = runner.read_meta(job_id)
    if meta is None:
        return StatusResponse(
            job_id=job_id,
            status="unknown",
            message="No job record found. Either the job_id is invalid or the "
            "record was purged.",
        )
    # StatusResponse auto-populates from meta keys that match; unknown keys are
    # ignored. Pass only keys pydantic accepts to avoid 500s on schema drift.
    known_keys = set(StatusResponse.model_fields.keys())
    filtered = {k: v for k, v in meta.items() if k in known_keys}
    filtered["job_id"] = job_id
    return StatusResponse(**filtered)


@app.post("/hydrate", response_model=HydrateResponse, status_code=status.HTTP_202_ACCEPTED)
def hydrate(_auth: None = Depends(require_auth)) -> HydrateResponse:
    """Kick off a background archive hydration from Vercel Blob."""
    manifest_url = os.environ.get("ARCHIVE_MANIFEST_URL", "").strip()
    token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
    dest_root = os.environ.get("ARCHIVE_ROOT", "").strip()

    missing = [
        name
        for name, value in (
            ("ARCHIVE_MANIFEST_URL", manifest_url),
            ("BLOB_READ_WRITE_TOKEN", token),
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
    dest_root = os.environ.get("ARCHIVE_ROOT", "/data/archive").strip() or "/data/archive"
    with _hydrate_state_lock:
        state = dict(_hydrate_state)
    return HydrateStatusResponse(
        last_job_id=state["last_job_id"],
        last_status=state["last_status"],
        last_error=state["last_error"],
        last_result=state["last_result"],
        is_seeding=is_seeding(),
        archive=count_archive_files(dest_root),
    )
