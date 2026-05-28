---
status: Spec — pending user approval before implementation plan
date: 2026-05-19
---

# Lottery Finder — Inversion-Quality Filter & Score Bonus

**Date:** 2026-05-19
**Author:** Session — narrowing the daily lottery-finder feed using existing enrichment columns
**Status:** Spec — pending user review before writing-plans
**Predecessors:**

- [lottery-flow-inversion-exit-2026-05-04.md](./lottery-flow-inversion-exit-2026-05-04.md) — added `realized_flow_inversion_pct` to `lottery_finder_fires` as a backfill-only column
- [lottery-flow-inversion-automation-2026-05-05.md](./lottery-flow-inversion-automation-2026-05-05.md) — backfill automation for the column
- [lottery-finder-2026-05-02.md](./lottery-finder-2026-05-02.md) — original tiered-scoring system (Tier 1 ≥18, Tier 2 ≥12) and `lottery_ticker_stats` table

---

## What this is

Ship a **server-side filter + score bonus** that uses the per-ticker historical
`realized_flow_inversion_pct` distribution to suppress the worst-quality
tickers and re-rank the survivors. The single user-facing outcome is going
from ~88 fires/day (≈11 pages) to ~40-50 fires/day (≈4-5 pages), without
losing any high-quality alerts.

**Why now.** `lottery_finder_fires.realized_flow_inversion_pct` and
`lottery_finder_fires.peak_pct` are already populated by the manual nightly
backfill, and `lottery_ticker_stats` already aggregates one statistic
(`high_peak_rate`) per ticker. The data is sitting in the DB unused by the
score — adding a Wilson-bounded ticker-quality metric and folding it into
the score is the smallest change that gets the user out of the 11-page
spam problem.

## What this is NOT

- **NOT a row-level score change.** The fire's OWN `realized_flow_inversion_pct`
  doesn't exist at fire-write time (it's backfilled after hours). The score
  reads a per-ticker AGGREGATE from `lottery_ticker_stats`, which has the
  same latency model as the existing `high_peak_rate` LEFT JOIN.
- **NOT a destructive change to `combined_score`.** The bonus is applied at
  SELECT time as `quality_adjusted_score`. `combined_score` stays as the
  canonical "structural" score (Path A from the brainstorm).
- **NOT a retirement of `LOTTERY_TICKER_WEIGHTS`.** The hardcoded ticker
  bonus stays as-is and is additive with the new inversion-quality bonus.
  Revisit after a few weeks of seeing both signals interact.
- **NOT a per-setup or per-TOD cohort axis.** Ticker-only first. Crossing
  with mode / tags / TOD comes later (or never) based on whether the
  ticker-only signal is enough.
- **NOT a real-time refit.** The user runs the nightly backfill manually
  and confirmed they don't miss days. A Sentry staleness warning is the
  only operational guard.

---

## Goal

> Add a per-ticker Wilson-LCB inversion-quality metric to `lottery_ticker_stats`,
> map it to a quintile-based score bonus (+5/+3/0/-2/-5) added at SELECT time
> as `quality_adjusted_score`, server-side suppress fires whose ticker is in
> the bottom two quintiles (Q1/Q2), re-tune Tier 1/2 cutoffs so daily Tier 1+2
> volume lands at ~40-50, and surface the quintile + LCB on the row as a
> small chip with a tooltip. Include an escape-hatch toggle that bypasses the
> filter via `?showAll=1`.

---

## Thresholds / constants (locked from brainstorm)

| Constant                       | Value                                           | Source                                                                                                |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Win threshold T                | `realized_flow_inversion_pct >= 50%`            | Matches existing `high_peak_rate` framing                                                             |
| Sample-size floor (per window) | N ≥ 10                                          | Same floor used elsewhere in `lottery_ticker_stats`                                                   |
| 21-day window weight           | 0.6                                             | Brainstorm pick — recency                                                                             |
| 90-day window weight           | 0.4                                             | Brainstorm pick — stability                                                                           |
| Bonus shape (Q5→Q1)            | +5 / +3 / 0 / -2 / -5                           | Symmetric, ~10pt swing top-to-bottom                                                                  |
| Quintile filter cut            | Suppress Q1, Q2 (worst ~40% of tickers)         | Server-side, bypassable via `?showAll=1`                                                              |
| Target Tier 1+2 daily volume   | 40-50 fires/day                                 | User pick                                                                                             |
| Tier 1 cutoff (post-bonus)     | `quality_adjusted_score >= 24`                  | Phase 2 CSV — ~22 fires/day in Tier 1                                                                 |
| Tier 2 cutoff (post-bonus)     | `quality_adjusted_score >= 22`                  | Phase 2 CSV — median 52/day Tier 1+2 combined (closest integer to 40-50 target; 23 dropped to 22/day) |
| Staleness warning threshold    | `MAX(lottery_ticker_stats.updated_at) > 3 days` | Operational guard                                                                                     |

