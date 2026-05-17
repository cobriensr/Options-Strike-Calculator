---
status: Likely Shipped
date: 2026-05-04
---

# Lottery Flow-Inversion Exit Policy

**Date:** 2026-05-04
**Author:** Session continuation from lottery-net-flow-eda
**Status:** Spec — pending user approval before implementation
**Predecessor:** [lottery-net-flow-eda-2026-05-03.md](./lottery-net-flow-eda-2026-05-03.md) — Phase 2 EDA found flow-inversion exit beats trail-30/10 by +9.8pp mean (after costs) with 5x lottery rate

---

## What this is

Ship the **flow-inversion exit policy** as a fourth option in the LotteryRow exit-policy selector, alongside the existing `realizedTrail30_10Pct`, `realizedHard30mPct`, and `realizedTier50HoldEodPct`. The policy was validated in `ml/experiments/lottery-net-flow-eda/exit_simulation.py` against per-minute NBBO mid prices on the 15-day parquet window — concentrated edge confirmed.

## What this is NOT

- **Not a default change.** Trail-30/10 stays the default policy. Inversion is opt-in via the chip selector.
- **Not a live enrichment cron.** Existing `realized_*` columns are also backfill-only — we follow the same pattern.
- **Not an automated trade execution.** Display-only realized %; the user still trades manually.

---

## Goal

> Add `realizedFlowInversionPct` as a selectable exit policy in the Lottery Finder UI, populated from the parquet-window simulation, so the user can stratify the lottery feed by flow-inversion outcomes the same way they currently do by trail-30/10 outcomes.

---

## Phases

### Phase 1 — Backend: schema + backfill

#### Task 1.1 — Migration #123: add `realized_flow_inversion_pct`

- [ ] Add migration to `api/_lib/db-migrations.ts`:
  ```sql
  ALTER TABLE lottery_finder_fires
    ADD COLUMN IF NOT EXISTS realized_flow_inversion_pct NUMERIC;
  ```
- [ ] Update `api/__tests__/db.test.ts`: applied-migrations mock, expected output, SQL call count (+2: 1 ALTER + 1 INSERT INTO schema_migrations).
- **Verify:** `npx vitest run api/__tests__/db.test.ts` passes.

#### Task 1.2 — Extend `exit_simulation.py` to write back to DB

User's workflow (confirmed 2026-05-04): manual run after each new parquet
drops. Architecture choice: extend the existing simulation script to ALSO
issue batched UPDATEs against `lottery_finder_fires` after writing the
parquet — one Python command does everything. Matches the existing
`backfill-lottery-fires.mjs` "single user-invoked command" idiom.

- [ ] In `ml/experiments/lottery-net-flow-eda/exit_simulation.py`, add a
      final stage that opens a psycopg2 connection and runs batched UPDATEs:
  ```sql
  UPDATE lottery_finder_fires AS f
  SET realized_flow_inversion_pct = u.pct
  FROM (
    SELECT unnest(%(ids)s::bigint[]) AS id,
           unnest(%(pcts)s::numeric[]) AS pct
  ) u
  WHERE f.id = u.id
  ```
  500 rows / batch (per `feedback_batched_inserts`).
- [ ] Gated by `WRITE_DB=1` env var so re-running the script for analysis
      doesn't accidentally clobber values.
- [ ] Print summary: rows attempted, rows updated.
- **Verify:** After running with `WRITE_DB=1`,
  `SELECT COUNT(*) FROM lottery_finder_fires WHERE realized_flow_inversion_pct IS NOT NULL`
  matches the parquet row count (~47,658).

### Phase 2 — API: serialize the new column

#### Task 2.1 — Update `api/_lib/lottery-finder.ts` row shape

- [ ] Add `realized_flow_inversion_pct: DbNullableNumeric` to the row interface
- [ ] Include the column in the SELECT
- [ ] Map to `realizedFlowInversionPct` in the response transformer (`num()` coercion)

#### Task 2.2 — Update `api/lottery-finder.ts` serialization

