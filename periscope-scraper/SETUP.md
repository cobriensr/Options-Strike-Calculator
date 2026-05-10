# Self-hosting `periscope-scraper`

This doc walks you through running your own copy of `periscope-scraper`
against your own Neon Postgres database. The existing
[README.md](README.md) is written from the perspective of the original
operator (who already has the parent strike-calculator app deployed on
Vercel and runs the migration pipeline from there). This doc removes
that assumption — it's everything you need to stand up the scraper
independently.

> **Heads up — this is a single-owner tool.** It scrapes a logged-in UW
> Periscope session through your own browser cookie. Sharing one auth
> state across multiple operators will get the cookie invalidated. If
> two people want data, run two services with two separate UW accounts.

---

## 1. What the scraper does

Every 10 minutes during the regular trading session, the service:

1. Opens the UW Periscope **Market Maker Exposures Table** in headless
   Chromium using a saved login cookie (Playwright `storageState`).
2. Filters to today's 0DTE expiry (Single-Expiry mode, with a
   walk-the-date fallback).
3. Cycles the Greek dropdown through Gamma → Charm → Vanna, capturing
   the rendered HTML after each switch.
4. Parses ~150 per-strike values out of each capture.
5. Inserts ~450 rows per tick into `periscope_snapshots` in Neon
   Postgres, idempotent on `(captured_at, expiry, panel, strike)`.

It also supports a **historical backfill** mode that walks the date
picker + timeframe widget to scrape any past trading day.

Source files worth skimming before you start:

- [src/index.ts](src/index.ts) — entry point, scheduler, backfill flags.
- [src/scrape.ts](src/scrape.ts) — Playwright orchestration and selectors.
- [src/parser.ts](src/parser.ts) — pure HTML → row parser.
- [src/db.ts](src/db.ts) — batched inserts to Neon.
- [src/config.ts](src/config.ts) — env validation and the RTH gate.
- [Dockerfile](Dockerfile) — Railway build.

---

## 2. Prerequisites

You'll need accounts / tools for each of the following:

| Thing                          | Why                                                     | Notes                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unusual Whales account**     | Required to load the Periscope page at all.             | The Periscope tab is paid-tier only. As of writing, you need at least the **Advanced** plan (the same tier required for the websocket API). Verify on UW's pricing page; the scraper has no workaround if your plan can't see the page. |
| **Neon Postgres**              | Destination database.                                   | Free tier is plenty for this workload. ~450 rows × 10 min ≈ 195 K rows/day; far below the free-tier row + storage caps. Get a `postgres://…` connection string from the Neon console.                                                   |
| **Node 24+**                   | To run the auth-capture probe and the dev loop locally. | The Dockerfile pins `node:24-slim`.                                                                                                                                                                                                     |
| **Railway account (optional)** | Long-running host.                                      | The service is a single always-on process; Railway is the original deploy target but anything that runs a Docker container 24/7 with a persistent disk works (Fly.io, a VPS, your own server).                                          |
| **Sentry account (optional)**  | Error tracking.                                         | Strongly recommended — UW's UI changes break the scraper without warning. Logs alone make it easy to miss for hours.                                                                                                                    |

---

## 3. Provision the database

The scraper writes to one table: `periscope_snapshots` (plus a
`schema_migrations` row to track the migration). The original repo
applies these via the parent app's `POST /api/journal/init` endpoint.
You don't have that endpoint, so apply the SQL directly to your Neon
DB.

Connect with `psql` (or any Postgres client) and run:

```sql
-- Migration 140 — base table.
CREATE TABLE IF NOT EXISTS periscope_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL,
  expiry      DATE NOT NULL,
  panel       TEXT NOT NULL CHECK (panel IN ('gamma', 'charm', 'vanna', 'positions')),
  strike      INT NOT NULL,
  value       NUMERIC(14,2) NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (captured_at, expiry, panel, strike)
);

CREATE INDEX IF NOT EXISTS idx_periscope_snapshots_lookup
  ON periscope_snapshots (expiry, panel, captured_at, strike);

-- Migration 141 — adds the per-row UW slot label, e.g. "09:10 - 09:20".
ALTER TABLE periscope_snapshots
  ADD COLUMN IF NOT EXISTS timeframe TEXT;
```

These are exactly migrations 140 + 141 from
[api/\_lib/db-migrations.ts](../api/_lib/db-migrations.ts). The
descriptions there explain _why_ each column exists if you want
context.

You don't need any of the other ~70 migrations from that file — none of
them are touched by the scraper.

> **Connection string note.** Use the **pooled** connection string
> (`-pooler` host) since the inserts run from a long-lived process. The
> direct (non-pooler) string also works but has tighter connection
> caps.

---

## 4. Capture your auth state

