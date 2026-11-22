# Feature snapshot pick: skip rows that can't be trusted

## Goal

`build-features` reads each date's static features (VIX family, regime, SPX
open, sigma, ceilings, opening range) from one `market_snapshots` row: the one
nearest 10:00 AM CT (`pickFeatureSnapshot`, `api/cron/build-features.ts:141`).
Some rows hold values from a different time or a different day than their slot.
The pick must skip those rows, so training_features carry the real 10:00 view
or nothing. A day with nothing must not train.

## Why

On 2026-11-22 a rebuild of seven dates picked bad rows on two of them, and
both were restored from the backup the same night:

- **07-15** picked row 4869, a "10:00 AM" row saved on a later day at about
  10:00. That is a browser tab left open on an old date, saving the live quote
  under the old date's slot. The real 9:50 row (4795, VIX 15.81) was skipped.
- **03-27** picked row 359, a placeholder with SPX 5720 and VIX 19, saved
  before its own date.

Profiling all 10,629 rows found these classes. The analysis is in
`docs/tmp/feature-pick-vetting/` (`profile.out`, `candidate-T10-L10.out`,
`variants-strict.out`, `variants-v4.out`, `nopick-stored.out`).

- 119 stale-tab rows: saved on a later day, at the slot's own clock time
  (within 10 minutes).
- 35 placeholder rows (SPX 5720 / VIX 19).
- Same-day catch-up rows. On 03-26, rows for 9:00 to 9:55 were saved between
  10:36 and 11:26 and all hold about the same quote (SPX 6540, VIX 26.96).
- Rows saved before their slot or before their date.
- Upsert overwrites. `saveSnapshot` keeps the first `created_at` and replaces
  the values (`api/_lib/db-snapshots.ts`, around 184–238). Row 367 (03-27
  10:10) looks on time but holds an SPX about 40 points below the day's low as
  of 10:10.

`is_backtest` alone can't tell these apart: it is inverted on rows saved before
2026-10-28.

## Owner decisions

- **2026-11-21, "B is fine":** change the pick to skip suspect rows: rows
  saved on a different day or long after their slot, and rows whose SPX is
  outside the day's high/low.
  - **The narrowing.** The rule here keeps a later-day save unless it was
    made at the slot's own clock time. Dropping every later-day save would
    throw away about 5,700 good replay rows.
  - The owner was told this in the 2026-11-22 message that asked decision A,
    and didn't object.
- **2026-11-22, "A":** on a day with no trustworthy row within an hour of
  10:00, write no snapshot features.
  - Rejected: B, take the nearest trustworthy row however late (03-27 → its
    1:45 PM row). It leaks most of the day into the 10:00 view.
  - Rejected: C, keep today's rule on those days. It can land on junk again.
