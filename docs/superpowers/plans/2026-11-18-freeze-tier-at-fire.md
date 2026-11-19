# Fix the Lottery Finder and Silent Boom tiers at the fire: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both feeds and the nightly refit gate compute the tier, the displayed score and the score filters from the score as it stood at the fire. The round-trip deduct is left out of all of them and stays visible as the round-tripped pill.

**Architecture:** The change is read-time only. The `round_trip_score_deduct` term comes out of every copy of the tier formula:
- the feed's `qasExprText`, and its two hand-written SQL copies (the chip counts and the detector's tier monitor);
- the `toLotteryFire` mapper;
- Silent Boom's effective score and its `minScore` SQL;
- `feed_qas` in the refit gates.

The shared pins (`expectedQasSql` and the ml test's `qasExprText` body) change first, so every copy fails its test until it follows. There is no migration and no database write.

**Tech Stack:**
- TypeScript (Vercel functions, vitest);
- React 19 with Testing Library and jest-dom;
- Python (numpy and pandas, pytest).

**Spec:** `docs/superpowers/specs/2026-11-17-freeze-tier-at-fire-design.md` (owner-approved 2026-11-18).

## Global Constraints

- **Lottery formula,** exactly: `qas = GREATEST(0, COALESCE(score, 0)) + INVERSION_BONUS_CASE`.
- **Silent Boom:**
  - `effectiveScore = rawScore == null ? null : Math.max(0, rawScore)`;
  - both `minScore` predicates read `GREATEST(0, score) >= …`.
- **Unchanged:**
  - the deduct cron and its brackets;
  - the stored column and `combined_score`;
  - the `rawScore` and `roundTripScoreDeduct` API fields;
  - the sort order;
  - the inversion bonus and the feed cutoffs (13 and 10 in the seed);
  - the direction gate and the Take-It gate exemption;
  - `NULL_SCORE_QAS_MAX` (5) and `FEED_CUTOFF_FLOOR` (6).
- **The row SELECTs keep `round_trip_net_pct` and `round_trip_score_deduct`.** The pill needs them.
- **The database:** no migration and no production write.
- **Where to work:**
  - Worktree `F:/dev/strike-calculator/.worktrees/freeze-tier-at-fire`, branch `feat/freeze-tier-at-fire`, made off origin/main.
  - Its `node_modules` is a junction to the main checkout.
- **Python gates** use the main checkout's venvs, run from the worktree:
  - `cd ml && make format test-cov PYTHON=F:/dev/strike-calculator/ml/.venv/Scripts/python.exe`
  - `cd nightly && F:/dev/strike-calculator/nightly/.venv/Scripts/python.exe -m pytest -q`
- **Every commit is gated.** That includes docs-only and Python-only commits: run `npm run review` before each one.
- **No dates in code comments for this change.** Cite the spec file instead.
- **One push for the whole branch, never between tasks.** Push only when the time is after 15:00 CT and outside 07:15–12:30 UTC, because `ml/src/lottery_refit_gates.py` is a nightly watch path.

## Review Focus

1. **A NULL-score Lottery fire with a deduct.** Score stays null, its qas is the bonus alone, and the tier is tier 3. Covered in Task 1.
2. **A direction-gated Silent Boom alert exempted by Take-It (≥ 0.70) with a deduct.** It shows the tier of its stored score, and the deduct changes nothing. Covered in Task 3.
3. **A Silent Boom alert exactly at the `minScore` floor with a −3 deduct.** The SQL keeps it, and it shows the floor's tier. Covered in Task 3.
4. **A refit feed frame that still has a `round_trip_score_deduct` column** (an old export). It scores the same as one without the column. Covered in Task 2.
5. **The feed's count query.** The pagination total must not depend on the deduct: the count SQL no longer names the column. Covered in Task 1.

---

### Task 0: Setup (main session, already done)

- [x] Worktree created, with the `node_modules` junction.
- [x] Design doc moved in from the main checkout.
- [x] This plan saved.
- [x] Handoff doc `docs/superpowers/specs/2026-11-16-handoff-lottery-scoring-and-data-repairs.md` updated with the 4.8 and 4.12 results.

These three docs are uncommitted. Task 1 commits them (Step 7).

### Task 1: Lottery Finder tier copies (feed, chip counts, detector monitor)

This task touches eight files, above the usual five. `expectedQasSql` holds the three SQL copies to one text, so they and their tests must pass one gate run together. The eighth file is a one-line comment on the same formula.

**Files:**
- Modify: `api/__tests__/lottery-qas-sql.ts:26-35`
- Modify: `api/lottery-finder.ts`:
  - comments at :177-183, :319-345, :655-664, :773, :836-838, :1382-1427, :1443-1449 and :1521-1522;
  - code at :364-373 (`qasExprText`), :796 (count CTE) and :1434 (mapper).
- Modify: `api/__tests__/lottery-finder-endpoint.test.ts`, at :629-660, :1593-1712 and :2535-2547.
- Modify: `api/lottery-finder-ticker-counts.ts`, at :169-174, :212 and :227-241.
- Modify: `api/__tests__/lottery-finder-ticker-counts.test.ts`, at :490-497 and :583.
- Modify: `api/cron/detect-lottery-fires.ts`, at :599, :1349-1389 and :1553.
- Modify: `api/__tests__/detect-lottery-fires.test.ts`, at :656-663 and :740-741.
- Modify: `api/_lib/lottery-weights-schema.ts:137-141` (comment only).

**Interfaces:**
- **Produces: the `qasExprText` body,** exactly. Task 2 pins it, comparing with whitespace squashed:
  ```ts
  function qasExprText(fireAlias: QasFireAlias): string {
    if (!(QAS_FIRE_ALIAS_WHITELIST as readonly string[]).includes(fireAlias)) {
      throw new Error(`qasExprText: invalid fire alias "${fireAlias}"`);
    }
    return (
      `(GREATEST(0, COALESCE(${fireAlias}score, 0)) ` +
      `+ ${INVERSION_BONUS_CASE_SQL})`
    );
  ```
- **Produces: `expectedQasSql(alias)`.** It returns `squashSql(`GREATEST(0, COALESCE(${alias}score, 0)) + ${INVERSION_BONUS_CASE_SQL}`)`.

**Steps:**

- [ ] **Step 1: Move the shared pin.**
  - Set `expectedQasSql` to the text above, and its doc comment to `GREATEST(0, score) + the inversion bonus CASE`.
  - Run `npx vitest run api/__tests__/lottery-finder-endpoint.test.ts api/__tests__/lottery-finder-ticker-counts.test.ts api/__tests__/detect-lottery-fires.test.ts`.
  - Expected: FAIL in three places, because each copy still adds the deduct:
    - FIX C in lottery-finder-endpoint;
    - FIX D in ticker-counts;
    - "feed-tier monitor SQL computes the same qas…" in detect-lottery-fires.

- [ ] **Step 2: Rewrite the feed endpoint tests** (`lottery-finder-endpoint.test.ts`). The default `ROW` is inversion quintile 5 (+5).
  - **:629 FIX C.**
    - Rename it to say `GREATEST(0, score) + inversion CASE`.
    - Add `expect(countSql).not.toContain('round_trip_score_deduct');`.
  - **:1593.**
    - Rename it to `keeps the tier shown at the fire when a -3 deduct lands (score 7, Q5 stays tier2)`.
    - Keep the row: score 7, net_pct `'-0.65'`, deduct −3.
    - Expect `{ score: 7, rawScore: 7, roundTripNetPct: -0.65, roundTripScoreDeduct: -3, qualityAdjustedScore: 12, scoreTier: 'tier2' }`.
  - **:1629.**
    - Rename it to `keeps tier1 when a -3 deduct lands on a score of 8 (qas 13)`.
    - Expect `{ score: 8, qualityAdjustedScore: 13, inversionQuintile: 5, scoreTier: 'tier1' }`.
  - **:1683.**
    - Rename it to `floors a negative stored score at 0`.
    - Row: score −2, deduct 0, net_pct null.
    - Expect `{ score: 0, rawScore: -2, qualityAdjustedScore: 5, scoreTier: 'tier3' }`.
  - **New, after :1683:** `a NULL-score fire with a deduct keeps a null score and stays tier3`.
    - Row: score `null`, deduct −3, net_pct `'-0.70'`.
    - Expect `{ score: null, rawScore: null, roundTripScoreDeduct: -3, qualityAdjustedScore: 5, scoreTier: 'tier3' }`.
  - **:2535.**
    - Rename it to `ignores round_trip_score_deduct: a chain that round-tripped keeps its raw score`.
    - Expect `{ rawScore: 20, roundTripScoreDeduct: -2, score: 20 }`.

- [ ] **Step 3: Chip-count test** (`lottery-finder-ticker-counts.test.ts`).
  - :490: rename it to say `GREATEST(0,score)+inversion CASE`.
  - :583: change it to `expect(sql).not.toContain('round_trip_score_deduct');`.

- [ ] **Step 4: Detector test** (`detect-lottery-fires.test.ts`).
  - :656-663: the comment now says the qas is `GREATEST(0, score) + inversion bonus`.
  - After :741, add `expect(inlined).not.toContain('round_trip_score_deduct');`.

- [ ] **Step 5: Run the three test files, then implement.**
  - Run the three files. Expected: FAIL on Steps 2–4.
  - **`qasExprText`:** the body from Interfaces.
  - **Count CTE (:796):** `score,` with the deduct column dropped. After the change, nothing in that query reads it.
  - **`toLotteryFire`:**
    - Keep `rtDeduct`; it still feeds `roundTripScoreDeduct`.
    - `const score = rawScore == null ? null : Math.max(0, rawScore);`
  - **`lottery-finder-ticker-counts.ts`:**
    - Drop `round_trip_score_deduct` from both CTE select lists (:174, :212).
    - The floor becomes `GREATEST(0, COALESCE(cd.score, 0)) + ${db.unsafe(INVERSION_BONUS_CASE_SQL)}`.
  - **Detector monitor SQL:** `(GREATEST(0, COALESCE(f.score, 0)) + ${db.unsafe(INVERSION_BONUS_CASE_SQL)}) AS qas`.
  - **Comments:**
    - Every listed comment that states the formula says `GREATEST(0, score) + inversion bonus`.
    - Where a comment explained the deduct's role, write one sentence instead: the deduct is left out so the tier is the one shown at the fire (cite the spec), and it still drives the round-tripped pill.
    - `rawScore` (:1521): the stored score before the zero floor; no UI reads it.
    - The stale pointer `api/lottery-finder.ts:417-433` (:1403) now names the score-sort comment in the rows query.
    - The stale "combined_score + per-ticker inversion bonus" (:1443-1449) now says the qas is the floored stored score plus the inversion bonus.

- [ ] **Step 6: Verify.**
  - Run the three files. Expected: PASS.
  - Run `grep -n "round_trip_score_deduct" api/lottery-finder.ts api/lottery-finder-ticker-counts.ts api/cron/detect-lottery-fires.ts`. Expected: only these remain:
    - the `FireRow` field (:185);
    - the two row SELECTs (:747, :1156);
    - the mapper's `rtDeduct` read.
  - Run `grep -rn "combined_score" api src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v db-migrations`. Expected: comments only. This confirms the spec's claim that nothing reads the column.

- [ ] **Step 7: Gate and commit.**
  - Run `npm run review`. Expected: green.
  - Commit the docs first, then the code:
  ```bash
  git add docs/superpowers/specs/2026-11-17-freeze-tier-at-fire-design.md docs/superpowers/plans/2026-11-18-freeze-tier-at-fire.md docs/superpowers/specs/2026-11-16-handoff-lottery-scoring-and-data-repairs.md && git commit -m "docs(lottery): Spec and plan to fix the tier at the fire; record handoff 4.8 and 4.12 results"
  git add api/__tests__/lottery-qas-sql.ts api/lottery-finder.ts api/__tests__/lottery-finder-endpoint.test.ts api/lottery-finder-ticker-counts.ts api/__tests__/lottery-finder-ticker-counts.test.ts api/cron/detect-lottery-fires.ts api/__tests__/detect-lottery-fires.test.ts api/_lib/lottery-weights-schema.ts && git commit -m "fix(lottery): Fix the feed tier at the fire by leaving the round-trip deduct out"
  ```
  - After this commit, `ml/tests/test_lottery_refit_gates.py` fails, because it pins the old body. Task 2 fixes it, which is why nothing is pushed between tasks.

### Task 2: The nightly refit gates follow the feed

**Files:**
- Modify: `ml/src/lottery_refit_gates.py`, at :101-111 (comment), :119-127 and :250-287.
- Modify: `ml/tests/test_lottery_refit_gates.py`, at:
  - :152, :224-233, :249-262 and :441-557;
  - :678-793;
  - delete :695-696, and delete :796 through :1263, which ends just before `@pytest.mark.parametrize("reach", [3, 5])`.
- Modify: `nightly/tests/test_refit_step.py`, at :143 and :2038.
- Modify: `nightly/README.md:605-616`.

**Interfaces:**
- Consumes: Task 1's `qasExprText` body.
- Produces:
  - `FEED_COLUMNS == SCORE_COLUMNS + ("direction_gated", "inversion_quintile")`. `nightly/src/refit_step.py` builds its SELECT from this and needs no code change.
  - `feed_qas(scores, feed)` keeps its signature. It now computes `np.maximum(0.0, score) + bonus`.

**Steps:**

- [ ] **Step 1: Confirm the break.**
  - Run `cd ml && make test-cov PYTHON=F:/dev/strike-calculator/ml/.venv/Scripts/python.exe`.
  - Expected: FAIL in `test_feed_qas_mirrors_the_feeds_displayed_score_sql` and in `test_the_feed_qas_expression_is_the_one_the_floor_was_derived_from`.

- [ ] **Step 2: Rewrite the tests.**
  - **`QAS_EXPR_TEXT_BODY`:** Task 1's body.
  - **`test_feed_qas_mirrors_the_feeds_displayed_score_sql`:**
    - Fragments: `"(GREATEST(0, COALESCE(${fireAlias}score, 0)) "` and `"+ ${INVERSION_BONUS_CASE_SQL})"`.
    - Add `assert "round_trip" not in body`.
  - **`test_an_extra_qas_term_fails_the_pin_instead_of_leaving_the_floor_stale`:**
    - New ids: `["inside GREATEST", "deduct put back", "before the bonus", "renamed"]`.
    - The first two cases, as (old, new, reason):
      - `("COALESCE(${fireAlias}score, 0)) `", "COALESCE(${fireAlias}score, 0) + 1) `", "no longer the expression")`
      - `("COALESCE(${fireAlias}score, 0)) `", "COALESCE(${fireAlias}score, 0) + COALESCE(${fireAlias}round_trip_score_deduct, 0)) `", "no longer the expression")`
    - The last two cases are unchanged.
  - **`_stale_floor` message:** "...It holds only while the feed's qas is GREATEST(0, score) plus the inversion bonus: revisit NULL_SCORE_QAS_MAX, and so FEED_CUTOFF_FLOOR, before this passes."
  - **`test_the_floor_is_derived_from_the_largest_qas_a_null_score_fire_can_reach`:**
    - Its comment says a NULL-score fire gets `GREATEST(0, 0) + inversion bonus`.
    - Drop the deduct sentence.
  - **Remove the round-trip writer guards.**
    - Delete `EVALUATE_ROUND_TRIP` and `BACKFILL_ROUND_TRIP`.
    - Delete everything from the `# \`round_trip_score_deduct\` has two writers` comment (:796) through `test_a_bad_backfill_deduct_fails_the_guard_instead_of_leaving_the_floor_stale` (:1262).
    - Keep `_squash`, `_stale_floor` and `LOTTERY_FINDER`: the body pin still uses them.
  - **`test_feed_columns_extend_the_score_columns`:**
    - Expect `lw.SCORE_COLUMNS + ("direction_gated", "inversion_quintile")`.
    - Add `assert "round_trip_score_deduct" not in g.FEED_COLUMNS`.
  - **Helpers:**
    - `make_feed_frame`: drop the deduct line.
    - `_sql_qas(score, quintile)`: `max(0, score or 0)` plus the bonus.
    - `_feed` and `_row(gated=False, quintile=3)`: drop the deduct.
  - **`test_feed_qas_floors_at_zero_before_the_bonus`:**
    - Scores `[-1, -1, -1, 1]`, quintiles 5, 4, 3, 3.
    - Expect `[5.0, 3.0, 0.0, 1.0]`.
  - **`test_feed_qas_reads_a_null_deduct_and_odd_quintiles_as_zero`:**
    - Rename it to `test_feed_qas_reads_odd_quintiles_as_zero`.
    - Quintiles 3, 0, 6 and 3.5, score 7 each. Expect `[7.0] * 4`.
  - **`test_feed_qas_ignores_a_fire_count_adjustment_column`:**
    - Rows: `[_row(quintile=3), _row(quintile=4), _row(quintile=5)]`, scores `[12, 12, 2]`.
    - Expect `[12.0, 15.0, 7.0]`.
  - **New, Review Focus 4: `test_feed_qas_ignores_a_round_trip_deduct_column`.**
    - Same rows and scores as the fire-count test.
    - The stale frame adds `round_trip_score_deduct = [-3, -1, None]`.
    - It equals the plain frame, and both equal `[12.0, 15.0, 7.0]`.
  - **Random-rows transliteration test:** drop the deduct draw.
  - **`nightly/tests/test_refit_step.py`:** remove the `"round_trip_score_deduct"` keys at :143 and :2038.

