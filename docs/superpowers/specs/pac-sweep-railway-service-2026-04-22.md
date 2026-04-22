# PAC Sweep Railway Service — `ml-sweep`

**Date:** 2026-04-22
**Owner:** @cobriensr
**Status:** planning
**Trigger:** User's laptop can't handle full CPCV/Optuna backtest sweeps; need remote compute. Chose Option A + HTTP trigger pattern from `2026-04-22` brainstorm.

## Goal

One sentence: **Stand up a second Railway service (`ml-sweep`) in the existing `Theta-Options` project that runs PAC backtests on-demand via HTTP, reads the Databento archive (from shared volume or blob), and uploads JSON results to Vercel Blob for the user to download.**

This unblocks the immediate need to re-run the 2022-2024 CPCV + Optuna sweep with the BOS-causality fix (spec-ref: `pac-exit-trigger-finding-2026-04-22.md` and the lookahead finding from the Pine convergence thread).

## Scope

### In scope

- A new Railway service named `ml-sweep` in the existing `Theta-Options` project.
- A minimal FastAPI app with 3 endpoints: `GET /health`, `POST /run`, `GET /status/:job_id`.
- Dockerfile at `ml-sweep/Dockerfile` (Python 3.14-slim, installs `ml/requirements.txt`, copies `ml/src/`).
- A thin job-runner layer that invokes one of the existing `ml/scripts/*.py` entry points with user-supplied args.
- Result upload to Vercel Blob via `@vercel/blob`'s Python equivalent (`vercel-blob` or raw HTTP).
- Railway config so this service deploys only when `ml-sweep/` or `ml/` changes.

### Out of scope

- Scheduled / cron sweeps (can add later).
- Parallelizing across multiple Railway regions.
- A UI for launching sweeps (curl is fine for now).
- Replacing or modifying the existing sidecar service.
- Fixing the lookahead bug itself (different spec — this one is just infrastructure).

## Phases

### Phase 1: Service scaffold (1-2 hours, shippable standalone)

Build the minimum viable `ml-sweep` service that just echoes — proves the Railway setup works before we put real sweep code in it.

- Create `ml-sweep/Dockerfile`, `ml-sweep/app.py` (FastAPI), `ml-sweep/requirements.txt`, `ml-sweep/railway.toml`.
- Endpoints:
  - `GET /health` → `{"ok": true}`
  - `POST /run` → immediately returns `{"job_id": "<uuid>", "status": "echo-only-phase1"}` (no actual work yet)
- Deploy to Railway via `railway up` from `ml-sweep/`.
- Verify health check passes and we can curl from local.

**Done criteria:** `curl https://ml-sweep.up.railway.app/health` returns 200.

### Phase 2: Archive access (1 hour, branches on volume decision)

Get the Databento parquets into the sweep container.

**Decision point:** Can we share `options-strike-calculator-volume` across two services live, or do we need to sync from blob?

- **Investigation:** `railway volume attach --service ml-sweep` — does it work concurrently with sidecar's attachment? Railway's docs aren't explicit; a 2-minute test answers definitively.
- **If shared volume works (preferred):** mount at `/data` read-only in the sweep container; sweep code uses `ARCHIVE_ROOT=/data/archive` exactly like sidecar does.
- **If not:** the sweep service hydrates from Vercel Blob on cold start, using the existing `ARCHIVE_MANIFEST_URL` / `ARCHIVE_SEED_TOKEN` plumbing. Cache the download in `/tmp/archive/` so warm starts are fast.

**Done criteria:** from inside the sweep container, `ml/.venv/bin/python -c "from pac.archive_loader import load_bars; print(load_bars('NQ', '2024-01-01', '2024-01-10').shape)"` returns a sane bar count.

### Phase 3: Sweep runner (2-3 hours)

Wire the FastAPI `POST /run` endpoint to actually execute a sweep.

