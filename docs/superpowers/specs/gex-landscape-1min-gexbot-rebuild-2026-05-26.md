# GEX Landscape — 1-Min GexBot Rebuild

**Date:** 2026-05-26
**Author:** Claude + Charles
**Supersedes:** [gex-landscape-mm-swap-2026-05-12.md](./gex-landscape-mm-swap-2026-05-12.md)
**Status:** Locked — decisions confirmed 2026-05-26, ready to implement

## Goal

Rewire the GexLandscape so MM gamma/charm/vanna come straight from the 1-min
GexBot capture table, with 1m / 5m / 10m Δ% columns and a rebuilt vol-reinforcement
signal. Drop the 10-min `usePeriscopeStrikes` path entirely.

## Why now

- `gexbot_api_capture` has been writing every minute for SPX `{gamma,charm,vanna}_zero`
  since 2026-05-16. Same table the new MM Exposure map uses.
- The MM-swap shipped in May took the Δ% windows from 10m/30m → still 10m cadence.
  Trader wants minute-grade reactivity for entries.
- Each `mini_contracts` row already carries position-4 = `[t-1m, t-5m, t-10m]`
  per strike. The lookback windows the trader asked for are **embedded in the
  same payload** — no extra DB lookbacks needed. The current decoder in
  [api/_lib/periscope-gexbot.ts](../../../api/_lib/periscope-gexbot.ts) drops it
  on the floor.

## Locked decisions (2026-05-26)

1. **Vol reinforcement signal:** **(b) Redefine** as "delta-trend agreement" —
   `volReinforcement = reinforcing` when sign(Δ1m) === sign(Δ5m) === sign(Δ10m)
   === sign(netGamma); `opposing` when current sign disagrees with all three
   priors; `neutral` otherwise (mixed or insufficient data). No WS dependency.
2. **GammaPressure overlay:** Drop. Removes `computeGammaPressure`,
   `PRESSURE_NEUTRAL_BAND_RATIO`, and the gamma-cell overlay rendering.
3. **Naive sub-bias line:** Drop. Removes `computeNaiveSubBias`,
   `NaiveBiasMetrics`, `NaiveDriftTarget`, and the BiasPanel sub-line UI.
4. **Scrubbing:** (b) 1-min scrub against `gexbot_api_capture` for today only.
   No cross-day index work, no live-only regression.
5. **Vanna column:** Add `netVanna` to the table.

## Architecture (post-rebuild)

```
gexbot_api_capture  ─┐
  (1-min, SPX,        │  fetchLatestGexbotSlot()
   state/{γ,χ,v}_zero)│  fetchGexbotMinuteTimestamps()
                     │  +  decodeStrikesWithHistory()  ← NEW
                     │     emits per-strike { strike, gamma, charm, vanna,
                     │                        gammaPrev1m, gammaPrev5m, gammaPrev10m,
                     │                        charmPrev1m, charmPrev5m, charmPrev10m,
                     │                        vannaPrev1m, vannaPrev5m, vannaPrev10m }
                     │
                     ▼
                  /api/gex-landscape  ← NEW endpoint
                     │     returns { strikes, spot, asOf, ageSec, availableMinutes }
                     │
                     ▼
                  useGexLandscapeData (rewritten)
                     │     no WS, no usePeriscopeStrikes, no useGexStrikeExpirySpx
                     │     computes 3 delta maps inline from per-strike prev fields
                     ▼
                  GexLandscape (rebuilt)
                     │     columns: Strike | Direction | NetGamma | NetCharm | NetVanna
                     │              | Δ1m | Δ5m | Δ10m | Class | Reinforcement
```

**What goes away:**
- `usePeriscopeStrikes` (still used? grep — drop only the GexLandscape consumer)
- `useGexStrikeExpirySpx` consumption from this hook
- 10m/15m/20m/30m Δ% maps and column UI
- Naive sub-bias panel
- GammaPressure overlay
- `computeSmoothedStrikes` 5-min averaging buffer (1-min native cadence makes
  it cheap to re-tune; revisit only if jitter shows in the wild)

## Phases

**Each phase is a separate commit, each ends with `npm run review` green, each
ends with a code-reviewer subagent pass per CLAUDE.md.**

### Phase 0 — Dead code cleanup (Step 0 Rule)

GexLandscape index.tsx is 673 LOC, StrikeTable 455, BiasPanel 405. Per CLAUDE.md,
sweep dead props/imports/exports/logs in these three files BEFORE structural
work. Commit separately.

