# Alerts Side-by-Side + Lottery/Silent-Boom Test Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Per CLAUDE.md: each phase ends with `npm run review` green + a code-reviewer subagent + a commit on branch `cobriensr/alerts-side-by-side`. Phases are ordered; ship Phase 1 first.

**Goal:** Render Lottery Finder + Silent Boom side-by-side on wide screens (stack on narrow), and close the concrete test-coverage gaps the 2026-06-10 audit found across both features (FE + BE).

**Architecture:** Layout is a one-file responsive Tailwind change in `OptionsAlerts/index.tsx` (`flex-col` → `flex-col xl:flex-row`). Test hardening adds branch/edge cases to existing suites plus a few new dedicated suites for money-path modules; all tests assert CURRENT behavior (characterization), not new behavior.

**Tech Stack:** React 19, Tailwind 4, Vitest + @testing-library/react, Playwright + axe-core, Vercel Functions (TS) + Vitest for `api/`.

**Spec:** `docs/superpowers/specs/2026-06-10-alerts-side-by-side-and-test-hardening-design.md`

**Note on test-code granularity:** characterization tests of existing complex logic must be written against the LIVE source (real fixtures, types, mock sequences). Each test task below names the exact file, function/branch, and concrete scenarios (input → expected) from the audit. The implementing subagent reads the live source and writes the assertions — it does NOT invent fixtures. Phase 1 (deterministic layout) carries full code.

---

## Phase 1 — Side-by-side layout (ship first)

**Files:**
- Modify: `src/components/OptionsAlerts/index.tsx`
- Test: `src/__tests__/OptionsAlertsView.test.tsx` (extend)
- Create: `e2e/options-alerts-responsive.spec.ts`

- [ ] **Step 1 — Write the failing unit assertions.** In `OptionsAlertsView.test.tsx`, add a test that renders the view (with market context present so panes mount) and asserts: the root flex container's className contains both `flex-col` and `xl:flex-row`; each of the two `<section>` panes' className contains `min-h-0`, `flex-1`, `overflow-y-auto`, and `min-w-0`; the first (Lottery) pane contains `border-b`, `xl:border-b-0`, and `xl:border-r`. Use the existing render harness/mocks in that file.
- [ ] **Step 2 — Run; verify fail.** `npx vitest run src/__tests__/OptionsAlertsView.test.tsx` → FAIL (missing `xl:flex-row` / `min-w-0` / `xl:border-r`).
- [ ] **Step 3 — Apply the layout edit** in `OptionsAlerts/index.tsx`:
  - Outer container `className`: `flex min-h-0 flex-1 flex-col` → `flex min-h-0 flex-1 flex-col xl:flex-row`
  - Lottery `<section>`: `border-edge min-h-0 flex-1 overflow-y-auto border-b` → `border-edge min-h-0 min-w-0 flex-1 overflow-y-auto border-b xl:border-b-0 xl:border-r`
  - Silent Boom `<section>`: `min-h-0 flex-1 overflow-y-auto` → `min-h-0 min-w-0 flex-1 overflow-y-auto`
- [ ] **Step 4 — Run; verify pass.** `npx vitest run src/__tests__/OptionsAlertsView.test.tsx` → PASS.
- [ ] **Step 5 — Write the Playwright responsive spec** `e2e/options-alerts-responsive.spec.ts`: navigate to the alerts view; at viewport 1024×800 assert the two panes stack (2nd pane `boundingBox().y >= 1st.y + 1st.height - tolerance`); at 1440×900 assert side-by-side (`Math.abs(2nd.y - 1st.y)` small AND `2nd.x > 1st.x`). Add an `@axe-core/playwright` scan at the wide viewport. Follow existing `e2e/` selector + fixture conventions (semantic `getByRole('region')` / `data-testid`); reuse any auth/setup fixture other specs use.
- [ ] **Step 6 — Run** `npm run review` (tsc + eslint + prettier + vitest --coverage) → green. (Playwright runs separately: `npm run test:e2e -- options-alerts-responsive` if the local env supports it; otherwise note it for CI.)
- [ ] **Step 7 — code-reviewer subagent** on the diff → address findings.
- [ ] **Step 8 — Commit** `feat(alerts): side-by-side lottery/silent-boom on xl, stack below` (+ tests).