---

## Phases

Each phase is independently shippable, ends with a code-reviewer subagent
pass, and the per-phase loop is: **implement → `npm run review` →
code-reviewer subagent → fix findings → commit + push → next phase**.

---

### Phase 1 — DB migration (add columns to `lottery_ticker_stats`)

**Scope:** ~30 minutes. One migration, one test update.

#### Task 1.1 — Migration: add the 6 new columns

- [ ] Add a numbered migration to `api/_lib/db-migrations.ts` (use the
      next available id):
  ```sql
  ALTER TABLE lottery_ticker_stats
    ADD COLUMN IF NOT EXISTS inversion_lcb_21d NUMERIC,
    ADD COLUMN IF NOT EXISTS inversion_lcb_90d NUMERIC,
    ADD COLUMN IF NOT EXISTS inversion_blend NUMERIC,
    ADD COLUMN IF NOT EXISTS inversion_quintile SMALLINT,
    ADD COLUMN IF NOT EXISTS inversion_n_21d INTEGER,
    ADD COLUMN IF NOT EXISTS inversion_n_90d INTEGER;
  ```
- [ ] Migration comment must include: derivation method (Wilson 95% LCB),
      window definitions, sample-size floor, refit cadence.
- [ ] Per-row migration is one atomic `statements()` call.

#### Task 1.2 — Test fixes for `db.test.ts`

- [ ] Add the new migration `{ id: N }` to the applied-migrations mock in
      `api/__tests__/db.test.ts`.
- [ ] Add the migration to the expected-output list.
- [ ] Update SQL call count: +2 (1 ALTER + 1 INSERT INTO schema_migrations).

#### Task 1.3 — Verification

- [ ] `npx vitest run api/__tests__/db.test.ts` passes.
- [ ] `npm run review` clean.

#### Task 1.4 — Code review (mandatory)

- [ ] Launch `code-reviewer` subagent on the diff.
- [ ] Resolve any `continue` feedback before commit. On `refactor`, restart
      the phase from scratch with the reviewer's notes.
- [ ] Commit and push directly to main (per `feedback_direct_to_main`),
      then move to Phase 2.

---

### Phase 2 — ML refit extension + tune-before-ship CSV

**Scope:** ~2-3 hours. Python script changes + a single manual run + CSV
inspection to lock the tier cutoffs.

#### Task 2.1 — Extend the nightly backfill script

Identify the existing manual nightly script (likely under `ml/` or
`scripts/`; see `lottery-flow-inversion-automation-2026-05-05.md` for the
predecessor wiring). Extend it with a final stage that:

- [ ] Queries `lottery_finder_fires` for the trailing 90 days with
      `realized_flow_inversion_pct IS NOT NULL`.
- [ ] For each ticker, computes the 21d and 90d Wilson 95% LCB on
      `P(realized_flow_inversion_pct >= 50%)`. Wilson formula uses
      `z = 1.96`. Skip windows with N < 10 (column written as NULL).
- [ ] Computes `inversion_blend = 0.6 * lcb_21d + 0.4 * lcb_90d` when both
      windows have N≥10; falls back to the populated window if only one
      qualifies; NULL when neither does.
- [ ] Computes quintile cuts across the ticker universe using only the
      non-NULL `inversion_blend` values. Tickers with NULL blend get NULL
      quintile.
- [ ] UPSERTs all 6 columns into `lottery_ticker_stats`, batched 500 rows
      per query (per `feedback_batched_inserts`).
- [ ] Gated by `WRITE_DB=1` env var (mirrors the predecessor script's
      pattern).
- [ ] Print summary: ticker count per quintile, NULL count, oldest/newest
      `fired_at` in the window.

#### Task 2.2 — Tune-before-ship CSV

Same script also writes a one-shot simulation CSV to `docs/tmp/lottery-quality-sim-2026-05-19.csv`:

