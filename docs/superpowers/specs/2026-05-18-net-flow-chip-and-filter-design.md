---
status: Draft
date: 2026-05-18
---

# Net Flow chip + counter-flow filter (Silent Boom + Lottery Finder)

**Date:** 2026-05-18
**Author:** Charles + Claude
**Status:** Draft → user review → implementation plan

## Goal

Surface the per-ticker net flow direction at fire time as a UI signal
on both Silent Boom and Lottery Finder, alongside the existing
market-wide Tide chip. Trader observation: market tide is often
bearish while individual tickers run strongly bullish (or the inverse).
Routing the per-ticker NCP - NPP delta into chips and a filter lets the
user separate macro context from the side that owns the actual tape on
the alert's ticker.

Three deliverables, all **frontend-only**:

1. Per-row `Flow ⬆/⬇` chip on `SilentBoomRow` and `LotteryRow`, styled
   to match the existing `Tide ⬆/⬇` chip.
2. Parent-rollup `flow ↑ aligned` / `flow ↓ counter` / `flow mixed`
   chip on `SilentBoomTickerGroup` and `LotteryFinderTickerGroup`,
   styled to match the existing `tide ↑ aligned` chip.
3. A `<FilterChip>` toolbar toggle on both `SilentBoomSection` and
   `LotteryFinderSection` that hides rows where the per-ticker net
   flow direction at fire time contradicts the option type. Persists
   to localStorage.

No backend changes. No detector changes. No DB migration. No score
change. Fire-time `tickerCumNcpAtFire` / `tickerCumNppAtFire` are
already populated on both feeds going forward; historical NULL rows
get backfilled by an existing operational script in **Phase 0**
(below).

## Decisions locked during brainstorm

| Question                                               | Decision                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-side gate vs UI filter                          | **UI filter only** — no `directionGated`-style server flag, no score impact, no migration.                                                                                                                                                  |
| Threshold for bullish/bearish                          | **Sign-only** — `delta > 0` bullish, `delta < 0` bearish, `delta === 0` flat. Matches the existing `computeFlowMatch` convention.                                                                                                           |
| Fire-time vs live snapshot                             | **Fire-time** — `tickerCumNcpAtFire` / `tickerCumNppAtFire`. Chip is stable; filter is deterministic. Doesn't conflict with the existing live `Flow Match` badge.                                                                           |
| Rollup count chip (parallel to `N gated`)              | **Skip** — rely on the rollup `flow ↑/↓ counter` chip + per-row chip + filter. The `N gated` count is meaningful because rows were demoted; the new flow filter is client-side, so a count chip would just restate the per-row chip's info. |
| Share `tideBadge` + `flowBadge` between row components | **Extract** to `src/utils/macro-badges.ts` — single source of truth for both panels' chips.                                                                                                                                                 |

## Data shape