---

## Phase 2A — Backend HIGH

**Files (≤5):** `api/__tests__/silent-boom-export.test.ts`, `api/__tests__/validation/lottery.test.ts`, `api/__tests__/silent-boom.test.ts`, `api/__tests__/lottery-score-weights-v2.test.ts`, `api/__tests__/enrich-lottery-outcomes.test.ts` (modify all; source unchanged).

- [ ] **silent-boom export↔feed filter parity** — read filter-bucket SQL in both `api/silent-boom-export.ts` and `api/_lib`/`api/silent-boom-feed.ts`. Add a parametrized test asserting export applies identical bounds for every `todRange` (incl. LATE), `dteRange` (all arms incl. 4+), `burstRange` (red/yellow/grey), `askPctRange` (all 5 bands). Verify by mock-capturing the SQL params for each bucket and comparing to the feed's. Run: `npx vitest run api/__tests__/silent-boom-export.test.ts`.
- [ ] **validation bool-coercion arms** — in `validation/lottery.test.ts`, table test asserting every bool param (`reload`, `cheapCallPm`, silent-boom export bool flags, etc.) maps `'false'`→`false` and missing→`undefined` (not truthy). Source: `api/_lib/validation/lottery.ts` + `validation.ts` silent-boom schemas.
- [ ] **silent-boom detector edges** — `silent-boom.test.ts`: spike-multiplier floor boundary (size just below vs just above `spikeMultiplier * max(baseline,100)` → reject vs accept) and `median()` even-length + empty-array arms. Source lines ~252-253, 313-316.
- [ ] **score-v2 branch** — read `api/_lib/lottery-score-weights-v2.ts` lines ~432-439, identify the bonus/clamp, add the input case that drives it in `lottery-score-weights-v2.test.ts`.
- [ ] **enrich-lottery soft-degrade + date** — `enrich-lottery-outcomes.test.ts`: (a) `simulateFlowInversion` throws → other realized fields still UPDATE with `flowInversion=null`; (b) `dateToIso` table for `Date` object vs `'YYYY-MM-DD'` string.
- [ ] `npm run review` green → code-reviewer subagent → commit `test(silentboom,lottery): backend HIGH branch/edge coverage`.

---

## Phase 2B — Frontend HIGH

**Files (≤5):** create `src/__tests__/ticker-rollup-aggregates.test.ts`; modify `src/__tests__/SilentBoomRow.test.tsx`, `src/__tests__/useStickyUnion.test.ts`, `src/__tests__/LotteryFinderSection.test.tsx`, and `src/__tests__/useLotteryFinder.test.ts` + `useSilentBoomFeed.test.ts` (filter-wiring; if this exceeds 5 files, split filter-wiring into its own commit within the phase).

- [ ] **ticker-rollup-aggregates** — new suite for `src/utils/ticker-rollup-aggregates.ts`: boundary tables for `isHighConviction`/`isStrongConviction` (PM-window cutoff, entry ≤ $1.00), `isBurstStorm` (≥8 fires AND ≥$500k — test each side of both thresholds), `findEarliestConvictionWindow`, `formatPremiumAmount` (rounding at k and M boundaries), `formatTideLabel`/`formatFlowLabel`. Read the source for exact thresholds/signatures.
- [ ] **SilentBoomRow display** — render tests: premium string at k vs M magnitude, tier1/tier2/none badge, take-it chip present/absent at the floor, OTM vs ITM badge class. Source: `SilentBoomRow.tsx` lines ~339-415.
- [ ] **useStickyUnion degrade** — stub `localStorage.setItem` to throw (quota) → assert in-memory union still updates + returns rows (no throw); assert `seen` map pruned in lockstep on cap-eviction.
- [ ] **reignited-vs-ticker partition** (`LotteryFinderSection.test.tsx`) — feed overlapping fires to both `firesFeed` and `reignitedFeed`; assert each row renders in exactly one partition (HRN vs ticker group) and counts reconcile.
- [ ] **filter→fetch→union rescoping** (`useLotteryFinder.test.ts` + `useSilentBoomFeed.test.ts`) — flip `convictionFloor`/`takeitFloor`/`minPremium`; assert BOTH the fetch URL query param changes AND the never-vanish storageKey suffix (filterSig) changes, so the union rescopes (no filtered/unfiltered bleed). This is the class as the 2026-06-10 staleness bug — assert it end-to-end.
- [ ] `npm run review` green → code-reviewer subagent → commit `test(lottery,silentboom): frontend HIGH coverage — rollup engine, union degrade, partition, filter rescope`.

