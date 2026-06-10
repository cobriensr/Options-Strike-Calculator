# Alerts side-by-side layout + Lottery/Silent-Boom test hardening

**Date:** 2026-06-10
**Branch:** `cobriensr/alerts-side-by-side`
**Goal:** (1) Render Lottery Finder and Silent Boom side-by-side (50/50) on wide screens, stacking on narrow; (2) close concrete test-coverage gaps across everything touching both features, front-end and back-end.

## Part 1 — Side-by-side layout

**Decisions (owner-approved 2026-06-10):** side-by-side 50/50 on `xl` (1280px) and up; auto-stack to today's top/bottom layout below `xl`; replace stacked (no toggle).

**Single file:** `src/components/OptionsAlerts/index.tsx`.
- Outer container: `flex-col` → `flex-col xl:flex-row`.
- Panes: keep `flex-1 min-h-0 overflow-y-auto`; add `min-w-0` so each can shrink in row mode. `flex-1` yields even 50/50 in row mode and full-height independent scroll in both orientations.
- Divider: first pane `border-b` → `border-b xl:border-b-0 xl:border-r`.
- `compact` prop on both panes unchanged. No data/state/logic changes.

**Why `xl`:** at `lg` (1024px) a 50/50 split is ~512px/pane and the wide rows horizontal-scroll badly; `xl` gives ~640px. Below `xl` is byte-identical to today → zero regression on laptop/tablet/phone.

**Tests:**
- Unit (`OptionsAlertsView.test.tsx`): assert root carries `flex-col` AND `xl:flex-row`, each `<section>` retains `min-h-0 flex-1 overflow-y-auto` (guard against dropping `min-h-0`, which breaks scroll), and the divider class flips to `xl:border-r`.
- E2E (new `e2e/options-alerts-responsive.spec.ts`): viewport <1280 → panes stacked (2nd pane `y` > 1st `y+height`); ≥1280 → side-by-side (shared `y`, 2nd `x` > 1st `x`). Include an axe-core a11y check (project convention).

## Part 2 — Test hardening (grounded in the 2026-06-10 coverage audit)

Both surfaces are behaviorally covered; gaps are branch/edge + a few untested money-path modules. Organized into phases ≤5 files each (per CLAUDE.md phased execution). Each phase ships + is reviewed independently.

### Phase 2A — Backend HIGH
- **`api/silent-boom-export.ts` filter-arm parity** (84% stmt / 82% br; filter buckets `todRange` LATE, all `dteRange`, `burstRange` red/yellow/grey, `askPctRange` 5 bands exercised 0×): add a parametrized feed↔export parity test asserting export SQL bounds match `silent-boom-feed.ts` for every bucket value. **Highest-impact single addition.**
- **`api/_lib/validation/lottery.ts` bool-transform arms** (68% br): table test asserting every `optionalBoolEnum()`/bool param maps `'false'`→false and missing→undefined (the `?flag=false` silent-coerce footgun) — covers lottery + silent-boom export bool flags.
- **`api/_lib/silent-boom.ts`** (76% br): spike-multiplier floor boundary (just-below vs just-above `spikeMultiplier * max(baseline,100)`) + `median()` even-length/empty arms.
- **`api/_lib/lottery-score-weights-v2.ts`** (79% br): input case driving the uncovered scoring branch at lines ~432–439 (read block to identify the bonus/clamp).
- **`api/cron/enrich-lottery-outcomes.ts`** (65% br): `simulateFlowInversion` try/catch soft-degrade (flow load throws → other realized fields still UPDATE, `flowInversion=null`) + `dateToIso` Date-object vs `'YYYY-MM-DD'`-string table (NUMERIC/date-as-string class).

