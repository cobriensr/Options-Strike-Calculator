# Analyze Endpoint: Position-State Honesty + Delta-Aware Strike Picks

Date: 2026-04-20
Status: Draft — awaiting approval before Phase 1

## Goal

Stop Claude from (a) hallucinating filled positions when no papermoney CSV was uploaded for the current session and (b) recommending sub-10Δ strikes when the trader's preferred entry delta is ~12Δ. Both failures share a root cause: the analyze endpoint does not pass enough ground truth — current position state or per-strike delta — so Claude falls back to its prior recommendation and generic guidance.

## Problem Statement (from session 2026-04-20)

1. Claude rendered a Mid-Day re-analysis that said `Entry 1: CALL CREDIT SPREAD 0Δ at 0% size · FILLED — manage existing only` and then told the trader to "buy-to-close the 7075P/7050P put spread at market." No CSV was uploaded today → no rows in `positions` table for `date = 2026-04-20` → there is no open position. Claude treated its own earlier recommendation as evidence of a fill.
2. The trader's preferred entry is **~12Δ (floor 10Δ)**. Claude has been picking 4Δ strikes. The model cannot see the per-strike delta curve — only aggregate ceilings and derived skew metrics are passed in `AnalysisContext`.

## Current State (verified)

### Positions pipeline

- `POST /api/positions` parses a thinkorswim papermoney CSV → `savePositions()` → `positions` table (`api/_lib/db-positions.ts:53`).
- `getLatestPositions(date)` returns the most recent row for that date, or `null`.
- `api/_lib/analyze-context.ts:142-168` already calls `getLatestPositions` in entry/midday modes. When it returns `null`, `positionContext` is set to `null` and the "Current Open Positions" section is simply **omitted** from the user message.
- **Gap**: silence is not honest. Claude interprets the absence as "positions still in place from earlier rec" rather than "flat."

### Chain pipeline

- `useChainData` (`src/hooks/useChainData.ts`) holds the full `ChainResponse` with per-strike `{strike, bid, ask, mid, delta, gamma, theta, vega, iv, volume, oi, itm}` for both puts and calls, plus `targetDeltas: Partial<Record<number, TargetDeltaMatch>>` (pre-matched 5/10/15/20/25/30Δ rungs).
- `AnalysisContext` (`src/components/ChartAnalysis/types.ts:3`) currently passes only `topOIStrikes` (5 highest-OI strikes) and `skewMetrics` (derived aggregates) from the chain.
- `deltaCeiling`, `putSpreadCeiling`, `callSpreadCeiling` are passed but are **ceilings**, not targets. No floor is defined anywhere.
- **Gap**: Claude cannot map a delta to a strike because the delta curve is not in the prompt. It picks whatever "feels far enough OTM" based on point distance, which skews low-delta on calm days.

## Phases

### Phase 1 — Position-state honesty (2 files)

1. In `api/_lib/analyze-context.ts`, replace the silent-omission pattern with an affirmative FLAT block when:
   - `mode ∈ {'entry','midday'}` AND
   - `!context.isBacktest` AND
   - `getLatestPositions(date)` returned `null` AND
   - `context.currentPosition` is null/empty.

   Block text (draft):

   ```
   ## Current Open Positions
   NONE. No papermoney CSV uploaded for 2026-04-20 and no live Schwab positions
   were returned. Treat the account as FLAT for this analysis.
   IMPORTANT: Any prior recommendation in this thread is NOT a filled position.
   Do not instruct the trader to close, roll, or manage strikes that were only
   recommended — recommendations are advisory until the trader uploads a CSV
   or confirms a fill.
   ```

2. In `api/_lib/analyze-prompts.ts`, add a rule under the existing position-management section: _"Recommendations are never self-fulfilling. A prior-session recommendation is evidence of your reasoning, not of a fill. If the Current Open Positions block says NONE/FLAT, treat it as ground truth and produce a fresh entry plan rather than managing imaginary positions."_

**Verify**: `npm run review`; unit test in `api/__tests__/analyze-context.test.ts` that mocks `getLatestPositions → null` with `mode = 'midday'` and asserts the FLAT block is present in `content[*].text`.

### Phase 2 — Delta-aware chain context (3 files)

1. Extend `AnalysisContext` (`src/components/ChartAnalysis/types.ts`) with:
   ```ts
   targetDeltaStrikes?: {
     preferredDelta: number;       // 12
     floorDelta: number;           // 10
     puts: Array<{ delta: number; strike: number; bid: number; ask: number; iv: number; oi: number }>;
     calls: Array<{ delta: number; strike: number; bid: number; ask: number; iv: number; oi: number }>;
   };
   ```
   Populate a dense-enough slice (5, 8, 10, 12, 15, 20, 25Δ) from `chainData.chain.puts`/`calls` in `useAnalysisContext.ts` by nearest-delta search.
