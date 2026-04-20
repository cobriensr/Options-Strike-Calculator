# Analog Range Forecast — Production Wiring

## Goal

At analyze-time, surface cohort-conditional range + asymmetric excursion
numbers to Claude so the trader can size iron condors at 30Δ / 12Δ based
on historically-similar morning analogs rather than a fixed percentage
of spot or a global historical distribution.

## Findings driving this build (from `comparison-v16-excursion.md`)

On 2024-01-01 → 2026-03-06 (n=563 trading days), temporal-leakage-guarded:

- **Text embeddings give nearly-calibrated range forecasts.** Cohort p90
  catches 78% of actual daily ranges (target 80%). Cohort p95 → 83%.
- **Text's cohort captures SPX's left-tail asymmetry correctly.**
  Text up p80 = 44.6pt, down p80 = 50.3pt — 13% fatter to the downside,
  matching well-documented SPX skew. Features-cohort symmetrizes this
  (27.2 / 30.4) which is a distortion.
- **Features, regime-filter, and enriched cohorts are all broken for
  range.** Features p80 covers only 46% vs target 80%; systematically
  underestimates because the 60-dim pct-change vector is magnitude-
  normalized and blind to volatility regime.
- **Global unconditional baseline is dangerously miscalibrated.** Pre-
  2024 p80 covers only 29% of 2024+ actuals — today's regime is higher-
  vol than the average of the archive.
- **Signal strongest in elevated/crisis VIX** (where features/global
  collapse to 0-7% coverage) and on **strong-directional opens**
  (strong-up/strong-down both under 25% for global).

**The edge is: Text's cohort adaptively widens when the market is actually
going to move, where global/features both fail.**

## Phases

### Phase 1 — Persist structured OHLC in Neon

The sidecar's `/archive/day-summary-batch` already emits open/high/low/
close/range/up_excursion/down_excursion alongside the text summary (as
of commit `1698355`). We need these persisted so analyze-time doesn't
round-trip the sidecar.

- [ ] Migration: add columns `open`, `high`, `low`, `close`, `range_pt`,
      `up_exc`, `down_exc` to `day_embeddings` (same row we already
      upsert), or create sibling `day_ohlc` table if we want a cleaner
      separation. **Default pick**: extend `day_embeddings` — simpler,
      one row per date already exists.
- [ ] Backfill script `scripts/backfill-day-ohlc.mjs` using batched
      `/archive/day-summary-batch` endpoint. 2010-06-07 → today.
- [ ] Nightly cron `api/cron/fetch-day-ohlc.ts` keeps yesterday's row
      fresh (runs 6 PM CT weekdays after ES settles).

**Files:** `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`,
`scripts/backfill-day-ohlc.mjs` (new), `api/cron/fetch-day-ohlc.ts` (new),
`vercel.json`.

**Verify:** run migration → query returns non-null OHLC for a recent
date → backfill completes → row count matches embedding count.

### Phase 2 — Analog range forecast module

- [ ] New module `api/_lib/analog-range-forecast.ts` exporting one
      function: `getRangeForecast(targetDate, targetSummary): Promise<
      RangeForecast | null>`.
- [ ] Embeds the target summary with OpenAI (reuse existing embed
      helper), retrieves top-15 text-nearest analogs with date <
      targetDate, pulls their structured OHLC, returns cohort quantiles
      for range, up_exc, down_exc at p50, p85, p90, p95.
- [ ] Zod schema `RangeForecastSchema` in `api/_lib/validation.ts`.
- [ ] Unit tests (mocked Neon, mocked OpenAI) in
      `api/__tests__/analog-range-forecast.test.ts`.

**Output shape:**
```ts
{
  n: 15,
  range_p50: 22.3, range_p85: 38.1, range_p95: 52.4,
  up_exc_p50: 11.2, up_exc_p85: 22.0, up_exc_p95: 31.8,
  down_exc_p50: 11.8, down_exc_p85: 25.3, down_exc_p95: 36.0,
  // VIX-bucket-filtered variant for Phase 4 (null if Phase 4 not shipped)
  regime_matched: { ... } | null,
}
```

