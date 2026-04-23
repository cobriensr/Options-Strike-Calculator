# ml-sweep — Railway-hosted PAC backtest runner

Sibling service to [`sidecar/`](../sidecar/). Runs the Python PAC
backtest suite (CPCV, Optuna, pine-match validation) on Railway's
compute so the developer laptop doesn't have to.

Full design: [pac-sweep-railway-service-2026-04-22.md](../docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md).

## Current phase: 4 — sweep runner with observability

`/run` spawns whitelisted scripts as subprocesses and uploads the final
JSON result to Vercel Blob. `/status/{job_id}` reads live state
(including a rolling 1-hour RSS history) from
`/data/jobs/{job_id}/meta.json`. `/logs/{job_id}` tails subprocess
stdout+stderr. Container restarts can't lose state: orphaned jobs are
flipped to `failed` on next boot.

### Whitelisted scripts

| Name                     | Path in container                           | Accepts                                                    |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `pine_match_2026_window` | `/app/ml-scripts/pine_match_2026_window.py` | `timeframe` (1m\|5m), `start`, `end`, `symbol`             |
| `full_cpcv_optuna_sweep` | `/app/ml-scripts/full_cpcv_optuna_sweep.py` | `timeframe`, `start`, `end`, `markets`, `n-trials`, `seed` |

### Running a full 3-year sweep

```bash
source ml-sweep/.env
# 1m, NQ, full 2022-2024 window, 30 trials/fold — ~2h on Railway
curl -sS -X POST "$ML_SWEEP_URL/run" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "script": "full_cpcv_optuna_sweep",
    "args": {
      "timeframe": "1m",
      "markets": "NQ",
      "start": "2022-01-01",
      "end": "2024-12-31",
      "n-trials": 30
    }
  }'
```

Then fire the 5m run after the 1m finishes (one-at-a-time lock):

```bash
curl -sS -X POST "$ML_SWEEP_URL/run" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script":"full_cpcv_optuna_sweep","args":{"timeframe":"5m","markets":"NQ","start":"2022-01-01","end":"2024-12-31","n-trials":30}}'
```

**Chunked pattern (recommended):** for multi-year sweeps, fire one year
at a time so a single chunk failure doesn't waste the whole window. See
the A2 chain at `scripts/sweep_chain_a2.sh` for an example. Each chunk
writes an independent `result.json` on the volume plus a blob upload.

**Smoke-test flag**: pass `n-trials: 5` and a narrow window (e.g.
`start: 2022-01-01, end: 2022-02-01`) for a ~5-minute dry-run before
committing to the full multi-hour sweep.

Subprocess timeout is 6 hours. Full 1-year CPCV+Optuna sweeps complete
in 20-40 min depending on timeframe; 3-year sweeps in 1-3h.

### Polling a running sweep

```bash
source ml-sweep/.env
# Full status (including RSS history):
curl -sS "$ML_SWEEP_URL/status/<job_id>" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# Key fields:
#   status          queued | running | succeeded | failed | rejected | unknown
#   heartbeat_at    updated every 30s while subprocess is alive
#   rss_kb          latest sampled child RSS in KB
#   peak_rss_kb     max child RSS seen so far
#   rss_history     rolling 1h timeline of {t, child_kb, parent_kb}
#   result_url      set when status=succeeded; public blob URL
#   download_url    same but triggers Content-Disposition: attachment

# Tail the log (stdout+stderr):
curl -sS "$ML_SWEEP_URL/logs/<job_id>?lines=200" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq -r .text

# When status=succeeded, download the result:
curl "$result_url" > /tmp/sweep_result.json
```

Only one sweep runs at a time. Second `/run` while one is in flight
returns `429 Too Many Requests`.

## Endpoints

| Method | Path               | Auth   | Purpose                                                             |
| ------ | ------------------ | ------ | ------------------------------------------------------------------- |
| `GET`  | `/health`          | none   | Railway health probe; returns `{ok: true, phase: 4}`                |
| `POST` | `/hydrate`         | Bearer | Pull Databento archive from Vercel Blob into `/data/archive`.       |
| `GET`  | `/hydrate/status`  | Bearer | Poll hydration progress + on-disk file count.                       |
| `POST` | `/run`             | Bearer | Queue a sweep job, return a `job_id`.                               |
| `GET`  | `/status/{job_id}` | Bearer | Read sweep job state + RSS timeline + blob URLs when done.          |
| `GET`  | `/logs/{job_id}`   | Bearer | Tail subprocess stdout+stderr for a given job. `?lines=N` for more. |

