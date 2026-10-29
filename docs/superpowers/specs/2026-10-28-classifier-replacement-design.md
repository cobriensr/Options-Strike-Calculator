# Replace the multileg classifier with the exchange's multi-leg flag

Status: approved by the owner 2026-10-28 (all five points of the recommendation). Evidence and the investigation trail: memory `project_classifier_assessment_2026_10_28.md`, scratch outputs in this session's `scratchpad/flagcheck/` and `scratchpad/takeitcheck/`.

## Intent

The Railway `classifier/` service was built to answer one question about the print behind each Lottery Finder or Silent Boom fire: is this a one-way bet, or one leg of a spread? That question matters. On 10-26 to 10-28, lottery fires whose anchor print was a spread leg reached +20% 37.6% of the time, against 50.7% for single-leg anchors. The gap holds at −9 pts within the same ticker, hour and day.

The classifier answers it badly and expensively:

- It agrees with the exchange's own multi-leg flag on only 40% of fires. It calls 65% of prints the exchange reports as single-leg a "structure".
- Its labels show no outcome separation: 48.6% vs 49.6%.
- It needs 2 replicas × 24 GB, and had 55 OOM restarts in the last 30 days.
- Nothing the trader sees reads its output. Live Take-It doesn't use it either; verified against the live model bundles.

The exchanges already report this on every print we store. `ws_option_trades.raw_payload->>'trade_code'` carries the OPRA condition. It matches UW's per-trade `multi_vol` tag that the original 76% study used on 99.97% of 24.4M prints. For 99.8% of flagged prints, the other legs printed on the same ticker in the same millisecond, which gives the spread's actual shape.

So: read the flag, find the sibling legs, show the trader a badge, and retire the classifier.

## Goals

1. Each new lottery fire and Silent Boom alert records whether its anchor print is single-leg, a multi-leg spread leg, or stock-tied, and for spread legs the other legs and a shape name.
2. The trader sees it on the alert as a badge, e.g. `spread leg · call vertical 726/727`.
3. One shared, correct list of multi-leg trade codes, used everywhere it is needed (API and uw-stream).
4. The classifier is gone: no calls, no service, no env vars, no dead code, no dead Take-It wiring.

## Non-goals

