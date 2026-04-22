"""PAC sweep service — FastAPI entry point.

Runs on Railway as a sibling to the sidecar. Accepts on-demand sweep
requests via HTTP, dispatches them in a background subprocess, and uploads
result JSONs to Vercel Blob when done. See
docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md for the
full design.

Phase 1 (current): endpoints are wired but `/run` is echo-only. This
proves the Railway deployment works end-to-end before we plug in real
sweep code in Phase 3.
"""

from __future__ import annotations

import os
import uuid
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(
    title="PAC Sweep Service",
    version="0.1.0-phase1",
    description="On-demand CPCV/Optuna backtests. Single-owner, bearer-auth gated.",
)


def require_auth(authorization: str = Header(default="")) -> None:
    """Gate mutation endpoints with a bearer token.

    Expects `Authorization: Bearer <token>` where the token equals the
    AUTH_TOKEN env var configured on the Railway service.
    """
    expected = os.environ.get("AUTH_TOKEN")
    if not expected:
        # Fail-closed: if the server forgot to configure a token, do not
        # silently accept all requests.
        raise HTTPException(status_code=500, detail="AUTH_TOKEN not configured")
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if token != expected:
        raise HTTPException(status_code=403, detail="invalid token")


class RunRequest(BaseModel):
    """Body for POST /run. Phase 3 will add argument validation per script."""

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


@app.get("/health")
def health() -> dict[str, Any]:
    """Railway health-probe target. No auth."""
    return {"ok": True, "version": app.version, "phase": 1}


@app.post("/run", response_model=RunResponse)
def run(req: RunRequest, _auth: None = Depends(require_auth)) -> RunResponse:
    """Phase 1 stub — returns a fresh job_id without doing any work.

    Phase 3 will spawn a subprocess that imports `ml.src.pac_backtest` and
    runs the requested script, streaming logs to `/tmp/jobs/<id>.log` and
    uploading the result JSON to Vercel Blob when done.
    """
    job_id = str(uuid.uuid4())
    return RunResponse(
        job_id=job_id,
        status="echo-only-phase1",
        message=f"Received request to run {req.script!r}. "
        "Not executed — Phase 1 is scaffold-only.",
    )


@app.get("/status/{job_id}", response_model=StatusResponse)
def status(job_id: str, _auth: None = Depends(require_auth)) -> StatusResponse:
    """Phase 1 stub — always reports unknown. Phase 3 will persist job
    records to blob and look them up here."""
    return StatusResponse(
        job_id=job_id,
        status="unknown",
        message="Phase 1 is scaffold-only — no job persistence yet.",
    )
