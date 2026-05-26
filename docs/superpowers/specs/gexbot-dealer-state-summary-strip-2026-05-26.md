# GEXBot Dealer State — Summary Strip refinement

**Date**: 2026-05-26
**Parent spec**: [gexbot-frontend-2026-05-16.md](./gexbot-frontend-2026-05-16.md)

## Goal

Add an at-a-glance summary strip at the top of the `GEXBot Dealer State`
section so the regime is readable in one glance before scrolling into
the 7 per-ticker panels.

## Why

The section is currently a flat `flex-col` of 7 panels (StrikeMoverLadder,
VixDealerStateBadge, CharmClock, GammaCompass, DexoflowVelocityTape,
ConvexityMatrix, CrossAssetSkewDashboard). Each panel renders its own
per-ticker table. To answer "what regime am I in right now?" the trader
has to scan three different tables. A single strip surfaces the four
load-bearing facts up front:

1. **SPX dealer state** — primary trading instrument γ sign + distance
   from zero-gamma.
2. **VIX dealer state** — meta-regime gate (vol-of-vol).
3. **Cross-asset breadth** — how many of the 16 tickers share the
   majority γ sign.
4. **Loudest dealer flow + freshness** — top ticker by
   `max(|zMlgamma|, |zMsgamma|)` and the last GEXBot capture timestamp.

## Files

**New**

- `src/components/Gexbot/DealerStateSummaryStrip.tsx` — strip component
- `src/__tests__/DealerStateSummaryStrip.test.tsx` — Vitest coverage

**Modified**

- `src/components/Gexbot/index.tsx` — add the strip; remove the
  now-redundant `VixDealerStateBadge` (its content is folded into the
  VIX tile of the strip).

**Deleted**

- `src/components/Gexbot/VixDealerStateBadge.tsx`
- `src/__tests__/VixDealerStateBadge.test.tsx`

Per CLAUDE.md "Orphan Cleanup": the VIX badge becomes dead once the
strip ships, so it's removed in the same commit.

## Design

```text
┌──────────────────────────────────────────────────────────────────────┐
│ SPX · LONG γ      VIX · LONG γ      BREADTH · 11/16    LOUDEST · NQ_NDX │
│ spot 5847 / 0γ    spot 14.3 / 0γ   LONG γ              z 3.4 SHORT γ    │
│ 5820 (+27)        15.8 (-1.5)      5 short · 0 partial as of 14:32 CT   │
└──────────────────────────────────────────────────────────────────────┘
```

- Responsive: `grid grid-cols-2 md:grid-cols-4 gap-2`.
- Each tile uses the same chip shell (rounded border, subtle bg, left
  accent colored by γ sign: emerald = long, rose = short, amber =
  partial/unknown).
- Loading / error / true-empty states render a single strip-wide chip
  matching the existing pattern (`text-tertiary rounded-md border
  border-white/5 bg-white/[0.02] px-3 py-2 text-xs`).
- Per-tile partial: if SPX row exists but missing spot or zero-gamma,
  that tile shows `—` rather than blanking the whole strip.

## Data

Strip consumes the same `useGexbotData({ view: 'snapshots-latest' },
marketOpen)` hook as the existing children. No backend changes.

Cross-asset breadth and "loudest" iterate over `GEXBOT_TICKER_ORDER`.

## Acceptance criteria

- Strip renders 4 tiles when the snapshots-latest payload contains SPX
  + VIX + ≥1 other ticker.
- VIX dealer state matches what the deleted `VixDealerStateBadge` would
  have shown for the same payload.
- Loading / error / empty states render a single chip; no React errors
  thrown when any individual ticker row is missing.
- `npm run review` passes (tsc + eslint + prettier + vitest --coverage).
- Code-reviewer subagent verdict: pass.
