# 0DTE Options Strike Calculator

A Black-Scholes-based calculator for determining delta-targeted strike prices, theoretical option premiums, credit spread P&L, iron condor profiles, and VIX regime-aware position guidance for same-day (0DTE) SPX and SPY options. Built with React, TypeScript (strict mode), and Vite.

Live at: [options-strike-calculator.vercel.app](https://options-strike-calculator.vercel.app/)

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Market Regime Intelligence](#market-regime-intelligence)
- [The Math](#the-math)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Configuration & Constants](#configuration--constants)
- [VIX Data Management](#vix-data-management)
- [Excel Export](#excel-export)
- [Testing](#testing)
- [Deployment](#deployment)
- [Accessibility](#accessibility)
- [Scripts Reference](#scripts-reference)
- [Technical Decisions](#technical-decisions)
- [Trading Workflow](#trading-workflow)
- [Position Sizing Guide](#position-sizing-guide)
- [Accuracy & Limitations](#accuracy--limitations)

---

## Overview

This tool solves a specific problem for 0DTE options traders: given a spot price, time of day, and implied volatility, where should your delta-targeted strikes be, what are the theoretical premiums, what does your iron condor P&L look like, and what delta ceiling should you respect based on today's VIX regime, term structure, volatility clustering, and day-of-week effects?

It computes everything client-side with zero external API dependencies. You input the current SPY price, the VIX (plus optionally VIX1D and VIX9D), and the time — and it gives you:

- A complete strike table across 6 delta targets (5Δ through 20Δ) with theoretical put and call premiums
- A full iron condor breakdown split into put spread, call spread, and combined IC — with credit, max loss, buying power, return on risk, probability of profit, and breakevens in both SPX and SPY terms
- **A Delta Guide with a ceiling recommendation** based on 9,102 days of historical VIX-to-SPX range data, adjusted for day-of-week effects and volatility clustering
- **VIX term structure signals** (VIX1D/VIX and VIX9D/VIX ratios) for pre-market risk assessment
- **Opening range check** comparing the first 30 minutes of trading against the expected daily range
- **Volatility clustering analysis** showing how yesterday's range predicts today's range
- An adjustable contracts counter to see dollar-denominated P&L at any position size
- A one-click Excel export comparing all 7 wing widths × 6 deltas × 3 trade structures with monthly P&L projections and recovery metrics

---

## Features

### Strike Calculation

- **All 6 delta targets simultaneously**: 5Δ, 8Δ, 10Δ, 12Δ, 15Δ, 20Δ
- **SPX and SPY strikes**: Both calculated and displayed, with SPX snapped to nearest 5-pt and SPY snapped to nearest $1 (tradeable increments)
- **Put skew adjustment**: Configurable 0–8% IV asymmetry between puts and calls to model the volatility smile
- **Theoretical option premiums**: Black-Scholes pricing for puts and calls at every delta, displayed as "Put $" and "Call $" columns in the strike table

### SPY/SPX Conversion

- **SPY price input**: Primary input designed for reading directly from Market Tide
- **Optional SPX input**: Enter the actual SPX price to derive the exact SPX/SPY ratio
- **Configurable ratio slider**: 9.95–10.05 range for manual ratio adjustment when SPX price isn't available
- **Auto-derived ratio**: When both prices are entered, the ratio is computed automatically to 4 decimal places

### IV Input

- **VIX mode**: Enter VIX value with a configurable 0DTE adjustment multiplier (default 1.15×, range 1.0–1.3×) to account for the fact that 0DTE IV is typically 10–20% higher than 30-day VIX
- **Direct IV mode**: Enter σ directly as a decimal for traders with access to actual 0DTE IV data (or use the VIX1D → Direct IV button)
- **Explanation tooltip**: The "?" button on the 0DTE adjustment field explains the VIX-to-IV conversion with worked examples

### Iron Condor & Credit Spread Analysis

- **Full 4-leg structure**: Long put, short put, short call, long call — all with SPX and SPY strikes
- **Wing width selection**: 5, 10, 15, 20, 25, 30, or 50 SPX points
- **Contracts counter**: Adjustable 1–999 with +/− stepper to see total dollar impact at any position size
- **Per-side spread breakdown**: Each delta row shows three sub-rows:
  - **Put Credit Spread**: Sell short put / buy long put — credit, max loss, buying power, RoR, PoP, breakeven
  - **Call Credit Spread**: Sell short call / buy long call — same metrics
  - **Iron Condor (combined)**: Both spreads combined with aggregate P&L and dual breakevens
- **Dual breakeven display**: Both SPX BE and SPY BE columns so you can cross-reference with Market Tide's SPY price chart
- **Dollar-denominated P&L**: All values shown with SPX $100 multiplier × contracts applied, with SPX points shown underneath

### Hedge Calculator

- **Protective long options**: Recommends hedge strikes and costs for each IC delta
- **Net credit after hedge**: Shows the adjusted credit and its impact on recovery metrics
- **Scenario table**: Expandable P&L at various SPX moves including the hedge payoff

### Probability of Profit (PoP)

- **Iron condor PoP**: Uses the correct formula `P(S_T > BE_low) + P(S_T < BE_high) − 1`, NOT the product of individual spread PoPs (which double-counts the overlap)
- **Individual spread PoPs**: Single-tail probabilities for each side — always higher than the combined IC PoP
- **Skew-adjusted**: Put-side uses `putSigma` for lower breakeven, call-side uses `callSigma` for upper breakeven

### Excel Export

- **One-click download**: Generates an XLSX file comparing all 7 wing widths × 6 deltas × 3 trade structures
- **Sheet 1 — P&L Comparison**: 126 rows with credit, max loss, buying power, RoR, PoP, wins to recover, breakevens, monthly P&L projections for every combination
- **Sheet 2 — IC Summary**: Pivot-friendly iron condor rows with per-side credit and PoP breakdowns
- **Sheet 3 — Inputs**: Snapshot of all parameters used for the export (spot, σ, T, skew, contracts, etc.) with methodology notes
- **Monthly projections**: Estimated monthly wins/losses, profit/loss dollars, and net P&L based on 22 trading days × PoP
- **Wins to Recover**: Max loss ÷ credit — shows how many winning trades needed to offset one full loss at each delta

### Historical VIX Data

- **Built-in dataset**: 9,137 days of VIX OHLC data (January 1990 through March 2026) ships with the app — works on first load with zero setup
- **CSV upload**: Load any VIX OHLC CSV file (supports `YYYY-MM-DD` and `MM/DD/YYYY` date formats) to extend or override built-in data
- **Date lookup**: Select a date to auto-populate VIX from historical data
- **OHLC display**: Shows Open, High, Low, Close for the selected date
- **Smart field selection**: Auto-selects Open for AM entries, Close for PM entries, or manually pick any OHLC value
- **Three-tier data loading**: localStorage cache (instant) → static JSON (first load) → manual CSV upload (override)
- **Persistent caching**: Uploaded data and built-in data are cached in localStorage — survives page refreshes and browser restarts

### UI

- **Light and dark modes**: Full theme toggle with WCAG AA contrast in both modes
- **508 accessibility compliance**: ARIA labels, roles, focus management, keyboard navigation, screen reader support
- **Responsive**: Works on desktop and mobile
- **Debounced inputs**: Text fields recalculate after 250ms pause; dropdowns and sliders update instantly

---

## Market Regime Intelligence

The calculator includes a comprehensive market regime analysis system built on 9,102 matched VIX/SPX trading days (1990–2026). This goes beyond simple strike placement to answer: *should I trade today, and if so, how aggressively?*

### VIX Regime Card

Compact inline card showing the current VIX regime (Green / Caution / Elevated / Extreme) with historical statistics for that level — median range, 90th percentile range, median open-to-close move, and an actionable advice line.

### Delta Guide

The core decision tool. Given today's VIX, entry time, and historical range data:

- **Ceiling recommendation**: The maximum delta you should sell for ~90% settlement (close-to-close) survival. Explicitly labeled as a ceiling, not a target. Example: "10Δ is the most aggressive you should sell."
- **Three-tier guidance**: Aggressive (ceiling), Moderate (90% intraday safe), Conservative (extra cushion) — shown side by side so you see the full spectrum.
- **Range → Delta table**: Four historical thresholds (median O→C, median H-L, 90th O→C, 90th H-L) mapped to concrete put/call deltas using live Black-Scholes parameters.
- **Your Deltas vs. Regime matrix**: Checkmark/cross grid showing whether each of your 6 standard deltas clears each historical threshold.
- **Continuous interpolation**: Range thresholds use per-point VIX data (VIX 10–30) with linear interpolation, avoiding discrete jumps at bucket boundaries.
- **Day-of-week adjustment**: Monday ranges are ~6% narrower than average, Thursday ~4% wider. Computed from historical data and applied automatically based on the selected date.
- **Volatility clustering adjustment**: When yesterday's range was extreme (>p90), today's expected range multiplier is applied automatically. At VIX 25+, this can widen thresholds by up to 87%.
- **VIX-derived σ**: The Delta Guide always computes its own σ from VIX × 1.15, independent of whether you switched to Direct IV (VIX1D) for strike pricing. This keeps the regime thresholds and delta computation self-consistent.

### VIX Term Structure

Pre-market risk assessment using the VIX term structure:

- **VIX1D / VIX ratio**: Compares today's implied vol (from 0DTE options) to the 30-day average. Signals: CALM (<0.85), NORMAL (0.85–1.15), ELEVATED (1.15–1.50), EVENT RISK (>1.50).
- **VIX9D / VIX ratio**: Compares near-term (9-day) to 30-day vol. Signals: CONTANGO (<0.90), FLAT (0.90–1.10), INVERTED (1.10–1.25), STEEP INVERSION (>1.25).
- **Combined signal**: Worst-of logic — if either ratio triggers a higher severity, the banner reflects it (GREEN LIGHT / PROCEED / CAUTION / HIGH ALERT).
- **VIX1D as σ button**: Since VIX1D is derived directly from today's 0DTE options, you can use it as your σ with no adjustment needed. One-click switches to Direct IV mode with VIX1D/100 filled in.

### Opening Range Check

Compares the first ~30 minutes of SPX trading range against the expected daily range:

- **Two inputs**: SPX 30-min high and low (from your chart at ~10:00 AM ET)
- **Signal**: GREEN (range intact, <40% consumed → add positions), YELLOW (moderate, 40–65% → tighter deltas), RED (exhausted, >65% → skip second entry)
- **Consumption bars**: Visual showing what percentage of median and 90th percentile daily ranges have been used
- **DOW-adjusted**: Expected ranges account for the day of week

### Volatility Clustering

Checks if yesterday's range predicts a wider day today:

- **Three inputs**: Yesterday's SPX open, high, low
- **Signal**: TAILWIND (calm yesterday → quieter today, mult 0.89–0.96x), NEUTRAL (typical, 0.97–1.01x), CLUSTERING (active, 1.04–1.19x), HIGH CLUSTERING (extreme, 1.20–1.87x)
- **Automatic Delta Guide integration**: The clustering multiplier flows directly into the Delta Guide's range thresholds, adjusting the ceiling without any manual math
- **Percentile reference bar**: Visual showing where yesterday's range fell relative to p50/p75/p90 for the current VIX regime

### Historical Range Analysis

Full expandable section with:

- **SPX range by VIX level table**: 8 VIX buckets with median H-L, 90th H-L, median O→C, percentage of days exceeding 1% and 2% ranges
- **Iron condor survival heatmap**: Settlement and intraday survival rates for ±0.50% through ±2.00% wings across all VIX buckets. Toggle between settlement (open-to-close) and intraday (high-low) views.
- **Fine-grained VIX breakdown**: Per-point bar chart for VIX 10–30 showing median range with 90th percentile ghost bars and point equivalents

---

## The Math

### Strike Calculation Formula

For a delta target D with z-score z = N⁻¹(1 − D/100):

```text
K_put  = S × e^(−z × σ_put  × √T)
K_call = S × e^(+z × σ_call × √T)
```

Where:

- `S` = SPX spot price (derived from SPY × ratio)
- `σ_put` = σ × (1 + skew) — put IV is adjusted upward for the volatility smile
- `σ_call` = σ × (1 − skew) — call IV is adjusted downward
- `T` = hours remaining ÷ 1638 (annualized time-to-expiry)
- `1638` = 6.5 trading hours × 252 trading days
- `r` = 0 (negligible for 0DTE)

### Z-Scores by Delta

| Delta | Z-Score | Source      |
|-------|---------|-------------|
| 5     | 1.645   | N^-1(0.95)  |
| 8     | 1.405   | N^-1(0.92)  |
| 10    | 1.280   | N^-1(0.90)  |
| 12    | 1.175   | N^-1(0.88)  |
| 15    | 1.036   | N^-1(0.85)  |
| 20    | 0.842   | N^-1(0.80)  |

### Option Pricing (Black-Scholes)

```text
d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

Call = S·N(d1) − K·N(d2)
Put  = K·N(−d2) − S·N(−d1)
```

The cumulative normal distribution N(x) is implemented using the Abramowitz & Stegun 26.2.17 rational approximation with error < 7.5 × 10⁻⁸. No external math libraries are used.

### Iron Condor P&L

```text
Credit     = (short_put_premium − long_put_premium) + (short_call_premium − long_call_premium)
Max Profit = credit
Max Loss   = wing_width − credit
BE Low     = short_put − credit
BE High    = short_call + credit
RoR        = credit ÷ max_loss
```

### Credit Spread P&L (per side)

```text
Put Spread:
  Credit   = short_put_premium − long_put_premium
  Max Loss = wing_width − put_credit
  BE       = short_put − put_credit
  PoP      = P(S_T > BE)    ← single-tail probability

Call Spread:
  Credit   = short_call_premium − long_call_premium
  Max Loss = wing_width − call_credit
  BE       = short_call + call_credit
  PoP      = P(S_T < BE)    ← single-tail probability
```

Individual spread PoPs are always higher than the combined IC PoP because each spread only needs price to stay on one side of one breakeven.

### Iron Condor Probability of Profit

```text
PoP = P(S_T > BE_low) + P(S_T < BE_high) − 1
```

This is NOT the product of individual spread PoPs (which would double-count the overlapping profit zone). Each probability uses the log-normal d2 with skew-adjusted σ for the respective tail.

### Single Spread Probability of Profit

```text
d2 = [ln(S/K) − (σ²/2)·T] / (σ·√T)

Put credit spread:   PoP = N(d2)     where K = put breakeven
Call credit spread:  PoP = N(−d2)    where K = call breakeven
```

### Delta Guide — Range-to-Delta Mapping

For each historical range threshold (e.g., 90th percentile O→C = 2.14%):

```text
1. putStrike = spot × (1 − threshold/100)
2. z ≈ threshold / (σ × √T)                          ← approximate z for skew scaling
3. putSigma = σ × (1 + skew × min(z, 3) / 1.28)     ← skew-adjusted σ
4. putDelta = N(d1) where d1 from BS(spot, putStrike, putSigma, T)
5. maxDelta = min(putDelta, callDelta) × 100          ← the ceiling
```

σ is always computed as VIX × 1.15 / 100 (independent of the user's IV mode) to keep the delta guide self-consistent with VIX-based range thresholds.

### Range Threshold Adjustments

The base range thresholds from per-point VIX interpolation are multiplied by two adjustment factors:

```text
adjustedThreshold = baseThreshold × DOW_multiplier × clustering_multiplier
```

- **DOW multiplier**: Monday ~0.94x (quieter), Thursday ~1.04x (wider), others ~1.0x
- **Clustering multiplier**: Based on yesterday's range percentile. After a p90 day at VIX 25+, today's multiplier is 1.87x.

### Time-to-Expiry

```text
T = hours_remaining / (6.5 × 252)
```

Market hours: 9:30 AM – 4:00 PM Eastern (6.5 hours). Times outside this range are rejected. Central Time is converted to Eastern automatically.

### IV Resolution

```text
VIX mode:    σ = VIX × multiplier / 100
Direct mode: σ = user input (as decimal)
```

The default multiplier (1.15) accounts for the empirical observation that 0DTE IV runs 10–20% above 30-day VIX. For more accurate strike pricing, use VIX1D directly via the "Use VIX1D as σ" button (sets σ = VIX1D / 100 with no multiplier needed).

### Buying Power

```text
Buying Power = Max Loss = Wing Width − Credit Received
```

For an iron condor, the broker holds margin on one side only (SPX can't breach both sides simultaneously). The buying power impact equals your max loss — the capital your broker holds as margin for the duration of the trade.

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
npm install
```

### Development

```bash
npm run dev
```

Opens at `http://localhost:5173`. The app loads with 9,137 days of built-in VIX data automatically.

### Build

```bash
npm run build
```

Outputs to `dist/`.

### Update Historical VIX Data (Optional)

If you have a newer VIX OHLC CSV file:

```bash
node scripts/convert-vix-csv.mjs path/to/your-vix-data.csv
```

This converts the CSV to `public/vix-data.json`, which ships with the app. The CSV should have columns: `Date, Open, High, Low, Close`. Both `YYYY-MM-DD` and `MM/DD/YYYY` date formats are supported.

---

## Project Structure

```text
├── public/
│   └── vix-data.json                  # 9,137 days of built-in VIX OHLC data (1990–2026)
├── scripts/
│   └── convert-vix-csv.mjs            # One-time CSV → JSON converter
├── src/
│   ├── __tests__/
│   │   ├── App.test.tsx               # Component tests (55 tests)
│   │   ├── calculator.test.ts         # Strike calc, matrix, properties (132 tests)
│   │   ├── csvParser.test.ts          # CSV parsing (13 tests)
│   │   ├── DeltaRegimeGuide.test.tsx  # Delta guide, DOW, clustering (51+ tests)
│   │   ├── exportXlsx.test.ts         # Excel export (33 tests)
│   │   ├── hedge.test.tsx             # Hedge calculator (32 tests)
│   │   ├── OpeningRangeCheck.test.tsx  # Opening range analysis
│   │   ├── pricing.test.ts            # Black-Scholes & normalCDF (39 tests)
│   │   ├── resolveIV.test.ts          # IV resolution (25 tests)
│   │   ├── skewAndIC.test.ts          # Skew, IC, spreads, PoP (56 tests)
│   │   ├── timeValidation.test.ts     # Market hours boundaries (20 tests)
│   │   ├── VIXRangeAnalysis.test.tsx  # Range analysis component (53 tests)
│   │   ├── VIXRegimeCard.test.tsx     # Regime card component (39 tests)
│   │   ├── VIXTermStructure.test.tsx  # Term structure signals (30 tests)
│   │   ├── vixRangeStats.test.ts      # Stats data + helpers (58+ tests)
│   │   ├── vixStorage.test.ts         # Storage layer (19 tests)
│   │   ├── VolatilityCluster.test.tsx # Clustering component
│   │   └── setup.ts                   # Vitest setup
│   ├── components/
│   │   ├── DeltaRegimeGuide.tsx       # Delta ceiling with DOW + clustering adjustments
│   │   ├── DeltaStrikesTable.tsx      # Strike table with premiums and Greeks
│   │   ├── IronCondorSection.tsx      # IC legs table and P&L profile
│   │   ├── OpeningRangeCheck.tsx      # First-30-min range signal
│   │   ├── ParameterSummary.tsx       # Calculation parameter display
│   │   ├── ui.tsx                     # Shared UI helpers
│   │   ├── VIXRangeAnalysis.tsx       # Full regime analysis with survival heatmap
│   │   ├── VIXRegimeCard.tsx          # Compact regime context card
│   │   ├── VIXTermStructure.tsx       # VIX1D/VIX9D term structure panel
│   │   └── VolatilityCluster.tsx      # Yesterday's range clustering signal
│   ├── constants/
│   │   └── index.ts                   # Named constants (no magic numbers)
│   ├── data/
│   │   └── vixRangeStats.ts           # Pre-computed VIX→SPX range stats, DOW data, clustering data
│   ├── themes/
│   │   └── index.ts                   # Light/dark theme definitions
│   ├── types/
│   │   └── index.ts                   # TypeScript type definitions
│   ├── utils/
│   │   ├── calculator.ts              # Pure calculation functions (Black-Scholes, strikes, IC, PoP)
│   │   ├── csvParser.ts               # VIX CSV parser
│   │   ├── exportXlsx.ts              # Excel export (multi-sheet wing width comparison)
│   │   └── vixStorage.ts              # localStorage cache + static JSON loader
│   ├── App.tsx                        # Main React component
│   ├── main.tsx                       # React entry point
│   └── vite-env.d.ts                  # Vite type declarations
├── .dockerignore
├── .gitattributes
├── .gitignore
├── Dockerfile                         # Multi-stage: Node build → nginx serve
├── index.html                         # HTML entry point
├── package.json
├── tsconfig.json                      # TypeScript strict mode config
└── vite.config.ts                     # Vite + Vitest config
```

---

## Architecture

### Separation of Concerns

The codebase follows a strict separation between pure calculation logic, data management, regime intelligence, UI components, and shared types:

**Pure functions** (`src/utils/calculator.ts`) — All financial math is in standalone, stateless functions with zero React dependencies. The module exports:

- `validateMarketTime()` — Time-to-expiry validation with hard rejection outside market hours
- `calcTimeToExpiry()` — Hours → annualized T conversion
- `resolveIV()` — Single funnel: both VIX and direct IV modes converge to one σ
- `calcStrikes()` — Put/call strikes for a single delta with optional skew
- `calcAllDeltas()` — All 6 deltas with premiums, SPY conversions, and snapped strikes
- `buildIronCondor()` — Full 4-leg IC with Black-Scholes pricing, per-side spread breakdown, and P&L profile
- `calcPoP()` — Probability of profit for an iron condor (two-tail)
- `calcSpreadPoP()` — Probability of profit for a single credit spread (one-tail)
- `normalCDF()` — Cumulative normal distribution (Abramowitz & Stegun)
- `blackScholesPrice()` — European option pricing with r=0
- `calcBSDelta()` — Black-Scholes delta for European options
- `calcScaledSkew()` — Z-scaled skew adjustment for the volatility smile
- `snapToIncrement()` — Round to nearest tradeable strike
- `to24Hour()` — 12h → 24h time conversion

**Pre-computed data** (`src/data/vixRangeStats.ts`) — Historical VIX-to-SPX range statistics derived from 9,102 matched trading days (1990–2026):

- `VIX_BUCKETS` — 8 broad VIX buckets with range percentiles, survival-relevant stats
- `SURVIVAL_DATA` — Iron condor survival rates across 6 wing widths × 8 VIX buckets, settlement and intraday
- `FINE_VIX_STATS` — Per-point VIX data (10–30) for continuous interpolation
- `DOW_STATS_*` — Day-of-week adjustment multipliers by VIX regime
- `CLUSTER_*` — Volatility clustering multipliers by VIX regime and yesterday's range percentile
- `estimateRange()` — Interpolates 4 range thresholds for any VIX value
- `getDowMultiplier()` — Returns DOW adjustment for a given VIX and day
- `getClusterMultiplier()` — Returns clustering adjustment for a given VIX and yesterday's range

**Regime components** (`src/components/`) — Purpose-built UI for each regime signal:

- `VIXRegimeCard` — Compact card with regime label, stats, and advice
- `VIXRangeAnalysis` — Full expandable analysis with survival heatmap and fine-grained breakdown
- `DeltaRegimeGuide` — Core delta ceiling calculator with DOW + clustering adjustments
- `VIXTermStructure` — VIX1D/VIX9D input and ratio signals
- `OpeningRangeCheck` — First-30-min range consumption analysis
- `VolatilityCluster` — Yesterday's range → today's range multiplier

**Strike/IC components** (`src/components/`) — Delta table, iron condor section, parameter summary, and shared UI helpers.

**Excel export** (`src/utils/exportXlsx.ts`) — Generates multi-sheet XLSX comparing all wing widths with P&L projections. Uses SheetJS for client-side spreadsheet generation.

**VIX data management** (`src/utils/vixStorage.ts`) — Three-tier loading: localStorage cache → static JSON → manual upload. All storage operations have try/catch for environments where localStorage isn't available.

**Types** (`src/types/index.ts`) — All interfaces are readonly, enforcing immutability throughout the calculation chain.

**Constants** (`src/constants/index.ts`) — Every magic number is named and documented. No raw numbers appear in formulas.

**Themes** (`src/themes/index.ts`) — Light and dark theme color definitions with WCAG AA contrast ratios.

**UI** (`src/App.tsx`) — Root React component managing state, inputs, and layout. All financial computations delegate to `src/utils/calculator.ts`.

### Data Flow

```text
SPY price ──→ × ratio ──→ SPX spot ──┐
                                      │
VIX ──→ resolveIV() ──→ σ ──────────┤
                                      ├──→ calcAllDeltas() ──→ DeltaRow[]
Time ──→ validateMarketTime() ──→ T ──┤                           │
                                      │                           ▼
Skew ────────────────────────────────┘               buildIronCondor() ──→ IronCondorLegs[]
                                                              │
                                                              ├──→ UI P&L table (put/call/IC per delta)
                                                              └──→ exportPnLComparison() ──→ XLSX download

VIX ──→ estimateRange(vix) ──→ range thresholds ──┐
                                                    │
DOW ──→ getDowMultiplier(vix, day) ──→ dow mult ──┤
                                                    ├──→ adjusted thresholds ──→ DeltaRegimeGuide
Yesterday ──→ getClusterMultiplier(vix, hl%) ──→ ──┤                              │
                                                    │                              ▼
VIX × 1.15 / 100 ──→ guide σ ─────────────────────┘               ceiling Δ + guidance tiers

VIX1D / VIX ──→ term structure signal ──┐
VIX9D / VIX ──→ term structure signal ──┤──→ combined pre-market risk signal
                                        │
30-min H-L / expected range ────────────┘──→ add-position go/no-go
```

### Recalculation Strategy

- **Text inputs** (price, VIX, IV, multiplier): Debounced at 250ms
- **Discrete controls** (delta, AM/PM, timezone, chips, sliders, contracts): Instant recalculation
- **Regime components**: Recalculate on VIX/date/spot change; clustering multiplier flows via callback
- **No memoization**: The entire calculation chain is ~10 microseconds; `useMemo` would add complexity for zero perceptible benefit

---

## Configuration & Constants

All configurable values are in `src/constants/index.ts`:

| Constant | Value | Purpose |
| -------- | ----- | ------- |
| `MARKET.HOURS_PER_DAY` | 6.5 | Regular trading session length |
| `MARKET.TRADING_DAYS_PER_YEAR` | 252 | US equity calendar |
| `MARKET.ANNUAL_TRADING_HOURS` | 1638 | 6.5 × 252 |
| `DEFAULTS.IV_PREMIUM_FACTOR` | 1.15 | Default 0DTE IV multiplier over VIX |
| `DEFAULTS.IV_PREMIUM_MIN` | 1.0 | Minimum allowed multiplier |
| `DEFAULTS.IV_PREMIUM_MAX` | 1.3 | Maximum allowed multiplier |
| `DEFAULTS.RISK_FREE_RATE` | 0 | Negligible for 0DTE |
| `DEFAULTS.STRIKE_INCREMENT` | 5 | SPX strike snap interval |

### Regime Thresholds (in `vixRangeStats.ts`)

| Signal | VIX1D/VIX | VIX9D/VIX |
| ------ | --------- | --------- |
| Calm / Contango | < 0.85 | < 0.90 |
| Normal / Flat | 0.85–1.15 | 0.90–1.10 |
| Elevated / Inverted | 1.15–1.50 | 1.10–1.25 |
| Event Risk / Steep | > 1.50 | > 1.25 |

---

## VIX Data Management

The app uses a three-tier strategy for VIX data:

### Tier 1: localStorage Cache (fastest)

On page load, the app checks `localStorage` for previously cached VIX data. This is populated either by a prior CSV upload or by the initial load of static data. Cached data loads instantly with zero network requests.

### Tier 2: Static JSON (first load)

If no cache exists, the app fetches `/vix-data.json` from the server. This file contains 9,137 days of VIX OHLC data (1990–2026) and ships with the app. On successful load, the data is cached to localStorage for subsequent visits.

### Tier 3: Manual CSV Upload (fallback/override)

The user can upload any VIX OHLC CSV. The uploaded data is merged with existing data (newer values override older ones) and the merged result is cached. The CSV parser handles:

- `YYYY-MM-DD` and `MM/DD/YYYY` date formats
- Case-insensitive headers
- `Adj Close` as an alias for `Close`
- Missing columns (filled with `null`)
- Whitespace trimming

### Updating the Built-in Data

```bash
node scripts/convert-vix-csv.mjs path/to/vix-data.csv
```

Output: `public/vix-data.json` — commit this file and deploy.

---

## Excel Export Details

The "Export All Wing Widths to Excel" button generates an XLSX file with three sheets:

### Sheet 1: P&L Comparison

Every combination of **7 wing widths × 6 deltas × 3 sides** = 126 rows:

| Column | Description |
| ------ | ----------- |
| Delta | 5Δ through 20Δ |
| Wing Width | 5, 10, 15, 20, 25, 30, 50 |
| Side | Put Spread, Call Spread, or Iron Condor |
| Credit (pts / $) | Premium received in SPX points and dollars |
| Max Loss (pts / $) | Maximum possible loss |
| Buying Power ($) | Capital held as margin (= max loss) |
| RoR (%) | Return on risk = credit ÷ max loss |
| PoP (%) | Probability of profit |
| Wins to Recover | Max loss ÷ credit — winning trades needed to offset one full loss |
| Breakeven | SPX price level where P&L = $0 |
| Short/Long Strike | Actual strike prices |
| Monthly Wins/Losses | 22 trading days × PoP |
| Monthly Profit/Loss ($) | Estimated monthly dollar P&L |
| Monthly Net ($) | Profit − Loss (theoretical, assumes no trade management) |

### Sheet 2: IC Summary

Iron condor rows only, one per delta × wing width. Includes per-side credits and PoPs as separate columns for pivot table analysis.

### Sheet 3: Inputs

Snapshot of every parameter: SPY, SPX, ratio, σ, skew, T, hours, contracts, multiplier. Plus methodology notes explaining that monthly net is theoretical (approximately zero per Black-Scholes) and that real edge comes from trade management.

---

## Testing

### Test Suite Overview

**700+ tests across 17+ test files**, all passing with TypeScript strict mode.

| File | Coverage Focus |
| ---- | -------------- |
| `calculator.test.ts` | Golden test case, full 6×3×3 matrix, property-based invariants, utilities |
| `App.test.tsx` | Component rendering, mode switching, validation, CSV upload, IC UI, contracts, spreads, dark mode, market regime toggle |
| `skewAndIC.test.ts` | Skew asymmetry, IC leg construction, P&L fields, PoP, per-side spreads, calcSpreadPoP |
| `exportXlsx.test.ts` | Excel export generation, sheet structure, data integrity |
| `resolveIV.test.ts` | VIX mode, direct mode, boundary values, edge cases, cross-mode equivalence |
| `timeValidation.test.ts` | Every market-hour boundary, precision checks, minute-by-minute monotonic sweep |
| `pricing.test.ts` | normalCDF properties, Black-Scholes sanity checks, put-call parity, scaling |
| `csvParser.test.ts` | Date formats, edge cases, 9k-row performance, whitespace handling |
| `hedge.test.tsx` | Hedge calculator rendering, recommendations, scenario table |
| `vixRangeStats.test.ts` | VIX bucket integrity, survival data, fine stats, estimateRange interpolation, DOW data, clustering data, multiplier functions |
| `VIXRegimeCard.test.tsx` | Regime card rendering across zones, stat display, theme support |
| `VIXRangeAnalysis.test.tsx` | Survival toggle, fine-grained toggle, table rendering, bucket highlighting |
| `DeltaRegimeGuide.test.tsx` | Ceiling recommendation, threshold table, delta matrix, continuous interpolation, DOW badges, clustering integration |
| `VIXTermStructure.test.tsx` | VIX1D/VIX9D ratio signals, combined signal, VIX1D as σ callback |
| `OpeningRangeCheck.test.tsx` | Range signals, VIX sensitivity, DOW adjustment, edge cases |
| `VolatilityCluster.test.tsx` | Clustering signals, multiplier callback, VIX sensitivity, percentile reference |
| `vixStorage.test.ts` | localStorage cache, static JSON loading |

### Test Philosophy

- **Full matrix coverage**: 6 deltas × 3 time scenarios × 3 IV levels = 54 combinations tested for structural correctness
- **Property-based tests**: Higher delta → narrower strikes, higher σ → wider strikes, less time → narrower strikes, put strike < spot < call strike
- **Boundary tests**: Every minute from market open to close verified for monotonic time decrease
- **Edge cases**: VIX = 0, negative values, NaN, undefined, multiplier boundaries, T = 0, σ = 0
- **Regime tests**: Continuous interpolation smoothness, DOW adjustment monotonicity, clustering multiplier integration, term structure signal classification
- **Spread-specific tests**: Put spread + call spread credits sum to IC total, individual spread PoP > IC PoP, breakevens between strikes, skew asymmetry
- **Component tests**: Full user interaction flows including CSV upload, date selection, IV mode switching, IC toggle, contracts counter, wing width selection, dark mode, spread sub-rows rendering, regime analysis sections

### Running Tests

```bash
# Watch mode (terminal)
npm test

# Interactive browser UI
npm run test:ui

# Single run (CI)
npm run test:run

# Coverage report
npm run test:coverage
```

---

## Deployment

### Vercel (Production)

The app is deployed to Vercel via GitHub integration with automatic deployments on push to `main`.

**Live URL**: [options-strike-calculator.vercel.app](https://options-strike-calculator.vercel.app/)

Vercel auto-detects the Vite framework and uses these settings:

- **Build command**: `npm run build`
- **Output directory**: `dist`
- **Node.js version**: 18+

Every push to `main` triggers a production deployment. Pull requests get preview deployments automatically.

### Docker

```bash
# Build
docker build -t strike-calc .

# Run
docker run -p 3000:80 strike-calc
```

The Dockerfile uses a two-stage build:

1. **Build stage**: `node:24-alpine` runs `npm ci` and `npm run build`
2. **Production stage**: `nginx:1.28-alpine-slim` serves the static output with SPA routing, gzip compression, and 1-year cache headers on assets

---

## Accessibility

The application targets Section 508 / WCAG AA compliance:

- **Semantic HTML**: Proper use of `<header>`, `<main>`, `<section>`, `<table>`, `<fieldset>`, `<legend>`
- **ARIA attributes**: `role="radiogroup"`, `role="radio"`, `aria-checked`, `aria-invalid`, `aria-describedby`, `aria-expanded`, `role="tooltip"`, `aria-label` on all interactive elements, `aria-live="polite"` on dynamic content
- **Focus management**: 3px focus outlines on all interactive elements, visible skip-to-results link for keyboard users
- **Color contrast**: All text meets WCAG AA minimums (4.5:1 for normal text, 3:1 for large text) in both light and dark modes
- **Error handling**: Errors use `role="alert"` for screen reader announcement and are linked to inputs via `aria-describedby`
- **Reduced motion**: `@media (prefers-reduced-motion: reduce)` disables all transitions and animations
- **Input labels**: Every input has an associated `<label>` (visible or screen-reader-only)

---

## Scripts Reference

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start Vite dev server with HMR |
| `npm run build` | TypeScript check + Vite production build |
| `npm run preview` | Preview the production build locally |
| `npm test` | Vitest in watch mode |
| `npm run test:ui` | Vitest interactive browser dashboard |
| `npm run test:run` | Single test run (for CI) |
| `npm run test:coverage` | Generate v8 coverage report |
| `npm run lint` | TypeScript type check without emitting |
| `node scripts/convert-vix-csv.mjs <csv>` | Convert VIX CSV to static JSON |

---

## Technical Decisions

Key design decisions made during development, with rationale:

| Decision | Choice | Why |
| -------- | ------ | --- |
| Calc engine | Pure functions module | Testable, explicit, no class overhead |
| Component extraction | Separate files per section | Keeps App.tsx focused on state; components handle rendering |
| Delta support | All 6 via lookup table | Avoids inverse CDF dependency |
| IV input | Both VIX + Direct modes | Covers all user types; VIX1D button bridges the gap |
| SPX/SPY display | Always show both | No toggle friction |
| Magic numbers | Named constants | DRY, self-documenting |
| Time validation | Hard reject outside market hours | Prevents meaningless results |
| IV convergence | Single `resolveIV()` funnel | Eliminates conversion bugs |
| Strike rounding | Integer + nearest 5-pt snap | "Engineered enough" for ±5-15pt accuracy |
| Recalculation | Hybrid debounce | Instant for discrete, 250ms for text |
| Memoization | None | Math is ~10μs, not worth the complexity |
| Input parsing | Strict validation + errors | Explicit over clever |
| External math | Zero dependencies | Native `Math` handles everything |
| CDF implementation | Abramowitz & Stegun 26.2.17 | <7.5×10⁻⁸ error, 15 lines, no deps |
| Option pricing | Black-Scholes with r=0 | Standard model, negligible rate for 0DTE |
| PoP (IC) | Two-tail formula | Correct for IC (not product of spread PoPs) |
| PoP (spreads) | Single-tail formula | Each spread only needs one breakeven |
| P&L display | Split into put/call/combined | Supports directional spread trading |
| Breakevens | Dual SPX/SPY columns | Cross-reference with Market Tide SPY charts |
| Contracts | Adjustable counter with +/− | Instant dollar-denominated sizing |
| Excel export | All wing widths × all deltas | Side-by-side comparison for position sizing |
| Monthly projections | 22 days × PoP | Shows theoretical monthly P&L (approx. zero) |
| Wins to Recover | Max loss ÷ credit | Key metric for risk assessment |
| VIX data | Static JSON + localStorage cache | Works offline after first load |
| Built-in data | 9,137 days (1990–2026) | Zero setup required |
| Regime data | Pre-computed in vixRangeStats.ts | No runtime CSV parsing; instant lookups |
| Range interpolation | Per-point linear (VIX 10–30) | Avoids bucket boundary jumps |
| Delta Guide σ | VIX × 1.15 / 100 (internal) | Self-consistent with VIX-based thresholds |
| DOW adjustment | Historical multipliers per VIX regime | Monday 6% narrower, Thursday 4% wider |
| Clustering | Yesterday's range percentile → multiplier | Strongest signal at high VIX (up to 1.87x) |
| Term structure | VIX1D/VIX and VIX9D/VIX ratios | Pre-market risk assessment |
| Opening range | First 30-min vs expected daily | Go/no-go for second entry |
| Framework | Vite + React | Lightest viable toolchain |
| TypeScript | Strict mode | `noUncheckedIndexedAccess`, `noUnusedLocals`, etc. |
| Testing | Vitest + RTL | Fast, modern, good DX |
| Hosting | Vercel via GitHub | Push-to-deploy on main, preview deploys on PRs |
| Spreadsheet | SheetJS (xlsx) | Client-side Excel generation, ~200KB |
| Containerization | Docker (nginx alpine) | Two-stage build, SPA routing, gzip |

---

## Trading Workflow

This section documents the intended workflow combining the calculator with external tools. This is not financial advice.

### Recommended Tools

1. **This calculator** — Strike placement, premiums, P&L, sizing, regime guidance
2. **TradingView** — VIX, VIX1D, VIX9D panels for term structure; SPX charts for opening range
3. **Market Tide (Unusual Whales)** — Net premium flow for directional filtering
4. **Periscope (Unusual Whales)** — Market maker gamma exposure for strike validation

### Daily Workflow

```text
NIGHT BEFORE / PRE-MARKET:
  Enter yesterday's SPX OHLC → check Volatility Clustering signal
  Note: HIGH CLUSTERING → reduce size tomorrow
        TAILWIND → normal or slightly more aggressive

8:30 AM ET:  Open TradingView
             → Note VIX, VIX1D, VIX9D
             → Enter in calculator
             → Check term structure signal (GREEN LIGHT → proceed, HIGH ALERT → sit out)

9:30 AM ET:  Check Periscope gamma profile
             → Identify positive gamma zones (price suppression)
             → Identify negative gamma zones (price acceleration)
             → Note the 0DTE straddle breakeven cone

9:45 AM ET:  Check Market Tide
             → NCP and NPP parallel → ranging day → iron condor
             → NCP diverging up → bullish → sell put credit spread only
             → NPP diverging up → bearish → sell call credit spread only

8:45 AM CT:  FIRST ENTRY
             → Enter SPY price, VIX, time in calculator
             → Check Delta Guide ceiling (e.g. "≤10Δ")
             → Check DOW badge and clustering badge
             → Cross-reference short strikes against gamma profile
             → Verify short strikes are outside straddle cone
             → Size position within daily risk budget
             → Execute first IC
             → Set $0.50 debit limit close order immediately

10:00 AM ET: OPENING RANGE CHECK
             → Enter SPX 30-min high and low
             → GREEN (range intact) → proceed with second entry
             → YELLOW → tighter deltas or smaller size
             → RED (exhausted) → skip second entry

10:00-10:30: SECOND ENTRY (if opening range is green/yellow)
             → Re-check Delta Guide (ceiling will be lower due to less time)
             → Enter at or below new ceiling
             → Set $0.50 debit limit close order

During day:  Monitor positions
             → Close at 50% of max profit ($0.50 debit) if filled
             → Close at 2× credit loss if stopped
             → Do not re-enter after 2:00 PM ET

3:45 PM ET:  Remaining positions expire or close
             → Log result
```

### Structure Selection

| Market Tide Signal | Structure | Why |
| ------------------ | --------- | --- |
| NCP ≈ NPP (parallel) | Iron Condor | Ranging day, collect both sides |
| NCP >> NPP (diverging up) | Put Credit Spread | Bullish trend, no call exposure |
| NPP >> NCP (diverging up) | Call Credit Spread | Bearish trend, no put exposure |
| Both declining sharply | Sit out | High uncertainty, model less reliable |

### Regime Signal Stacking

Multiple signals can reinforce or conflict. When they conflict, always defer to the most cautious signal:

| Signal | Action |
| ------ | ------ |
| Term structure: GREEN LIGHT + Clustering: TAILWIND + DOW: Mon | Full size, standard deltas |
| Term structure: PROCEED + Clustering: NEUTRAL + DOW: avg | Standard — follow delta guide ceiling |
| Term structure: CAUTION + Clustering: any | Reduce size regardless of other signals |
| Clustering: HIGH CLUSTERING + any | Widen deltas or reduce size even if other signals are green |
| Term structure: HIGH ALERT + any | Consider sitting out entirely |
| Opening range: RED + any | Skip second entry |

---

## Position Sizing Guide

### Buying Power Budget

```text
Conservative:  5% of account per day  → survives 10+ consecutive max losses
Moderate:     10% of account per day  → survives 5+ consecutive max losses
Aggressive:   15% of account per day  → survives 3+ consecutive max losses
```

### Important: Correlation

Multiple positions on the same underlying and same expiration are NOT diversified. They lose on the same move. Always add up the total buying power of all same-day SPX positions — that total is your daily risk.

For genuine diversification, consider different underlyings (SPX + RUT + NDX) which have 65–75% correlation rather than 100%.

### Example Sizing

```text
Account: $200,000
Daily risk budget: 10% = $20,000

Option A: 8Δ, 5-pt wings, 50 contracts
  Credit: $3,676
  Buying power: $21,324
  PoP: 84%

Option B: 10Δ, 10-pt wings, 12 contracts
  Credit: $2,268
  Buying power: $9,732
  PoP: 80%

Option C: Laddered entries (recommended)
  8:45 AM: 8Δ × 20 contracts = $8,520 BP
  10:15 AM: 5Δ × 15 contracts = $6,780 BP
  Total: $15,300 BP (7.6% of account)
  Note: Second entry delta adjusted per delta guide at later time
```

---

## Accuracy & Limitations

The calculator provides strike placement accuracy of approximately ±5–15 SPX points. Sources of error, in order of impact:

1. **VIX vs actual 0DTE IV** (largest) — VIX measures 30-day IV. The adjustable multiplier compensates but cannot perfectly capture real-time 0DTE IV. Use the "Use VIX1D as σ" button for the most accurate strike pricing when VIX1D is available.
2. **Put/call skew** — The linear skew model (±N% on puts/calls) is a simplification of the real volatility smile. Actual skew varies by strike distance and market conditions.
3. **SPX/SPY ratio drift** — The ratio fluctuates due to ETF expense ratios, dividend timing, and NAV tracking. Enter the actual SPX price when available for maximum accuracy.
4. **Theoretical vs market premiums** — Black-Scholes prices assume continuous hedging and log-normal returns. Real option prices include bid/ask spreads, market maker edge, and supply/demand effects.
5. **Regime data limitations** — Historical range statistics are based on VIX open matched to same-day SPX OHLC. They don't account for event-day effects (CPI, FOMC, NFP), though the VIX1D term structure signal partially captures event pricing.
6. **Monthly projections** — The Excel export's monthly P&L assumes hold-to-expiration on every trade. Real results depend heavily on trade management (profit targets, stop losses, position sizing).
7. **Interest rate** — Assumed zero. Negligible for 0DTE but non-zero for longer durations.
8. **Dividends** — Not modeled. Minimal impact for SPX same-day calculations.

For practical 0DTE iron condor placement, credit spread analysis, regime assessment, and position sizing, these error sources are well within acceptable bounds. For live trading, always compare theoretical values against actual bid/ask quotes from your broker.
