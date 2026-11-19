# Handoff: Lottery scoring, econ labels and data repairs (session 2026-11-14 to 11-16)

**Goal.** Let a new session pick up where this one stopped.
- Section 2 lists what is finished and verified. Nothing there needs action.
- Section 4 lists the open items, each with evidence and a recommended fix. **None is started.** Each needs the owner's go before any code or production write, except 4.8, which is a read-only study.

**Before you start**
- The scratch evidence cited here lives in the **main checkout's** `docs/tmp/` folder. It is gitignored, so a fresh worktree doesn't have it. Read it from the main checkout.
- Related memory notes: `project_refire_study_2026_11_15`, `project_macro_badge_weekday_null`, `project_econ_fomc_labels`, `project_spx_candle_placeholder_gaps`, `project_event_day_flags`, `project_neon_history_window`, `project_replay_cooldown_bug_corrupted_days`, `project_snapshot_replay_repair_2026_11_07`.

## 1. Rules that apply to this work

- **Production database.** `.env.local` `DATABASE_URL` is production Neon.
  - Any write needs the owner's explicit go.
  - Back up the rows first.
  - Before any `--apply`, recompute one or two rows by hand from each raw source.
- **Secrets.**
  - Never edit `.env*` files and never print a secret.
  - Never ask the owner to paste a key into chat.
- **Neon tooling.**
  - The Neon MCP is read-only on purpose. Don't work around it.
  - The `neonctl` login on this machine has write scope. Use it only when the owner asks.
- **Migrations.**
  - Applying migrations applies **all** pending ones, so check first for other sessions' unapplied migrations.
  - Run heavy DDL with `scripts/migrate-db.ts`, which allows 10 minutes. `/api/journal/migrate` stops at Vercel's 300 s.
- **Pushes.** Don't push to Railway or nightly watch paths during market hours or between 07:15 and 12:30 UTC.
- **Git.**
  - No bare `git stash` and no `--no-verify`.
  - The pipe-exit-guard hook blocks `git … | … && …` chains, so run git steps on their own.
- **Analyze prompt.** Don't propose changes to `api/_lib/analyze-prompts.ts`. It is the owner's rework area: flag problems only.
- **Fire studies.**
  - Count each contract once per day at its true first fire: `ROW_NUMBER() OVER (PARTITION BY date, option_chain_id ORDER BY trigger_time_ct, id)`. Stored `alert_seq = 1` mislabels later fires.
  - Report a realized exit (trail 30/10), not peak-touch rates, and name the metric.
  - Any effect tied to calendar timing must be standardized by weekday, or checked with a week-shift placebo.
- **Talking to the owner.** Plain words, one numeric example, one decision per message.

## 2. Done

1. **Econ FOMC labels backfill.** Applied 2026-11-14 at about 12:12 CT.
   - Writes:
     - 117 `economic_events` rows retyped;
     - 143 `training_features` rows changed (`is_fomc` true on 53 days → 7);
     - 54 `ws_gamma_setup_fires.is_fomc_day` set.
   - Backup: `docs/tmp/econ-labels-apply/backup-2026-11-14T18-11-36-583Z.json`.
   - The features were rebuilt the same day, and the dry run still shows 0 changes.
   - Spec: `docs/superpowers/specs/2026-11-06-economic-events-fomc-classification.md`.
2. **MACRO badge re-measured, then removed.**
   - On the corrected labels, the 72–168 h lift (1.20× on win50) is a Thursday/Friday effect.
   - Weekday-adjusted it is 1.00 (0.96–1.04), and a week-shift placebo reproduces it.
   - The badge also could never fire live.
   - Removed on 11-15 (main `99ac2def..297c930d`).
   - Report: `docs/tmp/macro-badge-remeasure-2026-11-14/REPORT.md`.
3. **Weekday realized-return study.**
   - On true first fires, Friday minus Mon–Thu is −1.0 pts (−2.7..+0.7). There is no detectable Friday effect.
   - The earlier "Friday is worst" result (−3.0) came from re-fire entries.
   - Reports: `docs/tmp/lottery-weekday-realized-2026-11-14/REPORT.md` and `docs/tmp/lottery-weekday-realized-2026-11-15-addendum.md`.
