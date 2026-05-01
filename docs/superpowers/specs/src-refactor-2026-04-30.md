# Frontend Refactor — src/ cleanup pass — 2026-04-30

## Goal

Reduce duplication and decompose oversized files in `src/` (hooks, components, utils) without changing UI behavior. Pulled from a parallel-agent assessment of the 30 largest TS/TSX files. The biggest wins are **shared primitives** (scrub controller, freshness ticker, polling, table sort) that remove duplication across multiple files at once — those go first, then file-by-file consumers follow.

## Constraints

- No UI behavior change. Visual diffs and snapshot tests must remain stable.
- All polling hooks already gate on `marketOpen` — keep that contract.
- Files in `src/` imported by `api/` need explicit `.js` on relative imports (per CLAUDE.md). Applies if any extracted util gets pulled server-side.
- Each phase must touch ≤5 files (CLAUDE.md `## Pre-Work`).
- Each phase ends with `npm run review` and a code-reviewer subagent verdict before commit.
- Commit directly to `main` (per memory `feedback_direct_to_main.md`).
- New code must ship with tests (per memory `feedback_always_test.md`).

## Files to create (new primitives)

```
src/hooks/useScrubController.ts          # scrub state machine
src/hooks/useWallClockFreshness.ts       # tick + isFresh derivation
src/hooks/usePolling.ts                  # gated setInterval primitive
src/hooks/useTableSort.ts                # generic sort state for tables
src/components/ui/SortableHeader.tsx     # shared <th> sort button
src/utils/flow-formatters.ts             # premium/pct/gex formatters
src/utils/futures-gamma/flow-signals.ts  # evaluateDriftOverride helper
src/utils/calibration-stats.ts           # niceTicks, median, classifyRegime
src/utils/chart-helpers.ts               # resampleTo5Min, computeVWAP, resolveThemeColor
```

## Files to modify (consumers)

```
src/hooks/useGexPerStrike.ts             # adopt scrub + freshness + polling
src/hooks/useGexTarget.ts                # adopt scrub + freshness + polling
src/hooks/useMarketData.ts               # adopt polling
src/hooks/useFuturesGammaPlaybook.ts     # extract sub-hooks
src/hooks/useChartAnalysis.ts            # move pure utils out
src/components/OptionsFlow/WhalePositioningTable.tsx
src/components/OptionsFlow/OptionsFlowTable.tsx
src/components/GexTarget/index.tsx       # extract selectTarget + header
src/components/GexTarget/PriceChart.tsx  # move chart utils out
src/components/GexLandscape/index.tsx    # collapse 5 delta windows
src/components/PositionMonitor/PositionRow.tsx  # split mobile cards
src/components/TRACELive/TRACELiveCalibrationPanel.tsx  # extract Scatter + stats
src/components/DarkPoolLevels.tsx        # adopt shared scrub controls
src/App.tsx                              # GatedSection + AppHeader
src/utils/futures-gamma/triggers.ts      # buildTriggerState factory
src/utils/futures-gamma/playbook.ts      # rule builders, dedupe regime mirrors
src/utils/futures-gamma/tradeBias.ts     # extract buildBreakBias helper
src/utils/hedge.ts                       # decompose calcHedge
src/utils/timezone.ts                    # consolidate wallClockToUtcIso
```

## Phases

### Phase 1 — Cross-cutting primitives (highest leverage)

These are the foundation. Other phases consume them. Tests-first.

**1a. Scrub + freshness primitives** (≤5 files)

- Create `useScrubController(timestamps)` returning `{ scrubTimestamp, isScrubbed, canScrubPrev, canScrubNext, scrubPrev, scrubNext, scrubTo, scrubLive }`.
- Create `useWallClockFreshness(timestamp, thresholdMs, gates)` returning `{ nowMs, isFresh, ageMs }`.
- Vitest unit tests for both.
- Adopt in `useGexPerStrike.ts` (lines ~341-369, 379-427) and `useGexTarget.ts` (lines ~498-525, 535-583).
- Verify: `npm run review` clean; `useGexPerStrike.test.ts` and `useGexTarget.test.ts` still green.

**1b. Polling primitive** (≤5 files)

- Create `usePolling(fn, intervalMs, gates)` — boolean gates array; returns nothing.
- Tests cover: gate flip on/off, cleanup, fn change.
- Adopt in `useMarketData.ts` (338-389), `useGexPerStrike.ts` (289-339), `useGexTarget.ts` (454-458).
- Verify: existing hook tests pass; manual smoke = polling stops outside market hours.

**1c. Table sort primitives** (≤5 files)

