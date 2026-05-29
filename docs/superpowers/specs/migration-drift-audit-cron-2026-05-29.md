# Migration-drift audit cron

**Date:** 2026-05-29
**Status:** implementing

## Goal

Detect when a DB migration has been authored in code (`MIGRATIONS` in
`api/_lib/db-migrations.ts`) but never applied to the live database, and alert
via Sentry before a downstream consumer crashes on the missing table/column.

## Motivation

Migration #182 (`takeit_health_daily`, authored 2026-05-28) was committed and
deployed but never applied — this project applies migrations via direct psql
(`OWNER_SECRET` is empty in Vercel prod, so the owner-gated migrate endpoint
401s). Nothing detected the drift. Two consumers broke instead:

- `ml/src/takeit_drift_monitor.py` crashed the nightly `make update` (visible).
- `api/cron/audit-takeit-health` threw `NeonDbError: relation
  "takeit_health_daily" does not exist` at 2026-05-28T23:30 UTC (silent until
  Sentry — issue `SENTRY-EMERALD-DESERT-DH`).

Code was at migration 182, DB at 181, and the gap surfaced only via outage.
A cheap daily check turns this class of bug from "found by crash" into "found
by alert."

## Design

New cron `GET /api/cron/audit-migration-drift`, mirroring the
`audit-takeit-health` shape exactly (cronGuard, `withCronCheckin`,
`withDbRetry`, Sentry isolation scope, `reportCronRun`).

- Read applied ids: `SELECT id FROM schema_migrations`.
- Compute the code id set from imported `MIGRATIONS`.
- `missing = codeIds.filter(id => !appliedIds.has(id))` — set difference, so a
  gap anywhere (not just the max) is caught.
- If `missing.length > 0`: `Sentry.captureMessage` at `warning` with tag
  `cron.anomaly: migration-drift` and `extra: { missing, appliedMax, codeMax }`.
- Always respond 200 with `{ applied_max, code_max, missing }`; reserve 500 +
  `captureException` for genuine query failure (transient Neon, etc.).
- Extra applied ids beyond code (DB ahead of code, e.g. post-revert) are NOT
  flagged — that is not a drift error.

## Schedule

`0 12 * * *` (daily, 12:00 UTC / 07:00 CT) — ahead of the 13:00 UTC
market-data crons and the 23:30 UTC audit, giving a window to react before
table-dependent jobs run.

Not added to `SCHEDULE_MAP` — consistent with the sibling `audit-takeit-*`
crons, which run un-monitored for check-ins but still report failures via
`Sentry.captureException` + `reportCronRun`.

## Files

- `api/cron/audit-migration-drift.ts` (new)
- `api/__tests__/cron-audit-migration-drift.test.ts` (new) — auth guard,
  all-applied happy path, drift-detected (captureMessage warning), DB-error 500.
- `vercel.json` — one cron entry.

## Out of scope

- Auto-applying migrations (intentional: psql is a deliberate manual gate).
- Detecting column/constraint drift within an applied migration (id-level only).
