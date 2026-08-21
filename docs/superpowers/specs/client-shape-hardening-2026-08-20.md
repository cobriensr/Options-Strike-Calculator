# Client shape hardening — 2026-08-20

**Date:** 2026-08-20 · **Status:** shipped — all 8 planned components + the usePolledWindowSignal/useRegime0dte straggler hardened (with GexLandscape/PriceChart from e14e9cdc, the whole class is closed); ~75 new tests · **Owner:** soonerdude28 fork

## Goal

Eight components crash into their section ErrorBoundary when their API
returns a malformed/empty JSON shape (`{}`, a 5xx JSON blob, an HTML error
body loosely parsed). Harden each at the fetch parse so bad payloads become
a stable empty/error state — never a throw. GexLandscape + GexTarget
PriceChart were already hardened (e14e9cdc); this finishes the set.

## Model

`validateSpike` in `src/hooks/useVegaSpikes.ts`: row-level validation at the
parse; invalid rows dropped; invalid envelopes → no-data. Where the data
flows through `src/hooks/useFetchedData.ts`, pass a validating `parse:`
(its default is an identity cast — the vulnerability). Keep outputs
referentially stable across rerenders where a component mirrors them into
effects (the GexLandscape loop lesson).

## Phases (disjoint files, run in parallel)

| Phase | Components | Known crash site | Files |
|---|---|---|---|
| A | OpeningFlowSignal, PinSetupTile | `displayData.tickers[t]`; `data.state.replace` | src/components/OpeningFlowSignal/**, src/components/PinSetupTile/**, src/hooks/useOpeningFlowSignal.ts, src/hooks/usePolledWindowSignal.ts (+tests) |
| B | DarkPoolLevels, StrikeBattleMap | `levels.map` + `data.levels[0]` in the hook; `data[t]?.rows.length` | src/components/DarkPoolLevels/**, src/components/StrikeBattleMap/**, src/hooks/useDarkPoolLevels.ts, src/hooks/useGexStrikeExpiry.ts (+tests) |
| C | GammaNodeDetectorPanel, PeriscopeLotteryPanel | probe-verified ErrorBoundary on `{}` | src/components/GammaNodeDetector/**, src/components/PeriscopeLottery/** (+their hooks; find fetch sites) |
| D | PeriscopeChatHistory, LessonLibrary | probe-verified ErrorBoundary on `{}` | src/components/PeriscopeChat/PeriscopeChatHistory.tsx, LessonLibrary.tsx (+ any shared fetch in that dir they own together) |

## Rules

- TDD per component: render with `{}` (and one HTML-ish/garbage payload)
  via a mocked fetch → assert the normal empty state renders, zero
  console.error, no throw. Then the happy-path regression.
- Validation lives at the parse (hook), not scattered through JSX; a
  component-level guard is allowed as belt-and-suspenders only.
- Invalid rows dropped, not fatal; invalid envelope → empty/no-data state.
- Do not change response types or server code; do not touch e2e/**.
- `useFetchedData.parse` throwing must land in the hook's existing error
  path — verify how it handles a parse throw before relying on it.

## Verification

Per phase: targeted vitest + prettier + eslint + `npx tsc --noEmit`.
Orchestrator runs full `npm run review` at the end.