Both `SilentBoomAlert` ([src/components/SilentBoom/types.ts#L168](src/components/SilentBoom/types.ts#L168))
and `LotteryFire.macro` ([src/components/LotteryFinder/types.ts#L86](src/components/LotteryFinder/types.ts#L86))
already expose:

```ts
tickerCumNcpAtFire: number | null;
tickerCumNppAtFire: number | null;
```

Derived signal for this feature (per row):

```ts
const flowAtFire =
  alert.tickerCumNcpAtFire != null && alert.tickerCumNppAtFire != null
    ? alert.tickerCumNcpAtFire - alert.tickerCumNppAtFire
    : null;
```

## Architecture

### Phase 0 — Backfill historical `cum_ncp_at_fire` / `cum_npp_at_fire`

The cron paths (`detect-lottery-fires`, `detect-silent-boom`) already
populate these columns going forward via `api/_lib/ticker-flow-snapshot.ts`.
But historical rows inserted before migration #158 — and any rows where
the prior LATERAL-join code path left a NULL — still need filling so
the UI chip renders on history AND so the columns are reliable for
ML feature engineering on the full alert history.

Tool: `scripts/backfill-ticker-flow-at-fire.mjs` (already exists from
the migration #158 work). What it does:

- Groups NULL rows by `(ticker, date)` across both `lottery_finder_fires`
  AND `silent_boom_alerts`
- Fetches each ticker-day cumulative series ONCE from a UNION of
  `ws_net_flow_per_ticker` (live WS rolls) and
  `net_flow_per_ticker_history` (REST backfill), bounded 08:30–15:00 CT
- Binary-searches each fire's `bucket_ct` / `trigger_time_ct` against
  the series; batches updates per group via
  `UPDATE … FROM jsonb_array_elements()`
- Idempotent — `WHERE cum_ncp_at_fire IS NULL` on both the
  group-discovery query and the UPDATE clauses, so re-runs are safe
- Flags: `--table lottery|silentboom|both` · `--ticker` · `--date` ·
  `--limit N` · `--dry-run`

**Run sequence:**

1. `DATABASE_URL=… node scripts/backfill-ticker-flow-at-fire.mjs --dry-run`
   to estimate scope (groups, rows updated, rows unreachable).
2. Spot-check one ticker-day live: `--ticker MSFT --date 2026-05-15 --dry-run`,
   then confirm the resulting NCP/NPP delta matches what UW shows for
   that ticker at the fire time.
3. Drop `--dry-run` to commit. Run during off-hours (the script is
   gentle — one SELECT + one batched UPDATE per group — but it does
   touch every NULL row in both tables).

**Unreachable rows (left NULL after the script):**

- **Outside-universe tickers** — `uw-stream` subscribes to ~50 tickers
  (the Lottery Finder universe). Alerts on tickers outside that set
  have no entries in either source table and stay NULL forever. Same
  state as today's LATERAL fallback. UI chip simply doesn't render.
- **Pre-series fires** — `trigger_time_ct` / `bucket_ct` before the
  earliest tick of that ticker-day. Rare (the REST backfill starts at
  08:30 CT) but possible for pre-market alerts. Same fallback.

Both counts are reported in the script's summary so you can audit
exactly what was reached.

**ML consideration:** once backfilled, `cum_ncp_at_fire` and
`cum_npp_at_fire` are reliable as historical training features. A
filter like `WHERE cum_ncp_at_fire IS NOT NULL` cleanly partitions the
universe into "rows where the per-ticker tape direction is known at
fire time" — useful for feature-by-feature lift analysis on the
direction-flow signal.

### Phase 1 — Shared badge utility

**New file:** `src/utils/macro-badges.ts`

Move both `tideBadge()` (currently duplicated in `SilentBoomRow.tsx`
and `LotteryRow.tsx`) and the new `flowBadge()` into one module so
chip styling is single-source. Identical behavior to the existing
`tideBadge` — pure function, no React, no side effects.

```ts
export interface MacroBadgeView {
  label: string;
  cls: string;
  tooltip: string;
}

/**
 * Market-wide Tide badge. Diff = NCP - NPP at fire time.
 * Display-only (per lottery's spec Appendix A).
 */
export function tideBadge(diff: number | null): MacroBadgeView | null;

/**
 * Per-ticker Net Flow badge. Diff = cumNcpAtFire - cumNppAtFire
 * at fire time. Sign-only — no deadband, matches the existing
 * Flow Match badge convention.
 *
 * Distinct from the live Flow Match badge: this chip is the FIRE-TIME
 * direction of net flow (frozen); Flow Match is the LIVE direction
 * (updates intraday). The two read together as "where was the tape at
 * fire time" + "where is it now".
 */
export function flowBadge(diff: number | null): MacroBadgeView | null;
```

`flowBadge` returns:

- `Flow ⬆` (green border/text) when `diff > 0`
- `Flow ⬇` (red border/text) when `diff < 0`
- `Flow →` (neutral) when `diff === 0`
- `null` when `diff == null` (chip hidden)

Tooltip: `Ticker net flow at fire time: NCP $X.XM, NPP $Y.YM, Δ ±$Z.ZM. Sign-only direction; used by the hide-counter-flow filter.`

**Tests:** `src/__tests__/utils/macro-badges.test.ts` — cover positive/
negative/zero/null for both badges. Verify CSS classes, label format,
tooltip dollar formatting.

### Phase 2 — Per-row Flow chip

**Modified files:**

- [src/components/SilentBoom/SilentBoomRow.tsx](src/components/SilentBoom/SilentBoomRow.tsx)
  - Replace local `tideBadge` with import from `macro-badges.ts`
  - Add `flowBadge` import + invocation:
    `const flow = flowBadge(deltaFromAtFire(alert.tickerCumNcpAtFire, alert.tickerCumNppAtFire))`
  - Render `<span>` chip between Tide and Flow Match (left-to-right
    macro → fire-time micro → live micro)

- [src/components/LotteryFinder/LotteryRow.tsx](src/components/LotteryFinder/LotteryRow.tsx)
  - Same refactor + addition. Source: `fire.macro.tickerCumNcpAtFire/NppAtFire`

Helper used by both rows (lives in `macro-badges.ts`):

```ts
export function deltaFromAtFire(
  ncp: number | null | undefined,
  npp: number | null | undefined,
): number | null {
  if (ncp == null || npp == null) return null;
  if (!Number.isFinite(ncp) || !Number.isFinite(npp)) return null;
  return ncp - npp;
}
```

**Test updates:**

- [src/**tests**/SilentBoomRow.test.tsx](src/__tests__/SilentBoomRow.test.tsx) — assert Flow chip renders for non-null + hidden for null
- [src/**tests**/LotteryRow.test.tsx](src/__tests__/LotteryRow.test.tsx) — same

### Phase 3 — Rollup flow chip

**Modified file:** [src/utils/ticker-rollup-aggregates.ts](src/utils/ticker-rollup-aggregates.ts)

Add one optional field to `RollupAlertSummary`:

```ts
/** Ticker cumulative NCP - NPP at trigger time. Null when feed lacks
 *  the snapshot. */
tickerNetFlowAtFire: number | null;
```

Add `flow: TideAggregate` to `RollupAggregates`:

```ts
export interface RollupAggregates {
  // ...existing fields...
  /** Per-ticker net flow aggregation. Same shape as `tide`. */
  flow: TideAggregate;
}
```

Refactor the existing `computeTide(rows, bias)` to take a field
selector, OR add a parallel `computeFlow` that re-uses the body. Draft
picks the field-selector path — one function, less duplication:

```ts
function computeDirAlignment(
  rows: readonly RollupAlertSummary[],
  bias: Bias,
  selector: (r: RollupAlertSummary) => number | null,
): TideAggregate {
  // body identical to existing computeTide, but uses `selector(r)`
  // instead of `r.mktTideDiff`.
}

function computeTide(rows, bias) {
  return computeDirAlignment(rows, bias, (r) => r.mktTideDiff);
}

function computeFlow(rows, bias) {
  return computeDirAlignment(rows, bias, (r) => r.tickerNetFlowAtFire);
}
```

New formatter:

```ts
export function formatFlowLabel(flow: TideAggregate): string {
  if (flow.dir === 'unknown') return 'flow —';
  if (flow.dir === 'mixed') return 'flow mixed';
  const arrow = flow.dir === 'up' ? '↑' : '↓';
  return `flow ${arrow} ${flow.align}`;
}
```

**Tests:** [src/**tests**/utils/ticker-rollup-aggregates.test.ts](src/__tests__/utils/ticker-rollup-aggregates.test.ts)
— mirror every existing tide test case for flow (aligned / counter /
mixed / unknown across bull/bear/mixed bias).

### Phase 4 — Wire rollup chip into ticker groups

**Modified files:**

- [src/components/SilentBoom/SilentBoomTickerGroup.tsx](src/components/SilentBoom/SilentBoomTickerGroup.tsx)
  - Add `tickerNetFlowAtFire: deltaFromAtFire(a.tickerCumNcpAtFire, a.tickerCumNppAtFire)` to the `RollupAlertSummary` payload mapped at line ~141
  - **Rename** the local `tideChipClass(align)` helper → `alignChipClass(align)` so the same function legibly serves both `agg.tide.align` and `agg.flow.align` (it's already generic over `TideAggregate['align']`; the rename matches the Phase 3 `computeDirAlignment` generalization)
  - Render a new `<span>` flow chip next to the existing tide chip, using `alignChipClass(agg.flow.align)` (green=aligned, red=counter, neutral=mixed, dim=unknown)
  - Tooltip explains the source: `Does per-ticker net flow (cumNcpAtFire − cumNppAtFire) direction agree with this ticker's bias? aligned = same direction; counter = opposite (tape fighting the bet); mixed = inconsistent across alerts; unknown = no fire-time snapshot.`

- [src/components/SilentBoom/SilentBoomSection.tsx](src/components/SilentBoom/SilentBoomSection.tsx) (line ~795)
  - Add the same field to the `RollupAlertSummary` payload used for sort/grouping
  - `useMemo` deps must include alerts (already present — nothing else changes here)

- [src/components/LotteryFinder/LotteryFinderTickerGroup.tsx](src/components/LotteryFinder/LotteryFinderTickerGroup.tsx)
  - Mirror SB ticker group changes; source path is `f.macro.tickerCumNcpAtFire` / `f.macro.tickerCumNppAtFire`

- [src/components/LotteryFinder/LotteryFinderSection.tsx](src/components/LotteryFinder/LotteryFinderSection.tsx) (line ~689)
  - Mirror SB section sort/group payload addition

**Test updates:**

- `src/__tests__/SilentBoomTickerGroup.test.tsx` — assert `flow` chip renders the expected label for aligned/counter/mixed cases
- `src/__tests__/LotteryFinderTickerGroup.test.tsx` — same

### Phase 5 — `hide counter-flow` filter on both sections

**Modified files:**

- [src/components/SilentBoom/SilentBoomSection.tsx](src/components/SilentBoom/SilentBoomSection.tsx)
- [src/components/LotteryFinder/LotteryFinderSection.tsx](src/components/LotteryFinder/LotteryFinderSection.tsx)

New state per section, persisted to localStorage with keys:

- `silentBoom.hideCounterFlow`
- `lottery.hideCounterFlow`

```ts
const HIDE_COUNTER_FLOW_LS_KEY = 'silentBoom.hideCounterFlow';

const [hideCounterFlow, setHideCounterFlow] = useState<boolean>(() => {
  // mirror the existing hideGated initializer pattern
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

Filter predicate (added to the existing `displayedAlerts` / `displayedFires` `useMemo` chain):

```ts
if (hideCounterFlow) {
  out = out.filter((row) => {
    const ncp = row.tickerCumNcpAtFire; // or row.macro.tickerCumNcpAtFire
    const npp = row.tickerCumNppAtFire;
    if (ncp == null || npp == null) return true; // never drop pre-snapshot rows
    const delta = ncp - npp;
    if (delta === 0) return true; // flat = neutral, don't drop
    if (row.optionType === 'C') return delta > 0; // bullish flow → keep call
    return delta < 0; // bearish flow → keep put
  });
}
```

Hidden-count for the chip suffix:

```ts
const hiddenCounterFlowCount = hideCounterFlow
  ? alerts.filter((a) => {
      // count rows that WILL be hidden (the inverse of the keep predicate)
    }).length
  : 0;
```

Chip JSX:

```tsx
<FilterChip
  active={hideCounterFlow}
  activeColor="amber"
  testId="silent-boom-hide-counter-flow-chip"
  onClick={() => setHideCounterFlow(!hideCounterFlow)}
  title="Hide counter-flow alerts — where the per-ticker net flow (cumNcpAtFire − cumNppAtFire) at fire time contradicts the option type. Calls hidden when NCP < NPP; puts hidden when NCP > NPP. Rows with no fire-time snapshot are never hidden. Client-side filter — does not affect score or tier."
  ariaPressed={hideCounterFlow}
>
  hide counter-flow
  {hideCounterFlow && hiddenCounterFlowCount > 0 && (
    <span className="text-[10px] opacity-70">−{hiddenCounterFlowCount}</span>
  )}
</FilterChip>
```

Place this chip directly after the existing `hide counter-trend`
chip (`hideGated`) so the two related filters read as a unit:
market-tide counter-trend → per-ticker counter-flow.

**Test updates:**

- [src/**tests**/SilentBoomSection.test.tsx](src/__tests__/SilentBoomSection.test.tsx)
  - Assert `hide-counter-flow-chip` toggles `aria-pressed`
  - Assert localStorage persistence
  - Assert call rows are dropped when `tickerCumNcpAtFire < tickerCumNppAtFire`
  - Assert put rows are dropped when `tickerCumNcpAtFire > tickerCumNppAtFire`
  - Assert pre-snapshot rows (`null` either field) are NEVER dropped
  - Assert hidden-count suffix appears with correct N

- `src/__tests__/LotteryFinderSection.test.tsx` — same

## Files touched

| Phase | File                                                                         | New / Modified                                      |
| ----- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| 0     | `scripts/backfill-ticker-flow-at-fire.mjs`                                   | Operational (already exists) — run dry, then commit |
| 1     | `src/utils/macro-badges.ts`                                                  | **New**                                             |
| 1     | `src/__tests__/utils/macro-badges.test.ts`                                   | **New**                                             |
| 2     | `src/components/SilentBoom/SilentBoomRow.tsx`                                | Modified                                            |
| 2     | `src/components/LotteryFinder/LotteryRow.tsx`                                | Modified                                            |
| 2     | `src/__tests__/SilentBoomRow.test.tsx`                                       | Modified                                            |
| 2     | `src/__tests__/LotteryRow.test.tsx`                                          | Modified                                            |
| 3     | `src/utils/ticker-rollup-aggregates.ts`                                      | Modified                                            |
| 3     | `src/__tests__/utils/ticker-rollup-aggregates.test.ts`                       | Modified                                            |
| 4     | `src/components/SilentBoom/SilentBoomTickerGroup.tsx`                        | Modified                                            |
| 4     | `src/components/SilentBoom/SilentBoomSection.tsx`                            | Modified                                            |
| 4     | `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx`                  | Modified                                            |
| 4     | `src/components/LotteryFinder/LotteryFinderSection.tsx`                      | Modified                                            |
| 4     | `src/__tests__/SilentBoomTickerGroup.test.tsx`                               | Modified                                            |
| 4     | `src/__tests__/LotteryFinderTickerGroup.test.tsx`                            | Modified                                            |
| 5     | `src/components/SilentBoom/SilentBoomSection.tsx` (already in Phase 4)       | Modified                                            |
| 5     | `src/components/LotteryFinder/LotteryFinderSection.tsx` (already in Phase 4) | Modified                                            |
| 5     | `src/__tests__/SilentBoomSection.test.tsx`                                   | Modified                                            |
| 5     | `src/__tests__/LotteryFinderSection.test.tsx`                                | Modified                                            |

**Touch count:** 2 new files, 12 modified files. No backend / DB / migration / detector / score changes.

## Edge cases

- **Pre-snapshot rows** (`tickerCumNcpAtFire == null` or `tickerCumNppAtFire == null`): chip hidden, filter never drops the row, rollup excludes the row from `flow` aggregation (returns `unknown` when ALL rows are null).
- **Exactly zero delta** (`NCP === NPP`): chip shows `Flow →` neutral, filter doesn't drop (no contradiction with either option type).
- **All rows in a ticker group are pre-snapshot null:** rollup shows `flow —` neutral chip (parallel to `tide —`).
- **Filter intersection with existing `hide counter-trend`**: both filters compose by AND — a row is shown only if NEITHER filter would hide it. Same composition as every other filter on the toolbar.
- **localStorage absent / SSR:** both initializers tolerate `typeof window === 'undefined'` and unparseable values (mirror the existing `hideGated` pattern).
- **The existing `Flow Match` live badge stays untouched.** The new `Flow ⬆/⬇` chip is the FIRE-TIME signal; `Flow Match` continues to read the live `useTickerNetFlowBatch` snapshot. Reading them side-by-side gives the user "where was the tape at fire" + "where is it now".

## Future considerations

No blocking questions remain. Four watch-list items that the spec
deliberately defers:

1. **Deadband for sign-only chip + filter.** A row with NCP=$501K /
   NPP=$500K reads as `Flow ⬆` and trips the filter on put alerts.
   Decision was "sign-only fine for now"; revisit if a real
   near-zero-delta case in production produces a clearly misleading
   chip. Cleanest retrofit: `|delta| < 5% of (NCP+NPP)` treated as
   flat in `flowBadge` AND in the filter predicate (must stay in
   sync).

2. **Server-side gate / score weight.** The whole feature ships as a
   client-side UI filter. If post-backfill ML analysis (using the
   newly-reliable `cum_ncp_at_fire` / `cum_npp_at_fire` columns) shows
   higher win-rate lift than the existing market-tide
   `directionGated`, that's the trigger to promote the signal into
   the score: new migration adds `flow_direction_gated` column,
   `computeSilentBoomScore` gets a counter-flow demote, backfill
   rolls it across history.

3. **Rollup chip read density.** Adding the flow chip puts the busy
   ticker headers at 11+ chips wide. The existing `flex flex-wrap`
   handles overflow, but visual review on first deploy may show
   wrapping reads as noise. Mitigation if needed: collapse adjacent
   `tide … aligned` + `flow … aligned` into a single combined
   "both aligned" chip when they agree.

4. **Outside-universe ticker coverage.** `uw-stream` subscribes to
   ~50 tickers — single-name alerts outside that set never get a
   `Flow` chip. Phase 0's backfill summary surfaces the count.
   Reopen when chip coverage on more tickers becomes worth the WS
   subscription expansion or a REST polling fallback.

## Risk

Low. Pure frontend; no detector, no DB, no score change. Phase 1 is a
mechanical refactor of two near-identical functions into one. Phases
2-4 are additive UI. Phase 5 mirrors the existing `hide counter-trend`
filter pattern verbatim. Visual regression is the only real risk;
the unit test additions cover that surface.

## Phase order

0 → 1 → 2 → 3 → 4 → 5. Phase 0 is operational (running an existing
script) and unblocks the ML use case immediately; it can run in
parallel with Phase 1–5 frontend work since they don't depend on each
other (NULL rows simply don't render a chip). Each subsequent phase
independently shippable with full `npm run review` (tsc + eslint +
prettier + vitest) green and a reviewer-subagent pass per the
project's Get-It-Right loop.
