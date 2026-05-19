# Sentry / Neon Cleanup — 2026-05-19

## Goal

Drain the 88 unresolved Sentry issues from today by fixing the ~6 real bugs and adding retry coverage for the Neon outage cluster. Most issues are duplicates of the same underlying problems; fixing the roots clears thousands of events.

## Issue Triage (from Sentry, 24h window)

See triage in this session — 10 clusters total. Top 4 root causes account for ~80% of events:

1. **db attempt timeout in periscope enrich** (1328 events) — missing index on `ws_option_trades(ticker, expiry, strike, option_type)` causes 10s per-attempt timeout. Same root cause as `chainExtras degraded to fallback` (489) and `reignitedRows degraded to fallback` (488) — total ~2305 events.
2. **multileg.classify.window_too_large** (285 events) — QQQ option chain exceeds 5000-trade cap. Cap is over-conservative for ETFs; downgrade Sentry capture to logger.
3. **takeit.bundle.manifest_fetch_failed** (298 events) — Vercel Blob list/fetch returns 403. Probably an env / token issue.
4. **Neon outage spillover** (~35 issues) — `recovery_mode`, `server conn crashed?`, `Too many connections attempts`, `out of memory`. Endpoints missing `withDbRetry` spilled errors during ~4h Neon blip.

Plus:
- **archive-gexbot Blob access mismatch** (NEW, 5th recurrence) — `access: 'public'` vs private store.
- **UW rate-limit bursts** — multiple crons hit UW at top-of-minute.
- **uw-stream flush failed** (208) — outage spillover; verify reconnect.
- **periscope_analyses unique_slot race** (2 events) — INSERT lacks ON CONFLICT.

## Phases

### Phase 1 — P0 fixes (clears ~2600 events)

Files:
- [api/cron/archive-gexbot.ts](api/cron/archive-gexbot.ts) — change `access: 'public'` to private (omit the field; default is private).
- [api/_lib/db-migrations.ts](api/_lib/db-migrations.ts) — add migration #N: composite index on `ws_option_trades(ticker, expiry, strike, option_type, executed_at)` covering the periscope enrich query path.
- [api/__tests__/db.test.ts](api/__tests__/db.test.ts) — update mock + expected migration list per the project's migration test convention.
- [api/_lib/multileg-classify-batch.ts](api/_lib/multileg-classify-batch.ts) — drop `Sentry.captureMessage` for `window_too_large` (keep `logger.warn`); bump `MAX_WINDOW_TRADES` from 5000 to 10000. The asyncpg memory pressure that motivated the cap was upstream of uw-stream's own batch path, not multileg classifier load.

Verification: `npm run lint && npm run test:run`.

### Phase 2 — Neon retry coverage + UW rate-limit stagger

Files:
- [api/_lib/db.ts](api/_lib/db.ts) — extend `DB_RETRYABLE_RX` to also match `recovery_mode` / `server_login_retry` / `Too many connections attempts` / `connection closed` / `server conn crashed`.
- Audit which `/api/*` endpoints in the Sentry list lack `withDbRetry` and wrap them. Targets per Sentry culprit:
  - `/api/futures/snapshot`, `/api/gexbot`, `/api/greek-heatmap`, `/api/ticker-net-flow-current`, `/api/interval-ba-feed`, `/api/interval-ba-alerts`, `/api/alerts`, `/api/silent-boom-feed`, `/api/silent-boom-ticker-counts`, `/api/periscope-exposure`, `/api/periscope-playbook`, `/api/net-flow-history`, `/api/darkpool-levels`, `/api/gex-strike-expiry`, `/api/cron/fetch-market-internals`, `/api/cron/fetch-gex-strike-expiry-etfs`, `/api/cron/fetch-etf-tide`, `/api/cron/fetch-strike-iv`, `/api/cron/fetch-strike-trade-volume`, `/api/cron/fetch-strike-exposure`, `/api/cron/fetch-gex-0dte`, `/api/cron/fetch-gexbot-fast`, `/api/cron/fetch-gexbot-strikes`, `/api/cron/monitor-flow-ratio`, `/api/cron/fetch-flow-alerts`, `/api/opening-flow-signal`, `/api/lottery-finder-ticker-counts`, `/api/greek-flow`, `/api/alerts-ack`, `/api/snapshot`, `/api/cron/fetch-nope`, `/api/cron/fetch-greek-flow-etf`, `/api/cron/fetch-futures-snapshot`.
- [vercel.json](vercel.json) — stagger UW-hitting crons so per-minute cap (100) isn't exceeded at top-of-minute.

### Phase 3 — uw-stream + small fixes

Files:
- [api/_lib/takeit-bundle-loader.ts](api/_lib/takeit-bundle-loader.ts) — verify `BLOB_READ_WRITE_TOKEN` is being read correctly. Test path against Blob list manifest path; investigate 403.
- [api/_lib/periscope-db.ts](api/_lib/periscope-db.ts) — add `ON CONFLICT (trading_date, slot_captured_at, auto_generated) DO NOTHING RETURNING id` to `savePeriscopeAnalysis`; on null return, re-run `findExistingRowId`.
- Confirm uw-stream auto-recovered from Neon outage by checking Railway logs / current Sentry tail — no code change if so.

## Open Questions / Defaults

- **MAX_WINDOW_TRADES = 10000** — chosen as 2× current cap. If memory pressure returns post-deploy, drop back to 7500 and chunk windows >5k.
- **takeit manifest 403** — assumed config issue; will investigate before code change.
- **uw-stream `flush failed`** — assumed outage spillover; will not touch unless Sentry still firing post-Neon recovery.

## Thresholds / Constants

- `MAX_WINDOW_TRADES`: 5000 → 10000
- `DB_RETRYABLE_RX`: add `recovery_mode|server_login_retry|Too many connections|connection closed|server conn crashed`
- Composite index columns (ws_option_trades): `(ticker, expiry, strike, option_type, executed_at DESC)`