---

## Phase 2C — Backend MEDIUM

**Files (≤5):** `api/__tests__/detect-lottery-fires.test.ts`, `detect-silent-boom.test.ts`, `silent-boom-feed.test.ts`, `lottery-finder-endpoint.test.ts` (modify).

- [ ] **detect-lottery gexbot resilience** — `getLatestGexbotSnapshotAt` throws → fire still inserts, `gexMisses` increments; assert ON CONFLICT idempotency (re-run same window → 0 new inserts).
- [ ] **detect-silent-boom macro as-of** — macro fetch failure → alert still lands (EMPTY_MACRO); assert per-fire as-of uses the fire bucket timestamp, not cron-tick wall-clock (the recent fix).
- [ ] **silent-boom-feed pagination** — empty window → `total:0` coherent; `total` vs returned page length coherent under `limit`/`offset`.
- [ ] **lottery-finder combined filters** — minPremium × minScore × quintile active together → `suppressedCount` + `total` coherence (matches displayed reachable set).
- [ ] `npm run review` green → code-reviewer subagent → commit `test(lottery,silentboom): backend MEDIUM error-path + coherence coverage`.

---

## Phase 2D — Frontend MEDIUM

**Files (≤5):** `LotteryFinderSection.test.tsx`, `SilentBoomSection.test.tsx`, `useNeverVanishFeed.test.ts`, create `src/__tests__/session-quality.test.ts`, `useSilentBoomTickerCounts.test.ts`/`useSilentBoomFeed.test.ts`.

- [ ] **suppressed-count hint** — both sections: `suppressedCount` 1 vs >1 → exact hint text + singular/plural; filter-chip labels per `convictionFloor`/`takeitFloor`.
- [ ] **HRN floor-blind** — sub-floor fire appears in reignited lane AND is counted in `suppressedCount` for the main list (guards the documented "don't re-add quality gate to reignitedRows" regression).
- [ ] **useNeverVanishFeed** — `engaged=false` → raw passthrough; union-only ticker (absent from server) appended after server order, sorted by merged count.
- [ ] **session-quality** — `getTodBucket` boundary table (9.5/11.5/12.5 CT hours) + `SessionQualityBanner` render per tier.
- [ ] **SB hooks parity** — port the Lottery siblings' missing cases (empty response, page>0 dedup, count reconciliation) to `useSilentBoomTickerCounts`/`useSilentBoomFeed`.
- [ ] `npm run review` green → code-reviewer subagent → commit `test(lottery,silentboom): frontend MEDIUM coverage`.

---

## Phase 2E — LOW (optional; do only if Phases 1–2D land with time before close)

**Files:** `lottery-export.test.ts`, `silent-boom-ticker-counts.test.ts`, `enrich-silent-boom-outcomes.test.ts`, create `src/__tests__/gexbot-badge.test.ts`, `ct-window.test.ts`, `LotteryRow.test.tsx`.

- [ ] CSV field escaping (comma/quote/newline) in lottery-export + silent-boom-ticker-counts; default-date fallback.
- [ ] `enrich-silent-boom-outcomes` dateToIso Date-vs-string table.
- [ ] `lottery-inversion-bonus` unused export — add a direct unit test OR confirm + document it's internal/dead.
- [ ] `gexbot-badge` gamma-sign → badge-variant mapping (positive/negative/zero/null).
- [ ] `ct-window` boundary edge (lines ~42-48); `LotteryRow` badge-combo branches (~250-257/421/552).
- [ ] `npm run review` green → code-reviewer subagent → commit `test(lottery,silentboom): LOW telemetry/cosmetic coverage`.

---

## Finish
- [ ] Confirm branch coverage ≥90% on every HIGH file (`npx vitest run --coverage` filtered to the touched files); `ticker-rollup-aggregates.ts` + `session-quality.ts` now have dedicated suites.
- [ ] Open PR from `cobriensr/alerts-side-by-side` → main with the spec + plan linked; summarize layout change + coverage deltas.
