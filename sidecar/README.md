# Railway Sidecar (SHAP + Archive)

Python service deployed to **Railway** (not Vercel). Serves the Takeit SHAP explainer and read-only DuckDB queries over the frozen historical futures archive.

> **Databento ingestion removed (2026-09-29).** The sidecar used to stream futures OHLCV-1m bars, top-of-book, trade ticks, and ES options trades/statistics from Databento into Neon. The Databento subscription was cancelled, so that path (and the `databento` dependency and `DATABENTO_API_KEY`) is gone. Live futures data now comes from the `uw-stream` Railway service. The `/data/archive` Parquet archive (originally sourced from Databento) is frozen but still served read-only.
>
> **Theta Data Terminal and multileg-classify fallback removed (2026-10-02).** The co-resident Theta Data Terminal (Java jar, nightly SPX EOD fetch into `theta_option_eod`) never ran in production and is gone, along with its JRE and `THETA_*` env vars. `POST /takeit/multileg-classify` is gone too: the standalone `classifier/` Railway service is the only multileg classifier, and `api/_lib/multileg-client.ts` requires `CLASSIFIER_URL`.

## Why a separate service?

The DuckDB archive needs a persistent `/data` volume, and the SHAP explainer keeps heavy ML deps and loaded model bundles warm. Neither fits Vercel's stateless function model. Railway lets us run a real process with a `/data` volume.

## What it does

- **Archive volume** — Persistent `/data/archive` on Railway, SHA-resumable seed from Vercel Blob via `POST /admin/seed-archive`. Frozen: nothing appends to it now, so for dates after the freeze the `embed-yesterday` and `fetch-day-ohlc` crons fall back to Postgres (`api/_lib/postgres-day-summary.ts`). See `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.
- **Takeit ML server** — `src/takeit_server.py` serves SHAP explanations (`/takeit/explain`, `/takeit/health`) for the `takeit-fill-shap` cron.
- **Archive reads** — `src/archive_query.py` runs DuckDB over the Parquet archive for the `/archive/*` routes (called via `api/_lib/archive-sidecar.ts`).

The sidecar writes nothing to Postgres. Consumer side of the data is in [api/\_lib/db.ts](../api/_lib/db.ts) and the cron handlers under `api/cron/`.

## Local development

```bash
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt  # runtime deps + pytest/ruff; the image installs requirements.txt only
cp .env.example .env
# Fill in DATABASE_URL at minimum.
python -m src.main
```

Health check: `curl http://localhost:8080/health` returns `{"status": "ok", "checks": {"db": true}}` (200) when the DB is reachable, `degraded` (503) otherwise. The boot-time DB check is non-fatal: during a Neon outage the SHAP and `/archive/*` routes stay up while `/health` reports 503.

### Tests

```bash
pytest tests/
# or
make test
```

The Makefile wraps the common workflows (`make lint`, `make test`, `make review`; CI runs `make review`).

## Environment variables

Sidecar is the canonical owner of these in **Railway**, not Vercel. `.env.example` lists the local-dev minimum; full Railway list:

| Variable                       | Required? | Purpose                                                          |
| ------------------------------ | --------- | ---------------------------------------------------------------- |
| `DATABASE_URL`                 | yes       | Neon connection, used only by the `/health` db check (psycopg2)  |
| `SENTRY_DSN`                   | yes       | Error tracking (tagged `server_name=sidecar`)                    |
| `TAKEIT_SERVER_ENABLED`        | yes       | `1` enables `/takeit/explain`                                    |
| `TAKEIT_SIDECAR_SHARED_SECRET` | yes       | Bearer secret for `/takeit/explain`                              |
| `ARCHIVE_MANIFEST_URL`         | yes       | Manifest of archive files in Blob                                |
| `ARCHIVE_SEED_TOKEN`           | yes       | Gates `POST /admin/seed-archive`                                 |
| `ARCHIVE_ROOT`                 | optional  | Volume path; defaults to `/data/archive`                         |
| `BLOB_READ_WRITE_TOKEN`        | yes       | Archive seeder reads from Vercel Blob                            |
| `RAILWAY_RUN_UID`              | yes       | `0` on Railway so the container can write to the volume          |
| `ARCHIVE_QUERY_CONCURRENCY`    | optional  | Concurrent `/archive/*` DuckDB queries; default 2                |
| `TAKEIT_MAX_BODY_BYTES`        | optional  | `/takeit/explain` body cap; default 1 MiB                        |
| `PORT`                         | optional  | Default 8080                                                     |
| `LOG_LEVEL`                    | optional  | Default INFO                                                     |

`DATABASE_URL` now exists only for the `/health` db check: since Theta was removed, no sidecar route reads or writes Neon. It is still required at boot; removing it is a separate decision.

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

```text
src/
  main.py             # Entry point: env check, HTTP server
  config.py           # Env vars + settings
  db.py               # psycopg2 pool, boot verification, /health probe
  front_month.py      # Front-month CTE SQL for archive queries
  takeit_server.py    # /takeit/explain + /takeit/health (SHAP)
  archive_seeder.py   # /admin/seed-archive
  archive_query.py    # Read-side of /data/archive
  health.py           # HTTP server + /health and route dispatch
  sentry_setup.py     # Sentry tagging
  logger_setup.py     # Pino-style structured logs
```

## Related specs

- `docs/superpowers/specs/sidecar-refactor-2026-05-02.md` — modular split
- `docs/superpowers/specs/archive-volume-seed-2026-04-18.md` — archive volume contract
- `docs/superpowers/specs/databento-removal-2026-09-29.md` — Databento removal, the UW futures substitution, and the F4 strip (Theta, multileg-classify fallback)
- `docs/superpowers/specs/multileg-classifier-service-split-2026-05-28.md` — why the classifier left the sidecar
- Historical: `theta-railway-sidecar-2026-04-18.md` (Theta design, removed), `max-leverage-databento-uw-2026-04-18.md` (data sourcing), `phase2a-sidecar-l1-ingest-2026-04-18.md` (L1 ingest, removed)

## Operational notes

- `psycopg2` is used here (not asyncpg or `@neondatabase/serverless`) because the workload is sync and long-lived.
- The `uw-stream` Railway service uses **asyncpg** instead — different access pattern (concurrent, fan-in from websocket).