- Create `flow-formatters.ts` exporting `formatPremium`, `formatPct`, `formatGex` (and any other duplicate found via diff between `WhalePositioningTable` 65-139 and `OptionsFlowTable` 68-115).
- Create `useTableSort<T>({ rows, keyExtractors, defaultKey, defaultDir })` returning `{ sortedRows, sortKey, sortDir, setSort }`.
- Create `<SortableHeader>` component (shared shape from both tables, ~50 LOC).
- Tests for all three.
- Verify: `npm run review` clean.

**1d. evaluateDriftOverride helper** (≤2 files)

- Create `flow-signals.ts` exporting `evaluateDriftOverride(flowSignals): { up, down }`.
- Tests for both axes.
- Verify: `npm run review` clean.

### Phase 2 — High-priority consumers

**2a. WhalePositioningTable + OptionsFlowTable** (2 files)

- Replace inline formatters with `flow-formatters.ts` imports.
- Replace local sort state with `useTableSort`.
- Replace local `SortableHeader` definitions with shared component.
- Extract `WhaleAlertRow` (lines 546-624) and `OptionsFlowRow` (459-561) as named subcomponents within their files.
- Verify: existing component tests pass; visually inspect both tables in dev (sort still works, columns still align).

**2b. useFuturesGammaPlaybook split** (≤4 files)

