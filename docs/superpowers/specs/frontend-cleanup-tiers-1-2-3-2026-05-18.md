---
status: Draft — pending review
date: 2026-05-18
---

# Frontend Cleanup — Tiers 1, 2, 3 (Post-Audit Remediation)

**Date:** 2026-05-18
**Status:** Draft
**Source audit:** 5-agent parallel review run on 2026-05-18 covering
component architecture, hooks, utils, React patterns / perf, and
TypeScript health.

## Goal

Remediate the 17 findings surfaced by the 2026-05-18 frontend review.
Fix latent bugs (Tier 1), extract shared scaffolding so the next
feature folders aren't another Lottery↔SilentBoom clone (Tier 2), and
polish naming / dependency direction (Tier 3). **No user-visible
behavior changes.** Outcome: the codebase is meaningfully easier to
change, with no test coverage dip and a clean `npm run review` after
every commit.

## Why now

Five independent reviewers each surfaced the same headline — Lottery
and SilentBoom are clones — which is itself a signal. Three of the
four "drift clusters" exist because feature work landed faster than
shared scaffolding could be extracted. Tier 2 is the highest-leverage
refactor available; Tiers 1 and 3 are cheap bug-and-polish bundles
that ride along.

## Operating rules (apply to every phase, no exceptions)

These are not negotiable for this spec:

1. **Per-phase loop:** implement → `npm run review` → code-reviewer
   subagent → apply `continue` findings → re-review if needed →
   commit + push → next phase. Don't ask between steps.
2. **Verification gates (every phase commit):**
   - `npm run review` exits 0 (tsc + eslint + prettier + vitest
     `--coverage`)
   - Coverage % ≥ Phase 0 baseline (no dips, no exceptions; if the
     refactor genuinely needs new tests, write them in the same
     phase)
   - code-reviewer subagent final verdict is `pass`
3. **Test discipline:** every new module gets a sibling
   `__tests__/<name>.test.ts(x)`. Every migration that touches
   public hook/component shape gets at least one new test
   asserting parity with pre-refactor behavior.
4. **Tier checkpoint review:** after the final phase of each tier,
   run an additional broader code-reviewer pass over the cumulative
   tier diff (`git diff <tier-start-sha>..HEAD`). This satisfies
   the explicit "review on each tier before each tier is committed"
   requirement — the per-phase reviews catch local issues; the tier
   review catches cumulative drift.
5. **Max files per phase commit:** 5 (per CLAUDE.md). Sweeps that
   touch more files are split into multiple phases (labeled e.g.
   2G-1, 2G-2).
6. **Behavior parity:** no user-visible UI or polling-cadence
   changes. Polling intervals, localStorage keys, and prop shapes
   are preserved verbatim unless explicitly called out.
7. **Commit style:** conventional commits with Sentry-style scope.
   Example: `refactor(hooks): extract usePersistedState primitive`.
   Commit directly to main per project convention.

## Phase 0 — Baseline snapshot (no code change)

Single small commit capturing the pre-refactor metrics so coverage
floors and LOC deltas are objective.

**Tasks:**

- `npm run review` to confirm green at HEAD
- `npm run test:coverage` and record the global coverage %
- Record `find src -name '*.ts' -o -name '*.tsx' | wc -l` total file
  count, total LOC, top 5 file sizes
- Write metrics to `docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18-baseline.md`

**Verify:** baseline file committed, numbers reproducible.

---

# Tier 1 — Latent bug fixes (4 phases)

Real bugs that can bite at runtime. Small, targeted, no
architectural change.

### Phase 1A — PriceChart ref-bang cluster