The scraper authenticates to UW by replaying a Playwright `storageState`
JSON — the bundle of cookies + localStorage that a logged-in browser
session has. There's no API token; this is a browser-cookie scrape.

You capture this once, locally, in a headed browser:

```bash
git clone <your fork of this repo>
cd <repo>
npm install                              # installs root + workspace deps
npx playwright install chromium          # downloads the browser

PERISCOPE_URL='https://unusualwhales.com/periscope/market-exposures-table' \
  node scripts/periscope-probe.mjs --login
```

[scripts/periscope-probe.mjs](../scripts/periscope-probe.mjs) is a
helper that opens a headed Chromium with anti-detection flags so Google
OAuth (UW's only sign-in option for many accounts) actually accepts the
browser. A naive Playwright window is rejected as automated.

Steps inside the headed window:

1. Log in to UW (Google OAuth or whatever your account uses).
2. Once logged in, the script auto-navigates to Periscope.
3. **Set up the saved view manually before closing the window:**
   - Pick today's 0DTE expiry (the scraper will override this on every
     tick, but having a sane default helps the first load).
   - Set the **Timeframe** to `Latest`.
   - The Greek dropdown choice doesn't matter — the scraper cycles it.
4. Press **Enter** in the terminal where the probe is running. It
   serializes the session to `~/.periscope-probe-auth.json` and exits.

That JSON is your runtime auth. **Treat it like a password** — it's a
session token that lets anyone open Periscope as you.

> **Re-auth cadence.** UW invalidates these cookies every few weeks, or
> sooner if it detects automation. When the Railway logs show 401s or
> redirects on every tick, repeat this section and re-upload the new
> file (Section 6). There's no in-flight refresh — the simple
> cookie-paste model is intentional.

---

## 5. Verify it works locally

Before paying for a Railway dyno, prove the auth + parser + database
wiring with a one-shot run on your laptop.

```bash
cd periscope-scraper
npm install

export DATABASE_URL='postgres://user:pass@…neon.tech/neondb?sslmode=require'
export UW_AUTH_STATE_PATH="$HOME/.periscope-probe-auth.json"
export SENTRY_DSN=''                 # leave empty to skip Sentry locally
export FORCE_TICK=true               # bypass the RTH gate, run once, exit
export HEADLESS=false                # optional: watch the browser drive itself

npm run dev
```

Expected output: pino logs showing the page loading, dropdown clicks,
three `parsed Greek` lines (one each for gamma / charm / vanna with
~150 rows), and a `tick complete` line with the inserted count.

Then verify the rows landed:

```sql
SELECT panel, COUNT(*), MIN(strike), MAX(strike), MAX(captured_at)
FROM periscope_snapshots
GROUP BY panel
ORDER BY panel;
```

You should see three rows (one per panel), each with ~150 strikes and a
`captured_at` matching the run.

**If this fails on a weekend,** that's expected — UW shows "No data
available" for the live `Latest` slot when the market's closed. Either
test on a trading day, or use backfill mode (Section 8) against a
recent past trading day to verify the wiring.

---

## 6. Deploy to Railway

The pattern is "always-on container with a base64-encoded auth state in
an env var."

### 6a. Create the service

1. New Railway project (or service inside an existing project).
2. Connect it to your GitHub fork.
3. **Set the root path to `periscope-scraper/`** in service settings —
   the [Dockerfile](Dockerfile) is path-prefixed for the repo-root build
   context.
4. Railway auto-detects the Dockerfile via
   [railway.toml](railway.toml).

The `railway.toml` `watchPatterns` are intentionally narrow so a docs /
README commit doesn't bounce a long-running tick. If you fork and rename
paths, update that file.

### 6b. Pack the auth state into an env var

Railway env vars are strings — to ship a JSON file you base64-encode it
locally and decode at container start. The decoder is already wired up
in [src/index.ts](src/index.ts) lines 38–55; you just need to provide
the encoded string.

```bash
# macOS / Linux
base64 -i ~/.periscope-probe-auth.json | tr -d '\n' | pbcopy
```

Paste the result into Railway as `UW_AUTH_STATE_B64`. (The
container writes it to `/data/uw-auth-state.json` on every start.)

### 6c. Set the rest of the env vars

| Variable             | Required | Value                                                                                                  |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | yes      | Your Neon pooled connection string.                                                                    |
| `UW_AUTH_STATE_B64`  | yes      | Base64 of `~/.periscope-probe-auth.json`.                                                              |
| `SENTRY_DSN`         | no       | Leave unset to log to stdout only.                                                                     |
| `UW_PERISCOPE_URL`   | no       | Defaults to the table view URL; override only if UW renames the route.                                 |
| `UW_AUTH_STATE_PATH` | no       | Defaults to `/data/uw-auth-state.json`. Only override if your container has a different writable path. |
| `LOG_LEVEL`          | no       | `info` (default), `debug`, `warn`, `error`.                                                            |

