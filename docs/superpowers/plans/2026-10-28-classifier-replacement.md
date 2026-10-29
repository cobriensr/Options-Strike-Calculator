# Classifier Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the live Take-It one-hot bug, then replace the Railway multileg classifier with the exchange's multi-leg trade code + same-millisecond sibling legs, show it as a badge, and remove every trace of the classifier.

**Architecture:**
- A pure TS module (`api/_lib/anchor-legs.ts`) turns an anchor print and its same-millisecond prints into `{legKind, shape, legs}`.
- A batched SQL helper in the same module finds anchors and siblings in `ws_option_trades` for a whole cron tick in two queries.
- The detect crons write five new columns. The two feeds expose them, and a shared formatter renders the badge text in both panels.
- The classifier service, client, env vars and dead Take-It wiring are deleted last.

**Tech Stack:** TypeScript (Vercel Functions, Node 24), Neon Postgres via `@neondatabase/serverless`, React 19 + Tailwind 4, Zod 4, Vitest; Python 3 (uw-stream, ml).

**Spec:** `docs/superpowers/specs/2026-10-28-classifier-replacement-design.md` (read it first; it carries the why, the decisions and the shape table).

## Global Constraints

- Every task: TDD where CLAUDE.md requires it; `npm run review` green before each commit; code-reviewer verdict `pass` before committing.
- One implementer stream at a time. Work in the worktree `F:\dev\strike-calculator\.worktrees\classifier-replacement` (branch `classifier-replacement-2026-10-28` off origin/main). Land each task on main by rebasing onto origin/main and `git push origin HEAD:main`.
- Commits: conventional `type(scope): Subject`, explicit-path staging, footer `Spec: docs/superpowers/specs/2026-10-28-classifier-replacement-design.md`, plus the harness Co-Authored-By line.
- Multi-leg codes, exactly: `mlat, mlet, mlft, masl, mesl, mfsl, mlct, cbmo, mctp`. Stock-tied codes, exactly: `tlet, tlat, tlft, tlct, tesl, tasl, tfsl`. `mfto` appears nowhere.
- Legs are grouped by option chain (summed size, volume-weighted price, modal code). At most 8 legs are stored, anchor's chain first.
- Lottery anchor: highest `size*price` print on the fire's chain in `[trigger_time_ct − 30 s, trigger_time_ct + 30 s)`, `canceled = false`, `price > 0`, tie → earliest `executed_at`.
- Silent Boom anchor: the same, over `[bucket_ct, bucket_ct + 5 min)`.
- Siblings: same `ticker`, `executed_at` in `[anchor_ms, anchor_ms + 1 ms)`, multi-leg code, `canceled = false`. Never widen the window.
- Badge text:
  - Lottery row: `spread leg on <k> of <n> fires · <desc>`, or `spread leg on all <n> fires · <desc>` when k = n.
  - Silent Boom: `trigger print: spread leg · <desc>`; stock-tied: `trigger print: stock-tied leg`.
  - Lottery stock-tied (my call, mirrors SB): `stock-tied leg` on the row when k = 0 and the latest fire is stock-tied.
- No filtering, dimming or sorting changes. UW-derived data stays behind owner-or-guest auth.
- Deploy timing:
  - Pushes touching `uw-stream/` or `classifier/` redeploy Railway: only outside 08:30–15:00 CT.
  - Pushes changing the detect crons or feeds: prefer outside 08:30–15:00 CT.
- Neon returns NUMERIC/BIGINT as strings and DATE as `Date`. Normalise strike → number and expiry → `YYYY-MM-DD` string.

## Review Focus

1. Anchor whose `trade_code` is null or an unknown code → `legKind` follows the code (`null` for null, `'single'` for unknown), no badge, no crash. Test in Task 4.
2. One spread leg filled in several same-millisecond prints → a single leg with summed size, so a 2-strike vertical is `vertical`, not `four_leg`. Test in Task 4.
3. Two unrelated orders on a busy ticker in the same millisecond → 5+ grouped contracts → `complex`, not a misnamed shape. Test in Task 4.
4. A fire with no print in its window (common for Silent Boom) → all five columns NULL, counted as "no anchor", not as a lookup failure, cron stays `success`. Tests in Tasks 5 and 6.
5. A database error during the batched lookup → fires still insert with NULL columns, Sentry/log names the lookup, cron reports `partial`. Tests in Tasks 5 and 6.