**Risk:** [PriceChart.tsx:373-416](../../../src/components/GexTarget/PriceChart.tsx#L373) has 4
consecutive `candleSeriesRef.current!.createPriceLine(...)` calls and
2 more at [:92, :95](../../../src/components/GexTarget/PriceChart.tsx#L92). If the chart
disposes between renders, the next call throws.

**Change:**

- Add `const series = candleSeriesRef.current; if (!series) return;`
  guard at the top of the affected effect(s)
- Remove all 6 `!` non-null assertions
- Add `src/__tests__/components/PriceChart.test.tsx` asserting that
  the effect early-returns when the series ref is `null`

**Verify:** vitest passes; manually scrub the GexTarget chart in
dev to confirm price lines still draw.

### Phase 1B — App.tsx derived-state effect

**Risk:** [App.tsx:360-370](../../../src/App.tsx#L360) is a `useEffect`
deriving `vix.vixOHLC` from `historyData.history?.vix.candles` with
`eslint-disable-line react-hooks/exhaustive-deps`. Effect-as-derivation.

**Change:**

- Replace with a `useMemo` consumed wherever the derived value is
  used downstream
- Remove the disable-comment
- If a side effect on `historyData` change really is needed (e.g.,
  Sentry breadcrumb), keep it in a separate effect with correct deps

**Verify:** `vix.vixOHLC` identity is stable across renders when
inputs unchanged; no lint disables remain in App.tsx for this path.

### Phase 1C — AbortController on polling fetchers (Pt 1)

**Risk:** Polling hooks suppress state writes with `mountedRef` but
in-flight requests still complete on rapid filter changes — bandwidth
waste, server load.

**Files (≤5 per phase):**

- `src/hooks/useLotteryFinder.ts`
- `src/hooks/useSilentBoomFeed.ts`
- `src/hooks/useTickerCandles.ts`
- `src/hooks/useNetFlowHistory.ts`
- `src/hooks/useTickerNetFlowBatch.ts`

**Change:** Add `AbortController` per fetch, store ref, abort on
rerun and unmount. Pass `signal` to `fetchJson`/`fetch` calls.

**Tests:** Extend the 3 hooks with existing tests
(`useLotteryFinder`, `useSilentBoomFeed`, `useTickerNetFlowBatch`)
to assert abort-on-rerun.

### Phase 1D — AbortController on polling fetchers (Pt 2)

**Files (≤5):**

- `src/hooks/usePeriscopeStrikes.ts`
- `src/hooks/useDarkPoolLevels.ts`
- `src/hooks/useGreekFlow.ts`
- `src/hooks/useDealerRegime.ts`
- `src/hooks/useZeroGamma.ts`

Same pattern as 1C. Tests on at least 2 representative hooks.

### Phase 1E — useFuturesData polling

**Risk:** [useFuturesData.ts:112-117](../../../src/hooks/useFuturesData.ts#L112)
has no polling at all on a live futures panel. Single mount fetch.

**Decision (2026-05-18):** add a `marketOpen`-gated 30s poll matching
sibling data hooks.

**Verify:** network panel shows refresh during market hours and
quiescence otherwise; existing `useFuturesData` test extended to
assert poll fires.

### Tier 1 checkpoint

Run a code-reviewer subagent over `git diff <pre-1A-sha>..HEAD`
covering all of Phase 1A–1E. Verdict must be `pass` before starting
Tier 2.

---

# Tier 2 — High-leverage refactors

Where the real win lives. Every phase below is independently
shippable. The order is chosen so each phase strictly enables the
next (primitives before sweeps).

### Phase 2A — Extract `usePersistedState`

**New files:**

- `src/hooks/usePersistedState.ts`
- `src/hooks/__tests__/usePersistedState.test.ts`

**Signature:**

```ts
function usePersistedState<T>(
  key: string,
  defaultValue: T,
  options?: { parse?: (raw: string) => T; serialize?: (v: T) => string },
): [T, Dispatch<SetStateAction<T>>];
```

- Reads from `localStorage` on first render (SSR-safe via
  lazy initializer)
- Writes on each value change with single effect
- Coalesces JSON-parse failures to `defaultValue`

**Verify:** unit tests cover string/number/object/array values,
storage failure paths, and round-trip across remount.

### Phase 2B — Sweep `usePersistedState` into SilentBoomSection

**Risk targeted:** the 16-effect cluster at
[SilentBoomSection.tsx:508-597](../../../src/components/SilentBoom/SilentBoomSection.tsx#L508) +
~12 LS-backed `useState` blocks.

**Files (1):** `src/components/SilentBoom/SilentBoomSection.tsx`

**Change:** Replace 12+ `useState(() => readLocalStorage(KEY))`
blocks with `usePersistedState` calls. Delete the 16-effect block
entirely (the hook handles persistence).

**Verify:**

- `npm run review` clean
- Manual: change a filter, hard-reload, value persisted
- Coverage: no dip

### Phase 2C — Sweep `usePersistedState` into LotteryFinder + GexLandscape

**Files (≤5):**

- `src/components/LotteryFinder/LotteryFinderSection.tsx`
- `src/components/GexLandscape/index.tsx` (lines 60-102 hand-rolled
  read/write helpers)
- Other LS-backed `useState` sites surfaced by
  `grep -rn 'localStorage' src/ --include='*.tsx'`

Split into 2C-1 and 2C-2 if file count exceeds 5.

### Phase 2D — Extend FilterChip work (defer to existing spec)

**Note:** [`filter-toolbar-standardization-2026-05-17.md`](filter-toolbar-standardization-2026-05-17.md)
is already in progress and covers the `<FilterChip />` primitive +
tokens module for Lottery + SilentBoom. **This phase finishes that
spec first if not done**, then extends:

- Add `<FilterToolbar rows={[{ label, chips }]} />` schema-driven
  wrapper around the `<FilterRow>` div pattern (still leaves rows
  composable for one-off cases — see the existing spec's "out of
  scope" notes on `<FilterRow>`)
- Add `<ChipGroup label chips active onSelect />` for the common
  "label + N chips + active key" pattern

**Files:**

- `src/components/ui/FilterToolbar.tsx` (new) + tests
- `src/components/ui/ChipGroup.tsx` (new) + tests
- LotteryFinderSection.tsx + SilentBoomSection.tsx migrations

**Verify:** Playwright screenshot diff of both sections shows
visual parity; toolbar interactions unchanged.

### Phase 2E — Extract `useTickerGrouping<T>`

**Risk:** verbatim duplicate at
[LotteryFinderSection.tsx:708-779](../../../src/components/LotteryFinder/LotteryFinderSection.tsx#L708) and
[SilentBoomSection.tsx:821-893](../../../src/components/SilentBoom/SilentBoomSection.tsx#L821).

**New files:**

- `src/hooks/useTickerGrouping.ts`
- `src/hooks/__tests__/useTickerGrouping.test.ts`

**Signature:**

```ts
function useTickerGrouping<T>(opts: {
  items: readonly T[];
  sortMode: SortMode;
  intensityKey: keyof T | ((item: T) => number);
  premiumFn: (item: T) => number;
  convictionFloor: ConvictionFloor;
}): TickerGroup<T>[];
```

(Both call sites pass effectively this — confirm exact field names
during implementation.)

**Migration:** Lottery + SilentBoom call this instead of inline
`useMemo` ladders.

**Verify:** snapshot test asserts grouping output for fixed
fixture matches both pre-refactor versions byte-for-byte.

### Phase 2F — Move shared charts to `src/components/charts/`

**Risk:** `SilentBoomRow.tsx` imports `ContractTapeChart` and
`TickerNetFlowChart` from `../LotteryFinder/`. Cross-feature import.

**Files (3 move + N updates):**

- Move `src/components/LotteryFinder/ContractTapeChart.tsx` → `src/components/charts/ContractTapeChart.tsx`
- Move `src/components/LotteryFinder/TickerNetFlowChart.tsx` → `src/components/charts/TickerNetFlowChart.tsx`
- Update all importers (`grep -rn 'from.*LotteryFinder/\\(ContractTape\\|TickerNetFlow\\)' src`)

**Verify:** `npm run review` clean; visual parity in both row
expanded views.

### Phase 2G — Lift shared literals to `src/types/index.ts`

**Risk:** `OptionType`, `MoneynessMode` (+ `MONEYNESS_FILTERS` +
`isMoneynessMode`), `ConvictionFloor`, `ScoreTier`,
`TakeItTopFeatures` are declared per-feature.

**Files (≤5):**

- `src/types/index.ts` — add canonical declarations
- `src/components/LotteryFinder/types.ts` — delete duplicates,
  re-export shared types
- `src/components/SilentBoom/types.ts` — same
- `src/components/LotteryFinder/LotteryFinderSection.tsx` — delete
  inline `MoneynessMode`/`ConvictionFloor` declarations
- `src/components/SilentBoom/SilentBoomSection.tsx` — same

`TakeItTopFeatures` cleanup may extend to a 2G-2 commit covering
`TakeItScore.tsx` + `MLInsights/FindingsSummary.tsx` (kill the
`as Record<string, unknown>` casts).

**Verify:** `tsc --noEmit` clean; no duplicate identifiers; no
behavior change.

### Phase 2H — `usePolling` adoption sweep (Pt 1)

**Risk:** [usePolling.ts:46](../../../src/hooks/usePolling.ts#L46) exists but
only 3 of ~30 polling hooks use it.

**Files (≤5):**

- `src/hooks/useLotteryFinder.ts`
- `src/hooks/useSilentBoomFeed.ts`
- `src/hooks/useTickerCandles.ts`
- `src/hooks/useNetFlowHistory.ts`
- `src/hooks/useTickerNetFlowBatch.ts`

**Change:** Replace hand-rolled `useEffect`+`setInterval`+cleanup
with `usePolling`. Polling intervals + `marketOpen` gates preserved
verbatim. AbortController stays from Phase 1C.

**Verify:** existing per-hook tests pass; if a test stubs the
interval directly, update to use whatever `usePolling` exposes.

### Phase 2I — `usePolling` sweep (Pt 2)

**Files (≤5):**

- `src/hooks/useDealerRegime.ts`
- `src/hooks/useZeroGamma.ts`
- `src/hooks/useGreekFlow.ts`
- `src/hooks/useNopeIntraday.ts`
- `src/hooks/useDarkPoolLevels.ts`

### Phase 2J — `usePolling` sweep (Pt 3)

**Files (≤5):**

- `src/hooks/usePeriscopeStrikes.ts`
- `src/hooks/useTrackerAlerts.ts`
- `src/hooks/useTrackerContracts.ts`
- `src/hooks/useGreekHeatmap.ts`
- `src/hooks/useGexStrikeExpiry.ts`

### Phase 2K — `usePolling` sweep (Pt 4 — remainder)

Remaining polling hooks identified by:

```bash
grep -lrn 'setInterval' src/hooks/ | xargs grep -L 'usePolling'
```

Split into ≤5-file commits.

### Phase 2L — Extract `useFetchedData<T>` primitive

**Risk:** ~20 hooks duplicate the same
`abortRef`+`mountedRef`+`URLSearchParams`+`setLoading/setError/setData`
ceremony.

**New files:**

- `src/hooks/useFetchedData.ts`
- `src/hooks/__tests__/useFetchedData.test.ts`

**Signature:**

```ts
function useFetchedData<T>(opts: {
  url: string | null;          // null = disabled
  marketOpen: boolean;
  pollIntervalMs?: number;     // omit = single fetch
  historical?: boolean;        // backtest mode bypass
  parse?: (raw: unknown) => T;
}): { data: T | null; loading: boolean; error: string | null; refresh: () => void; fetchedAt: number | null };
```

Built on top of `usePolling` + the existing `fetchJson` from
[useMarketData.fetchers.ts:49](../../../src/hooks/useMarketData.fetchers.ts#L49).

**Pilot migration:** convert `useTickerCandles.ts` to use it. Don't
migrate other hooks in this phase — validate the abstraction first.

**Verify:** `useTickerCandles` tests pass; network behavior
identical (Playwright network log diff before/after on a fixture).

### Phase 2M — `useFetchedData` migration sweep

**Files (≤5 per commit, multiple commits expected):**

Likely candidates (confirm by grepping for the duplicated ceremony):

- `useNetFlowHistory`, `useSilentBoomFeed`, `useLotteryFinder`,
  `useSilentBoomTickerCounts`, `useLotteryFinderTickerCounts`,
  `usePeriscopeStrikes`, `useDarkPoolLevels`, ...

Split into 2M-1, 2M-2, 2M-3 as needed. Each phase: replace the
boilerplate; tests assert identical return shape; **caller updates
ride in the same commit as the hook migration** (Option A, decided
2026-05-18). Tier 3 finding "hook return-shape consistency" is
cleaned up as a side effect.

**Canonical return shape:**

```ts
{ data: T | null; loading: boolean; error: string | null; refresh: () => void; fetchedAt: number | null }
```

#### Behavior-parity safeguards for Phase 2M shape migrations

The shape change is the highest-blast-radius part of this spec.
These safeguards are non-negotiable for every 2M sub-commit:

1. **TypeScript is the safety net.** Strict mode + zero `any` in
   this codebase means a missed rename surfaces as a tsc error.
   `npm run review` must pass before the commit lands; any tsc
   error is treated as "you missed a call site."
2. **Pre-migration callsite census.** Before editing each hook,
   produce a complete list of consumers:

   ```bash
   grep -rn "from.*hooks/<hookName>" src/ --include='*.ts' --include='*.tsx'
   ```

   Walk every match, identify which fields it reads, build the
   rename map (`.refetch()` → `.refresh()`, `.lastUpdated` →
   `.fetchedAt`, etc.), apply all in the same commit.
3. **No external-contract changes.** Only the *in-memory* hook
   return shape changes. Preserved verbatim:
   - localStorage keys
   - URL query params / API request shapes
   - DOM event handlers / refs
   - Sentry breadcrumb / log payloads
   - Any value passed to a chart library (`lightweight-charts`,
     etc.) — destructure the hook return first, pass the inner
     primitive
4. **Field-by-field semantic check.** When renaming a timestamp
   field, the *value* must be semantically identical:
   - `lastUpdated: string (ISO)` → `fetchedAt: number (epoch ms)`
     is a **type change**, not just a rename. The renaming commit
     must update every consumer that does `new Date(updatedAt)`
     or `.toLocaleString()` on the old field. Audit each.
   - `updatedAt` / `lastUpdated` consumers may also do string
     comparison (`updatedAt > prev.updatedAt`). Convert to numeric
     comparison.
5. **Behavior-parity test required.** Each migrated hook keeps
   its existing test file and gets at least one new assertion:
   given the same fixture inputs, the new return shape contains
   the same `data` and `error` values as before. (loading
   transitions and refresh cadence are validated by `useFetchedData`
   tests.)
6. **Manual smoke before commit.** For each migrated hook, run
   `npm run dev`, exercise the panel that consumes it, verify:
   - the panel renders the same content
   - the refresh button (if exposed) still triggers a refetch
   - the "last updated" UI label shows the correct timestamp
7. **Rollback plan.** If a 2M sub-commit's reviewer subagent
   returns `refactor`, revert the commit immediately (`git revert`,
   not `git reset` — we don't lose history). Re-plan the
   problematic hook's migration as a one-hook standalone phase if
   needed.
8. **No mass renames in a single commit.** Even if 12 hooks
   could be migrated in one PR, the 5-file cap forces incremental
   commits. This is the safety property: a bad rename only blasts
   a handful of components, not the whole app.

### Phase 2N — Extract `<LazySection>` primitive

**Risk:** the `<span id /> + ErrorBoundary + Suspense +
SkeletonSection` quad repeats ~10× verbatim in App.tsx.

**New files:**

- `src/components/ui/LazySection.tsx`
- `src/components/ui/__tests__/LazySection.test.tsx`

**Signature:**

```tsx
<LazySection id="sec-charts" label="Charts" fallback={<SkeletonSection lines={6} />}>
  <ChartAnalysis ... />
</LazySection>
```

**Migration:** all ~10 call sites in App.tsx in the same commit
(small per-site diff, single primitive).

**Verify:** scroll-to-anchor still works; error boundary still
catches; `.catch(handleStaleChunk)` behavior preserved on all
lazy imports.

### Phase 2O — Extract `<PanelRouter>` from App.tsx

**Risk:** 550-line inline `panelRenderers` IIFE at
[App.tsx:847-1395](../../../src/App.tsx#L847).

**New files:**

- `src/components/PanelRouter.tsx`
- `src/components/__tests__/PanelRouter.test.tsx`

**Approach:** `<PanelRouter />` receives `panelMap: Map<PanelId, () => ReactNode>`
constructed in App.tsx (closures still capture local hooks — App.tsx
shrinks but doesn't lose its data ownership). PanelRouter handles
the iteration over `resolvedGroups` + `resolvedPanelsByGroup` and
the group-header rendering.

**Verify:** every panel still renders in the same order; E2E
happy-path Playwright spec for at least 3 panels passes.

### Phase 2P — Split `useAppState`

**Risk:** [useAppState.ts:48](../../../src/hooks/useAppState.ts#L48) has no
explicit return type and is the most-imported hook in the app.

**New hooks (split along the comment-header boundaries already in
useAppState.ts):**

- `useTheme` (darkMode + persistence)
- `useSpotInputs` (spot, SPX direct, ratio + derived)
- `useIvInputs` (ivMode, vix, multiplier, directIV)
- `useTimeInputs` (hour/minute/AmPm/timezone)
- `useStrategyInputs` (wing/IC/skew/cluster/breakeven/BWB/portfolio)

Each hook has an explicit `UseXReturn` interface. Each gets its
own test file.

**Files:**

- `src/hooks/useTheme.ts` (new) + test
- `src/hooks/useSpotInputs.ts` (new) + test
- `src/hooks/useIvInputs.ts` (new) + test
- `src/hooks/useTimeInputs.ts` (new) + test
- `src/hooks/useStrategyInputs.ts` (new) + test
- `src/hooks/useAppState.ts` — becomes thin facade that composes
  the 5 sub-hooks and re-exports the same return shape; keep for
  back-compat in this phase

**Phase 2P-2 (separate commit):** call 5 sub-hooks directly in
App.tsx, delete the `useAppState` facade.

**Verify:** zero behavior change; all existing App.tsx tests pass.

### Phase 2Q — Split `hedge.ts`

**Risk:** [hedge.ts](../../../src/utils/hedge.ts) at 632 LOC with seams
already named at [:244](../../../src/utils/hedge.ts#L244),
[:344](../../../src/utils/hedge.ts#L344),
[:416](../../../src/utils/hedge.ts#L416),
[:477](../../../src/utils/hedge.ts#L477).

**Approach:** pure code move; no logic change.

**New files:**

- `src/utils/hedge/pricing.ts` (priceHedgeLegs)
- `src/utils/hedge/sizing.ts` (recommendHedgeContracts)
- `src/utils/hedge/scenarios.ts` (buildScenarioTable)
- `src/utils/hedge/constants.ts` (CRASH_SCENARIO_PCTS et al)
- `src/utils/hedge/index.ts` (calcHedge orchestrator + re-exports)
- Delete `src/utils/hedge.ts`

**Verify:** `src/__tests__/utils/hedge.test.tsx` passes
unchanged. If any test imports from `'./hedge.ts'` directly,
update to barrel import.

### Tier 2 checkpoint

Run code-reviewer subagent over the cumulative tier diff
(`git diff <pre-2A-sha>..HEAD`). Verdict `pass` required.

---

# Tier 3 — Cleanup that compounds quietly

### Phase 3A — Decompose `PeriscopePanel.tsx`

**Risk:** [PeriscopePanel.tsx](../../../src/components/Periscope/PeriscopePanel.tsx)
packs 13 sub-components in 805 LOC.

**Files (new):**

- `src/components/Periscope/ConeSection.tsx`
- `src/components/Periscope/GammaSection.tsx`
- `src/components/Periscope/CharmSection.tsx`
- `src/components/Periscope/VannaSection.tsx`
- `src/components/Periscope/FlipsSection.tsx`
- `src/components/Periscope/TradePlanSection.tsx` (if not already
  in `PlaybookSection.tsx`)
- `src/utils/periscope-charm-drift.ts` (extracted
  `computeCharmDriftRead`) + test

PeriscopePanel.tsx becomes a thin composition shell.

**Verify:** visual parity in Periscope panel; charm-drift unit
tests cover the extracted function.

### Phase 3B — Consolidate formatters

**Risk:** `format-magnitude.ts`, `flow-formatters.ts`,
`component-formatters.ts`, `ui-utils.ts` overlap.

**Approach:**

- `format-magnitude.ts` becomes the canonical source for
  signed/compact $/K/M/B
- `flow-formatters.ts` re-exports `formatPremium` and `formatGex`
  from `format-magnitude.ts`
- `ui-utils.ts` `fmtDollar` deleted in favor of canonical
- `pin-risk.ts` `formatOI` moved to `format-magnitude.ts`

**Files (≤5 per commit, split if needed).**

**Verify:** `tsc` clean; no duplicate function exports; all
formatter call sites still compile.

### Phase 3C — Fix inverted-dependency utils

**Risk:** utils importing types from `components/` or `hooks/`:

- [portfolio-risk.ts:18](../../../src/utils/portfolio-risk.ts#L18) → `components/PositionMonitor/types`
- [settlement.ts:2](../../../src/utils/settlement.ts#L2) → `components/SettlementCheck/types`
- [analysis.ts:1](../../../src/utils/analysis.ts#L1) → `components/ChartAnalysis/types`
- [candle-momentum.ts:16](../../../src/utils/candle-momentum.ts#L16) → `hooks/useGexTarget`
- [periscope-trade-plan.ts:29](../../../src/utils/periscope-trade-plan.ts#L29) → `hooks/usePeriscopeExposure`

**Change:** lift each cited type into `src/types/` (or a feature
type module under `src/types/`). Update both the util and the
original component/hook to import from the new home.

**Files (≤5 per commit):** group by feature.

### Phase 3D — Folder + entry-point naming hygiene

**Decision (2026-05-18):** canonicalize on `index.tsx` for top-level
feature roots.

**Migration:**

- `LotteryFinder/LotteryFinderSection.tsx` → `LotteryFinder/index.tsx`
  (re-export the named symbol if external imports rely on it)
- Same for `SilentBoom`, `Tracker`, `Gexbot`, `GreekHeatmap`
- Update App.tsx lazy imports

**Section vs Panel naming:** keep both; `Section` = top-level
feature root rendered by PanelRouter, `Panel` = inner subsection.
Document in CLAUDE.md.

**Loose top-level `src/components/*.tsx`:** audit list, fold any
>250 LOC into folders (`MarketRegimeSection`, `DarkPoolLevels`,
`AdvancedSection` are obvious candidates).

### Phase 3E — Hook return-shape rename sweep

**Note:** Largely subsumed by Phase 2M, but anything that
`useFetchedData` didn't catch gets cleaned here:

- `refetch` → `refresh` (the dominant name)
- `isLoading` → `loading` (1 outlier in `useNopeIntraday`)
- `updatedAt` / `lastUpdated` → `fetchedAt` (epoch ms canonical)

`grep -rn 'refetch\\|isLoading\\|updatedAt\\|lastUpdated' src/hooks src/components`
to find remaining cases.

### Phase 3F — Misc bundles (single commit)

Small fixes that don't justify their own phase:

- [main.tsx:14](../../../src/main.tsx#L14) — add `.catch(...)` to
  `import('@vercel/toolbar/vite')` (dev-only impact, but uniform
  policy)
- [App.tsx:1403](../../../src/App.tsx#L1403) — gate `<BacktestDiag />`
  on `historySnapshot != null` (or lazy-load it)
- [anomaly-sound.ts:83](../../../src/utils/anomaly-sound.ts#L83) —
  delete duplicate `getAudioContextCtor`, import from
  `audio-utils.ts`
- Export `hedge.ts` magic constants (`CRASH_SCENARIO_PCTS`,
  `BREAKEVEN_MAX_ITER`, `BREAKEVEN_SEARCH_PCT`) from
  `src/utils/hedge/constants.ts` (already done in Phase 2Q —
  verify here)
- Move `src/utils/__tests__/{panel-order,uw-occ-parse}.test.ts`
  to `src/__tests__/utils/` for consistency

### Tier 3 checkpoint

Final code-reviewer subagent over `git diff <pre-3A-sha>..HEAD`.
Verdict `pass` before declaring done.

---

## Files index (master list)

Created:

- `src/hooks/usePersistedState.ts`, `useTickerGrouping.ts`,
  `useFetchedData.ts`, `useTheme.ts`, `useSpotInputs.ts`,
  `useIvInputs.ts`, `useTimeInputs.ts`, `useStrategyInputs.ts`
- `src/components/ui/FilterToolbar.tsx`, `ChipGroup.tsx`,
  `LazySection.tsx`
- `src/components/PanelRouter.tsx`
- `src/components/charts/ContractTapeChart.tsx` (moved),
  `TickerNetFlowChart.tsx` (moved)
- `src/components/Periscope/{Cone,Gamma,Charm,Vanna,Flips}Section.tsx`
- `src/utils/hedge/{pricing,sizing,scenarios,constants,index}.ts`
- `src/utils/periscope-charm-drift.ts`
- Sibling `__tests__/<name>.test.ts(x)` for every new module above

Deleted:

- `src/utils/hedge.ts` (replaced by `src/utils/hedge/`)

Renamed:

- Several feature folders' entry points unified to `index.tsx`
  (Phase 3D)

Heavily modified:

- `src/App.tsx` (Phases 1B, 2N, 2O, 2P-2, 3F)
- `src/hooks/useAppState.ts` (Phase 2P; deleted in 2P-2)
- `src/components/{LotteryFinder,SilentBoom}/{Lottery,Silent}*Section.tsx`
- `src/components/GexLandscape/index.tsx` (Phase 2C)
- `src/components/GexTarget/PriceChart.tsx` (Phase 1A)
- All ~25 polling hooks listed in Phases 1C/1D, 2H–2K, 2M

## Data dependencies

None. This is a pure frontend refactor: no migrations, no new env
vars, no new external API calls, no schema changes.

## Thresholds / constants

- **Coverage floor:** hard floor at Phase 0 baseline. No "1%
  tolerance" — if a phase would dip coverage, write the missing
  test in the same phase.
- **Max files per phase commit:** 5 (CLAUDE.md rule).
- **Polling intervals:** preserved verbatim from existing hooks.
  No tuning in this refactor — that's a separate spec if needed.
- **localStorage keys:** preserved verbatim. `usePersistedState`
  must read/write the exact same keys current code does.

## Resolved decisions (2026-05-18)

All open questions from the original draft were resolved before
execution. Recorded here for traceability.

1. **Phase 1E — `useFuturesData` polling:** add a 30s
   `marketOpen`-gated poll matching sibling hooks.
2. **Phase 3D — entry-point naming:** canonicalize on `index.tsx`.
   Document the rule in CLAUDE.md as part of Phase 3D.
3. **Phase 2M — `useFetchedData` return shape:** Option A — caller
   updates ride in the same commit as each hook migration. Canonical
   shape `{ data, loading, error, refresh, fetchedAt }`. Tier 3's
   hook-shape consistency cleanup happens as a side effect. See
   "Behavior-parity safeguards" in Phase 2M.
4. **Phase 2D — `FilterRow` primitive:** respect the boundary set
   by `filter-toolbar-standardization-2026-05-17.md`; `FilterToolbar`
   consumes the schema but does not replace the row `<div>` directly.
5. **Phase 2H–2K — `usePolling` adoption exceptions:** leave
   non-`marketOpen`-gated hooks (`useOpeningFlowSignal`,
   `useNowMinute`) alone and document the exception in each hook's
   docstring.

## Out of scope

- **Backend** — no changes to `api/`, `sidecar/`, `uw-stream/`,
  `ml/`.
- **New features** — no behavior changes, no new endpoints, no UI
  redesign.
- **Performance optimization beyond Phase 1C/1D abort controllers.**
  No React Compiler enablement, no virtualization, no
  rendering-priority changes.
- **Conversion to TanStack Query / SWR.** `useFetchedData<T>` is
  the intentional bridge — staying in-house keeps the refactor
  bounded.
- **A11y audit / WCAG sweep.** Separate spec if needed.
- **Backwards-compat shims.** Migrations are direct; if a callsite
  breaks, fix it in the same commit. No legacy aliases.
- **Anything in `feedback_no_silent_methodology_changes.md`
  territory** — if a refactor seems to want a behavior change,
  stop and surface it, don't quietly land it.

## Done when

- All 17 audit findings closed (one Phase per finding cluster or
  cleanly grouped)
- Test coverage % ≥ Phase 0 baseline
- `npm run review` clean at HEAD
- Tier 1, 2, 3 checkpoint reviewer verdicts: all `pass`
- A short post-refactor metrics summary appended to
  `docs/superpowers/specs/frontend-cleanup-tiers-1-2-3-2026-05-18-baseline.md`
  with before/after LOC, file count, biggest 5 files, coverage
