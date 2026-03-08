# 0DTE Options Strike Calculator

A Black-Scholes-based calculator for determining delta-targeted strike prices, theoretical option premiums, and iron condor P&L profiles for same-day (0DTE) SPX and SPY options. Built with React, TypeScript (strict mode), and Vite.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [The Math](#the-math)
- [Getting Started](#getting-started)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Configuration & Constants](#configuration--constants)
- [VIX Data Management](#vix-data-management)
- [Testing](#testing)
- [Deployment](#deployment)
- [Accessibility](#accessibility)
- [Scripts Reference](#scripts-reference)
- [Technical Decisions](#technical-decisions)

---

## Overview

This tool solves a specific problem for 0DTE options traders: given a spot price, time of day, and implied volatility, where should your delta-targeted strikes be, what are the theoretical premiums, and what does your iron condor P&L look like?

It computes all of this client-side with zero external API dependencies. You input the current SPY price (from Market Tide, your broker, or any chart), the VIX or direct IV, and the time — and it gives you a complete strike table across 6 delta targets (5Δ through 20Δ) plus a full iron condor breakdown with credit, max loss, buying power, return on risk, probability of profit, and breakevens.

---

## Features

### Strike Calculation
- **All 6 delta targets simultaneously**: 5Δ, 8Δ, 10Δ, 12Δ, 15Δ, 20Δ
- **SPX and SPY strikes**: Both calculated and displayed, with SPX snapped to nearest 5-pt and SPY snapped to nearest $1 (tradeable increments)
- **Put skew adjustment**: Configurable 0–8% IV asymmetry between puts and calls to model the volatility smile
- **Theoretical option premiums**: Black-Scholes pricing for puts and calls at every delta

### SPY/SPX Conversion
- **SPY price input**: Primary input designed for reading directly from Market Tide
- **Optional SPX input**: Enter the actual SPX price to derive the exact SPX/SPY ratio
- **Configurable ratio slider**: 9.95–10.05 range for manual ratio adjustment when SPX price isn't available
- **Auto-derived ratio**: When both prices are entered, the ratio is computed automatically to 4 decimal places

### IV Input
- **VIX mode**: Enter VIX value with a configurable 0DTE adjustment multiplier (default 1.15×, range 1.0–1.3×) to account for the fact that 0DTE IV is typically 10–20% higher than 30-day VIX
- **Direct IV mode**: Enter σ directly as a decimal for traders with access to actual 0DTE IV data
- **Explanation tooltip**: The "?" button on the 0DTE adjustment field explains the VIX-to-IV conversion with worked examples

### Iron Condor Analysis
- **Full 4-leg structure**: Long put, short put, short call, long call — all with SPX and SPY strikes
- **Wing width selection**: 5, 10, 15, 20, 25, 30, or 50 SPX points
- **Contracts counter**: Adjustable 1–999 to see total dollar impact
- **P&L profile per delta**:
  - Credit received (SPX points and dollars)
  - Max profit = credit
  - Max loss = wing width − credit (SPX points and dollars)
  - Buying power = max loss in dollars (capital held as margin)
  - Return on risk (RoR) = credit ÷ max loss
  - Probability of profit (PoP) using the log-normal distribution with skew-adjusted σ per tail
  - Breakeven low and high

### Historical VIX Data
- **CSV upload**: Load any VIX OHLC CSV file (supports `YYYY-MM-DD` and `MM/DD/YYYY` date formats)
- **Date lookup**: Select a date to auto-populate VIX from historical data
- **OHLC display**: Shows Open, High, Low, Close for the selected date
- **Smart field selection**: Auto-selects Open for AM entries, Close for PM entries, or manually pick any OHLC value
- **Static JSON**: Ship built-in VIX data with the app for zero-friction first load
- **localStorage cache**: Uploaded data persists across browser sessions

### UI
- **Light and dark modes**: Full theme toggle with WCAG AA contrast in both modes
- **508 accessibility compliance**: ARIA labels, roles, focus management, keyboard navigation, screen reader support
- **Responsive**: Works on desktop and mobile
- **Debounced inputs**: Text fields recalculate after 250ms pause; dropdowns and sliders update instantly

---

## The Math

### Strike Calculation

For a delta target D with z-score z = N⁻¹(1 − D/100):

```
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

| Delta | Z-Score | Source |
|-------|---------|--------|
| 5     | 1.645   | N⁻¹(0.95) |
| 8     | 1.405   | N⁻¹(0.92) |
| 10    | 1.280   | N⁻¹(0.90) |
| 12    | 1.175   | N⁻¹(0.88) |
| 15    | 1.036   | N⁻¹(0.85) |
| 20    | 0.842   | N⁻¹(0.80) |

### Option Pricing (Black-Scholes)

```
d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

Call = S·N(d1) − K·N(d2)
Put  = K·N(−d2) − S·N(−d1)
```

The cumulative normal distribution N(x) is implemented using the Abramowitz & Stegun 26.2.17 rational approximation with error < 7.5 × 10⁻⁸. No external math libraries are used.

### Iron Condor P&L

```
Credit     = (short_put_premium − long_put_premium) + (short_call_premium − long_call_premium)
Max Profit = credit
Max Loss   = wing_width − credit
BE Low     = short_put − credit
BE High    = short_call + credit
RoR        = credit ÷ max_loss
```

### Probability of Profit

For an iron condor, PoP is the probability that the underlying stays between both breakevens at expiration:

```
PoP = P(S_T > BE_low) + P(S_T < BE_high) − 1
```

This is NOT the product of individual spread PoPs (which would double-count the overlap). Each probability uses the log-normal d2 with skew-adjusted σ for the respective tail.

### Time-to-Expiry

```
T = hours_remaining / (6.5 × 252)
```

Market hours: 9:30 AM – 4:00 PM Eastern (6.5 hours). Times outside this range are rejected. Central Time is converted to Eastern automatically.

### IV Resolution

```
VIX mode:    σ = VIX × multiplier / 100
Direct mode: σ = user input (as decimal)
```

The default multiplier (1.15) accounts for the empirical observation that 0DTE IV runs 10–20% above 30-day VIX. This is the largest source of estimation error in the model.

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

Opens at `http://localhost:5173`.

### Build

```bash
npm run build
```

Outputs to `dist/`.

### Load Historical VIX Data (Optional)

If you have a VIX OHLC CSV file:

```bash
node scripts/convert-vix-csv.mjs path/to/your-vix-data.csv
```

This converts the CSV to `public/vix-data.json`, which ships with the app and loads automatically on first visit. The CSV should have columns: `Date, Open, High, Low, Close`. Both `YYYY-MM-DD` and `MM/DD/YYYY` date formats are supported.

---

## Project Structure

```
├── public/
│   └── vix-data.json           # Static VIX data (auto-loaded on first visit)
├── scripts/
│   └── convert-vix-csv.mjs     # One-time CSV → JSON converter
├── src/
│   ├── __tests__/
│   │   ├── App.test.tsx         # Component tests (45 tests)
│   │   ├── calculator.test.ts   # Strike calc, matrix, properties (132 tests)
│   │   ├── csvParser.test.ts    # CSV parsing (13 tests)
│   │   ├── pricing.test.ts      # Black-Scholes & normalCDF (19 tests)
│   │   ├── resolveIV.test.ts    # IV resolution (25 tests)
│   │   ├── skewAndIC.test.ts    # Skew, IC legs, PoP (28 tests)
│   │   ├── timeValidation.test.ts # Market hours boundaries (20 tests)
│   │   └── setup.ts             # Vitest setup
│   ├── App.tsx                  # Main React component
│   ├── calculator.ts            # Pure calculation functions
│   ├── constants.ts             # Named constants (no magic numbers)
│   ├── csvParser.ts             # VIX CSV parser
│   ├── main.tsx                 # React entry point
│   ├── themes.ts                # Light/dark theme definitions
│   ├── types.ts                 # TypeScript type definitions
│   ├── vite-env.d.ts            # Vite type declarations
│   └── vixStorage.ts            # localStorage cache + static JSON loader
├── .dockerignore
├── .gitattributes
├── .gitignore
├── Dockerfile                   # Multi-stage: Node build → nginx serve
├── index.html                   # HTML entry point
├── package.json
├── tsconfig.json                # TypeScript strict mode config
└── vite.config.ts               # Vite + Vitest config
```

---

## Architecture

### Separation of Concerns

The codebase follows a strict separation between pure calculation logic and UI:

**Pure functions** (`calculator.ts`) — All financial math is in standalone, stateless functions with zero React dependencies. This makes them trivially testable and portable. The module exports:
- `validateMarketTime()` — Time-to-expiry validation with hard rejection outside market hours
- `calcTimeToExpiry()` — Hours → annualized T conversion
- `resolveIV()` — Single funnel: both VIX and direct IV modes converge to one σ
- `calcStrikes()` — Put/call strikes for a single delta with optional skew
- `calcAllDeltas()` — All 6 deltas with premiums, SPY conversions, and snapped strikes
- `buildIronCondor()` — Full 4-leg IC with Black-Scholes pricing and P&L profile
- `calcPoP()` — Probability of profit for an iron condor
- `normalCDF()` — Cumulative normal distribution (Abramowitz & Stegun)
- `blackScholesPrice()` — European option pricing with r=0
- `snapToIncrement()` — Round to nearest tradeable strike
- `to24Hour()` — 12h → 24h time conversion

**Types** (`types.ts`) — All interfaces are readonly, enforcing immutability throughout the calculation chain.

**Constants** (`constants.ts`) — Every magic number is named and documented. No raw numbers appear in formulas.

**UI** (`App.tsx`) — React component with inline styles. All financial computations delegate to `calculator.ts`. The component handles:
- Input state management with debounced text fields
- VIX data loading (localStorage → static JSON → manual upload)
- Theme switching
- Results rendering

### Data Flow

```
SPY price ──→ × ratio ──→ SPX spot ──┐
                                      │
VIX ──→ resolveIV() ──→ σ ──────────┤
                                      ├──→ calcAllDeltas() ──→ DeltaRow[]
Time ──→ validateMarketTime() ──→ T ──┤                           │
                                      │                           ▼
Skew ────────────────────────────────┘               buildIronCondor() ──→ IronCondorLegs[]
```

### Recalculation Strategy

- **Text inputs** (price, VIX, IV, multiplier): Debounced at 250ms
- **Discrete controls** (delta, AM/PM, timezone, chips, sliders): Instant recalculation
- **No memoization**: The entire calculation chain is ~10 microseconds; `useMemo` would add complexity for zero perceptible benefit

---

## Configuration & Constants

All configurable values are in `src/constants.ts`:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MARKET.HOURS_PER_DAY` | 6.5 | Regular trading session length |
| `MARKET.TRADING_DAYS_PER_YEAR` | 252 | US equity calendar |
| `MARKET.ANNUAL_TRADING_HOURS` | 1638 | 6.5 × 252 |
| `DEFAULTS.IV_PREMIUM_FACTOR` | 1.15 | Default 0DTE IV multiplier over VIX |
| `DEFAULTS.IV_PREMIUM_MIN` | 1.0 | Minimum allowed multiplier |
| `DEFAULTS.IV_PREMIUM_MAX` | 1.3 | Maximum allowed multiplier |
| `DEFAULTS.RISK_FREE_RATE` | 0 | Negligible for 0DTE |
| `DEFAULTS.STRIKE_INCREMENT` | 5 | SPX strike snap interval |

---

## VIX Data Management

The app uses a three-tier strategy for VIX data:

### Tier 1: localStorage Cache (fastest)
On page load, the app checks `localStorage` for previously cached VIX data. This is populated either by a prior CSV upload or by the initial load of static data. Cached data loads instantly with zero network requests.

### Tier 2: Static JSON (first load)
If no cache exists, the app fetches `/vix-data.json` from the server. This file is generated by running the conversion script and committed to the repo. On successful load, the data is cached to localStorage for subsequent visits.

### Tier 3: Manual CSV Upload (fallback/override)
The user can upload any VIX OHLC CSV. The uploaded data is merged with existing data and the merged result is cached. The CSV parser handles:
- `YYYY-MM-DD` and `MM/DD/YYYY` date formats
- Case-insensitive headers
- `Adj Close` as an alias for `Close`
- Missing columns (filled with `null`)
- Whitespace trimming

### Converting Your CSV

```bash
node scripts/convert-vix-csv.mjs path/to/vix-data.csv
```

Output: `public/vix-data.json` — commit this file and deploy.

---

## Testing

### Test Suite Overview

**282 tests across 7 test files**, all passing with TypeScript strict mode.

| File | Tests | Coverage Focus |
|------|-------|---------------|
| `calculator.test.ts` | 132 | Golden test case, full 6×3×3 matrix, property-based invariants, utilities |
| `App.test.tsx` | 45 | Component rendering, mode switching, validation, CSV upload, IC UI, contracts |
| `skewAndIC.test.ts` | 28 | Skew asymmetry, IC leg construction, P&L fields, PoP properties |
| `resolveIV.test.ts` | 25 | VIX mode, direct mode, boundary values, edge cases, cross-mode equivalence |
| `timeValidation.test.ts` | 20 | Every market-hour boundary, precision checks, minute-by-minute monotonic sweep |
| `pricing.test.ts` | 19 | normalCDF properties, Black-Scholes sanity checks, put-call parity, scaling |
| `csvParser.test.ts` | 13 | Date formats, edge cases, 9k-row performance, whitespace handling |

### Test Philosophy

- **Full matrix coverage**: 6 deltas × 3 time scenarios × 3 IV levels = 54 combinations tested for structural correctness
- **Property-based tests**: Higher delta → narrower strikes, higher σ → wider strikes, less time → narrower strikes, put strike < spot < call strike
- **Boundary tests**: Every minute from market open to close verified for monotonic time decrease
- **Edge cases**: VIX = 0, negative values, NaN, undefined, multiplier boundaries, T = 0, σ = 0
- **Component tests**: Full user interaction flows including CSV upload, date selection, IV mode switching, IC toggle, contracts counter

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

### Coverage

```
File           | % Stmts | % Branch | % Funcs | % Lines
---------------|---------|----------|---------|--------
All files      |   97.95 |    88.55 |      75 |   97.95
 App.tsx       |   98.85 |    86.43 |   65.71 |   98.85
 calculator.ts |   98.20 |    95.38 |    100  |   98.20
 constants.ts  |    100  |     100  |    100  |    100
 csvParser.ts  |    100  |    90.32 |    100  |    100
 themes.ts     |    100  |     100  |    100  |    100
```

---

## Deployment

### Vercel (Recommended)

The project is configured for Vercel out of the box:

1. Push to GitHub
2. Import the repo in Vercel
3. Framework: Vite (auto-detected)
4. Build command: `npm run build`
5. Output directory: `dist`
6. Deploy

### Docker

```bash
# Build
docker build -t strike-calc .

# Run
docker run -p 3000:80 strike-calc
```

The Dockerfile uses a two-stage build:
1. **Build stage**: `node:20-alpine` runs `npm ci` and `npm run build`
2. **Production stage**: `nginx:1.27-alpine` serves the static output with SPA routing, gzip compression, and 1-year cache headers on assets

### AWS S3 + CloudFront

```bash
npm run build
aws s3 sync dist/ s3://your-bucket-name --delete
```

Configure CloudFront with a custom error response to redirect 404s to `/index.html` for SPA routing.

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
|---------|-------------|
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
|----------|--------|-----|
| Calc engine | Pure functions module | Testable, explicit, no class overhead |
| Delta support | All 6 via lookup table | Avoids inverse CDF dependency |
| IV input | Both VIX + Direct modes | Covers all user types |
| SPX/SPY display | Always show both | No toggle friction |
| Magic numbers | Named constants | DRY, self-documenting |
| Time validation | Hard reject outside market hours | Prevents meaningless results |
| IV convergence | Single `resolveIV()` funnel | Eliminates conversion bugs |
| Strike rounding | Integer + nearest 5-pt snap | "Engineered enough" for ±5-15pt accuracy |
| Recalculation | Hybrid debounce | Instant for discrete, 250ms for text |
| Memoization | None | Math is ~10μs, not worth the complexity |
| Input parsing | Strict validation + errors | Explicit over clever |
| External math | Zero dependencies | Native `Math` handles everything |
| Framework | Vite + React | Lightest viable toolchain |
| TypeScript | Strict mode | `noUncheckedIndexedAccess`, `noUnusedLocals`, etc. |
| Testing | Vitest + RTL | Fast, modern, good DX |
| Hosting | Vercel | Push-to-deploy, free tier |
| VIX data | Static JSON + localStorage cache | Works offline after first load |
| CDF implementation | Abramowitz & Stegun 26.2.17 | <7.5×10⁻⁸ error, 15 lines, no deps |

---

## Accuracy & Limitations

The calculator provides strike placement accuracy of approximately ±5–15 SPX points. Sources of error, in order of impact:

1. **VIX vs actual 0DTE IV** (largest) — VIX measures 30-day IV. The adjustable multiplier compensates but cannot perfectly capture real-time 0DTE IV.
2. **Put/call skew** — The linear skew model (±N% on puts/calls) is a simplification of the real volatility smile. Actual skew varies by strike distance and market conditions.
3. **SPX/SPY ratio drift** — The ratio fluctuates due to ETF expense ratios, dividend timing, and NAV tracking. The configurable ratio slider mitigates this.
4. **Theoretical vs market premiums** — Black-Scholes prices assume continuous hedging and log-normal returns. Real option prices include bid/ask spreads, market maker edge, and supply/demand effects.
5. **Interest rate** — Assumed zero. Negligible for 0DTE but non-zero for longer durations.
6. **Dividends** — Not modeled. Minimal impact for SPX same-day calculations.

For practical 0DTE iron condor placement and backtesting, these error sources are well within acceptable bounds. For live trading, always compare theoretical values against actual bid/ask quotes.

---

## License

MIT
