# Retire the Lottery Finder fire-count score adjustment

**Goal:** stop adding the per-chain fire-count bucket (−3 / −1 / 0 / +1 / +2) to the Lottery Finder's quality score. It rewards contracts for re-firing, but entering at a re-fire has no edge, and in stored history it is hindsight.

**Owner decision:** 2026-11-15, "yeah thats fine", after the re-fire study.

## Why

The evidence is in `docs/tmp/refire-study-2026-11-15/REPORT.md` (main checkout, gitignored). The main session re-checked the key numbers against production.

- **Re-fires are worse entries.** Realized trail 30/10 by each fire's true sequence (row number by trigger time):

  | Fire | Mean per fire |
  |---|---|
  | 1st | −1.0% |
  | 2nd–5th | −1.7% |
  | 6th–20th | −2.3% |
  | 21st+ | −1.9% |

  Day-clustered CIs exclude 0 for 2–5 and 6–20. So the adjustment penalizes the better entries (a chain's first fire gets −3) and boosts the worse ones.
- **Its support was hindsight.** The "more fires = better" evidence came from each chain-day's *final* count. First fires on chains that end with 8–15 fires average +4.4%, but entering at the 8th fire averages −1.8%.
- **Stored history is hindsight too.** The migration #167 trigger (`update_lottery_fire_count_score_adj`) rewrites the adjustment on every row of the chain-day when the count reaches 1, 2, 4, 8 or 16. So each stored early fire carries the final day's bucket: it matches on 99.8% of rows, against 49.2% for the count so far.
- **Removing it does no harm at entry.** Entering each chain when it first reaches the tier, June–November with the 24 replay-corrupted days excluded:

  | Entry at first reaching | Rule | Entries | Mean | Exits > 0 | Entered at fire no. |
  |---|---|---|---|---|---|
  | Score ≥ 13 | old | 4,025 | −0.51% | 69.8% | 4.1 |
  | Score ≥ 13 | new | 5,389 | −0.50% | 68.8% | 2.7 |
  | Score ≥ 10 | old | 7,639 | −0.78% | 67.7% | 3.5 |
  | Score ≥ 10 | new | 9,792 | +0.44% | 67.8% | 2.4 |

  No CIs were computed. Read tier 1 as unchanged and tier 1+2 as suggestive.
- **Expected feed effect** (last 30 live days, chains before the default chips):
  - tier 1 goes from about 12.0 to 16.5 chains a day, and tier 1+2 from 28.9 to 36.6;
  - about 17 chains a day move up a tier and about 5 move down.

## Phases

Each phase is at most 5 files, and each commit passes `npm run review` on its own.

**Phase 1: the API stops using the adjustment** (score SQL, mapper, response field)
- `api/lottery-finder.ts`:
  - the `qasExprText` term (~:335-378);
  - the select lists (~:756, :805, :1166);
  - the mapper (~:1402-1428);
  - the `fireCountScoreAdjustment` response field (~:1546).
- `api/lottery-finder-ticker-counts.ts`: its qas copy (~:173, :211, :237).
- `api/__tests__/lottery-finder-endpoint.test.ts` and `api/__tests__/lottery-finder-ticker-counts.test.ts`.

**Phase 2: the detector's feed-tier monitor stops using it**
- `api/cron/detect-lottery-fires.ts` (~:1316-1351). The monitor's qas must keep mirroring the feed exactly; that is its purpose.
- `api/__tests__/detect-lottery-fires.test.ts`.

**Phase 3: types, helpers, chips and comments**
- `src/components/LotteryFinder/types.ts`: drop `fireCountScoreAdjustment` and its docblock.
- Any remaining `fireCountScoreAdjustment` helper in `api/_lib/lottery-score-weights.ts`, plus its test.
- `api/_lib/constants.ts` ~:402: the comment.
- `src/components/LotteryFinder/index.tsx` ~:225-252: **keep** the ×≥3 / ×≥8 / ×≥16 chips, since they're fire-count-so-far filters and the count is still informative to see.
  - Rewrite their tooltips as descriptive. Drop the hindsight edge claims ("mean −5.8% on singletons", "94% win… Recommended day-to-day filter", "median best peak 127%").
  - Say plainly that entering on a later fire showed no edge over the first (re-fire study, 2026-11-15).

**Phase 4: ML and script readers**
- `ml/src/lottery_refit_gates.py` (~:104, :237, :255) and `ml/tests/test_lottery_refit_gates.py`: drop the column from the qas they compute.
- `scripts/feature_audit.py` (Makefile target): same.
- The dated one-off analysis scripts (`scripts/_probe-lf-tags.ts`, `scripts/analyze-tag-scorecard-2026-05-29.ts`, `scripts/walk_forward_backtest_v22_corrected.py`) and the historical `scripts/apply-migration*.sql`:
  - leave the `.sql` files alone, since they're a record of what was applied;
  - for the three scripts, drop the column from their qas if trivial; otherwise add a one-line header noting the column was retired on 2026-11-15. Stay within 5 files per commit.

**Phase 5: migration #209**, in `api/_lib/db-migrations.ts` and `api/__tests__/db.test.ts`. One `statements:` migration (one transaction). Steps 0 and 7 were added in review: the view `lottery_finder_fires_with_outcome` (#177, `SELECT * FROM lottery_finder_fires`) depends on both columns we drop, so without them the DROP COLUMNs fail with "view … depends on it".
- Before the steps: `SET LOCAL lock_timeout = '5s'`, as #194–#208 do, so a wait for the ACCESS EXCLUSIVE lock behind a running detect-cron insert fails fast and rolls back instead of queueing.
0. `DROP VIEW IF EXISTS lottery_finder_fires_with_outcome`
1. `DROP TRIGGER IF EXISTS lottery_finder_fires_fc_adj_trg ON lottery_finder_fires`
2. `DROP FUNCTION IF EXISTS update_lottery_fire_count_score_adj()`
3. `ALTER TABLE lottery_finder_fires DROP COLUMN IF EXISTS combined_score`. The column is a generated column that references the one we drop.
4. `ALTER TABLE lottery_finder_fires DROP COLUMN IF EXISTS fire_count_score_adjustment`
5. Recreate `combined_score` exactly as migration #168 defines it, minus the fire-count term:
   `GREATEST(0, COALESCE(score,0) + COALESCE(round_trip_score_deduct,0) + CASE … gamma … END)`.
   Copy #168's CASE verbatim.
6. Recreate `lottery_finder_fires_combined_score_idx ON lottery_finder_fires (date DESC, combined_score DESC NULLS LAST)`.
7. `CREATE OR REPLACE VIEW lottery_finder_fires_with_outcome` with #177's exact text. Its `SELECT *` is expanded again, so the view now also carries the columns added since #177 (the live view stops at `spot_at_trigger`) and has no `fire_count_score_adjustment`. Nothing in the code reads the view.

Plus the `db.test.ts` updates per CLAUDE.md "DB Migrations": the applied-ids mock, the expected-output list, the mockSql and mockSql.transaction totals, and the breakdown comments.

**Phase 6: docs**
- This spec, committed with phase 1.
- In `docs/superpowers/specs/`, any doc that describes the adjustment as live gets a one-line "Retired 2026-11-15" note. Don't rewrite history.

## Data dependencies
- The migration rewrites `lottery_finder_fires` (about 1.1M rows), because dropping and re-adding a STORED generated column rewrites the table. The table is locked meanwhile, and the detect cron writes to it every minute during market hours.
- **Apply it on a weekend or after the close only**, right after the deploy, via `/api/journal/migrate`. That needs the owner's explicit go at apply time.
- Production has applied every migration through #208 (checked 2026-11-15), so a migrate run applies only #209, unless another session lands one first. **Recheck that at apply time.**
- **Deploy first. That is a hard requirement.**
  - The new code does not read `combined_score` or `fire_count_score_adjustment` at runtime: the feed sorts on `f.score` (`LOTTERY_FEED_ORDER_BY`), and the qas is computed from `score` and `round_trip_score_deduct`.
  - So with the code deployed and #209 not yet applied, nothing misbehaves: the #167 trigger keeps writing a column nobody reads.
  - Applying #209 BEFORE the deploy breaks the old code, which still selects `fire_count_score_adjustment`. The feed, the chip strip and the detector's tier monitor would all fail with Postgres error 42703 (undefined column).
  - There is therefore no deploy-to-migration window to keep short. Only the apply itself needs the weekend or after-close slot.

## Open questions (defaults picked)
- **Tier cutoffs** stay at 13/10. The default: the entry test above shows no quality loss at 13. Re-tune later only from a realized-outcome study on true first-tier entries.
- **Hot badge** (`LotteryFinderTickerGroup.tsx:328`, "≥8 fires OR ≥20 re-triggers OR ≥$500K"): out of scope. It's descriptive, not part of the score.
- **Take-It sequence features** (`alert_seq` and friends) and the 24 replay-corrupted days: separate items, not in this change.

## Constants
- The retired buckets are count 1 → −3, 2–3 → −1, 4–7 → 0, 8–15 → +1, 16+ → +2.
- The tier cutoffs stay at 13 and 10 (`api/_lib/lottery-tier.ts`).

## Implementation notes (2026-11-15, branch `fix/retire-fire-count-adj`)
Code, tests and the migration are written and deployed.

**Applied to production 2026-11-16 at about 07:02 UTC** (owner's go). It ran through `scripts/migrate-db.ts`, not the endpoint, because the endpoint is held to Vercel's 300 s limit.
- Production was at #208 beforehand.
- The rewrite took 67 s, and the table shrank from 2,986 MB to 2,156 MB.
- **Checked after:**
  - the trigger, the function and `fire_count_score_adjustment` are gone;
  - `combined_score` matches the new formula on all 1,111,476 rows;
  - the view and the index are back;
  - `/api/lottery-finder` and `/api/lottery-finder-ticker-counts` return 200.
- **Backup:** the dropped values (id, `fire_count_score_adjustment`, old `combined_score`) are in the main checkout's `docs/tmp/fire-count-retire-209/`, which is gitignored.
- **One qas, three places.** The feed (`qasExprText`), the chip strip and the detector's tier monitor each hold their own copy of the expression. `api/__tests__/lottery-qas-sql.ts` writes it once, and the three tests assert their captured SQL contains it (whitespace ignored), so one cannot change without the other two failing.
- **The score no longer depends on fire count.** The old bucket-ladder tests are replaced by a table over fire counts 1, 2, 3, 4, 7, 8, 15, 16, 20 and 21 on one row, all giving the same score, qas and tier, plus a same-row-at-1-and-20 test.
- **The ML mirror reads the TS source.** `ml/tests/test_lottery_refit_gates.py::test_feed_qas_mirrors_the_feeds_displayed_score_sql` parses `qasExprText` out of `api/lottery-finder.ts`, so it is red between the Phase 1 commit and the Phase 4 commit and green after both.
- **Phase 4 scripts.** `scripts/feature_audit.py` reads `combined_score`, so it follows #209 on its own; only its comment changed. The other three dated scripts query the stored column to measure the tag itself, so they got a one-line retirement header and will not run after #209.
- **Migration #209** has the statements above, in that order: the lock timeout, the view drop, steps 1–6, then the view recreate. The lock timeout bounds the wait for the lock, not the rewrite. `api/__tests__/migration-209-pglite.test.ts` replays #110, 124, 126, 134, 154, 158, 167, 168, 177 and 178, seeds rows the #167 trigger scored, applies #209, and checks the trigger, function and column are gone, the same inputs score the same at one fire and at sixteen, the view still serves `outcome_pct` and `is_aligned`, and the gamma CASE and the view text are #168's and #177's.
- **The view blocked the first version.** The first draft of #209 had no view steps and could not apply: the review reproduced the "view … depends on it" error in pglite, and read-only `pg_depend` on production showed the view as the table's only dependent object.
- **Nightly:** no file this change touches is one of the ten Nightly watch paths, so there is no push-time constraint from it.
