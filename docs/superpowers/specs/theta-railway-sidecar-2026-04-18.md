# Theta Data Nightly EOD on Railway Sidecar

## Goal
Co-host Theta Terminal (free tier) on the existing Python sidecar and write SPXW/VIX/VIXW/NDXP option EOD chains to a new `theta_option_eod` Postgres table nightly.

## Why
Theta free tier yields ~14 years of SPX option EOD chains (OHLC + NBBO + volume) that complement Databento (futures) and UW (flow/OI). Nightly ingest enables historical 0DTE backtests without paying for any tier.

## Non-goals
- No intraday Theta (that's Value tier, future work)
- No Vercel cron involvement (Theta Terminal is localhost-only to its container)
- No replacement of Databento or UW ingest — additive only

## Architecture
- **Sidecar container** gains a `openjdk-21-jre-headless` layer and ships `ThetaTerminalv3.jar`
- **Python startup** writes `creds.txt` from env vars, launches the jar as a background subprocess, waits for `:25503` to open
- **APScheduler** (new dep) runs a single job nightly at `17:25 America/New_York`
- **Fetcher** pulls `/v2/hist/option/eod` per (root, expiration) pair via the local Theta HTTP server, upserts to Postgres
- **Health endpoint** reports Theta subprocess liveness + last-fetch freshness
- **Sentry** catches every jar/fetcher failure mode via the existing `sentry_setup.capture_*` helpers

## Error surfaces & Sentry instrumentation

All events tagged `component:theta` via `sentry_sdk.new_scope().set_tag()`. Uses existing `sidecar/src/sentry_setup.py` helpers — no new Sentry init code.

| Surface | Detection | Severity | Payload context |
|---|---|---|---|
| Subprocess fails to start | `Popen(...)` raises | error (exception) | `{phase: "launch", java_version, jar_path}` |
| Subprocess exits unexpectedly | monitor thread sees `proc.poll() is not None` after boot | error (message) | `{exit_code, uptime_s, stderr_tail (last 50 lines)}` — then auto-restart with backoff |
| HTTP readiness timeout | poll `:25503` for 60s, no response | error (message) | `{stderr_tail, stdout_tail, elapsed_s}` |
| Java stack trace on stderr | regex match `java\..*Exception\|FATAL` in stderr stream | error (message) | `{line, surrounding_lines}` — rate-limited to 1 event per minute per signature |
| Theta auth rejected | HTTP 401/403 on any fetch | error (message) | `{endpoint, response_body}` |
| Nightly job uncaught exception | try/except wrapper around `fetcher.run()` | error (exception) | `{phase: "nightly_fetch", current_root, current_expiration, rows_so_far}` |
| Schema drift (KeyError/TypeError on response) | caught by above wrapper | error (exception) | includes raw response sample |
| Nightly job slow | elapsed > 30min | warning (message) | `{elapsed_s, rows_written, roots_completed}` |
| Nightly job never ran | Sentry cron check-in missed | error (automated) | see below |

### Explicitly NOT sent to Sentry (would cause fatigue):
- `"No data for the specified timeframe & contract"` responses — expected, logged at INFO only
- Successful fetches with 0 rows for a given (root, expiration) — expected
- Normal auto-update log lines at jar startup
- Any stderr line not matching the error regex

### Cron check-in monitoring
Sentry's cron monitor catches the "scheduler never fired" case (container crash before 17:25 ET, Railway outage, etc.) that exception tracking misses. Wire via `sentry_sdk.monitor(...)` decorator on the nightly job:
```python
@sentry_sdk.monitor(monitor_slug="theta-nightly-eod")
def run_nightly():
    fetcher.run()
```
One-time setup: create the monitor in Sentry UI with schedule `25 22 * * *` (UTC — 17:25 ET standard / 18:25 ET DST; use fixed UTC to avoid DST drift), checkin_margin 10min, max_runtime 30min.

## Phases (each independently shippable, ≤5 files)

### Phase 1 — Migration + test (2 files)
Creates the table. Nothing else in the stack touches it yet.
- `api/_lib/db-migrations.ts` — add migration `#70: Create theta_option_eod table`
- `api/__tests__/db.test.ts` — add `{ id: 70 }` mock row, append expected description, bump SQL call count

**Table shape** (mirrors `futures_options_daily` conventions):
```sql
CREATE TABLE theta_option_eod (
  symbol       TEXT NOT NULL,                  -- SPXW, VIX, VIXW, NDXP
  expiration   DATE NOT NULL,
  strike       NUMERIC(10,2) NOT NULL,         -- dollars (converted from thousandths in ingest)
  option_type  CHAR(1) NOT NULL CHECK (option_type IN ('C', 'P')),
  date         DATE NOT NULL,                  -- trading day
  open         NUMERIC(10,2),
  high         NUMERIC(10,2),
  low          NUMERIC(10,2),
  close        NUMERIC(10,2),
  volume       BIGINT,
  trade_count  INTEGER,
  bid          NUMERIC(10,2),
  ask          NUMERIC(10,2),
  bid_size     INTEGER,
  ask_size     INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, expiration, strike, option_type, date)
);
CREATE INDEX ix_theta_option_eod_symbol_date ON theta_option_eod (symbol, date DESC);
CREATE INDEX ix_theta_option_eod_expiration ON theta_option_eod (expiration);
```
Note: `option_type` not `right` — `right` is a SQL reserved word (RIGHT JOIN) and `futures_options_daily` uses `option_type`. Ingest converts Theta's `right=C` / `right=P` strings to `'C'` / `'P'` directly.

**Verify Phase 1:** `npm run review` passes. Migration runs locally (`POST /api/journal/init` against a dev DB).

---

### Phase 2 — Dockerfile + Theta Terminal launch (3 files)
Adds Java + jar + startup subprocess. No ingest yet — just proves Theta serves on `:25503` inside the container.
- `sidecar/Dockerfile` — add openjdk-21-jre-headless layer, COPY the jar
- `sidecar/ThetaTerminalv3.jar` — commit the jar (check size — 11MB, git-ok)
- `sidecar/src/theta_launcher.py` — new module: write creds.txt from env, `subprocess.Popen`, poll `:25503` until ready, surface status via a module-level flag
- `sidecar/src/main.py` — call `theta_launcher.start()` on startup, before existing Databento init

**Verify Phase 2:** `docker build` succeeds locally. Container boots, `curl http://localhost:25503/v2/list/roots/index` inside container returns data. Railway deploy green.

---

### Phase 3 — Scheduler + fetcher + DB writes (4 files)
The actual ingest logic.
- `sidecar/requirements.txt` — add `apscheduler`
- `sidecar/src/config.py` — add `THETA_EMAIL`, `THETA_PASSWORD`, `THETA_ROOTS` (default `["SPXW","VIX","VIXW","NDXP"]`), `THETA_BACKFILL_DAYS` (default 90)
- `sidecar/src/theta_client.py` — new module: thin HTTP client for `/v2/list/expirations`, `/v2/list/strikes`, `/v2/hist/option/eod`. Handles retries + "No data" responses.
- `sidecar/src/theta_fetcher.py` — new module: orchestrates the nightly job (for each root → for each expiration in next 90d → pull chain → upsert). Idempotent via `ON CONFLICT (symbol, expiration, strike, right, date) DO UPDATE`.
- `sidecar/src/main.py` — wire APScheduler, schedule `theta_fetcher.run()` at `17:25 America/New_York` daily, and trigger one-time backfill on startup if `theta_option_eod` empty for a root

**Verify Phase 3:** Container boots → backfill pulls ≥100 rows for SPXW → scheduler lists the next fire time in logs → manual trigger writes rows to Neon (verify via `SELECT COUNT(*) FROM theta_option_eod GROUP BY symbol`).

---

### Phase 4 — Health + secrets + docs (3 files)
Production readiness.
- `sidecar/src/health.py` — add `theta_running` + `theta_last_fetch_at` + `theta_last_error` to `/health`
- `sidecar/README.md` (or CLAUDE.md under sidecar patterns) — document `THETA_EMAIL`/`THETA_PASSWORD` as Railway env vars
- `vercel.json` `ignoreCommand` — confirm still ignores `sidecar/` changes (no change needed if already correct)

**Verify Phase 4:** Railway env vars set → redeploy → `curl $RAILWAY_URL/health` shows `theta_running: true`. After 24h, `theta_last_fetch_at` is within last day.

---

## Open questions (with defaults)
- **Roots to pull:** `SPXW, VIX, VIXW, NDXP`. Can add `SPX, NDX, RUT, RUTW` later if free tier covers them (likely yes).
- **Backfill window:** 90 days. More == longer first boot; less == can be extended later (script is idempotent).
- **Expiration horizon per nightly run:** Pull all expirations with `exp_date ∈ [today - 7d, today + 180d]`. Covers recently-expired (for late settlements) and all active chains.
- **Schedule time:** 17:25 ET (Theta generates EOD at 17:15 — 10min buffer for any lag).
- **Retry policy:** 3 retries with exponential backoff on HTTP 5xx; log + skip on "No data for contract"; abort whole job on 4xx auth errors.

## Thresholds / constants
- Theta HTTP base: `http://127.0.0.1:25503`
- Startup readiness probe: `GET /v2/list/roots/index` until HTTP 200 or 60s timeout
- Nightly job max duration: 30min (log warning if longer)
- Per-request timeout: 15s

## Data dependencies
- New Railway env vars: `THETA_EMAIL`, `THETA_PASSWORD`
- No new Vercel env vars
- No change to Neon schema for existing tables
- Existing `DATABASE_URL`, `SENTRY_DSN` reused

## Risks / footguns
- **Credentials on Railway** — plaintext creds.txt written to container at boot. Risk mirrors existing `DATABENTO_API_KEY`. No worse than status quo.
- **First backfill is heavy** — SPXW has ~250 active expirations × 200+ strikes × 2 rights × 90 days. Estimated 100k–500k rows. Neon handles this fine, but expect a 10–30min first run. Subsequent nightly runs write only the new day (~1k–10k rows).
- **Theta Terminal auto-update** — the jar self-updates on startup. If a future update changes the HTTP API shape, the fetcher breaks silently. Mitigation: fetcher logs raw response schema on every startup.
- **Free-tier rate limits** — undocumented. Start conservative: sequential requests, no concurrency. If ingest exceeds 30min consistently, revisit.

## Done when
- [ ] Phase 1 merged, migration runs clean on dev Neon
- [ ] Phase 2 merged, Railway container starts Theta subprocess and `:25503` responds
- [ ] Phase 3 merged, `SELECT COUNT(*) FROM theta_option_eod WHERE symbol = 'SPXW'` returns >10,000 after 24h
- [ ] Phase 4 merged, health endpoint reports Theta status, README documents env vars