- [ ] For every fire in the last 90 days (regardless of NULL inversion
      status), compute:
  - The ticker's proposed `inversion_quintile` (from the just-computed
    stats, or NULL).
  - `quality_adjusted_score = combined_score + inversion_bonus`, where
    bonus = lookup(quintile) per the table above (NULL quintile → 0
    bonus, i.e. cold-start tickers are not penalized).
  - A flag `would_be_filtered = (quintile IN (1, 2))`.
- [ ] CSV columns: `fire_id, ticker, fired_at, combined_score, quintile,
    bonus, quality_adjusted_score, would_be_filtered`.
- [ ] Script prints a summary table: for candidate Tier 1 cutoffs
      `[20, 21, 22, 23, 24]` and Tier 2 cutoffs `[14, 15, 16, 17]`, show
      median daily Tier 1+2 count after filtering. We pick the cutoffs
      whose median lands in [40, 50].

#### Task 2.3 — Tests for the refit script

- [ ] Python tests for the Wilson LCB calculation under `ml/tests/` —
      include edge cases: N=0, N=1, N=10 (exactly the floor), all wins,
      no wins.
- [ ] Python test for the blend formula (both windows present, only 21d,
      only 90d, neither).
- [ ] Python test for the quintile-cut function on a synthetic ticker
      universe.

#### Task 2.4 — Verification

- [ ] Run the refit manually with `WRITE_DB=1`.
- [ ] `SELECT inversion_quintile, COUNT(*) FROM lottery_ticker_stats GROUP BY 1`
      shows a reasonable distribution (quintiles 1-5 with similar counts
      among the non-NULL bucket).
- [ ] Open the CSV in pandas / Excel and confirm the median daily Tier 1+2
      count at the chosen cutoffs lands in [40, 50].
- [ ] **Write the chosen cutoffs into this spec under
      "Thresholds / constants" before starting Phase 3.** Do NOT proceed
      with TBD values.

#### Task 2.5 — Code review (mandatory)

- [ ] `code-reviewer` subagent on the ml/ diff + the CSV simulation
      output.
- [ ] Commit + push, then Phase 3.

---

### Phase 3 — API: read the metric, score, filter

**Scope:** ~2 hours. One endpoint module, one new lib, full test coverage.

#### Task 3.1 — Extend `lottery-ticker-stats` row shape

- [ ] In `api/lottery-finder.ts`, extend the row interface and the SELECT
      to pull the new columns:
  ```sql
  s.inversion_blend AS ticker_inversion_blend,
  s.inversion_quintile AS ticker_inversion_quintile,
  s.inversion_n_21d AS ticker_inversion_n_21d,
  s.inversion_n_90d AS ticker_inversion_n_90d
  ```
  Apply to **all four SELECTs** in the file (lines 441, 516, 590, 879
  per the current code).

#### Task 3.2 — New module `api/_lib/lottery-inversion-bonus.ts`

- [ ] Pure-function module:
  ```ts
  export function inversionQualityBonus(quintile: number | null): number;
  export function qualityAdjustedScore(
    combinedScore: number,
    quintile: number | null,
  ): number;
  export const INVERSION_BONUS_BY_QUINTILE: Readonly<Record<number, number>> = {
    1: -5,
    2: -2,
    3: 0,
    4: 3,
    5: 5,
  };
  ```
- [ ] NULL quintile → bonus 0 (cold-start tickers are neutral).
- [ ] Full unit test coverage in `api/__tests__/lottery-inversion-bonus.test.ts`:
      every quintile, NULL, out-of-range values (defensive: 0 / 6 → 0).

#### Task 3.3 — New module `api/_lib/lottery-tier.ts`

- [ ] Move tier classification out of `lottery-score-weights.ts` and into
      a new module that takes `qualityAdjustedScore` as input:
  ```ts
  export const TIER_CUTOFFS_V2 = {
    tier1MinScore: <FROM_PHASE_2>,
    tier2MinScore: <FROM_PHASE_2>,
  } as const;
  export function tierFromQualityScore(score: number | null): LotteryScoreTier;
  ```
- [ ] `lotteryScoreTier()` in `lottery-score-weights.ts` is kept as a
      deprecated re-export for any external caller, but the lottery
      endpoint switches to `tierFromQualityScore`.
