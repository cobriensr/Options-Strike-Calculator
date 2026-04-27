# TRACE Live Capture Daemon

Long-running TS service that captures gamma + charm + delta heatmaps from SpotGamma TRACE every 5 minutes during market hours, queries the GEX landscape from Neon at the same instant, and POSTs the batch to `/api/trace-live-analyze` for Sonnet-4.6 analysis. Captures persist to Postgres + Vercel Blob and surface in the **TRACE Live** dashboard component.

## Architecture (v1 — local execution)

```
                                                            POST
   ┌──────────────────┐    spawns    ┌────────────────────┐ ────► ┌────────────────┐
   │   daemon (tsx)   │ ───────────► │ capture-trace-     │       │   /api/trace-  │
   │   src/index.ts   │              │ live.ts (Playwright│       │   live-analyze │
   │   ─ scheduler    │              │  + local Chromium) │       │   (Vercel)     │
   │   ─ tick orches- │              │                    │       └────────────────┘
   │     trator      │              │  Reads .trace-     │              │
   └──────────────────┘              │  storage.json     │              ▼
            │                        │  for SpotGamma    │       Neon Postgres
            │                        │  auth             │       + Vercel Blob
            ├─ neon() ─────► gex_strike_0dte snapshot ───┘
            │
            ▼
        pino + Sentry
```

The daemon and capture script run on **the same machine** (your MacBook). Future migration to Railway is gated on porting auth + headless Chromium into a hosted runtime — for now, local-first because TRACE auth lives in the gitignored `scripts/charm-pressure-capture/.trace-storage.json` from the historical study.

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

```
# Where the daemon POSTs captures.
# Production:  https://theta-options.com/api/trace-live-analyze
# Local dev:   http://localhost:3000/api/trace-live-analyze
TRACE_LIVE_ANALYZE_ENDPOINT=https://theta-options.com/api/trace-live-analyze

# Owner cookie value — pull from your root .env.local OWNER_SECRET line.
OWNER_SECRET=

# Neon Postgres — daemon reads gex_strike_0dte directly. Same connection
# string as the root project's DATABASE_URL.
DATABASE_URL=

# ── Reserved for future Railway/browserless move (set to placeholders for v1) ──
BROWSERLESS_TOKEN=unused-in-v1
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

**Watch the browser** (debug — set `HEADLESS=0`):

```bash
cd daemon
HEADLESS=0 BYPASS_MARKET_HOURS_GATE=1 npx tsx --env-file=.env src/index.ts
```

## Verifying it works

1. **Start the daemon** with `BYPASS_MARKET_HOURS_GATE=1 CADENCE_SECONDS=15` to fire a tick every 15s outside market hours.
2. **Watch the logs**: you should see
   - `Capture script returned successfully` (with byte counts for each chart)
   - `POST /api/trace-live-analyze response` with `status: 200`
   - `Cycle complete` with the duration
3. **Check the dashboard**: open https://theta-options.com, expand the **TRACE Live** section. The new capture's headline + image should appear within 60s.
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

| Source | Cost / capture | Cycles / day | Daily cost |
|---|---|---|---|
| Anthropic (Sonnet 4.6, ~14.7K cached + adaptive thinking + structured output) | ~$0.04 | 76 | ~$3.00 |
| OpenAI (text-embedding-3-large @ 2000 dim) | ~$0.0001 | 76 | ~$0.01 |
| Vercel Blob (3 PNGs × ~250 KB each) | ~$0.000017 | 76 | ~$0.001 |
| Neon Postgres (one INSERT + jsonb + vector) | ~$0 | 76 | $0 |
| **Daily total** | | | **~$3** |
| **Monthly (20 trading days)** | | | **~$60** |

If you promote `PRIMARY_MODEL` to `claude-opus-4-7` later, multiply Anthropic by ~5× → ~$15/day, $300/month.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `FATAL: TRACE auth not found at .trace-storage.json` | Auth file missing or older than 7 days | Run `npx tsx scripts/charm-pressure-capture/save-storage.ts` |
| `could not select chart type "Gamma"` | TRACE DOM changed | Inspect with `HEADLESS=0`; update selectors in `scripts/capture-trace-live.ts` |
| `POST returned 429` | Rate limit on `/api/trace-live-analyze` (6/min) | Auto-retried after 30s; lower CADENCE_SECONDS only if intentional |
| `POST returned 401` | OWNER_SECRET stale | Refresh from root `.env.local` (which is `vercel env pull`-able) |
| `No gex_strike_0dte snapshot at-or-before capturedAt` | 1-min cron paused or behind | Daemon skips this cycle; check `/api/cron/fetch-gex` health |
| `capture timed out after 90000ms` | TRACE page slow / network blip | Auto-skipped; next cycle should recover |
| Wrong chart on the dashboard | Chart-type dropdown drifted | Check the saved screenshot from `HEADLESS=0` run; reset the dropdown's combobox selector |

## Future work (not v1)

- **Move to Railway** — port auth state to a Vercel Blob upload, daemon downloads on startup; switch from local Chromium to browserless.io connect URL.
- **Backfill mode** — `--date YYYY-MM-DD --backfill` flag iterates through 5-min slots in a historical day via TRACE's MUI time slider.
- **Heartbeat row** — write a `daemon_heartbeat (cycle_started_at, cycle_ended_at, status)` table so the dashboard can render a "daemon last seen N min ago" status pill.
- **Skill-files-in-bundle** for the future Railway move (Vercel function bundles them already; daemon will need its own copy or a download).
