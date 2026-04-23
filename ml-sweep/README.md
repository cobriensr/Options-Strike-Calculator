# ml-sweep — Railway-hosted PAC backtest runner

Sibling service to [`sidecar/`](../sidecar/). Runs the Python PAC
backtest suite (CPCV, Optuna, pine-match validation) on Railway's
compute so the developer laptop doesn't have to.

Full design: [pac-sweep-railway-service-2026-04-22.md](../docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md).

## Current phase: 3 — sweep runner

`/run` now spawns whitelisted scripts as subprocesses and uploads the
final JSON result to Vercel Blob. `/status/{job_id}` reads live state
from `/data/jobs/{job_id}/meta.json` on the volume, so container
restarts don't lose job history.

### Whitelisted scripts

| Name                     | Path in container                           | Accepts                                                    |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `pine_match_2026_window` | `/app/ml-scripts/pine_match_2026_window.py` | `timeframe` (1m\|5m), `start`, `end`, `symbol`             |
| `full_cpcv_optuna_sweep` | `/app/ml-scripts/full_cpcv_optuna_sweep.py` | `timeframe`, `start`, `end`, `markets`, `n-trials`, `seed` |

### Running a full 3-year sweep

```bash
source ml-sweep/.env
# 1m, NQ+ES, full 2022-2024 window, default 50 trials/fold — ~2h on Railway
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
      "n-trials": 50
    }
  }'
```

Then fire the 5m run after the 1m finishes (one-at-a-time lock):

```bash
curl -sS -X POST "$ML_SWEEP_URL/run" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script":"full_cpcv_optuna_sweep","args":{"timeframe":"5m","markets":"NQ","start":"2022-01-01","end":"2024-12-31","n-trials":50}}'
```

**Smoke-test flag**: pass `n-trials: 5` and a narrow window (e.g.
`start: 2022-01-01, end: 2022-02-01`) for a ~5-minute dry-run before
committing to the full multi-hour sweep.

Subprocess timeout is 6 hours. Most full sweeps complete in 2-4 hours.

### Running a sweep

```bash
source ml-sweep/.env
# Fire a 5m-timeframe run:
curl -sS -X POST "$ML_SWEEP_URL/run" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"script":"pine_match_2026_window","args":{"timeframe":"5m"}}'
# → 202 {"job_id":"...","status":"accepted","message":"Sweep started..."}

# Poll:
curl -sS "$ML_SWEEP_URL/status/<job_id>" \
  -H "Authorization: Bearer $AUTH_TOKEN" | jq

# When status=succeeded, download the result:
curl -H "Authorization: Bearer $BLOB_READ_WRITE_TOKEN" \
  <result_url> > /tmp/sweep_result.json
```

Only one sweep runs at a time. Second `/run` while one is in flight
returns `429 Too Many Requests`.

## Endpoints

| Method | Path               | Auth   | Purpose                                                                                                               |
| ------ | ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`          | none   | Railway health probe; returns `{ok: true, phase: 3}`                                                                  |
| `POST` | `/hydrate`         | Bearer | Start downloading the Databento archive from Vercel Blob to `/data/archive`. Returns 202 immediately with a `job_id`. |
| `GET`  | `/hydrate/status`  | Bearer | Poll hydration progress + on-disk file count.                                                                         |
| `POST` | `/run`             | Bearer | Phase 3: queue a sweep job, return a `job_id`                                                                         |
| `GET`  | `/status/{job_id}` | Bearer | Phase 3: check sweep job state; returns blob URL when done                                                            |

## Auth

All mutation/read endpoints except `/health` require
`Authorization: Bearer <token>` where `<token>` matches the `AUTH_TOKEN`
env var on the Railway service.

## Required env vars on Railway

| Variable                | Purpose                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `AUTH_TOKEN`            | Bearer token gate for `/run`, `/status/*`, `/hydrate*`                                               |
| `ARCHIVE_ROOT`          | `/data/archive` — where parquets land                                                                |
| `ARCHIVE_MANIFEST_URL`  | Vercel Blob URL listing every archive file + SHA (copy from sidecar)                                 |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob bearer for the manifest + each archive file (copy from sidecar). Phase 3 also uses this. |
| `RAILWAY_RUN_UID`       | `0` — required so the container runs as root and can write the root-owned mounted volume             |

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

## Deploying changes

Auto-deploys on any push to `main` that touches `ml-sweep/**` or `ml/**`
(see `railway.toml` watchPatterns).

## Scaling to zero (save money)

After completing a sweep, scale to zero replicas:

```bash
railway service scale --replicas 0 --service ml-sweep
```

Bring it back for the next run:

```bash
railway service scale --replicas 1 --service ml-sweep
```

Cold start is ~15-30 sec (container boot). Archive hydration is
skipped on restart — the volume persists across replicas.

## Destroying

```bash
railway service delete ml-sweep
```

Removes the service. The attached volume and parent project are not
affected (volume deletion is a separate step).
