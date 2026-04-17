# Pyramid Trade Tracker — Cleanup Runbook

**Purpose**: Remove the pyramid tracker experiment from the codebase if the ML cutoff hypothesis doesn't validate and the dataset is abandoned.

**When to run this**: Only after the experiment has been formally concluded (≥3 months of attempted use + analysis showing no signal, or a pivot to a different methodology). Don't run this to "declutter" — data accumulation is the point.

**Estimated time**: ~10 minutes.

## Preconditions

- On `main` branch with a clean working tree
- `npm run review` is green before you start

## Step 1 — Write a cleanup migration

Append a new migration to `api/_lib/db-migrations.ts` (numbering continues from the highest id — check the file; as of 2026-04-17 the last pyramid migration was #66, so next free id is whatever is at the bottom of the list):

```ts
{
  id: <next_free_id>,
  description: 'Drop pyramid_chains + pyramid_legs tables (experiment retired)',
  statements: (sql) => [
    sql`DROP TABLE IF EXISTS pyramid_legs`,
    sql`DROP TABLE IF EXISTS pyramid_chains`,
  ],
},
```

Order matters: drop `pyramid_legs` first (the child with FK) then `pyramid_chains`.

## Step 2 — Delete the feature files

```bash
rm -rf src/components/PyramidTracker/
rm src/hooks/usePyramidData.ts
rm src/types/pyramid.ts
rm -rf src/__tests__/components/PyramidTracker/
rm src/__tests__/hooks/usePyramidData.test.ts

rm -rf api/pyramid/
rm api/_lib/db-pyramid.ts
rm api/__tests__/pyramid.test.ts
rm api/__tests__/db-pyramid.test.ts
```

## Step 3 — Remove imports and renders

### `src/App.tsx`

Remove the import line:

```tsx
import { PyramidTrackerSection } from './components/PyramidTracker';
```

Remove the render (ErrorBoundary wrapper + section) below the AnalysisHistory block.

### `src/main.tsx`

Remove these 8 entries from the `initBotId({ protect: [...] })` array:

```tsx
{ path: '/api/pyramid/chains', method: 'GET' },
{ path: '/api/pyramid/chains', method: 'POST' },
{ path: '/api/pyramid/chains', method: 'PATCH' },
{ path: '/api/pyramid/chains', method: 'DELETE' },
{ path: '/api/pyramid/legs', method: 'POST' },
{ path: '/api/pyramid/legs', method: 'PATCH' },
{ path: '/api/pyramid/legs', method: 'DELETE' },
{ path: '/api/pyramid/progress', method: 'GET' },
```

### `api/_lib/validation.ts`

Remove the `pyramidChainSchema` and `pyramidLegSchema` exports (and their `PyramidChainInput` / `PyramidLegInput` type exports).

### `api/__tests__/db.test.ts`

Remove the mock-sequence entries for migrations 65 and 66 (or whatever ids were assigned). Adjust the SQL call count and `sql.transaction` count accordingly — subtract:

- Migration 65: 6 SQL calls, 1 transaction
- Migration 66: 8 SQL calls, 1 transaction
- Cleanup migration: adds 3 SQL calls (2 DROP + 1 INSERT schema_migrations) and 1 transaction

## Step 4 — Remove the kill-switch env var

```bash
# Local .env files
grep -v VITE_PYRAMID_ENABLED .env.local > .env.local.new && mv .env.local.new .env.local

# Vercel — requires dashboard or CLI
vercel env rm VITE_PYRAMID_ENABLED production
vercel env rm VITE_PYRAMID_ENABLED preview
vercel env rm VITE_PYRAMID_ENABLED development
```

## Step 5 — Verify

```bash
npm run review
```

Expected: zero TS errors, zero ESLint errors, all tests green. The migration test should still pass with the new drop migration in place.

## Step 6 — Commit and push

```bash
git add -A
git commit -m "chore: Retire pyramid tracker experiment (N=<count>, hypothesis not validated)"
git push
```

If the experiment produced useful data, consider exporting the CSVs to a long-term archive before dropping the tables:

```bash
# From pyramid-tracker UI — click "Export CSV" and save both files
# to wherever long-term experiment data lives (e.g., docs/archives/)
```

## What the migration drops

- **`pyramid_legs`** — all rows (per-leg observations, ~5-10 per chain)
- **`pyramid_chains`** — all rows (one per trade session)
- **`schema_migrations`** — NOT affected. The cleanup migration adds its own row; nothing is retroactively removed. This is fine — migration history is audit-only.

## Deferred work NOT to clean up

- The ML pipeline files in `ml/` — were never implemented beyond the spec. Nothing to remove.
- Sentry alerts / dashboards — none were configured for this feature.
- Vercel cron jobs — none registered.

## If you change your mind mid-cleanup

`git reset --hard HEAD~1` reverts the cleanup commit locally. If already pushed, follow the team's standard revert-PR workflow.

**The DB migration is irreversible once run in production** — the data is gone. If you might want the data back later, dump the tables before running the cleanup migration:

```bash
pg_dump $DATABASE_URL -t pyramid_chains -t pyramid_legs > pyramid_backup_$(date +%Y-%m-%d).sql
```

## Success criteria

Run this checklist after Step 5:

- [ ] `grep -r PyramidTracker src/ api/` returns no results (except the migration file itself, which references the dropped table names)
- [ ] `grep -r pyramid_chains src/ api/` returns only the drop migration
- [ ] `npm run review` is green
- [ ] `VITE_PYRAMID_ENABLED` is no longer set in any env context
- [ ] Production `/api/pyramid/*` endpoints return 404 after deploy
- [ ] Production DB queries `SELECT * FROM pyramid_chains LIMIT 1` return a "relation does not exist" error

If all six check, cleanup is complete.
