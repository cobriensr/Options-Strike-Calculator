---
status: Done
date: 2026-10-29
---

# Put the analyze premium floor back to 8Δ

## Goal

Make every floor Claude sees in an analyze call say 8Δ: the system
prompt, the Chain Delta Rungs context and the calibration example.

## Why

On 2026-10-28 the floor was raised to 10Δ to resolve an 8-vs-10 mismatch.
The prompt said 8Δ, while `FLOOR_ENTRY_DELTA = 10` (since 2026-04-20)
told Claude "Floor: 10Δ" in the Chain Delta Rungs (commit 19f7298c).

Other parts of the app still assume 8Δ:

- the Risk Calculator warns at `delta < 0.08`;
- 4 of the active lessons injected into every analyze call cite an 8Δ
  floor (#43, #46, #141, #144). #144 says "the premium floor rule (8Δ
  minimum)".

So each call carried conflicting floors. The owner (2026-10-29) decided
that moving the rest of the app to 10Δ isn't worth it, and chose to
return to 8Δ everywhere Claude reads it.

## Approach

Change the number forward instead of `git revert 19f7298c`:

- **Keep** the tests 19f7298c added. They tie every prompt floor
  statement to `FLOOR_ENTRY_DELTA`, which guards against this drift
  coming back.
- **Keep** its wording improvements (ADJUSTED, SIT OUT).

## Phases

1. **One commit**, about 30 min.
   - `src/constants/index.ts`: `FLOOR_ENTRY_DELTA = 8`.
   - `api/_lib/analyze-prompts.ts`: every floor statement 10Δ → 8Δ (the
     11 lines 19f7298c changed). This includes the calibration example's
     `"suggestedDelta": 8`, self-check 5 (`>= 8`), and the "Common
     mistake" line, which goes back to "Defaulting to 8-10Δ".
   - `src/components/ChartAnalysis/types.ts`: the `// 10` comment.
   - `docs/TRADING_WORKFLOW.md`: every floor mention (5 lines; 0a537d57
     added three after 19f7298c).
   - `docs/FEATURES.md`: the two floor mentions (the Chain Delta Rungs
     row and bullet).
   - Tests: `api/__tests__/analyze-prompts.test.ts` (keyed to the
     constant) and `src/__tests__/hooks/useAnalysisContext.test.ts`.
     `api/__tests__/analyze-context.test.ts` needs no change: its
     fixtures set their own `floorDelta`.
   - Review: the `analyze-prompt-reviewer` (cache boundary, internal
     consistency), then the `code-reviewer`.

## Data dependencies

None. The cached stable system block changes once, so the first call
after the deploy writes a new cache entry.

## Open questions (default picks)

1. **Lessons that go below 8Δ** (#71 "6-7Δ", #78 "6-8Δ", #89 "6Δ"):
   they conflicted with the old 8Δ floor too. _Default:_ leave them to
   the weekly curation, as the owner chose on 2026-10-28.
2. **Risk Calculator `delta < 0.08`:** it already matches. _Default:_ no
   change.

## Thresholds and constants

- `FLOOR_ENTRY_DELTA = 8`.
- `PREFERRED_ENTRY_DELTA` stays 12.
