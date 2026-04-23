"""Sweep subprocess dispatcher + Vercel Blob result uploader.

The `/run` endpoint hands a whitelisted script name + arg dict to
`dispatch()`, which runs in a background thread. The thread spawns the
script as a subprocess with PYTHONPATH set to /app/ml-src (so
`import pac.archive_loader` etc. resolve), waits for completion, uploads
the result JSON to Vercel Blob, and updates the job meta file on the
volume at /data/jobs/<job_id>/meta.json.

Design constraints:
  - **One job at a time.** Module-level `_run_lock` enforces single-flight.
    A second /run returns 429 Too Many Requests via `is_running()` probe.
  - **State persists on volume.** /data/jobs/<job_id>/{meta.json, log.txt,
    result.json} survive container restarts. /status/:id reads meta.json
    from disk, so a crash mid-sweep leaves a recoverable trail.
  - **Blob upload uses BLOB_READ_WRITE_TOKEN** (same token the hydrator
    uses to READ the archive). Vercel Blob REST API: PUT to
    https://blob.vercel-storage.com/<pathname> with Bearer auth.
  - **Stdlib only on the hot path.** urllib.request handles the blob PUT.
    No requests/httpx to keep the startup fast.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import subprocess
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# Whitelist of runnable scripts. Keys are the value clients pass in /run's
# body as `{"script": "..."}`. Values are absolute paths to entry scripts
# inside the container (COPYd by the Dockerfile from ml/scripts).
WHITELIST: dict[str, str] = {
    "pine_match_2026_window": "/app/ml-scripts/pine_match_2026_window.py",
    # Phase 4 will add:
    # "full_cpcv_optuna_sweep": "/app/ml-scripts/full_cpcv_optuna_sweep.py",
}

# Jobs scratch directory lives alongside /data/archive (same mounted volume).
# Split from archive so we can prune old jobs without touching parquet data.
JOBS_ROOT = Path(
    os.environ.get("JOBS_ROOT") or str(Path("/data") / "jobs")
)

# Upper bound per subprocess. Full 3-year CPCV sweeps take ~90 min on the
# user's laptop; 3h gives 2x headroom on Railway hardware.
SUBPROCESS_TIMEOUT_S = 3 * 60 * 60

# Archive root (overridable via env). Passed down to the subprocess so
# pac.archive_loader reads from the mounted volume.
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT", "/data/archive")


# ---------------------------------------------------------------------------
# Single-flight state
# ---------------------------------------------------------------------------

_run_lock = threading.Lock()


def is_running() -> bool:
    """True iff a sweep subprocess is currently active in this process."""
    acquired = _run_lock.acquire(blocking=False)
    if acquired:
        _run_lock.release()
        return False
    return True


# ---------------------------------------------------------------------------
# Per-job paths
# ---------------------------------------------------------------------------


def _job_dir(job_id: str) -> Path:
    return JOBS_ROOT / job_id


def _meta_path(job_id: str) -> Path:
    return _job_dir(job_id) / "meta.json"


def _log_path(job_id: str) -> Path:
    return _job_dir(job_id) / "log.txt"


def _result_path(job_id: str) -> Path:
    return _job_dir(job_id) / "result.json"


def read_meta(job_id: str) -> dict[str, Any] | None:
    """Load the on-disk meta record for `job_id`, or None if missing."""
    p = _meta_path(job_id)
    if not p.is_file():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("Failed to read meta for %s: %s", job_id, exc)
        return None


def _write_meta(job_id: str, meta: dict[str, Any]) -> None:
    """Atomic-ish write of meta.json (tmp file + rename)."""
    p = _meta_path(job_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(meta, indent=2, default=str))
    tmp.replace(p)


def tail_log(job_id: str, lines: int = 100) -> str | None:
    """Return the last `lines` lines of the job's log file."""
    p = _log_path(job_id)
    if not p.is_file():
        return None
    # Read as bytes to handle mid-line truncation gracefully.
    raw = p.read_bytes()
    decoded = raw.decode("utf-8", errors="replace")
    return "\n".join(decoded.splitlines()[-lines:])


# ---------------------------------------------------------------------------
# Vercel Blob upload
# ---------------------------------------------------------------------------