## Auth

All mutation/read endpoints except `/health` require
`Authorization: Bearer <token>` where `<token>` matches the `AUTH_TOKEN`
env var on the Railway service.

## Required env vars on Railway

| Variable                | Purpose                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `AUTH_TOKEN`            | Bearer token gate for `/run`, `/status/*`, `/hydrate*`, `/logs/*`                        |
| `ARCHIVE_ROOT`          | `/data/archive` — where parquets land                                                    |
| `ARCHIVE_MANIFEST_URL`  | Vercel Blob URL listing every archive file + SHA (copy from sidecar)                     |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob bearer for manifest reads + result uploads (copy from sidecar).              |
| `RAILWAY_RUN_UID`       | `0` — required so the container runs as root and can write the root-owned mounted volume |

## First-time hydration

The attached 5 GB volume starts empty. Before any sweep can read
parquets, trigger the hydration once:

```bash
source ml-sweep/.env
curl -sS -X POST "$ML_SWEEP_URL/hydrate" \
  -H "Authorization: Bearer $AUTH_TOKEN"
# → 202 Accepted, {"job_id":"...","status":"accepted","message":"..."}

# Poll every 20 sec until last_status == "succeeded"
while true; do
  curl -sS "$ML_SWEEP_URL/hydrate/status" \
    -H "Authorization: Bearer $AUTH_TOKEN" | jq '.'
  sleep 20
done
```

Expect ~100 seconds for a fresh 5 GB download at Railway's ~50 MB/s
internal bandwidth. Subsequent hydrations are near-instant (resumable
via per-file SHA check — already-present files with matching SHA are
skipped).

## Local dev

```bash
cd ml-sweep
pip install -r requirements.txt
AUTH_TOKEN=dev uvicorn app:app --reload --port 8080
curl http://localhost:8080/health
```

RSS telemetry degrades gracefully on macOS (reads `/proc/<pid>/status`
which is Linux-only) — `rss_kb` is returned as null and the rest of the
status response works as normal.

## Deploying changes

Auto-deploys on any push to `main` that touches `ml-sweep/**` or `ml/**`
(see `railway.toml` watchPatterns).

## Reliability notes

### Heartbeat + orphan recovery

Every 30 sec during a run, the dispatcher thread writes
`heartbeat_at` (and RSS samples) into `meta.json`. On app startup and
opportunistically during every `/status` read, `recover_orphaned_jobs()`
scans for meta files with `status="running"` whose `heartbeat_at` is
stale (>5 min) or missing. Those get flipped to `failed` with
`message = "orphaned by container restart ..."`.

This makes container restarts (OOM, maintenance, manual redeploy) safe:
the next poll will see the failed status within one heartbeat window.

### Do NOT enable scale-to-zero on this service

Railway's scale-to-zero / serverless "sleep on inactivity" feature only
counts inbound HTTP traffic. A subprocess burning CPU inside the
container is invisible to the idle detector, so long sweeps get stopped
mid-flight after the HTTP idle window expires (observed: ~8 min on the
default settings). The RSS history stays flat, `returncode` is null,
and Railway logs show a deliberate `"Stopping Container"`.

**Keep the service always-on.** The idle cost is negligible (a few
cents/day at the allocated memory/CPU tier) compared to the operational
cost of retries and the risk of partial results polluting the comparison
dataset.

If cost ever becomes a concern, prefer manual scale-down between sweep
campaigns (replicas=0) over scale-to-zero with inactivity detection:

```bash
# Idle between campaigns:
railway service scale --replicas 0 --service ml-sweep
# Re-activate for the next run:
railway service scale --replicas 1 --service ml-sweep
```

Cold start is ~15-30 sec (container boot). Archive hydration is skipped
on restart — the volume persists across replicas.

### No Docker HEALTHCHECK

The Dockerfile intentionally has no `HEALTHCHECK` directive. Railway
runs its own port probe to `/health`, which is lighter than a Docker
in-container healthcheck and doesn't fight with the subprocess for the
GIL during long sweeps. Adding HEALTHCHECK back caused container
restarts mid-sweep in earlier phases.

## Destroying

See [TEARDOWN.md](./TEARDOWN.md) for the full shutdown and cleanup
procedure (stop service, delete volume, reseed elsewhere if needed).
