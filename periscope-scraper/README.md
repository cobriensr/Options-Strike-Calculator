# periscope-scraper

Long-running Railway service that scrapes UW Periscope HTML every 10 minutes
during the regular trading session and persists per-strike Gamma, Charm,
Vanna, and Positions values to the `periscope_snapshots` table in Neon
Postgres.

Sibling service to `sidecar/` (Databento futures ingestion). Same Railway
deploy pattern, same env-var conventions, separate Dockerfile and process.

## Status: AWAITING PHASE 0 PROBE

`src/scrape.ts` is intentionally a stub. The Periscope page is a private,
dynamic React UI — guessing selectors blind would either scrape nothing or
scrape the wrong cells. We need real HTML samples before wiring the parser.

The service will boot, schedule its 10-minute loop, and run normally. The
first scrape tick will throw a clear error to Sentry and Railway logs:

> `scrape.ts is a stub — Phase 0 probe must run first to identify selectors.`

That is expected until Phase 0 lands.

## What you need to do (Phase 0)

1. Run `node scripts/periscope-probe.mjs` from the **repo root**, locally,
   with your UW session cookie set in env. The probe opens Periscope in
   Playwright and dumps the rendered HTML for each panel.
2. Capture HTML samples for all four panels: Gamma, Charm, Vanna, Positions.
3. Hand the HTML files back so the selectors can be wired into
   `src/scrape.ts`.

The full design is in
`docs/superpowers/specs/periscope-html-ingestion-2026-05-07.md`.

## Railway deploy (after Phase 0 is complete)

1. Create a new Railway service from this directory (separate from the
   existing `sidecar/` service).
2. Set the env vars below in the Railway dashboard.
3. Connect the GitHub repo, set the **root path** to `periscope-scraper/`.
4. Auto-deploys on any push that touches `periscope-scraper/**`.

Do NOT enable scale-to-zero — the service is intentionally long-running and
the 10-minute idle stretches between ticks would otherwise kill it.

## Local dev

```bash
cd periscope-scraper
npm install
npx playwright install chromium   # first time only
npm run dev                        # tsx src/index.ts
```

You'll need `DATABASE_URL`, `SENTRY_DSN`, and `UW_SESSION_COOKIE` exported in
your shell. The first tick will throw the stub error — that's expected until
selectors are wired.

## Required env vars

| Variable            | Source                             | Notes                                                         |
| ------------------- | ---------------------------------- | ------------------------------------------------------------- |
| `DATABASE_URL`      | Neon Postgres (Vercel Marketplace) | Same connection string as Vercel                              |
| `SENTRY_DSN`        | Sentry                             | Same DSN as the rest of the project                           |
| `UW_SESSION_COOKIE` | UW dashboard cookie jar            | The authenticated session cookie                              |
| `UW_PERISCOPE_URL`  | UW                                 | Optional override; default placeholder until Phase 0 confirms |
| `LOG_LEVEL`         | -                                  | Optional; defaults to `info`                                  |

The destination table `periscope_snapshots` is created by migration 140 in
the main app. Run `POST /api/journal/init` against the Vercel deployment to
apply the migration before starting this service.
