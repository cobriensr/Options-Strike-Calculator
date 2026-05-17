# GEXBot Frontend Components — 2026-05-16

## Goal

Surface the GEXBot Orderflow-tier data (captured via the cron pipeline
spec'd in [gexbot-trial-capture-2026-05-16.md](./gexbot-trial-capture-2026-05-16.md))
through 8 new React components that give the user signal angles their
existing stack doesn't cover: cross-asset dealer positioning, sub-10-min
strike-change movers, VIX-on-VIX state, mechanical charm drift, and
asymmetric long/short gamma exposure.

The capture pipeline lands data starting Monday 13:00 UTC. Components
must degrade gracefully (skeleton / "awaiting first cron tick" empty
state) until then.

## Locked design decisions

| Decision                                   | Choice                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Section placement                          | **New dedicated `<GexbotSection />`** in `App.tsx`, contains all 7 standalone tiles + child component for the Strike Mover marquee at top |
| Polling cadence                            | **30s** (frontend) against a 60s cron cadence — catches new ticks at most 30s late                                                        |
| Sibling-Asset Confirmation Bar integration | **Inline in the same row** as existing TakeItScore badges in Lottery + Silent Boom feeds                                                  |
| Mock data                                  | **No mock mode** — components render empty state until Monday's first tick                                                                |

## Components (8 total)

### Wave 2 — Small scalar tiles (4)

#### 1. `<VixDealerStateBadge />` (Wave 2a — pipeline validator)

- **Data:** `gexbot_snapshots WHERE ticker='VIX'` ORDER BY captured_at DESC LIMIT 1
- **Render:** Pill with VIX label + LONG/SHORT gamma state + zero-gamma level. Green when long-gamma (vol stable), red when short-gamma (vol may expand).
- **Sketch:**

  ```text
  ┌─ VIX DEALER STATE ─────────────────┐
  │ ● SHORT GAMMA   ZeroГ: 22.50       │
  │   vol expansion regime active      │
  └────────────────────────────────────┘
  ```

#### 2. `<CharmClock />` (multi-ticker)

- **Data:** `gexbot_snapshots.zcharm` for each ticker, latest row + current time
- **Render:** Per-ticker mini-row showing time-to-close + net charm + projected dollar-drift if dealers mechanically rehedge. Tickers in a vertical list.
- **Sketch:**

  ```text
  ┌─ CHARM CLOCK (time to close: 3h 22m) ─────────┐
  │ SPX  +$47M  → projected drift +0.18%           │
  │ SPY  +$12M  → projected drift +0.21%           │
  │ QQQ  −$8M   → projected drift −0.14%           │
  │ IWM  +$3M   → projected drift +0.09%           │
  │ ...                                            │
  └────────────────────────────────────────────────┘
  ```

  Projection formula: `projected_drift_pct = (zcharm × time_remaining_hours) / spot / 1e9` (scale will need calibration once data lands).

#### 3. `<GammaCompass />` (multi-ticker)

- **Data:** `gexbot_snapshots.{z_mlgamma, z_msgamma, spot}` per ticker
- **Render:** Per-ticker row: spot in center, long-gamma strike (floor) on left arrow, short-gamma strike (ceiling) on right arrow, distance + percent.
- **Sketch:**

  ```text
  ┌─ LONG/SHORT GAMMA COMPASS ─────────────────────┐
  │ SPX 5985.20  ⬅ FLOOR 5950 (−35, −0.58%)        │
  │              ➡ DANGER 6020 (+35, +0.58%)       │
  │ QQQ  535.12  ⬅ FLOOR 532 (−3, −0.58%)          │
  │              ➡ DANGER 540 (+5, +0.91%)         │
  │ ...                                            │
  └────────────────────────────────────────────────┘
  ```

#### 4. `<DexoflowVelocityTape />`

- **Data:** `gexbot_snapshots.{dexoflow, gexoflow, cvroflow}` per ticker, last 5 ticks (5 min history)
- **Render:** Per-ticker row showing the 3 flow-rate scalars as small speedometer-style gauges. Color-graded by direction (positive = green, negative = red). Trend arrow showing 5-min slope.
- **Sketch:**

  ```text
  ┌─ DEXOFLOW VELOCITY ────────────────────────────┐
  │       DEX flow    GEX flow    CVR flow         │
  │ SPX   ▲ +1.2K     ▼ −340      ▲ +0.04          │
  │ SPY   ▲ +890      ─ ±0        ▲ +0.02          │
  │ QQQ   ▼ −450      ▼ −210      ▼ −0.01          │
  │ ...                                            │
  └────────────────────────────────────────────────┘
  ```

### Wave 3 — Larger visualizations (3)

#### 5. `<ConvexityMatrix />`

- **Data:** `gexbot_snapshots.zcvr` per ticker, last 60 minutes
- **Render:** 4×4 grid of mini-sparklines (one per ticker). Each cell shows the 60-min `zcvr` trend as a tiny line chart. Cell background heat-mapped (green high → red low). Click cell → opens detail panel with full timeseries.
- **Sketch:**

  ```text
  ┌─ CROSS-ASSET CONVEXITY (0DTE zcvr, 60min) ─────┐
  │ ┌────┐ ┌────┐ ┌────┐ ┌────┐                    │
  │ │SPX │ │ES  │ │NDX │ │NQ  │                    │
  │ │1.4↗│ │1.3↗│ │1.6↗│ │1.5↗│                    │
  │ └────┘ └────┘ └────┘ └────┘                    │
  │ ┌────┐ ┌────┐ ┌────┐ ┌────┐                    │
  │ │RUT │ │VIX │ │SPY │ │QQQ │                    │
  │ │0.9↘│ │2.1↗│ │1.4↗│ │1.5↗│                    │
  │ └────┘ └────┘ └────┘ └────┘                    │
  │   ... (16 cells total, 4 rows × 4 cols)        │
  └────────────────────────────────────────────────┘
  ```

#### 6. `<CrossAssetSkewDashboard />`

- **Data:** `gexbot_snapshots.delta_risk_reversal` per ticker, latest + 1-day-ago
- **Render:** Bar chart, one bar per ticker, height = risk reversal value. Positive (call-skewed/greed) above zero line, negative (put-skewed/fear) below. Today vs 1d-ago overlay.
- **Sketch:**

  ```text
  ┌─ DELTA RISK REVERSAL — TODAY vs PRIOR DAY ─────┐
  │            ███                                 │
  │       ██  ███  ██                              │
  │  ─────██──███──██──██──── 0 ──                 │
  │            █▓▓        ▓▓                       │
  │            █▓▓   ██   ▓▓                       │
  │  SPX  SPY  QQQ  VIX  TLT  GLD ...              │
  │ Solid = today, light = yesterday               │
  └────────────────────────────────────────────────┘
  ```

#### 7. `<StrikeMoverTicker />`

- **Data:** `gexbot_api_capture WHERE category LIKE '%/maxchange'` joined to extract the 5-min strike-change winner per (ticker, category)
- **Render:** Horizontal scrolling marquee at the top of `<GexbotSection />`. Format: `TICKER STRIKE±CHANGE  |  TICKER STRIKE±CHANGE  |  ...` — pause on hover, click to deep-dive.
- **Sketch:**

  ```text
  ┌─ STRIKE MOVERS (5-min, all categories) ────────┐
  │ ◀ QQQ 535C +120K  |  SPY 615P −80K  |  IWM 230C +45K  |  SPX 5995 vanna +12K  |  ... ▶
  └────────────────────────────────────────────────┘
  ```

### Wave 4 — Integrated component (1)

#### 8. `<SiblingAssetConfirmationBar />` (lives inline in lottery/silent-boom rows)

- **Data:** Given a lottery row for `{ticker, side}`, query `gexbot_snapshots` for sibling tickers' `zcvr` + `delta_risk_reversal` direction over the last 5 minutes. "Sibling" = same asset class (large-cap = SPX/SPY/QQQ/IWM/NDX; volatility = VIX; commodity = GLD/USO/SLV; etc.).
- **Render:** Inline 3-pill bar next to existing TakeItScore badges. Each pill represents a sibling ticker; color indicates whether it confirms (green) or contradicts (red) the lottery row's direction. Tooltip on hover shows the underlying convexity ratio.
- **Sketch:**

  ```text
  Lottery row (existing):
  AAPL  240C  $5.50  prob: 0.72  [Δ flow] [γ wall] [+lottery cofire]
                                                   ▲
                                                   Add inline:
  [SPY+✓] [QQQ+✓] [IWM−✗]
  ```

  Logic: SPY/QQQ confirming the AAPL call direction → both pills green; IWM diverging → red. Adds a one-glance "is the broader tape with this trade?" signal.

## Phases / Files

### Phase 1 — Shared infrastructure (4 files)

- `api/gexbot.ts` — single GET endpoint, dispatch by `?view=` query param (`view=snapshots-latest|maxchange-winners|charm-clock|sibling-confirm`)
- `api/_lib/gexbot-queries.ts` — read helpers: `getLatestSnapshots()`, `getMaxchangeWinners(windowMin)`, `getCharmProjections()`, `getSiblingConfirmation(ticker, side)`
- `api/_lib/validation/market-data.ts` — add Zod schema for the `?view=` discriminated union
- `src/hooks/useGexbotData.ts` — polled hook (30s cadence, gated on `marketOpen`), returns typed view-shaped data

### Phase 2 — Wave 2 small tiles (each is one phase, 5 files each)

- 2a. **VIX Dealer-State Badge** (validates the pipeline first):
  - `src/components/Gexbot/VixDealerStateBadge.tsx`
  - `src/__tests__/VixDealerStateBadge.test.tsx`
  - Section-level placeholder `src/components/Gexbot/GexbotSection.tsx` (skeleton with just this badge for v0)
  - `src/components/Gexbot/types.ts`
  - `src/main.tsx` (mount section in App.tsx)
- 2b. **Charm Clock** — adds `CharmClock.tsx` + test + slot into GexbotSection
- 2c. **Long/Short Gamma Compass** — adds `GammaCompass.tsx` + test + slot
- 2d. **DEXoflow Velocity Tape** — adds `DexoflowVelocityTape.tsx` + test + slot

### Phase 3 — Wave 3 larger visualizations (each one phase, 4-5 files each)

- 3a. **Cross-Asset Convexity Matrix** — adds `ConvexityMatrix.tsx` + tiny `Sparkline.tsx` helper if needed + test + slot
- 3b. **Cross-Asset Skew Dashboard** — adds `CrossAssetSkewDashboard.tsx` + test + slot. Bar chart via lightweight-charts (already a dep) or pure SVG
- 3c. **Strike-Mover Ticker** — adds `StrikeMoverTicker.tsx` + test + slot (mounts at top of `<GexbotSection />`)

### Phase 4 — Sibling-Asset Confirmation Bar (5 files)

- `src/components/Gexbot/SiblingAssetConfirmationBar.tsx`
- `src/__tests__/SiblingAssetConfirmationBar.test.tsx`
- `src/components/LotteryFinder/LotteryFinderSection.tsx` — wire inline next to existing TakeItScore badges
- `src/components/SilentBoom/SilentBoomSection.tsx` — same wiring
- Lottery/SilentBoom row types may need an extension to carry the bar's payload

### Phase 5 — Verify

- `npm run review` after each phase (tsc + eslint + prettier + vitest)
- Manual smoke test against empty-state rendering (no data) before Monday

### Phase 6 — Code review subagent on diff per phase

### Phase 7 — Commit + push per phase

---

## Open questions

None — design decisions all locked.

## Thresholds / constants

| Constant               | Value                                                                                                   | Location                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Frontend poll interval | 30 s                                                                                                    | `useGexbotData`              |
| Stale-data threshold   | 5 min (any tile whose `captured_at` is older shows "stale" indicator)                                   | `useGexbotData`              |
| Sibling-asset groups   | `{ broad: [SPY,QQQ,IWM,NDX,SPX], vol: [VIX,UVXY], bonds: [TLT,HYG], metals: [GLD,SLV], energy: [USO] }` | `api/_lib/gexbot-queries.ts` |
| Charm projection scale | TBD — calibrate after first week of data                                                                | `CharmClock`                 |
| Empty-state copy       | "Awaiting first GEXBot tick — capture pipeline starts Monday 13:00 UTC"                                 | shared component             |

## Risk notes

- **Data is empty until Monday 13:00 UTC.** Every component must render
  an empty-state skeleton without crashing.
- **`zcharm` projection scale is uncalibrated.** The Charm Clock's
  projected drift formula `(zcharm × hours_left) / spot / 1e9` is a
  first-cut guess. After first week of data, regress projected vs
  realized drift to recover the proper scaling.
- **`zcvr` / `zgr` semantics are spec-undocumented.** The Convexity
  Matrix renders the raw value; color thresholds (what counts as
  "abnormally high convexity") need a week of distribution data
  before they can be set meaningfully. v0 uses naive 3-band heatmap
  on observed range; v1 will calibrate on observed quantiles.
- **Sibling confirmation logic is heuristic.** Direction of `zcvr` or
  `delta_risk_reversal` ≠ direction of the underlying. Needs
  validation that "SPY zcvr rising" reliably maps to "broad market
  call pressure rising" before this signal influences any decision.
- **Polling cost.** 30s polling × 8 components from one shared hook
  = 2 requests/min during market hours = ~16K reads/day. Negligible
  on Neon Free plan limits.
- **CSP / bot-protection.** New `/api/gexbot` endpoint needs to be
  added to the `protect` array in `src/main.tsx`'s `initBotId()`
  call (per CLAUDE.md backend pattern).

## Acceptance criteria

- All 8 components render without errors in the empty-data state
- After Monday 13:00 UTC tick lands, each component shows live data
  within 60 seconds (30s poll + 30s data-fetch buffer)
- `npm run review` passes after each phase commit
- Sibling-Asset Confirmation Bar visibly augments lottery/silent-boom
  rows without crowding the existing TakeItScore SHAP badges
- Polling pauses outside market hours (gated on `marketOpen`)