def _upload_to_blob(local_path: Path, blob_path: str, token: str) -> dict[str, Any]:
    """PUT the file at `local_path` to Vercel Blob at `blob_path`.

    Uses BLOB_READ_WRITE_TOKEN (starts with `vercel_blob_rw_...`) as Bearer.
    Returns the decoded JSON response containing `url`, `downloadUrl`, etc.

    API shape reverse-engineered from @vercel/blob SDK source (put-helpers.ts
    + api.ts):
      - Endpoint: https://vercel.com/api/blob/?pathname=<urlencoded>
        (the SDK's `getApiUrl` concatenates pathname onto that base; put.ts
        uses the pathname as a query parameter on the root endpoint.)
      - Method: PUT
      - x-api-version: currently 12 (overridable via VERCEL_BLOB_API_VERSION_OVERRIDE)
      - x-vercel-blob-access: "private" | "public"
      - x-allow-overwrite: "1" | "0" (SDK defaults to 0; we want 1 so re-runs of
        the same job_id's path overwrite instead of erroring)
      - x-add-random-suffix: "0" keeps our job_id-scoped paths predictable
      - x-content-type: MIME of the body
    """
    import urllib.parse

    body = local_path.read_bytes()
    url = f"https://vercel.com/api/blob?pathname={urllib.parse.quote(blob_path, safe='/')}"
    req = urllib.request.Request(
        url,
        method="PUT",
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "x-api-version": "12",
            "x-vercel-blob-access": "private",
            "x-add-random-suffix": "0",
            "x-allow-overwrite": "1",
            "x-content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


# ---------------------------------------------------------------------------
# Job dispatch
# ---------------------------------------------------------------------------


def create_job_record(job_id: str, script: str, args: dict[str, Any]) -> None:
    """Initialize the meta file so /status can see the queued job."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    _write_meta(
        job_id,
        {
            "job_id": job_id,
            "script": script,
            "args": args,
            "status": "queued",
            "queued_at": now,
        },
    )


def dispatch(job_id: str, script: str, args: dict[str, Any]) -> None:
    """Run `script` with `args` and upload the result to blob.

    Blocking. Meant to be called from a daemon thread. Updates meta.json
    on the volume as the job progresses so /status/<job_id> can surface
    live state. Releases the single-flight lock in finally.
    """
    if not _run_lock.acquire(blocking=False):
        # Shouldn't happen if the caller checked is_running() first, but
        # belt-and-suspenders — record the rejection.
        meta = read_meta(job_id) or {"job_id": job_id}
        meta["status"] = "rejected"
        meta["message"] = "Another job was already running when dispatch started"
        _write_meta(job_id, meta)
        return

    meta: dict[str, Any] = read_meta(job_id) or {
        "job_id": job_id,
        "script": script,
        "args": args,
    }
    meta["status"] = "running"
    meta["started_at"] = datetime.datetime.utcnow().isoformat() + "Z"
    _write_meta(job_id, meta)

    try:
        # ── Validate script is whitelisted ──
        if script not in WHITELIST:
            raise ValueError(f"Script {script!r} not in whitelist {list(WHITELIST)}")
        script_path = WHITELIST[script]

        # ── Build command line ──
        cmd: list[str] = ["python", script_path]
        for key, value in args.items():
            flag = f"--{key.replace('_', '-')}"
            cmd.extend([flag, str(value)])
        cmd.extend(["--out", str(_result_path(job_id))])
        meta["cmd"] = cmd
        _write_meta(job_id, meta)
        log.info("Job %s cmd: %s", job_id, cmd)

        # ── Run subprocess ──
        env = os.environ.copy()
        env["PYTHONPATH"] = "/app/ml-src"
        env["ARCHIVE_ROOT"] = ARCHIVE_ROOT

        _log_path(job_id).parent.mkdir(parents=True, exist_ok=True)
        with _log_path(job_id).open("wb") as log_fh:
            proc = subprocess.run(  # noqa: S603  — cmd is whitelisted
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                env=env,
                timeout=SUBPROCESS_TIMEOUT_S,
                check=False,
            )
        meta["returncode"] = proc.returncode

        if proc.returncode != 0:
            meta["status"] = "failed"
            meta["message"] = f"subprocess exited with {proc.returncode}"
            meta["log_tail"] = tail_log(job_id, lines=40)
            return  # finally still runs, meta is already written in finally

        # ── Subprocess must have produced the result JSON ──
        rp = _result_path(job_id)
        if not rp.is_file():
            meta["status"] = "failed"
            meta["message"] = f"script did not write --out file at {rp}"
            meta["log_tail"] = tail_log(job_id, lines=40)
            return

        # ── Upload result to blob ──
        token = os.environ.get("BLOB_READ_WRITE_TOKEN", "").strip()
        if not token:
            meta["status"] = "failed"
            meta["message"] = "BLOB_READ_WRITE_TOKEN missing on service env"
            return

        today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
        tf = str(args.get("timeframe", "1m"))
        blob_path = f"sweeps/{today}/{job_id}-{script}-{tf}.json"
        meta["blob_path"] = blob_path

        try:
            upload_resp = _upload_to_blob(rp, blob_path, token)
        except urllib.error.HTTPError as exc:
            meta["status"] = "failed"
            meta["message"] = f"blob upload {exc.code}: {exc.reason}"
            return

        meta["result_url"] = upload_resp.get("url")
        meta["download_url"] = upload_resp.get("downloadUrl")
        meta["result_bytes"] = rp.stat().st_size
        meta["status"] = "succeeded"

    except subprocess.TimeoutExpired as exc:
        meta["status"] = "failed"
        meta["message"] = f"subprocess timed out after {exc.timeout}s"
        meta["log_tail"] = tail_log(job_id, lines=40)
    except Exception as exc:  # noqa: BLE001
        meta["status"] = "failed"
        meta["message"] = f"{type(exc).__name__}: {exc}"
        meta["log_tail"] = tail_log(job_id, lines=40)
        log.error("Job %s failed: %s", job_id, exc, exc_info=True)
    finally:
        meta["finished_at"] = datetime.datetime.utcnow().isoformat() + "Z"
        _write_meta(job_id, meta)
        _run_lock.release()