- Accept a JSON body like `{"script": "pine_match_2026_window", "args": {...}}` where `script` is a whitelisted entry name (not raw shell).
- Spawn the sweep as a subprocess (`python -m ml.scripts.<script>` with arg overrides via env vars or argparse).
- Stream stdout/stderr to a growing log file at `/tmp/jobs/<job_id>.log`.
- Non-blocking: return `{"job_id": ...}` immediately; client polls `GET /status/:job_id`.
- When the subprocess exits, upload its result JSON(s) to Vercel Blob (private URL, 7-day TTL) and update the job state.

**Whitelist of runnable scripts (Phase 3 minimum):**

1. `pine_match_2026_window` — quick validation (~30 sec, our existing script).
2. `full_cpcv_optuna_sweep` — the big one (maybe add as Phase 4).

**Done criteria:** `curl -X POST /run -d '{"script": "pine_match_2026_window"}'` returns a job_id; polling `/status/:job_id` eventually returns a blob URL; the URL contents match what we got running locally earlier today.

### Phase 4: Full CPCV + Optuna driver (2-3 hours)

Port the existing CPCV/Optuna sweep logic to run under the sweep service. Most of this already exists in `ml/src/pac_backtest/` and was used to produce the v4 sweep results last week — we just need to expose it through the new entry point.

- Add `ml/scripts/full_cpcv_optuna_sweep.py` (if not already there) that accepts `--start`, `--end`, `--symbol`, `--fold-count`, `--trial-count`, `--params-yaml` as CLI args.
- Whitelist it in the FastAPI dispatcher.
- Ensure the output writes to `ml/ml/experiments/sweeps/<timestamp>/` structure so it matches the existing convention; upload the whole directory as a zip to blob.

**Done criteria:** running the full 2022-2024 NQ sweep via `/run` completes in under 2 hours (acceptable Railway cost) and the results zip downloads cleanly.

### Phase 5: Documentation + teardown controls (30 min)

- Update `CLAUDE.md` to mention the new service.
- Add a `ml-sweep/README.md` with usage examples (`curl` snippets, env var list).
- Document how to pause the service when idle to save Railway costs (`railway service scale --replicas 0`).
- Document how to destroy the service entirely if we decide to stop using it.

**Done criteria:** a fresh reader could find the README and run their first sweep without asking.

## Files to create / modify

### New files

- `ml-sweep/Dockerfile` — Python 3.14-slim, installs ml/requirements.txt, copies ml/src/, runs FastAPI on `$PORT`.
- `ml-sweep/app.py` — FastAPI app with the 3 endpoints.
- `ml-sweep/runner.py` — subprocess dispatcher + blob uploader.
- `ml-sweep/requirements.txt` — FastAPI, uvicorn, pydantic, plus all of `ml/requirements.txt` pinned.
- `ml-sweep/railway.toml` — `watchPatterns = ["ml-sweep/**", "ml/**"]`, buildCommand, startCommand.
- `ml-sweep/README.md` — usage docs.
- `ml/scripts/full_cpcv_optuna_sweep.py` (Phase 4) — CLI entry point for the full sweep.

### Modified files

