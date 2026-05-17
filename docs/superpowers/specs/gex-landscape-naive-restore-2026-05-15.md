---
status: TBD
date: 2026-05-15
---

# GEX Landscape — Restore Naive GEX Alongside MM GEX

**Date:** 2026-05-15
**Owner:** cobriensr
**Status:** Draft, awaiting approval before Phase 1

## Goal

Restore naive GEX (sum of raw `call_gamma_oi + put_gamma_oi` from
`ws_gex_strike_expiry`) to the GEX Landscape component, displayed
alongside MM-attributed GEX. Both views coexist — MM stays the
structural primary, naive becomes a complementary secondary read.

This reverses the MM-swap omission: when the MM swap landed
(2026-05-12), the naive column was removed entirely. The user wants
it back because the two metrics can disagree on sign at the same
strike — that disagreement is itself signal.

## Background

- MM GEX comes from the periscope scraper, 10-min cadence, projected
  into `GexStrikeLevel.netGamma` via `projectMmStrike()` in
  [useGexLandscapeData.ts](../../src/hooks/useGexLandscapeData.ts).
- Naive GEX comes from `ws_gex_strike_expiry` (WS feed, continuous
  upsert). Already plumbed through to the hook as a side channel
  for the Vol ✓/✗ column; `callGammaOi` and `putGammaOi` fields
  on `GexStrikeLevel` are currently **zeroed** in `projectMmStrike()`.
- Per-strike naive Δ% over 1/5/10/15/30m is already computed
  server-side via SQL `LAG()` and surfaced on each WS row as
  `gamma_delta_*m`. Currently unused by the hook's output.

Naive ≠ MM — naive sums raw OI gamma without dealer-direction
attribution. They can disagree on sign at the same strike. The user
sees value in both views.

## User-confirmed design (2026-05-15)

- **Layout:** Separate column in the strike table — "Naive Γ" right
  after "Dollar Γ" (MM).
- **Scope:** Surface naive in (a) per-strike table rows, (b)
  BiasPanel summary, (c) Top 5 GEX tab.
- **Per-strike Δ%:** Out of scope for this restore. Existing 10m/30m
  Δ% columns stay MM-only. Naive Δ% is available server-side but
  adding a third Δ% pair would over-widen the table.

## Phases

### Phase 1 — Data wiring (hook + types)

**Goal:** Populate `callGammaOi`/`putGammaOi` on `GexStrikeLevel` from
WS rows so `naiveNetGamma = callGammaOi + putGammaOi` is computable
downstream. Also expose `naiveDelta10mMap` / `naiveDelta30mMap` from
the WS feed's server-computed `gamma_delta_10m` / `gamma_delta_30m`
fields — Phase 3's BiasPanel work consumes them, but they live in the
hook with the other Δ% maps for cohesion. No new UI column yet.

**Expected side effect — gamma-pressure cue activation:**
`computeGammaPressure()` uses `Math.abs(callGammaOi + putGammaOi)` as
a denominator. Before this change the sum was always 0 (zeroed in
`projectMmStrike`), so the + / − pressure markers in
[StrikeTable.tsx](src/components/GexLandscape/StrikeTable.tsx) were
dormant for every row. After Phase 1 they activate. This is
intentional restoration of pre-MM-swap behavior — visually verify
the markers look right in dev.

**Noise-floor decision (deviation from initial spec):** The MM
`DELTA_NOISE_FLOOR = 100` is calibrated against MM dollar-gamma scale
(billions/millions). Naive `gamma_delta_*m` from WS is a unitless
ratio computed server-side over raw OI gamma — different scale,
different distribution. Applying `100` directly would be miscalibrated.
The server already filters divide-by-zero via `NULLIF(ABS(prior), 0)`.
Phase 1 ships without a naive-side magnitude floor; if Phase 3
surfaces outlier pollution in bias panel means, add a naive-specific
floor calibrated separately (out of scope here).

**Files:**

- `src/hooks/useGexLandscapeData.ts` — in `projectMmStrike()`, pull
  `call_gamma_oi` / `put_gamma_oi` from the matching WS row when
  available; leave zero when no WS match. Build naive Δ% maps from
  each WS row's `gamma_delta_10m` / `gamma_delta_30m`.
- `src/__tests__/hooks/useGexLandscapeData.test.ts` — update
  existing tests; add cases for naive OI population and naive Δ%
  maps (populated + absent-strike fallback).

**Verification:** `npm run review` passes.

### Phase 2 — Naive column in StrikeTable

**Goal:** Render the naive GEX value per row.

**Files:**

- `src/components/GexLandscape/StrikeTable.tsx`:
  - Widen the grid template by one column (~88px), placing the new
    cell between "Dollar Γ" and "10m Δ%".
  - Rename "Dollar Γ" header label to "MM Γ" (keep tooltip pointing
    to dealer-attribution math).
  - New "Naive Γ" header with tooltip explaining raw OI sum.
  - New cell renders `fmtGex(s.callGammaOi + s.putGammaOi)` with
    standard green/amber sign coloring.
- `src/__tests__/components/GexLandscape.test.tsx` — header and
  row-cell assertions for the new column.

**Verification:** `npm run review` passes; visual sanity-check in
dev server.

### Phase 3 — BiasPanel naive readouts

**Goal:** Show naive gravity, drift targets, and trend numbers
alongside MM equivalents in the top summary panel.

**Design (compact, single panel — no doubling of visual weight):**

