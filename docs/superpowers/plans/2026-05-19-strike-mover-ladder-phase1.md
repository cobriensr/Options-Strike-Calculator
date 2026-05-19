# StrikeMoverLadder Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `StrikeMoverTicker` (a flex-wrap chip wall) with `StrikeMoverLadder`, a spot-anchored SPX-centered ladder of strike movers focused on 0DTE trading. Adds position-aware coloring, cross-asset confirmation, and an ATM-magnet treatment.

**Architecture:** Component lives at `src/components/Gexbot/StrikeMoverLadder.tsx`. Pure functions (color classification, cross-asset aggregation) extracted to a sibling folder for unit-testable logic without React. SPX spot is threaded as a prop from `App.tsx` (Schwab real-time via `useMarketData`) — NOT pulled from GEXBot's minute-cadence snapshot. Replaces `StrikeMoverTicker` in `GexbotSection`.

**Tech Stack:** React 19, TypeScript strict, Tailwind CSS 4, Vitest + @testing-library/react. No new dependencies, no API changes, no DB migrations.

**Spec:** `docs/superpowers/specs/strike-mover-ladder-2026-05-19.md`

---

## File Structure

### Create

- `src/components/Gexbot/strike-mover-ladder/types.ts` — type definitions for the component family.
- `src/components/Gexbot/strike-mover-ladder/colors.ts` — pure color/tone classifier (position × sign).
- `src/components/Gexbot/strike-mover-ladder/aggregation.ts` — pure row builder (filter, bin, mark largest, sort).
- `src/components/Gexbot/StrikeMoverLadder.tsx` — React component.
- `src/__tests__/strike-mover-ladder.colors.test.ts` — colors unit tests.
- `src/__tests__/strike-mover-ladder.aggregation.test.ts` — aggregation unit tests.
- `src/__tests__/StrikeMoverLadder.test.tsx` — component tests.

### Modify

- `src/components/Gexbot/GexbotSection.tsx` — accept `spxSpot` prop, swap child component.
- `src/__tests__/GexbotSection.test.tsx` — assert new testid `strike-mover-ladder-empty`; pass `spxSpot={null}` in test renders.
- `src/App.tsx` — thread `spxSpot={market.data.quotes?.spx?.price ?? null}` into `<GexbotSection>`.

### Delete

- `src/components/Gexbot/StrikeMoverTicker.tsx`
- `src/__tests__/StrikeMoverTicker.test.tsx`

---

## Task 1: Types, constants, and color classifier

**Files:**

- Create: `src/components/Gexbot/strike-mover-ladder/types.ts`
- Create: `src/components/Gexbot/strike-mover-ladder/colors.ts`
- Create: `src/__tests__/strike-mover-ladder.colors.test.ts`

- [ ] **Step 1.1: Create the parent folder**

```bash
mkdir -p src/components/Gexbot/strike-mover-ladder
```

- [ ] **Step 1.2: Write `types.ts`**

File: `src/components/Gexbot/strike-mover-ladder/types.ts`

```ts
/**
 * Shared types + numeric constants for the StrikeMoverLadder family.
 * Co-located so both the color classifier and the aggregation pipeline
 * read the same ATM band and cross-asset tolerance.
 */

export type Side = 'above' | 'below' | 'atm';
export type Tone = 'strengthening' | 'weakening' | 'magnet';
export type CategoryTab = 'gex' | 'gamma' | 'delta' | 'vanna' | 'charm';
export type LadderSymbol = 'SPX' | 'ES_SPX' | 'SPY';

export interface ClassifiedRow {
  side: Side;
  tone: Tone;
  toneClass: string;
  marker: '▽' | '◈ ATM' | null;
}

export interface AggregatedRow {
  /** SPX-equivalent strike, rounded to nearest 5. */
  strike: number;
  /** Signed 5-minute Δ for the row (SPX sample if present, else first). */
  change: number;
  /** Symbols present at this strike (deduped, canonical display order). */
  symbols: LadderSymbol[];
  /** Number of symbols agreeing on direction: 0 (no badge), 2, or 3. */
  confirmCount: 0 | 2 | 3;
  /** True when this row holds the largest |change| in the visible set. */
  isLargestMover: boolean;
}

/** Width of the ATM band, in basis points of spot. 25 bps ≈ ±0.25%. */
export const ATM_BAND_BPS = 25;

/** ±N points around a strike used to bin cross-asset winners together. */
export const CROSS_ASSET_TOLERANCE_PTS = 5;

/** Multiplier to convert SPY strikes to SPX-equivalent strikes. */
export const SPY_TO_SPX_RATIO = 10;

/** Maximum rows rendered per side (ceilings, floors). */
export const MAX_ROWS_PER_SIDE = 5;

/** Minimum bar fill % when a row's |change| is non-zero. Mirrors CharmClock. */
export const MIN_BAR_PCT = 4;

/** GEXBot endpoint suffix that every 0DTE state category shares. */
export const GEXBOT_MAXCHANGE_SUFFIX = '/maxchange';

/** Maps the on-screen tab to GEXBot's 0DTE category key. */
export const CATEGORY_TO_GEXBOT_KEY: Record<CategoryTab, string> = {
  gex: 'gex_zero',
  gamma: 'gamma_zero',
  delta: 'delta_zero',
  vanna: 'vanna_zero',
  charm: 'charm_zero',
};

/** Display label for each tab. */
export const CATEGORY_LABEL: Record<CategoryTab, string> = {
  gex: 'GEX',
  gamma: 'γ',
  delta: 'Δ',
  vanna: 'V',
  charm: 'CH',
};
```

- [ ] **Step 1.3: Write the failing color test**

