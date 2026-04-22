# FuturesGammaPlaybook — Wire BiasMetrics signals into the rule engine

**Date:** 2026-04-21
**Status:** Scoped, ready to build
**Scope:** Extends the existing `FuturesGammaPlaybook` — no new top-level
component. Adds three signals from `GexLandscape/bias.ts`'s
`BiasMetrics` that the playbook currently can't see: per-target `cls`
(charm-aware intensity), `priceTrend` overrides (`drifting-up/down`),
and `floorTrend5m`/`ceilingTrend5m` (hedging-flow momentum).

## Goal

Make the futures playbook charm-aware and flow-aware. Today the
playbook classifies on `netGex` alone and fires the same fade-call rule
whether the wall is structurally strengthening or eroding. After this
spec, rule rows carry a `conviction` field, the `drifting-up/down`
verdicts suppress the opposing fade/lift rule, and a small wall-flow
strip shows 5m ceiling/floor Δ% alongside the rule panel.

## Why this, why now

The existing `FuturesGammaPlaybook` module already:

- Classifies SPX regime (`POSITIVE / NEGATIVE / TRANSITIONING`)
- Translates SPX levels to ES via live basis
- Generates fade/lift/breakout rules with entry/target/stop
- Handles session phases aligned to the 8:30-15:00 trading schedule
- Computes `esGammaPin` (highest |netGamma| strike)

But it doesn't use the second derivative the `GexLandscape` already
carries. The `GexLandscape/bias.ts` module computes four extra signals
off the same per-strike data:

1. **Per-target `cls`** — `max-launchpad / fading-launchpad / sticky-pin
/ weakening-pin`. A call wall at `sticky-pin` (charm builds into
   close) is a different trade than one at `weakening-pin` (charm
   draining). The playbook today treats them identically.
2. **`drifting-up/down` verdict** — when GEX says rangebound but the
   tape is grinding one way, the component already flags it. The
   playbook's classifier sees `POSITIVE → MEAN_REVERT` and fires BOTH
   fade and lift rules, which is the classic +GEX trap.
3. **`floorTrend` / `ceilingTrend` (1m and 5m)** — avg Δ% of per-strike
   GEX above and below spot. A leading indicator of walls building or
   eroding.

These aren't hypothetical — `GexLandscape` has rendered them for
months; we're just wiring them into the rule engine.

## Open questions (decided for this spec)

- **Where does charm classification live?** Import `classify` from
  `GexLandscape/classify.ts`. Single source of truth — same function
  that drives the landscape renders the conviction badge.
- **Where does Δ% computation live?** Move `computeDeltaMap` from
  `GexLandscape/deltas.ts` to the hook layer, or export it as-is and
  have `useFuturesGammaPlaybook` call it against the per-snapshot
  history. Default pick: **export from `deltas.ts`**; don't move.
  The function is pure and the file is correctly named for the concern.
- **Conviction thresholds.** A `sticky-pin` classification on the
  top-|GEX| upside/downside target = `high`. `weakening-pin` = `low`.
  Anything else (launchpad quadrants, null target) = `standard`.
- **Does drift-override apply in POWER phase only, or all phases?**
  All phases. If the tape is grinding through a wall, the wall isn't
  holding — that's true at 09:45 too, not just POWER.
- **Wall-strip thresholds.** Ceiling/floor 5m Δ% ≥ +2% = strengthening,
  ≤ −2% = eroding, else flat. Dead-band avoids jitter.

## Phases

### Phase 1 — Thread BiasMetrics-like signals through the hook (~1.5 hrs, 3 files)

`useFuturesGammaPlaybook` already holds a snapshot ring buffer internally
via `useGexPerStrike`'s returned strikes. We need to add three derived
values that mirror `GexLandscape`'s output.

**Modify:**

- `src/hooks/useFuturesGammaPlaybook.ts`:
  - Add a rolling snapshot buffer keyed by `timestamp` (same shape as
    `GexLandscape/index.tsx:95`).
  - Compute 1m and 5m `gexDeltaMap` from the buffer using
    `computeDeltaMap` from `GexLandscape/deltas.ts`.
  - Compute `priceTrend` using `computePriceTrend` from the same module.
  - Classify the top upside/downside drift targets using
    `classify(netGamma, netCharm)` from `GexLandscape/classify.ts`.
  - Aggregate 5m Δ% across above-spot strikes → `ceilingTrend5m`, and
    below-spot → `floorTrend5m`.
  - Add these to the hook's return so the container can render them.
