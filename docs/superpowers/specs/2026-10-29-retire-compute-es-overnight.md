---
status: Plan
date: 2026-10-29
---

# Retire the compute-es-overnight pipeline

## Goal

Remove the `compute-es-overnight` cron and its two empty tables. The
cron has had no input since Databento was removed (2026-09-29), so it
runs twice every weekday and writes nothing.

## Why (checked 2026-10-29 against production Neon, read-only)

- `es_bars`: 0 rows. Nothing writes it. Migration #42 copied its history
  into `futures_bars`, which uw-stream fills live (ES from 2025-04-06 to
  now).
- `es_overnight_summaries`: 0 rows. Only the cron writes it, and nothing
  reads it.
- **Other references:**
  - `api/cron/backup-tables.ts` backs up both tables daily.
  - Two comments (`api/_lib/cron-schedules.ts:152`,
    `api/cron/auto-prefill-premarket.ts:19`) describe their own
    schedules as mirroring this cron's.
  - `api/_lib/gamma-detector.ts:449-451` mentions `es_bars` as history.
  - The `es_bars` CTE in `sidecar/src/archive_query.py` is a DuckDB name
    over the archive's Parquet files, not this table, so it is out of
    scope.
- Owner decision 2026-10-29: retire the cron rather than repoint it at
  `futures_bars`.

## Phases

1. **Remove the cron.** About 20 min.
   - Delete `api/cron/compute-es-overnight.ts` and
     `api/__tests__/compute-es-overnight.test.ts`.
   - Remove its `vercel.json` cron entry and its `api/_lib/cron-schedules.ts`
     entry.
   - Reword the two "mirrors compute-es-overnight" comments so each
     explains its own dual-slot schedule.
   - Fix any registry test that pins the cron list or count.
2. **Drop the tables.** About 20 min.
   - A new migration in `api/_lib/db-migrations.ts`:
     `DROP TABLE IF EXISTS es_overnight_summaries` and
     `DROP TABLE IF EXISTS es_bars`, as in the earlier retirements
     (e.g. `whale_anomalies`, `institutional_blocks`).
   - `api/__tests__/db.test.ts`: add the applied-migrations mock entry,
     the expected-output entry and the SQL call count.
   - Remove both names from `api/cron/backup-tables.ts`.
   - Note the drop in the `gamma-detector.ts` comment.
   - A PGlite test that the drop works, keeps `futures_bars`, is
     idempotent, and fails closed (both tables kept) when another object
     depends on one.
   - Apply it to production **only after the deploy carrying Phases 1
     and 2 is READY**. Until then the live cron still reads `es_bars`
     and `backup-tables` still lists both tables, so an early drop
     raises `relation "es_bars" does not exist` in Sentry. From the main
     checkout (the worktree has no `.env.local`):
     - Pre-check, read-only: `SELECT max(id) FROM schema_migrations` is
       199 (so only #200 applies), and both tables have 0 rows.
     - Apply: `npx tsx --env-file=.env.local scripts/run-pending-migrations.mts`.
       It prints the host and waits 5 s for Ctrl-C, then runs every
       pending migration in order, each in its own transaction.
     - Post-check: `to_regclass('public.es_bars')` and
       `to_regclass('public.es_overnight_summaries')` are NULL, and
       `schema_migrations` has id 200.
   - Then delete the `compute-es-overnight` Sentry cron monitor (owner
     approved 2026-10-29), before its first missed check-in at the next
     weekday 13:35 UTC.
3. **Docs.** About 15 min.
   - Remove the `docs/ARCHITECTURE.md` cron-table row and the
     `ml/README.md` table row.
   - Update the cron and migration counts wherever the docs state them
     (README, DEPLOYMENT, CLAUDE.md facts), dated "as of".
4. **Delete 13 dead constants** (`Z_WINDOW_SIZE` too). About 10 min. They are left over from
   the same retired IV-anomaly block as the `CATALYST_*` constants
   (deleted 2026-10-29), and each appears only at its own definition in
   `api/_lib/constants.ts`: `VOL_OI_RATIO_THRESHOLD`,
   `SKEW_DELTA_THRESHOLD`, `Z_SCORE_THRESHOLD`, `ASK_MID_DIV_THRESHOLD`,
   `IV_SIDE_SKEW_THRESHOLD`, `RESOLVE_FLAT_PNL_THRESHOLD`,
   `RESOLVE_FAST_PEAK_MINS`, `REGIME_THRESHOLDS`, `TAPE_WINDOW_MIN`,
   `VIX_WINDOW_MIN`, `DP_BUCKETS`, `DP_AT_STRIKE_BAND_PTS`. Owner rule
   (2026-10-29): remove what is unused. Re-verify zero consumers first.
   This phase lands from the `docs/readme-refresh` worktree, on top of
   its `CATALYST_*` deletion in the same block, so the two edits to
   `constants.ts` can't conflict.

## Files

- **Phase 1:** `api/cron/compute-es-overnight.ts` (delete),
  `api/__tests__/compute-es-overnight.test.ts` (delete), `vercel.json`,
  `api/_lib/cron-schedules.ts`, `api/cron/auto-prefill-premarket.ts`.
- **Phase 2:** `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`,
  `api/__tests__/drop-es-tables-pglite.test.ts` (new),
  `api/cron/backup-tables.ts`, `api/__tests__/backup-tables.test.ts`,
  `api/_lib/gamma-detector.ts`, `scripts/backfill-gamma-setup-fires.ts`
  (a log label), `scripts/run-pending-migrations.mts` (its usage lines).
- **Phase 3:** `docs/ARCHITECTURE.md`, `ml/README.md`, and the docs
  holding counts.
- **Phase 4:** `api/_lib/constants.ts`.

## Data dependencies

- One migration that drops two empty tables.
- No new env vars.
- Sentry: if a cron monitor exists for `compute-es-overnight`, it will
  report missed check-ins once the cron is gone. Find it and delete or
  disable it after the deploy.

## Open questions (default picks)

1. **Drop the tables, or keep them empty?** _Default:_ drop, if both
   still have 0 rows when the migration runs. Recreating either is one
   `CREATE TABLE` from the old migration.
2. **Which Sentry monitor?** _Default:_ find it by slug during Phase 1.
   Deleting it is an outward action, so the owner confirms it.

## Thresholds and constants

None.