### Phase 2B — Frontend HIGH
- **`src/utils/ticker-rollup-aggregates.ts`** (no dedicated test; 79% br): new `ticker-rollup-aggregates.test.ts` — threshold-boundary tables for `isHighConviction`/`isStrongConviction` (PM-window, entry ≤ $1.00), `isBurstStorm` (≥8 fires AND ≥$500k), `findEarliestConvictionWindow`, `formatPremiumAmount` (k/M rounding), tide/flow label formatters.
- **`src/components/SilentBoom/SilentBoomRow.tsx`** (75.6/70.5, lowest): render tests — premium string at k/M magnitudes, tier1/tier2/none badge, take-it chip presence/absence at floor, OTM vs ITM badge class.
- **`src/hooks/useStickyUnion.ts`** (86% br): localStorage degrade paths — stub `setItem`→throw (quota/private-mode) asserts in-memory union still updates/returns; `seen`-map pruned in lockstep on cap-eviction.
- **Component-level partition** (`LotteryFinderSection.test.tsx`): feed overlapping fires to `firesFeed` + `reignitedFeed`, assert each row lands in exactly one partition with correct counts.
- **filter→fetch→union wiring** (`useLotteryFinder` / `useSilentBoomFeed` tests): flip `convictionFloor`/`takeitFloor`, assert BOTH the fetch query param AND the union storageKey suffix change (union rescopes, no filtered/unfiltered bleed). This is the class the just-fixed never-vanish staleness bug lives in — assert it end-to-end.

### Phase 2C — Backend MEDIUM
- `detect-lottery-fires.ts` (77% br): gexbot snapshot throw → fire still inserts, `gexMisses` increments; assert ON CONFLICT idempotency on re-run.
- `detect-silent-boom.ts` (87% br): macro-as-of fetch failure → alert still lands; assert per-fire as-of uses the fire bucket, not cron-tick time (the recent fix).
- `silent-boom-feed.ts`: empty window → coherent `total:0`; `total` vs page-length coherence under limit/offset.
- `lottery-finder.ts`: combined-filter (minPremium × minScore × quintile) → `suppressedCount` + `total` coherence.

### Phase 2D — Frontend MEDIUM
- Suppressed-count hint footer (both sections): `suppressedCount` 1 vs >1 exact text + plural; filter chip labels per `convictionFloor`/`takeitFloor`.
- HRN floor-blind assertion: sub-floor fire appears in reignited lane but is counted in `suppressedCount` for main (guards the documented "don't re-add quality gate to reignitedRows" regression).
- `useNeverVanishFeed` engaged=false raw passthrough + union-only ticker appended after server order, sorted by merged count.
- `session-quality.ts`/`SessionQualityBanner.tsx` (70/50): `getTodBucket` boundary table (9.5/11.5/12.5 CT) + banner render per tier.
- SB ticker-counts/feed: port the edge cases the Lottery siblings already have (empty response, page>0 dedup, count reconciliation).

### Phase 2E — LOW (optional, if time)
- CSV field escaping (lottery-export, silent-boom-ticker-counts); `enrich-silent-boom-outcomes` dateToIso; `lottery-inversion-bonus` unused export (test or confirm dead); `gexbot-badge` gamma-sign mapping; `ct-window` edge; `LotteryRow` badge branches.

## Non-goals
- No scoring/threshold/behavior changes — tests assert CURRENT behavior. If a test surfaces a real bug, flag it separately, don't silently "fix" by changing the assertion.
- No layout toggle, no draggable divider (explicitly deferred).
- `component-formatters.ts`, `timezone.ts` global coverage are NOT in scope (not feature-specific deps — confirmed by audit).

## Execution
Subagent-driven per CLAUDE.md: Phase 1 first (ship the visible change + its tests), then 2A–2E. Each phase: implement (TDD where adding behavior; here mostly characterization tests of existing behavior) → `npm run review` → code-reviewer subagent → commit on branch. PR at the end.

## Coverage target
Raise branch coverage on every HIGH file to ≥90% and eliminate the "no dedicated test" money-path modules (`ticker-rollup-aggregates.ts`). Not chasing 100% on telemetry/CSV cosmetics.
