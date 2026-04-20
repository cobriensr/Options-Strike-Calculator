# Phase 1 — Cross-Asset Regime + Volume Profile + VIX Divergence — 2026-04-18

Part of the max-leverage roadmap
(`max-leverage-databento-uw-2026-04-18.md`). Three analyze-context
enrichments using only data already in the DB.

## Goal

Give Claude three new signals during analysis: (1) a cross-asset
risk-regime read from the six futures symbols already streaming,
(2) prior-day volume profile reference levels (POC / VAH / VAL)
computed from ES bars, (3) a VIX/SPX divergence flag when VIX rises
while SPX is flat.

## Scope

### 1. Cross-asset risk-regime composite

Reads from `futures_bars` (ES, NQ, ZN, RTY, CL, GC). All of these
stream live today.

- Compute 5-minute returns for each symbol at the most recent bar.
- Risk composite: `(ES_ret + NQ_ret) / (ZN_ret - GC_ret)`.
  - Large positive = classic risk-on (stocks up, bonds + gold down).
  - Large negative = classic risk-off.
  - Near zero with absolute-magnitude cross-asset moves = MIXED.
- ES/NQ divergence: `abs(ES_ret - NQ_ret) > 0.3%` → flag "ES/NQ
  diverging (tech leading or lagging broad market)".
- CL spike: `abs(CL_ret over last 30 min) > 2%` → flag "macro stress
  — oil spike".
- Classify overall regime into one of: `RISK-ON`, `RISK-OFF`,
  `MIXED`, `MACRO-STRESS`.
- Include the raw component returns so Claude can reason about
  magnitude, not just the classifier output.

### 2. Volume profile (POC / VAH / VAL)

Reads from `futures_bars` for ES.

- For the _prior_ trading day (not today's partial session), compute
  a simple volume profile on 1-point price buckets:
  - **POC (Point of Control):** price bucket with max volume.
  - **VAH / VAL:** boundaries of the 70% volume region around POC.
- Produce the three price levels in the analyze context so Claude
  can cite them as reference levels on today's chart.
- Skip if prior day has < 50 bars (half-day / holiday) — return null
  rather than an unreliable profile.

### 3. VIX/SPX divergence flag

Reads from `market_snapshots` (VIX + SPX intraday) — both already
tracked. If that table doesn't carry minute-bar granularity, fall
back to whichever table does (investigate before coding).

- Compute 5-minute rolling returns for VIX and SPX.
- Flag divergence when `abs(VIX_ret) > 3% AND abs(SPX_ret) < 0.1%`
  over the latest 5-min window.
- Surface as a boolean plus the underlying VIX and SPX 5-min returns
  so Claude can interpret magnitude.

## Files

### New

- `api/_lib/cross-asset-regime.ts` — compute and format the risk
  regime composite. Exports `computeCrossAssetRegime(tradeDate,
now)` returning `{ composite, esNqDiverging, clSpike, regime,
components }` and `formatCrossAssetRegimeForClaude(regime)`.
- `api/_lib/volume-profile.ts` — compute POC/VAH/VAL for a symbol
  and date. Exports `computeVolumeProfile(symbol, tradeDate)` and
  `formatVolumeProfileForClaude(profile)`.
- `api/_lib/vix-divergence.ts` — compute the 5-min divergence flag.
  Exports `computeVixSpxDivergence(now)` and
  `formatVixDivergenceForClaude(div)`.
- Test files mirroring each: `api/__tests__/cross-asset-regime.test.ts`,
  `api/__tests__/volume-profile.test.ts`,
  `api/__tests__/vix-divergence.test.ts`.

### Modified

- `api/_lib/analyze-context-fetchers.ts` — three new fetcher
  wrappers following the existing pattern (each wraps a module
  above with logger + Sentry metrics + null-on-error).
- `api/_lib/analyze-context.ts` — wire the three new fetchers into
  the orchestrator, positioned alongside related signal blocks.
- `api/_lib/analyze-prompts.ts` — add short interpretation rules
  for Claude covering when to weight each signal.
- `api/__tests__/analyze-context.test.ts` — mock the three new
  fetchers; assert their formatted text appears in the prompt when
  they return data.

## Constraints

- **No new tables, no migrations.** All data already in DB.
- **No new external API calls.** Reads existing DB tables only.
- **Three independent fetchers, each null-safe.** One failing can
  never take down another.
- **Must be cached-stable.** The three fetchers belong _outside_ the
  stable-prompt-cache boundary — they're dynamic per call. Verify
  placement against `analyze-context.ts` assembly order.

## Done when

- `npm run review` passes with zero errors (tsc + eslint + prettier +
  vitest --coverage).
- Three new sections render in the analyze prompt when data is
  available.
- Fetchers return `null` gracefully and the analyze prompt omits
  their sections cleanly when data is missing.
- Each new module has unit tests covering: happy path, empty-data
  path, single-symbol-missing path, boundary cases (POC tie, zero
  divergence, ZN/GC denominator = 0).

## Open questions

None — all three use data we've confirmed exists.

## Out of scope for this phase

- Real-time streaming of these signals (they recompute on every
  analyze request, which is fine for current usage).
- Intraday volume profile (only prior-day).
- Multi-day regime persistence tracking.
- Cross-validating against the existing `futures_snapshots`
  `esSpxBasis` — separate concern.
