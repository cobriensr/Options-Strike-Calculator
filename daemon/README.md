# TRACE Live Capture Daemon

Long-running TS service that captures gamma + charm + delta heatmaps from SpotGamma TRACE every 5 minutes during market hours, queries the GEX landscape from Neon at the same instant, and POSTs the batch to `/api/trace-live-analyze` for Sonnet-4.6 analysis. Captures persist to Postgres + Vercel Blob and surface in the **TRACE Live** dashboard component.

## Architecture

```text
                                                                       POST
   ┌──────────────────┐    spawns    ┌────────────────────┐    wss://     ┌─────────────────┐
   │   daemon (tsx)   │ ───────────► │ capture-trace-     │ ─────────────►│  browserless.io │
   │   src/index.ts   │              │ live.ts            │               │  (production-   │
   │   ─ scheduler    │              │                    │               │   sfo, $35/mo)  │
   │   ─ tick orches- │              │  Reads .trace-     │               └─────────────────┘
   │     trator      │              │  storage.json for  │
   └──────────────────┘              │  SpotGamma auth    │     POST       ┌────────────────┐
            │                        │  (passed via       │ ─────────────► │ /api/trace-    │
            │                        │  storageState)     │                │  live-analyze  │
            │                        └────────────────────┘                │  (Vercel)      │
            │                                                              └────────────────┘
            │                                                                     │
            ├─ neon() ─────► gex_strike_0dte snapshot ──────────────────────────► ▼
            │                                                              Neon Postgres
            ▼                                                              + Vercel Blob
        pino + Sentry
```

The daemon runs on **your MacBook** — TRACE auth lives in the gitignored `scripts/charm-pressure-capture/.trace-storage.json` from the historical study, and the cookies are passed to the remote browserless context via `newContext({ storageState })`. The daemon shells out to `scripts/capture-trace-live.ts`, which connects to browserless's production-sfo cluster via the WebSocket native-Playwright protocol.

## Prerequisites

1. **TRACE auth** — refresh the storage file at least once a week:

   ```bash
   npx tsx scripts/charm-pressure-capture/save-storage.ts
   ```

   This opens a browser, prompts you to log in to SpotGamma manually, and saves cookies to `scripts/charm-pressure-capture/.trace-storage.json` (gitignored). The daemon and capture script both read from this file.

2. **Daemon deps**:

   ```bash
   cd daemon && npm install
   ```

3. **Env file** — create `daemon/.env` from the template below.

## Env template

Copy this into `daemon/.env` and fill in:

```bash
# Browserless API token — your Prototyping-tier ($35/mo) token from
# the dashboard. Used for the WebSocket connection that runs the headless
# Chromium remotely.
BROWSERLESS_TOKEN=

# Where the daemon POSTs captures.
# Production:  https://theta-options.com/api/trace-live-analyze
# Local dev:   http://localhost:3000/api/trace-live-analyze
TRACE_LIVE_ANALYZE_ENDPOINT=https://theta-options.com/api/trace-live-analyze

# Owner cookie value — pull from your root .env.local OWNER_SECRET line.
OWNER_SECRET=

# Neon Postgres — daemon reads gex_strike_0dte directly. Same connection
# string as the root project's DATABASE_URL.
DATABASE_URL=

# ── Reserved for future first-run auto-login (not used in v1; auth comes
#    from the existing storageState file).
TRACE_EMAIL=unused-in-v1
TRACE_PASSWORD=unused-in-v1

# ── Optional ──
SENTRY_DSN=
LOG_LEVEL=info
CADENCE_SECONDS=300
BYPASS_MARKET_HOURS_GATE=
```

## Running

**During market hours** (8:35 AM – 2:55 PM CT, weekdays):

```bash
cd daemon
npx tsx --env-file=.env src/index.ts
```

**Outside market hours** (testing / dry-run a single cycle):

```bash
cd daemon
BYPASS_MARKET_HOURS_GATE=1 CADENCE_SECONDS=10 npx tsx --env-file=.env src/index.ts
```

**Watch the browser** is not possible with browserless (the headless Chromium runs remotely). To debug DOM issues, run the local capture script instead:

```bash
HEADLESS=0 npx tsx scripts/capture-trace.ts
```

(That uses local Chromium; selectors are the same as `capture-trace-live.ts`, so what works there will work here.)

## Backfill mode

One-shot: capture every 5-min slot for a single ET trading day and post each batch with the historical `capturedAt`. Runs ~35 min per day; costs ~$3 per day in Anthropic + OpenAI calls.

```bash
cd daemon
npx tsx --env-file=.env src/backfill.ts --date 2026-04-22
```

The backfill rate-limits to 6/min (10s gap between cycle starts) to respect the API's rate-limit guard. To backfill the last 10 trading days:

```bash
cd daemon
for d in 2026-04-14 2026-04-15 2026-04-16 2026-04-17 2026-04-18 \
         2026-04-21 2026-04-22 2026-04-23 2026-04-24 2026-04-25; do
  npx tsx --env-file=.env src/backfill.ts --date "$d"
done
```

