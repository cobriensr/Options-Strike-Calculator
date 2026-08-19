# Readiness loose ends + Schwab re-enablement — 2026-08-18

**Date:** 2026-08-18 · **Status:** implemented 2026-08-18 evening (phases A–H + F); C = deployed sidecar + Vercel, pushed to fork · **Owner:** soonerdude28 fork

## Goal

Close the five non-blocking findings from the 2026-08-18 evening readiness
audit (see memory `railway-setup`) and make the codebase ready to use the
owner's newly granted Schwab Trader API access **without** giving up the
UW + Theta market-data facade that killed the 7-day refresh-token treadmill.

## Phases (each independently shippable, disjoint files)

### A. `enrich-lottery-outcomes` cadence (Vercel)
Fires/day are 3.6k–5.3k since the uw-stream universe expansion; the cron
runs once/day at 21:40 UTC with `LIMIT 300`, so ~95% of a day's fires never
get labeled (08-18: 5,047 of 5,347 unlabeled). Two-part fix:
1. **Loop-until-budget** inside one invocation: process batches of 300
   (oldest first) until no unenriched fires remain **or** elapsed wall time
   exceeds `ENRICH_WALL_BUDGET_MS = 240_000` (maxDuration is 300s). Each
   batch keeps the existing 30-fire tick-read chunking and UW throttle.
   Result message reports batches + totals.
2. **Schedule** post-close every 5 min: replace the single `40 21 * * 1-5`
   entry with `40-59/5 21 * * 1-5` **and** `*/5 22-23 * * 1-5` (duplicate
   paths are already used by fetch-gexbot-*). First fire stays ≥ 21:40 UTC
   (original close buffer, valid in EST and EDT). Capacity ≈ 28 runs ×
   ~450 = ~12k fires/day, so a day drains before the 2-day
   ws_option_trades retention.
Files: `api/cron/enrich-lottery-outcomes.ts`,
`api/__tests__/enrich-lottery-outcomes.test.ts`, `vercel.json` (crons),
header comment cadence line. Fix stale "~52 fires/day" comment.

### B. Sign-in entry point (Vercel)
`SchwabAuthLink` → `/api/auth/init` 500s when Schwab creds are absent, while
the real owner login is `GET /api/auth/login`. Keep the SPA link stable and
route server-side:
- `api/auth/init.ts`: if `SCHWAB_CLIENT_ID`/`SCHWAB_CLIENT_SECRET` are not
  both set → `302 /api/auth/login` (before touching redis/getAuthUrl).
  Genuine failures still 500.
- `api/auth/login.ts` GET form: when Schwab IS configured, render a small
  "Connect Schwab account instead" link to `/api/auth/init` (needed for
  positions + breadth internals). No link when unconfigured.
Files: `api/auth/init.ts`, `api/auth/login.ts`, tests
(`api/__tests__/auth-init.test.ts` new or existing, `auth-login.test.ts`).

### G. Schwab passthrough for facade gaps (Vercel)
The facade stays primary (UW+Theta) for `/chains`, `/pricehistory`,
`/quotes`, `/movers`. Add a **real Schwab Market Data passthrough only for
paths/symbols the adapters report as `501 SOURCE_UNAVAILABLE`** (NYSE breadth
internals `$TICK/$TRIN/$ADD/$VOLD`, and any other uncovered path), gated on
Schwab being configured (`SCHWAB_CLIENT_ID` + `SCHWAB_CLIENT_SECRET` set):
- `api/_lib/schwab-fetch.ts`: `SCHWAB_MARKET_BASE = 'https://api.schwabapi.com/marketdata/v1'`;
  in `schwabFetch`, when the adapter result is `SOURCE_UNAVAILABLE` and
  `hasSchwabConfig()` → `schwabApiFetch(SCHWAB_MARKET_BASE, path)`. When
  unconfigured → unchanged 501. Token missing/expired → the existing
  `401 SCHWAB_TOKEN_EXPIRED` / `500 SCHWAB_TOKEN_ERROR` envelope.
- `api/cron/fetch-market-internals.ts`: treat `SCHWAB_TOKEN_EXPIRED` /
  `SCHWAB_TOKEN_ERROR` like SOURCE_UNAVAILABLE for the *skip* decision (one
  warn log per run, not one error per symbol) so the window between "creds
  added" and "owner completed OAuth" is quiet.
- Do NOT passthrough on transient adapter failures (UW 5xx etc.) — only on
  the explicit no-source code. (Possible follow-up: Schwab as fallback.)
Files: `api/_lib/schwab-fetch.ts`, `api/cron/fetch-market-internals.ts`,
`api/__tests__/schwab-fetch*.test.ts`, `api/__tests__/fetch-market-internals*.test.ts`.
Operator steps (user, not code): register callback
`https://options-strike-calculator-hazel.vercel.app/api/auth/callback` on the
Schwab app; `vercel env add SCHWAB_CLIENT_ID production` +
`SCHWAB_CLIENT_SECRET`; redeploy; visit `/api/auth/init`.

