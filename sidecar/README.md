# Railway Sidecar (SHAP + Archive)

Python service deployed to **Railway** (not Vercel). Serves the Take-It SHAP explainer and read-only DuckDB queries over the frozen historical futures archive.

> **Databento ingestion removed (2026-09-29).** The sidecar used to stream futures OHLCV-1m bars, top-of-book, trade ticks, and ES options trades/statistics from Databento into Neon. The Databento subscription was cancelled, so that path (and the `databento` dependency and `DATABENTO_API_KEY`) is gone. Live futures data now comes from the `uw-stream` Railway service. The `/data/archive` Parquet archive (originally sourced from Databento) is frozen but still served read-only.
>
> **Theta Data Terminal and multileg-classify fallback removed (2026-10-02).** The co-resident Theta Data Terminal (Java jar, nightly SPX EOD fetch into `theta_option_eod`) never ran in production and is gone, along with its JRE and `THETA_*` env vars. `POST /takeit/multileg-classify` is gone too: the standalone `classifier/` Railway service is the only multileg classifier, and `api/_lib/multileg-client.ts` requires `CLASSIFIER_URL`.

## Why a separate service?

The DuckDB archive needs a persistent `/data` volume, and the SHAP explainer keeps heavy ML deps and loaded model bundles warm. Neither fits Vercel's stateless function model. Railway lets us run a real process with a `/data` volume.

## What it does

