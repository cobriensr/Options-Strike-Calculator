# Ticker-Rollup At-a-Glance Aggregates — 2026-05-15

## Goal

Add five aggregate chips to the collapsed ticker-group header in both Silent
Boom and Lottery Finder so a user can decide whether to expand a ticker
without reading individual rows. Layout is a single dense row.

## Aggregates

All five are derivable frontend-only from data already on each alert row —
no backend changes, no migrations.

| #   | Chip           | Source                                     | Display                                                                                  |
| --- | -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 1   | Direction bias | `optionType` over all rows                 | `↑ bull` (all call), `↓ bear` (all put), `~ mixed`                                       |
| 2   | Tide alignment | sign of `mktTideDiff` over all rows × bias | `tide ↑ aligned` / `tide ↓ aligned` / `tide ↑ counter` / `tide ↓ counter` / `tide mixed` |
| 6   | Time density   | `max - min` triggered timestamp            | `Δ 8min` when ≤60 min, else `Δ 2.5h`                                                     |
| 7   | Gated count    | `directionGated === true` count            | `1 gated` (omit chip when 0)                                                             |
| 8   | Strike spread  | `max - min` strike across distinct strikes | appended to existing strike list: `68C, 71C (3pt)`                                       |

### Bias

- All `optionType === 'call'` → `bull`
- All `optionType === 'put'` → `bear`
- Mix → `mixed`
- Empty group → `null` (don't render chip; should be unreachable since
  ticker groups exist only when ≥1 alert exists)

### Tide alignment

Use majority sign of non-null `mktTideDiff` values:

- All positive (or `count(pos) > count(neg)` and no nulls dominating) → tide ↑
- All negative → tide ↓
- Counts equal, or all null → mixed / unknown

Cross with bias:

- bull + tide↑ → `aligned` (green)
- bull + tide↓ → `counter` (red)
- bear + tide↑ → `counter` (red)
- bear + tide↓ → `aligned` (green)
- bias mixed OR tide mixed → `tide mixed` (gray, no aligned/counter qualifier)

If every row has `mktTideDiff === null` (rare — pre-Phase-4 backfill) the
chip renders `tide —` (muted) rather than disappearing, so users learn to
expect it.

### Time density

- `spreadMs = max(triggeredAt) - min(triggeredAt)`
- Single fire → omit chip (no spread to measure)
- Spread ≤ 60 min → `Δ Nmin` (rounded to nearest minute)
- Spread > 60 min → `Δ N.Nh` (1 decimal)

### Gated count

- Count rows where `directionGated === true`
- Render `N gated` only when N > 0; otherwise omit chip entirely (avoid
  noise in the clean-signal case)

### Strike spread

- Append `(Npt)` to the existing strike-list summary when ≥ 2 distinct
  strikes appear: `68C, 71C (3pt)` instead of `68C, 71C`
- Spread is computed over distinct strikes (a 68C and a 68P count once
  at 68; reasoning: the chain anchor matters more than side for "how
  concentrated is the flow on this ticker")
- Single distinct strike → no `(Npt)` suffix

## Why these five and not the others

User explicitly picked 1, 2, 6, 7, 8 from the brainstorm. Skipped:

- **Active / closed split (#3)** and **Hit rate (#4)** — would require
  reading outcome enrichment; user wants a fast, derivable-from-input win
  first
- **Total premium (#5)** — wasn't picked; nice-to-have but not load-bearing
  for the "should I expand?" decision

## File plan

### Phase 1 — Shared util

- `src/utils/ticker-rollup-aggregates.ts` — pure functions over a
  normalized `RollupAlertSummary` input shape
- `src/__tests__/utils/ticker-rollup-aggregates.test.ts` — unit tests

### Phase 2 — Silent Boom integration

- `src/components/SilentBoom/SilentBoomTickerGroup.tsx` — map
  `SilentBoomAlert[]` to `RollupAlertSummary[]`, render new chips
- `src/__tests__/SilentBoomTickerGroup.test.tsx` — extend existing tests

### Phase 3 — Lottery Finder integration

- `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx` — map
  `LotteryFire[]` (note: `macro.mktTideDiff`, `triggerTimeCt`) to
  `RollupAlertSummary[]`, render new chips
- `src/__tests__/LotteryFinderTickerGroup.test.tsx` — extend existing tests

## Normalized input shape

```ts
interface RollupAlertSummary {
  optionType: 'call' | 'put';
  mktTideDiff: number | null;
  directionGated: boolean;
  triggeredAt: string; // ISO; bucketCt for SB, triggerTimeCt for LF
  strike: number;
}

interface RollupAggregates {
  bias: 'bull' | 'bear' | 'mixed' | null;
  tide:
    | { dir: 'up' | 'down'; align: 'aligned' | 'counter' }
    | { dir: 'mixed'; align: 'mixed' }
    | { dir: 'unknown'; align: 'unknown' };
  spreadMinutes: number | null; // null when count < 2
  gatedCount: number;
  strikeRange: { min: number; max: number; spreadPts: number } | null;
}
```

## Visual reference

Before:

```
▾ OKLO  2 alerts  68C, 71C                  last 09:59 CT  best peak +88.5%
```

After:

```
▾ OKLO  2 alerts  68C, 71C (3pt)  [↑ bull]  [tide ↑ aligned]  [Δ 7min]    last 09:59 CT  best +88.5%
```

(The `1 gated` chip is conditional and omitted when zero, which is the
common case.)

## Open questions

- **Order of chips**: bias first (most decisive), then tide (next most
  decisive), then time-density (context), then gated (alarm bell when
  present). Strike spread is part of the existing strike-list element.
  Will lock this order unless user objects.
- **Color**: tide aligned chip uses theme green (`text-green-400 bg-green-950/40`);
  counter uses red; mixed uses neutral. Bias chip uses bullish green for
  call, bearish red for put, neutral gray for mixed. Time-density and gated
  use neutral chip styling.

## Thresholds / constants

| Value                                           | Reason                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Single-fire skip on `Δ` chip                    | A 1-row group has no spread to measure                                      |
| 60-min boundary for min vs. h display           | "8min" reads instantly; "0.13h" doesn't                                     |
| Tide chip uses majority-sign on non-null values | Defensible default; `mktTideDiff = 0` exact is treated as mixed-contributor |

## Verification plan

Per project Get-It-Right loop:

1. Phase 1: implement util → `npm run review` → code-reviewer subagent → commit + push
2. Phase 2: integrate SB → review → commit + push
3. Phase 3: integrate LF → review → commit + push

Test coverage targets:

- Util: bias (3 cases) × tide (5 cases) × time-density (2 ranges) ×
  gated (0 vs N>0) × strike-spread (1 strike vs N>1)
- Each TickerGroup: chip presence + correct label given a hand-crafted
  alerts fixture