### D. Unconfigured optional features must not 500 (Vercel + sidecar)
Extends commit 331e915c's principle ("unconfigured != broken"):
- `api/cron/backfill-futures-gaps.ts`: missing `DATABENTO_API_KEY` →
  200 `{ status: 'skipped', message: 'DATABENTO_API_KEY not configured' }`
  (info log, no Sentry). Mirror the gexbot pattern; note this handler uses
  `cronGuard` directly, not `withCronInstrumentation` — keep its shape.
- `api/events.ts`: missing `FRED_API_KEY` → 200 with the normal response
  shape but empty events + `configured: false`, cache headers set, warn log
  (not error). Frontend (`useMarketData.fetchers.ts` `EventsResponse`,
  `EventDayWarning`) must keep working — verify the shape.
- Sidecar `/archive/day-summary-batch` (and `day-summary`/`day-features`)
  returned HTTP 500 for 2026-08-18 when the archive volume is unseeded.
  Investigate in `sidecar/src/health.py` / `archive_query.py` (reproduce
  with `ARCHIVE_ROOT` pointing at an empty/nonexistent dir); return
  404/503 with a JSON code instead of 500. Vercel `fetch-day-ohlc.ts`:
  treat 404/503 as "skipped, archive unavailable" (no throw). Keep
  `refresh-current-snapshot`'s existing 404 handling.
- `/api/chain` 502 ×7 (1.8%) on 08-18: sidecar Theta 503 → UW fallback
  also failed. **Root cause (found):** the fallback was UW `stock-state`,
  which returns HTTP 422 for EVERY index ticker (SPX/VIX/NDX/RUT —
  deterministic). Fixed in **phase H1**: index roots now fall back to the UW
  stock screener (`/screener/stocks?ticker=SPY,{ROOT}`; SPY companion needed
  because index-only requests return NULL close), NDX uses it as primary
  (`$NDX` quotes + NDX 1m candles are alive again), RUT → 501
  SOURCE_UNAVAILABLE (UW has no RUT price) → Schwab passthrough (phase G).
  Open check for the first session after deploy: confirm screener `close`
  is live intraday (compare against sidecar `/theta/index/price` ~10:00 ET).
Files: `api/cron/backfill-futures-gaps.ts`, `api/events.ts`,
`api/cron/fetch-day-ohlc.ts`, sidecar archive route + tests, tests.

### E. Theta nightly observability (sidecar)
- `MAX_JOB_DURATION_S` 1800 → 3h (nightly took ~99 min on 08-18).
- Declare the Sentry monitor in code: `@sentry_sdk.monitor(monitor_slug=…,
  monitor_config={schedule crontab '25 17 * * *', timezone 'America/New_York',
  checkin_margin 10, max_runtime 180, failure_issue_threshold 1,
  recovery_threshold 1})`; fix the stale comment (`25 22 * * *` UTC).
Files: `sidecar/src/theta_fetcher.py`, `sidecar/tests/test_theta_fetcher.py`.

### F. Repo hygiene
- Add `skills-lock.json` to `.gitignore` (the `.claude/skills/upstash-*`
  dirs it pins are already ignored; upstream has no skills manifest).
- Update `docs/superpowers/specs/schwab-replacement-2026-08-16.md` Status
  line: Phases 1, 2, 4 shipped; Phase 3 live-validated 2026-08-17/18;
  Schwab access restored 2026-08-18 → passthrough (this spec, phase G).
- CLAUDE.md: "35 scheduled jobs" → count from vercel.json (84 entries).

### C. Handoff
Push branch to `fork`; retitle PR #199 to reflect the Schwab-replacement +
hardening scope; deploy Vercel (`vercel --prod`) and sidecar (`railway up`).

### H. Follow-ups surfaced during D (Vercel)
- **H1** — index-spot fallback rewrite in `api/_lib/market-data-adapters.ts`
  (see D bullet above). `UW_INDEX_ROOTS = {SPX, NDX, VIX}`; new
  `NoSourceError` → `sourceUnavailable(path)`; sidecar blip never reported
  as SOURCE_UNAVAILABLE (transient wins).
- **H2** — `/api/events` without `FRED_API_KEY` still serves the static FOMC
  + early-close/holiday events (`configured: false`, no FRED/Finnhub calls,
  no redis read/write) so `EventDayWarning` keeps working on this fork.

## Data dependencies
No migrations. New env (user-provided): `SCHWAB_CLIENT_ID`,
`SCHWAB_CLIENT_SECRET` (Vercel prod+preview). Optional:
`FRED_API_KEY`, `DATABENTO_API_KEY` (Vercel).

## Thresholds / constants
`ENRICH_WALL_BUDGET_MS = 240_000`; enrich batch 300; tick chunk 30 (unchanged);
`MAX_JOB_DURATION_S = 3 * 60 * 60`; monitor `max_runtime` 180 min,
`checkin_margin` 10 min.

## Open questions (defaults picked)
- Schwab as *fallback* for transient UW/Theta failures on covered paths?
  Default: no (predictability; avoids re-creating the treadmill dependency).
- Passthrough for `$NDX` quotes (fetch-spx-candles-1m NDX ratio)? Resolved
  by H1: the UW 422 was deterministic (stock-state has no index tickers);
  NDX now comes from the UW screener, so no passthrough needed. `$RUT` is
  the only root that reaches the passthrough.