---

### Task 0: Take-It one-hot fix

**Files:**
- Modify: `api/_lib/takeit-features.ts:540-559` (`expandOneHotCategoricals`)
- Test: `api/__tests__/takeit-features.test.ts`, `api/__tests__/takeit-score.parity.test.ts`

**Interfaces:**
- Produces: `expandOneHotCategoricals(bundle, raw, ticker): Record<string, number>`. Same signature as today, but it now returns a value (0 or 1) for every feature column whose name starts with `${col}_` for a `col` in `bundle.categorical_cols`, or with `ticker_bucket_`.

- [ ] **Step 1: Write the failing tests**
  - In `takeit-features.test.ts`, `it('emits 0 for every inactive one-hot column')`. Use a bundle with `categorical_cols: ['option_type','tod']` and `feature_cols` containing `option_type_C, option_type_P, tod_AM_open, tod_PM, ticker_bucket_QQQ, ticker_bucket_OTHER, score`. Input `option_type: 'P', tod: 'PM'`, ticker `'QQQ'`. Expect `{option_type_C: 0, option_type_P: 1, tod_AM_open: 0, tod_PM: 1, ticker_bucket_QQQ: 1, ticker_bucket_OTHER: 0}`, with no `score` key.
  - Also `it('emits all zeros for a categorical whose value is null')`.
  - In `takeit-score.parity.test.ts`, `it('scores a fixture row identically when inactive one-hots arrive via expandOneHotCategoricals')`:
    1. Take a fixture row and delete its inactive one-hot keys.
    2. Rebuild them through `expandOneHotCategoricals`.
    3. Assert `predictTakeitScore` equals the fixture's expected raw prob.