4. **Re-fire study.**
   - A re-fire is no better an entry than the first fire. Per fire: first −1.0%, fires 2–5 −1.7%, 6–20 −2.3%, 21+ −1.9%.
   - Stored `alert_seq` mislabels 75% of "first fires".
   - It found the 24 replay-duplicate days (item 4.6).
   - The fire-count score adjustment was hindsight: it equalled the bucket of the day's FINAL fire count on 99.8% of rows.
   - Report: `docs/tmp/refire-study-2026-11-15/REPORT.md`.
5. **Fire-count score adjustment retired.**
   - Code `85373a6a` and `02ef14c2` are deployed.
   - Migration #209 was applied 2026-11-16 at about 07:02 UTC. It took 67 s, and the table went from 2,986 to 2,156 MB.
   - All after-checks passed.
   - The dropped values are backed up in `docs/tmp/fire-count-retire-209/backup-2026-11-16T07-01-40.561Z.json` (1,111,476 rows).
   - Spec: `docs/superpowers/specs/2026-11-15-retire-lottery-fire-count-adjustment.md`.
6. **Neon restore window raised from 6 h to 7 days.**
   - Set 2026-11-16 at about 15:00 CT through the Neon API. `neonctl` has no flag for it.
   - Read back as 604,800 s.
   - The window fills forward, so full 7-day coverage arrives about 2026-11-23.
   - Estimated cost: ~$30–37 a month in a heavy week.
7. **Status check, 11-16 after the close.**
   - The feed answers normally: 519 chains. Among the top 200 by score, 33 are tier 1 and 13 tier 2.
   - Last week's tier 1 counts for the same request were 24, 31, 22, 33 and 74, so today is in range.
   - No Sentry errors came from the feed or from #209.

## 3. What worked and what didn't

**Worked**
- `scripts/migrate-db.ts` for DDL that rewrites a whole table.
- A keyset-paged JSON export of the affected columns before a destructive migration.
- A read-only feed probe that sends the `sc-owner` cookie from `.env.local` without printing it (`docs/tmp/fire-count-retire-209/feed-probe.mjs`).
- A Neon REST `PATCH /api/v2/projects/{id}` with the `neonctl` OAuth token for a setting `neonctl` lacks. The token is in `~/.config/neon/credentials.json`; never print it.
- Weekday standardization plus a week-shift placebo, which exposed the MACRO lift as a weekday effect.
- `VITEST_MAX_WORKERS=6` when subprocess-spawn tests flaked in `npm run review` under load.

**Didn't work**
- Treating stored `alert_seq = 1` as the first fire.
- Peak-touch win rates as a verdict. Friday led on peak touch (win50 46.7%), yet looked worst on realized returns until the first-fire correction showed no Friday effect at all.
- `git worktree remove` or `rmdir` on Windows while VS Code holds the folder: "Device or resource busy".
- `neonctl projects update`: it has no history-retention flag.

## 4. Open items

### 4.1 Let a rebuild clear stale feature values (code)

- **What.** The `training_features` upsert keeps the old value whenever the new one is NULL, on all 169 columns (`api/_lib/build-features-upsert.ts:263`). `day_labels` works the same way (`api/_lib/build-features-labels.ts:177`).
  - This is deliberate. A failed upstream fetch returns NULL (for example, UW refusing dates more than 30 days old), and the rule stops a rebuild from wiping the value fetched earlier.
  - But it can't tell "couldn't fetch it" from "nothing to compute", such as a zero denominator or a source row that was deleted or repaired.
- **Evidence.**
  - On 03-27 the stored resistance premium is 0 but the ratio is 1.1934, a value left over from an older build.
  - Every stored ratio that can be recomputed from other stored columns was checked: the dark-pool ratio, VIX1D/VIX and VIX/VIX9D. Only 03-27 is inconsistent.
  - A full audit needs a dry rebuild of each date compared against the stored row, which first requires knowing each column's source.
- **Recommended.** Split the columns by source.
  - Columns computed from our own tables get overwritten, NULLs included.
  - Columns fetched from outside APIs keep the current rule.
