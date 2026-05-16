# Lottery Finder + Silent Boom: ITM/OTM Toggle and Aggressive Premium Parity — 2026-05-15

## Goal

Bring filter parity between Silent Boom (SB) and Lottery Finder (LF) by porting
the `💎 aggressive premium` chip into LF (with a lottery-native predicate), and
add a new tri-state `All / OTM / ITM` moneyness chip group to BOTH sections so
the user can scope alerts to in-the-money or out-of-the-money contracts at a
glance.

## Phases

1. **SB API passthrough** — expose `underlying_price_at_spike` in the
   `/api/silent-boom-feed` JSON response and on `SilentBoomAlert`. No filter
   logic change; the column is already read by the OTM gate for aggressive
   premium. ~1 file, ~5 LOC server, ~5 LOC types.
2. **SB client OTM/ITM** — add a tri-state chip group (`All` / `OTM` / `ITM`)
   to `SilentBoomSection.tsx`, persisted to localStorage. Client-side
   `useMemo` filter on the new `underlyingPriceAtSpike` field. Default `All`.
   Rows missing spot snapshot fall through under `All` and are hidden under
   either `OTM` or `ITM`.
3. **LF client parity** — three sub-tasks on `LotteryFinderSection.tsx`:
   - **Aggressive premium chip**: `💎 aggressive premium`, sky color when
     active, predicate below.
   - **Counter-trend harmonization**: confirm the existing `hide counter-trend`
     chip matches SB's label, position next to other "hide \*" chips, neutral
     color when inactive. Adjust only if drifted.
   - **OTM/ITM toggle**: same tri-state chip group as Phase 2, predicate uses
     `entry.spotAtFirst` (no server change needed).
4. **Tests** — extend the existing section tests for both components:
   - New aggressive-premium predicate on LF (matches and misses)
   - Tri-state OTM/ITM filter on both (All shows everything; OTM-only excludes
     ITM rows; ITM-only excludes OTM rows; rows w/ no spot fall through under
     All but hide under OTM/ITM for SB)
5. **Verify + ship** — `npm run review`, code-reviewer subagent, commit + push.

## Files to create/modify

| File                                                                                 | Phase | Why                                                               |
| ------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------- |
| `api/silent-boom-feed.ts`                                                            | 1     | Add `underlying_price_at_spike` to SELECTs and JSON response      |
| `api/__tests__/silent-boom-feed.test.ts` (or analogue)                               | 1     | Smoke-test the new field is in the payload                        |
| `src/components/SilentBoom/types.ts`                                                 | 1     | Add `underlyingPriceAtSpike: number \| null` to `SilentBoomAlert` |
| `src/components/SilentBoom/SilentBoomSection.tsx`                                    | 2     | Tri-state OTM/ITM chip + filter useMemo                           |
| `src/components/LotteryFinder/LotteryFinderSection.tsx`                              | 3     | Aggressive-premium chip, harmonized counter-trend, OTM/ITM chip   |
| `src/components/SilentBoom/__tests__/SilentBoomSection.test.tsx` (or analogue)       | 4     | OTM/ITM filter                                                    |
| `src/components/LotteryFinder/__tests__/LotteryFinderSection.test.tsx` (or analogue) | 4     | Aggressive-premium + OTM/ITM filter                               |

## Predicates

**Aggressive premium (LF, client-side):**

```ts
const estimatedPremium =
  fire.entry.price * fire.trigger.volToOiWindow * fire.entry.openInterest * 100;
const isOtm =
  fire.optionType === 'C'
    ? fire.strike > fire.entry.spotAtFirst
    : fire.strike < fire.entry.spotAtFirst;
const isAggressive =
  estimatedPremium >= 50_000 &&
  fire.dte <= 3 &&
  (fire.scoreTier === 'tier1' || fire.scoreTier === 'tier2') &&
  isOtm;
```

**Why $50K, not SB's $100K:** LF universe (~50 mostly mega-cap tickers) trades
cheaper contracts on average than SPX/SPXW. Pegging at $100K would near-empty
the chip. $50K stays selective without becoming useless.

**Why drop "single-leg" gate:** `multi_leg_share` is not in the LF payload.
Score tier already handles conviction filtering.

**Why `volToOiWindow × openInterest` not `windowPrints`:** `windowPrints` is
print event count (5-20), not contract volume. The product
`volToOiWindow × openInterest` reconstructs in-window contract volume per the
trigger spec.

**OTM/ITM (SB, client-side):**

```ts
const spot = alert.underlyingPriceAtSpike;
if (spot == null) return moneynessMode === 'all';
const isOtm =
  alert.optionType === 'C' ? alert.strike > spot : alert.strike < spot;
if (moneynessMode === 'otm') return isOtm;
if (moneynessMode === 'itm') return !isOtm;
return true;
```

**OTM/ITM (LF, client-side):**

```ts
const spot = fire.entry.spotAtFirst;
const isOtm = fire.optionType === 'C' ? fire.strike > spot : fire.strike < spot;
if (moneynessMode === 'otm') return isOtm;
if (moneynessMode === 'itm') return !isOtm;
return true;
```

LF always has `spotAtFirst` populated, so no null-fallthrough branch needed.

## UI

Chip group rendered next to existing TOD / option-type chips. Tri-state pattern
matches the existing `mode` chip in LF (`A` / `B` / `all`):

```
[ all ]  [ OTM ]  [ ITM ]   <- pick one, default 'all', persisted
```

When `OTM` is active, color = `CHIP_ACTIVE.emerald`. When `ITM` is active,
color = `CHIP_ACTIVE.amber`. When `all` is active, no chip is highlighted
(neutral). State key: `localStorage['silentboom.moneynessMode']` and
`localStorage['lottery.moneynessMode']`, values `'all' | 'otm' | 'itm'`.

## Open questions

- None blocking. Threshold and color choices are defaults — easy to tune
  post-ship if the chip lands wrong.

## Constants

| Constant                    | Value                            | Where                                                     |
| --------------------------- | -------------------------------- | --------------------------------------------------------- |
| `LF_AGGRESSIVE_PREMIUM_USD` | 50_000                           | LotteryFinderSection.tsx (local const, no need to export) |
| `LF_AGGRESSIVE_MAX_DTE`     | 3                                | same                                                      |
| `LF_AGGRESSIVE_TIERS`       | `['tier1', 'tier2']`             | same                                                      |
| `MONEYNESS_MODES`           | `['all', 'otm', 'itm'] as const` | shared local type                                         |

## Out of scope

- Server-side OTM filtering as a query param (deferred — would be a bigger
  change; the client filter is sufficient for current visible-row counts).
- Backfilling `underlying_price_at_spike` on pre-#152 SB rows (existing
  behavior: those rows fall through `All` and hide under OTM/ITM).
- Cross-section unification of the chip group as a shared component
  (premature abstraction; the two inlined chip groups are <30 LOC each).
