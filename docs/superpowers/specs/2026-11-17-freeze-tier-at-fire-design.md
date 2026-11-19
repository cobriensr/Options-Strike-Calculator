# Fix the Lottery Finder and Silent Boom tiers at the fire (design)

**Date:** 2026-11-17. **Decision:** owner, handoff item 4.12 (option 2, approach A, Silent Boom included).

## Why

The round-trip deduct is measured from the hour after a fire, so it can only land later:

- **Timing.** It lands a median 65.6 minutes after the fire (p99 71.1). Until then the row shows the tier without the deduct; when the deduct lands, the tier can drop. Source: `docs/tmp/round-trip-timing-2026-11-17/REPORT.md`.
- **Tier record.** 7.4% of tier-1 fires drop a tier when it lands. Counting those drops makes the tier's record read about 0.9 points better than what could be traded at the fire: tier 1 averages −2.8% as seen at the fire and −1.9% with the drops. Source: `docs/tmp/roundtrip-tiers-2026-11-17/REPORT.md`, step 2.
- **No forecast.** As an exit signal it is worth +0.13 points per fire (CI −0.08..+0.33). Fires that get a −1 deduct are already down about 28% when it lands. It describes what has already happened, not what will. Source: same report, step 3.

**Owner decision.** The tier is what you could act on at the fire, and the deduct stays visible as a separate marker. The same rule applies to Silent Boom.

## Goals

- **Lottery Finder.** These all use the score without the deduct:
  - the tier badge and the displayed score;
  - the `minScore` / `minTier` floor;
  - the ticker chip counts;
  - the detector's tier-1 monitor (the "no tier-1 fires for N days" Sentry alert).
- **Silent Boom.** The displayed tier, the displayed score and the `minScore` filter use the score without the deduct.
- **Nightly refit gates.** `feed_qas` judges a candidate on the tiers the feed shows, so it drops the deduct too.
- **The marker stays.** The amber "round-tripped −N" pill and the dimmed row stay on both feeds, with a tooltip that says what the deduct now means.

## Non-goals

- **The deduct itself.** Nothing changes in the deduct cron (`api/cron/evaluate-round-trip.ts`), its brackets or the stored column.
- **The database.** No migration and no production write.
- **Sort order.** It already sorts on raw `f.score`, fixed at the fire, since 2026-05-28.
- **Other tier inputs.** The inversion bonus, the feed cutoffs, the direction gate, the weights versions and the Take-It gate exemption are unchanged.
- **`combined_score`.** The generated column on both tables still includes the deduct. Nothing reads it (the builder confirms with a grep), and it is left in place.
- **`rawScore` API field.** The UI doesn't read it. After this change it equals the stored score before the zero floor. Left in place; noted to the owner as already-dead.

## Anti-goals

- **Copies drifting.** The Lottery copies of the tier formula must not disagree. A chip count or tier alert that differs from the feed is a silent bug, and the existing pin tests must keep all copies to one text.
- **Changing tonight's refit.** The refit's behavior must not change under the first live nightly refit run (2026-11-18, 07:15 UTC), which another session is checking.

## Approaches

- **A. Drop the deduct when the tier is computed (picked).** Read-time only. Past rows show their tier as at the fire, which is the "as seen" definition the step 2 study measured.
- **B. Store the tier on the row at insert (rejected).** Silent Boom already stores one. B also fixes the tier against weights promotions and changes in a ticker's inversion grade. It needs a migration and a rewrite of about 1.1M production rows, and the tier would stop following later cutoff changes. That is a bigger decision than the one made.

## Design

**Lottery Finder formula:** `qas = GREATEST(0, COALESCE(score, 0)) + INVERSION_BONUS_CASE`.

**Lottery Finder changes**

- `api/lottery-finder.ts`:
  - `qasExprText` drops the deduct term.
  - `toLotteryFire` computes `score = max(0, rawScore)`, and the tier comes from that.
  - Update the comments near `:323`, `:658` and `:1380-1440`.
  - Drop `round_trip_score_deduct` from the count CTE (`:796`) if nothing else in that query reads it.
  - The row SELECTs keep the column for the pill.
- `api/lottery-finder-ticker-counts.ts`: the chip-count floor drops the term, and the CTEs stop carrying the column.
- `api/cron/detect-lottery-fires.ts`: the tier-monitor SQL and its comment.
- `api/__tests__/lottery-qas-sql.ts`: `expectedQasSql`.
- `api/_lib/lottery-weights-schema.ts`: comment.

**Nightly refit gates**

- `ml/src/lottery_refit_gates.py`:
  - `feed_qas` drops the deduct.
  - `round_trip_score_deduct` leaves `_FEED_ONLY_COLUMNS`. `nightly/src/refit_step.py` builds its query from `FEED_COLUMNS`, so it stops selecting the column.
  - The `NULL_SCORE_QAS_MAX` comment gets simpler. The value is unchanged: a NULL score now reaches at most the largest bonus with no argument about the deduct's sign, and `FEED_CUTOFF_FLOOR` stays 6.
- `ml/tests/test_lottery_refit_gates.py`:
  - Update the pinned `qasExprText` body.
  - Remove the round-trip writer guards (both writers parsed, column writes pinned, spread entries rejected). They only kept the floor derivation valid while the deduct was in the qas, so they would pin a constraint nothing relies on. They were added today by another session; the owner is told.
- `nightly/README.md`: the floor-derivation paragraph (about `:600-610`).

**Silent Boom changes**

- `api/silent-boom-feed.ts`: the effective score drops the deduct; both `minScore` filters become `GREATEST(0, score)`; update the comments.
- `api/__tests__/silent-boom-feed.test.ts`: follows.

**UI changes**

- **Pill.** The label "round-tripped −N" and the dimming stay. The tooltip changes in `LotteryRow.tsx` and `SilentBoomRow.tsx`. Proposed text:
  - Lottery Finder: "Sellers dominated this contract in the hour after the fire (deduct −N). It describes what already happened: Lottery fires with a deduct were down about 28% on average when it landed, and it did not predict further loss. The tier is the one shown at the fire."
  - Silent Boom: the same text, with the 28% figure marked as measured on Lottery Finder fires.
- `types.ts` comments for `score`, `rawScore` and `roundTripScoreDeduct`, in both feeds.

**Tests that flip**

- The endpoint test "applies round_trip_score_deduct alone … scores raw − 2", and its Silent Boom twin, now assert:
  - the deduct leaves the score and tier unchanged;
  - `roundTripScoreDeduct` still passes through.

## Delivery

- **Build tonight.** Build and review in a worktree off `origin/main`.
- **Push later.** Push after 2026-11-18 15:00 CT, once the other session has checked the first nightly refit run. `ml/src/lottery_refit_gates.py` is a nightly watch path (`nightly/README.md:120`).
- **One push.** Everything goes in one push, because cross-language pin tests tie the copies together (the ml test reads `qasExprText` from `api/lottery-finder.ts`).
- **Gates.** `npm run review`, plus `npm run review:ml`, plus the nightly pytest suite.

## Left to the builder

- Final tooltip wording, keeping the facts above.
- Whether any other reader of the deduct turns up beyond the ones the 2026-11-17 grep found. If one does, it follows the same rule.