- **Owner decision.** Approve the code change. It was raised on 11-15 and isn't approved yet.
- **Watch out.** Earlier repairs that deleted source rows, such as the 11-12 futures and snapshot deletions, may have left features built on those rows in place.

### 4.2 Stop the 03-26 feature row from overflowing (code, "option A")

- **What.** Building features for 2026-03-26 fails the whole row.
  - `dp_support_resistance_ratio` comes out at 35,853, which doesn't fit its NUMERIC(8,4) column (limit 9,999.9999). The row hasn't rebuilt since March.
  - The ratio is unbounded, guarded only by `resistance > 0` (`api/_lib/build-features-phase2.ts:375`). On 11-05, a one-way sell day, it reached 1,471.
  - `oic_oi_change_pcr` (`:540`) has the same flaw. Its stored maximum is 140.9.
- **Cause.** The placeholder candles (4.3), plus one off-market SPY print: 305 shares at $657.97 at 12:36 ET, sale condition `average_price_trade`. That print became the only level above the open.
- **Recommended.**
  - Set the value to NULL when |ratio| ≥ 10,000, and guard `oic_oi_change_pcr` the same way.
  - Write the NULL explicitly, because of 4.1.
  - Don't widen the column: that would feed 35,853 to the model's scaler.
  - A clamp, share or relative guard would change the method, so it needs the owner.
- **After the fix.** Resolve Sentry issue `SENTRY-EMERALD-DESERT-MB`. Its alert rule fires only on an issue's first event, so a recurrence stays silent while it's open.
- **Report.** `docs/tmp/overflow-0326/REPORT.md`.
- **Do 4.1 and 4.2 together**: same pipeline, one worktree, one review loop.

### 4.3 Replace the SPX 1-minute placeholder candles (production writes)

- **What.** In `index_candles_1m`, SPX closes are exactly 10.0000 × SPY.
  - That covers 13,408 rows from 03-18 to 04-10. 03-26 is 822 of 822 minutes.
  - It probably reaches back to 02-25, but there are no SPY candles before 03-18 to check against.
  - The real ratio is about 10.01–10.04.
  - This breaks the dark-pool SPY→SPX level mapping (`api/_lib/dark-pool-query.ts:140`).
- **Writer.**
  - The rows came from an old backfill that used a fixed ratio of 10, plus the live cron until `e9d12edb`.
  - Today's `scripts/backfill-spx-candles-1m.mjs` uses a per-day ratio. It writes `ON CONFLICT DO NOTHING`, so the placeholder rows must be deleted before a re-backfill.
- **Recommended.** Back up, delete the ×10 rows, re-backfill, then rebuild features for the affected dates. About 15 dates' dark-pool values will move.
- **Owner decision.**
  - A go for the delete, the backfill and the rebuild.
  - What to do about 02-25..03-17, where there are no SPY candles to verify or recompute from.

### 4.4 Fill the 13 days with no SPX 1-minute candles

- **What.** 09-22..09-30 and 10-08..10-15 have SPY candles but no SPX rows. The cause hasn't been investigated.
- **Lead (unverified).** The 11-13 commits `6186d7ea` and `fc95246f` handle a lapsed Schwab login in `fetch-spx-candles-1m`, so a login lapse is a plausible cause.
  - The peer worktree `.worktrees/spx-candles-lapse` has since been reused for another branch (`land/sentry-p12`). Nothing else is covering this.
- **First step (read-only).** Check the cron and Sentry history for those dates.
- **Then.** Backfill with the same script and rebuild those dates' features, with the owner's go.

### 4.5 March snapshot rows saved with placeholder inputs (SPX 5720, VIX 19.00)

- **What.** 32 live `market_snapshots` rows on 03-23, 03-24, 03-26, 03-27 and 03-30 were saved with the app's placeholder inputs.
  - The `training_features` rows for 03-23 and 03-30 are built on them and show VIX 19.00.
  - 03-26's placeholder rows have a NULL `spx_open`, so build-features never picks them.