- [ ] **Step 2: Run** `npx vitest run api/__tests__/takeit-features.test.ts api/__tests__/takeit-score.parity.test.ts`. Expected: the new tests FAIL (inactive keys missing).
- [ ] **Step 3: Implement.** Before setting active keys to 1, set to 0 every `feature_cols` entry with a categorical prefix. Live bundles have no prefix collisions with numeric features (checked 10-28: lottery 28/74 and silentboom 21/49 one-hot columns, all genuine).
- [ ] **Step 4: Run** the same command, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(takeit): Score inactive one-hot categories as 0, as in training`. The body notes:
  - Silent Boom live scores fall about 6 pts on average.
  - The 0.70 gate share falls from 42% to 32%.
  - Owner approved 10-28.

  Footer `Refs memory project_takeit_onehot_missing_bug`.

### Task 1: Shared trade-code lists (API)

**Files:**
- Create: `src/types/spread-legs.ts`. Types only, shared by `api/` and `src/`; this follows the repo pattern of `api/` doing `import type … from '../../src/types/…'`.
- Create: `api/_lib/multileg-codes.ts`
- Modify: `api/cron/detect-silent-boom.ts:117` (drop the local list, import the shared one), and the comments at `api/_lib/silent-boom.ts:47,101`
- Test: `api/__tests__/multileg-codes.test.ts`

**Interfaces:**
- Produces, in `src/types/spread-legs.ts` (type-only):
  - `type AnchorLegKind = 'single' | 'multi_leg' | 'stock_tied'`
  - `type SpreadShape = 'vertical'|'calendar'|'diagonal'|'straddle'|'combo'|'butterfly'|'three_leg'|'four_leg'|'four_leg_multi_expiry'|'complex'|'unpaired'|'other'`
  - `interface SpreadLeg { optionType: 'C'|'P'; strike: number; expiry: string; size: number; price: number; tradeCode: string | null }`
- Produces, in `api/_lib/multileg-codes.ts`:
  - `MULTI_LEG_TRADE_CODES: readonly string[]`
  - `STOCK_TIED_TRADE_CODES: readonly string[]`
  - `legKindForTradeCode(code: string | null | undefined): AnchorLegKind | null`: null/empty → `null`, case-insensitive, unlisted → `'single'`

- [ ] **Step 1: Failing test.** One assertion per code in each list. Also: `legKindForTradeCode('MLET') === 'multi_leg'`, `('auto') === 'single'`, `('mfto') === 'single'`, `(null) === null`, `('') === null`; `MULTI_LEG_TRADE_CODES` contains `cbmo` and `mctp` and not `mfto`.
- [ ] **Step 2: Run** `npx vitest run api/__tests__/multileg-codes.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the module, and switch `detect-silent-boom.ts` to the import. The SQL still passes the array as `text[]`.
- [ ] **Step 4: Run** the test plus `npx vitest run api/__tests__/detect-silent-boom.test.ts`, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(silent-boom): Count cbmo and mctp as multi-leg and drop the nonexistent mfto`.

### Task 2: Shared trade-code list (uw-stream)

**Files:**
- Modify: `uw-stream/src/handlers/interval_ba.py:114-116` (`_MULTI_LEG_CODES`), the comment at `uw-stream/src/config.py:215`
- Test: `uw-stream/tests/test_interval_ba.py:283`

- [ ] **Step 1: Failing test.** Parametrize over the exact multi-leg list from Global Constraints. Add a case asserting `mfto` is NOT treated as multi-leg, and one asserting `cbmo` IS.
- [ ] **Step 2: Run** `cd uw-stream && python -m pytest tests/test_interval_ba.py -q`, in a venv built from `requirements-dev.txt`. Expected: FAIL on `cbmo`/`mfto`.
- [ ] **Step 3: Implement** the new frozenset.
- [ ] **Step 4: Run** the full uw-stream suite plus `ruff check`. Expected: PASS. Also run `npm run review` (it should be unaffected).
- [ ] **Step 5: Commit** `fix(uw-stream): Count cbmo and mctp as multi-leg in the interval gate`. Push only outside 08:30–15:00 CT.

### Task 3: Migration for the anchor columns

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append the next id; 192 on 10-28, re-check), `api/__tests__/db.test.ts`

**Interfaces:**
- Produces: on BOTH `lottery_finder_fires` and `silent_boom_alerts`, all nullable:
  - `anchor_ws_trade_id UUID`
  - `anchor_trade_code TEXT`
  - `anchor_leg_kind TEXT`
  - `spread_shape TEXT`
  - `spread_legs JSONB`

- [ ] **Step 1: Failing test.** Update `db.test.ts` per the CLAUDE.md migration rule (applied-ids mock, expected list, SQL call count).
- [ ] **Step 2: Run** `npx vitest run api/__tests__/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration: `ADD COLUMN IF NOT EXISTS` × 5 per table, with a description that cites the spec. No index; no reader filters on these yet.
- [ ] **Step 4: Run** the test, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): Add exchange multi-leg anchor columns to fires and alerts`.

### Task 4: Anchor + legs module

**Files:**
- Create: `api/_lib/anchor-legs.ts`
- Test: `api/__tests__/anchor-legs.test.ts`

**Interfaces:**
- Consumes: `legKindForTradeCode`, `MULTI_LEG_TRADE_CODES` (Task 1, `api/_lib/multileg-codes.ts`); types `AnchorLegKind`, `SpreadShape`, `SpreadLeg` (Task 1, `src/types/spread-legs.ts`, via `import type`); `getDb` (`api/_lib/db.ts`).
- Produces:
  - `interface TapePrint { wsTradeId: string; optionChain: string; optionType: 'C'|'P'; strike: number; expiry: string; executedAt: string; price: number; size: number; tradeCode: string | null }`
  - `interface AnchorLegs { anchorWsTradeId: string; anchorTradeCode: string | null; legKind: AnchorLegKind | null; spreadShape: SpreadShape | null; spreadLegs: SpreadLeg[] | null }`
  - `groupLegs(prints: TapePrint[], anchorChain: string): SpreadLeg[]`: groups by chain, anchor chain first, others by expiry/type/strike ascending, capped at 8.
  - `classifySpreadShape(legs: SpreadLeg[]): SpreadShape`: the spec's shape table, applied to grouped legs.
  - `describeAnchor(anchor: TapePrint, sameMsMultiLeg: TapePrint[]): AnchorLegs`. `spreadShape`/`spreadLegs` are non-null only when `legKind === 'multi_leg'`. The anchor itself is included in grouping. A lone multi-leg anchor → `unpaired`.
  - `interface AnchorRequest { key: string; ticker: string; optionChain: string; windowStart: Date; windowEnd: Date }`
  - `lookupAnchorLegs(requests: AnchorRequest[]): Promise<Map<string, AnchorLegs | null>>`. Exactly two queries for any batch size:
    1. Anchors via `unnest(...)` + `LATERAL (... ORDER BY price*size DESC, executed_at ASC LIMIT 1)`.
    2. Siblings via `unnest` of (ticker, ms) pairs on the `(ticker, executed_at)` index.

    It returns `null` for keys with no print, throws on DB error, and returns an empty map for empty input without querying.

- [ ] **Step 1: Failing table tests for `classifySpreadShape`.** One row per shape-table line, plus:
  - Review Focus 2: a vertical whose short leg is 3 same-ms prints groups to 2 legs and is `vertical`, with summed size and VWAP price.
  - Review Focus 3: 5 contracts → `complex`.
  - 1:2:1 equal-spaced puts → `butterfly`; 1:1:1 → `three_leg`.
- [ ] **Step 2: Failing tests for `describeAnchor`:**
  - `mlet` anchor + one sibling → `multi_leg`/`vertical`.
  - `tlet` → `stock_tied` with null shape/legs.
  - `auto` → `single`.
  - null code → `legKind: null` (Review Focus 1).
  - Lone `mlet` → `unpaired`.
- [ ] **Step 3: Failing tests for `lookupAnchorLegs`** with mocked `getDb`:
  - Two queries for 3 requests.
  - Neon string strike / `Date` expiry normalised.
  - Missing anchor → `null` in the map.
  - DB rejection propagates.
  - Empty input → no query.
- [ ] **Step 4: Run** `npx vitest run api/__tests__/anchor-legs.test.ts`. Expected: FAIL.
- [ ] **Step 5: Implement.** Before wiring the SQL, run EXPLAIN against prod-size data (Neon MCP, SELECT/EXPLAIN only) and confirm both queries use the migration #109 indexes.
- [ ] **Step 6: Run** the tests, then `npm run review`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(lottery): Read spread legs from the exchange multi-leg flag`.