File: `src/__tests__/strike-mover-ladder.colors.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { classifyRow } from '../components/Gexbot/strike-mover-ladder/colors';

describe('classifyRow', () => {
  const SPOT = 6750;

  it('classifies below-spot positive Δ as floor strengthening (emerald)', () => {
    const r = classifyRow(6700, SPOT, 1_600);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('strengthening');
    expect(r.toneClass).toBe('text-emerald-300');
    expect(r.marker).toBeNull();
  });

  it('classifies below-spot negative Δ as floor weakening (amber + ▽)', () => {
    const r = classifyRow(6700, SPOT, -199);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('weakening');
    expect(r.toneClass).toBe('text-amber-300');
    expect(r.marker).toBe('▽');
  });

  it('classifies above-spot negative Δ as ceiling strengthening (rose)', () => {
    const r = classifyRow(6800, SPOT, -820);
    expect(r.side).toBe('above');
    expect(r.tone).toBe('strengthening');
    expect(r.toneClass).toBe('text-rose-300');
    expect(r.marker).toBeNull();
  });

  it('classifies above-spot positive Δ as ceiling weakening (yellow + ▽)', () => {
    const r = classifyRow(6800, SPOT, 164);
    expect(r.side).toBe('above');
    expect(r.tone).toBe('weakening');
    expect(r.toneClass).toBe('text-yellow-300');
    expect(r.marker).toBe('▽');
  });

  it('classifies a strike within ±0.25% as ATM magnet (violet + ◈ ATM)', () => {
    // Spot 6750 → band ±16.875. 6760 is inside the band.
    const r = classifyRow(6760, SPOT, 2_100);
    expect(r.side).toBe('atm');
    expect(r.tone).toBe('magnet');
    expect(r.toneClass).toBe('text-violet-300');
    expect(r.marker).toBe('◈ ATM');
  });

  it('classifies the exact-spot strike as ATM regardless of Δ sign', () => {
    const positive = classifyRow(6750, SPOT, 100);
    const negative = classifyRow(6750, SPOT, -100);
    expect(positive.side).toBe('atm');
    expect(negative.side).toBe('atm');
  });

  it('treats Δ === 0 below spot as weakening (no positive contribution)', () => {
    const r = classifyRow(6700, SPOT, 0);
    expect(r.side).toBe('below');
    expect(r.tone).toBe('weakening');
  });
});
```

- [ ] **Step 1.4: Run the test, expect failure**

Run: `npm run test:run -- src/__tests__/strike-mover-ladder.colors.test.ts`

Expected: FAIL — `classifyRow` is not exported (module not found).

- [ ] **Step 1.5: Write `colors.ts`**

File: `src/components/Gexbot/strike-mover-ladder/colors.ts`

```ts
/**
 * Pure color/tone classifier for ladder rows. Encodes the trading-aware
 * 4-quadrant matrix from the spec plus an ATM-magnet override.
 *
 *   Below spot · +Δ → floor strengthening   → emerald
 *   Below spot · −Δ → floor weakening       → amber + ▽
 *   Above spot · −Δ → ceiling strengthening → rose
 *   Above spot · +Δ → ceiling weakening     → yellow + ▽
 *   Within ±ATM_BAND_BPS → magnet           → violet + ◈ ATM
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md
 */

import { ATM_BAND_BPS, type ClassifiedRow } from './types';

export function classifyRow(
  strike: number,
  spot: number,
  change: number,
): ClassifiedRow {
  const bandWidth = spot * (ATM_BAND_BPS / 10_000);
  const distance = Math.abs(strike - spot);
  if (distance <= bandWidth) {
    return {
      side: 'atm',
      tone: 'magnet',
      toneClass: 'text-violet-300',
      marker: '◈ ATM',
    };
  }
  const positive = change > 0;
  const above = strike > spot;
  if (above) {
    return positive
      ? {
          side: 'above',
          tone: 'weakening',
          toneClass: 'text-yellow-300',
          marker: '▽',
        }
      : {
          side: 'above',
          tone: 'strengthening',
          toneClass: 'text-rose-300',
          marker: null,
        };
  }
  return positive
    ? {
        side: 'below',
        tone: 'strengthening',
        toneClass: 'text-emerald-300',
        marker: null,
      }
    : {
        side: 'below',
        tone: 'weakening',
        toneClass: 'text-amber-300',
        marker: '▽',
      };
}
```

- [ ] **Step 1.6: Run tests, expect pass**

Run: `npm run test:run -- src/__tests__/strike-mover-ladder.colors.test.ts`

Expected: PASS — 7 tests.

- [ ] **Step 1.7: Lint**

Run: `npm run lint`

Expected: zero errors. Fix any reported issues before committing.

- [ ] **Step 1.8: Commit**

```bash
git add src/components/Gexbot/strike-mover-ladder/types.ts \
        src/components/Gexbot/strike-mover-ladder/colors.ts \
        src/__tests__/strike-mover-ladder.colors.test.ts && \
git commit -m "$(cat <<'EOF'
feat(gexbot): Add StrikeMoverLadder types + color classifier

Foundation for the spot-anchored SPX ladder that will replace the
StrikeMoverTicker chip wall. classifyRow() encodes the trading-aware
position × sign matrix from the spec — floor strengthening (emerald)
vs floor weakening (amber + ▽) vs ceiling strengthening (rose) vs
ceiling weakening (yellow + ▽), with an ATM-magnet override (violet
+ ◈ ATM) for strikes within ±0.25% of spot.

Pure function, no React dependencies — fully unit-tested across all
five cases.

Refs spec docs/superpowers/specs/strike-mover-ladder-2026-05-19.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Cross-asset aggregation

**Files:**

- Create: `src/components/Gexbot/strike-mover-ladder/aggregation.ts`
- Create: `src/__tests__/strike-mover-ladder.aggregation.test.ts`

- [ ] **Step 2.1: Write the failing aggregation test**

File: `src/__tests__/strike-mover-ladder.aggregation.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { buildLadderRows, sortAndCapRows } from '../components/Gexbot/strike-mover-ladder/aggregation';
import type { MaxchangeWinnerRow } from '../hooks/useGexbotData';

function makeWinner(
  ticker: string,
  category: string,
  strike: number,
  change: number,
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint: `/foo/${ticker}`,
    category,
    capturedAt: '2026-05-19T17:00:00Z',
    windows: {
      current: null,
      one: null,
      five: [strike, change],
      ten: null,
      fifteen: null,
      thirty: null,
    },
  };
}