- Filtering, demoting or re-scoring fires based on the flag. The badge is information only until the outcome gap is re-measured on a few weeks of live data (owner's point 5).
- Adding the flag as a Take-It feature. That waits for a retrain that shows lift.
- Spread direction (debit vs credit, bought vs sold). UW's side tags on multi-leg legs are unreliable; working it out needs price/NBBO logic. Out of scope.
- Spreads entered one leg at a time. They aren't tagged; they will show as single-leg. Accepted.
- Backfilling the new columns for fires older than `ws_option_trades` retention (~2 days). History before ship stays NULL in the new columns.
- The separate Take-It one-hot scoring bug (memory `project_takeit_onehot_missing_bug.md`). The owner approved fixing it on 10-28. It ships as its own change, before this project's phases.

## Anti-goals (fails even if it "works")

- New columns that mix classifier-era labels with flag-derived values. The old columns keep their history and stop being written.
- Per-fire serial DB round-trips in the detect crons (rule R5). Anchor and sibling lookups are batched per cron tick.
- A NULL that can't be told apart from a failure. A missing anchor and a lookup error must be distinguishable in logs/Sentry, and the cron must not report `success` on a write failure (R4).
- Deleting the Railway service or env vars before the code has stopped calling them.

## Decisions already made

**Trade codes** (OPRA Pillar output spec, verified against live data). Replace every copy of the current list with one shared constant per language:

- Multi-leg: `mlat`, `mlet`, `mlft`, `masl`, `mesl`, `mfsl`, `mlct`, **`cbmo`** (added), **`mctp`** (added, my call).
  - `mctp` is a proprietary-product multilateral compression trade. It prints outside regular hours, so it can't anchor an intraday fire.
- Drop **`mfto`**. It is not an OPRA code and never matches.
- Stock-tied: `tlet`, `tlat`, `tlft`, `tlct`, plus **`tesl`, `tasl`, `tfsl`** (added, my call; OPRA: stock/options multi-leg against single legs). These are option legs of a stock+option order. Kept as a separate kind, not counted as multi-leg.
- None of `mctp`, `tesl`, `tasl` or `tfsl` occurred in 10-26→10-28 live data, so adding them doesn't move the live gates.

The copies to replace:
- `api/cron/detect-silent-boom.ts:117`
- `uw-stream/src/handlers/interval_ba.py:114`
- the comment lists in `api/_lib/silent-boom.ts`, `uw-stream/src/config.py`, and `uw-stream/tests/test_interval_ba.py`

The research scripts under `scripts/` keep their old lists. They are historical analyses; leave them alone.

The fix slightly changes Silent Boom's `multi_leg_share` and the uw-stream interval gate. That change was approved as point 4.

**Anchor print** (unchanged definition for lottery):
- Lottery: the highest `size × price` print on the fire's own option chain within trigger time ±30 s, `canceled = false`, `price > 0`, ties to the earliest.
- Silent Boom (my call): the highest `size × price` print on the alert's chain within its 5-minute bucket `[bucket_ct, bucket_ct + 5 min)`. The old ±30 s window was centred on the bucket start, not on the spike.

Use only prints already received at detect time. This matched the full-window anchor 98.9% of the time.

**Sibling legs:** prints on the same underlying ticker, at the exact same `executed_at`, carrying a multi-leg code. Do not widen to ±1 s; that picks up unrelated trades on busy tickers.

**A leg is one contract, not one print** (my call). Big spread orders often fill against several counterparties, giving several prints per leg in the same millisecond.
- Group all same-millisecond multi-leg prints on the ticker by option chain, the anchor's own chain included.
- Each group is one leg: summed size, volume-weighted price, and its trade code (the most common code if they differ).
- Shape rules and leg counts below apply to these grouped legs.

**Leg kind:** `single` | `multi_leg` | `stock_tied`. It comes from the anchor's trade code alone.

**Shape names** (my call). Computed from option type, strike, expiry and leg sizes of anchor + siblings:

| Legs | Rule | Shape |
|---|---|---|
| 2 | same type, same expiry, different strikes | `vertical` |
| 2 | same type, same strike, different expiries | `calendar` |
| 2 | same type, different strike and expiry | `diagonal` |
| 2 | call + put, same expiry, same strike | `straddle` |
| 2 | call + put, same expiry, different strikes | `combo` (strangle or risk reversal; can't tell without direction) |
| 3 | same type, same expiry, equally spaced strikes, sizes 1:2:1 | `butterfly` |
| 3 | anything else | `three_leg` |
| 4 | same expiry | `four_leg` |
| 4 | multiple expiries | `four_leg_multi_expiry` |
| 5+ | | `complex` (may merge two orders on busy tickers) |
| 1 | multi-leg code but no sibling found | `unpaired` (e.g. the other leg is stock or futures) |
| | everything not covered above | `other` |

**New columns** on both `lottery_finder_fires` and `silent_boom_alerts`. One migration, the next free id (192 at time of writing; re-check, other sessions add migrations). Update `api/__tests__/db.test.ts` per the CLAUDE.md migration rule.

| Column | Type | Contents |
|---|---|---|
| `anchor_ws_trade_id` | `uuid` | the anchor print |
| `anchor_trade_code` | `text` | the anchor's code |
| `anchor_leg_kind` | `text` | `single` / `multi_leg` / `stock_tied` |
| `spread_shape` | `text` | from the table above; NULL unless `multi_leg` |
| `spread_legs` | `jsonb` | array of `{option_type, strike, expiry, size, price, trade_code}`, anchor first, capped at 8 legs |

All nullable. NULL `anchor_leg_kind` means no anchor print was found.

**Old columns** (`inferred_structure`, `is_isolated_leg`, `match_confidence`, `pattern_group_id`): kept for history, no longer written. Dropping them is a separate, later decision.

**Badge** (owner decisions 10-28). Information only. No dimming, filtering or sorting changes.

*Silent Boom* (one row per alert):
- The new badge is worded as being about the trigger print, so it isn't confused with the existing "Spread-Confirmed" badge:
  - `multi_leg`: `trigger print: spread leg · <shape> <strikes>`, e.g. `trigger print: spread leg · put vertical 135/140`.
  - `stock_tied`: `trigger print: stock-tied leg`.
  - `single` or NULL: no badge.
- The existing green "Spread-Confirmed" badge (`multi_leg_share` 10–50%) stays unchanged. It measures the bucket's volume mix, a different thing. Its claimed edge gets re-measured in the follow-up, after the code-list fix.

*Lottery Finder* (one row per chain-day, latest fire wins, earlier fires in `historicalFires` / the reignites list):
- 10-26→10-28: 67% of rows fired more than once. 30% mixed spread-leg and single-leg fires, and 15% were spread-leg on every fire. A latest-fire-only badge would flicker.
- The row badge counts across the chain-day's fires: `spread leg on <k> of <n> fires · <shape> <strikes>`.
  - Shape and strikes come from the most recent spread-leg fire.
  - Shown when k ≥ 1.
  - When every fire is a spread leg it reads `spread leg on all <n> fires · …`.
- Each entry in the reignites list (`historicalFires` / `ReignitionSection`) gets a small spread-leg marker when that fire's anchor was `multi_leg` (`stock_tied` gets its own marker).
- The feed must therefore return per-fire `anchor_leg_kind` (and shape) in `historicalFires`, plus k and n for the row.

**Take-It:** remove the dead classifier wiring so a future retrain can't learn from columns that will now always be NULL:
- `takeit-features.ts` (the `inferred_structure` one-hot inputs, `is_isolated_leg`, `match_confidence`)
- `takeit-backfill-mapper.ts`
- `ml/src/takeit/train.py`
- `ml/src/takeit/build_training_set.py`

Live scores do not change. Verified: the live bundles have no classifier features.

**Calibration audit:** `api/cron/audit-takeit-calibration.ts` reports `pct_inferred_structure_classified`. Remove it. If anchor coverage is reported instead, put it inside `meta`, never as a new Axiom top-level key (CLAUDE.md Axiom rule).

## Phases

Each phase lands on main by itself and passes `npm run review` and the code-reviewer loop. Split any phase into commits of ≤5 files (owner rule). Work happens in a worktree off origin/main. Pushes that redeploy Railway services (uw-stream, classifier) happen only outside 08:30–15:00 CT.

1. **Shared code lists.**
   - Add `api/_lib/multileg-codes.ts` with the multi-leg and stock-tied lists.
   - Use it in `detect-silent-boom.ts`; fix the `silent-boom.ts` comments.
   - Fix `uw-stream/src/handlers/interval_ba.py` (and its config comment and test).
   - Tests: a code in each list is classified correctly; `mfto` is gone.
2. **Migration** for the five new columns on both tables, plus the `db.test.ts` update.
3. **Anchor + legs module.**
   - Add `api/_lib/anchor-legs.ts`, with a TDD table test:
     - a pure function from anchor + sibling rows to `{leg_kind, shape, legs}` covering every shape rule;
     - a batched SQL helper that takes the tick's fires and returns anchors and siblings in two queries.
   - Check `ws_option_trades` has an index serving (ticker, executed_at) and (option_chain, executed_at) lookups; use EXPLAIN on prod-size data. Add an index via the migration in phase 2 if not.
4. **Wire the detect crons.**
   - In `detect-lottery-fires.ts` and `detect-silent-boom.ts`, replace the `classifyAlertMultileg` call with the batched anchor-legs lookup and write the new columns. Stop writing the old four.
   - Tests cover:
     - the happy path;
     - lookup DB error (surfaced by name, cron not `success`);
     - no anchor (NULL, logged).
5. **Feeds and badge.**
   - Expose the new fields in `api/lottery-finder.ts` and `api/silent-boom-feed.ts`.
   - Extend the Zod schemas in `src/hooks/useLotteryFinder.ts` and `useSilentBoomFeed.ts`, and the types in `src/components/LotteryFinder/types.ts` and `SilentBoom/types.ts`.
   - Render the badge in both panels.
   - Tests: feed shape, schema, and badge text for each kind/shape.
6. **Remove the classifier from code.** Order matters:
   - Railway redeploys the classifier service whenever `classifier/**` or `ml/src/multileg_*.py` change.
   - So delete the `classifier/` folder and `ml/src/multileg_*.py` only AFTER the phase 7 service teardown. Everything else here can land before it.

   Delete:
   - `api/_lib/multileg-client.ts`, `api/_lib/multileg-classify-batch.ts` and their tests;
   - `CLASSIFIER_URL` / `CLASSIFIER_SHARED_SECRET` from `api/_lib/env.ts`, `.env.example` and the CLAUDE.md env table;
   - the Take-It and audit wiring above;
   - `classifier/`;
   - `ml/src/multileg_assembler.py`, `ml/src/multileg_patterns.py` and their tests (`ml/tests/test_multileg_*`). Only these and `ml/experiments/multileg-assembler-validation/run.py` import them. Keep that experiment's results files as the historical record; delete the now-broken `run.py`.
   - the `classifier` job and path filter in `.github/workflows/ci.yml`;
   - the classifier mentions in CLAUDE.md (architecture block, deployment section), `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/ONBOARDING.md` and `sidecar/README.md`.

   Also add a "superseded by" note at the top of the classifier specs (`meta-detectors-2026-05-16.md` multileg phase, `multileg-classifier-service-split-2026-05-28.md`, `classifier-oom-rework-2026-06-11.md`, `classifier-hardening-2026-05-28.md`, `classifier-cross-type-subbatch-2026-06-04.md`).
7. **Infra teardown.** Destructive: confirm with the owner immediately before.
   - Delete the Railway `Classifier` service (project `Theta-Options`, service id `0ca5cfb5…`).
   - Remove `CLASSIFIER_URL` and `CLASSIFIER_SHARED_SECRET` from Vercel (all environments) and from Railway.

   Only after phase 4 is deployed and a cron tick has run with no classifier calls.

   The owner approved decommissioning on 10-28 ("completely gone, decommissioned and removed from all code mentions without breaking anything"). Still confirm right before the irreversible delete.
8. **Verify it's gone.** The owner's acceptance bar is that the classifier is gone everywhere, with nothing broken.
   - Grep the whole repo for `classifier`, `multileg`, `CLASSIFIER_`, `inferred_structure`, `is_isolated_leg`, `match_confidence`, `pattern_group_id`. Every remaining hit must be:
     - historical (specs, the DB migration history, the old columns); or
     - the intentionally kept old DB columns.
   - Confirm in production:
     - `npm run review` is green;
     - the next detect-cron ticks write the new columns with no errors;
     - no `multileg.classify*` Sentry events after the cutover;
     - the Railway service list no longer has `Classifier`;
     - Vercel and Railway env have no `CLASSIFIER_*`.

**Follow-up (not a build phase):** after 2–3 weeks of live data, re-measure the spread-leg vs single-leg outcome gap. Use realized trail-30/10 as well as peak ≥ 20. Then decide on filtering or a Take-It feature.

## Data dependencies

- Reads `ws_option_trades` (`raw_payload->>'trade_code'`, `executed_at`, chain fields). Already populated by uw-stream for the 86-ticker universe.
- One new migration.
- No new env vars; two removed.
- No external APIs.

## Known side effects

- `ml/src/lottery_scoring.py:129` trains only on rows with `inferred_structure IS NULL`. After phase 4, every new row qualifies, so that filter stops meaning anything. Flag at the next rescore; not changed here.
- Silent Boom's `multi_leg_share` (a live Take-It feature) shifts slightly once `cbmo` counts and `mfto` is gone. Approved.

## Settled during the builder check

- `ws_option_trades` already has `(ticker, executed_at DESC)` and `(option_chain, executed_at DESC)` indexes (migration #109). Phase 3 still runs EXPLAIN but should need no new index. Next migration id was 192 on 10-28; re-check.
- Lookup errors in the detect crons report the existing `'partial'` status from `api/_lib/cron-instrumentation.ts`, never `'success'`.
- Phase 6 also removes:
  - the `/classifier` entry in `.github/dependabot.yml`;
  - classifier mentions in the untracked `.claude/` skills and agents.
- `scripts/replay-lottery-fires-2026-05-18.ts` imports `multileg-classify-batch.ts` and will break. Replay scripts are excluded from `tsconfig.scripts.json`, so the gate stays green. Delete that import's call site or the script (builder's call).
- Silent Boom's Aggressive Premium filter (`multi_leg_share < 10%` = single-leg) is untouched. No filtering changes in this project.

## Left to the builder

- Exact SQL shape of the batched lookups (e.g. `unnest` of chain/window tuples). It must stay within R5 and use an index.
- Badge styling: use the existing tag/pill primitives in `src/components/ui` and theme tokens, and match neighbouring tags.
- How to format strikes in the badge (trailing zeros, ordering low→high).
- Whether `spread_legs` also carries `side`. It's allowed as a raw field, but don't derive direction from it.
- Logging/Sentry naming for the new lookup, following `monitoring-expert` conventions.