- [ ] **Step 3: Run to see the new tests fail.**
  - Run the ml tests.
  - Expected: FAIL on the `FEED_COLUMNS`, floor and ignore-column tests.

- [ ] **Step 4: Implement.**
  - **`_FEED_ONLY_COLUMNS = ("direction_gated", "inversion_quintile")`.** Its comment says "the two the feed adds".
  - **`feed_qas`:**
    - Drop the `round_trip` line, so `qas = np.maximum(0.0, score) + bonus`.
    - The docstring formula becomes `GREATEST(0, COALESCE(score, 0)) + CASE …`.
    - Drop "A NULL deduct counts as 0".
  - **The `NULL_SCORE_QAS_MAX` comment.**
    - The feed gives a NULL-score fire `GREATEST(0, COALESCE(score, 0)) + inversion bonus`, which is 0 plus the bonus, so its largest qas is the largest bonus.
    - A test pins the `qasExprText` body.
    - The round-trip deduct was left out when the feed fixed its tier at the fire (cite the spec), and the fire-count term was retired before that.
    - The value is unchanged.
  - **`nightly/README.md` :605-616.**
    - Replace the deduct clause with "the score counts as 0, the zero floor comes before the inversion bonus, and the bonus adds up to 5".
    - Add one sentence: the round-trip deduct was left out of the feed's qas when the feed fixed its tier at the fire, so it no longer bears on this floor.