- `CLAUDE.md` — one-line mention of ml-sweep in the Architecture section.
- `vercel.json` — add `ml-sweep` to the `ignoreCommand` path list (don't rebuild Vercel app when sweep service changes).
- `.gitignore` — add `ml-sweep/__pycache__/`, `ml-sweep/.env*`.

## Data dependencies

### Env vars on the `ml-sweep` Railway service

| Variable                | Source                                        | Purpose                                 |
| ----------------------- | --------------------------------------------- | --------------------------------------- |
| `PORT`                  | Railway auto-injected                         | FastAPI listen port                     |
| `ARCHIVE_ROOT`          | Static (`/data/archive`)                      | Sidecar's parquet path                  |
| `ARCHIVE_MANIFEST_URL`  | Copy from sidecar env                         | Fallback for blob-sync mode             |
| `ARCHIVE_SEED_TOKEN`    | Copy from sidecar env                         | Auth for the seed endpoint              |
| `BLOB_READ_WRITE_TOKEN` | Copy from sidecar env                         | Upload results to blob                  |
| `DATABENTO_API_KEY`     | Copy from sidecar env                         | If sweep needs fresh data               |
| `DATABASE_URL`          | **Skip** — sweep shouldn't write to prod Neon | —                                       |
| `AUTH_TOKEN`            | **New** — generate a random secret            | Gate `/run` endpoint so nobody spams it |

### Volume

Decision deferred to Phase 2 (shared vs blob-sync). If shared works, no data transfer cost. If not, ~5 GB one-time download per cold start (cache mitigates).

## Open questions

1. **Volume sharing**: Does Railway support cross-service volume attachment on our plan? If no → blob-sync. Answer via quick test in Phase 2.
2. **Authentication**: a simple bearer token (`AUTH_TOKEN` header) is fine for gating `/run`, since this is single-owner. Confirm before building.
3. **Result size**: how big does a full CPCV sweep result get? If >100 MB, we might need to chunk uploads. Based on the existing `ml/ml/experiments/sweeps/20260420T193741Z/` outputs (which are trimmed JSONs), probably <20 MB — safe for a single blob upload.
4. **Cost ceiling**: Railway charges per resource-hour. Default recommendation: scale to 0 replicas when idle (after each sweep), scale to 1 when user hits `/run`. Confirm user is okay with ~30-60 sec cold-start latency per sweep.
5. **Do we also need a DB for job persistence?** If the service crashes mid-sweep, the `/status` query returns 404 unless we persist job state. Options: (a) accept this, one-shot jobs only; (b) use Neon for persistence (add `DATABASE_URL`); (c) persist to blob under `jobs/<job_id>.json`. Default pick: (c) — keeps the sweep service stateless.

## Thresholds / constants

- **Job timeout**: 3 hours. Kill the subprocess and report failure if exceeded. (Full 2022-2024 CPCV sweep takes ~90 min locally; 3h is 2× headroom.)
- **Concurrent jobs**: 1. If a second `/run` arrives while one is in flight, return 429. Simplifies state management.
- **Log file retention**: keep the last 10 job logs on local disk; older ones evicted.
- **Blob TTL**: 7 days on result uploads. User can download + commit results to git within that window.
- **Volume size**: 5 GB is nearly full. If blob-sync mode is chosen, we'll also need ~5 GB scratch in `/tmp` during hydration.

## Follow-on work

- Scheduled nightly full-sweep cron (via Railway cron or GitHub Actions calling the endpoint).
- Output comparison tool: diff two sweep result JSONs and surface which params/folds changed.
- Slack / push notification on sweep completion.
- Auto-upload results to a `sweeps/` git branch for version control.

## Risk / mitigation

| Risk                                                               | Likelihood | Mitigation                                                                                   |
| ------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------- |
| Railway volume sharing doesn't work and blob hydration is too slow | Medium     | Blob download is ~50 MB/sec in Railway's network; 5 GB = ~100 sec. Acceptable on cold start. |
| Sweep OOMs on Railway's default RAM tier                           | Medium     | Start with 4 GB, scale up if needed. Log memory use during first real sweep.                 |
| Cost spirals if we forget to scale to 0                            | Low        | Scale-to-0 automation after each sweep, documented in README.                                |
| Someone hits `/run` publicly and burns compute                     | Medium     | AUTH_TOKEN required on all mutation endpoints.                                               |
| Job state lost on restart → user can't find result                 | Low        | Persist minimal job record to blob as part of success path (Phase 3).                        |

## Review gate

Before Phase 2 starts: commit Phase 1 and verify it runs. Before Phase 4 starts: confirm Phase 3 produced a correct result for `pine_match_2026_window` (smoke test). Before Phase 5: have run at least one real CPCV sweep end-to-end.