- [ ] Same shape changes as above (the file is the endpoint)
- [ ] Include in response `outcomes` payload

### Phase 3 — Frontend: type + selector

#### Task 3.1 — Update `src/components/LotteryFinder/types.ts`

- [ ] Add `'realizedFlowInversionPct'` to the ExitPolicy union
- [ ] Add label `'flow-inversion'` to `EXIT_POLICY_LABELS`
- [ ] Add tooltip to `EXIT_POLICY_TOOLTIPS`:
  > "Exit when matched-side ticker net flow slope flips negative for ≥3 consecutive minutes after the post-trigger flow peak. Validated against trail-30/10 in 47k-fire simulation: +9.8pp mean uplift (after costs), 5x lottery rate (6.7% vs 1.3%), at the cost of more small losses (44.5% win rate vs 55.8%). Real edge concentrates on momentum-news days × call fires × AM/MID."
- [ ] Add `realizedFlowInversionPct: number | null` to the LotteryFire outcomes interface

#### Task 3.2 — Update `LotteryFinderSection.tsx` selector

- [ ] Add `'realizedFlowInversionPct'` to `EXIT_POLICIES` array (4th option)
- [ ] No other changes — the chip rendering loop handles arbitrary count

#### Task 3.3 — Verify LotteryRow already handles it

- [ ] LotteryRow reads `fire.outcomes[exitPolicy]` — already type-safe via the union extension. No code change needed beyond the type update propagating.

### Phase 4 — Validation

- [ ] `npm run review` clean (tsc + eslint + prettier + vitest --coverage)
- [ ] Visual check in dev: chip selector shows 4 options; selecting flow-inversion shows non-null values for fires in the 15-day window, null/`—` for fires outside
- [ ] Code-reviewer subagent verdict: pass

---

## Files to create / modify

### Create

- `scripts/backfill-flow-inversion-exit.mjs`
- `docs/superpowers/specs/lottery-flow-inversion-exit-2026-05-04.md` (this file)

### Modify

- `api/_lib/db-migrations.ts` (migration #123)
- `api/__tests__/db.test.ts` (mock counts + applied list)
- `api/_lib/lottery-finder.ts` (row interface + SELECT)
- `api/lottery-finder.ts` (serialization)
- `src/components/LotteryFinder/types.ts` (ExitPolicy + labels + tooltip + outcome interface)
- `src/components/LotteryFinder/LotteryFinderSection.tsx` (EXIT_POLICIES array)

### Not modified

- `LotteryRow.tsx` — generic `fire.outcomes[exitPolicy]` indexer handles it transparently
- The simulation script — already produces the parquet we'll read back from

---

## Open questions

1. **Periodic refresh.** The simulation reads the parquet archive (15 days). For new fires that arrive via live cron, `realized_flow_inversion_pct` will stay NULL until either (a) the next parquet drop or (b) we add a daemon-data simulation path. Both are out of scope for this spec — same constraint as the existing `realized_*` columns. Worth flagging in a future spec if the user wants live inversion outcomes.

2. **Cost-net vs gross display.** The simulation report shows two columns (`inversion_pct` gross and `inversion_net_pct` after costs). The DB column will store gross (matches existing realized\_\* convention). User can still mentally subtract their estimated frictions in the UI. Confirm this is the right call.

---

## Done when

- [ ] Migration #123 deployed to Neon
- [ ] `realized_flow_inversion_pct` populated for all parquet-window fires
- [ ] UI shows 4 exit-policy chips
- [ ] Selecting "flow-inversion" surfaces the new realized% in LotteryRow
- [ ] No regressions on the 3 existing policies

---

## Notes

- This is the first new column on `lottery_finder_fires` since the table shipped. Migration is additive (`ADD COLUMN IF NOT EXISTS`) so backwards-compatible — old code reading the table is unaffected.
- The simulation parquet is the source of truth for the populated values. Re-running the simulation regenerates the parquet, then the backfill script writes them back — keeps the data lineage clear.