- [ ] **Step 5: Verify.**
  - `cd ml && make format test-cov PYTHON=…`: PASS, and coverage stays at least 70.
  - Nightly pytest: PASS.
  - `grep -rn "round_trip" ml/src/lottery_refit_gates.py nightly/src nightly/tests`: only the history comment remains.

- [ ] **Step 6: Gate and commit.**
  - Run `npm run review`.
  - Commit `ml/src/lottery_refit_gates.py ml/tests/test_lottery_refit_gates.py nightly/tests/test_refit_step.py nightly/README.md` with the message `fix(ml): Leave the round-trip deduct out of the refit gates' feed qas`.

### Task 3: Silent Boom

**Files:**
- Modify: `api/silent-boom-feed.ts`:
  - comments at :94-98, :148-159 and :605-610;
  - code at :465, :532 and :616-617.
- Modify: `api/__tests__/silent-boom-feed.test.ts`, at :180-255, :467-475 and :1218-1283, plus one new test after the gate-exemption test at :1289.
- Modify: `src/components/SilentBoom/types.ts:145-154` (comments only).

**Interfaces:**
- Consumes: nothing from Tasks 1 and 2. Silent Boom's tier is `silentBoomScoreTier` (tier 1 at 21 or more, tier 2 at 8 or more), from `api/_lib/silent-boom-score.ts`.