- [ ] Unit tests covering boundary values (`tier1MinScore - 1`,
      `tier1MinScore`, `tier2MinScore`, `tier2MinScore - 1`, NULL).

#### Task 3.4 — Filter + serialize

- [ ] Add `showAll` to `api/_lib/validation.ts` query schema for the
      lottery endpoint: `z.coerce.boolean().optional().default(false)`.
- [ ] In `api/lottery-finder.ts`, after computing per-row
      `qualityAdjustedScore` and `tier`, filter:
  ```ts
  const filtered = showAll
    ? rows
    : rows.filter(
        (r) =>
          r.tickerInversionQuintile == null || r.tickerInversionQuintile > 2,
      );
  ```
- [ ] Serialize new fields on the response row:
  - `qualityAdjustedScore: number`
  - `inversionQuintile: number | null`
  - `inversionBlend: number | null`
  - `inversionN21d: number | null`
  - `inversionN90d: number | null`
  - Update the existing `tier` field to be derived from
    `qualityAdjustedScore`.

#### Task 3.5 — Test fixes & coverage updates

- [ ] Update existing tests in `api/__tests__/lottery-finder.*.test.ts`
      (if any exist) for the new row shape and the filter behavior.
- [ ] Add new tests:
  - Filter suppresses Q1/Q2 by default
  - `?showAll=1` returns all rows including Q1/Q2
  - NULL quintile rows are NEVER filtered (cold-start protection)
  - `qualityAdjustedScore` matches the additive formula
  - `tier` matches `tierFromQualityScore(qualityAdjustedScore)`
- [ ] Coverage gate: every new function in `lottery-inversion-bonus.ts`
      and `lottery-tier.ts` has ≥1 test per branch.

#### Task 3.6 — Verification

- [ ] `npm run review` clean (tsc + eslint + prettier + vitest --coverage).
- [ ] Hit the dev endpoint and confirm fire count drops to ~40-50/day on a
      typical historical day (use `?since=<date>` if the endpoint
      supports it; otherwise just eyeball).
- [ ] Hit `?showAll=1` and confirm the full ~88/day universe comes back.

#### Task 3.7 — Code review (mandatory)

- [ ] `code-reviewer` subagent on the diff.
- [ ] Resolve `continue` feedback; on `refactor`, revert and restart.
- [ ] Commit + push, then Phase 4.

---

### Phase 4 — Frontend: chip, tooltip, escape-hatch toggle

**Scope:** ~1.5-2 hours. One row component, one new badge, one toggle.

#### Task 4.1 — Tier badge consumes `qualityAdjustedScore`

- [ ] In whichever frontend component renders the lottery tier pill
      (likely `src/components/LotteryFinder/` — confirm during impl),
      rename the prop / input so the badge derives its tier from the new
      field.
- [ ] Visual rendering unchanged — same colors, same labels, just a new
      numeric input.

#### Task 4.2 — Inversion-quality chip

- [ ] Add a small chip near the tier pill that renders `Q1`-`Q5` (or
      `Q?` when NULL).
- [ ] Color: muted gray for NULL/Q3, red-ish for Q1, amber for Q2,
      neutral for Q3, green-ish for Q4, strong green for Q5. Re-use
      existing Tailwind palette in the row.
- [ ] Hidden on the row when `inversionQuintile == null` AND the row
      has no `inversionBlend` (truly cold-start).

#### Task 4.3 — Tooltip

- [ ] On hover (or focus, for keyboard a11y), tooltip shows:
  ```
  Inversion-win rate: 62% (Wilson 95% LCB)
  Sample: n=34 (21d) / n=121 (90d)
  ```
- [ ] Numbers formatted as percentages with one decimal.
- [ ] Re-use the existing tooltip primitive in the project — do not
      introduce a new dependency.

#### Task 4.4 — Escape-hatch toggle

- [ ] Add "Show filtered tickers" toggle near the existing exit-policy
      chip selector.
- [ ] Off by default. When on, append `?showAll=1` to the data-fetch
      call.
- [ ] Toggle state persisted in `useAppState` (not localStorage) — flips
      back off on reload, intentional.

#### Task 4.5 — Test fixes & coverage updates

- [ ] Update existing component tests for the new prop / chip / tooltip.
- [ ] Add Playwright spec at `e2e/lottery-inversion-filter.spec.ts`:
  - Chip renders on rows with quintile
  - Tooltip shows on hover with expected text format
  - Toggle off: bottom-quintile tickers not present
  - Toggle on: bottom-quintile tickers visible