- `src/components/FuturesGammaPlaybook/types.ts`:
  - Add `PlaybookFlowSignals` interface — `{ceilingTrend5m, floorTrend5m,
upsideTargetCls, downsideTargetCls, priceTrend}`.

**Create:**

- `src/hooks/__tests__/useFuturesGammaPlaybook.bias-signals.test.ts` — unit
  test that the derived signals match expected values for a hand-rolled
  sequence of snapshots.

**Verify:**

- `npm run test:run -- useFuturesGammaPlaybook` passes new test.
- `npm run lint` clean.
- No UI change yet — existing tests still green.

### Phase 2 — Charm-aware conviction on rules (~1 hr, 3 files)

Rules now carry `conviction: 'high' | 'standard' | 'low'`. The rule
generator reads the top upside target's charm classification for
fade-call rules, and the top downside target's for lift-put rules.

**Modify:**

- `src/components/FuturesGammaPlaybook/types.ts`:
  - Add `conviction: 'high' | 'standard' | 'low'` to `PlaybookRule`.
- `src/components/FuturesGammaPlaybook/playbook.ts`:
  - Extend `rulesForRegime` signature with an optional
    `flowSignals?: PlaybookFlowSignals` parameter. Default = standard
    when omitted (keeps existing callers working until migrated).
  - For `pos-fade-call-wall` and `pos-lift-put-wall`, set
    `conviction = 'high'` when the matching target's `cls` is
    `sticky-pin`, `'low'` when `weakening-pin`, else `'standard'`.
  - `breakout` rules (negative regime) get `'standard'` — charm
    classification doesn't map cleanly to trend-follow conviction.
- `src/components/FuturesGammaPlaybook/PlaybookPanel.tsx`:
  - Render a conviction badge next to the rule status (`▲ HIGH`,
    `▼ LOW`, none for standard). Colors: high = green accent,
    low = amber accent.

**Modify tests:**

- `src/components/FuturesGammaPlaybook/__tests__/playbook.test.ts`:
  - Add three `rulesForRegime` cases: sticky-pin → high, weakening-pin
    → low, missing flowSignals → standard (back-compat).

**Verify:**

- `npm run test:run -- playbook.test` passes new cases.
- `npm run lint` clean.
- Start `npm run dev`, open the playbook, confirm conviction badge
  renders for the fade/lift rules and nothing for breakouts.

### Phase 3 — Drift-override suppresses opposing rule (~45 min, 2 files)

