# Hot Right Now — floor-blind cadence view + dedup-hole fix

**Date:** 2026-05-29
**Status:** approved, implementing
**Decision:** Hot Right Now = cadence-hot, **floor-blind**, relabeled.

## Goal

Make the pinned "Hot Right Now" (reignition) section an intentional,
clearly-labeled **floor-blind cadence view**: surface the day's most
re-ignited chains ranked by fire cadence **regardless of the TAKE-IT
floor / score / premium quality filters**, so it keeps catching big
movers the model under-rates — and close the dedup hole so no chain
falls through both surfaces.

## Why (reproduced on 2026-05-29)

The reignition ranking (`qualified` CTE, api/lottery-finder.ts:890) ranks
top-N purely by fire cadence (`fire_count`, `max_gap_min`,
`post_gap_fires`) and ignores all user filters. The `reignited` flag it
produces removes those chains from the main list
(`tickerGroupFires = filtered.filter(f => f.reignited !== true)`).

But Phases 1–2 made the reignited PAYLOAD query (`reignitedRows`) apply
the quality filters (TAKE-IT floor at :1108, Q1/Q2 quintile at :1109,
`minScore`/`minPremium` in its CTE). So a cadence-top-N chain that fails
those quality filters gets removed from the main list (by the flag) yet
also excluded from Hot Right Now (by the payload filters) → **vanishes
from both**.

Concrete: SNDK 1670C fired 24×, peaked **+1974%** off $1.35, but
`chain_max_takeit = 0.685` < the 0.70 default floor. The main feed hides
it; a filtered Hot Right Now would too. The trader wants exactly this
chain surfaced — the reignition section is the right home for
"cadence-hot movers the floor hid."

## Design (decided)

Hot Right Now respects only **structural scoping** (date, ticker,
optionType, mode, tod, reload/cheapCallPm tags, entry ≥ MIN_ALERT) and is
**blind to quality floors** (TAKE-IT, score, premium, Q1/Q2 quintile).
The flag (already global cadence-top-N) and the payload (now
quality-blind) then mark the same chains, so every flagged chain appears
in Hot → no dedup hole. The section is relabeled so the floor-blind
behavior is explicit, not surprising.

This is a targeted change, not a from-scratch rebuild — the cadence
ranking stays; we remove the quality gates from the payload and relabel.

## Phases

### Phase 5a — server: make `reignitedRows` floor-blind

File: `api/lottery-finder.ts`.

- Remove from the `reignitedRows` inner `filtered` CTE WHERE (api/lottery-finder.ts:1058, 1060):
  - `minScore` gate, `minPremium` gate. Keep date/ticker/reload/cheapCallPm/mode/optionType/tod/entry.
- Remove from the `reignitedRows` outer WHERE (:1108, :1109):
  - the `chain_max_takeit >= minTakeitProb` gate (added Phase 1) and the
    Q1/Q2 quintile gate (added Phase 2). Keep `rn = 1`.
- Net: `reignitedRows` returns the cadence-top-N chains within the user's
  structural scope, regardless of quality. The `reignited` flag
  (chainExtras `qualified` CTE) is unchanged (already cadence-only).

### Phase 5b — frontend: relabel + explain

File: `src/components/LotteryFinder/ReignitionSection.tsx`.

- Relabel the subtitle/tooltip so it's clear this view ignores the
  TAKE-IT floor and other quality filters — e.g. "cadence-ranked · ignores
  the TAKE-IT floor — surfaces the most re-ignited chains even if the
  model scored them below your floor." Keep "Hot Right Now" title.
- Optional: a small "floor-blind" pill so the distinction is glanceable.

### Phase 5c — tests

Files: `api/__tests__/lottery-finder-endpoint.test.ts`,
`src/components/LotteryFinder/__tests__` (or existing reignition test).

- SQL-shape: assert the `reignitedRows` query does NOT gate on
  `chain_max_takeit`, `inversion_quintile`, `score >=`, or premium — i.e.
  it is quality-blind — while the MAIN row query still does (the no-vanish
  guard must remain intact for the main feed).
- Frontend: the relabeled copy renders.

## Data dependencies

None new.

## Open questions / decisions

- **Structural vs quality split** (decided): keep ticker/type/mode/tod/
  reload/cheapCallPm (structural) on the reignited payload; drop
  takeit/score/premium/quintile (quality).
- The reignition top-N ranking stays global-per-day and cadence-based.
- Default TAKE-IT floor (0.70 default-on) policy is a SEPARATE open item
  raised earlier (it hid SNDK 1670C in the main feed); not part of this
  phase. Hot Right Now now backstops it.

## Thresholds / constants

Unchanged: REIGNITION_MIN_FIRES=3, REIGNITION_MIN_GAP_MIN=30,
REIGNITION_MIN_POST_GAP_FIRES=2, REIGNITION_TOP_N_PER_DAY=5.