describe('buildLadderRows', () => {
  it('returns [] when no winners match the active category', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_one/maxchange', 6750, 100)],
      'gex',
    );
    expect(rows).toEqual([]);
  });

  it('produces a single row when SPX is the only winner', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100)],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6750);
    expect(rows[0]!.change).toBe(2_100);
    expect(rows[0]!.symbols).toEqual(['SPX']);
    expect(rows[0]!.confirmCount).toBe(0);
    expect(rows[0]!.isLargestMover).toBe(true);
  });

  it('bins ES_SPX within ±5pt of SPX into the same row', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6752, 2_050),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'ES_SPX']);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('bins SPY × 10 with SPX into the same row', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 950),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(2);
  });

  it('emits 3✓ when SPX + ES_SPX + SPY all agree on direction', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 2_080),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 1_500),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX', 'ES_SPX', 'SPY']);
    expect(rows[0]!.confirmCount).toBe(3);
  });

  it('suppresses the confirm badge when signs disagree', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, -500),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confirmCount).toBe(0);
  });

  it('filters non-spine tickers (QQQ, NDX, IWM) out entirely', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('QQQ', 'gex_zero/maxchange', 702, -800),
        makeWinner('NDX', 'gex_zero/maxchange', 29000, 365),
        makeWinner('IWM', 'gex_zero/maxchange', 272, -100),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.symbols).toEqual(['SPX']);
  });

  it('rounds SPY-derived strikes to the nearest 5 for binning', () => {
    // SPY 673.4 × 10 = 6734 → rounds to 6735.
    // SPX 6735 should bin with this SPY sample.
    const rows = buildLadderRows(
      [
        makeWinner('SPY', 'gex_zero/maxchange', 673.4, 800),
        makeWinner('SPX', 'gex_zero/maxchange', 6735, 1_400),
      ],
      'gex',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.strike).toBe(6735);
  });

  it('skips winners whose Δ is exactly zero', () => {
    const rows = buildLadderRows(
      [makeWinner('SPX', 'gex_zero/maxchange', 6750, 0)],
      'gex',
    );
    expect(rows).toEqual([]);
  });

  it('marks only the largest |Δ| row as isLargestMover', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6700, 1_500),
        makeWinner('SPX', 'gex_zero/maxchange', 6800, -3_200),
      ],
      'gex',
    );
    expect(rows).toHaveLength(2);
    const big = rows.find((r) => r.strike === 6800);
    const small = rows.find((r) => r.strike === 6700);
    expect(big!.isLargestMover).toBe(true);
    expect(small!.isLargestMover).toBe(false);
  });

  it('uses the SPX sample to set canonical change when SPX present', () => {
    const rows = buildLadderRows(
      [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 9_999),
      ],
      'gex',
    );
    expect(rows[0]!.change).toBe(2_100);
  });
});

describe('sortAndCapRows', () => {
  const make = (
    strike: number,
    change: number,
  ): import('../components/Gexbot/strike-mover-ladder/types').AggregatedRow => ({
    strike,
    change,
    symbols: ['SPX'],
    confirmCount: 0,
    isLargestMover: false,
  });

  it('orders rows by strike descending', () => {
    const out = sortAndCapRows([make(6700, 1), make(6800, 1), make(6750, 1)], 6750);
    expect(out.map((r) => r.strike)).toEqual([6800, 6750, 6700]);
  });

  it('caps each side at 5 rows, preferring proximity to spot', () => {
    const ceilings = [6760, 6770, 6780, 6790, 6800, 6810, 6820].map((s) =>
      make(s, 1),
    );
    const floors = [6740, 6730, 6720, 6710, 6700, 6690, 6680].map((s) =>
      make(s, 1),
    );
    const out = sortAndCapRows([...ceilings, ...floors], 6750);

    // 5 ceilings closest to spot: 6760, 6770, 6780, 6790, 6800 (NOT 6810/6820).
    // 5 floors closest to spot: 6740, 6730, 6720, 6710, 6700 (NOT 6690/6680).
    expect(out.map((r) => r.strike)).toEqual([
      6800, 6790, 6780, 6770, 6760,
      6740, 6730, 6720, 6710, 6700,
    ]);
  });

  it('keeps ATM rows in the visible set even when ceilings/floors are capped', () => {
    const rows = [
      ...[6760, 6770, 6780, 6790, 6800, 6810].map((s) => make(s, 1)),
      make(6750, 1), // exact ATM
    ];
    const out = sortAndCapRows(rows, 6750);
    expect(out.find((r) => r.strike === 6750)).toBeDefined();
  });
});
```

- [ ] **Step 2.2: Run test, expect failure**

Run: `npm run test:run -- src/__tests__/strike-mover-ladder.aggregation.test.ts`

Expected: FAIL — `buildLadderRows` and `sortAndCapRows` not exported.

- [ ] **Step 2.3: Write `aggregation.ts`**

File: `src/components/Gexbot/strike-mover-ladder/aggregation.ts`

```ts
/**
 * Cross-asset aggregation for the StrikeMoverLadder.
 *
 * Input:  raw MaxchangeWinnerRow[] from `useGexbotData({view:'maxchange-winners'})`.
 * Output: AggregatedRow[] anchored on SPX-equivalent strikes, with
 *         cross-asset symbol dots and 3✓/2✓ confirmation badges.
 *
 * Pipeline:
 *   1. Filter to {SPX, ES_SPX, SPY} × selected 0DTE category.
 *   2. Convert SPY strikes to SPX-equivalent (× 10).
 *   3. Bin to nearest-5 SPX-equivalent strike; merge adjacent bins
 *      within ±CROSS_ASSET_TOLERANCE_PTS into one row.
 *   4. Compute confirmCount (sign-agreement among present symbols).
 *   5. Mark the largest |Δ| row.
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md
 */

import type { MaxchangeWinnerRow } from '../../../hooks/useGexbotData';
import {
  ATM_BAND_BPS,
  CATEGORY_TO_GEXBOT_KEY,
  CROSS_ASSET_TOLERANCE_PTS,
  GEXBOT_MAXCHANGE_SUFFIX,
  MAX_ROWS_PER_SIDE,
  SPY_TO_SPX_RATIO,
  type AggregatedRow,
  type CategoryTab,
  type LadderSymbol,
} from './types';