2. Add a new context section in `api/_lib/analyze-context.ts` rendered under the existing `skewMetrics` block:
   ```
   ## Chain Delta Rungs (from live option chain, actual market strikes)
   Preferred entry delta: 12Δ. Floor: 10Δ. Never go below floor.
   PUTS:  5Δ → 7020 ($0.45) | 8Δ → 7035 ($0.72) | 10Δ → 7045 ($0.95) | 12Δ → 7055 ($1.20) | ...
   CALLS: 5Δ → 7215 ($0.38) | 8Δ → 7200 ($0.60) | 10Δ → 7190 ($0.85) | 12Δ → 7180 ($1.10) | ...
   ```
3. Add a system-prompt rule: _"When recommending IC/PCS/CCS strikes, select from the Chain Delta Rungs table. Target the preferred delta row; never recommend a strike whose delta is below the floor. If your structural thesis requires a lower-delta strike, reduce size or skip the trade rather than picking a 4-5Δ strike."_

**Verify**: `npm run review`; unit test in `src/__tests__/hooks/useAnalysisContext.test.ts` asserting `targetDeltaStrikes` is populated when `chain` is present and omitted when null.

### Phase 3 — Verification

- `npm run review` passes (tsc + eslint + prettier + vitest --coverage).
- Manual smoke: run an entry-mode analysis with no positions CSV uploaded → confirm output does NOT reference strikes as "filled" and entry plan lists actual 12Δ strikes from the rendered rungs table.

## Files to create / modify

| File                                             | Phase | Change                                    |
| ------------------------------------------------ | ----- | ----------------------------------------- |
| `api/_lib/analyze-context.ts`                    | 1     | Emit FLAT block when positions null       |
| `api/_lib/analyze-prompts.ts`                    | 1     | Add "recommendations ≠ fills" rule        |
| `api/__tests__/analyze-context.test.ts`          | 1     | FLAT-block unit test                      |
| `src/components/ChartAnalysis/types.ts`          | 2     | Extend `AnalysisContext`                  |
| `src/hooks/useAnalysisContext.ts`                | 2     | Build `targetDeltaStrikes` from chain     |
| `api/_lib/analyze-context.ts`                    | 2     | Render Chain Delta Rungs section          |
| `api/_lib/analyze-prompts.ts`                    | 2     | Add "pick from rungs, respect floor" rule |
| `src/__tests__/hooks/useAnalysisContext.test.ts` | 2     | Rungs-population unit test                |

## Data dependencies

- **No new tables, migrations, or env vars.** Everything needed is already in `positions` (Phase 1) and `useChainData` frontend state (Phase 2).
- No new external API calls.

## Thresholds / constants

- `PREFERRED_ENTRY_DELTA = 12`
- `FLOOR_ENTRY_DELTA = 10`
- Rung sampling: `[5, 8, 10, 12, 15, 20, 25]` Δ — wide enough for Claude to see context, narrow enough to not bloat tokens.

## Open questions

1. **Should the floor apply to both sides of an IC, or only the near side?** Default pick: both sides. A 5Δ wing on an IC has negligible credit and asymmetric tail risk.
2. **Should delta preference be hard-coded in the system prompt or per-request in `AnalysisContext`?** Default pick: per-request via `AnalysisContext.targetDeltaStrikes.preferredDelta`. This keeps the preference tunable without a prompt redeploy, and the Phase 2 UI could later surface a slider.
3. **What if the chain API fails (chain === null) mid-session?** Default pick: fall back to the current behavior (no rungs rendered, ceilings still present), but add `'Chain Delta Rungs'` to the `unavailable` manifest so Claude knows why it's missing.

## Not in scope

- Schwab live-positions integration (still requires OAuth + scope expansion; the papermoney CSV is the current source of truth).
- Tuning the delta preference UI — exposed as a constant now; add a settings-screen slider later if needed.
- Any change to the IC/PCS/CCS structural rules themselves. This plan only affects how Claude sees position state and strike-level delta.

## Done when

- An entry-mode analysis with no positions CSV uploaded emits a visible "FLAT" block in the user message and the response does not manage imaginary strikes.
- An entry-mode analysis with chain data present renders the Chain Delta Rungs table in the user message and the returned `entryPlan.entry1.delta` is ≥ 10.
- `npm run review` is green.