- **2026-11-22 00:40 CT, "yeah": blank all 28 no-pick dates** (see "What the
  28 dates store now").
  - Their stored snapshot features came mostly from rows this rule rejects.
  - The blanking is a one-off run with a backup, and it needs the owner's OK
    on the run itself.

## The rule

A row is **trusted** when every test below passes. The pick is the existing
nearest-to-10:00 rule over trusted rows only: trusted rows with a usable
`spx_open` first, then any trusted row. When no row is trusted, the pick is
none. The `rows[0]` fallback goes.

Definitions:
- `slot` = `parseEntryTimeMinutes(entry_time)` (CT minutes).
- `offset` = the save's CT calendar day minus the row's `date`, in days.
- `saved` = the save's CT clock time in minutes.

| # | Test | Rejection reason |
|---|------|------------------|
| 1 | `slot` is readable | `no-slot` |
| 2 | `|slot − 600| ≤ 60` (9:00 to 11:00 AM CT, both ends in) | `outside-window` |
| 3 | `offset ≥ 0` | `saved-before-date` |
| 4 | If `offset = 0`: `saved − slot ≥ −1` | `saved-before-slot` |
| 5 | If `offset = 0`: `saved − slot ≤ 10` | `saved-late` |
| 6 | If `offset > 0`: `|saved − slot| > 10` | `stale-tab` |
| 7 | `spx`, `spx_low` and `spx_high` are all usable numbers | `no-price-range` |
| 8 | `spx_low − 10 ≤ spx ≤ spx_high + 10` | `spx-outside-range` |

**Reliable backtest rows skip tests 3–5.**
- **Which rows:** `is_backtest = true` and first saved on or after
  2026-10-28 00:00 CT. Such a row is built from candles for its own slot, so
  the time it was first saved says nothing about its values.
- **Why the flag is reliable from then on:** it was fixed on 2026-10-27
  between 20:27 and 22:44 CT (`ae1bb53fd` to `a0d179c2e`).
- **Why the exemption is needed:** `created_at` is the first insert's time,
  and an ON CONFLICT update never changes it.
  - When a later replay updates a row in place, tests 3–5 would judge that
    row by its first save.
  - Example, 10-28 row 5877: first saved 10-28 at 20:38, so test 5 would
    reject it as `saved-late`. It holds the 11-07 replay's 10:00 values, and
    that replay's insert for the slot became an update (id 6631 is unused).
  - 11-11 row 16649 is the same case (id 16987 unused).
- **Test 6 still applies to these rows.** Two kinds of `is_backtest = true`
  rows saved after 10-28 are not candle builds:
  - live captures from a tab still running the code from before the fix
    (10-28 rows 5821 and 5822, each saved at its own slot time);
  - rows whose flag was flipped by hand (`flip-1111-frozen.mjs`,
    `backup-flip-1116-0830.mjs`) and not yet overwritten by a replay.
  - A tab like that left on an old date makes stale-tab rows, and test 6
    catches them.
- **Rows saved before 10-28 get all eight tests,** whatever their flag. On
  those rows the flag is inverted. Also, the 03-26 catch-up rows carry
  `is_backtest = false`, which before 10-28 meant a backtest save, and they
  are still junk.

Notes on the rule:
- **A later-day save is kept unless it was made at the slot's clock time.**
  The replay repairs were saved days later, mostly in the evening (CT hours
  17–22 after 10-28).
- **Where `spx_low` and `spx_high` come from:**
  - On live rows saved since 11-19 they come from the quote at save time
    (phase 1 G1).
  - On every other row from 03-05 on, they come from the 11-21/22
    price-context backfill: candles up to the row's slot on its own date.
    Stale-tab row 4869, saved 07-16, carries 07-15's range at its slot.
  - On dates before 03-05 the backfill had no candles. The range is whatever
    the row was saved with, and it may not be as-of: rows 86 (9:55) and 87
    (9:05) on 02-25 carry the identical range 6915.15–6936.20. Test 8 is
    weaker on those dates.
- **Tolerance.** These are dates under the full rule, from `rows.json`:

  | Tolerance | Dates that move | Dates with no pick |
  |---|---|---|
  | 5 | 6 | 31 |
  | 10 | 3 | 28 |
  | 20 | 2 | 24 |

  - It is 10.
  - Moving from 10 to 20 changes 5 dates. 01-28, 02-10, 03-02 and 03-03
    would get their 9:05 rows back, and 02-25 would keep row 86.
  - All five are before 03-05, where the range itself can't be trusted, so
    neither choice is vetted. 10 keeps them out.
  - (An earlier draft cited `window.out` here. That file predates the window
    and the exemption, and counts distances, not picks.)
- **The same-day limit is 10 minutes.** Live same-day saves lag 4 minutes at
  the 90th percentile. The 03-26 catch-up rows (41 minutes or more) are what
  the limit is there to catch.
- **Missing range means untrusted (test 7).** Example: 01-02 row 247 has no
  range and holds SPX 6506 / VIX 26.78, a late-March quote on a day SPX was
  near 6860.

## What it changes on today's data

These counts come from running the rule over the profiled rows
(`variants-v5.out`, with test 6 kept for exempt rows; the same result as
`variants-v4.out`).

- **3 dates move to another row:**
  - 02-25: 86 → 87;
  - 03-18: 171 → 172 (both hold the identical 10:18 quote);
  - 07-15: 4869 → 4795 (9:50, VIX 15.81).
- **28 dates have no trusted row:**
  - 01-02, 01-28, 02-03 to 02-06, 02-09, 02-10, 02-12, 02-24, 03-02, 03-03,
    03-04, 03-09, 03-17, 03-23, 03-26, 03-27, 03-30, 03-31, 04-01, 04-02,
    04-06, 04-07, 04-10, 04-13, 04-16 and 08-24.
- **161 dates keep their pick.**

**What the 28 dates store now.** This is a read-only check of
training_features (2026-11-22, `nopick-stored.out`). Their values came from
the rows today's rule picked, and those rows are mostly not a 10:00 view
either:
- **17 dates come from a row that fails a timing or price test:**
  - two VIX 19 placeholders (03-23, 03-30);
  - stale tabs (04-02, 04-10, 08-24);
  - catch-up saves (03-31, 04-13);
  - rows outside the SPX range: 03-27 by 41 points, 02-12 by 107, 03-09 by
    96, and the 9:05 rows on 01-28, 02-09, 02-10, 02-24, 03-02, 03-03 and
    03-04, by 12 to 21 points.
- **7 dates come from real rows far from 10:00:**
  - 01-02 at 11:05;
  - 03-26 at 8:45;
  - 03-17, 04-01, 04-06, 04-07 and 04-16 between 2:00 and 2:55 PM. For
    example, 03-17 stores `hours_remaining` 0.92.
- **4 dates come from rows with no range to check:** 02-03 to 02-06, all at
  9:05.

The owner decided to blank all 28 (see Owner decisions). The run is described
under "Repair runs after deploy".

## A day with no pick must not train

Most ML readers keep a day only when `feature_completeness >= 0.80`:
`ml/src/clustering.py:930`, `ml/src/explore.py:68`,
`ml/src/phase2_early.py:764`, `ml/src/milestone_check.py:91` and
`api/ml/export.ts:90`.

**Completeness can't drop that low on its own.**
- `computeCompleteness` (`api/_lib/build-features-upsert.ts:131-142`) divides
  by the keys present, about 120 on a full day.
- `build-features-flow.ts:87-129` always assigns its 76 keys.
- So 17 NULL snapshot keys bring a full day to about 0.82–0.86, and median
  imputation (`ml/src/clustering.py:232`) fills them in.

**Rule: a date that has snapshot rows but no trusted pick gets
`feature_completeness = 0`.**
- It has no 10:00 view, so it is not a training day. Every reader that
  applies the 0.80 filter honours it, with no change to any reader.
- It is 0, not NULL, because the COALESCE upsert can't write NULL.
- When a later run finds a trusted pick (a phase 5 fill, a phase 6 rebuild),
  completeness is recomputed as usual.
- Two places read completeness for status rather than training. A 0 must read
  as "no 10:00 view", not as a pipeline failure, in both:
  - `latestCompleteness` (`build-features.ts:363`);
  - `ml/src/health.py:136-150`.
  The builder checks both and adjusts wording or thresholds there if a 0
  would raise a false alarm.
- **A date with no snapshot rows at all is unchanged.** Its keys stay absent,
  as today, and it can still score high.
  - That is an existing gap outside this decision.
  - Read-only count, 2026-11-22 (`vix-null.out`): 17 stored dates have no
    VIX, none of them with snapshot rows. 11 of them (09-10 to 09-29) score
    0.93 and pass the 0.80 filter.
  - Whether they get the same rule goes to the owner as its own question.

## Code changes (one phase)

Five files. The `CLI test` makes six only if it needs a change. The shared
pick type couples the cron and the script, so they ship together.

1. `api/cron/build-features.ts`
   - The snapshot read adds these columns:
     - `spx`, `spx_low`, `spx_high` and `is_backtest`;
     - `(created_at >= TIMESTAMPTZ '2026-10-28 00:00 America/Chicago') AS flag_reliable`;
     - `((created_at AT TIME ZONE 'America/Chicago')::date - date) AS saved_day_offset`;
     - `(EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Chicago')::int * 60 + EXTRACT(MINUTE FROM created_at AT TIME ZONE 'America/Chicago')::int) AS saved_minutes_ct`.

     All time-zone math stays in SQL.
   - **One SQL text for both reads.** The trust columns are one exported SQL
     text, shared with the script (item 3), so the pglite test (item 5) pins
     the same text the cron runs. The builder picks the mechanism (for
     example `sql.query` with the shared text); the cron test's mock
     plumbing follows it.
   - A new exported pure function,
     `featureSnapshotRejection(row): FeatureSnapshotRejection | null`, returns
     the first failing reason from the table, or null when the row is trusted.
     It reads the numbers through `num()`, because NUMERIC arrives as a string.
   - `pickFeatureSnapshot` applies it as described under The rule.
   - Named module constants:
     - `FEATURE_SAMPLE_WINDOW_MINUTES = 60`;
     - `SAME_DAY_EARLY_MINUTES = 1`;
     - `SAME_DAY_LATE_MINUTES = 10`;
     - `STALE_TAB_MINUTES = 10`;
     - `SPX_RANGE_TOLERANCE = 10`;
     - the flag cutover in the SQL text.
   - The new fields stay local to this file, in the type `SnapshotCandidate`
     reads. `SnapshotRow` in `build-features-types.ts` is unchanged.
   - `buildFeaturesForDate`, with rows but no pick:
     - All 18 copied fields are set to `null` explicitly, then `spx_open`
       takes the existing `outcomes.day_open` fallback (the day's open does
       not depend on the slot). Nothing tells absent from undefined (the
       CLAUDE.md optional-props policy).
     - `feature_completeness = 0` (see the section above).
     - The VIX-derived phase-2 features (`prev_day_vix_change`,
       `rv_iv_ratio`, `vix_term_slope`, `vvix_percentile`) stay unassigned
       when there is no VIX, as today. `build-features-phase2.ts` is
       unchanged. The blanking run clears their stored values.
     - `is_event_day` is computed from every row whenever the date has rows,
       pick or no pick. It is the date's flag, not the row's.
     - It logs one `logger.warn` naming the date and how many rows failed
       each reason.
   - A date with no rows at all is unchanged.
2. `api/__tests__/build-features.test.ts`
   - A table test of `featureSnapshotRejection`, covering every reason and
     each boundary:
     - same-day lag −1 passes, −2 fails;
     - same-day lag 10 passes, 11 fails;
     - later-day distance 10 fails, 11 passes;
     - `spx` at `spx_low − 10` passes, `spx_low − 10.01` fails, and the same
       on the high side;
     - slot 9:00 and 11:00 pass, 8:55 and 11:05 fail;
     - offset −1 fails;
     - a NULL `spx`, `spx_low` or `spx_high` fails;
     - NUMERIC strings parse;
     - a reliable backtest row saved 638 minutes late (10-28 row 5877) passes;
     - the same row with `flag_reliable` false fails `saved-late`;
     - a reliable backtest row saved on a later day at its slot's clock time
       fails `stale-tab`;
     - a reliable backtest row outside the SPX range still fails.
   - Existing tests the rule makes wrong are rewritten, not deleted
     (`build-features.test.ts:2135-2190` and nearby):
     - "the only row, though it is pre-market": now no pick;
     - "the first row when no label parses": now no pick;
     - "the 11:05 row over a pre-market one": 65 minutes away, now no pick;
     - "the next row when the 10:00 one has a null open": 11:05 is outside
       the window;
     - "a usable row far from 10:00 over a closer one with no open": 1:30 PM
       is outside the window.
   - Helpers:
     - The table's `pick` helper (`build-features.test.ts:2051`) gets trusted
       defaults for the new fields.
     - So does the handler tests' `snapshotRow` helper. Each row is an
       on-time same-day save with `saved_minutes_ct` set from its own slot
       (a fixed 600 would make a 10:30 row fail as `saved-before-slot`), and
       SPX inside its range.
   - `pickFeatureSnapshot`:
     - a nearer untrusted row loses to a farther trusted one;
     - the `spx_open` preference holds within trusted rows;
     - the tie rule still sends a tie to the earlier slot;
     - no trusted row returns undefined.
   - Real-data fixtures:
     - 07-15: rows 4795 and 4869, pick 4795;
     - 03-26 catch-up: a same-day 9:55 row saved 41 minutes late is rejected;
     - 01-02: row 247 with no range is rejected.
   - The handler, with rows but no trusted row:
     - the upsert receives NULL for the 17 copied fields other than
       `spx_open`;
     - `spx_open` comes from the outcomes fallback;
     - `feature_completeness` is 0;
     - `is_event_day` is still set from the rows;
     - the warning is logged.
   - The handler, with no rows: unchanged (an existing test stays green).
3. `scripts/_lib/snapshot-price-context.ts`
   - `featurePickChange` applies the same rule as build-features.
   - Its row read uses the shared trust columns, plus `spx`.
   - Its "after" pick uses the planned `spx_open`, `spx_high` and `spx_low`.
4. `scripts/_lib/snapshot-price-context.test.ts`: update the
   `featurePickChange` fixtures and add one case where the plan makes a row
   trusted.
5. `scripts/_lib/snapshot-price-context-pglite.test.ts`
   - **Table setup.** The DDL (lines 190-201) gains `is_backtest` and
     `created_at`. The `seed` (lines 241-260) writes `spx` and explicit
     `created_at` values, never `DEFAULT NOW()`, so no test depends on the
     wall clock. "names the dates whose feature pick changes" (around line
     499) keeps its `{from: 8, to: 9}` with trusted seeds.
   - **Time-zone cases**, on the shared SQL text:
     - a save at 23:30 CT (05:30Z the next UTC day) gives offset 0 and
       minutes 1410;
     - a save at 2026-11-02 15:30Z (CST, after the 11-01 change) gives 570;
     - a save at 2026-10-28 04:59Z gives `flag_reliable` false, and one at
       05:00Z gives true. These also prove Postgres accepts the zone-named
       literal.

`scripts/_lib/snapshot-price-context-cli.test.ts` mocks `pickFeatureSnapshot`
as `vi.fn()`. It changes only if the CLI's row shape changes what it passes
in.

## Repair runs after deploy (operations, owner OK on each run)

Nothing below runs until phase 1 is deployed. Each write run is backed up
first, applied to one date first, and needs the owner's OK on the run.

1. **Dry run.** A read-only script recomputes the pick for every date with the
   deployed function and diffs it against the 3 moves and 28 no-pick dates
   above. Any other difference stops everything.
2. **Vet the 3 new source rows** (feedback memory
   spot-check-backfill-output). For each:
   - it was saved on its own date near its slot, or is a non-stale later-day
     save;
   - its SPX is inside its as-of range;
   - its SPX and VIX match independent candles at its slot, not only the
     neighbouring rows, which can share a stale quote.
   - Sources per date:
     - **07-15 (row 4795):** `index_candles_1m`, or Schwab 5-minute `$SPX`
       and `$VIX`.
     - **03-18 (row 172):** Schwab 5-minute candles. `index_candles_1m` is
       SPY × 10 there (memory spx-candle-placeholder-gaps).
     - **02-25 (row 87):** no intraday source. It is before Schwab's depth
       and the 1-minute candles are SPY × 10. Check rows 86 and 87 against
       02-25's VIX high and low (`public/vix-data.json`) and SPX against
       `outcomes`. If either falls outside, bring 02-25 to the owner before
       it is rebuilt.
3. **Back up** every training_features row the runs below touch.
4. **Blank the 28 dates.**
   - Per date, one UPDATE sets 22 columns to NULL:
     - the 18 copied fields;
     - `prev_day_vix_change`, `rv_iv_ratio`, `vix_term_slope` and
       `vvix_percentile`.
   - It runs only if the row still hashes to what the plan read (an
     `md5(to_jsonb(row))` guard).
   - Then the date is rebuilt through the deployed cron (`?date=`). The
     rebuild refills `spx_open` from `outcomes.day_open` and writes
     completeness 0.
   - Then check the row: the 21 columns other than `spx_open` are NULL,
     `spx_open` equals `outcomes.day_open`, and completeness is 0.
   - Start with one date (03-23, the placeholder). Then the rest, one at a
     time.
5. **Rebuild the 3 moved dates.**
   - 07-15 first: then check each copied column against row 4795.
   - Then 03-18, then 02-25 if step 2 cleared it.
6. **Recompute `vvix_percentile` everywhere it depends on a changed `vvix`.**
   - On date D it ranks D's `vvix` against the 20 most recent earlier rows
     with a non-NULL `vvix` (`build-features-phase2.ts:206-216`). That is 20
     rows, not 20 trading dates.
   - Blanking takes 28 dates out of those windows, and the moves change 3
     values, so most dates from 01-02 to about 09-21 can shift.
   - A full rebuild would also rewrite every other column, so instead a
     one-off script does this:
     - it calls the exported `addVvixPercentileFeatures` on each date's
       stored `vvix`, so the real code computes the value;
     - it diffs the result against the stored value;
     - it backs up, then UPDATEs only `vvix_percentile` where it changed, in
       batches.
   - Order doesn't matter: the value reads earlier dates' `vvix`, never their
     percentile.
   - Hand-check two dates before the apply.

## What this asks of later snapshot-builder phases

These are asks on
`docs/superpowers/specs/2026-11-17-server-snapshot-builder-design.md`.

- **Phase 5 (fill cron) rows pass as they are.**
  - The cron runs at about 11:20 UTC on the next weekday morning.
  - Its rows are later-day saves made at least 160 minutes from their slot's
    clock time, so test 6 passes.
  - They carry candle as-of ranges, so tests 7–8 pass.
  - When a fill gives a no-pick date a trusted row, the fill's own
    training_features rebuild recomputes completeness.
- **As scoped today, phase 6 repairs none of the 28 dates.**
  - None of them is in `docs/tmp/snapshot-repair/replay-log.jsonl`.
  - Call 14 of that spec limits phase 6 to replay-log rows, backtest rows
    saved after 10-28 and four known empty slots.
- **Repairing them needs phase 6 widened.** My proposed default, for its
  spec to settle:
  - **Depth.** Schwab's 5-minute depth reached 03-05 in the 11-21 dry run
    (`docs/tmp/snapshot-price-context/dry-run-stdout-20261121T0500Z.txt`).
    - So 15 of the 28 are within reach: 03-09, 03-17, 03-23, 03-26, 03-27,
      03-30, 03-31, 04-01, 04-02, 04-06, 04-07, 04-10, 04-13, 04-16 and 08-24.
    - The 13 earlier ones stay blank.
    - The owner asked for 03-26 and 03-27 by name (2026-11-21: "lets keep an
      eye on that so the 2 days get the real 10:00 AM source row too").
  - **Dates with no row between 9:00 and 11:00** (03-17, 04-01, 04-06, 04-07,
    04-10, 04-16) need a 10:00 row inserted, by the fill's insert-only path.
  - **The others need their rejected 9:00–11:00 rows rebuilt.**
    - Rows 357 (03-26) and 359 (03-27) are `is_backtest = false`.
    - Phase 6 overwrites only `is_backtest = true` rows, and a backtest write
      never replaces a live row (`db-snapshots.ts:237`). So such rows need a
      flag flip first, as `flip-1111-frozen.mjs` did for 11-11.
  - **A provenance signal.** A rebuilt row first saved before 10-28 still
    takes tests 3–5.
    - Phase 6 needs a mark the exemption accepts, for example a column the
      rebuild sets (a migration, owner OK).
    - Setting `created_at` to the rebuild time is not a good fix. It
      reorders the readers that take the newest row by `created_at`
      (`api/futures/snapshot.ts:129`, `api/positions.ts:150`,
      `api/pre-market.ts:55,100`). And a run between about 8:50 and 11:10 CT
      would make its own rows fail test 6.
  - **Depth risk.** Whether Schwab's 5-minute depth is a rolling window is
    unknown. If it is, the earliest of the 15 can fall out before phase 6
    lands. Saving their candles to `docs/tmp/` now is a cheap guard.

## Left to the builder

- The shared-SQL mechanism (item 1), and the mock plumbing it needs.
- Where the warning's per-reason counts are built, and its exact wording.
- Whether `featureSnapshotRejection` takes the CT sample time as a parameter
  or reads the module constant (the constant, unless a test needs otherwise).
- The wording or threshold changes in `latestCompleteness` and
  `ml/src/health.py`, if a 0 would read as a failure there.