**Verify:** call with a known 2025 date offline, numbers are finite,
p95 > p85 > p50 always, down_exc_p85 typically exceeds up_exc_p85.

### Phase 3 — Wire into analyze-context

- [ ] Call `getRangeForecast()` in `analyze-context-fetchers.ts` (same
      pattern as other context fetchers). Fail-open: null forecast
      drops the block entirely — never blocks an analyze.
- [ ] Add format function in `analyze-context.ts` that emits a short
      block: `Historical analog range forecast (n=15 similar mornings):
      — Expected range p50/p85/p95: 22/38/52pt — Upside excursion p85:
      22pt, p95: 32pt — Downside excursion p85: 25pt, p95: 36pt —
      Implied strikes: 30Δ condor ±22/±25, 12Δ condor ±32/±36`.
- [ ] Block goes **outside** the stable cache boundary (it changes every
      morning, would invalidate the cache if placed inside).
- [ ] Add a static rule paragraph in `analyze-prompts.ts` explaining how
      to interpret the block — goes **inside** stable cache.

**Verify:** call `/api/analyze` with a recorded snapshot → forecast
block present in `messages` → cache hit rate on the stable part
unchanged.

### Phase 4 — VIX-bucketed retrieval (stretch)

- [ ] Filter the 15-NN text retrieval by same VIX bucket as today.
      Requires VIX-bucket column on `day_embeddings` (or join to
      vix-data.json server-side).
- [ ] Output both `cohort` (all 15) and `regime_matched` (same VIX
      bucket only, may be <15) in the forecast.
- [ ] Claude gets both numbers and can prefer regime-matched when
      available.

**Verify:** on a high-VIX day, `regime_matched` band is wider than
`cohort` band (confirms VIX stratification does what it should).

### Phase 5 — Verification

- [ ] `npm run review` passes (tsc + eslint + prettier + vitest).
- [ ] Manual analyze call with a production snapshot — confirm forecast
      appears in Claude's response context.
- [ ] Spot-check forecast numbers against what the comparison script
      produces for the same date (should match within rounding).

## Data dependencies

- Sidecar `/archive/day-summary-batch` — shipped, already emitting
  structured OHLC.
- `day_embeddings` table — exists, 15 years of rows already backfilled.
- No new external APIs needed.

## Open questions / default picks

- **K = 15** for cohort size. Tested and calibrated at this value;
  larger K would smooth quantiles but risks pulling irrelevant days.
- **Percentile choice for Claude's output:** p85 for 30Δ, p95 for 12Δ.
  From comparison: cohort p85 hits 73% actual coverage (close to 70%
  implied by 30Δ), cohort p95 hits 83% (close to 88% for 12Δ). Not
  perfect but both are in-tolerance and the skew is toward caution.
- **Phase 4 ship together or later?** Default: Phase 1-3 first
  (unconditional text cohort — already validated). Phase 4 is a lift
  on top that the stratified table suggests will help in elevated VIX
  but shouldn't block shipping.
- **Cache impact:** forecast block is ~200 tokens, outside stable cache.
  Adds ~200 uncached tokens per analyze call (~$0.001 at Opus rates).
  Negligible.
- **Fail-open policy:** null forecast drops the block. Claude still
  gets everything else. No regression possible.

## Thresholds / constants

- `COHORT_SIZE = 15`
- Recency window: `date < targetDate` (strict, no same-day leak)
- Excursion percentiles emitted: `[0.50, 0.85, 0.90, 0.95]`
- Chop rate: **not emitted** — Brier score in comparison showed no
  cohort beats the global baseline on chop classification, so it would
  be noise. If Claude asks about chop, point to first-hour bias instead.

## Non-goals

- **Directional prediction from analogs.** Don't reintroduce the UP/DOWN
  majority vote — we proved it's coin-toss on this dataset (50.3%
  across all backends).
- **Features vector cohort.** We're not wiring a second cohort — text
  wins on every range metric, and a blended cohort would be strictly
  worse than text alone.
- **Intraday refresh.** Forecast is computed once per analyze call at
  the time of the call, not polled. Morning first-hour shape doesn't
  change after 9:30 AM CT — a single computation per session is
  correct.
