# Remove the Lottery Finder NEW HIGH badge (2026-11-17)

**Goal.** Remove the display-only NEW HIGH badge and the `rangePosAtTrigger` field that only it reads.
- Its claimed edge does not hold out of sample.
- 81.6% of its stored history is a stock-split artifact.

The owner approved the removal on 2026-11-17. This is handoff item 4.8 (`2026-11-16-handoff-lottery-scoring-and-data-repairs.md`).

## Why

Study: `docs/tmp/newhigh-weekday-2026-11-17/REPORT.md` (gitignored, main checkout). The main session re-checked the artifact and found its cause.

- **The tooltip's claim fails out of sample.** It cites "2.4× win100 lift (N=143)" from the 2026-05-16 EDA. After 05-16, with the artifact removed, 68 badge fires reach +100% at peak 17.6% of the time against a 17.9% baseline: a lift of 0.98.
- **No realized edge.** Realized trail 30/10, badge minus no badge, artifact removed, day-clustered 95% CI:
  - true first fires −4.5 pts (−19.6..+9.9), 72 fires on 41 days;
  - every fire +7.6 (−4.4..+17.1), carried by 5 ticker-days.
  - Weekday standardization moves either by 0.6 pts at most. The within-day contrast agrees.
- **The stored history is mostly a split artifact.** Badge rows total 1,138; 929 are CRWD, with `range_pos_at_trigger` = 1.0 on every CRWD fire from 05-19 to 07-01.
  - CRWD split 4-for-1 in early July (`spot_at_first` was $783 on 07-01 and $193 on 07-07).
  - The 10-29 backfill (`scripts/backfill-range-pos.mjs`) compared split-adjusted UW candles with the unadjusted stored spot, so `range_pos` clamped at 1.
  - SOXS is the mirror case: a reverse split (about $4 on 07-10, about $54 on 07-17) pinned 253 fires from 05-22 to 07-02 at 0.
- **No other reader.** `range_pos_at_trigger` is not a score input (`api/_lib/lottery-score-bonuses.ts:45`) and not a Take-It feature.

## Phase 1: remove the badge and the client field (one review loop)

**Changes**
1. `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`: remove `LF_NEW_HIGH_THRESHOLD` and its comment (~:30-43), plus the `isNewHigh` logic and badge JSX (~:440-463). If the wrapping `relative` div exists only to position the badge, simplify it.
2. `src/__tests__/LotteryFinderTickerGroup.test.tsx`: remove the badge tests. Keep one assertion that no `lottery-new-high-badge` renders for a fire whose range_pos would have saturated.
3. Remove `rangePosAtTrigger` from the client fire type (`src/components/LotteryFinder/types.ts` ~:381) and from the test fixtures that set it:
   - `LotteryDayBanner.test.tsx`, `LotteryFinderSection.test.tsx`, `LotteryRow.test.tsx`, `LotteryTierBanner.test.tsx`, `ReignitionSection.test.tsx`, `lottery-fire-spot.test.ts`.
4. `api/lottery-finder.ts`: stop selecting `f.range_pos_at_trigger` (~:750, ~:1159) and stop mapping it (~:1706). Remove it from the row type (~:180). Update `api/__tests__/lottery-finder-endpoint.test.ts`.
5. Stale comments: `api/cron/detect-lottery-fires.ts` ~:1052 and `api/_lib/lottery-score-bonuses.ts` ~:45-48 say the column feeds the badge. Reword them: research-only, no reader in the app. The same wording sits in `api/__tests__/detect-lottery-fires.test.ts` and `api/__tests__/lottery-score-bonuses.test.ts`; reword those too, so a grep for `NEW HIGH` finds nothing left.

**Kept**
- The `range_pos_at_trigger` column, the detector's write and `computeRangePos`. Owner rule: keep working collectors even when unread. The ml/ EDA scripts still read the column.

**Commits.** At most 5 files per commit. Follow the MACRO removal sequence: badge first, then the field made optional, then the field removed (`7dbd1218..e3240310`).

## Data dependencies
None: no migration, env var or external API change.

## Open items (not in this change; each needs the owner)
- **Repair the split artifact.** About 1,181 rows (CRWD 05-19..07-01, SOXS 05-22..07-02 and possibly 07-10) hold a wrong `range_pos_at_trigger`. NULL them, or recompute with split-consistent inputs. It's a production write and matters only to research now.
- **Split guard in the backfill.** `scripts/backfill-range-pos.mjs` / `scripts/_lib/range-pos-backfill.mjs` will repeat the error on any re-run across a split. A guard could return NULL when `spot_at_first` lies far outside the session's candle range (for example above 1.2 × high or below 0.8 × low). That is a method change, so it's the owner's call.
- **Semantics** (from reading the code, not verified on data). `range_pos` uses `spot_at_first`, the first print of the detector window, not the spot at the trigger. So 1.0 meant "nothing printed higher after the window's first print" rather than "spot broke above the high". This matters only if the field is ever surfaced again.

## Constants
| Name | Value |
|---|---|
| Old badge threshold | `range_pos_at_trigger >= 1.0` (clamped [0,1]) |
| Badge rows as stored | 1,138 (929 CRWD) |
| Clean badge rows | 210 |
