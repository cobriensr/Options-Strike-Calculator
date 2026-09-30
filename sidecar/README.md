# Railway Sidecar (SHAP + Archive + Theta)

Python service deployed to **Railway** (not Vercel). Serves the Takeit SHAP explainer, read-only DuckDB queries over the historical futures archive, and the multi-leg classifier fallback; also hosts the co-resident Theta Data Terminal.

> **Databento ingestion removed (2026-09-29).** The sidecar used to stream futures OHLCV-1m bars, top-of-book, trade ticks, and ES options trades/statistics from Databento into Neon. The Databento subscription was cancelled, so that path (and the `databento` dependency and `DATABENTO_API_KEY`) is gone. Live futures data now comes from the `uw-stream` Railway service. The `/data/archive` Parquet archive (originally sourced from Databento) is frozen but still served read-only.

## Why a separate service?

The DuckDB archive needs a persistent `/data` volume, the SHAP explainer keeps heavy ML deps and loaded model bundles warm, and Theta Data Terminal is a Java daemon with persistent state. None of that fits Vercel's stateless function model. Railway lets us run a real process with a `/data` volume and a co-resident Java JRE.

## What it does

- **Theta Data Terminal** — Co-resident Java service (Eclipse Temurin 21) for nightly EOD options data.
- **Archive volume** — Persistent `/data/archive` on Railway, SHA-resumable seed from Vercel Blob via `POST /admin/seed-archive`. See `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.
- **Multi-leg classifier** — `src/multileg_routes.py` exposes sidecar-side analysis used by detect crons.
- **Takeit ML server** — `src/takeit_server.py` serves SHAP explanations (`/takeit/explain`, `/takeit/health`) for the `takeit-fill-shap` cron.
- **Archive reads** — `src/archive_query.py` runs DuckDB over the Parquet archive for the `/archive/*` routes (called via `api/_lib/archive-sidecar.ts`).

Consumer side of the data is in [api/\_lib/db.ts](../api/_lib/db.ts) and the cron handlers under `api/cron/`.

## Local development

```bash
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in DATABASE_URL at minimum.
python -m src.main
```

Health check: `curl http://localhost:8080/health` (200 when the DB is reachable).

### Tests

```bash
pytest tests/
# or
make test
```

The Makefile wraps the common workflows (`make lint`, `make test`, `make run`).

## Environment variables

Sidecar is the canonical owner of these in **Railway**, not Vercel. `.env.example` lists the local-dev minimum; full Railway list:

| Variable                | Required? | Purpose                                                       |
| ----------------------- | --------- | ------------------------------------------------------------- |
| `DATABASE_URL`          | yes       | Neon connection (uses psycopg2, not @neondatabase/serverless) |
| `SENTRY_DSN`            | yes       | Error tracking (tagged `server_name=sidecar`)                 |
| `THETA_EMAIL`           | yes       | Theta Data Terminal login                                     |
| `THETA_PASSWORD`        | yes       | Theta Data Terminal password                                  |
| `ARCHIVE_MANIFEST_URL`  | yes       | Manifest of archive files in Blob                             |
| `ARCHIVE_SEED_TOKEN`    | yes       | Gates `POST /admin/seed-archive`                              |
| `ARCHIVE_ROOT`          | optional  | Volume path; defaults to `/data/archive`                      |
| `BLOB_READ_WRITE_TOKEN` | yes       | Archive seeder reads from Vercel Blob                         |
| `RAILWAY_RUN_UID`       | yes       | `0` on Railway so the container can write to the volume       |
| `PORT`                  | optional  | Default 8080                                                  |
| `LOG_LEVEL`             | optional  | Default INFO                                                  |

## Deployment

Railway auto-deploys on push to `main` for this service. `vercel.json`'s `ignoreCommand` skips Vercel deploys for changes confined to `sidecar/`, so Vercel and Railway are independent.

```bash
# View Railway logs
railway logs --service sidecar

# Force redeploy
railway up
```

`railway.toml` controls Railway runtime config; the [Dockerfile](Dockerfile) is the source of truth for the build.

## Source layout

```
src/
  main.py             # Entry point: env check, Theta boot, HTTP server
  config.py           # Env vars + settings
  db.py               # psycopg2 pool + helpers
  theta_client.py     # Theta Data Terminal HTTP client
  theta_launcher.py   # Manages the co-resident Java jar
  theta_fetcher.py    # Periodic Theta polls
  front_month.py      # Front-month CTE SQL for archive queries
  multileg_routes.py  # /takeit/multileg-classify
  takeit_server.py    # /takeit/explain + /takeit/health (SHAP)
  archive_seeder.py   # /admin/seed-archive
  archive_query.py    # Read-side of /data/archive
  health.py           # HTTP server + /health and route dispatch
  sentry_setup.py     # Sentry tagging
  logger_setup.py     # Pino-style structured logs
```

## Related specs

- `docs/superpowers/specs/theta-railway-sidecar-2026-04-18.md` — design
- `docs/superpowers/specs/sidecar-refactor-2026-05-02.md` — modular split
- `docs/superpowers/specs/max-leverage-databento-uw-2026-04-18.md` — data sourcing decisions
- `docs/superpowers/specs/phase2a-sidecar-l1-ingest-2026-04-18.md` — L1 ingest pipeline
- `docs/superpowers/specs/archive-volume-seed-2026-04-18.md` — archive volume contract

## Operational notes

- `ThetaTerminalv3.jar` (~12 MB) is committed so the build is hermetic. Update by replacing the jar; record the version in the commit message.
- `psycopg2` is used here (not asyncpg or `@neondatabase/serverless`) because the workload is sync, long-lived, and uses prepared statements heavily.
- The `uw-stream` Railway service uses **asyncpg** instead — different access pattern (concurrent, fan-in from websocket).
