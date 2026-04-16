# React & TypeScript Audit Remediation

**Date:** 2026-04-16
**Source:** In-depth codebase audit performed 2026-04-16 via four parallel Explore subagents covering hooks, components, utils/types, and api/ backend.
**Overall grade at audit time:** B+. Fundamentals are solid (strict mode, Zod at boundaries, pino logging, parameterized SQL). Pain clusters in a handful of monolithic files, leaky error-handling patterns, and inconsistent memoization discipline.

## Goal

Address 21 prioritized findings from the React/TypeScript audit to bring the codebase from B+ to A-tier quality — no god-components, no silent failures, consistent type safety at boundaries, and removal of the top duplication hotspots.

## Guiding Principles

- **Step 0 rule applies per file.** Before refactoring any file >300 LOC, first remove dead props/imports/logs in a separate commit.
- **Phased execution.** Each phase is independently shippable. Run `npm run review` between phases.
- **Test-first for refactors.** No decomposition without the existing test suite passing; add characterization tests if coverage is thin.
- **Resist over-memoization.** React Compiler is stable-RC; aggressive manual `useMemo`/`useCallback` ages poorly. Only memoize what demonstrably matters.

## Thresholds & Constants

- **File-size ceiling:** 500 LOC for components, 400 LOC for utils, 600 LOC for api/_lib modules. Files above → split candidate.
- **Prop-count ceiling:** 12 props per component before grouping into settings objects.
- **Dependency-array ceiling:** 10 dependencies on a single `useMemo`/`useEffect`. Over → split.
- **Test coverage floor:** Every exported util in `src/utils/` must have a co-located test file.

## Phases

### Phase 1 — Safety net (highest risk, lowest effort) — ~1 day

Fix silent failures and validation bypasses first. These are production risks; every day they ship is a day bad data can reach Claude's analysis.

**Files to modify:**

1. **[api/alerts-ack.ts:27](../../api/alerts-ack.ts)** — Replace `as { id?: number }` cast with Zod schema. Add `alertAckSchema` to [api/_lib/validation.ts](../../api/_lib/validation.ts).
2. **[api/positions.ts](../../api/positions.ts)** — POST accepts raw CSV with no schema. Add `positionCsvSchema` (file size + MIME check + parsed-row schema) to `validation.ts`.
3. **[api/_lib/api-helpers.ts:517](../../api/_lib/api-helpers.ts)** — Replace `.catch(() => '')` with `.catch(e => '[parse error: ${e.message}]')` + explicit throw. Do not silently continue.
4. **[api/_lib/darkpool.ts:104](../../api/_lib/darkpool.ts),[:192](../../api/_lib/darkpool.ts),[:234](../../api/_lib/darkpool.ts)** — Fix three swallowed errors. Line 234 specifically must add `Sentry.captureException(err)` before throw — `analyze.ts` calls this synchronously, so silent failure = Claude gets stale/empty dark pool context.
5. **[api/_lib/spx-candles.ts:231](../../api/_lib/spx-candles.ts)** — Remove `.catch(() => '')`.
6. **[api/_lib/max-pain.ts:56](../../api/_lib/max-pain.ts)** — Remove `.catch(() => '')`.
7. **[api/_lib/alerts.ts:87](../../api/_lib/alerts.ts)** — Remove `.catch(() => '')`.
8. **[api/_lib/iv-term-structure.ts:47](../../api/_lib/iv-term-structure.ts)** — Remove `.catch(() => '')`.
9. **[api/cron/backfill-futures-gaps.ts:99](../../api/cron/backfill-futures-gaps.ts)** — Remove `.catch(() => '')`.
10. ~~**[tsconfig.json:24](../../tsconfig.json)** — Flip `exactOptionalPropertyTypes: false` → `true`.~~ **DEFERRED to Phase 1B (2026-04-16).** Flip produced 119 errors, well above the 50-error threshold set for this phase. See "Phase 1B — exactOptionalPropertyTypes" below.

**Verification:** `npm run review` passes. Manually trigger an error path on dark pool (e.g., bad API key) and confirm Sentry receives it.

### Phase 1B — exactOptionalPropertyTypes strict flag (separate PR) — ~1 day

Flipping `exactOptionalPropertyTypes: true` produces ~119 TS errors across:

- **Frontend (most errors):** component Props interfaces declared as `foo?: T` where tests pass `foo: undefined`. 71 in [src/__tests__/components/DeltaRegimeGuide.test.tsx](../../src/__tests__/components/DeltaRegimeGuide.test.tsx) alone; also BWBSection, IronCondorSection, ChartAnalysis, TradingScheduleSection, HedgeSection tests plus the hook tests (useRangeAnalysis, useComputedSignals, useSnapshotSave).
- **Backend:** [api/positions.ts](../../api/positions.ts), [api/cron/fetch-outcomes.ts](../../api/cron/fetch-outcomes.ts), [api/cron/fetch-darkpool.ts](../../api/cron/fetch-darkpool.ts), [api/ml/plot-image.ts](../../api/ml/plot-image.ts), [api/options-flow/whale-positioning.ts](../../api/options-flow/whale-positioning.ts), [api/cron/curate-lessons.ts](../../api/cron/curate-lessons.ts).

