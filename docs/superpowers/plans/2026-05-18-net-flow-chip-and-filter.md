# Net Flow Chip + Counter-Flow Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-ticker fire-time net-flow chips (per-row + parent rollup) and a `hide counter-flow` UI filter to Silent Boom and Lottery Finder, plus a historical backfill so the columns are reliable for ML use.

**Architecture:** Frontend-only feature. Both feeds already populate `cum_ncp_at_fire` / `cum_npp_at_fire` forward via `api/_lib/ticker-flow-snapshot.ts`. We (a) backfill the historical NULLs using the existing `scripts/backfill-ticker-flow-at-fire.mjs`, (b) extract a shared `macro-badges.ts` utility used by both row components, (c) extend `computeRollupAggregates` with a parallel `flow` aggregation, and (d) wire a new `<FilterChip>` toggle into both Section files. No DB migration, no detector change, no score change.

**Tech Stack:** TypeScript + React 19, Vitest + @testing-library/react, Tailwind CSS 4, `FilterChip` primitive at `src/components/ui/FilterChip.tsx`.

**Spec:** [docs/superpowers/specs/2026-05-18-net-flow-chip-and-filter-design.md](../specs/2026-05-18-net-flow-chip-and-filter-design.md)

---

## Task 0: Backfill historical `cum_ncp_at_fire` / `cum_npp_at_fire`

Operational task — runs an existing script. Independent of all UI work; can run in parallel.

**Files:**
- Run: `scripts/backfill-ticker-flow-at-fire.mjs` (already exists, no edits needed)

- [ ] **Step 1: Estimate scope with a dry run**

Run:

```bash
DATABASE_URL="$DATABASE_URL" node scripts/backfill-ticker-flow-at-fire.mjs --dry-run
```

Expected output: a summary block reporting `Groups processed`, `Lottery rows updated (dry-run)`, `Silent boom rows updated (dry-run)`, `Left NULL (no series)`, `Left NULL (pre-series)`. Save the output for the commit message.

- [ ] **Step 2: Spot-check one ticker-day**

Pick a recent MSFT trading day and dry-run only that group:

```bash
DATABASE_URL="$DATABASE_URL" node scripts/backfill-ticker-flow-at-fire.mjs --dry-run --ticker MSFT --date 2026-05-15
```

Expected output: one group processed, a small `rows updated (dry-run)` count, no errors. Manually verify against UW: open Periscope for MSFT on the same date and confirm the NCP-NPP delta at one of the listed alert times matches the script's lookup.

- [ ] **Step 3: Run the live backfill**

```bash
DATABASE_URL="$DATABASE_URL" node scripts/backfill-ticker-flow-at-fire.mjs
```

Expected output: same summary block as Step 1 but with non-dry-run row counts. The script is idempotent (`WHERE cum_ncp_at_fire IS NULL`) so re-running is safe.

- [ ] **Step 4: Verify with a post-state query**

```bash
DATABASE_URL="$DATABASE_URL" psql "$DATABASE_URL" -c "
SELECT 'silent_boom' AS tbl,
       COUNT(*) FILTER (WHERE cum_ncp_at_fire IS NULL) AS null_count,
       COUNT(*) AS total
FROM silent_boom_alerts
UNION ALL
SELECT 'lottery',
       COUNT(*) FILTER (WHERE cum_ncp_at_fire IS NULL),
       COUNT(*)
FROM lottery_finder_fires;
"
```

Expected: residual `null_count` matches the script's "Left NULL (no series)" + "Left NULL (pre-series)" sum from Step 3. Save these numbers — they're the "outside-universe + pre-series" residual that will never be backfillable.

This task has no code commit. The script run produces only DB state changes.

---

## Task 1: Create shared `macro-badges.ts` utility

Extracts the duplicated `tideBadge` from both row files into one module and adds the new `flowBadge` + `deltaFromAtFire` helpers.

**Files:**
- Create: `src/utils/macro-badges.ts`
- Create: `src/__tests__/utils/macro-badges.test.ts`
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx` (remove local `tideBadge`, import from new utility)
- Modify: `src/components/LotteryFinder/LotteryRow.tsx` (same)

- [ ] **Step 1: Write the failing test file**

Create `src/__tests__/utils/macro-badges.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  deltaFromAtFire,
  flowBadge,
  tideBadge,
} from '../../utils/macro-badges.js';