**Files:**
- [src/components/GexLandscape/index.tsx](../../../src/components/GexLandscape/index.tsx) (673)
- [src/components/GexLandscape/StrikeTable.tsx](../../../src/components/GexLandscape/StrikeTable.tsx) (455)
- [src/components/GexLandscape/BiasPanel.tsx](../../../src/components/GexLandscape/BiasPanel.tsx) (405)

**Done when:** Files shrink by any nonzero amount AND `npm run review` is green
AND no behavior change visible in the panel.

### Phase 1 — Backend: extend decoder + new endpoint

**1a. Decoder:** Extend [api/_lib/periscope-gexbot.ts](../../../api/_lib/periscope-gexbot.ts)
with `decodeStrikesWithHistory()`:

```ts
export interface DecodedStrikeWithHistory extends DecodedStrike {
  /** Position-4 [t-1m, t-5m, t-10m] — already in the payload. null when sparse. */
  prev1m: number | null;
  prev5m: number | null;
  prev10m: number | null;
}
```

Keep `decodeStrikes()` untouched so MMExposureMap doesn't move.

**1b. New endpoint:** `api/gex-landscape.ts`. Pattern after `api/periscope-map.ts`
but:
- Decode all three panels with history (gamma, charm, vanna)
- Join the three by strike into a single per-strike row
- Return `{ strikes, spot, asOf, ageSec, availableMinutes }` — minute list pulled
  from a separate `SELECT DISTINCT date_trunc('minute', captured_at) ...` query.
- Auth: `guardOwnerOrGuestEndpoint` (same as periscope-map).
- Cache headers: 30s live / 60s after-hours.

**1c. Tests:** `api/__tests__/gex-landscape.test.ts`
- Auth: rejects without owner cookie
- happy path: 3 panels present, returns shaped data
- no_slot when any panel stale
- no_spot when spot missing
- scrub: `?at=YYYY-MM-DDTHH:mm:00Z` resolves at-or-before

**Done when:** `curl /api/gex-landscape | jq` returns the expected shape on
prod-like data + Phase 1 tests pass + 1 reviewer pass.

### Phase 2 — Hook rewrite

Rewrite [src/hooks/useGexLandscapeData.ts](../../../src/hooks/useGexLandscapeData.ts):
- Single fetch against `/api/gex-landscape` (no parallel WS hook)
- Build `GexStrikeLevel[]` from the new payload (most call/put fields become
  zero — keep the type shape stable for the table renderer this phase)
- 3 delta maps computed inline from `prev1m/prev5m/prev10m`:
  `delta = (current - prev) / |prev| * 100` (same noise floor of 100)
- Drop all naive maps from the return type. Drop empty back-compat maps.
- Update `UseGexLandscapeDataReturn` interface.

**Tests:** rewrite [src/__tests__/hooks/useGexLandscapeData.test.ts](../../../src/__tests__/hooks/useGexLandscapeData.test.ts)
- Happy path
- Empty payload → empty arrays
- Strike missing prev1m → null in delta map
- Prev below noise floor → null

**Done when:** hook compiles, tests pass, panel still renders (with 10m/30m
columns showing the WRONG window names — Phase 4 fixes that).

### Phase 3 — Type + bias updates

[src/components/GexLandscape/types.ts](../../../src/components/GexLandscape/types.ts):
- Drop `NaiveDriftTarget`, `NaiveBiasMetrics`, `naive` from `BiasMetrics`
- Replace `floorTrend10m/30m`, `ceilingTrend10m/30m` with 6 fields:
  `floorTrend1m/5m/10m`, `ceilingTrend1m/5m/10m`
- Drop `volReinforcement` (or repurpose per Q1 answer — assuming (b))

[src/components/GexLandscape/bias.ts](../../../src/components/GexLandscape/bias.ts):
- Drop `computeNaiveSubBias()`
- `computeBias()` takes 3 delta maps (1m/5m/10m), returns 6 trend fields
- Verdict logic untouched (regime × gravity)

[src/components/GexLandscape/classify.ts](../../../src/components/GexLandscape/classify.ts):
- Drop `computeGammaPressure()` and `GammaPressure` export

**Tests:** Update [GexLandscape-bias.test.ts](../../../src/__tests__/components/GexLandscape-bias.test.ts),
[GexLandscape-classify.test.ts](../../../src/__tests__/components/GexLandscape-classify.test.ts)

### Phase 4 — Component rebuild