- Extract `useSpxMaxPain(selectedDate, isOwner)` (currently lines 510-586).
- Extract `useSnapshotBuffer(...)` (currently lines 647-779).
- Move pure helpers `deriveSpxLevels` (215-290), `buildEsLevels` (309-389), `computeSessionPhaseBoundaries` (398-434) to `src/utils/futures-gamma/`.
- Add tests for the pure helpers (they're testable in isolation now).
- Verify: `npm run review` clean; FuturesGammaPlaybook UI loads in dev with no console errors.

**2c. GexTarget/index.tsx — selectTarget extraction** (2 files)

- Move `activeScore` useMemo (158-222) into `selectTarget(leaderboard, priceCtx, weights)` in `src/utils/gex-target.ts` (file already exists).
- Add unit tests for `selectTarget`.
- Verify: GexTarget panel renders identically; tests green.

**2d. evaluateTriggers buildTriggerState factory** (1 file + tests)

- Refactor `triggers.ts` (lines 145-441): extract `buildTriggerState({ id, name, condition, level, status, distance, blockedReason })` and decision-table helpers.
- Existing tests for `evaluateTriggers` should pass unchanged.
- Verify: `npm run review` clean; trigger snapshots stable.

### Phase 3 — Medium-priority cleanups

**3a. App.tsx — GatedSection + AppHeader** (≤3 files)

- Create `<GatedSection id label fallback children>` wrapper consuming the 9-times-repeated auth gate (App.tsx lines 1147-1389).
- Extract `<AppHeader>` and `<OwnerAdminBar>` from App.tsx lines 763-972.
- Verify: e2e nav still works; auth-gated sections still hidden when logged out.

**3b. PositionRow.tsx split** (≤3 files)

- Move mobile cards (lines 397-823) to `PositionCards.tsx`.
- Move duplicated IC P&L/cushion logic (110-127, 480-493) to `position-helpers.ts`.
- Verify: PositionMonitor renders both mobile and desktop layouts unchanged.

**3c. TRACELiveCalibrationPanel** (≤3 files)

- Move `niceTicks` / `median` / `classifyRegime` (lines 79-104, 160-166) to `src/utils/calibration-stats.ts`.
- Extract `Scatter` (lines 331-480) to its own file.
- Add tests for the stats helpers.
- Verify: panel renders identically.

**3d. utils/hedge.ts — calcHedge decomposition** (1 file + tests)

- Extract `priceHedgeLegs(...)`, `recommendHedgeContracts(...)`, `buildScenarioTable(...)`.
- Promote magic numbers: `CRASH_SCENARIO_PCTS`, `BREAKEVEN_MAX_ITER`, `BREAKEVEN_SEARCH_PCT`.
- Verify: `hedge.test.ts` passes unchanged.

**3e. utils/futures-gamma/playbook.ts + tradeBias.ts** (2 files)

- Extract `buildFadeCallRule` / `buildLiftPutRule` / `buildBreakRule(direction)` builders from `rulesForRegime` (playbook.ts 283-491).
- Extract `buildBreakBias(direction, rule, flow, reasonOnAligned, reasonOnUnaligned)` from `tradeBias.ts` (156-322).
- Verify: existing snapshot tests pass.

**3f. utils/timezone.ts wallClockToUtcIso** (1 file)

- Collapse `etWallClockToUtcIso` and `ctWallClockToUtcIso` into `wallClockToUtcIso(dateStr, minutes, formatter)`; keep public functions as 1-line wrappers.
- Verify: `timezone.test.ts` passes.

**3g. GexLandscape useMultiWindowDeltas** (1 file)

- Replace 5 individual `gexDeltaXMap` useState slots with `useMultiWindowDeltas([1, 5, 10, 15, 30])`.
- Verify: GexLandscape table renders identically.

### Verification (always last)

- `npm run review` — full pipeline (tsc + eslint + prettier + vitest --coverage).
- Manual smoke: load `npm run dev`, click through GexLandscape, GexTarget, PositionMonitor, OptionsFlow, FuturesGammaPlaybook, Calibration panel.
- Final code-reviewer subagent on the full diff.

## Open questions

- **Q1: Scrub controller scope** — `useGexPerStrike` and `useGexTarget` have slightly different scrub semantics (one uses ts strings, one uses ms numbers). Default: parameterize the timestamp type.
- **Q2: PositionCards naming** — split into one file per position type (`IronCondorView.tsx` etc.) or one combined `PositionCards.tsx`? Default: combined file (smaller surface).
- **Q3: SortableHeader location** — `src/components/ui/` (general) or `src/components/OptionsFlow/` (current home)? Default: `ui/` since other tables will adopt it.

## Thresholds / constants to name

- `CRASH_SCENARIO_PCTS = [0.015, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.1]` (hedge.ts)
- `BREAKEVEN_MAX_ITER = 50` (hedge.ts)
- `BREAKEVEN_SEARCH_PCT = 0.15` (hedge.ts)
- `WALL_FLOW_ALIGNMENT_THRESHOLD` (tradeBias.ts — already exists at line 105, hoist to shared)
- `FRESHNESS_TICK_MS = 1000` (useWallClockFreshness)
- `DEFAULT_FRESHNESS_THRESHOLD_MS = 60_000` (useWallClockFreshness)

## Skip / defer

- `useMarketData.getETCalendarAndMinutes` extraction to `src/data/marketHours.ts` — minor, can do later.
- `useChartAnalysis` `compressImage` / `playChime` extraction — minor, defer.
- `iron-condor.ts` — already clean, no refactor.
- `gex-target/scorers.ts` and `features.ts` — already clean.

## Deferred at completion (2026-04-30)

These were originally scoped but deferred when the refactor pass shipped:

- **Phase 3c — TRACELiveCalibrationPanel Scatter + stats extraction.** The file
  had uncommitted edits from a parallel session at the time of the refactor.
  Once those edits land or are discarded, the `calibration-stats.ts` and
  `Scatter.tsx` extraction can ship as a small follow-up phase.
- **DarkPoolLevels `<ScrubControlsCompact>` extraction.** The plan listed this
  under Phase 1 consumers, but the actual refactor target is a 132-LOC UI
  toolbar (DarkPoolLevels lines 168-300), not a state-machine adoption.
  GexTarget's header has the same shape. A future phase should extract a
  shared `<ScrubControlsCompact>` UI component (date picker + scrub buttons +
  page indicator + sort dropdown) and consume it in both panels.

## Done when

- All Phase 1-3 sub-tasks committed to `main`. ✅ (15 of 16 phases shipped;
  3c deferred per above; DarkPoolLevels UI extraction deferred per above)
- `npm run review` green. ✅
- Final code-reviewer subagent verdict = `pass`. ✅ (final review on
  full diff returned `pass`)
- No UI behavior regressions found in dev smoke test. ✅ (each phase
  verified in isolation; consumer tests all green)

## Outcome

Shipped phases (in commit order):

| Phase | Commit    | Title                                                |
| ----- | --------- | ---------------------------------------------------- |
| 1a    | fd465e55  | useScrubController + useWallClockFreshness           |
| 1b    | a6db22bb  | usePolling                                           |
| 1c    | 2c8177ff  | flow-formatters + useTableSort                       |
| 1d    | db8a6acc  | evaluateDriftOverride helper                         |
| 2a    | 9def0412  | SortableHeader + flow tables adopt primitives        |
| 2b    | 82570119  | useFuturesGammaPlaybook split (915 → 470 LOC)        |
| 2c    | 8afeaa78  | selectTarget extraction from GexTarget               |
| 2d    | 2cbdc105  | evaluateTriggers buildTriggerState factory           |
| 2d.fu | 15c1ad5b  | walLabel typo fix                                    |
| 3a    | f2922b1a  | App.tsx GatedSection + AppHeader (1524 → 1270 LOC)   |
| 3b    | 1a33b6d8  | PositionRow split (823 → 370 LOC)                    |
| 3b.fu | 6010ff05  | PctMaxBar lift                                       |
| 3d    | f27a84ac  | calcHedge decomposition                              |
| 3e    | 6c675b07  | playbook + tradeBias rule builders + drift adoption  |
| 3f    | 5d47ed1c  | wallClockToUtcIso consolidation                      |
| 3g    | e90f2073  | GexLandscape useMultiWindowDeltas                    |

Final: **9222 tests pass** across 446 files; coverage 95.23% lines /
93.56% statements. Net ~1,500 LOC of duplication removed from consumer
files; new primitives ship with their own tests.