### Task 5: Wire the Lottery Finder detect cron

**Files:**
- Modify: `api/cron/detect-lottery-fires.ts` (classifier call ~L641-705, INSERT ~L878, status ~L1065)
- Test: `api/__tests__/detect-lottery-fires.test.ts`

**Interfaces:**
- Consumes: `lookupAnchorLegs`, `AnchorRequest`, `AnchorLegs` (Task 4).

- [ ] **Step 1: Failing tests:**
  - Happy path: the INSERT receives the five new values for a spread-leg fire.
  - No anchor (Review Focus 4): NULLs, status `success`.
  - Lookup throws (Review Focus 5): fires still insert with NULLs, the Sentry capture/log names `anchor_legs.lookup_failed`, and status is `partial`.
  - The INSERT no longer names `inferred_structure`, `is_isolated_leg`, `match_confidence`, `pattern_group_id`.
- [ ] **Step 2: Run** `npx vitest run api/__tests__/detect-lottery-fires.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Build one `AnchorRequest` per new fire (key = fire's natural key), and call `lookupAnchorLegs` once per tick before the inserts.
  - Remove the `classifyAlertMultileg` import and call; write the five columns.
  - Make the final status `partial` when the lookup failed and fires were inserted. Reuse the `CronStatus` type in `api/_lib/cron-instrumentation.ts`.
- [ ] **Step 4: Run** the test file, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lottery): Record the anchor's exchange leg kind instead of the classifier label`.

### Task 6: Wire the Silent Boom detect cron