When the bias verdict is `drifting-up`, suppress the
`pos-fade-call-wall` rule (don't fade calls while the tape melts up).
When `drifting-down`, suppress `pos-lift-put-wall`. Also mirror this in
the PlaybookPanel copy so the trader sees why a normally-present rule
is missing.

**Modify:**

- `src/components/FuturesGammaPlaybook/playbook.ts`:
  - In `rulesForRegime`, after the POSITIVE branch generates both rules,
    filter by the `flowSignals.priceTrend.direction` override:
    - `priceTrend.direction === 'up'` AND regime POSITIVE AND
      phase ∈ MORNING/LUNCH/AFTERNOON/POWER → drop
      `pos-fade-call-wall`.
    - `priceTrend.direction === 'down'` same gate → drop
      `pos-lift-put-wall`.
  - Require `priceTrend.consistency ≥ 0.6` to avoid chop firing the
    override.
- `src/components/FuturesGammaPlaybook/PlaybookPanel.tsx`:
  - When the override suppresses a rule, show a one-line neutral note
    at the top of the panel: _"Drifting up — call-wall fade suppressed
    this session."_

**Modify tests:**

- `src/components/FuturesGammaPlaybook/__tests__/playbook.test.ts`:
  - Drift-up with consistency 0.8 → only `pos-lift-put-wall` present.
  - Drift-up with consistency 0.4 → both rules present (dead-band).
  - Drift-down → only `pos-fade-call-wall` present.

**Verify:**

- `npm run test:run -- playbook.test` passes new cases.
- `npm run lint` clean.

### Phase 4 — Wall-intensification strip (~30 min, 2 files)

Small one-line strip rendered above the rule list showing
`Ceiling (5m): +3.2% ▲ strengthening · Floor (5m): −1.1% ▼ eroding`.
Pure display — no rule-status coupling yet. Baseline instrumentation so
the trader can eyeball whether the signal is useful before we gate rules
on it.

**Create:**

- `src/components/FuturesGammaPlaybook/WallFlowStrip.tsx` — pure
  presentational component. Takes `{ceilingTrend5m, floorTrend5m}` as
  props. Shows `—` when null. Dead-band ±2%.

**Modify:**

- `src/components/FuturesGammaPlaybook/index.tsx` (or wherever
  `PlaybookPanel` is rendered) — mount the strip above the rule list,
  reading `ceilingTrend5m` and `floorTrend5m` from the hook.

**Modify tests:**

- `src/components/FuturesGammaPlaybook/__tests__/WallFlowStrip.test.tsx`
  — renders strengthening / eroding / flat badges at the threshold
  boundaries.

**Verify:**

- `npm run test:run -- WallFlowStrip` passes.
- `npm run lint` clean.
- Open the playbook in `npm run dev`; confirm the strip renders.
  (Live data requires market hours; after-hours the strip shows `—`.)

## Files touched (full summary)

**Modify:**

- `src/hooks/useFuturesGammaPlaybook.ts`
- `src/components/FuturesGammaPlaybook/types.ts`
- `src/components/FuturesGammaPlaybook/playbook.ts`
- `src/components/FuturesGammaPlaybook/PlaybookPanel.tsx`
- `src/components/FuturesGammaPlaybook/index.tsx`

**Create:**

- `src/hooks/__tests__/useFuturesGammaPlaybook.bias-signals.test.ts`
- `src/components/FuturesGammaPlaybook/WallFlowStrip.tsx`
- `src/components/FuturesGammaPlaybook/__tests__/WallFlowStrip.test.tsx`

**Use (cross-module import, no modification):**

- `src/components/GexLandscape/classify.ts` — `classify()`
- `src/components/GexLandscape/deltas.ts` — `computeDeltaMap`,
  `computePriceTrend`

## Thresholds / constants

```ts
// In playbook.ts or a new constants file
export const WALL_FLOW_STRENGTHENING_THRESHOLD_PCT = 2; // +2% Δ% = strengthening
export const WALL_FLOW_ERODING_THRESHOLD_PCT = -2; // −2% Δ% = eroding
export const DRIFT_OVERRIDE_CONSISTENCY_MIN = 0.6; // PriceTrend.consistency gate
```

## Done when

- [ ] `PlaybookRule.conviction` reflects per-target `cls` from charm
      classification.
- [ ] `drifting-up` suppresses `pos-fade-call-wall`; `drifting-down`
      suppresses `pos-lift-put-wall`; dead-band 0.6 consistency.
- [ ] Wall-flow strip renders between the rule panel header and the
      rule list, showing 5m ceiling/floor Δ%.
- [ ] `npm run review` (tsc + eslint + prettier + vitest) is green.
- [ ] Manual: open the panel, confirm conviction badges and strip
      render with live data.

## What we are NOT doing (explicit non-goals)

- Not adding gravity-strike as a second rule target — `esGammaPin`
  already covers this.
- Not coupling rule-status to wall-flow Δ% — ship as display-only first.
  Gating rules on this deserves its own backtest-validated spec after
  we've watched the signal live for a few sessions.
- Not introducing new verdicts beyond what `BiasMetrics` already emits.
- Not changing alerts / push-notification gating. Alerts continue to
  fire on status transitions; conviction is advisory overlay.

## Risk notes

- **Back-compat of `rulesForRegime`.** Several call sites hit this
  (evaluator, server-side cron). Signature change is additive — the new
  `flowSignals` param is optional. Callers that don't pass it get
  standard conviction and no drift override, which matches today's
  behavior exactly.
- **Snapshot buffer memory.** 10-min ring buffer of per-strike data is
  already what `GexLandscape` keeps; hoisting it into the playbook hook
  doesn't double memory (hooks are independent but the snapshot payload
  is ~100 strikes × ~20 fields — trivial).
- **`.js` extensions.** Any new imports from `src/` files pulled by
  `api/` must use explicit `.js`. The playbook module is already
  server-pulled via regime cron, so watch for this in Phase 1 hook
  imports.
