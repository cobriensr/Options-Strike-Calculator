# ml-sweep — Railway-hosted PAC backtest runner

Sibling service to [`sidecar/`](../sidecar/). Runs the Python PAC
backtest suite (CPCV, Optuna, pine-match validation) on Railway's
compute so the developer laptop doesn't have to.

Full design: [pac-sweep-railway-service-2026-04-22.md](../docs/superpowers/specs/pac-sweep-railway-service-2026-04-22.md).

## Current phase: 2 — hydration

`/health`, `/hydrate`, and `/hydrate/status` are live. `/run` still
returns an echo stub — Phase 3 will wire the real sweep subprocess
dispatcher + blob result upload.

## Endpoints

| Method | Path               | Auth   | Purpose                                                                                                               |
| ------ | ------------------ | ------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`          | none   | Railway health probe; returns `{ok: true, phase: 2}`                                                                  |
| `POST` | `/hydrate`         | Bearer | Start downloading the Databento archive from Vercel Blob to `/data/archive`. Returns 202 immediately with a `job_id`. |
| `GET`  | `/hydrate/status`  | Bearer | Poll hydration progress + on-disk file count.                                                                         |
| `POST` | `/run`             | Bearer | Phase 3: queue a sweep job, return a `job_id`                                                                         |
| `GET`  | `/status/{job_id}` | Bearer | Phase 3: check sweep job state; returns blob URL when done                                                            |

## Auth

All mutation/read endpoints except `/health` require
`Authorization: Bearer <token>` where `<token>` matches the `AUTH_TOKEN`
env var on the Railway service.

## Required env vars on Railway

| Variable                | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `AUTH_TOKEN`            | Bearer token gate for `/run`, `/status/*`, `/hydrate*`               |
| `ARCHIVE_ROOT`          | `/data/archive` — where parquets land                                |
| `ARCHIVE_MANIFEST_URL`  | Vercel Blob URL listing every archive file + SHA (copy from sidecar) |
| `ARCHIVE_SEED_TOKEN`    | Bearer token for the manifest + each blob file (copy from sidecar)   |
| `RAILWAY_RUN_UID`       | `1001` — lets the non-root `sweep` user write to the mounted volume  |
| `BLOB_READ_WRITE_TOKEN` | (Phase 3) Upload sweep results to Vercel Blob                        |

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