const TICKER_TO_SYMBOL: Record<string, LadderSymbol | undefined> = {
  SPX: 'SPX',
  ES_SPX: 'ES_SPX',
  SPY: 'SPY',
};

const SYMBOL_DISPLAY_ORDER: readonly LadderSymbol[] = ['SPX', 'ES_SPX', 'SPY'];

interface WinnerSample {
  symbol: LadderSymbol;
  /** SPX-equivalent strike (SPY × 10 applied). */
  strikeSpx: number;
  change: number;
}

function toSpxStrike(symbol: LadderSymbol, strike: number): number {
  return symbol === 'SPY' ? strike * SPY_TO_SPX_RATIO : strike;
}

function roundToNearest5(n: number): number {
  return Math.round(n / 5) * 5;
}

function filterWinners(
  rows: MaxchangeWinnerRow[],
  category: CategoryTab,
): WinnerSample[] {
  const targetCategory = `${CATEGORY_TO_GEXBOT_KEY[category]}${GEXBOT_MAXCHANGE_SUFFIX}`;
  const samples: WinnerSample[] = [];
  for (const r of rows) {
    if (r.category !== targetCategory) continue;
    const symbol = TICKER_TO_SYMBOL[r.ticker];
    if (!symbol) continue;
    const five = r.windows.five;
    if (!five) continue;
    const [strike, change] = five;
    if (change === 0) continue;
    samples.push({
      symbol,
      strikeSpx: toSpxStrike(symbol, strike),
      change,
    });
  }
  return samples;
}

export function buildLadderRows(
  rows: MaxchangeWinnerRow[],
  category: CategoryTab,
): AggregatedRow[] {
  const samples = filterWinners(rows, category);
  if (samples.length === 0) return [];

  // Bin by SPX-equivalent strike, rounded to nearest 5.
  const bins = new Map<number, WinnerSample[]>();
  for (const s of samples) {
    const key = roundToNearest5(s.strikeSpx);
    const bucket = bins.get(key) ?? [];
    bucket.push(s);
    bins.set(key, bucket);
  }

  // Merge adjacent bins whose centers are within tolerance. Walk in
  // sorted order; if the next key is within ±tolerance of the active
  // bucket key, fold it in. Otherwise it becomes a new active bucket.
  const orderedKeys = [...bins.keys()].sort((a, b) => a - b);
  const merged = new Map<number, WinnerSample[]>();
  let activeKey: number | null = null;
  for (const key of orderedKeys) {
    if (
      activeKey !== null &&
      Math.abs(key - activeKey) <= CROSS_ASSET_TOLERANCE_PTS
    ) {
      const bucket = merged.get(activeKey);
      bucket!.push(...bins.get(key)!);
    } else {
      merged.set(key, [...bins.get(key)!]);
      activeKey = key;
    }
  }

  const out: AggregatedRow[] = [];
  for (const [strike, bucket] of merged) {
    const spx = bucket.find((b) => b.symbol === 'SPX');
    const canonical = spx ?? bucket[0]!;

    const presentSet = new Set(bucket.map((b) => b.symbol));
    const symbols = SYMBOL_DISPLAY_ORDER.filter((s) => presentSet.has(s));

    const canonicalSign = Math.sign(canonical.change);
    const allAgree = bucket.every(
      (b) => Math.sign(b.change) === canonicalSign,
    );
    const confirmCount: 0 | 2 | 3 =
      allAgree && symbols.length >= 2 ? (symbols.length as 2 | 3) : 0;

    out.push({
      strike,
      change: canonical.change,
      symbols,
      confirmCount,
      isLargestMover: false,
    });
  }

  // Mark the largest mover by |change|.
  let maxAbs = 0;
  let maxIdx = -1;
  for (let i = 0; i < out.length; i++) {
    const abs = Math.abs(out[i]!.change);
    if (abs > maxAbs) {
      maxAbs = abs;
      maxIdx = i;
    }
  }
  if (maxIdx >= 0) out[maxIdx]!.isLargestMover = true;

  return out;
}

/**
 * Split rows into ceiling/ATM/floor, cap each side at MAX_ROWS_PER_SIDE
 * (preferring proximity to spot), then re-sort the visible set by
 * strike descending for top-to-bottom display.
 */