- **Limits.**
  - 03-23 and 03-24 are older than Schwab's 5-minute history, which starts 03-25, so they can't be replayed.
  - The other dates can be replayed with the snapshot replay driver (memory `project_snapshot_replay_repair_2026_11_07`).
  - Rows that analyses or positions reference (FK, no `ON DELETE`) can't be deleted. Flip `is_backtest` instead, so the replay overwrites them in place and keeps their ids.
- **Owner decision.**
  - Replay 03-26, 03-27 and 03-30.
  - For 03-23 and 03-24, either NULL the snapshot-derived features or leave those dates out of ML.

### 4.6 Repair the 24 replay-duplicate days in `lottery_finder_fires` (production writes)

- **What.** 24 days carry about 10× duplicate fires from replay templates that omitted the cooldown seed.
  - The days: 04-13→05-01, 05-05→05-14 and 05-26.
  - Together that's 206,718 fires, 18.6% of the table.
  - On those days 32–53% of fires land within 5 minutes of the same contract's previous fire. Live days run about 6–7%.
  - Only 05-04 and 05-20 were ever repaired (June, `7a93656f`).
- **Proven method** (memory `project_replay_cooldown_bug_corrupted_days`):
  1. Reload the trades from the Full Tape.
  2. Delete the replayed fires.
  3. Re-replay with the corrected template, `scripts/replay-lottery-fires-2026-06-10.ts`.
  4. Re-enrich the outcomes; the nightly service does this.
- **Watch out.**
  - Every fire from 01-02 to 05-01 was rebuilt, not live, so on those days the "inserted ≥ 30 min after trigger" delete rule removes whole days. Check how the May days were written before using the rule there.
  - Confirm the re-replay covers each day before committing the delete.
  - The study conclusions so far didn't depend on these days, but fire-count figures from them are inflated.

### 4.7 Take-It sequence features (at the next retrain)

- **What.** The live detector stores `alert_seq = 1` on 99.3% of fires, because it counts only fires found in the same run. In training the share is 18.6%.
- **How much it matters.**
  - The model gets about 1% of its gain from the 4 sequence features.
  - Re-scoring 22k live fires with the true values moved the mean probability by +0.004. The share above the 0.70 floor went from 38.0% to 39.1%.
- **Recommended.** Either drop these features at the next Take-It retrain, or compute the true sequence at detect time and backfill. Low urgency.

### 4.8 NEW HIGH badge: check for the weekday confound (read-only, can start without a decision)

- **What.** The MACRO re-measure never tested the NEW HIGH badge, and it may carry the same weekday confound.
  - The badge and its `rangePosAtTrigger` threshold are in `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx` (~:31 and ~:440).
- **Method.**
  - Same as `docs/tmp/macro-badge-remeasure-2026-11-14/`.
  - Use true first fires and a realized trail 30/10 exit.
  - Compare the raw lift with the weekday-standardized lift, and run a week-shift placebo.
  - Use day-clustered CIs.
- **Output.** A plain report to the owner. Whether to keep or remove the badge is the owner's call.
- **Result (2026-11-17): done, badge removed** (owner-approved, pushed as 99e1bd90..c40f09c1). Report: main checkout `docs/tmp/newhigh-weekday-2026-11-17/REPORT.md`.
  - No edge: realized trail 30/10, badge minus no badge on true first fires, −4.5 pts (CI −19.6..+9.9). Weekday standardization moved results by 0.6 pts or less, so weekday was not the problem.
  - 81.6% of badge rows were a stock-split artifact: the 10-29 `scripts/backfill-range-pos.mjs` run compared split-adjusted UW candles with unadjusted `spot_at_first` (CRWD 4:1 pinned at 1.0 05-19..07-01, SOXS reverse split pinned at 0 05-22..07-10).
  - **Still open, owner's call:** repair or NULL the ~1,181 bad CRWD/SOXS `range_pos_at_trigger` rows (a production write), and add a split guard to the backfill (`scripts/_lib/range-pos-backfill.mjs`). Until then, any study using that column drops those ticker windows.

### 4.9 Store UW's economic-calendar window (code, now a nice-to-have)

- **What.** The econ cron keeps only today's events.
  - UW's endpoint takes no parameters and serves the current and next week.
  - There is no websocket channel for it, so REST is allowed.
