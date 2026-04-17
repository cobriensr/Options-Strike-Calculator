# Pyramid Trade Tracker — Spec

**Date**: 2026-04-16
**Author**: scoped collaboratively w/ Claude; for single-owner research use
**Status**: **Implemented** — 2026-04-17. All phases (1A, 1B, 1C, 2A, 2B, 2C, 3) shipped on branch `cobriensr/feat/pyramid-trade-tracker`. Cleanup runbook at [`../plans/pyramid-tracker-cleanup-runbook.md`](../plans/pyramid-tracker-cleanup-runbook.md).

## Goal

Build a self-contained, droppable logging tool for MNQ pyramid trades (CHoCH initial entry + BOS continuation adds). Capture per-leg state so that after ≥30 chains are logged, an ML cutoff model can be trained in `ml/src/pyramid_cutoff.py` to predict which BOS-N additions have negative expected value. Phase 1 is logging only; the model is deferred to a future spec.

## Design Intent: Droppable Experiment

Every file introduced is confined to new folders. If the hypothesis fails, deletion is mechanical:

- Drop the `pyramid_chains` + `pyramid_legs` tables via a single cleanup migration.
- Delete `src/components/PyramidTracker/`.
- Delete `api/pyramid/`.
- Delete `api/_lib/db-pyramid.ts`.
- Remove 1 import line from `src/App.tsx`.
- Remove 1 env var (`VITE_PYRAMID_ENABLED`).

**Non-negotiable rule during implementation**: no cross-cutting integration with journal, analyze prompt, or ML pipeline. Feature must be reversible at near-zero cost.

## Decisions Captured

| Decision | Chosen |
| --- | --- |
| Sample size display | `N / 30 (min) / 50 (target) / 100 (robust)` + per-feature fill rates + elapsed calendar days |
| Entry workflow | Live entry — one leg at a time as BOSes print (preserves `ob_quality`) |
| Field optionality | **All feature fields optional.** Only PKs, FKs, `leg_number`, and system timestamps are required. Partial rows save successfully. |
| UI placement | Collapsible section below journal, defaulting collapsed |
| Auth | Owner-only via `isOwner(req)` — reads + writes |
| Kill switch | `VITE_PYRAMID_ENABLED` env var; section renders `null` when false |

## Data Dependencies

### New tables (migration id 65 in `db-migrations.ts`)

**`pyramid_chains`** — one row per trade sequence. Only the PK, `status`, and system timestamps are required. All feature fields are nullable so partial rows save successfully.

```sql
CREATE TABLE IF NOT EXISTS pyramid_chains (
  id                  TEXT PRIMARY KEY,                   -- "YYYY-MM-DD-SYMBOL-N"
  trade_date          DATE DEFAULT CURRENT_DATE,          -- nullable; defaults to today
  instrument          TEXT,                               -- MNQ / MES / ES / NQ
  direction           TEXT CHECK (direction IN ('long', 'short')),
  entry_time_ct       TIME,
  exit_time_ct        TIME,
  initial_entry_price NUMERIC,
  final_exit_price    NUMERIC,
  exit_reason         TEXT CHECK (exit_reason IN ('reverse_choch', 'stopped_out', 'manual', 'eod')),
  total_legs          INTEGER DEFAULT 0,
  winning_legs        INTEGER DEFAULT 0,
  net_points          NUMERIC DEFAULT 0,
  session_atr_pct     NUMERIC,
  day_type            TEXT CHECK (day_type IN ('trend', 'chop', 'news', 'mixed')),
  higher_tf_bias      TEXT,
  notes               TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pyramid_chains_date ON pyramid_chains (trade_date DESC);
CREATE INDEX IF NOT EXISTS idx_pyramid_chains_status ON pyramid_chains (status);
```

> Note: Postgres `CHECK` constraints permit `NULL` by default, so the enum-style checks above don't force the column to be filled — they only validate non-null values.

**`pyramid_legs`** — one row per contract entry. Only PK, FK (`chain_id`), `leg_number`, and system timestamps are required. All feature fields are nullable.