describe('deltaFromAtFire', () => {
  it('returns NCP - NPP when both are finite', () => {
    expect(deltaFromAtFire(5_000_000, 2_000_000)).toBe(3_000_000);
    expect(deltaFromAtFire(1_000_000, 4_000_000)).toBe(-3_000_000);
  });

  it('returns 0 for equal values', () => {
    expect(deltaFromAtFire(1_000_000, 1_000_000)).toBe(0);
  });

  it('returns null when either input is null/undefined', () => {
    expect(deltaFromAtFire(null, 1_000_000)).toBeNull();
    expect(deltaFromAtFire(1_000_000, null)).toBeNull();
    expect(deltaFromAtFire(null, null)).toBeNull();
    expect(deltaFromAtFire(undefined, 1_000_000)).toBeNull();
  });

  it('returns null when either input is NaN or Infinity', () => {
    expect(deltaFromAtFire(Number.NaN, 1_000_000)).toBeNull();
    expect(deltaFromAtFire(1_000_000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('tideBadge', () => {
  it('returns null when diff is null', () => {
    expect(tideBadge(null)).toBeNull();
  });

  it('returns up arrow + green for positive diff', () => {
    const v = tideBadge(1_000_000);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide ⬆');
    expect(v!.cls).toContain('green');
  });

  it('returns down arrow + red for negative diff', () => {
    const v = tideBadge(-1_000_000);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide ⬇');
    expect(v!.cls).toContain('red');
  });

  it('returns neutral arrow for zero', () => {
    const v = tideBadge(0);
    expect(v).not.toBeNull();
    expect(v!.label).toBe('Tide →');
    expect(v!.cls).toContain('neutral');
  });

  it('tooltip mentions fire-time market tide source', () => {
    const v = tideBadge(1_000_000);
    expect(v!.tooltip).toMatch(/market tide/i);
    expect(v!.tooltip).toMatch(/spike-bucket|fire/i);
  });
});

describe('flowBadge', () => {
  it('returns null when diff is null', () => {
    expect(flowBadge(null)).toBeNull();
  });

  it('returns Flow ⬆ + green for positive diff', () => {
    const v = flowBadge(2_000_000);
    expect(v!.label).toBe('Flow ⬆');
    expect(v!.cls).toContain('green');
  });

  it('returns Flow ⬇ + red for negative diff', () => {
    const v = flowBadge(-2_000_000);
    expect(v!.label).toBe('Flow ⬇');
    expect(v!.cls).toContain('red');
  });

  it('returns Flow → for zero', () => {
    const v = flowBadge(0);
    expect(v!.label).toBe('Flow →');
    expect(v!.cls).toContain('neutral');
  });

  it('tooltip mentions fire-time + sign-only + per-ticker', () => {
    const v = flowBadge(2_000_000);
    expect(v!.tooltip).toMatch(/fire time/i);
    expect(v!.tooltip).toMatch(/sign-only/i);
    expect(v!.tooltip).toMatch(/per-ticker|net flow/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/utils/macro-badges.test.ts
```

Expected: FAIL with `Cannot find module '../../utils/macro-badges.js'`.

- [ ] **Step 3: Create the utility module**

Create `src/utils/macro-badges.ts`:

```ts
/**
 * Macro context badges rendered next to each Silent Boom / Lottery
 * Finder row.
 *
 * - `tideBadge` — market-wide NCP − NPP at fire time (display-only;
 *   per lottery's spec Appendix A this is regime context, not a
 *   selection signal).
 * - `flowBadge` — per-ticker NCP − NPP at fire time. Distinct from
 *   the live `Flow Match` badge: this chip is FROZEN at the fire
 *   moment, while `Flow Match` drifts intraday with the live tape.
 *
 * Both badges share an identical structural contract (positive ⇒
 * green, negative ⇒ red, zero ⇒ neutral, null ⇒ hidden) so the row
 * JSX can render them with the same template.
 */

export interface MacroBadgeView {
  label: string;
  cls: string;
  tooltip: string;
}

const GREEN_CLS = 'border-green-500/40 bg-green-950/30 text-green-200';
const RED_CLS = 'border-red-500/40 bg-red-950/30 text-red-200';
const NEUTRAL_CLS = 'border-neutral-700 bg-neutral-900 text-neutral-300';

function arrowFor(diff: number): string {
  if (diff > 0) return '⬆';
  if (diff < 0) return '⬇';
  return '→';
}

function classFor(diff: number): string {
  if (diff > 0) return GREEN_CLS;
  if (diff < 0) return RED_CLS;
  return NEUTRAL_CLS;
}

export function tideBadge(diff: number | null): MacroBadgeView | null {
  if (diff == null) return null;
  return {
    label: `Tide ${arrowFor(diff)}`,
    cls: classFor(diff),
    tooltip: `Market Tide NCP − NPP at the spike-bucket / fire time = ${diff.toFixed(0)}. Display-only macro context, not a selection signal.`,
  };
}

export function flowBadge(diff: number | null): MacroBadgeView | null {
  if (diff == null) return null;
  return {
    label: `Flow ${arrowFor(diff)}`,
    cls: classFor(diff),
    tooltip: `Per-ticker net flow at fire time: NCP − NPP = ${diff.toFixed(0)}. Sign-only direction; used by the hide counter-flow filter. Distinct from the live Flow Match badge.`,
  };
}

/**
 * Safe NCP − NPP subtraction. Returns null whenever either input is
 * missing or non-finite so callers can render-hide the chip and the
 * counter-flow filter never accidentally drops a row whose snapshot
 * wasn't captured.
 */
export function deltaFromAtFire(
  ncp: number | null | undefined,
  npp: number | null | undefined,
): number | null {
  if (ncp == null || npp == null) return null;
  if (!Number.isFinite(ncp) || !Number.isFinite(npp)) return null;
  return ncp - npp;
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
npx vitest run src/__tests__/utils/macro-badges.test.ts
```

Expected: PASS — all describe blocks green.

- [ ] **Step 5: Replace local `tideBadge` in `SilentBoomRow.tsx`**

Open `src/components/SilentBoom/SilentBoomRow.tsx`. Around line 120-142, DELETE the local `tideBadge` function definition. Add this import at the top of the file (with the other `../../utils/*` imports):

```ts
import { tideBadge } from '../../utils/macro-badges.js';
```

- [ ] **Step 6: Replace local `tideBadge` in `LotteryRow.tsx`**

Open `src/components/LotteryFinder/LotteryRow.tsx`. Around line 296-312, DELETE the local `tideBadge` function definition. Add this import (with the other `../../utils/*` imports):

```ts
import { tideBadge } from '../../utils/macro-badges.js';
```

- [ ] **Step 7: Run the full lint + test pipeline**

```bash
npm run review
```

Expected: PASS. No new type errors, no new lint errors, no test regressions, no Prettier diffs.

- [ ] **Step 8: Commit**

```bash
git add src/utils/macro-badges.ts src/__tests__/utils/macro-badges.test.ts src/components/SilentBoom/SilentBoomRow.tsx src/components/LotteryFinder/LotteryRow.tsx
git commit -m "refactor(macro-badges): extract shared tideBadge + add flowBadge primitive"
```

---

## Task 2: Render per-row Flow chip on SilentBoomRow and LotteryRow

Adds the new `<span>` chip between the existing Tide chip and the existing Flow Match badge on each row.

**Files:**
- Modify: `src/components/SilentBoom/SilentBoomRow.tsx`
- Modify: `src/components/LotteryFinder/LotteryRow.tsx`
- Modify: `src/__tests__/SilentBoomRow.test.tsx`
- Modify: `src/__tests__/LotteryRow.test.tsx`

- [ ] **Step 1: Write the failing test for SilentBoomRow**

In `src/__tests__/SilentBoomRow.test.tsx`, append (or replace the existing macro-badges section if any):

```tsx
describe('Flow chip', () => {
  it('renders Flow ⬆ when ticker NCP > NPP at fire', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 2_000_000,
      }),
    );
    expect(screen.getByTestId('silent-boom-row-flow-chip')).toHaveTextContent(
      'Flow ⬆',
    );
  });

  it('renders Flow ⬇ when ticker NCP < NPP at fire', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 4_000_000,
      }),
    );
    expect(screen.getByTestId('silent-boom-row-flow-chip')).toHaveTextContent(
      'Flow ⬇',
    );
  });

  it('does not render Flow chip when either field is null', () => {
    renderRow(
      makeAlert({
        tickerCumNcpAtFire: null,
        tickerCumNppAtFire: 2_000_000,
      }),
    );
    expect(screen.queryByTestId('silent-boom-row-flow-chip')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/SilentBoomRow.test.tsx
```

Expected: FAIL — `Unable to find element by: [data-testid="silent-boom-row-flow-chip"]`.

- [ ] **Step 3: Add the Flow chip to `SilentBoomRow.tsx`**

In `src/components/SilentBoom/SilentBoomRow.tsx`:

1. Update the import line for macro-badges:

```ts
import { deltaFromAtFire, flowBadge, tideBadge } from '../../utils/macro-badges.js';
```

2. Find the existing `const tide = tideBadge(alert.mktTideDiff);` line in the component body. Add immediately after it:

```ts
const flow = flowBadge(
  deltaFromAtFire(alert.tickerCumNcpAtFire, alert.tickerCumNppAtFire),
);
```

3. Find the JSX where the Tide chip is rendered (look for `{tide && (` or similar — the existing Tide chip block). Insert directly after the closing tag of the Tide chip and before the Flow Match badge:

```tsx
{flow && (
  <span
    data-testid="silent-boom-row-flow-chip"
    className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flow.cls}`}
    title={flow.tooltip}
    aria-label={flow.tooltip}
  >
    {flow.label}
  </span>
)}
```

- [ ] **Step 4: Run the SilentBoomRow tests and verify they pass**

```bash
npx vitest run src/__tests__/SilentBoomRow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Write the failing test for LotteryRow**

In `src/__tests__/LotteryRow.test.tsx`, append:

```tsx
describe('Flow chip', () => {
  it('renders Flow ⬆ when ticker NCP > NPP at fire', () => {
    renderRow(
      makeFire({
        macro: {
          ...defaultMacro,
          tickerCumNcpAtFire: 5_000_000,
          tickerCumNppAtFire: 2_000_000,
        },
      }),
    );
    expect(screen.getByTestId('lottery-row-flow-chip')).toHaveTextContent(
      'Flow ⬆',
    );
  });

  it('renders Flow ⬇ when ticker NCP < NPP at fire', () => {
    renderRow(
      makeFire({
        macro: {
          ...defaultMacro,
          tickerCumNcpAtFire: 1_000_000,
          tickerCumNppAtFire: 4_000_000,
        },
      }),
    );
    expect(screen.getByTestId('lottery-row-flow-chip')).toHaveTextContent(
      'Flow ⬇',
    );
  });

  it('does not render Flow chip when either field is null', () => {
    renderRow(
      makeFire({
        macro: {
          ...defaultMacro,
          tickerCumNcpAtFire: null,
          tickerCumNppAtFire: 2_000_000,
        },
      }),
    );
    expect(screen.queryByTestId('lottery-row-flow-chip')).toBeNull();
  });
});
```

Note: the LotteryRow test file uses `makeFire` + `defaultMacro` patterns — read the top of the existing file to confirm the helper names (they may be `makeLotteryFire` or `buildFire`). Adjust accordingly.

- [ ] **Step 6: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/LotteryRow.test.tsx
```

Expected: FAIL.

- [ ] **Step 7: Add the Flow chip to `LotteryRow.tsx`**

In `src/components/LotteryFinder/LotteryRow.tsx`:

1. Update the imports for macro-badges:

```ts
import { deltaFromAtFire, flowBadge, tideBadge } from '../../utils/macro-badges.js';
```

2. Find the existing `const tide = tideBadge(fire.macro.mktTideDiff);` line and add immediately after:

```ts
const flow = flowBadge(
  deltaFromAtFire(fire.macro.tickerCumNcpAtFire, fire.macro.tickerCumNppAtFire),
);
```

3. Find the JSX block where the Tide chip is rendered. Insert directly after the Tide chip closing tag and before the Flow Match badge:

```tsx
{flow && (
  <span
    data-testid="lottery-row-flow-chip"
    className={`rounded border px-1.5 py-0.5 text-[10px] leading-none font-semibold ${flow.cls}`}
    title={flow.tooltip}
    aria-label={flow.tooltip}
  >
    {flow.label}
  </span>
)}
```

- [ ] **Step 8: Run the LotteryRow tests and verify they pass**

```bash
npx vitest run src/__tests__/LotteryRow.test.tsx
```

Expected: PASS.

- [ ] **Step 9: Run the full review**

```bash
npm run review
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components/SilentBoom/SilentBoomRow.tsx src/components/LotteryFinder/LotteryRow.tsx src/__tests__/SilentBoomRow.test.tsx src/__tests__/LotteryRow.test.tsx
git commit -m "feat(silent-boom,lottery): render per-row Flow chip from fire-time NCP/NPP"
```

---

## Task 3: Extend `ticker-rollup-aggregates.ts` with `flow` aggregation

Add `tickerNetFlowAtFire` to `RollupAlertSummary`, refactor `computeTide` into a generic `computeDirAlignment`, and add `computeFlow` + `formatFlowLabel`.

**Files:**
- Modify: `src/utils/ticker-rollup-aggregates.ts`
- Modify: `src/__tests__/utils/ticker-rollup-aggregates.test.ts` (or wherever the existing tests live — check `src/__tests__/`)

- [ ] **Step 1: Locate the existing test file**

```bash
find src/__tests__ -name "ticker-rollup-aggregates*" -o -name "rollup*"
```

Use the path found here in subsequent steps. If no test file exists yet, create one at `src/__tests__/utils/ticker-rollup-aggregates.test.ts`.

- [ ] **Step 2: Write the failing tests for `computeFlow` + `formatFlowLabel`**

Append to the test file:

```ts
import {
  computeRollupAggregates,
  formatFlowLabel,
} from '../../utils/ticker-rollup-aggregates.js';
import type { RollupAlertSummary } from '../../utils/ticker-rollup-aggregates.js';

function summary(
  override: Partial<RollupAlertSummary> = {},
): RollupAlertSummary {
  return {
    optionType: 'C',
    mktTideDiff: null,
    directionGated: false,
    triggeredAt: '2026-05-15T13:30:00.000Z',
    strike: 100,
    tickerNetFlowAtFire: null,
    ...override,
  };
}

describe('computeRollupAggregates — flow aggregation', () => {
  it('returns flow: aligned when bull bias and all flows positive', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'C', tickerNetFlowAtFire: 5_000_000 }),
      summary({ optionType: 'C', tickerNetFlowAtFire: 3_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'up', align: 'aligned' });
  });

  it('returns flow: aligned when bear bias and all flows negative', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'P', tickerNetFlowAtFire: -5_000_000 }),
      summary({ optionType: 'P', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'down', align: 'aligned' });
  });

  it('returns flow: counter when bull bias but flows negative', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'C', tickerNetFlowAtFire: -1_000_000 }),
      summary({ optionType: 'C', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow).toEqual({ dir: 'down', align: 'counter' });
  });

  it('returns flow: mixed when group has both call and put alerts', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'C', tickerNetFlowAtFire: 1_000_000 }),
      summary({ optionType: 'P', tickerNetFlowAtFire: 1_000_000 }),
    ]);
    expect(agg.flow.dir).toBe('mixed');
    expect(agg.flow.align).toBe('mixed');
  });

  it('returns flow: mixed when single-bias group has split flow signs', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'C', tickerNetFlowAtFire: 3_000_000 }),
      summary({ optionType: 'C', tickerNetFlowAtFire: -2_000_000 }),
    ]);
    expect(agg.flow.dir).toBe('mixed');
  });

  it('returns flow: unknown when every row has null tickerNetFlowAtFire', () => {
    const agg = computeRollupAggregates([
      summary({ optionType: 'C', tickerNetFlowAtFire: null }),
      summary({ optionType: 'C', tickerNetFlowAtFire: null }),
    ]);
    expect(agg.flow).toEqual({ dir: 'unknown', align: 'unknown' });
  });
});

describe('formatFlowLabel', () => {
  it('renders "flow ↑ aligned"', () => {
    expect(formatFlowLabel({ dir: 'up', align: 'aligned' })).toBe(
      'flow ↑ aligned',
    );
  });

  it('renders "flow ↓ counter"', () => {
    expect(formatFlowLabel({ dir: 'down', align: 'counter' })).toBe(
      'flow ↓ counter',
    );
  });

  it('renders "flow mixed"', () => {
    expect(formatFlowLabel({ dir: 'mixed', align: 'mixed' })).toBe('flow mixed');
  });

  it('renders "flow —" for unknown', () => {
    expect(formatFlowLabel({ dir: 'unknown', align: 'unknown' })).toBe('flow —');
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/utils/ticker-rollup-aggregates.test.ts
```

Expected: FAIL — `formatFlowLabel is not exported` and/or `agg.flow is undefined`.

- [ ] **Step 4: Refactor `computeTide` + add `computeFlow` + `formatFlowLabel` in `ticker-rollup-aggregates.ts`**

In `src/utils/ticker-rollup-aggregates.ts`:

1. Add `tickerNetFlowAtFire` to `RollupAlertSummary`:

```ts
export interface RollupAlertSummary {
  // ...existing fields unchanged...

  /**
   * Per-ticker cumulative NCP − NPP at trigger time. Null when the
   * feed lacks the fire-time snapshot (pre-#158 rows or outside-WS-
   * universe tickers). Sign-only — no deadband.
   */
  tickerNetFlowAtFire: number | null;
}
```

2. Add `flow: TideAggregate` to `RollupAggregates`:

```ts
export interface RollupAggregates {
  // ...existing fields unchanged...

  /** Per-ticker net flow direction aggregation. Same shape as `tide`. */
  flow: TideAggregate;
}
```

3. Replace the existing `computeTide` function with a generic `computeDirAlignment` + two thin wrappers:

```ts
function computeDirAlignment(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
  selector: (r: RollupAlertSummary) => number | null,
): TideAggregate {
  let pos = 0;
  let neg = 0;
  let nonNull = 0;
  for (const r of rows) {
    const v = selector(r);
    if (v == null) continue;
    nonNull += 1;
    if (v > 0) pos += 1;
    else if (v < 0) neg += 1;
  }
  if (nonNull === 0) return { dir: 'unknown', align: 'unknown' };

  let dir: 'up' | 'down' | 'mixed';
  if (pos > 0 && neg === 0) dir = 'up';
  else if (neg > 0 && pos === 0) dir = 'down';
  else dir = 'mixed';

  if (dir === 'mixed' || bias === 'mixed') {
    return { dir: 'mixed', align: 'mixed' };
  }
  const aligned =
    (bias === 'bull' && dir === 'up') || (bias === 'bear' && dir === 'down');
  return { dir, align: aligned ? 'aligned' : 'counter' };
}

function computeTide(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
): TideAggregate {
  return computeDirAlignment(rows, bias, (r) => r.mktTideDiff);
}

function computeFlow(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
): TideAggregate {
  return computeDirAlignment(rows, bias, (r) => r.tickerNetFlowAtFire);
}
```

4. Update `computeRollupAggregates` to populate the new `flow` field. Inside the function body (after `const tide = computeTide(rows, bias);`):

```ts
const flow = computeFlow(rows, bias);
```

And update the returned object to include `flow,` alongside `tide,`. Update the empty-rows guard at the top to also return `flow: { dir: 'unknown', align: 'unknown' }`.

5. Add `formatFlowLabel` after `formatTideLabel`:

```ts
/** Render flow chip text. Mirror of `formatTideLabel`. */
export function formatFlowLabel(flow: TideAggregate): string {
  if (flow.dir === 'unknown') return 'flow —';
  if (flow.dir === 'mixed') return 'flow mixed';
  const arrow = flow.dir === 'up' ? '↑' : '↓';
  return `flow ${arrow} ${flow.align}`;
}
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
npx vitest run src/__tests__/utils/ticker-rollup-aggregates.test.ts
```

Expected: PASS — flow describe block plus all existing tide tests still green.

- [ ] **Step 6: Run the full review**

```bash
npm run review
```

Expected: PASS. The `RollupAlertSummary` shape changed, so consumers will get type errors here — that's fine because Task 4 fixes them. **However**, type errors block `npm run review`. Resolution: either commit this task with `// @ts-expect-error` notes on the four consumer sites and let Task 4 remove them, OR include the consumer updates from Task 4 here.

Cleaner: include the consumer-update half of Task 4 in this commit. See Step 7 below.

- [ ] **Step 7: Add `tickerNetFlowAtFire: null` to all 4 consumer mapping sites (temporary)**

So Task 3 commits cleanly without type errors, drop a literal `null` into each `RollupAlertSummary` payload mapping (Task 4 replaces these with the real value):

- `src/components/SilentBoom/SilentBoomTickerGroup.tsx` (line ~141 `RollupAlertSummary` payload): add `tickerNetFlowAtFire: null,`
- `src/components/SilentBoom/SilentBoomSection.tsx` (line ~795 inside `groupedByTicker` `useMemo`): same
- `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx` (line ~167): same
- `src/components/LotteryFinder/LotteryFinderSection.tsx` (line ~689): same

Re-run:

```bash
npm run review
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/utils/ticker-rollup-aggregates.ts src/__tests__/utils/ticker-rollup-aggregates.test.ts src/components/SilentBoom/SilentBoomTickerGroup.tsx src/components/SilentBoom/SilentBoomSection.tsx src/components/LotteryFinder/LotteryFinderTickerGroup.tsx src/components/LotteryFinder/LotteryFinderSection.tsx
git commit -m "refactor(rollup): generalize computeTide → computeDirAlignment + add computeFlow"
```

---

## Task 4: Render rollup flow chip in both TickerGroup components + rename `tideChipClass`

Wires the new `agg.flow` from Task 3 into the visible group-header chip. Also renames the local `tideChipClass` helper to `alignChipClass` in both ticker-group files for naming clarity.

**Files:**
- Modify: `src/components/SilentBoom/SilentBoomTickerGroup.tsx`
- Modify: `src/components/SilentBoom/SilentBoomSection.tsx`
- Modify: `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`
- Modify: `src/components/LotteryFinder/LotteryFinderSection.tsx`
- Modify: corresponding test files

- [ ] **Step 1: Locate the existing ticker-group test files**

```bash
find src/__tests__ -name "SilentBoomTickerGroup*" -o -name "LotteryFinderTickerGroup*"
```

If they don't exist yet, create them. The existing `src/__tests__/SilentBoomRow.test.tsx` and `src/__tests__/LotteryRow.test.tsx` show the rendering pattern for nearby components.

- [ ] **Step 2: Write the failing rollup test for SilentBoomTickerGroup**

Append (or create) `src/__tests__/SilentBoomTickerGroup.test.tsx` with:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SilentBoomTickerGroup } from '../components/SilentBoom/SilentBoomTickerGroup';
// (import test helpers as you would for SilentBoomRow tests — reuse the same
//  makeAlert factory + render helper if available, or build minimal ones here)

describe('SilentBoomTickerGroup — flow rollup chip', () => {
  it('renders "flow ↑ aligned" when bull bias and all positive ticker flow', () => {
    const alerts = [
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
      }),
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 3_000_000,
        tickerCumNppAtFire: 2_000_000,
      }),
    ];
    renderGroup({ ticker: 'MSFT', alerts });
    expect(screen.getByTestId('silent-boom-ticker-flow-MSFT')).toHaveTextContent(
      'flow ↑ aligned',
    );
  });

  it('renders "flow ↓ counter" when bull bias but ticker flow negative', () => {
    const alerts = [
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 5_000_000,
      }),
    ];
    renderGroup({ ticker: 'MSFT', alerts });
    expect(screen.getByTestId('silent-boom-ticker-flow-MSFT')).toHaveTextContent(
      'flow ↓ counter',
    );
  });

  it('renders "flow —" when no rows have a fire-time snapshot', () => {
    const alerts = [
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: null,
        tickerCumNppAtFire: null,
      }),
    ];
    renderGroup({ ticker: 'MSFT', alerts });
    expect(screen.getByTestId('silent-boom-ticker-flow-MSFT')).toHaveTextContent(
      'flow —',
    );
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/SilentBoomTickerGroup.test.tsx
```

Expected: FAIL — `Unable to find element by: [data-testid="silent-boom-ticker-flow-MSFT"]`.

- [ ] **Step 4: Update `SilentBoomTickerGroup.tsx` — rename + new chip + real `tickerNetFlowAtFire`**

In `src/components/SilentBoom/SilentBoomTickerGroup.tsx`:

1. Add `formatFlowLabel` + `deltaFromAtFire` to imports:

```ts
import {
  // ...existing imports preserved...
  formatFlowLabel,
} from '../../utils/ticker-rollup-aggregates.js';
import { deltaFromAtFire } from '../../utils/macro-badges.js';
```

2. Rename the local `tideChipClass` helper to `alignChipClass`:

```ts
function alignChipClass(align: TideAggregate['align']): string {
  if (align === 'aligned') return 'bg-emerald-950/40 text-emerald-400';
  if (align === 'counter') return 'bg-red-950/40 text-red-400';
  if (align === 'unknown') return 'bg-neutral-900 text-neutral-500';
  return 'bg-neutral-800 text-neutral-300';
}
```

Update its one existing call site for the tide chip from `tideChipClass(agg.tide.align)` → `alignChipClass(agg.tide.align)`.

3. Replace the placeholder `tickerNetFlowAtFire: null` (added in Task 3) with the real value:

```ts
tickerNetFlowAtFire: deltaFromAtFire(
  a.tickerCumNcpAtFire,
  a.tickerCumNppAtFire,
),
```

4. Add the rendered flow chip JSX. Find the existing tide chip `<span>` block. Insert immediately after the closing `</span>` of the tide chip:

```tsx
<span
  className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${alignChipClass(agg.flow.align)}`}
  title="Does per-ticker net flow (cumNcpAtFire − cumNppAtFire) direction agree with this ticker's bias? aligned = same direction; counter = opposite (tape fighting the bet); mixed = inconsistent across alerts; unknown = no fire-time snapshot."
  data-testid={`silent-boom-ticker-flow-${ticker}`}
>
  {formatFlowLabel(agg.flow)}
</span>
```

- [ ] **Step 5: Run the test and verify it passes**

```bash
npx vitest run src/__tests__/SilentBoomTickerGroup.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Update `SilentBoomSection.tsx`'s grouping memo**

In `src/components/SilentBoom/SilentBoomSection.tsx` at the `RollupAlertSummary` payload inside the `groupedByTicker` `useMemo` (line ~795 currently), replace the placeholder `tickerNetFlowAtFire: null` with the real value:

```ts
tickerNetFlowAtFire: deltaFromAtFire(
  a.tickerCumNcpAtFire,
  a.tickerCumNppAtFire,
),
```

Add to top-of-file imports if not already present:

```ts
import { deltaFromAtFire } from '../../utils/macro-badges.js';
```

- [ ] **Step 7: Repeat Steps 2–4 for LotteryFinderTickerGroup**

Symmetric changes in `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`:

1. Add `formatFlowLabel` to the `ticker-rollup-aggregates.js` imports + add `import { deltaFromAtFire } from '../../utils/macro-badges.js';`
2. Rename local `tideChipClass` → `alignChipClass` (identical body), update its one tide call site.
3. Replace placeholder `tickerNetFlowAtFire: null` with `tickerNetFlowAtFire: deltaFromAtFire(f.macro.tickerCumNcpAtFire, f.macro.tickerCumNppAtFire),`
4. Insert flow chip JSX after the tide chip block:

```tsx
<span
  className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ${alignChipClass(agg.flow.align)}`}
  title="Does per-ticker net flow (cumNcpAtFire − cumNppAtFire) direction agree with this ticker's bias? aligned = same direction; counter = opposite (tape fighting the bet); mixed = inconsistent across alerts; unknown = no fire-time snapshot."
  data-testid={`lottery-ticker-flow-${ticker}`}
>
  {formatFlowLabel(agg.flow)}
</span>
```

Write the symmetric test file `src/__tests__/LotteryFinderTickerGroup.test.tsx` using the `lottery-ticker-flow-${ticker}` testid; verify it fails before the impl change, then passes after.

- [ ] **Step 8: Update `LotteryFinderSection.tsx`'s grouping memo**

In `src/components/LotteryFinder/LotteryFinderSection.tsx` at the `RollupAlertSummary` payload inside the `groupedByTicker` `useMemo` (line ~689 currently), replace `tickerNetFlowAtFire: null` with:

```ts
tickerNetFlowAtFire: deltaFromAtFire(
  f.macro.tickerCumNcpAtFire,
  f.macro.tickerCumNppAtFire,
),
```

Add to imports if needed:

```ts
import { deltaFromAtFire } from '../../utils/macro-badges.js';
```

- [ ] **Step 9: Run the full review**

```bash
npm run review
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/components/SilentBoom/SilentBoomTickerGroup.tsx src/components/SilentBoom/SilentBoomSection.tsx src/components/LotteryFinder/LotteryFinderTickerGroup.tsx src/components/LotteryFinder/LotteryFinderSection.tsx src/__tests__/SilentBoomTickerGroup.test.tsx src/__tests__/LotteryFinderTickerGroup.test.tsx
git commit -m "feat(rollup): render flow chip + rename tideChipClass → alignChipClass"
```

---

## Task 5: Add `hide counter-flow` filter to SilentBoomSection

**Files:**
- Modify: `src/components/SilentBoom/SilentBoomSection.tsx`
- Modify: `src/__tests__/SilentBoomSection.test.tsx`

- [ ] **Step 1: Write the failing test for filter behavior**

In `src/__tests__/SilentBoomSection.test.tsx`, append:

```tsx
describe('hide-counter-flow filter', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('flips aria-pressed and persists to localStorage', () => {
    renderSection({ alerts: [] });
    const chip = screen.getByTestId('silent-boom-hide-counter-flow-chip');
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(window.localStorage.getItem('silentBoom.hideCounterFlow')).toBe('1');
  });

  it('drops call rows when ticker NCP < NPP at fire', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'MSFT',
        optionType: 'C',
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 5_000_000,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'MSFT|2026-05-15|100|C',
      }),
      makeAlert({
        underlyingSymbol: 'MSFT',
        optionType: 'C',
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
        bucketCt: '2026-05-15T14:30:00.000Z',
        optionChainId: 'MSFT|2026-05-15|105|C',
      }),
    ];
    renderSection({ alerts });
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    // Only the bullish-flow call survives.
    expect(screen.queryByText(/100C/)).toBeNull();
    expect(screen.getByText(/105C/)).toBeInTheDocument();
  });

  it('drops put rows when ticker NCP > NPP at fire', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'AAPL',
        optionType: 'P',
        tickerCumNcpAtFire: 5_000_000,
        tickerCumNppAtFire: 1_000_000,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'AAPL|2026-05-15|150|P',
      }),
    ];
    renderSection({ alerts });
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    expect(screen.queryByText(/150P/)).toBeNull();
  });

  it('NEVER drops rows with null fire-time snapshot', () => {
    const alerts = [
      makeAlert({
        underlyingSymbol: 'TLT',
        optionType: 'C',
        tickerCumNcpAtFire: null,
        tickerCumNppAtFire: null,
        bucketCt: '2026-05-15T13:30:00.000Z',
        optionChainId: 'TLT|2026-05-15|95|C',
      }),
    ];
    renderSection({ alerts });
    fireEvent.click(screen.getByTestId('silent-boom-hide-counter-flow-chip'));
    expect(screen.getByText(/95C/)).toBeInTheDocument();
  });

  it('shows hidden-count suffix when filter active and rows hidden', () => {
    const alerts = [
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 1_000_000,
        tickerCumNppAtFire: 5_000_000,
      }),
      makeAlert({
        optionType: 'C',
        tickerCumNcpAtFire: 2_000_000,
        tickerCumNppAtFire: 5_000_000,
      }),
    ];
    renderSection({ alerts });
    const chip = screen.getByTestId('silent-boom-hide-counter-flow-chip');
    fireEvent.click(chip);
    expect(chip).toHaveTextContent('−2');
  });
});
```

Adjust the `makeAlert` factory if it doesn't yet expose `tickerCumNcpAtFire` / `tickerCumNppAtFire` — open the file and add the fields to the default fixture.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/SilentBoomSection.test.tsx -t 'hide-counter-flow'
```

Expected: FAIL — chip not found.

- [ ] **Step 3: Add the state + persistence in `SilentBoomSection.tsx`**

In `src/components/SilentBoom/SilentBoomSection.tsx`, near the other `HIDE_*_LS_KEY` constants at the top of the file:

```ts
const HIDE_COUNTER_FLOW_LS_KEY = 'silentBoom.hideCounterFlow';
```

Near the existing `const [hideGated, setHideGated] = ...` block:

```ts
const [hideCounterFlow, setHideCounterFlow] = useState<boolean>(() => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(HIDE_COUNTER_FLOW_LS_KEY) === '1';
});

useEffect(() => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      HIDE_COUNTER_FLOW_LS_KEY,
      hideCounterFlow ? '1' : '0',
    );
  }
}, [hideCounterFlow]);
```

- [ ] **Step 4: Add the filter predicate to `displayedAlerts`**

Find the `displayedAlerts` `useMemo` (around line 681). After the existing `if (hideGated) { out = out.filter((a) => !a.directionGated); }` block, add:

```ts
if (hideCounterFlow) {
  out = out.filter((a) => {
    const ncp = a.tickerCumNcpAtFire;
    const npp = a.tickerCumNppAtFire;
    if (ncp == null || npp == null) return true;
    const delta = ncp - npp;
    if (delta === 0) return true;
    if (a.optionType === 'C') return delta > 0;
    return delta < 0;
  });
}
```

Add `hideCounterFlow` to the dependency array of the `useMemo`.

- [ ] **Step 5: Compute hidden-count for the chip suffix**

Near the existing `const hiddenGatedCount = ...` definition:

```ts
const hiddenCounterFlowCount =
  bucketIso == null && hideCounterFlow
    ? alerts.filter((a) => {
        const ncp = a.tickerCumNcpAtFire;
        const npp = a.tickerCumNppAtFire;
        if (ncp == null || npp == null) return false;
        const delta = ncp - npp;
        if (delta === 0) return false;
        return a.optionType === 'C' ? delta < 0 : delta > 0;
      }).length
    : 0;
```

- [ ] **Step 6: Render the FilterChip immediately after `hide counter-trend`**

Find the existing `<FilterChip ... testId="silent-boom-hide-gated-chip" ...>` block (around line 1354). Insert directly after its closing `</FilterChip>`:

```tsx
<FilterChip
  active={hideCounterFlow}
  activeColor="amber"
  testId="silent-boom-hide-counter-flow-chip"
  onClick={() => setHideCounterFlow(!hideCounterFlow)}
  title="Hide counter-flow alerts — rows where the per-ticker net flow (cumNcpAtFire − cumNppAtFire) at fire time contradicts the option type. Calls hidden when NCP < NPP; puts hidden when NCP > NPP. Rows with no fire-time snapshot are never hidden. Client-side filter — does not affect score or tier."
  ariaPressed={hideCounterFlow}
>
  hide counter-flow
  {hideCounterFlow && hiddenCounterFlowCount > 0 && (
    <span className="text-[10px] opacity-70">−{hiddenCounterFlowCount}</span>
  )}
</FilterChip>
```

- [ ] **Step 7: Run the test and verify it passes**

```bash
npx vitest run src/__tests__/SilentBoomSection.test.tsx -t 'hide-counter-flow'
```

Expected: PASS — all five describe cases green.

- [ ] **Step 8: Run the full review**

```bash
npm run review
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/SilentBoom/SilentBoomSection.tsx src/__tests__/SilentBoomSection.test.tsx
git commit -m "feat(silent-boom): add hide-counter-flow filter chip"
```

---

## Task 6: Add `hide counter-flow` filter to LotteryFinderSection

Symmetric to Task 5 on the lottery side. The lottery section's row shape uses `f.macro.tickerCumNcpAtFire` instead of `a.tickerCumNcpAtFire` — that's the only structural difference.

**Files:**
- Modify: `src/components/LotteryFinder/LotteryFinderSection.tsx`
- Modify: `src/__tests__/LotteryFinderSection.test.tsx`

- [ ] **Step 1: Write the failing tests**

Mirror Task 5 Step 1 in `src/__tests__/LotteryFinderSection.test.tsx`. The five cases are identical except:
- Test IDs: `lottery-hide-counter-flow-chip` instead of `silent-boom-...`
- localStorage key: `lottery.hideCounterFlow`
- Fixtures: use `makeFire` with `macro: { ...defaultMacro, tickerCumNcpAtFire, tickerCumNppAtFire }` instead of top-level fields

Reuse the existing `hide-counter-trend` test in this file as the structural template — it already exercises `aria-pressed` + localStorage for the parallel filter.

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run src/__tests__/LotteryFinderSection.test.tsx -t 'hide-counter-flow'
```

Expected: FAIL — chip not found.

- [ ] **Step 3: Add state + persistence in `LotteryFinderSection.tsx`**

Near the existing `HIDE_GATED_LS_KEY` constant (line 42):

```ts
const HIDE_COUNTER_FLOW_LS_KEY = 'lottery.hideCounterFlow';
```

Near the existing `const [hideGated, ...] = ...`:

```ts
const [hideCounterFlow, setHideCounterFlow] = useState<boolean>(() => {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(HIDE_COUNTER_FLOW_LS_KEY) === '1';
});

useEffect(() => {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(
      HIDE_COUNTER_FLOW_LS_KEY,
      hideCounterFlow ? '1' : '0',
    );
  }
}, [hideCounterFlow]);
```

- [ ] **Step 4: Add filter predicate to `displayedFires`**

Find the `displayedFires` `useMemo` (around line 570). After the existing `if (hideGated) { out = out.filter((f) => !f.directionGated); }`:

```ts
if (hideCounterFlow) {
  out = out.filter((f) => {
    const ncp = f.macro.tickerCumNcpAtFire;
    const npp = f.macro.tickerCumNppAtFire;
    if (ncp == null || npp == null) return true;
    const delta = ncp - npp;
    if (delta === 0) return true;
    if (f.optionType === 'C') return delta > 0;
    return delta < 0;
  });
}
```

Add `hideCounterFlow` to the dependency array.

- [ ] **Step 5: Compute hidden-count**

Near `const hiddenGatedCount = hideGated ? ...`:

```ts
const hiddenCounterFlowCount = hideCounterFlow
  ? fires.filter((f) => {
      const ncp = f.macro.tickerCumNcpAtFire;
      const npp = f.macro.tickerCumNppAtFire;
      if (ncp == null || npp == null) return false;
      const delta = ncp - npp;
      if (delta === 0) return false;
      return f.optionType === 'C' ? delta < 0 : delta > 0;
    }).length
  : 0;
```

- [ ] **Step 6: Render the FilterChip after `hide counter-trend`**

Find the `<FilterChip ... onClick={() => setHideGated(...)} ...>` block (around line 1205). Insert directly after its closing `</FilterChip>`:

```tsx
<FilterChip
  active={hideCounterFlow}
  activeColor="amber"
  testId="lottery-hide-counter-flow-chip"
  onClick={() => setHideCounterFlow(!hideCounterFlow)}
  title="Hide counter-flow alerts — rows where the per-ticker net flow (cumNcpAtFire − cumNppAtFire) at fire time contradicts the option type. Calls hidden when NCP < NPP; puts hidden when NCP > NPP. Rows with no fire-time snapshot are never hidden. Client-side filter — does not affect score or tier."
  ariaPressed={hideCounterFlow}
>
  hide counter-flow
  {hideCounterFlow && hiddenCounterFlowCount > 0 && (
    <span className="text-[10px] opacity-70">−{hiddenCounterFlowCount}</span>
  )}
</FilterChip>
```

- [ ] **Step 7: Run the test and verify it passes**

```bash
npx vitest run src/__tests__/LotteryFinderSection.test.tsx -t 'hide-counter-flow'
```

Expected: PASS.

- [ ] **Step 8: Run the full review**

```bash
npm run review
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/components/LotteryFinder/LotteryFinderSection.tsx src/__tests__/LotteryFinderSection.test.tsx
git commit -m "feat(lottery): add hide-counter-flow filter chip"
```

---

## Task 7: Final verification + smoke check

Confirms the full pipeline is green and does a visual smoke check on the running dev server.

- [ ] **Step 1: Final `npm run review`**

```bash
npm run review
```

Expected: PASS across tsc + eslint + prettier + vitest.

- [ ] **Step 2: Start the dev server**

```bash
npm run dev:full
```

Wait for the server to be ready (Vite output reports `Local: http://localhost:5173/`).

- [ ] **Step 3: Smoke-check the Silent Boom panel**

Open `http://localhost:5173/`, navigate to the Silent Boom section. Verify on at least one ticker group with multiple alerts:
1. Per-row `Flow ⬆` or `Flow ⬇` chip appears next to the existing `Tide` chip on rows where the ticker is in the WS universe.
2. Parent rollup `flow ↑ aligned` / `flow ↓ counter` / `flow mixed` chip appears next to the existing `tide …` chip.
3. The `hide counter-flow` filter chip is visible immediately after `hide counter-trend`. Clicking it toggles between active/inactive states; when active, hidden rows disappear and the chip shows a `−N` suffix.
4. After page reload, the `hide counter-flow` toggle state persists (localStorage check).

- [ ] **Step 4: Smoke-check the Lottery Finder panel**

Repeat Step 3 on the Lottery Finder section with the lottery test IDs.

- [ ] **Step 5: Verify outside-universe ticker fallback**

Find or scroll to an alert on a single-name ticker outside the WS universe (e.g. an obscure ETF or small-cap). Confirm:
1. No `Flow` chip renders on the row (chip is hidden because fire-time fields are null).
2. With `hide counter-flow` active, the row is NOT hidden (null-protection working).

- [ ] **Step 6: Stop the dev server**

```bash
# Ctrl-C in the dev server terminal
```

This task has no commit — it's verification only.

---

## Self-review checklist

Before declaring the plan complete, run through this:

- [ ] **Spec coverage:** Each spec phase (0–5) maps to at least one task. Backfill = Task 0. Phase 1 = Task 1. Phase 2 = Task 2. Phase 3 = Task 3. Phase 4 = Task 4. Phase 5 = Tasks 5 + 6.
- [ ] **Type consistency:** `tickerNetFlowAtFire` is the field name used in `RollupAlertSummary` (Task 3), in all four mapping sites (Tasks 3 + 4), and matches the spec. `deltaFromAtFire`, `flowBadge`, `tideBadge` signatures are consistent across Tasks 1, 2, 3, 4.
- [ ] **Test IDs locked:** `silent-boom-row-flow-chip`, `lottery-row-flow-chip`, `silent-boom-ticker-flow-${ticker}`, `lottery-ticker-flow-${ticker}`, `silent-boom-hide-counter-flow-chip`, `lottery-hide-counter-flow-chip`. No drift between tasks.
- [ ] **localStorage keys locked:** `silentBoom.hideCounterFlow` and `lottery.hideCounterFlow`.
- [ ] **No placeholders:** No "TBD", "implement later", "similar to Task N". Every step shows the actual code/command.
