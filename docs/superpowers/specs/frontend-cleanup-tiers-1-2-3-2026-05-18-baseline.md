---
status: Baseline captured
date: 2026-05-18
parent_spec: frontend-cleanup-tiers-1-2-3-2026-05-18.md
---

# Phase 0 — Frontend Cleanup Baseline (2026-05-18)

Pre-refactor metrics snapshot. Every subsequent phase commit must
keep test coverage ≥ the value recorded here (hard floor — no
tolerance per the parent spec's operating rules).

## HEAD at baseline

- Commit: `48858602` — `docs(spec): Frontend cleanup Tiers 1+2+3
  post-audit remediation plan`
- Parent of cleanup work: `36af0315` — `chore(lint): Clear 3
  sonarjs errors blocking green-HEAD gate`
- `npm run review` status at this commit: **green** (tsc + eslint +
  prettier + vitest --coverage all passing)

## Source tree size (src/ only)

| Metric | Value |
|---|---|
| Total `.ts`/`.tsx` files in `src/` | 675 |
| Total LOC (incl. tests) | 174,883 |
| Non-test LOC | 78,824 |
| Test LOC | 96,011 |
| Custom hooks (`src/hooks/*.ts`) | 64 |
| Util modules (`src/utils/*.ts` top-level) | 41 |
| Component feature folders (`src/components/*/`) | 40 |

## Top 12 largest non-test files

| LOC | File |
|---:|---|
| 1690 | `src/components/SilentBoom/SilentBoomSection.tsx` |
| 1502 | `src/components/LotteryFinder/LotteryFinderSection.tsx` |
| 1415 | `src/App.tsx` |
| 1200 | `src/components/LotteryFinder/LotteryRow.tsx` |
|  940 | `src/components/SilentBoom/SilentBoomRow.tsx` |
|  927 | `src/data/vixRangeStats.ts` |
|  805 | `src/components/Periscope/PeriscopePanel.tsx` |
|  770 | `src/components/LotteryFinder/ContractTapeChart.tsx` |
|  701 | `src/components/GexLandscape/index.tsx` |
|  633 | `src/components/LotteryFinder/TickerNetFlowChart.tsx` |
|  632 | `src/utils/hedge.ts` |
|  616 | `src/hooks/useGexTarget.ts` |
|  586 | `src/components/Tracker/AddContractForm.tsx` |

Expected deltas from the planned phases:

- `SilentBoomSection.tsx` ↓ significantly after Phase 2B sweep
  (16-effect cluster + 12 LS-backed useStates removed)
- `LotteryFinderSection.tsx` ↓ after Phase 2C
- `App.tsx` ↓ ~550 LOC after Phase 2O (PanelRouter extraction)
- `PeriscopePanel.tsx` ↓ significantly after Phase 3A
- `hedge.ts` deleted; replaced by `src/utils/hedge/{pricing,
  sizing,scenarios,constants,index}.ts` after Phase 2Q
- `useGexTarget.ts` ↓ if Phase 2 follow-up splits it (not yet
  scoped — open question if it survives Tier 2 as-is)

## Vitest coverage (baseline)

Coverage from `npm run review` (vitest `--coverage`) at HEAD
`48858602` + prettier-sweep follow-up:

| Coverage type | Hit count | % | Hard floor for subsequent phases |
|---|---:|---:|---:|
| Statements | 30,944 / 33,028 | 93.69% | ≥ 93.69% |
| Branches | 21,265 / 24,704 | 86.07% | ≥ 86.07% |
| Functions | 5,125 / 5,405 | 94.81% | ≥ 94.81% |
| Lines | 27,930 / 29,227 | 95.56% | ≥ 95.56% |

These are the **hard floors** — every Phase N commit must produce
coverage numbers ≥ each of the four values above. If a refactor
genuinely raises coverage, the new (higher) value becomes the
floor for subsequent phases.

## What "coverage dip" means operationally

For every phase commit after Phase 0:

1. Run `npm run review` (already required by per-phase loop).
2. The vitest output prints a coverage summary table at the end.
3. None of the four `%` numbers (Statements, Branches, Functions,
   Lines) may be **lower** than the values above.
4. If a phase's refactor genuinely deletes covered code, the
   coverage % will naturally rise (less code to cover). Drops are
   either:
   - missed test for new code (write it in the same phase), or
   - accidentally removed tests (restore them).
5. If a drop is unavoidable for a structurally good reason, the
   reviewer subagent must explicitly bless it — and the new
   floor for subsequent phases is the new (lower) number.

## Side notes captured during baseline

- Pre-baseline cleanup commit `36af0315` resolved 3 sonarjs lint
  errors that were sitting at HEAD (`/=+$/g` regex in
  `api/_lib/push.ts`, two `void x;` discards in
  `scripts/replay-silent-boom-2026-05-18.ts`). Neither was in `src/`
  and neither was related to the frontend refactor; both were
  unblocking the green-HEAD gate.
- The audit reports from the 5-agent review run are the source of
  truth for the 17 findings. Spec phases map directly to those
  findings — see parent spec's "Why now" + tier sections.