```sql
CREATE TABLE IF NOT EXISTS pyramid_legs (
  id                              TEXT PRIMARY KEY,    -- "{chain_id}-L{leg_number}"
  chain_id                        TEXT NOT NULL REFERENCES pyramid_chains(id) ON DELETE CASCADE,
  leg_number                      INTEGER NOT NULL,    -- 1 = CHoCH; 2+ = BOS adds
  signal_type                     TEXT CHECK (signal_type IN ('CHoCH', 'BOS')),
  entry_time_ct                   TIME,
  entry_price                     NUMERIC,
  stop_price                      NUMERIC,
  stop_distance_pts               NUMERIC,
  stop_compression_ratio          NUMERIC,             -- computed: stop_distance / leg_1_stop_distance
  vwap_at_entry                   NUMERIC,
  vwap_1sd_upper                  NUMERIC,
  vwap_1sd_lower                  NUMERIC,
  vwap_band_position              TEXT CHECK (vwap_band_position IN ('outside_upper', 'at_upper', 'inside', 'at_lower', 'outside_lower')),
  vwap_band_distance_pts          NUMERIC,
  minutes_since_chain_start       INTEGER,
  minutes_since_prior_bos         INTEGER,
  ob_quality                      INTEGER CHECK (ob_quality BETWEEN 1 AND 5),
  relative_volume                 INTEGER CHECK (relative_volume BETWEEN 1 AND 5),
  ob_high                         NUMERIC,    -- upper boundary of the order block
  ob_low                          NUMERIC,    -- lower boundary of the order block
  ob_poc_price                    NUMERIC,    -- price at the top volume node
  ob_poc_pct                      NUMERIC CHECK (ob_poc_pct BETWEEN 0 AND 100),        -- volume share at POC (e.g. 32 for 32%)
  ob_secondary_node_pct           NUMERIC CHECK (ob_secondary_node_pct BETWEEN 0 AND 100),  -- 2nd-largest node % (always captured)
  ob_tertiary_node_pct            NUMERIC CHECK (ob_tertiary_node_pct BETWEEN 0 AND 100),   -- 3rd-largest node %, nullable (not always visible)
  ob_total_volume                 NUMERIC,    -- total OB volume if shown (e.g. 38914 + ... from LuxAlgo)    -- volume at signal bar vs. recent avg (1=thin, 5=heavy)
  session_phase                   TEXT CHECK (session_phase IN ('pre_open', 'open_drive', 'morning_drive', 'lunch', 'afternoon', 'power_hour', 'close')),
  session_high_at_entry           NUMERIC,                                           -- day's high up to this leg
  session_low_at_entry            NUMERIC,                                           -- day's low up to this leg
  retracement_extreme_before_entry NUMERIC,                                          -- deepest adverse price between prior leg entry and this leg entry
  exit_price                      NUMERIC,
  exit_reason                     TEXT CHECK (exit_reason IN ('reverse_choch', 'trailed_stop', 'manual')),
  points_captured                 NUMERIC,
  r_multiple                      NUMERIC,
  was_profitable                  BOOLEAN,
  notes                           TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pyramid_legs_chain ON pyramid_legs (chain_id, leg_number);
```

> Note: `stop_compression_ratio` is computed server-side on insert as `stop_distance_pts / leg_1_stop_distance_for_chain`. If `stop_distance_pts` is missing on leg 1 or the current leg, the ratio is left NULL.

### New env vars

- `VITE_PYRAMID_ENABLED` — frontend kill switch (no server equivalent; API endpoints are always live but owner-gated).

### Existing env vars reused

- `OWNER_SECRET` — already used by `isOwner(req)`.
- `DATABASE_URL` — Neon Postgres.

## Missing Data Strategy

All feature fields are nullable. This is deliberate — during live trading the user will not always have time to read every chart value. Consequences for analysis:

### Per-feature fill rate is a first-class metric

Total chain count is not a sufficient measure of dataset quality. A feature captured in only 40% of legs cannot meaningfully participate in a model. The frontend must display fill rates alongside the chain counter so the user can see at a glance which features are reliably captured vs. sparse.

### Analysis approach for missing data

When the ML phase begins (future spec), two strategies are available depending on model type:

1. **Listwise deletion (default)** — for any model, drop legs missing any feature the model uses. Simpler, no imputation bias. Reduces effective N.
2. **Feature-available subsetting** — build the model using only features with ≥80% fill rate across the dataset. Preserves N, narrows feature set.
3. **Simple imputation** (optional) — median for numeric, mode for categorical, only for features with 60-80% fill rate where dropping rows would cost too much N. Must be documented as a caveat in any reported results.

Multiple imputation and more complex missing-data techniques are **out of scope** — they add analytical complexity without meaningful gain at the sample sizes targeted here.

### Fill rate display in ProgressCounter

Alongside `42 / 30 (min) / 50 (target) / 100 (robust)`, the counter shows a scrollable list of per-feature fill rates grouped into bands:

- **High fill rate (≥80%)** — green, "ready for modeling"
- **Medium (50-79%)** — amber, "partially useful, consider increasing capture rate"
- **Low (<50%)** — red, "unusable as a model feature at current fill"

This gives fast feedback about whether future data collection should prioritize filling in previously-skipped fields vs. simply logging more chains.

### `stop_compression_ratio` edge case

This derived field depends on leg 1's `stop_distance_pts`. If that value is missing, the ratio is NULL for every leg in the chain. A small chain-level warning in the UI flags this: "Leg 1 stop distance missing — compression ratios unavailable for this chain."