### 6d. Disable scale-to-zero

The service is intentionally idle for ~9 minutes between ticks. Railway's
scale-to-zero will kill it during those gaps. Make sure that toggle is
off.

### 6e. Persistent volume (only if `UW_AUTH_STATE_PATH` writes outside `/tmp`)

The default `/data/uw-auth-state.json` path requires Railway to mount a
volume at `/data`. If you'd rather skip the volume, point
`UW_AUTH_STATE_PATH` at `/tmp/uw-auth-state.json` — the file is rewritten
from `UW_AUTH_STATE_B64` on every container start anyway, so ephemeral
storage is fine.

### 6f. First boot

Watch the deploy logs. You should see, in order:

```
auth-state seed: wrote N bytes to /data/uw-auth-state.json
periscope-scraper starting
… (one immediate tick fires)
parsed Greek (gamma, ~150 rows, …)
parsed Greek (charm, …)
parsed Greek (vanna, …)
tick complete (rows: 450, inserted: 450, ms: …)
```

If the boot tick happens outside RTH, you'll instead see a
`debug`-level "outside RTH, skipping tick" log and the next tick will be
scheduled for 10 minutes later. Set `LOG_LEVEL=debug` if that line is
hidden.

---

## 7. Operating notes

### Cadence and RTH gate

The scheduler fires every 10 minutes (`MS_PER_TICK` in
[src/config.ts](src/config.ts)) but each tick no-ops outside the
regular trading session window of 13:00–20:59 UTC, Mon–Fri (defined by
`isMarketHours()` in the same file). That window is intentionally
1 hour wider than NYSE's 13:30–21:00 RTH to absorb late ticks and clock
skew.

### Tick concurrency

A single in-flight flag (`tickInFlight` in [src/index.ts](src/index.ts))
prevents overlapping runs. If a scrape stalls past the 10-minute
boundary, the next tick logs `previous tick still running, skipping`
and waits another 10 minutes. There's no retry-on-stall; UW's anti-bot
prefers patient clients to retrying ones.

### Restart behavior

On boot, the service runs one tick **immediately** (regardless of where
in the 10-min cycle you are) before starting the interval. So a
Railway restart mid-session resumes within seconds, not within
10 minutes.

`SIGTERM` and `SIGINT` are handled — the scheduler clears its interval,
flushes Sentry, and exits 0. Railway's shutdown grace period of 30s is
plenty.

### Re-authentication

When UW's session expires, every tick fails with a 401 / login
redirect. Workflow:

1. Re-run `node scripts/periscope-probe.mjs --login` locally.
2. Re-base64 and update `UW_AUTH_STATE_B64` in Railway.
3. Railway redeploys automatically on env-var change. The new auth
   state is written to `/data/uw-auth-state.json` and the next tick
   uses it.

You don't need to delete the old auth file — the boot decoder
overwrites it.

### Schema reference

```sql
periscope_snapshots
├── id          BIGSERIAL PRIMARY KEY
├── captured_at TIMESTAMPTZ            -- ISO timestamp of the scrape
├── expiry      DATE                   -- 0DTE expiry the row applies to
├── panel       TEXT  -- 'gamma' | 'charm' | 'vanna' | 'positions'
├── strike      INT                    -- e.g. 5800
├── value       NUMERIC(14,2)          -- MM-attributed exposure value
├── inserted_at TIMESTAMPTZ DEFAULT NOW()
├── timeframe   TEXT                   -- "09:10 - 09:20" UW slot label
└── UNIQUE (captured_at, expiry, panel, strike)
```

`panel = 'positions'` is reserved but not currently emitted — the table
view doesn't expose Positions; only the chart histogram does. The
scraper never writes that value, so consumers can ignore it.

`value` is the MM-attributed dealer-flow figure UW renders in the
table. Sign convention: positive = MM net long that Greek at that
strike; negative = MM net short. See UW's docs for the full
interpretation.

### Anti-detection

`scrape.ts` uses `playwright-extra` + `puppeteer-extra-plugin-stealth`
to patch the most common Chromium-automation tells (navigator.webdriver,
WebGL fingerprint, chrome.runtime, etc.). Without these, UW's anti-bot
returns a stripped-down DOM ("All" placeholder rows instead of the real
table) on headless captures, which silently produces zero-row inserts.

If UW tightens detection further and the scraper starts returning
empty captures even with stealth on:

1. Re-run the headed probe and confirm the page works in a real browser.
2. Compare the headed DOM against what `await page.content()` returns
   in headless mode — there's an example at
   [scripts/periscope-controls-probe.mjs](../scripts/periscope-controls-probe.mjs).
3. Add or update stealth flags in [src/scrape.ts](src/scrape.ts) lines
   822–851.

---

## 8. Backfill mode

