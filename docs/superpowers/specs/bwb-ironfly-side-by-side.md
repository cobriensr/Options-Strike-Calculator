# BWB vs Iron Fly Side-by-Side Comparison

## Goal

Show BWB and Iron Fly calculations simultaneously so the user can compare credit received, profit range, and risk/reward without switching between strategies — critical for fast decision-making in the last 20 minutes of the trading day.

## Design

**Shared inputs (top):** Sweet spot, wing widths, gamma anchor, strikes, contracts, calls/puts toggle (BWB only).

**Dual fill prices:** Two fill price inputs side by side — one for BWB, one for Iron Fly — each with its own credit/debit toggle. Either or both can be filled independently.

**Side-by-side results (bottom):** Two columns (stacked on mobile). Each column shows trade summary, key metrics, and P&L table for its strategy. Renders when that strategy's fill price is valid.

## Phases

### Phase 1: Restructure `BWBCalculator/index.tsx`

- Remove `strategy` state and strategy toggle buttons from header
- Add dual fill price state: `bwbNetInput`, `bwbIsCredit`, `ifNetInput`, `ifIsCredit`
- Always compute BWB metrics (when strikes + BWB fill valid)
- Always compute Iron Fly metrics (when strikes + IF fill valid)
- New render: shared inputs → dual fill prices → side-by-side results grid

### Phase 2: Update `BWBCalculator/BWBInputs.tsx`

- Remove fill price section (moves to parent)
- Remove `netInput`, `setNetInput`, `isCredit`, `setIsCredit` props
- Use strategy-neutral strike labels: "lower wing", "center", "upper wing"

### Phase 3: Adapt `BWBCalculator/BWBResults.tsx`

- Already handles both strategies via `strategy` prop
- Parent renders two instances in a `grid-cols-1 lg:grid-cols-2` grid
- Add column header (strategy name) to each instance
- Minor text size tweaks for half-width readability

## Files

- `src/components/BWBCalculator/index.tsx` — major restructure
- `src/components/BWBCalculator/BWBInputs.tsx` — remove fill price section
- `src/components/BWBCalculator/BWBResults.tsx` — column header + minor tweaks
- `src/components/BWBCalculator/bwb-math.ts` — no changes needed