## Thresholds / Constants

| Constant                    | Value | Rationale                                                |
| --------------------------- | ----- | -------------------------------------------------------- |
| `SAMPLE_SIZE_MIN`           | 30    | Logistic regression floor for 3-4 features               |
| `SAMPLE_SIZE_TARGET`        | 50    | Comfortable fit, allows day-type stratification          |
| `SAMPLE_SIZE_ROBUST`        | 100   | Robust generalization; supports GBM w/ cross-validation  |
| `OB_QUALITY_MIN`            | 1     | Thin / questionable structure                            |
| `OB_QUALITY_MAX`            | 5     | Strong structure, clean rejection                        |
| `CHAIN_ID_FORMAT`           | `YYYY-MM-DD-{SYMBOL}-{N}` | Unique, sortable, human-readable          |
| `LEG_ID_FORMAT`             | `{chain_id}-L{leg_number}` | Derivable from chain + leg number       |

## Phases

### Phase 1 — DB + Backend (~5 files, ~2-3 hours)

**Files:**
- `api/_lib/db-migrations.ts` — append migration id 65 (two tables + indexes)
- `api/_lib/db-pyramid.ts` — NEW. Query module: `createChain`, `getChains`, `updateChain`, `deleteChain`, `createLeg`, `updateLeg`, `deleteLeg`, `getChainWithLegs`, `getProgressCounts`
- `api/_lib/validation.ts` — append `pyramidChainSchema` + `pyramidLegSchema` Zod definitions. **All feature fields use `.optional().nullable()`**; only `id` (chain) and `id` + `chain_id` + `leg_number` (leg) are strictly required. Enum fields validate only when non-null.
- `api/pyramid/chains.ts` — NEW. Endpoint: GET (list), POST (create), PATCH (update), DELETE (cascade)
- `api/pyramid/legs.ts` — NEW. Endpoint: POST (create), PATCH (update), DELETE (single leg)
- `api/pyramid/progress.ts` — NEW. Endpoint: GET counts stratified by `day_type` + per-feature fill rates (null-counts per column) + elapsed calendar days since first chain
- `api/__tests__/db.test.ts` — update mock sequence for migration 65 (+1 CREATE chains, +1 CREATE legs, +3 CREATE INDEX [2 on chains, 1 on legs], +1 INSERT schema_migrations)
- `api/__tests__/pyramid.test.ts` — NEW. Happy path + auth rejection + validation rejection tests

**Verification:**
- `npm run review` passes (tsc + eslint + prettier + vitest)
- `curl -H "Cookie: owner=..." POST /api/pyramid/chains` creates a chain and returns it
- Non-owner request returns 401

### Phase 2 — Frontend (~9 files, ~3-4 hours)

**Files (all under `src/components/PyramidTracker/`):**
- `PyramidTrackerSection.tsx` — collapsible container, renders children or `null` per env flag
- `ChainList.tsx` — list of prior chains; expand/collapse to show legs; edit/delete buttons
- `ChainCard.tsx` — single chain summary row (date, instrument, net pts, leg count)
- `LegTable.tsx` — nested table of legs within an expanded chain
- `ChainFormModal.tsx` — add/edit chain metadata (direction, day_type, notes, etc.). **All fields optional** except the chain `id` (auto-generated from date + symbol + sequence).
- `LegFormModal.tsx` — add/edit single leg. **All fields optional** — no required-field asterisks, Save button enabled even with partial data. Form indicates completeness with a subtle percentage meter so the user sees how much they've filled before saving.
- `ProgressCounter.tsx` — `N / 30 / 50 / 100` segmented progress bar + day-type breakdown + **per-feature fill rates** (green ≥80%, amber 50-79%, red <50%) + elapsed calendar days
- `ExportCSVButton.tsx` — downloads chains + legs as two CSVs (for pandas import later)
- `index.ts` — barrel export

**Supporting files:**
- `src/hooks/usePyramidData.ts` — NEW. Fetches chains + legs, exposes mutation helpers
- `src/types/pyramid.ts` — NEW. Shared TS types (mirror Zod schemas)
- `src/App.tsx` — add 1 line: `<PyramidTrackerSection />` below the journal section
- `src/__tests__/components/PyramidTracker/*.test.tsx` — tests for ChainList, ProgressCounter, form validation

**Verification:**
- `npm run dev:full` renders the collapsible section
- Expand → click "New chain" → fill form with only `id` set → submit → appears in list (proves optional fields work)
- Expand chain → "Add leg" → fill only `leg_number` and `signal_type` → submit → shows in nested leg table
- Fill in a complete leg (all fields) → save succeeds; edit to clear some fields → save still succeeds
- Progress counter shows chain count, elapsed days, and per-feature fill rates color-coded by band
- Edit chain and leg work and persist after reload
- CSV export produces well-formed files with all columns (null cells as empty strings)
- Owner-only: opening without owner cookie shows auth-required message (not a crash)