- **Archive volume**: persistent `/data/archive` on Railway, seeded from Vercel Blob by a one-shot, SHA-resumable `POST /admin/seed-archive`. Frozen: the last archived session is 2026-04-17 and nothing appends to it, so for later dates the `embed-yesterday` and `fetch-day-ohlc` crons fall back to Postgres (`api/_lib/postgres-day-summary.ts`). See `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.
- **Take-It SHAP server**: `src/takeit_server.py` serves `/takeit/explain` and `/takeit/health` for the `takeit-fill-shap` cron. On the first request per alert type it downloads that model bundle from private Vercel Blob (the `takeit/latest.json` manifest, then the versioned `.joblib`) and keeps it loaded.
- **Archive reads**: `src/archive_query.py` runs DuckDB over the Parquet archive for the read-only `/archive/*` routes, with a cap on concurrent queries.

The sidecar writes nothing to Postgres. Its callers are [`api/_lib/archive-sidecar.ts`](../api/_lib/archive-sidecar.ts) and [`api/cron/fetch-day-ohlc.ts`](../api/cron/fetch-day-ohlc.ts) (both via `SIDECAR_URL`), and [`api/cron/takeit-fill-shap.ts`](../api/cron/takeit-fill-shap.ts) (via `SIDECAR_TAKEIT_URL`).

## Local development

```bash
cd sidecar
python3.12 -m venv .venv            # Windows: py -3.12 -m venv .venv
source .venv/bin/activate           # Windows (Git Bash): source .venv/Scripts/activate
pip install -r requirements-dev.txt # runtime deps + pytest/ruff; the image installs requirements.txt only
cp .env.example .env                # fill in DATABASE_URL at minimum
set -a; source .env; set +a         # export it: main.py checks the process environment, not .env
python -m src.main
```

`config.py` reads `.env` for its own fields (`DATABASE_URL`, `PORT`, `LOG_LEVEL`), but the boot check for `DATABASE_URL` and every other variable below read the process environment, so the file has to be exported. Keep values that contain `&` in quotes before sourcing.

Health check: `curl http://localhost:8080/health` returns `{"status": "ok", "checks": {"db": true}}` (200) when the DB is reachable, `degraded` (503) otherwise. The boot-time DB check is non-fatal: during a Neon outage the SHAP and `/archive/*` routes stay up while `/health` reports 503.

### Tests

```bash
pytest tests/
# or
make test        # Windows: make test PYTHON=.venv/Scripts/python
```

The Makefile defaults to `PYTHON ?= .venv/Scripts/python` on Windows and `.venv/bin/python` elsewhere. `make lint` auto-fixes with ruff (`ruff check --fix` plus `ruff format`), and `make review` runs lint, then the tests with coverage. CI runs `make review PYTHON=python`, so format drift is fixed in CI rather than failing it (the uw-stream and classifier gates only check).

## Environment variables

Sidecar is the canonical owner of these in **Railway**, not Vercel. `.env.example` holds every variable below except the ignored `LOG_LEVEL` and the Railway-set ones, with empty or placeholder values. Only `DATABASE_URL` is required to boot; the rest switch features on.

| Variable                                       | Required?                          | Purpose                                                                                                             |
| ---------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                 | yes (boot exits without it)        | Neon connection, used only by the `/health` db check (psycopg2)                                                     |
| `SENTRY_DSN`                                   | optional                           | Error tracking; empty disables Sentry. Events carry `server_name=futures-sidecar`                                   |
| `TAKEIT_SERVER_ENABLED`                        | optional, default `0`              | `1` enables `POST /takeit/explain`; otherwise it returns 503                                                        |
| `TAKEIT_SIDECAR_SHARED_SECRET`                 | when Take-It is enabled            | Bearer secret for `/takeit/explain`; without it the route stays at 503. Must equal Vercel's `SIDECAR_TAKEIT_SECRET` |
| `BLOB_READ_WRITE_TOKEN`                        | when Take-It or seeding is enabled | Reads the Take-It model bundles and the archive files the seeder pulls                                              |
| `ARCHIVE_MANIFEST_URL`                         | to enable seeding                  | Manifest of archive files in Blob. Without it (or the Blob token), `POST /admin/seed-archive` returns 401           |
| `ARCHIVE_SEED_TOKEN`                           | to enable seeding                  | Must match the `X-Admin-Token` header on `POST /admin/seed-archive`                                                 |
| `ARCHIVE_BLOB_ALLOWED_HOSTS`                   | optional                           | Comma-separated extra hosts the seeder may download from (the manifest's own host is always allowed)                |
| `ARCHIVE_ROOT`                                 | optional                           | Volume path; default `/data/archive`                                                                                |
| `ARCHIVE_QUERY_CONCURRENCY`                    | optional                           | Concurrent `/archive/*` DuckDB queries; default 2 (503 when all slots are busy)                                     |
| `TAKEIT_MAX_BODY_BYTES`                        | optional                           | `/takeit/explain` body cap; default 1 MiB (413 above it)                                                            |
| `PORT`                                         | optional                           | Default 8080                                                                                                        |
| `LOG_LEVEL`                                    | ignored                            | Parsed by `config.py` but not applied; logs are always INFO                                                         |
| `RAILWAY_RUN_UID`                              | Railway setting                    | `0` on Railway so the container can write to the volume. Not read by sidecar code                                   |
| `RAILWAY_ENVIRONMENT`, `RAILWAY_DEPLOYMENT_ID` | set by Railway                     | Sentry `environment` and `release`                                                                                  |

`DATABASE_URL` now exists only for the `/health` db check: since Theta was removed, no sidecar route reads or writes Neon. It is still required at boot; removing it is a separate decision.

## Deployment

Railway auto-deploys on push to `main` for this service. `vercel.json`'s `ignoreCommand` skips Vercel deploys for changes confined to `sidecar/`, so Vercel and Railway are independent.

```bash
# View Railway logs
railway logs --service sidecar

# Redeploy the latest deployment (railway up would upload the local directory instead)
railway redeploy --service sidecar -y
```

`railway.toml` sets only `watchPatterns` (`sidecar/**`). The image's Docker `HEALTHCHECK` curls `/health`; no Railway `healthcheckPath` is set. The [Dockerfile](Dockerfile) is the source of truth for the build.

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

- `psycopg2` (a small threaded pool in `db.py`) backs only the `/health` DB probe.
- The `uw-stream` Railway service uses **asyncpg** instead — different access pattern (concurrent, fan-in from websocket).