[src/components/GexLandscape/StrikeTable.tsx](../../../src/components/GexLandscape/StrikeTable.tsx):
- Columns: Strike | Dir | NetGamma | NetCharm | NetVanna | Δ1m | Δ5m | Δ10m
  | Class | Reinforcement (if Q1=b)
- Drop the gamma-pressure overlay rendering
- Drop the vol-reinforcement column source (or repurpose per Q1)

[src/components/GexLandscape/BiasPanel.tsx](../../../src/components/GexLandscape/BiasPanel.tsx):
- Drop naive sub-line
- Replace 10m/30m trend display with 1m/5m/10m
- Verdict + gravity + drift targets unchanged

[src/components/GexLandscape/index.tsx](../../../src/components/GexLandscape/index.tsx):
- Drop the snapshot buffer + `computeSmoothedStrikes` call (1-min native; the
  5-min smoothing buffer was a 10-min-cadence band-aid)
- Drop the WS-fallback picker-timestamps caching effect — `availableMinutes`
  from the endpoint is now the single source
- Keep scrub UI but bind it to `availableMinutes` (1-min ticks)

[src/components/GexLandscape/deltas.ts](../../../src/components/GexLandscape/deltas.ts):
- Either delete (smoothing gone, price-trend can live inline) or keep
  `computePriceTrend` only.

**Tests:** Update [GexLandscape.test.tsx](../../../src/__tests__/components/GexLandscape.test.tsx),
[GexLandscape-HeaderControls.test.tsx](../../../src/__tests__/components/GexLandscape-HeaderControls.test.tsx),
[GexLandscape-deltas.test.ts](../../../src/__tests__/components/GexLandscape-deltas.test.ts),
[GexLandscape-formatters.test.ts](../../../src/__tests__/components/GexLandscape-formatters.test.ts).
Remove [useTopStrikesTracker.test.ts](../../../src/__tests__/hooks/useTopStrikesTracker.test.ts)
if Top-5 view stays; keep if it does.

### Phase 5 — Verification (always last)

- `npm run review` — must be green
- Manual: load `/?panel=gex-landscape` during market hours, confirm:
  - Δ1m / Δ5m / Δ10m columns populate within 10 minutes of open
  - Scrub backward 5 minutes shows distinct strike values
  - Verdict + gravity + drift targets match the live panel
- code-reviewer subagent: end-of-phase pass
- Commit + push

## Files touched (summary)

**Backend (new + modified):**
- `api/_lib/periscope-gexbot.ts` — add `decodeStrikesWithHistory()`
- `api/gex-landscape.ts` — NEW
- `api/__tests__/gex-landscape.test.ts` — NEW

**Frontend rewritten:**
- `src/hooks/useGexLandscapeData.ts`
- `src/components/GexLandscape/index.tsx`
- `src/components/GexLandscape/StrikeTable.tsx`
- `src/components/GexLandscape/BiasPanel.tsx`
- `src/components/GexLandscape/types.ts`
- `src/components/GexLandscape/bias.ts`
- `src/components/GexLandscape/classify.ts`
- `src/components/GexLandscape/deltas.ts` (or deleted)
- `src/components/GexLandscape/constants.ts` (threshold re-tune for 1-min cadence)

**Tests updated:**
- 7 existing GexLandscape test files
- 2 hook test files

**Possibly deleted:**
- `src/hooks/useTopStrikesTracker.ts` (if Top-5 view goes)
- `src/components/GexLandscape/ClassificationLegend.tsx` (re-evaluate)

## Threshold re-tune note (Phase 4)

- `DELTA_NOISE_FLOOR = 100` was chosen against ATM gamma p10 = 112 at MM scale.
  GexBot scale may differ — probe with a quick fetch before Phase 4.
- `SPX_SPOT_BAND` unchanged (it's about spot proximity, not cadence).
- `PRESSURE_NEUTRAL_BAND_RATIO` becomes dead if Q2 → drop GammaPressure.

## Data dependencies

- `gexbot_api_capture` table — already populated by
  [api/cron/populate-periscope-from-gexbot.ts](../../../api/cron/populate-periscope-from-gexbot.ts)
- No new env vars
- No new migrations

## Risk / rollback

- The current GexLandscape stays running until Phase 2 lands. Phase 1 is
  additive (new endpoint, untouched decoder export).
- Rollback = revert the commit per phase. Phase 0 / 1 are pure-add; Phases 2-5
  are tightly scoped per-file.
- If the GexBot capture cron hiccups, `/api/gex-landscape` returns
  `data: null, reason: 'no_slot'` — panel shows existing empty state.