Slots that can't find a `gex_strike_0dte` snapshot for that date+time are skipped (logged but not failed); slots whose POST returns 4xx fail the slot but don't abort the run. End-of-run summary shows `succeeded / skipped / failed`.

## Verifying it works

1. **Start the daemon** with `BYPASS_MARKET_HOURS_GATE=1 CADENCE_SECONDS=15` to fire a tick every 15s outside market hours.
2. **Watch the logs**: you should see
   - `Capture script returned successfully` (with byte counts for each chart)
   - `POST /api/trace-live-analyze response` with `status: 200`
   - `Cycle complete` with the duration
3. **Check the dashboard**: open <https://theta-options.com>, expand the **TRACE Live** section. The new capture's headline + image should appear within 60s.
4. **Check the DB**:

   ```sql
   SELECT id, captured_at, regime, headline
   FROM trace_live_analyses
   ORDER BY captured_at DESC LIMIT 5;
   ```

## Logs

- Local dev: pino-pretty colored output to stdout.
- Future Railway: structured JSON to stdout, picked up by the platform's log viewer.
- Sentry: errors only (`Sentry.captureException`). No tracing — daemon is a single long-running process.

## Cost estimate

| Source                                                                        | Cost / capture | Cycles / day | Daily cost |
| ----------------------------------------------------------------------------- | -------------- | ------------ | ---------- |
| Anthropic (Sonnet 4.6, ~14.7K cached + adaptive thinking + structured output) | ~$0.04         | 76           | ~$3.00     |
| OpenAI (text-embedding-3-large @ 2000 dim)                                    | ~$0.0001       | 76           | ~$0.01     |
| Vercel Blob (3 PNGs × ~250 KB each)                                           | ~$0.000017     | 76           | ~$0.001    |
| Neon Postgres (one INSERT + jsonb + vector)                                   | ~$0            | 76           | $0         |
| **Daily total**                                                               |                |              | **~$3**    |
| **Monthly (20 trading days)**                                                 |                |              | **~$60**   |

If you promote `PRIMARY_MODEL` to `claude-opus-4-7` later, multiply Anthropic by ~5× → ~$15/day, $300/month.

## Troubleshooting

| Symptom                                               | Likely cause                                    | Fix                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `FATAL: BROWSERLESS_TOKEN env var required`           | Missing token in `daemon/.env`                  | Copy from your browserless.io dashboard                                                                          |
| `FATAL: TRACE auth not found at .trace-storage.json`  | Auth file missing or older than 7 days          | Run `npx tsx scripts/charm-pressure-capture/save-storage.ts`                                                     |
| Browserless WebSocket connect timeout                 | Token invalid / quota exhausted / region down   | Check the browserless dashboard for active sessions + remaining units; rotate the token if it shows 401          |
| `Concurrent session limit reached`                    | 5+ sessions open simultaneously                 | Daemon uses 3 contexts per cycle; the 5-cap should be enough but a stuck previous cycle could hit it. Restart it |
| `could not select chart type "Gamma"`                 | TRACE DOM changed                               | Run `HEADLESS=0 npx tsx scripts/capture-trace.ts` against local Chromium to inspect; update selectors            |
| `POST returned 429`                                   | Rate limit on `/api/trace-live-analyze` (6/min) | Auto-retried after 30s; lower CADENCE_SECONDS only if intentional                                                |
| `POST returned 401`                                   | OWNER_SECRET stale                              | Refresh from root `.env.local` (which is `vercel env pull`-able)                                                 |
| `No gex_strike_0dte snapshot at-or-before capturedAt` | 1-min cron paused or behind                     | Daemon skips this cycle; check `/api/cron/fetch-gex` health                                                      |
| `capture timed out after 90000ms`                     | TRACE page slow / browserless region blip       | Auto-skipped; next cycle should recover                                                                          |
| Wrong chart on the dashboard                          | Chart-type dropdown drifted                     | Run `HEADLESS=0 npx tsx scripts/capture-trace.ts` to inspect the dropdown's actual DOM                           |

## Future work (not v1)

- **Move to Railway** — daemon process itself moves to a hosted runtime so it survives sleep/laptop close. Auth state would need to be uploaded to Vercel Blob and downloaded on startup since `.trace-storage.json` is gitignored. Browserless connection works the same regardless of where the daemon runs.
- **Auto-refresh `.trace-storage.json`** — script that detects expired cookies and re-runs `save-storage.ts` interactively. Currently you have to refresh it manually each week.
- **Heartbeat row** — write a `daemon_heartbeat (cycle_started_at, cycle_ended_at, status)` table so the dashboard can render a "daemon last seen N min ago" status pill.
- **First-run interactive auth** — when `.trace-storage.json` is missing, fall back to opening a Playwright window via `TRACE_EMAIL` + `TRACE_PASSWORD` env vars (currently placeholders). Eliminates the manual `save-storage.ts` step.
