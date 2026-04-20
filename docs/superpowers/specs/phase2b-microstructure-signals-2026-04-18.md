# Phase 2b — Microstructure Signals in Analyze Context — 2026-04-18

Part of the max-leverage roadmap
(`max-leverage-databento-uw-2026-04-18.md`). Phase 2b consumes the
`futures_top_of_book` and `futures_trade_ticks` tables populated by
Phase 2a to compute three live microstructure signals and inject them
into Claude's analyze context.

## Goal

Give Claude three new leading-indicator signals at analyze time:
order flow imbalance (OFI), spread widening z-score, and top-of-book
pressure. All computed on-demand from the Phase 2a tables — no cron,
no new DB table, no UI.

## Design: on-demand vs cron-snapshot

On-demand, computed per analyze call — same pattern as Phase 1's
cross-asset regime, volume profile, VIX divergence. Reasons:

- The signal only matters at analyze time; storing snapshots adds
  DB load with no consumer yet.
- Phase 3's ML backfill is where historical signals get materialized;
  keeping Phase 2b as pure computation avoids locking in a storage
  schema before the feature set is validated.
- Zero new cron = zero new CRON_SECRET handling = smaller blast radius.

If a UI tile or historical ML feature wants these later, we can add a
cron snapshot writer as a separate workstream.

## Scope

### Three signals

All computed for **ES only** (matches Phase 2a scope).

**1. Order Flow Imbalance (OFI)**

Reads `futures_trade_ticks`.

- 1-minute OFI: over the last 1 minute, `(buy_volume - sell_volume) / total_volume`
  where `buy_volume = sum(size) where aggressor_side = 'B'`,
  `sell_volume = sum(size) where aggressor_side = 'S'`, and
  total_volume excludes `'N'`-classified trades.
- 5-minute OFI: same formula over the last 5 minutes.
- Classification: `|OFI| > 0.3` is a meaningful directional signal.

**2. Spread widening z-score**

Reads `futures_top_of_book`.

- For the last minute, compute median spread = `median(ask - bid)`.
- For the trailing 30-minute baseline, compute median spread +
  standard deviation across 1-min bucket medians.
- Z-score: `(current_median - baseline_median) / baseline_stddev`.
- Classification: `z > 2.0` = liquidity pulling back (leading
  indicator).

**3. Top-of-book pressure**

Reads `futures_top_of_book`.

- Take the most recent quote snapshot (within the last 30 sec).
- Pressure ratio: `bid_size / ask_size`.
- Classification: `ratio > 1.5` = buy pressure building;
  `ratio < 0.67` = sell pressure building; otherwise balanced.

### Composite signal

Surface each signal's classification plus raw values so Claude can
reason about magnitude. A composite field summarizes: `"AGGRESSIVE_BUY"`
/ `"AGGRESSIVE_SELL"` / `"LIQUIDITY_STRESS"` / `"BALANCED"` when
multiple signals align; otherwise drop the composite and let the
individual signals speak.

## Files

### New

- `api/_lib/microstructure-signals.ts` — three compute helpers +
  formatter. Exports:

  ```ts
  export interface MicrostructureSignals {
    ofi1m: number | null;
    ofi5m: number | null;
    spreadZscore: number | null;
    tobPressure: number | null;
    composite:
      | 'AGGRESSIVE_BUY'
      | 'AGGRESSIVE_SELL'
      | 'LIQUIDITY_STRESS'
      | 'BALANCED'
      | null;
    computedAt: string;
  }
  export async function computeMicrostructureSignals(
    now: Date,
  ): Promise<MicrostructureSignals | null>;
  export function formatMicrostructureForClaude(
    s: MicrostructureSignals | null,
  ): string | null;
  ```

- `api/__tests__/microstructure-signals.test.ts` — mock DB,
  cover happy path + null-safety + classification boundaries +
  formatter edge cases.

### Modified

- `api/_lib/analyze-context-fetchers.ts` — add
  `fetchMicrostructureBlock()` following the existing null-on-error
  - logger + `metrics.increment` pattern.
- `api/_lib/analyze-context.ts` — wire the new fetcher into the
  `Promise.all` and into the context assembly. Position next to
  the other cross-asset/futures signals.
- `api/_lib/analyze-prompts.ts` — add `<microstructure_signals_rules>`
  block **inside `SYSTEM_PROMPT_PART1`** (cached stable section),
  NOT in the per-call dynamic context.
- `api/__tests__/analyze-context.test.ts` — mock the new fetcher,
  extend the positive-path test + unavailable-manifest test.

## Composite classification rules

Triggered only when multiple signals align in the same direction:

- `AGGRESSIVE_BUY`: `ofi5m > 0.3 AND tobPressure > 1.5`
- `AGGRESSIVE_SELL`: `ofi5m < -0.3 AND tobPressure < 0.67`
- `LIQUIDITY_STRESS`: `spreadZscore > 2.0` (dealer liquidity
  pulling back — strongest signal regardless of direction)
- `BALANCED`: default when none of the above fire AND all three
  individual signals are non-null
- `null`: when insufficient data to classify

`LIQUIDITY_STRESS` takes precedence over the directional composites
if it fires.

## Constraints

- **ES only.** No NQ/other symbols in this phase.
- **No new DB tables.** No new migrations. No cron.
- **No external API calls.** Reads existing Phase 2a tables only.
- **Null-safe.** If `futures_trade_ticks` has < 20 trades in the
  last 5 min, drop OFI. If `futures_top_of_book` has < 30 quotes
  in the last 30 min, drop the spread z-score. If no quote within
  30 sec, drop the TOB pressure. Signal-level null-drops are fine;
  return top-level null only when all three are null.
- **Cache boundary.** Interpretation rules (static) in cached
  PART1; signal values (dynamic) outside cache. Same pattern as
  Phase 1.

## Thresholds / constants

- OFI significance: `|OFI| > 0.3` — moderate directional pressure
- Spread z-score significance: `z > 2.0`
- TOB pressure significance: `> 1.5` or `< 0.67` (both ≈1.5x ratio)
- Minimum sample sizes: 20 trades for OFI, 30 quotes for spread
  z-score, most recent quote within 30 sec for TOB pressure.
- Rolling windows: 1 min / 5 min for OFI; 30-min baseline for
  spread z-score; latest for TOB pressure.

## Done when

- `npm run review` passes with zero errors.
- Three signal sections render in the analyze prompt when data is
  available; drop cleanly when data is missing.
- `microstructure-signals.test.ts` covers: happy path (all three
  signals computed), each signal individually dropping to null on
  insufficient data, each composite classification firing, formatter
  null handling, formatter output when only some signals are
  available.
- Interpretation rules added to cached PART1, not dynamic context.

## Out of scope

- Real-time streaming to the frontend — analyze-context only.
- Historical series storage (Phase 3).
- Cron job that writes snapshots (deferred until a consumer needs it).
- Signals for NQ or other symbols.
- Microstructure-derived chart overlays in the UI.

## Open questions

None — all three signals have clear definitions, and the Phase 2a
tables provide everything needed.