- **Recommended variant:**
  1. Write only rows dated today or later.
  2. Update forecast, previous, reported period and type, but never overwrite a stored value with NULL.
  3. In the same transaction, behind a circuit breaker, delete strictly-future rows that UW no longer returns.
  4. Rebase the analyze coverage rules (c) and (d), ideally on a run-log table.
- **Benefit.**
  - It heals missing weekdays: 18 non-holiday weekdays outside the big summer hole have no rows.
  - It gives live/backfill parity for `days_to_next_event`. That benefit is weak, because the feature has no live consumer.
  - The original reason, the MACRO badge, is gone.
- **Report.** `docs/tmp/econ-window-q3-2026-11-14/REPORT.md`.

### 4.10 Event-day flag leftovers (small)

- **Rule 12.** `api/_lib/analyze-prompts.ts:725` says the context includes `isEventDay` and `eventNames`, but the context never sends them. This is the owner's area, so flag it only.
- **Client field.** The client could stop sending `isEventDay`.
- **Dry run.** A dry run of `scripts/backfill-snapshot-event-flags.ts` would confirm the stored flags still match. It needs `FRED_API_KEY`, which isn't in `.env.local`, so the owner runs it from their own shell.
- **Already fixed; the memory note is stale.** build-features already ORs the flag over all of a date's rows (`552bdfd3`).

### 4.11 Watch list (act only if something looks wrong)

- **Tier counts after the retirement.**
  - Expected on the default feed: tier 1 rises from about 12 to 16.5 chains a day, and tier 1+2 from 29 to 37.
  - The feed computes its score in SQL from the raw score (plus the round-trip deduct until the 4.12 change lands; from then on the deduct is left out). It doesn't read `combined_score`, which still adds +1 for high gamma.
  - Tier tables built before #209 used the hindsight score, so note that when comparing. The round-trip deduct may also add information from after the fire (4.12).
  - After the 4.12 change ships, end-of-day tier counts rise further, because the deduct no longer demotes fires. On true first fires (REPORT step 2), tier 1 goes from 5,569 to 6,015 (+8%) and tier 2 from 4,457 to 4,912 (+10%). Don't blame that rise on the fire-count retirement.
  - The 11-18 shadow candidate's feed cutoffs, and the `gate_report.sessions` entries recorded before the deploy, use the old qas; entries after it use the new one. `decide_shadow` recomputes from the frames, so its verdict is consistent. Expect a step of about one point in the per-session shares at the deploy.
- **Sentry, 11-16.**
  - New and unexplained: `TypeError: O["Error"] is not a constructor`, in the frontend, 1 event at 15:24 UTC.
  - Known: the uw-stream reconnect storm and `ConnectionClosedError`.
  - Another session's area: detect-silent-boom skipped the ticker flow series once.
- **Neon restore window.** Full coverage arrives about 11-23. Verify with read-only `list_projects`: `history_retention_seconds` should be 604800.
- **Cleanup.**
  - `.worktrees/retire-fire-count-adj` is empty but held by VS Code.
  - Close its editor tabs or reload the window, then `rmdir` it. It contains no `node_modules` link.

### 4.12 Measure when the round-trip deduct is written (read-only, can start without a decision)

- **What.** The round-trip deduct may be a second input from after the fire in the stored tiers. #209 removed the first one, the fire-count adjustment.
  - `round_trip_score_deduct` (0 to −3, DTE ≤ 7 only) comes from `api/cron/evaluate-round-trip.ts`. It is based on the net ask-minus-bid share of the contract's volume in the 60 minutes after the fire, so it reflects selling after the fire, not price.
  - The cron runs every 10 minutes and evaluates fires 60–75 minutes old. A catch-up pass picks up older ones from the same day. By design, the deduct can't land until at least an hour after the fire.
  - The feed adds the deduct to the score before it sets the tier (`api/lottery-finder.ts` ~:327 and ~:374). A fire shows its full tier when it appears and can drop a tier about an hour later.
