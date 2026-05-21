# Gamma-Node Composite Detector — Daily Alert Tile

**Status:** Spec'd 2026-05-21. Awaiting implementation approval.
**Author:** Charlie + Claude (overnight 2026-05-20 → 21 research session)
**Reference:** [project_gamma_node_rejection_signal.md](../../../../.claude/projects/-Users-charlesobrien-Documents-Workspace-strike-calculator/memory/project_gamma_node_rejection_signal.md) for full analytical history (30+ hypotheses, 20+ scripts, full validation chain)

## Goal

A daily-active alert tile that flags real-time E1/E5/PCS setups against SPX +γ nodes during RTH, with per-DOW confidence labels so the trader knows when to size up and when to size down. Trader executes manually; the tile is informational, not autotrade.

## Trade triggers (all use SPX `index_candles_1m` + `periscope_snapshots`)

### E1 — Long Call breakthrough
Definition: 1-min SPX bar where `bar.open < node_strike` AND `bar.high > node_strike` AND `bar.close > node_strike`, for a positive-γ strike from the latest periscope snapshot. Then the NEXT 3 bars must all `close > node_strike` (hold). On confirmation of the 3-bar hold, fire the alert.

Trade recommendation: long call at the broken node strike OR long call debit spread (next ceiling as long leg).

Expected forward edge: +5 pts SPX over +30m (n=180 sample, walk-forward stable).

### E5 — Long Put failed-reversal
Definition: a v4-style down-wick event (bar pierces +γ floor from above and closes back above) where the 30-min forward return was negative — i.e., the bounce failed. Then, within the 10 min after the wick bar, price breaks 1pt below the wick's low. On break-of-low confirmation, fire alert.

Trade recommendation: long put at the broken low strike OR long put debit spread (next floor as long leg).

Expected forward edge: +8.95 pts SPX over +30m from the breakdown bar (n=86, walk-forward HOLDS: H1 +10.98, H2 +6.92, both p<0.001).

### PCS — Monday Rejection (put credit spread)
Definition: down-wick at a SMALL +γ floor (|gex| ≤ $500k) where bar.open is above node, bar.low pierces node, bar.close back above. ALSO requires:
- ES basis in top quartile (ES holding bid vs SPX cash)
- NOT a flat-gap day (`|open_gap| ≥ 0.1%`)
- Monday only

Trade recommendation: put credit spread, short leg at the next +γ floor below current price, ~40-50 delta.

Expected forward edge: +16 pts SPX over +30m (n=45, walk-forward holds both halves).

## Confidence labels (per DOW, displayed prominently on the tile)

| DOW | Label | Reason |
|---|---|---|
| **Monday** | **HIGH** (MAXIMUM if pre-day filter fires) | n=51 unfiltered Δ=+13, win 82%, p<0.0001. Strongest standalone. |
| **Friday** | **HIGH** | n=24 with calendar anti-filters Δ=+9, win 63%, p=0.04. Second-cleanest. |
| Tuesday | MEDIUM | n=41 Δ=+2.79, p=0.46. Edge present in composite but DOW-specific is noisy. |
| Wednesday | MEDIUM | n=29 Δ=+0.38, p=0.90. Track-but-don't-press. |
| Thursday | MEDIUM (caution) | n=26 Δ=-2.52, p=0.46. Slight negative drift, but composite still works on average. |

**MAXIMUM tier upgrade:** if the pre-day filter fires (`prior 5-day SPX return < -1%` AND `prior IV rank > 25`), upgrade Monday from HIGH to MAXIMUM. Within filter-on Monday subset, n=36, Δ=+15, win 80.6%, p<0.0001.

## Calendar anti-filters (display warning, do NOT auto-suppress)

The tile should DISPLAY these warnings but still let signals fire — the trader decides:
- **FOMC day**: E1 has -13.75 edge (n=4 in sample). Show "FOMC day — E1 untrustworthy" badge.
- **DOM 1-5**: E5 has -18.82 edge (n=12). Show "Early-month — E5 untrustworthy" badge.
- **DOM 16-20**: E1 weak (-1.43 edge). Show "Mid-month gamma void — E1 weak" badge.