**Files:**
- Modify: `api/cron/detect-silent-boom.ts` (classifier call ~L932, INSERT ~L1069; status logic ~L1164 already supports `partial`)
- Test: `api/__tests__/detect-silent-boom.test.ts`

- [ ] **Step 1: Failing tests:** the same four as Task 5. The window is `[bucket_ct, bucket_ct + 5 min)`. A lookup failure counts toward the existing `transientFailures`.
- [ ] **Step 2: Run** `npx vitest run api/__tests__/detect-silent-boom.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement**, mirroring Task 5.
- [ ] **Step 4: Run** the test file, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(silent-boom): Record the trigger print's exchange leg kind instead of the classifier label`.

### Task 7: Badge text formatter

**Files:**
- Create: `src/utils/spread-badge.ts`
- Test: `src/__tests__/spread-badge.test.ts`

**Interfaces:**
- Consumes: `SpreadShape`, `SpreadLeg` (Task 1, `src/types/spread-legs.ts`).
- Produces: `describeSpread(shape: SpreadShape, legs: SpreadLeg[]): string`:
  - Type word `call`/`put` when all legs share a type; omitted for mixed.
  - Shape word: `four_leg` → `4-leg`, `four_leg_multi_expiry` → `4-leg roll`, `three_leg` → `3-leg`, `unpaired` → `leg vs stock/futures`, others as-is.
  - Then unique strikes ascending, joined `/`, with no trailing zeros. Examples:
    - `describeSpread('vertical', [726C, 727C]) === 'call vertical 726/727'`
    - `describeSpread('butterfly', [135P,140P,145P]) === 'put butterfly 135/140/145'`
    - `describeSpread('calendar', [215P 10-26, 215P 10-28]) === 'put calendar 215'`
    - `describeSpread('combo', [940C, 890P]) === 'combo 890/940'`

- [ ] **Step 1: Failing table test** with the four examples above, plus `927.5` keeping its `.5`.
- [ ] **Step 2: Run** `npx vitest run src/__tests__/spread-badge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ui): Describe a spread's shape and strikes in one line`.

### Task 8: Lottery Finder feed + badge

**Files:**
- Modify: `api/lottery-finder.ts`:
  - main fires query: select the five columns;
  - chain-extras `per_chain` (~L862-881): per-fire `anchorLegKind`/`spreadShape` inside `fires_json`; `COUNT(*) FILTER (WHERE anchor_leg_kind = 'multi_leg')`; the most recent multi-leg fire's `spread_shape` + `spread_legs`;
  - the `historicalFires` mapping (~L1261-1294).
- Modify: `src/components/LotteryFinder/types.ts`, `src/hooks/useLotteryFinder.ts` (Zod), `src/components/LotteryFinder/LotteryRow.tsx`, `src/components/LotteryFinder/ReignitionSection.tsx`
- Test: `api/__tests__/lottery-finder.test.ts`, `src/__tests__/useLotteryFinder.test.ts`, `src/__tests__/LotteryRow.test.tsx`

**Interfaces:**
- Produces (feed, per row):
  - `spreadLeg: { fires: number; totalFires: number; shape: SpreadShape; legs: SpreadLeg[] } | null`: null when k = 0. For single-fire rows it comes from the row's own columns.
  - `anchorLegKind: AnchorLegKind | null` for the row's latest fire.
  - Each `historicalFires[i]` gains `anchorLegKind: AnchorLegKind | null`.

- [ ] **Step 1: Failing tests:**
  - Feed shape for a mixed chain (k = 2 of 5, shape from the most recent spread-leg fire), an all-spread chain, a single-fire stock-tied row, and a row with all NULLs.
  - Zod accepts and rejects accordingly.
  - Row renders `spread leg on 2 of 5 fires · call vertical 726/727`, `spread leg on all 3 fires · …`, `stock-tied leg`, and nothing for single/NULL.
  - The reignite list shows a marker with an accessible label (`spread-leg fire`, `stock-tied fire`) on the right entries.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the existing pill/badge primitive in `src/components/ui` and theme tokens, matching neighbouring tags. Keep the endpoint's existing owner-or-guest auth.