- **Why it matters.**
  - Tier tables use the final stored score, so they include a filter a trader can't apply when the fire appears.
  - The re-fire report's tier means, in realized %: adding the deduct on top of the final-count score moved tier 1 from −3.0 to −2.2 (+0.8) and tier 2 from −1.5 to −0.6 (+0.9). The fire-count adjustment had already added +1.4 to tier 1.
  - The deduct's effect on the raw score alone wasn't measured. Neither was the 60–75-minute timing: it comes from a code comment (report, "Train/serve skew and scoring").
- **Facts to account for.**
  - No column records when the deduct was written. The column is `NOT NULL DEFAULT 0`, so a fire not yet evaluated reads as no penalty. `round_trip_net_pct IS NULL` marks those fires.
  - Fires from before the cron went live (05-16) got their deduct from `scripts/backfill_round_trip_score.py`, weeks after the fact.
  - Before 10-02, Friday fires after about 15:05 ET were never evaluated (1,946 lottery fires in 30 days, per the cron's header comment). They read as no penalty. That leaves a Friday bias in any tier-by-weekday table from that period.
- **Method.**
  1. **Write time.** During one session, record each fire's `round_trip_net_pct` every 10 minutes using read-only SQL. Note the fire's age when the value first appears. Report the median, 90th percentile and maximum lag, and the share never evaluated by the next morning.
  2. **Tier history as seen at the fire.** Rebuild the tier tables from the score without the deduct, using true first fires and the same realized exit as the re-fire study. Compare them with the stored-score tables.
  3. **The deduct as an exit signal.** For fires whose deduct is ≤ −1, compare exiting at the minute the deduct lands with holding to the realized exit. This shows whether the deduct is worth more as a "get out" signal than as a tier input.
  - Use day-clustered CIs, as in 4.8.
- **Output.** A plain report to the owner. Keeping the deduct in the tier, showing it as a separate marker, or showing tiers as of the fire is the owner's call.
- **Result (2026-11-17): done.** Reports in the main checkout: `docs/tmp/round-trip-timing-2026-11-17/REPORT.md` (step 1) and `docs/tmp/roundtrip-tiers-2026-11-17/REPORT.md` (steps 2 and 3).
  - **Step 1.** The deduct lands a median 65.6 min after the fire (p99 71.1, max 80.9); 99.0% land on the first eligible 10-minute tick. No fire of 11-17 was left unevaluated.
  - **Step 2.** Tier 1 as seen at the fire averages −2.8% realized; 7.4% of it drops a tier when the deduct lands, and counting those drops makes the record read +0.9 pts better than what could be traded.
  - **Step 3.** As an exit signal the deduct is worth +0.13 pts per fire (CI −0.08..+0.33): deduct −1 fires still held are already down 28% when it lands and finish down 29%.
  - **Decision (owner, 2026-11-17/18):** the tier is fixed as of the fire on Lottery Finder and Silent Boom, computed at read time without the deduct, and the round-tripped pill stays as a separate marker. Spec `2026-11-17-freeze-tier-at-fire-design.md`, plan `docs/superpowers/plans/2026-11-18-freeze-tier-at-fire.md`.

## 5. Suggested order

1. **4.8 and 4.12.** Both are read-only and need no decision.
2. **4.1 and 4.2 as one code change.** They must land before any repair. Otherwise a rebuild keeps stale values and 03-26 still fails.
3. **4.3, then 4.4, then one feature rebuild covering every affected date.**
4. **4.5 and 4.6.** For each: backup, the owner's go, then a hand spot-check.
5. **4.7** at the next Take-It retrain. **4.9 and 4.10** whenever the owner wants them.

## 6. Constants

| Name | Value |
|---|---|
| NUMERIC(8,4) maximum | 9,999.9999 |
| Proposed NULL guard | \|ratio\| ≥ 10,000 |
| Real SPX/SPY ratio | about 10.01–10.04 |
| Placeholder SPX/SPY ratio | exactly 10.0000 |
| Feed tiers (active weights' cutoffs) | tier 1 ≥ 13, tier 2 ≥ 10 (quality-adjusted score) |
| Take-It default floor | 0.70 |
| Duplicate-day fingerprint: share of fires < 5 min after the same contract's previous fire | live ~6–7%, duplicate days 32–53% |
| Neon `history_retention_seconds` | 604,800 (7 days) |