**Steps:**

- [ ] **Step 1: Rewrite the tests.**
  - **:180.**
    - Rename it to `keeps the stored tier when a -3 deduct lands (score 10 stays tier2)`.
    - Expect `{ score: 10, rawScore: 10, roundTripNetPct: -0.75, roundTripScoreDeduct: -3, scoreTier: 'tier2' }`.
  - **:215.**
    - Rename it to `keeps tier1 when a -3 deduct lands on a score of 23`.
    - Expect `{ score: 23, scoreTier: 'tier1' }`.
  - **:236:** delete it. It is now the same case as :215.
  - **:472 and :1243.**
    - The literal becomes `'GREATEST(0, score) >='`.
    - Add `expect(sqlText).not.toContain('score + COALESCE(round_trip_score_deduct');`.
    - Rename :1218 to say `GREATEST(0, score)`.
  - **:1253, Review Focus 3.**
    - Rename it to `keeps an alert at the minScore floor, and its tier, when a -3 deduct lands`.
    - Row: score 21, `score_tier: 'tier1'`, deduct −3, net_pct `'-0.6'`, with `minScore: '21'`.
    - Expect score 21 and `scoreTier` `'tier1'`.
  - **New, after the test at :1289 (Review Focus 2):** `gated TAKE-IT-exempt alert with a deduct shows the tier of its stored score`.
    - Row: score 23, `score_tier: 'tier1'`, `direction_gated: true`, `takeit_prob: '0.72'`, deduct −3.
    - Expect `{ score: 23, scoreTier: 'tier1' }`.