export function sortAndCapRows(
  rows: AggregatedRow[],
  spot: number,
): AggregatedRow[] {
  const bandWidth = spot * (ATM_BAND_BPS / 10_000);
  const ceilings: AggregatedRow[] = [];
  const floors: AggregatedRow[] = [];
  const atm: AggregatedRow[] = [];
  for (const r of rows) {
    const dist = Math.abs(r.strike - spot);
    if (dist <= bandWidth) atm.push(r);
    else if (r.strike > spot) ceilings.push(r);
    else floors.push(r);
  }

  ceilings.sort(
    (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
  );
  floors.sort(
    (a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot),
  );
  const trimmedCeilings = ceilings.slice(0, MAX_ROWS_PER_SIDE);
  const trimmedFloors = floors.slice(0, MAX_ROWS_PER_SIDE);

  const all = [...trimmedCeilings, ...atm, ...trimmedFloors];
  all.sort((a, b) => b.strike - a.strike);
  return all;
}
```

- [ ] **Step 2.4: Run tests, expect pass**

Run: `npm run test:run -- src/__tests__/strike-mover-ladder.aggregation.test.ts`

Expected: PASS — 14 tests (11 for buildLadderRows, 3 for sortAndCapRows).

- [ ] **Step 2.5: Lint**

Run: `npm run lint`

Expected: zero errors.

- [ ] **Step 2.6: Commit**

```bash
git add src/components/Gexbot/strike-mover-ladder/aggregation.ts \
        src/__tests__/strike-mover-ladder.aggregation.test.ts && \
git commit -m "$(cat <<'EOF'
feat(gexbot): Add StrikeMoverLadder cross-asset aggregation

Pure pipeline that takes MaxchangeWinnerRow[] from useGexbotData and
produces AggregatedRow[] for the SPX-spine ladder:

  1. Filter to {SPX, ES_SPX, SPY} × selected 0DTE category.
  2. Convert SPY strikes to SPX-equivalent (× 10).
  3. Round to nearest-5 SPX strike; merge adjacent bins within ±5pt.
  4. Emit 3✓ / 2✓ confirmCount when present symbols agree on direction.
  5. Mark the largest |Δ| row.

sortAndCapRows() splits into ceilings/ATM/floors, caps each side at 5
(by proximity to spot), then re-sorts by strike descending for display.

Refs spec docs/superpowers/specs/strike-mover-ladder-2026-05-19.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Component shell — header, tabs, loading/error/empty states

**Files:**

- Create: `src/components/Gexbot/StrikeMoverLadder.tsx`
- Create: `src/__tests__/StrikeMoverLadder.test.tsx`

- [ ] **Step 3.1: Write the failing component test**

File: `src/__tests__/StrikeMoverLadder.test.tsx`

```tsx
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { StrikeMoverLadder } from '../components/Gexbot/StrikeMoverLadder';
import type { MaxchangeWinnerRow } from '../hooks/useGexbotData';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useGexbotData')>(
    '../hooks/useGexbotData',
  );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

function makeWinner(
  ticker: string,
  category: string,
  strike: number,
  change: number,
): MaxchangeWinnerRow {
  return {
    ticker,
    endpoint: `/foo/${ticker}`,
    category,
    capturedAt: '2026-05-19T17:00:00Z',
    windows: {
      current: null,
      one: null,
      five: [strike, change],
      ten: null,
      fifteen: null,
      thirty: null,
    },
  };
}

describe('<StrikeMoverLadder>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
  });

  it('renders loading placeholder when hook is loading', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: true,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-loading')).toBeInTheDocument();
  });

  it('renders error tile when hook reports an error', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: 'HTTP 500',
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-error')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
  });

  it('renders empty state when no SPX winners are present', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
  });

  it('shows the spot in the header when available', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750.5} />);
    expect(screen.getByText(/spot 6750\.5/)).toBeInTheDocument();
  });

  it('renders a row for each SPX winner inside the active category', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('ES_SPX', 'gex_zero/maxchange', 6750, 2_050),
        makeWinner('SPY', 'gex_zero/maxchange', 675, 1_500),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    const row = screen.getByTestId('strike-mover-ladder-row-6750');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('6750');
    expect(row).toHaveTextContent('3✓');
  });

  it('switches the active category when a tab is clicked', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [
        makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100),
        makeWinner('SPX', 'gamma_zero/maxchange', 6700, 800),
      ],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    // Default = GEX → shows strike 6750.
    expect(screen.getByTestId('strike-mover-ladder-row-6750')).toBeInTheDocument();
    // Switch to γ tab → shows strike 6700.
    fireEvent.click(screen.getByRole('button', { name: /^γ$/ }));
    expect(screen.getByTestId('strike-mover-ladder-row-6700')).toBeInTheDocument();
  });

  it('renders the ATM badge on a magnet row', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeWinner('SPX', 'gex_zero/maxchange', 6750, 2_100)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByText('◈ ATM')).toBeInTheDocument();
  });

  it('renders the spot divider when at least one row is present', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [makeWinner('SPX', 'gex_zero/maxchange', 6800, -820)],
      loading: false,
      error: null,
      freshestAt: '2026-05-19T17:00:00Z',
    });
    render(<StrikeMoverLadder marketOpen spxSpot={6750} />);
    expect(screen.getByTestId('strike-mover-ladder-spot-divider')).toBeInTheDocument();
  });

  it('falls back gracefully when spxSpot is null', () => {
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
    render(<StrikeMoverLadder marketOpen spxSpot={null} />);
    // Empty state still renders.
    expect(screen.getByTestId('strike-mover-ladder-empty')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3.2: Run test, expect failure**

Run: `npm run test:run -- src/__tests__/StrikeMoverLadder.test.tsx`

Expected: FAIL — module not found.

- [ ] **Step 3.3: Write `StrikeMoverLadder.tsx`**

File: `src/components/Gexbot/StrikeMoverLadder.tsx`

```tsx
/**
 * StrikeMoverLadder — SPX-spine, spot-anchored ladder of strike movers
 * focused on 0DTE trading. Replaces the StrikeMoverTicker chip wall.
 *
 * The body shows at most 5 ceilings above spot and 5 floors below, with
 * an ATM-magnet band rendered between them. Cross-asset confirmation is
 * shown as symbol dots + a 3✓/2✓ badge. Position-aware coloring distinguishes
 * a strengthening level from a failing one (see colors.ts).
 *
 * Data: useGexbotData({view:'maxchange-winners'}) for the rows; SPX spot
 * is threaded as a prop from App.tsx (Schwab realtime) — GEXBot's
 * snapshots-latest is intentionally NOT used here because its minute
 * cadence can lag the divider position by ~60 s during fast moves.
 *
 * Spec: docs/superpowers/specs/strike-mover-ladder-2026-05-19.md
 */

import { memo, useMemo, useState } from 'react';

import { useGexbotData } from '../../hooks/useGexbotData';
import { buildLadderRows, sortAndCapRows } from './strike-mover-ladder/aggregation';
import { classifyRow } from './strike-mover-ladder/colors';
import {
  CATEGORY_LABEL,
  MIN_BAR_PCT,
  type AggregatedRow,
  type CategoryTab,
} from './strike-mover-ladder/types';

interface StrikeMoverLadderProps {
  marketOpen: boolean;
  /** SPX last price from Schwab via useMarketData in App.tsx. Null when unauth or pre-fetch. */
  spxSpot: number | null;
}

const SPEC = { view: 'maxchange-winners' as const };
const TABS: readonly CategoryTab[] = ['gex', 'gamma', 'delta', 'vanna', 'charm'];

function formatChange(value: number): string {
  const abs = Math.abs(value);
  const sign = value >= 0 ? '+' : '−';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

function formatSpot(spot: number): string {
  return spot.toFixed(2).replace(/\.?0+$/, '');
}

function StrikeMoverLadderInner({ marketOpen, spxSpot }: StrikeMoverLadderProps) {
  const { rows: rawRows, loading, error } = useGexbotData(SPEC, marketOpen);
  const [activeTab, setActiveTab] = useState<CategoryTab>('gex');

  const visibleRows = useMemo<AggregatedRow[]>(() => {
    if (spxSpot == null) return [];
    const built = buildLadderRows(rawRows, activeTab);
    return sortAndCapRows(built, spxSpot);
  }, [rawRows, activeTab, spxSpot]);

  const maxAbsChange = useMemo(
    () =>
      visibleRows.reduce((m, r) => Math.max(m, Math.abs(r.change)), 0),
    [visibleRows],
  );

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-ladder-loading"
        className="text-tertiary rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-xs"
      >
        Strike Mover Ladder — loading…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="strike-mover-ladder-error"
        className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300/80"
      >
        Strike Mover Ladder — {error}
      </div>
    );
  }

  const hasRows = visibleRows.length > 0;

  return (
    <div
      data-testid="strike-mover-ladder"
      className="rounded-md border border-white/5 bg-white/[0.02]"
    >
      <div className="flex items-baseline justify-between border-b border-white/5 px-3 py-2">
        <span className="text-tertiary text-[10px] tracking-wide uppercase">
          Strike Movers — SPX 0DTE
          {spxSpot != null && ` · spot ${formatSpot(spxSpot)}`}
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-white/5 px-3 py-1.5">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-sm px-2 py-0.5 text-[11px] tabular-nums transition ${
              activeTab === tab
                ? 'bg-white/10 text-white'
                : 'text-tertiary hover:bg-white/5'
            }`}
          >
            {CATEGORY_LABEL[tab]}
          </button>
        ))}
      </div>

      {hasRows ? (
        <LadderBody
          rows={visibleRows}
          spot={spxSpot!}
          maxAbsChange={maxAbsChange}
        />
      ) : (
        <div
          role="status"
          aria-live="polite"
          data-testid="strike-mover-ladder-empty"
          className="text-tertiary px-3 py-3 text-xs"
        >
          No SPX winners in last 5 min for {CATEGORY_LABEL[activeTab]} (0DTE)
        </div>
      )}
    </div>
  );
}

interface LadderBodyProps {
  rows: AggregatedRow[];
  spot: number;
  maxAbsChange: number;
}

function LadderBody({ rows, spot, maxAbsChange }: LadderBodyProps) {
  // Find the index where to insert the spot divider — between the
  // last ceiling (strike > spot) and the first floor (strike <= spot).
  const dividerIdx = rows.findIndex((r) => r.strike <= spot);

  return (
    <div className="px-3 py-2">
      {rows.map((row, idx) => (
        <div key={row.strike}>
          {idx === dividerIdx && (
            <SpotDivider spot={spot} />
          )}
          <LadderRow row={row} spot={spot} maxAbsChange={maxAbsChange} />
        </div>
      ))}
      {/* Edge: all rows are above spot — divider goes at the bottom. */}
      {dividerIdx === -1 && rows.length > 0 && <SpotDivider spot={spot} />}
    </div>
  );
}

function SpotDivider({ spot }: { spot: number }) {
  return (
    <div
      data-testid="strike-mover-ladder-spot-divider"
      className="my-1 flex items-center gap-2 text-[10px] tracking-wide text-white/40 uppercase"
    >
      <span className="flex-1 border-t border-white/20" />
      <span className="font-medium">SPX spot {formatSpot(spot)}</span>
      <span className="flex-1 border-t border-white/20" />
    </div>
  );
}

interface LadderRowProps {
  row: AggregatedRow;
  spot: number;
  maxAbsChange: number;
}

function LadderRow({ row, spot, maxAbsChange }: LadderRowProps) {
  const classified = classifyRow(row.strike, spot, row.change);
  const barPct =
    maxAbsChange > 0
      ? Math.max(MIN_BAR_PCT, (Math.abs(row.change) / maxAbsChange) * 100)
      : 0;
  const barColor =
    classified.tone === 'magnet'
      ? 'bg-violet-400/50'
      : row.change >= 0
        ? 'bg-emerald-400/50'
        : 'bg-rose-400/50';

  return (
    <div
      data-testid={`strike-mover-ladder-row-${row.strike}`}
      className={`flex items-center gap-2 py-0.5 text-[11px] tabular-nums ${classified.toneClass}`}
    >
      <span className="w-12 font-medium">{row.strike}</span>

      {classified.marker === '◈ ATM' && (
        <span className="text-[10px] font-semibold tracking-wide">
          ◈ ATM
        </span>
      )}

      <span className="text-tertiary flex gap-1">
        {row.symbols.map((s) => (
          <span key={s} aria-label={s}>
            ▪{s === 'ES_SPX' ? 'ES' : s}
          </span>
        ))}
      </span>

      {row.confirmCount > 0 && (
        <span className="rounded-sm bg-white/10 px-1 text-[10px] font-semibold">
          {row.confirmCount}✓
        </span>
      )}

      <span className="ml-auto font-mono">{formatChange(row.change)}</span>

      <span
        aria-hidden="true"
        className="h-1.5 w-16 overflow-hidden rounded-sm bg-white/5"
      >
        <span
          className={`block h-full ${barColor}`}
          style={{ width: `${barPct}%` }}
        />
      </span>

      <span className="w-5 text-center">
        {row.isLargestMover ? '⚡' : classified.marker === '▽' ? '▽' : ''}
      </span>
    </div>
  );
}

export const StrikeMoverLadder = memo(StrikeMoverLadderInner);
```

- [ ] **Step 3.4: Run tests, expect pass**

Run: `npm run test:run -- src/__tests__/StrikeMoverLadder.test.tsx`

Expected: PASS — 9 tests.

- [ ] **Step 3.5: Lint**

Run: `npm run lint`

Expected: zero errors.

- [ ] **Step 3.6: Commit**

```bash
git add src/components/Gexbot/StrikeMoverLadder.tsx \
        src/__tests__/StrikeMoverLadder.test.tsx && \
git commit -m "$(cat <<'EOF'
feat(gexbot): Add StrikeMoverLadder component

Spot-anchored SPX-spine ladder built on the previously committed
colors.ts + aggregation.ts pure layer. Renders:

  - Header with SPX 0DTE label + current spot.
  - Category tabs (GEX / γ / Δ / V / CH), mutually exclusive, 0DTE only.
  - Body with ceilings above spot, ATM magnet rows, floors below spot,
    spot divider rendered between the two sides.
  - Per-row: strike, cross-asset symbol dots, 3✓/2✓ confirm badge,
    signed Δ, magnitude bar, ⚡ largest-mover / ▽ direction-mismatch.
  - Loading / error / empty states (testid-tagged for parent smoke tests).

SPX spot is threaded as a prop (Schwab realtime via useMarketData);
not yet wired into GexbotSection — that swap is the next task.

Refs spec docs/superpowers/specs/strike-mover-ladder-2026-05-19.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire StrikeMoverLadder into GexbotSection + App.tsx; delete old ticker

This task makes the full swap in a single commit so main stays
build-green (no intermediate broken-tsc state).

**Files:**

- Modify: `src/components/Gexbot/GexbotSection.tsx`
- Modify: `src/__tests__/GexbotSection.test.tsx`
- Modify: `src/App.tsx` (one render block)
- Delete: `src/components/Gexbot/StrikeMoverTicker.tsx`
- Delete: `src/__tests__/StrikeMoverTicker.test.tsx`

- [ ] **Step 4.1: Update the GexbotSection test for the new testid + spxSpot prop**

File: `src/__tests__/GexbotSection.test.tsx`

Replace the contents with:

```tsx
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockUseGexbotData = vi.fn();
vi.mock('../hooks/useGexbotData', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useGexbotData')>(
    '../hooks/useGexbotData',
  );
  return {
    ...actual,
    useGexbotData: (...args: unknown[]) => mockUseGexbotData(...args),
  };
});