### Phase 3 — Documentation + Kill Switch (~2 files, ~30 min)

**Files:**
- `docs/superpowers/specs/pyramid-tracker-2026-04-16.md` — this file (update status to "Implemented")
- Append to `docs/superpowers/plans/` a 10-line **cleanup runbook**: exact DB migration to write, exact files to delete, exact App.tsx line to remove. Future-proof for the case where the hypothesis is discarded.

**Verification:**
- `VITE_PYRAMID_ENABLED=false npm run build && npm run preview` — section does not render
- Cleanup runbook reviewed end-to-end; every step is concrete (file path, line number, migration SQL)

## Files to Create/Modify (Consolidated)

### New files (14)
```
api/_lib/db-pyramid.ts
api/pyramid/chains.ts
api/pyramid/legs.ts
api/pyramid/progress.ts
api/__tests__/pyramid.test.ts
src/components/PyramidTracker/PyramidTrackerSection.tsx
src/components/PyramidTracker/ChainList.tsx
src/components/PyramidTracker/ChainCard.tsx
src/components/PyramidTracker/LegTable.tsx
src/components/PyramidTracker/ChainFormModal.tsx
src/components/PyramidTracker/LegFormModal.tsx
src/components/PyramidTracker/ProgressCounter.tsx
src/components/PyramidTracker/ExportCSVButton.tsx
src/components/PyramidTracker/index.ts
src/hooks/usePyramidData.ts
src/types/pyramid.ts
docs/superpowers/plans/pyramid-tracker-cleanup-runbook.md
```

### Modified files (4)
```
api/_lib/db-migrations.ts           (+ migration id 65)
api/_lib/validation.ts              (+ Zod schemas)
api/__tests__/db.test.ts            (mock sequence update)
src/App.tsx                         (+ 1 import, + 1 render)
```

## Open Questions (Defaults Noted)

1. **Does the "live entry" workflow need WebSocket-style auto-refresh to multi-device sync?**
   **Default: NO.** Owner is the only user, and this is single-device usage by design. SWR-style revalidate-on-focus is sufficient.

2. **Should `stop_compression_ratio` be computed server-side on write, or client-side on read?**
   **Default: server-side on insert.** Ensures it's stored atomically with the leg, so exports and downstream ML always have it. Trigger on INSERT: compute as `stop_distance_pts / leg_1_stop_distance_for_chain`.

3. **Do we pre-populate `session_phase` from `entry_time_ct`, or make user pick it?**
   **Default: pre-populate server-side** using a simple time-range map, but allow user override in the form. Reduces cognitive load during trading.

4. **Should deleted chains be soft-deleted (flagged) or hard-deleted (CASCADE)?**
   **Default: hard delete with CASCADE.** This is experimental data; no audit trail needed. Simpler semantics.

## Out of Scope for This Spec

- ML training pipeline (`ml/src/pyramid_cutoff.py`) — separate spec after N≥30
- Analyze-prompt integration (Claude seeing pyramid data) — separate spec after model proves out
- Multi-instrument regime comparison (ES vs NQ vs CL) — future enhancement
- Historical backfill from TradingView screenshots — out of scope (manual entry only)
- Chart visualization / P&L curve rendering — out of scope; CSV export covers downstream analysis needs

## Verification Plan (Phase-Gated)

After each phase:
1. Run `npm run review` — zero errors
2. Run scoped manual test (curl for Phase 1; browser click-through for Phase 2)
3. Spawn `code-reviewer` subagent to evaluate the phase's diff against this spec
4. Only proceed to next phase if reviewer returns `pass`

## Rollback / Cleanup Runbook (lives in `docs/superpowers/plans/pyramid-tracker-cleanup-runbook.md` after Phase 3)

If the experiment is abandoned:

1. Write cleanup migration:
   ```sql
   DROP TABLE IF EXISTS pyramid_legs;
   DROP TABLE IF EXISTS pyramid_chains;
   ```
2. `rm -rf src/components/PyramidTracker/`
3. `rm -rf api/pyramid/`
4. `rm api/_lib/db-pyramid.ts`
5. `rm src/hooks/usePyramidData.ts src/types/pyramid.ts`
6. `rm api/__tests__/pyramid.test.ts`
7. Remove Zod schemas from `api/_lib/validation.ts`
8. Remove `<PyramidTrackerSection />` + import from `src/App.tsx`
9. Unset `VITE_PYRAMID_ENABLED` from Vercel + `.env.local`
10. `git commit -m "chore: remove pyramid tracker experiment (N={count}, hypothesis not validated)"`

Total cleanup: ~10 minutes.
