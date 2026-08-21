# Databento + Theta Sidecar

Python service deployed to **Railway** (not Vercel). Ingests futures and ES options market data from Databento and Theta Data Terminal into the Neon Postgres instance shared with the main app. Also hosts the multi-leg classifier and the Takeit ML scoring server.

## Why a separate service?

Databento streams are long-lived TCP connections; Theta Data Terminal is a Java daemon with persistent state. Neither fits Vercel's stateless function model. Railway lets us run a real process with a `/data` volume and a co-resident Java JRE.

## What it does

- **Databento ingestion** — OHLCV-1m for 6 futures symbols (ES, NQ, ZN, RTY, CL, GC) (DX would require the ICE IFUS.IMPACT dataset and is not implemented; VX deferred pending Databento availability).
- **ES options chain** — Front-month polled from Databento.
- **Theta Data Terminal** — Co-resident Java service (Eclipse Temurin 21) for additional options data not in Databento.
- **Archive volume** — Persistent `/data/archive` on Railway, SHA-resumable seed from Vercel Blob via `POST /admin/seed-archive`. See `docs/superpowers/specs/archive-volume-seed-2026-04-18.md`.
- **Multi-leg classifier** — `src/multileg_routes.py` exposes sidecar-side analysis used by detect crons.
- **Takeit ML server** — `src/takeit_server.py` serves XGBoost scoring for the Lottery Finder pipeline.

Consumer side of the data is in [api/\_lib/db.ts](../api/_lib/db.ts) and the cron handlers under `api/cron/`.

## Local development

```bash
cd sidecar
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Fill in DATABASE_URL, DATABENTO_API_KEY at minimum.
python -m src.main
```

Health check: `curl http://localhost:8080/health`.

### Tests

```bash
pytest tests/
# or
make test
```

### Lint / format

```bash
make lint     # ruff check --fix src/ tests/ && ruff format src/ tests/
make review   # lint + tests with coverage
```

Ruff and pytest are configured in `pyproject.toml` (line-length 100, py312,
the uw-stream/classifier rule families plus `PL`/`ARG`/`S`/`BLE`/`DTZ`/`D401`;
test-only relaxations live under `per-file-ignores`). `make lint` must exit 0
with zero findings; every remaining suppression is a `# noqa: <RULE> — reason`.
`_vendored_ml/` is excluded — it must stay byte-identical to `ml/src/`.

## Environment variables

Sidecar is the canonical owner of these in **Railway**, not Vercel. `.env.example` lists the local-dev minimum; full Railway list:

| Variable                | Required? | Purpose                                                       |
| ----------------------- | --------- | ------------------------------------------------------------- |
| `DATABASE_URL`          | yes       | Neon connection (uses psycopg2, not @neondatabase/serverless) |
| `DATABENTO_API_KEY`     | yes       | Futures + ES options live feed                                |
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
| `THETA_INDEX_CONCURRENCY` | optional | Cap on concurrent `/theta/index/*` calls into the Terminal (default 2, min 1). Theta Terminal v1.8.6 drops calls under bursts; excess callers queue for a slot. |
| `THETA_INDEX_WAIT_S`    | optional  | How long a caller waits for a slot before `503 {"error":"theta_busy"}` + `Retry-After: 1` (default 5.0, clamped 0.5–60). Vercel's client allows 8s per call. |
| `ARCHIVE_QUERY_CONCURRENCY` | optional | Cap on concurrent `/archive/*` DuckDB queries (sheds `503 archive busy` immediately when full). |
| `WATCHDOG_STALE_EXIT_S` | optional  | Stale-data watchdog: if connected + data expected + no bar for this many seconds, the process exits 1 so Railway restarts it (default 300, min 180). |
| `WATCHDOG_BOOT_GRACE_S` | optional  | Watchdog holds off this many seconds after boot (default 600). |

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
  main.py             # Entry point (stdlib http.server + Databento loop)
  config.py           # Env vars + settings
  db.py               # psycopg2 pool + helpers
  databento_client.py # Live + historical Databento
  theta_client.py     # Theta Data Terminal HTTP client
  theta_launcher.py   # Manages the co-resident Java jar
  theta_fetcher.py    # Nightly Theta EOD ingest (17:25 ET) + startup backfill
  symbol_manager.py   # Front-month rolling
  front_month.py      # Contract code resolution
  trade_processor.py  # Tick → DB
  quote_processor.py  # NBBO → DB
  batched_writer.py   # Bulk INSERT pipeline
  bar_writer.py       # Buffered futures OHLCV-1m writer
  stat_writer.py      # Buffered ES option stats writer
  options_router.py   # Databento options record routing (definitions/trades/stats)
  multileg_routes.py  # POST /takeit/multileg-classify handler
  takeit_server.py    # POST /takeit/explain, GET /takeit/health (SHAP scoring)
  archive_seeder.py   # POST /admin/seed-archive
  archive_query.py    # Read-side of /data/archive (/archive/* routes)
  session_calendar.py # CME trade-date bucketing
  health.py           # /health + HTTP route dispatch
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