- [ ] axe-core check on the new chip + toggle for accessibility.

#### Task 4.6 — Verification

- [ ] `npm run review` clean.
- [ ] `npm run test:e2e -- lottery-inversion-filter` passes.
- [ ] Manual smoke in `npm run dev`: load lottery feed, confirm chip
      visible, tooltip on hover, toggle bypasses the filter.

#### Task 4.7 — Code review (mandatory)

- [ ] `code-reviewer` subagent on the diff.
- [ ] Commit + push, then Phase 5.

---

### Phase 5 — Operational guard (Sentry staleness warning)

**Scope:** ~20 minutes. One conditional capture in an existing cron handler.

#### Task 5.1 — Add staleness check

- [ ] In an existing daily cron (e.g. the first cron that runs each
      trading morning), add a check:
  ```ts
  const ageDays = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) / 86400 AS days
    FROM lottery_ticker_stats`;
  if (ageDays > 3)
    Sentry.captureMessage('lottery_ticker_stats stale', {
      level: 'warning',
      extra: { ageDays },
    });
  ```
- [ ] Pick the host cron so it runs once per market morning, not on
      every fetch tick (avoid alert spam).

#### Task 5.2 — Verification + review

- [ ] Unit test: mock `updated_at`, confirm captureMessage fires when
      stale and is silent when fresh.
- [ ] `npm run review` clean.
- [ ] `code-reviewer` subagent on the diff.
- [ ] Commit + push.

---

## Test coverage summary (rolled up)

| Area                                   | New tests                                                     |
| -------------------------------------- | ------------------------------------------------------------- |
| `db.test.ts`                           | Migration mock + call count                                   |
| `ml/tests/`                            | Wilson LCB, blend, quintile-cut (Python)                      |
| `lottery-inversion-bonus.test.ts`      | Every quintile + NULL + out-of-range                          |
| `lottery-tier.test.ts`                 | Boundary values + NULL                                        |
| `lottery-finder.*.test.ts`             | Row shape + Q1/Q2 filter + `?showAll=1` + NULL never-filtered |
| Frontend component tests               | Chip render + tooltip + toggle                                |
| `e2e/lottery-inversion-filter.spec.ts` | End-to-end filter + toggle behavior + axe-core                |

Every phase ends with `npm run review` (which includes vitest --coverage)
clean before a code-reviewer subagent runs.

---

## Files to create

- `docs/superpowers/specs/lottery-inversion-quality-filter-2026-05-19.md` (this file)
- `api/_lib/lottery-inversion-bonus.ts`
- `api/_lib/lottery-tier.ts`
- `api/__tests__/lottery-inversion-bonus.test.ts`
- `api/__tests__/lottery-tier.test.ts`
- `e2e/lottery-inversion-filter.spec.ts`
- New Python test files under `ml/tests/`
- `docs/tmp/lottery-quality-sim-2026-05-19.csv` (Phase 2 output — not committed)

## Files to modify

- `api/_lib/db-migrations.ts` (Phase 1)
- `api/__tests__/db.test.ts` (Phase 1)
- The existing manual nightly backfill script (Phase 2 — identify during impl)
- `api/lottery-finder.ts` (Phase 3 — SELECTs, row shape, filter, serialize)
- `api/_lib/validation.ts` (Phase 3 — `showAll` query param)
- `api/_lib/lottery-score-weights.ts` (Phase 3 — re-export deprecation note)
- The frontend lottery row component(s) under `src/components/` (Phase 4)
- One existing cron handler (Phase 5 — staleness warning host)

## Data dependencies

- `lottery_finder_fires.realized_flow_inversion_pct` (already exists,
  backfilled nightly)
- `lottery_ticker_stats` (already exists with `high_peak_rate`; gains 6 new
  columns in Phase 1)

## Open questions

- **Tier cutoffs are TBD until Phase 2 runs.** Hard-locked from the CSV;
  do not proceed past Phase 2 with placeholder values. Update this spec's
  "Thresholds / constants" table before starting Phase 3.
- **Which existing manual nightly script gets extended?** Likely the one
  introduced by `lottery-flow-inversion-automation-2026-05-05.md` —
  confirm during Phase 2 task 2.1.
- **Which cron hosts the staleness check?** Pick during Phase 5 — needs
  to run once per trading morning, not every 5 minutes.
