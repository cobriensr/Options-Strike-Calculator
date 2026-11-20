# range_pos split repair, backfill split guard, badge screen-reader text

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Repair the 1,183 Lottery Finder fires whose `range_pos_at_trigger` the 10-29 backfill pinned at 0 or 1 because of stock splits, stop the backfill from doing it again, and give screen readers the explanation each row badge shows on hover.

**Approved:** owner, 2026-11-19 ("1. you can repair/blank them, 2. please go ahead, 3. please fix it").

**Background:** memory `new-high-badge-split-artifact` and `docs/tmp/newhigh-weekday-2026-11-17/REPORT.md` (main checkout). The 10-29 backfill (`scripts/backfill-range-pos.mjs`) compared UW 1-min candles, which UW adjusts for later splits, with the unadjusted stored `spot_at_first`. The clamp in `computeRangePos` hid the mismatch as 0 or 1.

## Findings (2026-11-19, read-only)

- Only CRWD and SOXS show the pattern. Every ticker was checked for 3+ days where all filled fires sit at the same extreme, and these were the only two.
  - The spot-jump scan over all tickers found the other splits either before 05-18, when the cron still filled `range_pos` live from same-day candles, or after the 10-29 backfill.
- Affected rows, all pinned:
  - CRWD 2026-05-18..07-01: 928 rows, all = 1.
  - SOXS 2026-05-18..07-10: 255 rows, all = 0.
- Split scale, measured as stored spot ÷ the UW candle close at the trigger minute on 6 sample fires:
  - CRWD 3.986–4.019, so a 4-for-1 split between 07-01 and 07-07.
  - SOXS 0.1000–0.1008, so a 1-for-10 reverse split between 07-10 and 07-17.
- Hand check, CRWD fire 647842 (05-19 13:30:54Z): spot 620.49 ÷ 4 = 155.12, against a pre-trigger range of 153.25–155.88, gives range_pos 0.712. The stored value is 1.
- Hand check, SOXS fire 844453 (07-10 18:35:37Z): spot 4.0701 × 10 = 40.70, against a range of 39.80–43.90, gives 0.220. The stored value is 0.
- UW returns the day's candles newest first and includes extended hours (08:00–23:59 UTC). `computeRangePos` scans every candle, so order doesn't matter. Anything that picks "the last candle" must sort first.

## Thresholds and constants

- `SPLIT_GUARD_RATIO = 1.2`. A fire fails the guard when its spot is above the pre-trigger high × 1.2 or below the pre-trigger low ÷ 1.2.
  - Why 1.2: the smallest common split is 3-for-2 (1.5×), so any split fails the guard. A stock can't trade 20% outside its own session range at one instant. Real edge cases, where spot sits a hair past the last candle's high or low, are well under 1%.
- Repair scales: multiply the stored spot by 0.25 for CRWD and by 10 for SOXS, which puts it on the scale of UW's adjusted candles.
- Repair windows start 2026-05-18. Before that, the cron filled `range_pos` live, from unadjusted same-day candles, and those values are right.

## Task 1: Split guard in the range_pos backfill

**Files:** `scripts/_lib/range-pos-backfill.mjs`, `scripts/_lib/range-pos-backfill.test.mjs`, `scripts/backfill-range-pos.mjs`

- Export `SPLIT_GUARD_RATIO = 1.2`, and `isSplitMismatch(candles, triggerTimeIso, spot) → boolean`.
  - It returns true when, over candles whose `start_time` ≤ trigger, spot > high × 1.2 or spot < low ÷ 1.2.
  - It returns false when there is no pre-trigger candle, no finite range or no finite spot. `computeRangePos` already returns null for those.
- `rangePosUpdates(fires, candles)` leaves a fire that fails the guard NULL and counts it as `splitMismatch`, separately from `leftNull`. It returns `{ ids, positions, leftNull, splitMismatch }`.
- `backfill-range-pos.mjs` tallies `splitMismatch`. The report prints the count, a one-line meaning (spot more than 20% outside the session's candle range, likely a split between the fire and UW's split-adjusted candles, or a bad stored spot of 0 or below, which fails the guard too) and the affected ticker-days. Update the header comment.
- `computeRangePos` stays unchanged: it is an exact port of `api/_lib/uw-stock-candles.ts`, pinned by test. The live cron needs no guard, because it compares same-day live spot with same-day live candles.
- Tests:
  - CRWD-like case (spot 620.49, candles 153.25–155.88): fails the guard, stays NULL, counted.
  - SOXS-like case (spot 4.0701, candles 39.8–43.9): fails the guard.
  - Spot 0.5% above the high: passes, and stays clamped to 1 as before.
  - Spot exactly at high × 1.2: passes.
  - A later candle whose range would contain the spot doesn't rescue a fire that fails.
  - Candles in newest-first order: same result.

## Task 2: Split repair script

**Files:** `scripts/_lib/range-pos-split-repair.mjs` (pure pieces), `scripts/_lib/range-pos-split-repair.test.mjs`, `scripts/repair-range-pos-splits.mjs`