**Root pattern:** Interfaces declared `foo?: T` but callers pass `foo: undefined` explicitly.

**Fix strategy (pick one per file, prefer #1 for mechanical sites):**

1. Widen the interface: `foo?: T` → `foo?: T | undefined`. Preferred for shared types.
2. Fix the caller: use conditional spread `...(value !== undefined && { foo: value })` to omit the key. Preferred for Props passed from tests.

**Scope:** ~25 files, ~119 errors. Do this as its own branch `react-ts-audit-phase1b`. Partial widenings already applied in Phase 1 (PositionLeg, SkippedLesson, getHistoricalWinRate, formatWinRateForClaude, buildAnalysisContext) are no-ops with the flag off and serve as preparation.

### Phase 2 — Decompose the monoliths — ~3–4 days, one file per session

Each file below is a full session. Do not attempt two in one go. Start every session with a Step 0 dead-code pass (separate commit), then the decomposition.

**Phase 2.1 — [src/components/GexPerStrike.tsx](../../src/components/GexPerStrike.tsx) (1,131 LOC)**

Extract into feature folder `src/components/GexPerStrike/`:
- `index.tsx` (orchestrator, <200 LOC)
- `StrikesTable.tsx` (table DOM + row rendering)
- `SummaryCards.tsx` (top aggregate cards)
- `ScrubControls.tsx` (snapshot navigation, refresh button)
- `useGexViewMode.ts` (hook: 7 useState + filter/window logic)
- `formatters.ts` (move `formatNum`, `formatFlowPressure`, `formatTime` here; possibly merge into `src/utils/formatting.ts` if generic enough)

Also fix inline `style={{...}}` objects at lines 176, 518, 536, 548 (hoist to `useMemo` or theme tokens). Replace hardcoded `rgba(...)` and hex colors (lines 175, 184, 277, 518, 534, 548) with theme tokens (`surfaceDim`, `accentAlt`, `greenDim`, `amberDim`). Add focus-visible outlines to icon-only buttons (lines 474, 506, 555, 564).

**Phase 2.2 — [src/components/FuturesCalculator/index.tsx](../../src/components/FuturesCalculator/index.tsx) (996 LOC)**

Extract:
- Keep `index.tsx` as the orchestrator (<250 LOC)
- `TickLadderTable.tsx`
- `PositionSizingPanel.tsx`
- `ScenarioInputs.tsx`
- `useFuturesPnL.ts` (P&L calculation hook)
- `useAccountSettings.ts` (account persistence hook)

**Reduce over-memoization.** Of 8 `useMemo` blocks (lines 216–297), keep only the expensive ones (full P&L calc, position sizing). Inline the rest — this is a calculator with <100 renders/session; `chipClass` as `useMemo` is noise.

**Phase 2.3 — [src/utils/gex-target.ts](../../src/utils/gex-target.ts) (1,214 LOC)**

Split into folder `src/utils/gex-target/`:
- `index.ts` (re-exports public API; preserves existing import paths)
- `scorer-oi.ts` (~400 LOC, OI-based scoring)
- `scorer-vol.ts` (~300 LOC, volume-based scoring)
- `scorer-dir.ts` (~250 LOC, directional scoring)
- `features.ts` (~200 LOC, shared feature extraction)
- `tiers.ts` (~50 LOC, tier assignment, wall detection)

After split, consolidate existing scattered tests into `src/__tests__/utils/gex-target/` mirroring the new structure. Confirm public API surface is unchanged before merging.

**Phase 2.4 — [src/hooks/useAppState.ts:122-236](../../src/hooks/useAppState.ts)**

Split the single 26-dep `useMemo` into logical sub-objects. Target shape:

```typescript
return {
  ui: useMemo(() => ({ theme, darkMode, ...toggles }), [/* ui deps */]),
  data: useMemo(() => ({ spot, iv, ...marketValues }), [/* data deps */]),
  setters: useMemo(() => ({ setSpot, setIv, ... }), []),  // setters are stable
};
```

Each sub-object: ≤10 deps. Verify downstream `React.memo` boundaries benefit — pick 2–3 child components and confirm they no longer re-render on unrelated state changes (React DevTools Profiler).

**Phase 2.5 — [api/_lib/analyze-context.ts](../../api/_lib/analyze-context.ts) (1,522 LOC)**

Split:
- `analyze-context.ts` (builder, ~400 LOC — assembles context from fetched data)
- `analyze-context-fetchers.ts` (~800 LOC — `fetchFlowData`, `fetchGexData`, etc.)
- Keep public signature of `buildAnalyzeContext()` unchanged.

**Verification per sub-phase:** `npm run review` + `git diff --stat` shows file-count delta but LOC delta is near-zero (code moved, not rewritten). Run [api/__tests__/analyze.test.ts](../../api/__tests__/analyze.test.ts) for Phase 2.5.

### Phase 3 — Structural fixes — ~1 day

**Files to modify:**

1. **[src/components/AdvancedSection.tsx](../../src/components/AdvancedSection.tsx)** — Collapse 23-prop interface into grouped settings objects:
   ```typescript
   interface AdvancedSectionProps {
     skew: { value: number; onChange: (v: number) => void };
     ironCondor: { show: boolean; onToggle: () => void; wingWidth: number; /* ... */ };
     bwb: { show: boolean; /* ... */ };
     vix: { show: boolean; /* ... */ };
   }
   ```
2. **[src/components/IronCondorSection/PnLProfileTable.tsx](../../src/components/IronCondorSection/PnLProfileTable.tsx) + [src/components/BWBSection/BWBPnLProfileTable.tsx](../../src/components/BWBSection/BWBPnLProfileTable.tsx)** — Extract generic `<PnLProfileTable>` to `src/components/shared/PnLProfileTable.tsx` accepting `rows: PnLRow[]` and a row-mapper function. Both IC and BWB become thin wrappers. Target: 510 LOC → ~250 LOC + two ~40-LOC mappers.
3. **[src/hooks/useVixData.ts:68-133](../../src/hooks/useVixData.ts)** — Consolidate the two racing effects (static-data lookup + API fallback) into one effect. Add `apiPendingRef: useRef<AbortController | null>` and cancel in-flight requests on date change.
4. **[src/hooks/useAutoFill.ts:140](../../src/hooks/useAutoFill.ts),[:210](../../src/hooks/useAutoFill.ts)** — Remove `eslint-disable-next-line react-hooks/exhaustive-deps`. Destructure ref values at hook entry and add to dep arrays explicitly. If refs are genuinely stable, document why in a single-line comment.
5. **[src/hooks/useAlertPolling.ts:159](../../src/hooks/useAlertPolling.ts)** — Replace `as { alerts: MarketAlert[] }` with the `FetchResult<T>` discriminated pattern from [src/hooks/useMarketData.fetchers.ts](../../src/hooks/useMarketData.fetchers.ts).
6. **[src/hooks/useChartAnalysis.ts:302](../../src/hooks/useChartAnalysis.ts)** — Same fix; replace `(err as Error & { status?: number })` with `'status' in err` type guard.
7. **[api/_lib/build-features-types.ts](../../api/_lib/build-features-types.ts)** — Replace `FeatureRow = Record<string, any>` with a typed interface listing each feature column.
8. **[api/_lib/futures-context.ts](../../api/_lib/futures-context.ts)** — Replace `as unknown as FuturesSnapshot[]` and `as unknown as EsOptionsDailyRow[]` with Zod `safeParse` on DB result rows.

### Phase 4 — Hygiene pass — ~1 day

Grouped trivial cleanups; can be done in a single session.

1. **Consolidate [src/components/ChartAnalysis/](../../src/components/ChartAnalysis/)** — Merge `AnalysisHistory.tsx` + `AnalysisHistoryPicker.tsx` + `AnalysisHistoryItem.tsx` into `<HistoryList>` + `<HistoryItem>`. Target 17 files → ~10 files.
2. **Fix `parseInt` radix** — [src/utils/time.ts:138-139](../../src/utils/time.ts), [src/utils/gex-target.ts:760-761](../../src/utils/gex-target.ts). Add `, 10` to all `Number.parseInt` calls.
3. **Extract rounding helpers** — Add `roundToHalf(n)` and re-export `round2`, `round0` from [src/utils/formatting.ts](../../src/utils/formatting.ts). Replace 6 duplicated `Math.round(n * factor) / factor` sites across [src/utils/strikes.ts](../../src/utils/strikes.ts) and [src/utils/settlement.ts](../../src/utils/settlement.ts).
4. **Add missing test** — Create [src/__tests__/utils/time.test.ts](../../src/__tests__/utils/time.test.ts) consolidating coverage from `timeValidation.test.ts` + `resolveIV.test.ts`, adding tests for any uncovered exports in [src/utils/time.ts](../../src/utils/time.ts).
5. **Migrate stray `process.env` reads** — All direct `process.env.X` outside [api/_lib/env.ts](../../api/_lib/env.ts) should use `requireEnv()` or `optionalEnv()`. Grep target: `process\.env\.` in `api/_lib/` excluding `env.ts` and `sentry.ts` platform-var reads.
6. **Remove unused `.map` index parameters** — 30 files use `.map((item, i) => ...)` where `i` is unused. Run a codemod or let ESLint `no-unused-vars` catch them; add the rule if missing.
7. **Tailwind `cva` extraction** — Long `className` strings (>150 chars) in [src/components/AdvancedSection.tsx:70-86](../../src/components/AdvancedSection.tsx) should use `cva` or a shared `classNames` helper.

### Phase 5 — Verification (LAST)

- `npm run review` → zero errors
- `npm run test:e2e` → all Playwright specs pass
- Manual smoke test of GexPerStrike and FuturesCalculator in `npm run dev:full` — both render, interactions work, no console errors
- Sentry dashboard check: no new error categories surfaced from Phase 1 error-handling changes
- React DevTools Profiler: confirm `useAppState` split actually reduces re-render count on children

## Files to Create

- `src/components/GexPerStrike/` folder (6 files)
- `src/components/FuturesCalculator/` new files (5 hooks/components — `index.tsx` already exists)
- `src/utils/gex-target/` folder (6 files)
- `src/components/shared/PnLProfileTable.tsx`
- `src/__tests__/utils/time.test.ts`
- `api/_lib/analyze-context-fetchers.ts`

## Files to Modify (summary)

**Frontend (17):**
- `src/hooks/useAppState.ts`, `useVixData.ts`, `useAutoFill.ts`, `useAlertPolling.ts`, `useChartAnalysis.ts`
- `src/components/GexPerStrike.tsx` (→ folder), `FuturesCalculator/index.tsx`, `AdvancedSection.tsx`, `IronCondorSection/PnLProfileTable.tsx`, `BWBSection/BWBPnLProfileTable.tsx`
- `src/utils/gex-target.ts` (→ folder), `time.ts`, `strikes.ts`, `settlement.ts`, `formatting.ts`
- `src/components/ChartAnalysis/*.tsx` (consolidation)
- `tsconfig.json`

**Backend (12):**
- `api/alerts-ack.ts`, `api/positions.ts`
- `api/_lib/validation.ts` (add schemas), `api-helpers.ts`, `darkpool.ts`, `spx-candles.ts`, `max-pain.ts`, `alerts.ts`, `iv-term-structure.ts`, `build-features-types.ts`, `futures-context.ts`, `analyze-context.ts`
- `api/cron/backfill-futures-gaps.ts`

## Data Dependencies

**None.** No new DB tables, no new migrations, no new env vars, no new external APIs. This is purely a refactor + hardening pass.

## Open Questions

1. **`exactOptionalPropertyTypes: true` blast radius** — unknown until the flag is flipped. Default: if it produces >50 errors, split Phase 1 into two PRs (error handling first, strict flag second).
2. **GexPerStrike feature-folder naming** — current single-file component has no folder; folder name `GexPerStrike/` vs. renaming to `StrikesGrid/` (more accurate). Default: keep `GexPerStrike/` to avoid churn in imports across the app.
3. **Should `useGexViewMode` hook be generic or tightly coupled?** Default: tightly coupled to the component for now. Extract generically only if a second caller appears.
4. **PnLProfileTable generic API shape** — `rows: PnLRow[]` vs. `rows: { puts: PnLRow[]; calls: PnLRow[] }`? Default: flat `rows` with `side: 'put' | 'call' | 'short'` discriminant.
5. **Branded types for `Strike`, `Premium`, `USD`, `Delta`** — deferred to a separate future spec. Low-priority and touches almost every file; not bundled here.

## Verdict on Completion

Remediation is complete when:

- [ ] All Phase 1 files merged and Sentry confirms error visibility on dark pool failures
- [ ] No file in `src/components/` exceeds 500 LOC
- [ ] No file in `src/utils/` exceeds 400 LOC
- [ ] No file in `api/_lib/` exceeds 600 LOC
- [ ] Zero `as unknown as` casts in `api/_lib/`
- [ ] Zero `.catch(() => '')` or `.catch(() => [])` in `api/`
- [ ] `exactOptionalPropertyTypes: true` in tsconfig with clean build
- [ ] Every `src/utils/*.ts` has a matching test file
- [ ] `npm run review` passes
- [ ] Re-running the audit returns grade A or A-

## What the Codebase Does Well (preserve these)

- Zod at system boundaries, centralized in `api/_lib/validation.ts`
- Parameterized SQL everywhere — zero string interpolation
- Logger + Sentry pairing on error paths; zero `console.log` in production
- Pure utility layer — no hidden side effects, divisions guarded
- Polling discipline — hooks gate on `marketOpen`
- Return-type discipline on exported backend helpers
- No dead cron handlers — all registered, all handlers present
- No duplicate types across `src/` and `api/`

None of the phased work above should regress these. If a review flags something that looks like a regression on any of the above, STOP and escalate.