- [ ] **Step 2: Run to see the tests fail.**
  - Run `npx vitest run api/__tests__/silent-boom-feed.test.ts`.
  - Expected: FAIL on the rewritten tests.

- [ ] **Step 3: Implement.**
  - `effectiveScore = rawScore == null ? null : Math.max(0, rawScore)`.
  - Both `minScore` predicates: `GREATEST(0, score) >= ${q.minScore ?? null}::int`.
  - **Comments:**
    - The row field, the response doc and the mapper comment say the deduct is shown, not applied: the tier is the one shown at the fire (cite the spec).
    - `rawScore`: the stored score before the zero floor.
  - **`SilentBoom/types.ts`:**
    - `score`: the stored score floored at 0, whose tier is the one shown at the alert.
    - `rawScore`: the stored score before the zero floor; no UI reads it.
    - `roundTripScoreDeduct`: the cron's bracket, written about 65 minutes after the alert. It drives the round-tripped pill and the dimmed row, and does not change `score` or the tier. Drop the stale "Hide round-tripped" chip reference.

- [ ] **Step 4: Verify.**
  - Run the file. Expected: PASS.
  - `grep -n "round_trip_score_deduct" api/silent-boom-feed.ts`: only the row field, the row SELECT and the `rtDeduct` read remain.