- `SPLIT_REPAIRS`, frozen:
  - `{ ticker: 'CRWD', from: '2026-05-18', to: '2026-07-01', spotScale: 0.25 }`
  - `{ ticker: 'SOXS', from: '2026-05-18', to: '2026-07-10', spotScale: 10 }`
  - Each carries a one-line note of the split and the evidence (the measured ratios above).
- Selection: that ticker's rows in [from, to] with `range_pos_at_trigger IS NOT NULL`.
- Per ticker-day, one `fetchDayCandles` call (reuse from range-pos-backfill.mjs; 3 in flight). Per row:
  1. Raw spot passes the guard: not a split artifact. Leave it, and count it as `notArtifact`.
  2. Raw spot fails and spot × spotScale passes: the new value is `computeRangePos(candles, trigger, spot × spotScale)`. A null result is a blank.
  3. Both fail: blank (NULL).
  4. UW error or empty day: leave the day's rows untouched, count them as failed, and exit 1.
- Backup comes first. Before any write, write every selected row (id, ticker, date, trigger_time_ct, spot, old value) as JSON to `docs/tmp/range-pos-split-repair/backup-<UTC stamp>.json` (gitignored). If the file can't be written, abort with no writes.
- Dry run is the default; `--apply` writes.
  - Writes go in ≤500-row `UPDATE … FROM unnest(ids bigint[], next numeric[], old numeric[])`.
  - The guard is `f.id = v.id AND f.range_pos_at_trigger IS NOT DISTINCT FROM v.old`, so a row changed since the read is skipped and counted.
  - Values go over as text into `numeric[]`, matching the backfill. NULL elements are allowed.
- `--undo <backup.json>` restores each listed row's backed-up value. It is batched the same way and touches only ids in the file whose ticker is in `SPLIT_REPAIRS`.
- Report, per ticker: rows, repaired, blanked, notArtifact, failed, written, changed-since-read; the new values' min, median and max; and 2 sample rows per ticker (id, trigger, spot, scaled spot, pre-trigger low and high, old, new) for the hand check.
- Same guards as the backfill: the market-hours refusal with `--allow-market-hours`, `redact` on every printed line, missing-env exit 1, and `retryTransientDb`. Reuse `backfill-cli.mjs` through the backfill lib.
- Tests:
  - The per-row plan covers all four cases.
  - The SPLIT_REPAIRS windows and scales.
  - The backup document's shape.
  - The undo plan rejects ids for tickers outside `SPLIT_REPAIRS`.
  - Arg parsing (`--apply`, `--undo` with and without a path, unknown flag).
  - Chunking at 500.

## Ops step (main session, after Tasks 1–2 pass review)

1. Run a dry run against production. Hand-recompute one row per ticker from the UW candles and the stored spot; they must match the printed new values.
2. Run `--apply` and keep the backup file.
3. Verify read-only:
   - No CRWD or SOXS row in either window is still 0 or 1 unless the recompute says so.
   - Counts match the report.
   - The NULL count rose only by the blanks.
4. Update memory `new-high-badge-split-artifact`: rows repaired, backup path, undo command.

## Task 3: Screen-reader text for the row badges

**Files:** `src/components/LotteryFinder/LotteryRow.tsx`, `src/components/SilentBoom/SilentBoomRow.tsx`, `src/components/LotteryFinder/SpreadLegBadge.tsx`, any other component rendered inside those rows with `aria-label` on a role-less element (check TakeItScore, SiblingAssetConfirmationBar, the GEXBot badge), and their tests.

- The problem: `aria-label` on a `span` or `div` with no role. ARIA 1.2 prohibits naming a generic element, and screen readers mostly ignore it, so the hover explanation never reaches them. The round-trip pill, tier badge, quintile chip, gated pill, flow chips, GEXBot badge, CI chip, reload badge, tide chip and exit-signal badge all do this.
- The fix:
  - Drop `aria-label` from those role-less elements, and keep `title` for mouse hover.
  - Put the explanation inside the badge as visually hidden text (`sr-only`), so a screen reader reads the visible label and then the explanation.
  - Where the explanation adds nothing to the visible text, drop the `aria-label` and add nothing.
  - Follow any existing `sr-only` pattern in `src/`. A small shared component is the implementer's call if it removes repetition.
- Leave `aria-label` on interactive elements (buttons, inputs, links, selects) and on elements that carry a role.
- Tests:
  - Update the per-badge assertions.
  - Add a guard test per row component: a fully badged LotteryRow and SilentBoomRow contain no element with `aria-label` and no role that isn't natively interactive.
- `npm run review` green. Run `npm run test:e2e` for the a11y spec if the badges appear in it.

## Order and push

One implementer stream: Task 1 → Task 2 → the ops step → Task 3, then one push.

- `scripts/` is neither a Vercel build path nor a nightly watch path.
- `src/` redeploys Vercel only. Nothing here touches Railway.
- Push after 15:00 CT and outside 07:15–12:30 UTC, then verify CI and the Vercel READY state.

## Open questions

None. The owner approved repairing or blanking, the split guard, and the badge fix. The how is ours, and is recorded above.