- [ ] **Step 4: Run** the tests, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** in ≤5-file commits: API first (`feat(lottery-finder): Return each fire's exchange leg kind and the row's spread count`), then UI (`feat(lottery-finder): Badge rows whose fires print as spread legs`).

### Task 9: Silent Boom feed + badge

**Files:**
- Modify: `api/silent-boom-feed.ts`, `src/components/SilentBoom/types.ts`, `src/hooks/useSilentBoomFeed.ts`, `src/components/SilentBoom/SilentBoomRow.tsx`
- Test: `api/__tests__/silent-boom-feed.test.ts`, `src/__tests__/useSilentBoomFeed.test.ts`, `src/__tests__/SilentBoomRow.test.tsx`

**Interfaces:**
- Produces (per alert): `anchorLegKind: AnchorLegKind | null`, `spreadShape: SpreadShape | null`, `spreadLegs: SpreadLeg[] | null`.

- [ ] **Step 1: Failing tests:**
  - Feed returns the three fields.
  - Zod accepts and rejects accordingly.
  - Row renders `trigger print: spread leg · put vertical 135/140`, `trigger print: stock-tied leg`, and nothing for single/NULL.
  - The existing "Spread-Confirmed" badge still renders unchanged alongside.
- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, then `npm run review`. Expected: PASS.
- [ ] **Step 5: Commit** in ≤5-file commits (API, then UI): `feat(silent-boom): Show whether the trigger print was a spread leg`.

### Task 10: Remove the classifier client and env vars

**Files:**
- Delete: `api/_lib/multileg-client.ts`, `api/_lib/multileg-classify-batch.ts`, `api/__tests__/multileg-client.test.ts`, `api/__tests__/multileg-classify-batch.test.ts`
- Modify: `api/_lib/env.ts` (drop `CLASSIFIER_URL`, `CLASSIFIER_SHARED_SECRET`), `.env.example`, the CLAUDE.md env table, `scripts/replay-lottery-fires-2026-05-18.ts` (drop its import and call site)

- [ ] **Step 1: Run** `git grep -n -E "multileg-client|multileg-classify-batch|CLASSIFIER_" -- api src scripts .env.example CLAUDE.md`. Expected: hits only in the files listed.
- [ ] **Step 2: Delete and edit.** Run `npm run review`. Expected: PASS (coverage floors: if a removed file had a per-file floor in `scripts/_lib/coverage-floor.mjs`, remove that entry; never lower another).
- [ ] **Step 3: Commit** `refactor(classifier): Delete the classifier client and its env vars`. Then commit the CLAUDE.md/.env.example change separately if it pushes the first commit past 5 files.

### Task 11: Remove dead Take-It and audit wiring

**Files:**
- Modify: `api/_lib/takeit-features.ts` (the `inferred_structure` raw input at ~L716 and ~L834, `is_isolated_leg`, `match_confidence` fields/types), `api/_lib/takeit-backfill-mapper.ts`, `api/cron/audit-takeit-calibration.ts` (drop `pct_inferred_structure_classified`; nothing new at Axiom top level)
- Modify: `ml/src/takeit/train.py`, `ml/src/takeit/build_training_set.py`, `api/_lib/forced-flow.ts` comment (L12)
- Test: `api/__tests__/takeit-features.test.ts`, `api/__tests__/takeit-backfill-mapper.test.ts`, `api/__tests__/audit-takeit-calibration.test.ts`, `ml/tests/test_takeit_build_training_set.py`

- [ ] **Step 1: Update tests first.** Assert the features record has no `inferred_structure_*`, `is_isolated_leg` or `match_confidence` keys, and the audit payload has no `pct_inferred_structure_classified`. Then run them. Expected: FAIL.
- [ ] **Step 2: Implement the removals.** Run `npm run review`, then `cd ml && .venv/Scripts/python -m pytest tests/test_takeit_build_training_set.py -q`. Expected: PASS.
- [ ] **Step 3: Commit** in ≤5-file commits: `refactor(takeit): Drop the classifier features from scoring and training inputs`, and `refactor(takeit): Stop auditing classifier coverage`.