- [ ] **Step 5: Gate and commit.**
  - Run `npm run review`.
  - Commit the three files with the message `fix(silent-boom): Fix the tier at the fire by leaving the round-trip deduct out`.

### Task 4: The round-tripped pill's tooltip

**Files:**
- Modify: `src/components/LotteryFinder/LotteryRow.tsx:682`
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx:602`
- Modify: `src/__tests__/LotteryRow.test.tsx:1674-1690`
- Modify: `src/__tests__/SilentBoomRow.test.tsx:1191-1200`
- Modify: `src/components/LotteryFinder/types.ts:193-201` (comments only).

**Tooltip copy, exact.** `${roundTripDeduct}` is the number, so it renders as `-2`. The 28% and 29% figures are for −1 fires still held when the deduct landed (`docs/tmp/roundtrip-tiers-2026-11-17/REPORT.md`, step 3), which is why the copy names −1.
- **Lottery Finder:**
  `Sellers dominated this contract in the hour after the fire (deduct ${roundTripDeduct}). It reports a loss that already happened: Lottery fires still held when a -1 deduct landed were already down about 28% and finished down about 29%. The tier is the one shown at the fire.`
- **Silent Boom:**
  `Sellers dominated this contract in the hour after the alert (deduct ${roundTripDeduct}). It reports a loss that already happened: on Lottery Finder fires, those still held when a -1 deduct landed were already down about 28% and finished down about 29%. The tier is the one shown at the alert.`
- **Superseded in the final fix wave.** The shipped copy leads with "Sellers outweighed buyers… finished about where they stood then", because "reports a loss that already happened" is false at −3. The spec's "UI changes" section has the shipped text and the reason.

**Steps:**

- [ ] **Step 1: Extend the two "dims the container…" tests.**
  - Lottery Finder:
    ```ts
    expect(pill).toHaveAttribute('title', expect.stringContaining('(deduct -2)'));
    expect(pill).toHaveAttribute('title', expect.stringContaining('The tier is the one shown at the fire.'));
    expect(pill.getAttribute('title')).not.toContain('lower-EV');
    ```
  - Silent Boom: the same three, with `'The tier is the one shown at the alert.'`, plus `expect.stringContaining('on Lottery Finder fires')`.
  - Run `npx vitest run src/__tests__/LotteryRow.test.tsx src/__tests__/SilentBoomRow.test.tsx`. Expected: FAIL.

- [ ] **Step 2: Implement.**
  - Replace the two `title` strings with the copy above. The pill label `round-tripped {roundTripDeduct}` and the dimming are unchanged.
  - Fix the `LotteryFinder/types.ts` comments the same way as Task 3's `SilentBoom/types.ts`.

- [ ] **Step 3: Verify.** Run the two files. Expected: PASS.

- [ ] **Step 4: Gate and commit.**
  - Run `npm run review`.
  - Commit the five files with the message `fix(ui): Say in the round-tripped tooltip that the tier is the one at the fire`.

### Delivery (main session)

- [ ] **Branch review.** Run a whole-branch `code-reviewer` pass on `origin/main...HEAD` and apply its findings.
- [ ] **Rebase.**
  - Rebase onto a fresh `origin/main`.
  - If the rebase brings in changes to a touched file, re-run `npm run review`, the ml gate and the nightly pytest.
- [ ] **Push window.** Push only when it is after 15:00 CT and outside 07:15–12:30 UTC.
  - Tonight, that means before 01:15 CT (07:15 UTC), if the branch is reviewed by then.
  - Otherwise, after 15:00 CT on 2026-11-19.
  - Either way, confirm no nightly run is in progress first.
- [ ] **Before the push:** `git status` in the main checkout shows no untracked copy of the spec or the plan. The fast-forward hook would conflict on one.
- [ ] **After the push, confirm:**
  - CI is green: App, ML and nightly gates.
  - The Vercel production deploy is READY.
  - The Railway nightly deploy succeeded.
  - The next morning: the nightly `lottery-refit` step completes, with no Sentry error.
- [ ] **Clean up.** Remove the worktree: delete the `node_modules` junction with `[System.IO.Directory]::Delete(path, $false)`, then run `git worktree remove`.