The same image runs in two one-shot backfill modes by setting env vars.
Useful for seeding history before the live cron has run for long enough,
or for filling a gap after a deploy outage.

### Single day

```bash
BACKFILL_DATE=2026-05-07
BACKFILL_START=08:20         # optional, defaults to 08:20
BACKFILL_END=14:50           # optional, defaults to 14:50
```

The container walks the date picker to `BACKFILL_DATE`, pins
Single-Expiry to that day's 0DTE row, then iterates 10-min slots from
start to end, capturing each. `captured_at` is stamped from the slot's
**end** time so the row stamping matches what the live cron would
produce. Exits 0 on completion.

### Multi-day range

```bash
BACKFILL_DATE_START=2026-04-01
BACKFILL_DATE_END=2026-05-07
BACKFILL_START=08:20         # applies to every day in the range
BACKFILL_END=14:50
```

Walks the trading-day calendar (Mon–Fri minus the US holiday list in
[src/scrape.ts](src/scrape.ts) lines 54–77) and runs the single-day
flow per date. Inserts are flushed per-day so a kill mid-loop preserves
prior days. A failed day is logged and the next day is attempted —
`daysFailed` is reported in the final summary.

### How to run it on Railway

Set the backfill env vars on the service, redeploy. The container
runs the backfill, exits 0, and Railway's restart policy spins it up
again (back into normal scheduler mode). Then **remove the backfill
vars** so subsequent restarts don't re-run the same backfill on every
boot.

### How to run it locally

Same env vars + `npm run dev` from inside `periscope-scraper/`. Locally
this is often faster for ad-hoc gap fills since you don't pay container
startup cost.

> **2025 holiday list cutoff.** The hard-coded calendar in
> [src/scrape.ts](src/scrape.ts) only covers 2025 + 2026. If you backfill
> a 2027+ range, add those holidays before you start or weekend filtering
> alone won't catch the days. The scraper soft-fails on holidays it
> attempts (logs "No data available" and skips) but the per-day attempt
> still costs UW load and time.

---

## 9. Caveats and fair warnings

- **UW Terms of Service.** Browser-driven scraping of a paid product is
  in a gray area at best. UW's ToS likely prohibits it. The original
  author runs this against their own paid account for personal use; if
  UW objects, your account is the one that gets banned. Don't run this
  against an account you can't afford to lose.
- **No stable selectors.** UW uses Tailwind hash classes that change on
  every deploy, plus Radix popovers that lazy-load. Roughly once a
  month the selectors in [src/scrape.ts](src/scrape.ts) need a touch.
  The probe scripts under [scripts/](../scripts/) are the canonical way
  to re-discover the right selectors when this happens.
- **Single owner per service.** One auth state per service. If you
  share a UW account across two scrapers, expect cookie revocation.
- **No rate limiting on UW's side that we know of.** The 10-minute
  cadence is conservative; the original spec considered 5-minute but
  matched UW's own slot publishing cadence. Going faster gains you
  nothing — UW only publishes a new slice every 10 min — and increases
  detection risk.
- **The `timeframe` column matters.** Greek-cycling within one tick
  takes 5–10 seconds, and UW publishes a new slot every 10 minutes. If
  your tick lands at the boundary, the three Greek captures may come
  from different UW slots even though they share `captured_at`.
  [src/scrape.ts](src/scrape.ts) detects this and walks the timeframe
  back to a gamma anchor; consumers should still group on `timeframe`
  as well as `captured_at` to be safe.
- **No automated re-auth.** When UW invalidates the cookie, ticks fail
  silently from your dashboard's perspective. Wire up Sentry alerts on
  `tick failed` errors, or set a watchdog query (`SELECT MAX(captured_at)
FROM periscope_snapshots` should be < 15 minutes old during RTH).

---

## 10. Going further

If you want to adapt the scraper beyond the 0DTE-only / Periscope-only
defaults:

- **Multi-DTE.** [src/scrape.ts](src/scrape.ts) hard-codes the Single-
  Expiry filter to today; `setExpirySingle()` already accepts any
  YYYY-MM-DD. Loop it across the DTE 0–7 expiries you care about and
  stamp each row's `expiry` accordingly.
- **Other Periscope tabs.** The Heat Map and Delta Flow tabs render
  their data in entirely different DOM. The parser would have to be
  rewritten — the scaffolding (auth, scheduler, batched inserts) is
  reusable.
- **Different DB.** [src/db.ts](src/db.ts) is the only Neon-specific
  file. The driver imports from `@neondatabase/serverless`; swap to
  `pg` (~30 lines of edits) if you want to point at vanilla Postgres.

If you fork the parent repo, also see
[docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md](../docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md)
for the original design rationale (parser contract, DB schema choices,
why Single-Expiry over DTE=[0,0]).