### Task 12: CI, Dependabot and docs

**Files:**
- Modify: `.github/workflows/ci.yml` (the `classifier` path filter at L33/L73-77 and the job at L271+), `.github/dependabot.yml` (`/classifier` entry)
- Modify: the CLAUDE.md architecture block and deployment section, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/ONBOARDING.md`, `sidecar/README.md`
- Modify: add a one-line "Superseded by `2026-10-28-classifier-replacement-design.md`" note to `meta-detectors-2026-05-16.md`, `multileg-classifier-service-split-2026-05-28.md`, `classifier-oom-rework-2026-06-11.md`, `classifier-hardening-2026-05-28.md`, `classifier-cross-type-subbatch-2026-06-04.md`

- [ ] **Step 1: Edit.** Run `npm run review`. Expected: PASS. Optionally validate `ci.yml` with `actionlint` if it is installed.
- [ ] **Step 2: Commit** in ≤5-file commits: `ci(classifier): Drop the classifier job and Dependabot entry`, `docs(claude): Remove the classifier service`, `docs(spec): Mark the classifier specs superseded`.

### Task 13: Infra teardown (main session; destructive, so confirm with the owner first)

- [ ] **Step 1: Pre-check.**
  - Tasks 5–6 are deployed to Vercel production (`READY`).
  - At least one detect-cron tick after deploy wrote the new columns. SELECT the latest fires and check `anchor_leg_kind IS NOT NULL` on some.
  - No new `multileg.classify*` Sentry events after the deploy.
- [ ] **Step 2: Ask the owner** in one line to confirm the deletion.
- [ ] **Step 3: Delete** the Railway `Classifier` service (project `Theta-Options`, id `0ca5cfb5-1def-4b06-9b57-488d78d9b316`). Remove `CLASSIFIER_URL` and `CLASSIFIER_SHARED_SECRET` from Vercel (all environments) and from any Railway service that still has them.
- [ ] **Step 4: Verify.** The Railway service list has no Classifier; `vercel env ls` has no `CLASSIFIER_*`.

### Task 14: Delete the classifier code (after Task 13)

**Files:**
- Delete: `classifier/`, `ml/src/multileg_assembler.py`, `ml/src/multileg_patterns.py`, `ml/tests/test_multileg_assembler.py`, `ml/tests/test_multileg_patterns.py`, `ml/experiments/multileg-assembler-validation/run.py` (keep its `results.json` and sample files)

- [ ] **Step 1: Run** `git grep -n -E "multileg_assembler|multileg_patterns" -- ':!classifier' ':!docs'`. Expected: only the files being deleted.
- [ ] **Step 2: Delete.** Run `npm run review` and `cd ml && .venv/Scripts/python -m pytest -q`. Expected: PASS.
- [ ] **Step 3: Commit** `chore(classifier): Delete the retired classifier service and matcher`. Push outside 08:30–15:00 CT. Railway has no service left to rebuild.

### Task 15: Verify it's gone (main session)

- [ ] **Step 1: Repo sweep.** Run `git grep -n -i -E "classifier|multileg|CLASSIFIER_|inferred_structure|is_isolated_leg|match_confidence|pattern_group_id"`. Every remaining hit must be:
  - historical: `docs/superpowers/specs/`, `docs/superpowers/plans/`, the migration history in `db-migrations.ts`, `db.test.ts` expectations, research scripts under `scripts/` that read the old columns;
  - the Take-It XGBoost "classifier" naming (`lottery_classifier_v*.json` bundles), which is unrelated;
  - or the kept DB columns.

  Report the list.
- [ ] **Step 2: Production checks.**
  - `npm run review` green on main.
  - The latest detect-cron runs succeeded and wrote the new columns.
  - No `multileg.classify*` Sentry events since the cutover.
  - No `Classifier` service on Railway; no `CLASSIFIER_*` in Vercel/Railway env.
  - Both panels render the badge on a live day.
- [ ] **Step 3: Update memory** `project_classifier_assessment_2026_10_28.md` to "shipped", with the commit hashes.