## Live-tracking database schema

New table: `ws_gamma_setup_fires` (suggested migration #N+1 in `api/_lib/db-migrations.ts`).

```sql
CREATE TABLE IF NOT EXISTS ws_gamma_setup_fires (
  id BIGSERIAL PRIMARY KEY,
  fired_at TIMESTAMPTZ NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('e1_long_call','e5_long_put','pcs_monday')),
  dow_label TEXT NOT NULL,  -- 'Monday', 'Tuesday', etc.
  confidence_tier TEXT NOT NULL CHECK (confidence_tier IN ('MAXIMUM','HIGH','MEDIUM')),

  -- Event context
  spot_at_fire NUMERIC NOT NULL,
  node_strike INT NOT NULL,
  node_gex NUMERIC NOT NULL,  -- positive value, raw gex
  bar_open NUMERIC NOT NULL,
  bar_high NUMERIC NOT NULL,
  bar_low NUMERIC NOT NULL,
  bar_close NUMERIC NOT NULL,
  bar_range NUMERIC NOT NULL,

  -- Filter status (for stratification later)
  es_basis_change_5m NUMERIC,
  prior_5d_ret NUMERIC,
  prior_iv_rank NUMERIC,
  pre_day_filter_fires BOOLEAN NOT NULL DEFAULT false,
  open_gap_pct NUMERIC,  -- (day_open / prior_close - 1) * 100
  is_fomc_day BOOLEAN NOT NULL DEFAULT false,
  is_dom_1_5 BOOLEAN NOT NULL DEFAULT false,
  is_dom_16_20 BOOLEAN NOT NULL DEFAULT false,

  -- Outcome (filled in retrospectively)
  ret_15m NUMERIC,  -- price points, direction-adjusted for the trade type
  ret_30m NUMERIC,
  ret_60m NUMERIC,
  ret_eod NUMERIC,

  -- Optional manual tracking
  trade_taken BOOLEAN NOT NULL DEFAULT false,
  trade_premium_cost NUMERIC,
  trade_premium_close NUMERIC,
  trade_pnl_dollars NUMERIC,
  trade_notes TEXT,

  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ws_gamma_setup_fires_fired_at
  ON ws_gamma_setup_fires (fired_at);
CREATE INDEX IF NOT EXISTS idx_ws_gamma_setup_fires_signal_type
  ON ws_gamma_setup_fires (signal_type);
```

The outcome columns (`ret_*`) get filled by a cron that runs daily after close — looks up SPX 1-min candles, computes forward returns at the appropriate horizons.

The `trade_*` columns are manually filled by the trader via a journal entry, so we can compare expected (ret_30m) vs realized (trade_pnl_dollars).

## Implementation order

**Phase 1 — Backend (api/ + DB):**
1. Migration #N+1: create `ws_gamma_setup_fires` table.
2. New cron job at `/api/cron/detect-gamma-setups.ts` — runs every 1-2 min during RTH:
   - Pulls latest SPX 1-min candle
   - Pulls latest periscope snapshot (within 10 min)
   - Evaluates E1 / E5 / PCS triggers
   - On fire, inserts a row in `ws_gamma_setup_fires`
3. New API endpoint `GET /api/gamma-setups/active` — returns the day's fires plus current day's confidence label + filter status.
4. Daily backfill cron `/api/cron/backfill-gamma-setup-outcomes.ts` — runs at 15:30 CT, fills `ret_*` columns for prior fires.

**Phase 2 — Frontend (src/):**
1. New tile `src/components/GammaSetupTile/` with:
   - Top banner: today's DOW + confidence tier + filter status
   - Active fires list (chronological today)
   - Each fire shows: signal type, time, strike, current P&L if trade was taken
   - Anti-filter warnings displayed prominently
2. Wire into `useGammaSetups` hook polling `/api/gamma-setups/active`
3. Position in main layout — probably alongside Periscope tile, since they share the same gamma-node mental model.

**Phase 3 — Live tracking & stats:**
1. Manual journal entry form (extend existing journal to capture `trade_taken` + outcomes for any fire).
2. Weekly summary panel: how many fires this week, how many trades taken, hit rate vs expected, edge realization.
3. After 4-6 weeks of live data, refresh the analytical baseline and re-validate.

## Out of scope (deliberately)

- Autotrade execution (manual only — the framework explicitly accepts a 60% win rate, not autotrade-grade certainty)
- Position sizing recommendations (trader's risk management is their own)
- Greeks/IV based exit signals (the analytical work measured Δ at +30m forward, not vol-crush; trader manages exits manually)
- Cross-asset confluence alerts (B1 ES basis is INCLUDED as a PCS filter; NDX/QQQ cross-confluence found ineffective per NDX cross-validation analysis)

## Open questions

1. Should the tile show non-Monday-or-Friday MEDIUM-confidence fires VISUALLY but maybe with a smaller font / muted color? Or treat all DOWs identically and let the label do the work?
2. Should the pre-day filter status be checked at Friday close and displayed as "Monday is MAXIMUM tomorrow" the night before, or only revealed when Monday opens?
3. Live data lag: the periscope scraper runs every 10 min. Setup detection therefore has 10-min lag on gamma nodes. Acceptable since 1-min candle data is faster than the dealer-rebalance dynamic anyway.

## Frontend integration (reviewed 2026-05-21)

### Placement in layout

The frontend uses a single-page `App.tsx` with a panel registry (`src/constants/panel-registry.ts`). Tiles are grouped into: Inputs, Market Context, Futures, Charts & History, Trading, Results.

**Add new panel between `sec-gexbot` and `sec-periscope-exposure`** in the **Market Context** group. Rationale:
- The tile is conceptually adjacent to Periscope (both about +γ floor/ceiling)
- Keeps gamma-related tiles contiguous
- Fire-list structure aligns with sibling alert tiles (LotteryFinder, SilentBoom) already in Market Context group
- **SilentBoom precedent**: already implements per-DOW confidence badges — read its source as the closest UI reference before building

**Registry entry** (`src/constants/panel-registry.ts`):
```ts
{ id: 'sec-gamma-node-detector', label: 'Gamma-Node Composite Detector', group: 'Market Context' }
```

**App.tsx panelMap entry** (around line 1188): wire `sec-gamma-node-detector` → `<GammaNodeDetectorPanel />`.

### Component structure

```
src/components/GammaNodeDetector/
  index.tsx              ← exports GammaNodeDetectorPanel
  GammaNodeDetectorPanel.tsx  ← outer SectionBox + header + day banner + fire list
  DayConfidenceBanner.tsx ← banner: DOW + confidence tier + filter status + anti-filter warnings
  FireRow.tsx            ← single fire entry (time + signal type + strike + ret_30m if past)
  hooks/
    useGammaSetups.ts    ← polls /api/gamma-setups/active
```

### Styling — match existing visual language EXACTLY

The frontend uses semantic CSS tokens (`--color-success`, `--color-danger`, `--color-caution`, `--color-accent`) from `src/themes/` with a `.dark` class override. Use the existing components, not hand-rolled wrappers.

**Outer tile wrapper** — use the `SectionBox` component (`src/components/ui/SectionBox.tsx`):
```tsx
<SectionBox id="sec-gamma-node-detector" title="GAMMA-NODE COMPOSITE DETECTOR">
  {/* contents */}
</SectionBox>
```
SectionBox handles all the standard styling (border-t-accent, rounded-[14px], border-[1.5px], p-[18px], shadow, animate-fade-in-up, dark-mode tokens). DO NOT roll a custom wrapper.

**Header** — handled by SectionBox `title` prop, which renders:
```
text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase
```

**Confidence badge** — use the `StatusBadge` component (`src/components/ui/StatusBadge.tsx`) with semantic color mapping. Reference implementation at `src/components/GexTarget/TargetTile.tsx:44-54`:
```tsx
import { StatusBadge } from '../ui/StatusBadge';
import { theme } from '../../themes';

function ConfidenceBadge({ tier }: { tier: 'MAXIMUM' | 'HIGH' | 'MEDIUM' }) {
  const color =
    tier === 'MAXIMUM' || tier === 'HIGH' ? theme.green : theme.caution;
  return <StatusBadge label={tier} color={color} />;
}
```
The StatusBadge uses `color-mix(in srgb, ${color} 9%, transparent)` for the tint — matches the existing visual.

**Anti-filter warning badge** — use the EventDayWarning pattern (`src/components/EventDayWarning.tsx:120-134`):
```tsx
<span
  className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] uppercase"
  style={{ backgroundColor: tint(warningColor, '18'), color: warningColor }}
>
  FOMC DAY
</span>
```
Color mapping for warnings:
- `FOMC day` → `theme.caution` (amber/yellow)
- `DOM 1-5` → `theme.red` (anti-filter for E5)
- `DOM 16-20` → `theme.red` (anti-filter for E1)

**Fire-row layout** — mirror EventDayWarning's row pattern:
```tsx
<div className="flex items-center gap-2.5 py-1.5">
  <span
    className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold tracking-[0.06em] uppercase"
    style={{ backgroundColor: tint(signalColor, '18'), color: signalColor }}
  >
    {signalType /* E1 / E5 / PCS */}
  </span>
  <span className="text-primary font-sans text-xs font-medium">
    Strike {nodeStrike} | {/* description */}
  </span>
  <span className="text-muted ml-auto shrink-0 font-mono text-[11px]">
    {fireTimeCT} CT
  </span>
</div>
```

**Color semantics for signal type:**
- E1 long call → `theme.green` (bullish breakthrough)
- E5 long put → `theme.red` (bearish breakdown)
- PCS Monday → `theme.accent` (blue, premium-sell setup)

**Loading state** — use the `SkeletonSection` component (`src/components/SkeletonSection.tsx`). Matches the SectionBox dimensions.

**Empty state** — when no fires today:
```tsx
<div className="rounded border border-neutral-800 bg-neutral-950 p-2 text-[11px] text-neutral-500">
  No setups detected yet today.
</div>
```

### Typography reference (for any custom text in the tile)

| Element | Classes |
|---|---|
| Section header (handled by SectionBox) | `text-tertiary font-sans text-[13px] font-bold tracking-[0.12em] uppercase` |
| Sub-header / row label | `text-tertiary font-sans text-[11px] font-bold tracking-[0.08em] uppercase` |
| Card title | `text-tertiary font-sans text-[10px] font-bold tracking-[0.08em] uppercase` |
| Card subtitle | `text-muted font-sans text-[10px]` |
| Body text | `text-primary font-sans text-xs font-medium` |
| Numeric value | `font-mono text-[13px] font-semibold` |
| Timestamp | `text-muted font-mono text-[11px]` |
| Badge text | `font-mono text-[10px] font-bold tracking-[0.06em] uppercase` |

### Day banner mockup

```
┌──────────────────────────────────────────────────────────────────────┐
│ GAMMA-NODE COMPOSITE DETECTOR                                         │
├──────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ MONDAY    [ MAXIMUM ]   pre-day filter active                     │ │
│ │           [ FOMC DAY ]  — display anti-filter warnings here       │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ [E1] Strike 7445 | breakthrough confirmed, 3-bar hold   10:22 CT  │ │
│ │ [E5] Strike 7420 | failed-bounce breakdown               11:47 CT  │ │
│ │ [PCS] Strike 7415 | ES basis ↑, gap +0.6%                10:08 CT  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### Don't forget

- Authenticated only? Probably yes — matches GexbotSection gating (CLAUDE.md memory: only Claude API calls are owner-gated; data reads are public for guests, so this tile could be public).
- Add to panel-prefs modal automatically (uses Market Context group default).
- Mobile layout: SectionBox uses `max-w-[660px]` mobile container; fire rows wrap naturally.

## Validation done

See [project_gamma_node_rejection_signal.md](../../../../.claude/projects/-Users-charlesobrien-Documents-Workspace-strike-calculator/memory/project_gamma_node_rejection_signal.md) for the full 30+ hypothesis validation chain. The composite framework survived walk-forward; the per-DOW labels are derived from the actual statistical edge in our 82-day sample (2026-02-27 → 2026-05-19).