import { GexbotSection } from '../components/Gexbot/GexbotSection';

describe('<GexbotSection>', () => {
  beforeEach(() => {
    mockUseGexbotData.mockReset();
    mockUseGexbotData.mockReturnValue({
      rows: [],
      loading: false,
      error: null,
      freshestAt: null,
    });
  });

  it('renders without crashing with marketOpen=true', () => {
    const { container } = render(
      <GexbotSection marketOpen spxSpot={6750} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('renders without crashing with marketOpen=false', () => {
    const { container } = render(
      <GexbotSection marketOpen={false} spxSpot={null} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it('shows the section label', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(screen.getByText(/GEXBot Dealer State/i)).toBeInTheDocument();
  });

  it('mounts all 7 child components (drives empty-state testids)', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    // Each child has a distinct *-empty testid; if any import broke,
    // one of these would be absent.
    expect(
      screen.getByTestId('strike-mover-ladder-empty'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('vix-dealer-state-badge-empty'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('charm-clock-empty')).toBeInTheDocument();
    expect(screen.getByTestId('gamma-compass-empty')).toBeInTheDocument();
    expect(screen.getByTestId('dexoflow-tape-empty')).toBeInTheDocument();
    expect(screen.getByTestId('convexity-matrix-empty')).toBeInTheDocument();
    expect(screen.getByTestId('skew-dashboard-empty')).toBeInTheDocument();
  });

  it('forwards marketOpen=false to the data hook for each child', () => {
    render(<GexbotSection marketOpen={false} spxSpot={null} />);
    const calls = mockUseGexbotData.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[1]).toBe(false);
    }
  });

  it('renders the trial-context footnote', () => {
    render(<GexbotSection marketOpen spxSpot={6750} />);
    expect(
      screen.getByText(/GEXBot Orderflow-tier data/i),
    ).toBeInTheDocument();
  });
});
```

- [ ] **Step 4.2: Update `GexbotSection.tsx`**

File: `src/components/Gexbot/GexbotSection.tsx`

Replace the contents with:

```tsx
/**
 * GexbotSection — dedicated section housing the GEXBot trial-data
 * components. Spec:
 * docs/superpowers/specs/gexbot-frontend-2026-05-16.md
 *
 * Children consume their own data via useGexbotData. The section
 * itself is just a layout container that forwards `marketOpen` (used
 * for polling gating) and the live SPX spot (used by StrikeMoverLadder
 * to anchor the ladder).
 *
 * The Sibling-Asset Confirmation Bar lives inline in lottery/silent-
 * boom rows, not in this section.
 */

import { memo } from 'react';

import { SectionBox } from '../ui';
import { CharmClock } from './CharmClock';
import { ConvexityMatrix } from './ConvexityMatrix';
import { CrossAssetSkewDashboard } from './CrossAssetSkewDashboard';
import { DexoflowVelocityTape } from './DexoflowVelocityTape';
import { GammaCompass } from './GammaCompass';
import { StrikeMoverLadder } from './StrikeMoverLadder';
import { VixDealerStateBadge } from './VixDealerStateBadge';

interface GexbotSectionProps {
  marketOpen: boolean;
  /**
   * Live SPX spot (Schwab via useMarketData). Forwarded to
   * StrikeMoverLadder; other children don't use it.
   */
  spxSpot: number | null;
}

function GexbotSectionInner({ marketOpen, spxSpot }: GexbotSectionProps) {
  return (
    <SectionBox label="GEXBot Dealer State" collapsible>
      <div className="flex flex-col gap-3">
        <StrikeMoverLadder marketOpen={marketOpen} spxSpot={spxSpot} />
        <VixDealerStateBadge marketOpen={marketOpen} />
        <CharmClock marketOpen={marketOpen} />
        <GammaCompass marketOpen={marketOpen} />
        <DexoflowVelocityTape marketOpen={marketOpen} />
        <ConvexityMatrix marketOpen={marketOpen} />
        <CrossAssetSkewDashboard marketOpen={marketOpen} />
      </div>
      <p className="text-tertiary mt-3 text-[10px] leading-relaxed">
        GEXBot Orderflow-tier data — capture pipeline ships dealer positioning +
        flow metrics for 16 Index/ETF tickers every minute during market hours.
      </p>
    </SectionBox>
  );
}

export const GexbotSection = memo(GexbotSectionInner);
```

- [ ] **Step 4.3: Update the `<GexbotSection>` render in App.tsx**

In `src/App.tsx`, locate the existing block (around line 1224):

```tsx
<GexbotSection
  marketOpen={market.data.quotes?.marketOpen ?? false}
/>
```

Replace it with:

```tsx
<GexbotSection
  marketOpen={market.data.quotes?.marketOpen ?? false}
  spxSpot={market.data.quotes?.spx?.price ?? null}
/>
```

- [ ] **Step 4.4: Delete the old ticker files**

```bash
rm src/components/Gexbot/StrikeMoverTicker.tsx \
   src/__tests__/StrikeMoverTicker.test.tsx
```

- [ ] **Step 4.5: Verify nothing imports the deleted module**

Run:

```bash
grep -rn "StrikeMoverTicker" src/ api/ 2>/dev/null
```

Expected output: zero matches in `.ts` / `.tsx` files. (Doc references in `docs/superpowers/` are fine — those are historical spec text.) If any code reference appears, fix the import before proceeding.

- [ ] **Step 4.6: Run the GexbotSection test**

Run: `npm run test:run -- src/__tests__/GexbotSection.test.tsx`

Expected: PASS — 6 tests.

- [ ] **Step 4.7: Run the full review**

Run: `npm run review`

Expected: tsc clean, eslint clean, prettier clean, vitest passes for all StrikeMoverLadder-related tests. **Unrelated pre-existing failures** in other test files (e.g. `takeit-fill-shap`) are not introduced by this task and can be ignored — verify by running only the relevant suites:

```bash
npm run test:run -- src/__tests__/StrikeMoverLadder.test.tsx \
                    src/__tests__/strike-mover-ladder.colors.test.ts \
                    src/__tests__/strike-mover-ladder.aggregation.test.ts \
                    src/__tests__/GexbotSection.test.tsx
```

Expected: all four green.

- [ ] **Step 4.8: Commit the full wire-up**

```bash
git add src/components/Gexbot/GexbotSection.tsx \
        src/__tests__/GexbotSection.test.tsx \
        src/App.tsx && \
git rm src/components/Gexbot/StrikeMoverTicker.tsx \
       src/__tests__/StrikeMoverTicker.test.tsx && \
git commit -m "$(cat <<'EOF'
feat(gexbot): Replace StrikeMoverTicker with spot-anchored StrikeMoverLadder

Final wire-up for the StrikeMoverLadder Phase 1 rollout — kept in a
single commit so main never carries a broken-tsc state:

  - GexbotSection gains a required `spxSpot: number | null` prop and
    renders <StrikeMoverLadder /> in place of <StrikeMoverTicker />.
  - App.tsx threads `spxSpot` from Schwab (market.data.quotes.spx.price)
    so the ladder anchor stays sub-second-fresh rather than minute-cadence.
  - The chip-wall StrikeMoverTicker.tsx and its test file are removed.
  - GexbotSection test asserts the new `strike-mover-ladder-empty` testid.

End of Phase 1. Phase 2 (sign-flip detection via cross-poll ring buffer)
will land as a separate plan after this soaks for one session.

Refs spec docs/superpowers/specs/strike-mover-ladder-2026-05-19.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4.9: Push**

```bash
git push
```

---

## Acceptance criteria — verify before declaring Phase 1 done

- [ ] Ladder visible on `npm run dev` with SPX spot in the header, sourced from `useMarketData` (Schwab).
- [ ] Toggling `[GEX] [γ] [Δ] [V] [CH]` tabs swaps the active category and the rendered rows change.
- [ ] When a row falls within ±0.25% of spot, it renders with the violet `text-violet-300` tone and a `◈ ATM` badge.
- [ ] Position-aware color matrix verified live: a strike above spot with a negative Δ shows in rose (strengthening ceiling); below spot with positive Δ shows emerald (strengthening floor); etc.
- [ ] Cross-asset confirmation: when SPX + ES_SPX + SPY winners agree, the row carries `3✓`.
- [ ] Magnitude bar present on every row, scaled to the visible-set max.
- [ ] Empty state renders when no SPX winners exist in the active category.
- [ ] `GexbotSection` still mounts all 7 children — confirmed by `src/__tests__/GexbotSection.test.tsx`.
- [ ] `grep -rn "StrikeMoverTicker" src/ api/` returns no matches (other than this plan and the spec).

---

## What this plan does NOT cover (deferred)

- **Phase 2 — sign-flip detection.** Spec section "Sign-flip detection (Phase 2, design preview)" describes a 10-minute client-local ring buffer keyed by `(symbol, category, strike)` plus a `↻` flipped-Xm-ago badge. Lands as a separate plan after Phase 1 soaks for one session.
- **Click-to-deep-dive** on a strike row — deferred until a deep-dive surface exists.
- **Persistent cross-reload flip history** — out of scope; the ring buffer is intentionally session-only.
- **Mobile / narrow-viewport behavior.** Tile is designed for the desktop multi-section layout. If the section appears clipped at <500px width, a stacked-card fallback can be added later.

---

## Self-review notes

The plan re-uses the same constants in two places (`ATM_BAND_BPS` used by both colors.ts and aggregation.ts.sortAndCapRows) — both import from `types.ts`, so there's a single source of truth. No drift risk.

The largest-mover marking happens in `buildLadderRows`, BEFORE `sortAndCapRows` trims the set. That means the `⚡` icon might land on a row that gets clipped out of the visible 5+5 budget. In practice the 5+5 budget will rarely trim anything (typical ladder state is 1–3 rows), so this is acceptable. If it ever bites, recompute `isLargestMover` after `sortAndCapRows` — single-line fix.

The `formatChange` helper in `StrikeMoverLadder.tsx` differs from the existing `formatChange` in the deleted `StrikeMoverTicker.tsx`. They're kept separate by design — the ladder's display constraints (narrow magnitude column, want "+3.7K" not "+3700") justify the new shape rather than back-porting it into a shared helper.