```
GEX Gravity        ↑ Drift Targets          ↓ Drift Targets         10m Trend       30m Trend
MM   ↑ 20.14pts    MM   7,440 −1K · 7,435 +1K    MM   7,380 −519 · 7,370 +226   F −17% C +76%   F −13% C −71%
     7,430 · +11K
Naiv ↑ 15.00pts    Naiv 7,440 +6K · 7,435 +4K    Naiv 7,380 −4K · 7,370 −2K    F −9%  C +50%   F −5%  C −40%
     7,425 · +18K
```

- Each metric block gets a "MM" line and a "Naiv" line directly
  below it (smaller font, muted color).
- The verdict row at the very top stays MM-only — naive doesn't
  generate a verdict here (verdicts are gravity × regime, and
  MM regime is the structural read).
- Computation: parallel pass through `computeBias()` that consumes
  `naiveNetGamma` in place of `netGamma`, ignores Δ% maps for the
  trend numbers (substitute naive Δ% from WS rows — see below).

**Files:**

- `src/components/GexLandscape/types.ts` — extend `BiasMetrics`
  with optional `naive: { gravityStrike, gravityOffset, gravityGex,
upsideTargets, downsideTargets, floorTrend10m, ceilingTrend10m,
floorTrend30m, ceilingTrend30m }`. Keep optional so existing
  tests don't need full rewrites.
- `src/components/GexLandscape/bias.ts` — extract the core math
  into a `computeBiasCore()` taking `(rows, currentPrice,
delta10mMap, delta30mMap, gammaAccessor)`. `computeBias()` calls
  it with `s => s.netGamma`; new `computeNaiveSubBias()` (or just
  a second call) uses `s => s.callGammaOi + s.putGammaOi` and the
  naive Δ% maps.
- `src/hooks/useGexLandscapeData.ts` — naive Δ% maps already shipped
  in Phase 1; nothing further needed here.
- `src/components/GexLandscape/index.tsx` — wire naive maps into
  the bias compute call.
- `src/components/GexLandscape/BiasPanel.tsx` — render the second
  "Naiv" line under each metric. Skip the line entirely when
  `bias.naive == null` (defensive for first-paint before WS
  arrives).
- `src/components/GexLandscape/formatters.ts` — if
  `formatBiasForClaude()` (already imported elsewhere) needs to
  include naive, update to append a one-line naive summary so the
  analyze endpoint sees both reads. Otherwise leave alone.

**Verification:** `npm run review`; manual: confirm MM verdict
unchanged on a sample snapshot, naive numbers populate when WS
data is present.

### Phase 4 — Top 5 tab parity

**Goal:** Ensure the "Top 5 GEX" tab displays naive alongside MM in
the new column (free with Phase 2) and verify ranking semantics.

**Decision needed:** Should the Top 5 ranking stay MM-only (rank by
`|netGamma|`, naive shown only as the secondary column value), or
also expose a "Top 5 by Naive" alternative?

**Default (lighter-weight):** MM-ranked only; the Top 5 tab is the
same MM-driven list, naive column just shows naive values for
those strikes. The disagreement between rankings is then
observable by browsing the All Strikes tab.

**Files:** None required beyond Phases 1-2 if we accept the default.
If user wants dual-ranking, add a sub-toggle inside the Top 5
tabpanel and a second list — defer to a follow-up.

**Verification:** Visual; existing Top 5 tests should still pass.

## Files summary

Create:

- `docs/superpowers/specs/gex-landscape-naive-restore-2026-05-15.md` (this)

Modify:

- `src/hooks/useGexLandscapeData.ts` (Phases 1, 3)
- `src/components/GexLandscape/types.ts` (Phase 3)
- `src/components/GexLandscape/bias.ts` (Phase 3)
- `src/components/GexLandscape/StrikeTable.tsx` (Phase 2)
- `src/components/GexLandscape/index.tsx` (Phase 3)
- `src/components/GexLandscape/BiasPanel.tsx` (Phase 3)
- `src/__tests__/hooks/useGexLandscapeData.test.ts` (Phase 1)
- `src/__tests__/components/GexLandscape.test.tsx` (Phase 2)
- `src/__tests__/components/GexLandscape-bias.test.ts` (Phase 3)
- `src/__tests__/components/GexLandscape-formatters.test.ts` (Phase 3 if `formatBiasForClaude` updated)

## Data dependencies

None new. All naive data already flows through
`useGexStrikeExpirySpx` and the `gamma_delta_*m` server-computed
fields. No new DB migrations, no new endpoints, no new env vars.

## Open questions — resolved 2026-05-15

1. **Header label rename:** RENAME "Dollar Γ" → "MM Γ" for symmetry
   with "Naive Γ". Tooltip preserved.
2. **`formatBiasForClaude`:** APPEND a one-line naive bias sentence
   so Claude sees both reads in the analyze prompt.
3. **Top 5 ranking toggle:** ADD MM/Naive sub-toggle inside the
   Top 5 tabpanel. Phase 4 builds it.

## Thresholds / constants

No new thresholds. Reuse `DELTA_NOISE_FLOOR = 100` and
`SPX_SPOT_BAND` from existing modules.

## Out of scope

- Per-strike naive 10m/30m Δ% columns (table too wide; defer if
  user asks later).
- Naive vol reinforcement (already implicitly used in the existing
  Vol column).
- A divergence-highlight pill when MM and Naive disagree on sign
  at the same strike (interesting follow-up, not in this restore).
