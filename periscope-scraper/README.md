# periscope-scraper

Long-running Railway service that scrapes the UW Periscope **Market Maker
Exposures Table** every 10 minutes during the regular trading session and
persists per-strike Gamma, Charm, and Vanna values to the
`periscope_snapshots` table in Neon Postgres.

Sibling service to `sidecar/` (Databento futures ingestion). Same Railway
deploy pattern, same env-var conventions, separate Dockerfile and process.

## What it scrapes

The page at <https://unusualwhales.com/periscope/market-exposures-table> renders
~165 strikes for the user-configured 0DTE expiry, with one MM-attributed
exposure value per strike per Greek. It's a single-Greek-at-a-time view, so
the scraper cycles through Gamma → Charm → Vanna by clicking the Greek
dropdown between captures.

The "Market Maker Exposure" tab (chart histogram view) and the "Delta Flow"
tab live elsewhere; this scraper only handles the table view. Positions is
**not** an option on this view.

## Auth

Playwright `storageState` JSON, captured locally via:

```bash
PERISCOPE_URL='https://unusualwhales.com/periscope/market-exposures-table' \
  node scripts/periscope-probe.mjs --login
```

This opens a headed Chromium with anti-detection flags so Google OAuth
accepts the browser. Logging in once writes `~/.periscope-probe-auth.json`,
which contains the session cookies Playwright needs to load the page
authenticated. The runtime expects this file at `UW_AUTH_STATE_PATH`
(default `/data/uw-auth-state.json`); on Railway we ship it as a base64
env var that the container decodes to disk on startup — see the deploy
section.

The page must be **pre-configured** in the saved view to today's expiry +
"Latest" timeframe. The Greek selection is overridden per-tick by the
scraper. UW retains expiry/timeframe selections in its session state so
the storageState capture preserves them.

## Railway deploy

1. Create a new Railway service from this directory (separate from the
   existing `sidecar/` service).
2. Set the env vars below in the Railway dashboard.
3. Connect the GitHub repo, set the **root path** to `periscope-scraper/`.
4. Auto-deploys on any push that touches `periscope-scraper/**`.

Do NOT enable scale-to-zero — the service is intentionally long-running and
the 10-minute idle stretches between ticks would otherwise kill it.

### Shipping the auth state to Railway

Railway env vars are strings. To ship a JSON file, base64-encode it and
decode at container start:

```bash
# locally, after running `--login`:
base64 -i ~/.periscope-probe-auth.json | pbcopy
# paste into Railway as UW_AUTH_STATE_B64
```

Add a one-line decoder to the container start (e.g. via a `pre-start.sh`
that the Dockerfile CMD calls before `node dist/index.js`):

```bash
echo "$UW_AUTH_STATE_B64" | base64 -d > /data/uw-auth-state.json
```

When UW invalidates the session (typically every few weeks), re-run
`--login` locally and update the env var.

## Local dev

```bash
cd periscope-scraper
npm install
npx playwright install chromium   # first time only

# point at the auth state created by --login
export UW_AUTH_STATE_PATH="$HOME/.periscope-probe-auth.json"
export DATABASE_URL='postgres://...'
export SENTRY_DSN='https://...'

npm run dev                        # tsx src/index.ts (long-running)
npm run test                       # vitest run (parser tests)
```

The dev loop runs the same 10-minute schedule as production. To force an
immediate scrape during the loop's idle stretch, you can manually call
`scrapeAllPanels()` from a REPL.

## Required env vars

| Variable             | Source                             | Notes                                                                 |
| -------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`       | Neon Postgres (Vercel Marketplace) | Same connection string as Vercel.                                     |
| `SENTRY_DSN`         | Sentry                             | Same DSN as the rest of the project.                                  |
| `UW_PERISCOPE_URL`   | UW                                 | Default `.../periscope/market-exposures-table`.                       |
| `UW_AUTH_STATE_PATH` | local file path                    | Default `/data/uw-auth-state.json` (Railway volume).                  |
| `UW_AUTH_STATE_B64`  | base64 of the storageState JSON    | Railway-only; decoded to `UW_AUTH_STATE_PATH` by the container start. |
| `LOG_LEVEL`          | -                                  | Optional; defaults to `info`.                                         |

## Optional env vars — auto-playbook webhook

After each successful scrape tick, the scraper can POST a webhook to
`/api/periscope-auto-playbook` on the main Vercel app. The endpoint then
fires a Claude playbook for the slot via `waitUntil`. See
`docs/superpowers/specs/periscope-auto-playbook-2026-05-10.md`.

Both vars below must be set for the webhook to fire — when either is
missing, the helper short-circuits with a one-time boot warning and the
scrape loop continues unaffected. This lets the scraper deploy before
the webhook is armed.

| Variable                   | Source                                  | Notes                                                                 |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `VERCEL_BASE_URL`          | Vercel deployment URL                   | e.g. `https://theta-options.com`. Trailing slashes are stripped.      |
| `PERISCOPE_WEBHOOK_SECRET` | shared secret (also in Vercel env)      | Sent as `Authorization: Bearer <value>`. MUST match Vercel exactly.   |

The destination table `periscope_snapshots` is created by migration 140 in
the main app, and the auto-playbook columns by migration 142. Run
`POST /api/journal/init` against the Vercel deployment to apply migrations
before starting this service.

## Spec

`docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md` — Phase 2.

## Re-auth procedure

When the session cookie expires (Railway logs will show 401s or login
redirects on every tick), re-run the probe `--login` flow locally and
update the Railway env var. There's no in-flight refresh — the simple
cookie-paste model is intentional for single-owner scraping.
