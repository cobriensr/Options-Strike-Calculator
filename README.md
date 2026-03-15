# 0DTE Options Strike Calculator

A Black-Scholes-based calculator for determining delta-targeted strike prices, theoretical option premiums, credit spread P&L, iron condor profiles, and VIX regime-aware position guidance for same-day (0DTE) SPX and SPY options. Includes AI-powered chart analysis via Claude Opus 4.6, live option chain verification via Schwab API, historical backtesting, and a Postgres database for ML-ready data collection.

Built with React 19, TypeScript (strict mode), and Vite. Deployed on Vercel with Neon Postgres, Upstash Redis, Schwab API, and Anthropic API integrations.

Live at: [theta-options.com](https://theta-options.com)

## Table of Contents

- [0DTE Options Strike Calculator](#0dte-options-strike-calculator)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Features](#features)
    - [Strike Calculation](#strike-calculation)
    - [SPY/SPX Conversion](#spyspx-conversion)
    - [IV Input](#iv-input)
    - [Iron Condor \& Credit Spread Analysis](#iron-condor--credit-spread-analysis)
    - [Probability of Profit (PoP)](#probability-of-profit-pop)
    - [UI](#ui)
  - [Chart Analysis (Claude Opus 4.6)](#chart-analysis-claude-opus-46)
    - [Three Analysis Modes](#three-analysis-modes)
    - [What Claude Receives](#what-claude-receives)
    - [What Claude Returns](#what-claude-returns)
    - [UI Features](#ui-features)
    - [Technical Details](#technical-details)
  - [Live Option Chain Verification](#live-option-chain-verification)
  - [Backtesting System](#backtesting-system)
  - [Data Collection \& ML Pipeline](#data-collection--ml-pipeline)
    - [Tables](#tables)
    - [Data Flow](#data-flow)
    - [Querying](#querying)
    - [ML Roadmap](#ml-roadmap)
  - [Market Regime Intelligence](#market-regime-intelligence)
    - [VIX Regime Card](#vix-regime-card)
    - [Delta Guide](#delta-guide)
    - [VIX Term Structure](#vix-term-structure)
    - [Opening Range Check](#opening-range-check)
    - [Volatility Clustering](#volatility-clustering)
    - [Event Day Warning](#event-day-warning)
  - [Live Market Data API](#live-market-data-api)
    - [Architecture](#architecture)
    - [Owner Gating](#owner-gating)
    - [Authentication Flow](#authentication-flow)
    - [Token Storage](#token-storage)
  - [The Math](#the-math)
    - [Strike Calculation Formula](#strike-calculation-formula)
    - [Option Pricing (Black-Scholes)](#option-pricing-black-scholes)
    - [Iron Condor P\&L](#iron-condor-pl)
    - [Delta Guide — Range-to-Delta Mapping](#delta-guide--range-to-delta-mapping)
    - [Time-to-Expiry](#time-to-expiry)
  - [Getting Started](#getting-started)
    - [Prerequisites](#prerequisites)
    - [Installation](#installation)
    - [Required Packages](#required-packages)
    - [Development](#development)
    - [Environment Variables](#environment-variables)
    - [Database Setup](#database-setup)
  - [Project Structure](#project-structure)
  - [Architecture \& Design](#architecture--design)
    - [Architecture Data Flow](#architecture-data-flow)
    - [Key Design Patterns](#key-design-patterns)
  - [Security](#security)
    - [Headers (vercel.json)](#headers-verceljson)
    - [Authentication](#authentication)
    - [Rate Limiting](#rate-limiting)
    - [Input Validation](#input-validation)
  - [VIX Data Management](#vix-data-management)
  - [Excel Export](#excel-export)
  - [Testing](#testing)
  - [Deployment](#deployment)
    - [Vercel (Production)](#vercel-production)
    - [Post-Deploy Setup](#post-deploy-setup)
  - [Accessibility](#accessibility)
  - [Scripts Reference](#scripts-reference)
  - [Trading Workflow](#trading-workflow)
    - [Daily Flow](#daily-flow)
    - [Structure Selection (from Chart Analysis)](#structure-selection-from-chart-analysis)
  - [Position Sizing Guide](#position-sizing-guide)
  - [Accuracy \& Limitations](#accuracy--limitations)

---

## Overview

This tool solves a specific problem for 0DTE options traders: given a spot price, time of day, and implied volatility, where should your delta-targeted strikes be, what are the theoretical premiums, what does your iron condor P&L look like, and what delta ceiling should you respect based on today's VIX regime, term structure, volatility clustering, and day-of-week effects?

All financial calculations run client-side with zero external dependencies. For the site owner, integrations with Schwab (market data + option chains), Anthropic (Claude chart analysis), and Neon Postgres (data collection) provide a complete AI-augmented trading workflow. Public visitors use the same full calculator with manual input.

You input (or auto-receive) the current SPY price, the VIX (plus optionally VIX1D and VIX9D), and the time — and it gives you:

- A complete strike table across 6 delta targets (5Δ through 20Δ) with theoretical put and call premiums
- A full iron condor breakdown split into put spread, call spread, and combined IC — with credit, max loss, buying power, return on risk, probability of profit, and breakevens in both SPX and SPY terms
- A Delta Guide with a ceiling recommendation based on 9,102 days of historical VIX-to-SPX range data, adjusted for day-of-week effects and volatility clustering
- AI-powered chart analysis that reads Market Tide, Net Flow, and Periscope screenshots to recommend structure, delta, strike placement, entry plan, management rules, and hedge
- Live option chain verification comparing theoretical strikes to actual Schwab chain deltas
- VIX term structure signals (VIX1D/VIX and VIX9D/VIX ratios) for pre-market risk assessment
- Opening range check comparing the first 30 minutes of trading against the expected daily range
- Volatility clustering analysis showing how yesterday's range predicts today's range
- Event day warnings for FOMC, CPI, NFP, and GDP release days with severity-coded alerts and actionable advice
- Historical backtesting with full candle-by-candle replay and settlement verification
- Automatic data collection to Postgres for ML training pipeline

---

## Features

### Strike Calculation

- All 6 delta targets simultaneously: 5Δ, 8Δ, 10Δ, 12Δ, 15Δ, 20Δ
- SPX and SPY strikes: Both calculated and displayed, with SPX snapped to nearest 5-pt and SPY snapped to nearest $1
- Put skew adjustment: Configurable 0–8% IV asymmetry between puts and calls to model the volatility smile
- Theoretical option premiums: Black-Scholes pricing for puts and calls at every delta

### SPY/SPX Conversion

- SPY price input: Primary input designed for reading directly from Market Tide
- Optional SPX input: Enter the actual SPX price to derive the exact SPX/SPY ratio
- Configurable ratio slider: 9.95–10.05 range for manual ratio adjustment when SPX price isn't available
- Auto-derived ratio: When both prices are entered, the ratio is computed automatically to 4 decimal places

### IV Input

- VIX mode: Enter VIX value with a configurable 0DTE adjustment multiplier (default 1.15×, range 1.0–1.3×)
- Direct IV mode: Enter σ directly as a decimal for traders with access to actual 0DTE IV data (or use the VIX1D → Direct IV button)
- VIX1D auto-apply: When live VIX1D data is available (via Schwab API), automatically switches to Direct IV mode with VIX1D/100

### Iron Condor & Credit Spread Analysis

- Full 4-leg structure: Long put, short put, short call, long call — all with SPX and SPY strikes
- Wing width selection: 5, 10, 15, 20, 25, 30, or 50 SPX points
- Contracts counter: Adjustable 1–999 with +/− stepper
- Per-side spread breakdown: Each delta row shows put credit spread, call credit spread, and combined iron condor with credit, max loss, buying power, RoR, PoP, and breakevens
- Dual breakeven display: Both SPX BE and SPY BE columns for cross-referencing with Market Tide

### Probability of Profit (PoP)

- Iron condor PoP: Uses the correct formula `P(S_T > BE_low) + P(S_T < BE_high) − 1`, NOT the product of individual spread PoPs
- Individual spread PoPs: Single-tail probabilities for each side — always higher than the combined IC PoP
- Skew-adjusted: Put-side uses `putSigma` for lower breakeven, call-side uses `callSigma` for upper breakeven

### UI

- Light and dark modes with WCAG AA contrast in both modes
- 508 accessibility compliance: ARIA labels, roles, focus management, keyboard navigation, screen reader support
- Responsive: Works on desktop and mobile
- Debounced inputs: Text fields recalculate after 250ms; dropdowns and sliders update instantly
- Live data indicator: Shows "● LIVE" or "● CLOSED" badge when market data is streaming (owner-only)

---

## Chart Analysis (Claude Opus 4.6)

The centerpiece feature: upload screenshots of Market Tide, Net Flow (SPY/QQQ), and Periscope (Delta Flow/Gamma) from Unusual Whales, and Claude Opus 4.6 with extended thinking analyzes them alongside the calculator's full context to produce a complete trading plan.

### Three Analysis Modes

| Mode      | When                                 | What it produces                                                                                                   |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Pre-Trade | Before entry (~8:45 AM CT)           | Full plan: structure, delta, 3 laddered entries, strike placement from gamma zones, management rules, hedge, risks |
| Mid-Day   | During position (~10:00–11:00 AM CT) | Update: has flow shifted, should you close legs, is it safe to add Entry 2/3                                       |
| Review    | After close (~4:00 PM ET)            | Retrospective: was the structure correct, what signals predicted the outcome, lessons learned                      |

### What Claude Receives

- All uploaded chart images (up to 5) with labels (Market Tide, Net Flow SPY, Net Flow QQQ, Periscope Delta Flow, Periscope Gamma)
- Full calculator context: SPX, VIX, VIX1D, VIX9D, VVIX, σ, T, hours remaining, delta ceiling, spread ceilings, regime zone, cluster multiplier, DOW label, opening range signal, term structure signal, overnight gap
- Previous recommendation (for mid-day/review continuity via `lastAnalysisRef`)
- Data availability notes (VIX1D missing, pre-10AM opening range, backtest mode)

### What Claude Returns

- Structure: IRON CONDOR, PUT CREDIT SPREAD, CALL CREDIT SPREAD, or SIT OUT
- Confidence: HIGH, MODERATE, or LOW
- Suggested delta with per-chart confidence breakdown
- Strike placement guidance from Periscope gamma zones with straddle cone analysis
- Multi-entry laddering plan (3 entries with timing, conditions, size percentages)
- Position management rules (profit target, stop conditions, time rules, flow reversal signal)
- Hedge recommendation (NO HEDGE, REDUCED SIZE, PROTECTIVE LONG, or SKIP)
- End-of-day review with wasCorrect, whatWorked, whatMissed, optimalTrade, lessonsLearned

### UI Features

- Drag-and-drop, file picker, or clipboard paste for image upload (max 5 images)
- Per-image label selector (Market Tide, Net Flow SPY, Net Flow QQQ, Periscope Delta Flow, Periscope Gamma)
- Two-step confirmation: Analyze button → confirmation bar showing image count, mode, and labels → Confirm/Go Back
- Thinking indicator with progress bar, elapsed timer, rotating status messages, and Cancel button
- TL;DR summary card always visible with structure, confidence, delta, hedge badge, Entry 1 details, profit target
- Collapsible detail sections: Strike Guidance and Entry Plan expanded by default, all others collapsed
- Image issues: Claude flags genuinely unreadable images with Replace button for each
- Raw response fallback when JSON parsing fails

### Technical Details

- Model: Claude Opus 4.6 (`claude-opus-4-6`)
- Extended thinking: `type: "enabled"`, `budget_tokens: 11000`
- Max tokens: 20,000 (11K thinking + 9K response)
- Vercel function timeout: 300 seconds (`maxDuration: 300`)
- Client-side timeout: 240 seconds (AbortController)
- Cost: ~$0.30–0.40 per analysis
- Owner-gated: requires authenticated session cookie
- Rate limited: 10 analyses per minute via Upstash Redis

---

## Live Option Chain Verification

Compares theoretical calculator strikes to actual Schwab option chain data:

| Feature          | Detail                                                                           |
| ---------------- | -------------------------------------------------------------------------------- |
| Endpoint         | `GET /api/chain`                                                                 |
| Symbol           | `$SPX`, range=ALL, strikeCount=80                                                |
| Target deltas    | 5, 8, 10, 12, 15, 20                                                             |
| Returns          | Nearest chain strike to each target delta with actual put/call delta, IV, credit |
| Divergence alert | Flags when theoretical vs chain strikes diverge >10 pts                          |
| Cache            | 30 seconds during market hours                                                   |

This addresses the single-σ model limitation: VIX1D is aggregate IV across the entire strip, but on high-skew days OTM put IV ≠ VIX1D. The chain endpoint shows per-strike deltas directly from Schwab.

---

## Backtesting System

Full historical replay using 5-minute SPX candles from the Schwab API:

- Select any past date → calculator auto-fills from historical candle data at the selected time
- Running OHLC computed from market open to selected time (not end-of-day)
- VIX, VIX1D, VIX9D, VVIX resolved from historical data with CBOE static fallback for VIX1D
- Opening range computed from first 6 candles (30 minutes)
- Settlement check: shows which deltas survived vs breached at end of day
- Candle-by-candle navigation: change time to step through the day
- Backtest diagnostic panel: shows mode, date, candle index, all prices, gap, opening range, yesterday's range
- Chart analysis works during backtesting with correct historical values (not contaminated by live quotes)
- Snapshots and analyses auto-save to Postgres with `is_backtest: true`

---

## Data Collection & ML Pipeline

Three Postgres tables automatically collect data for future ML training:

### Tables

**`market_snapshots`** — Complete calculator state at each date+time (40+ features):

| Category           | Fields                                                             |
| ------------------ | ------------------------------------------------------------------ |
| Prices             | SPX, SPY, open, high, low, prev close                              |
| Volatility surface | VIX, VIX1D, VIX9D, VVIX, VIX1D/VIX ratio, VIX/VIX9D ratio          |
| Calculator         | σ, sigma source, T, hours remaining, skew                          |
| Regime             | zone (go/caution/stop/danger), cluster multiplier, DOW multipliers |
| Delta guide        | IC ceiling, put/call spread ceilings, moderate/conservative deltas |
| Range thresholds   | median O→C %, median H-L %, P90 O→C %, P90 H-L %, P90 points       |
| Opening range      | available flag, high, low, % consumed, signal (GREEN/MODERATE/RED) |
| Term structure     | combined signal (calm/normal/elevated/extreme)                     |
| Strikes            | JSONB with put/call at every delta (5/8/10/12/15/20)               |
| Events             | early close flag, event day flag, event names array                |
| Metadata           | is_backtest flag, created_at timestamp                             |

Uniqueness: `UNIQUE(date, entry_time)` with `ON CONFLICT DO NOTHING` — duplicate submissions silently skipped.

**`analyses`** — Claude chart analysis responses:

| Column                                 | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| snapshot_id                            | FK to market_snapshots (linked at save time)  |
| structure, confidence, suggested_delta | Queryable recommendation fields               |
| hedge                                  | NO HEDGE, REDUCED SIZE, PROTECTIVE LONG, SKIP |
| full_response                          | Complete JSON response for replay             |

**`outcomes`** — End-of-day settlement data:

| Column                                  | Purpose                              |
| --------------------------------------- | ------------------------------------ |
| settlement, day_open, day_high, day_low | SPX OHLC                             |
| day_range_pts, day_range_pct            | Realized range                       |
| close_vs_open                           | Directional move (positive = up day) |
| vix_close, vix1d_close                  | Closing vol values                   |

Uniqueness: `UNIQUE(date)` with `ON CONFLICT DO UPDATE`.

### Data Flow

- **Snapshots**: Auto-save via `useSnapshotSave` hook whenever results compute with a new date+time. All 40+ fields populated from `useComputedSignals` hook which lifts derived values from child components.
- **Analyses**: Saved server-side in the analyze endpoint (awaited before response) with snapshot_id lookup.
- **Outcomes**: Backfilled from historical CSVs via `scripts/backfill-outcomes.ts`. ~960 days with VIX1D coverage (May 2022+).

### Querying

```text
GET /api/journal                              → last 50 analyses
GET /api/journal?date=2026-03-13              → all analyses for a date
GET /api/journal?structure=CALL+CREDIT+SPREAD → filter by structure
GET /api/journal?from=2026-03-01&to=2026-03-14 → date range
GET /api/journal/status                       → DB connection test + table counts
```

### ML Roadmap

| Days of data | Value                    | Method                                                          |
| ------------ | ------------------------ | --------------------------------------------------------------- |
| 30–50        | Pattern spotting         | SQL queries: win rate by structure, VIX level, opening range    |
| 50–100       | Simple prediction        | Logistic regression on snapshot features → survival probability |
| 100–200      | Non-obvious interactions | XGBoost on 40+ features: gamma wall × VIX × opening range       |
| 200+         | LLM fine-tuning viable   | Input/output pairs for fine-tuning a smaller model              |

---

## Market Regime Intelligence

The calculator includes a comprehensive market regime analysis system built on 9,102 matched VIX/SPX trading days (1990–2026).

### VIX Regime Card

Compact inline card showing the current VIX regime (Green / Caution / Elevated / Extreme) with historical statistics.

### Delta Guide

The core decision tool. Given today's VIX, entry time, and historical range data:

- Ceiling recommendation: Maximum delta for ~90% settlement survival, shown separately for IC, put spread, and call spread
- Three-tier guidance: Aggressive (ceiling), Moderate (90% intraday safe), Conservative (extra cushion)
- Range → Delta table: Four historical thresholds mapped to concrete deltas using live Black-Scholes parameters
- Your Deltas vs. Regime matrix: Checkmark/cross grid with per-side pass/fail (P✓/C✓)
- Continuous interpolation: Per-point VIX data (10–30) with linear interpolation
- Day-of-week adjustment: Monday ~6% narrower, Thursday ~4% wider
- Volatility clustering adjustment: Yesterday's extreme range → wider thresholds today

### VIX Term Structure

- VIX1D/VIX ratio: CALM, NORMAL, ELEVATED, EVENT RISK
- VIX9D/VIX ratio: CONTANGO, FLAT, INVERTED, STEEP INVERSION
- VVIX classification: CALM, NORMAL, ELEVATED, EXTREME
- Combined worst-of signal

### Opening Range Check

First 30 minutes of SPX trading vs expected daily range: GREEN (<40% consumed), MODERATE (40–65%), RED (>65%).

### Volatility Clustering

Yesterday's range percentile → today's range multiplier. Up to 1.87× at high VIX after a P90 day.

### Event Day Warning

Static calendar of FOMC (8/year), CPI (12/year), NFP (12/year), GDP (4/year) for 2025–2026 with severity-coded banners.

---

## Live Market Data API

### Architecture

| Endpoint                  | Schwab Call                                    | Returns                                  | Cache (market) | Cache (closed) |
| ------------------------- | ---------------------------------------------- | ---------------------------------------- | -------------- | -------------- |
| `GET /api/quotes`         | `getQuotes(SPY,$SPX,$VIX,$VIX1D,$VIX9D,$VVIX)` | Real-time spot prices                    | 60s            | 5 min          |
| `GET /api/intraday`       | `priceHistory($SPX, 5-min, 1 day)`             | Today's OHLC + 30-min opening range      | 2 min          | 10 min         |
| `GET /api/yesterday`      | `priceHistory($SPX, daily, 1 month)`           | Prior day SPX OHLC for clustering        | 1 hour         | 1 day          |
| `GET /api/chain`          | `chains($SPX, 0DTE)`                           | Live option chain with per-strike deltas | 30s            | —              |
| `GET /api/events`         | FRED API                                       | Economic calendar events                 | 1 hour         | 1 day          |
| `GET /api/history`        | `priceHistory($SPX+$VIX+$VIX1D+$VIX9D)`        | Historical candles for backtesting       | 1 hour         | 1 day          |
| `GET /api/movers`         | `movers($SPX)`                                 | Market movers                            | 5 min          | 10 min         |
| `POST /api/analyze`       | Anthropic Messages API                         | Claude chart analysis                    | —              | —              |
| `POST /api/snapshot`      | Neon Postgres                                  | Save market snapshot                     | —              | —              |
| `GET /api/journal`        | Neon Postgres                                  | Query saved analyses                     | —              | —              |
| `GET /api/journal/status` | Neon Postgres                                  | DB connection + table counts             | —              | —              |
| `POST /api/journal/init`  | Neon Postgres                                  | Create tables (one-time)                 | —              | —              |

### Owner Gating

All data, analysis, and database endpoints are gated behind an HTTP-only session cookie (`sc-owner`) set during the Schwab OAuth flow. Public visitors get the full calculator with manual input.

### Authentication Flow

1. Owner visits `/api/auth/init` → redirects to Schwab login
2. After login, Schwab redirects to `/api/auth/callback` → tokens stored in Upstash Redis + owner cookie set
3. All subsequent API calls auto-refresh the access token using the refresh token
4. After 7 days, the refresh token expires → owner re-authenticates

### Token Storage

Upstash Redis (via Vercel Marketplace). REST-based client, serverless-compatible.

---

## The Math

### Strike Calculation Formula

For a delta target D with z-score z = N⁻¹(1 − D/100):

```text
K_put  = S × e^(−z × σ_put  × √T)
K_call = S × e^(+z × σ_call × √T)
```

Where S = SPX spot, σ_put = σ × (1 + skew), σ_call = σ × (1 − skew), T = hours remaining ÷ 1638, r = 0.

### Option Pricing (Black-Scholes)

```text
d1 = [ln(S/K) + (σ²/2)·T] / (σ·√T)
d2 = d1 − σ·√T

Call = S·N(d1) − K·N(d2)
Put  = K·N(−d2) − S·N(−d1)
```

CDF implemented via Abramowitz & Stegun 26.2.17 rational approximation (error < 7.5 × 10⁻⁸).

### Iron Condor P&L

```text
Credit     = (short_put − long_put) + (short_call − long_call)
Max Loss   = wing_width − credit
BE Low     = short_put − credit
BE High    = short_call + credit
PoP        = P(S_T > BE_low) + P(S_T < BE_high) − 1
```

### Delta Guide — Range-to-Delta Mapping

```text
1. putStrike = spot × (1 − threshold/100)
2. z ≈ threshold / (σ × √T)
3. putSigma = σ × (1 + skew × min(z, 3) / 1.28)
4. putDelta = N(d1) from BS(spot, putStrike, putSigma, T)
5. maxDelta = min(putDelta, callDelta) × 100
```

σ is always VIX × 1.15 / 100 (independent of IV mode). Range thresholds adjusted by DOW × clustering multipliers.

### Time-to-Expiry

```text
T = hours_remaining / (6.5 × 252)
```

Early close days use reduced hours (e.g., 3.5 hours on day-before-holiday sessions).

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+
- Vercel CLI (`npm i -g vercel`) — for local development with serverless functions

### Installation

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
npm install
```

### Required Packages

```bash
# Core app dependencies (already in package.json)
npm install @neondatabase/serverless  # Neon Postgres
```

### Development

```bash
npm run dev          # Frontend only (localhost:5173)
vercel dev           # Frontend + API functions (localhost:3000)
```

### Environment Variables

| Variable               | Source                       | Purpose                           |
| ---------------------- | ---------------------------- | --------------------------------- |
| `SCHWAB_CLIENT_ID`     | developer.schwab.com         | Schwab API app key                |
| `SCHWAB_CLIENT_SECRET` | developer.schwab.com         | Schwab API app secret             |
| `SCHWAB_REDIRECT_URI`  | Your Schwab app settings     | OAuth callback URL                |
| `OWNER_SECRET`         | `openssl rand -hex 32`       | Owner session cookie value        |
| `KV_REST_API_URL`      | Auto-set by Vercel (Upstash) | Redis REST endpoint               |
| `KV_REST_API_TOKEN`    | Auto-set by Vercel (Upstash) | Redis auth token                  |
| `ANTHROPIC_API_KEY`    | console.anthropic.com        | Claude API key for chart analysis |
| `DATABASE_URL`         | Auto-set by Vercel (Neon)    | Postgres connection string        |

### Database Setup

```bash
# 1. Add Neon Postgres from Vercel Marketplace (Storage → Connect Database → Neon)
# 2. Pull env vars
vercel env pull .env.local

# 3. Deploy and initialize tables (one-time)
curl -X POST https://theta-options.com/api/journal/init \
  -b "sc-owner=YOUR_COOKIE_VALUE"

# 4. Backfill historical outcomes
mkdir -p data
cp your-csvs/* data/
npx tsx scripts/backfill-outcomes.ts
```

---

## Project Structure

```text
├── api/
│   ├── _lib/
│   │   ├── schwab.ts                  # Schwab OAuth token management (Upstash Redis)
│   │   ├── api-helpers.ts             # Shared fetch, cache, owner-gate, rate limiting
│   │   └── db.ts                      # Neon Postgres: schema, snapshots, analyses, outcomes
│   ├── auth/
│   │   ├── init.ts                    # GET /api/auth/init → redirect to Schwab login
│   │   └── callback.ts               # GET /api/auth/callback → exchange code for tokens
│   ├── journal/
│   │   ├── init.ts                    # POST /api/journal/init → create all tables
│   │   └── status.ts                  # GET /api/journal/status → DB connection diagnostics
│   ├── analyze.ts                     # POST /api/analyze → Claude Opus 4.6 chart analysis
│   ├── chain.ts                       # GET /api/chain → live option chain with per-strike deltas
│   ├── events.ts                      # GET /api/events → FRED economic calendar
│   ├── history.ts                     # GET /api/history → historical candles for backtesting
│   ├── intraday.ts                    # GET /api/intraday → today's OHLC + opening range
│   ├── journal.ts                     # GET /api/journal → query saved analyses
│   ├── movers.ts                      # GET /api/movers → market movers
│   ├── quotes.ts                      # GET /api/quotes → SPY, SPX, VIX, VIX1D, VIX9D, VVIX
│   ├── snapshot.ts                    # POST /api/snapshot → save market snapshot to Postgres
│   └── yesterday.ts                   # GET /api/yesterday → prior day SPX OHLC
├── public/
│   ├── vix-data.json                  # 9,137 days of built-in VIX OHLC data (1990–2026)
│   └── vix1d-daily.json              # 960 days of VIX1D daily OHLC (May 2022–Mar 2026)
├── scripts/
│   ├── backfill-outcomes.ts           # Populate outcomes table from historical CSVs
│   └── entry-time-analysis.ts         # 8:45 vs 9:00 AM CT entry timing study
├── src/
│   ├── __tests__/                     # 800+ tests across 14+ test files
│   ├── components/
│   │   ├── BacktestDiag.tsx           # Backtest diagnostic panel
│   │   ├── ChainVerification.tsx      # Theoretical vs live chain strike comparison
│   │   ├── ChartAnalysis.tsx          # Claude Opus chart analysis UI (major component)
│   │   ├── DateLookupSection.tsx      # Date picker with event day integration
│   │   ├── DeltaRegimeGuide.tsx       # Delta ceiling with DOW + clustering adjustments
│   │   ├── EntryTimeSection.tsx       # Time picker with CT/ET conversion
│   │   ├── EventDayWarning.tsx        # FOMC/CPI/NFP/GDP warning banner
│   │   ├── IVInputSection.tsx         # IV mode selection + VIX term structure
│   │   ├── MarketRegimeSection.tsx    # Container for all regime analysis components
│   │   ├── OpeningRangeCheck.tsx      # First-30-min range signal
│   │   ├── PreTradeSignals.tsx        # Pre-trade signal summary
│   │   ├── SettlementCheck.tsx        # Backtest: which deltas survived at settlement
│   │   ├── VIXRangeAnalysis.tsx       # Full range analysis with survival heatmap
│   │   ├── VIXRegimeCard.tsx          # Compact regime context card
│   │   ├── VIXTermStructure.tsx       # VIX1D/VIX9D/VVIX term structure panel
│   │   └── VolatilityCluster.tsx      # Yesterday's range clustering signal
│   ├── data/
│   │   ├── eventCalendar.ts           # Static FOMC/CPI/NFP/GDP dates + early close dates
│   │   └── vixRangeStats.ts           # Pre-computed VIX→SPX range stats, DOW, clustering
│   ├── hooks/
│   │   ├── useCalculation.ts          # Main calculation hook (strikes, ICs, premiums)
│   │   ├── useChainData.ts            # Live option chain polling (60s interval)
│   │   ├── useComputedSignals.ts      # Lifts all derived signals to App level for DB
│   │   ├── useHistoryData.ts          # Historical candle data for backtesting
│   │   ├── useMarketData.ts           # Live Schwab data (quotes, intraday, yesterday)
│   │   ├── useSnapshotSave.ts         # Auto-saves market snapshots to Postgres
│   │   └── useVix1dData.ts            # Static VIX1D CBOE data loader
│   ├── types/
│   │   ├── api.ts                     # API response types + chain types
│   │   └── index.ts                   # Core TypeScript types (all readonly)
│   ├── utils/
│   │   ├── calculator.ts              # Pure calculation functions (BS, strikes, IC, PoP)
│   │   ├── csvParser.ts               # VIX CSV parser
│   │   ├── exportXlsx.ts              # Excel export (multi-sheet wing width comparison)
│   │   └── vixStorage.ts              # localStorage cache + static JSON loader
│   ├── App.tsx                        # Root component: state, hooks, layout
│   └── main.tsx                       # React entry point
├── vercel.json                        # Rewrites + security headers + CSP
└── vite.config.ts                     # Vite + Vitest + PWA config
```

---

## Architecture & Design

### Architecture Data Flow

```text
                    ┌─── Schwab API (owner-only) ──────────────────┐
                    │  /api/quotes → SPY,SPX,VIX,VIX1D,VIX9D,VVIX │
                    │  /api/intraday → today OHLC + opening range  │
                    │  /api/yesterday → prior day OHLC             │
                    │  /api/chain → live option chain deltas        │
                    │  /api/history → historical candles            │
                    └──────────────────┬───────────────────────────┘
                                       │ (auto-populate)
                                       ▼
SPY + VIX + Time ──→ useCalculation() ──→ results (strikes, premiums, ICs)
                                            │
            useComputedSignals() ◄──────────┤ ← VIX, spot, T, skew, clusterMult
                    │                       │
                    ├──→ useSnapshotSave() ──→ POST /api/snapshot ──→ Neon Postgres
                    │                       │
                    ├──→ ChartAnalysis ──→ POST /api/analyze ──→ Claude Opus 4.6
                    │        context           │                      │
                    │                          └─── save analysis ───→ Neon Postgres
                    │
                    └──→ Display components (DeltaRegimeGuide, OpeningRangeCheck, etc.)

                    ┌─── Historical Data ─────────────┐
                    │  useHistoryData() → candles      │
                    │  useVix1dData() → CBOE VIX1D     │
                    │  Built-in VIX OHLC (1990–2026)   │
                    └──────────────┬───────────────────┘
                                   │ (backtesting)
                                   ▼
                    Same pipeline as live, with historySnapshot
                    replacing live quotes. is_backtest = true.
```

### Key Design Patterns

- **`useComputedSignals`**: Single hook that computes ALL derived signals (regime zone, DOW multipliers, delta ceilings, range thresholds, opening range, term structure, price context, events). Feeds both display components and database writer from one source of truth.
- **Backtest isolation**: When `historySnapshot` exists, all volatility values (VIX1D, VIX9D, VVIX) come from historical data, never from live quotes. Prevents data contamination.
- **Fire-and-forget snapshots**: `useSnapshotSave` sends snapshots via fetch with error-caught promises. UI never blocks on DB writes. Deduplication via `savedRef` + DB UNIQUE constraint.
- **Awaited analysis saves**: Unlike snapshots, analysis saves are `await`ed before `res.json()` because Vercel kills functions after response.

---

## Security

### Headers (vercel.json)

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-XSS-Protection: 1; mode=block`
- `Content-Security-Policy`: `default-src 'self'`, strict `script-src`, `frame-ancestors 'none'`, `connect-src` limited to self + Schwab + Vercel Analytics

### Authentication

- Owner cookie: HttpOnly, Secure, 7-day expiry, matched against `OWNER_SECRET` env var
- All API endpoints: `rejectIfNotOwner()` returns 401 for unauthenticated requests
- All API keys (Schwab, Anthropic, Postgres) are server-side only, never in client bundle

### Rate Limiting

All owner-gated endpoints are rate-limited via Upstash Redis:

| Endpoint        | Limit  | Purpose                               |
| --------------- | ------ | ------------------------------------- |
| `/api/analyze`  | 10/min | Prevent Opus cost abuse (~$0.30/call) |
| `/api/snapshot` | 30/min | Generous for normal use               |
| `/api/journal`  | 20/min | Query endpoint                        |
| Auth endpoints  | 5/min  | Brute-force protection                |

### Input Validation

- Image payload: Max 5 images, max 5MB per image (base64)
- Anthropic errors: Sanitized to generic messages, full details logged server-side only
- DB errors: Sanitized, never expose connection details to client
- SQL injection: Neon tagged templates auto-parameterize all queries

---

## VIX Data Management

Three-tier strategy: localStorage cache (instant) → static JSON (first load) → manual CSV upload (override).

Built-in: 9,137 days of VIX OHLC (1990–2026) + 960 days of VIX1D daily OHLC (May 2022–March 2026).

---

## Excel Export

One-click XLSX with three sheets: P&L Comparison (7 wing widths × 6 deltas × 3 sides = 126 rows), IC Summary, and Inputs snapshot with methodology notes.

---

## Testing

800+ tests across 14+ test files, all passing with TypeScript strict mode. Key test files:

| File                        | Focus                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ChartAnalysis.test.tsx`    | 57 tests: image management, confirmation step, cancel, analyze flow, TL;DR card, collapsible sections, modes, error handling |
| `DeltaRegimeGuide.test.tsx` | 51+ tests: ceiling, thresholds, delta matrix, DOW, clustering                                                                |
| `App.test.tsx`              | 55 tests: rendering, mode switching, validation, CSV upload                                                                  |
| `SettlementCheck.test.tsx`  | Backtest settlement verification                                                                                             |
| `api.test.ts`               | API data processing, owner gating, token logic                                                                               |

```bash
npm test                 # Watch mode
npm run test:run         # Single run (CI)
npm run test:coverage    # Coverage report
```

---

## Deployment

### Vercel (Production)

```bash
vercel deploy --prod     # Or push to main for auto-deploy
```

**Requirements**: Vercel Pro plan (required for 300-second function timeout on `/api/analyze`).

**Framework Preset**: Must be set to "Other" (not Vite) for API routes to work alongside SPA.

### Post-Deploy Setup

1. Add Neon Postgres: Vercel Storage → Connect Database → Neon
2. Add Upstash Redis: Vercel Storage → Connect Database → Upstash for Redis
3. Set environment variables: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SECRET`, `ANTHROPIC_API_KEY`
4. Initialize tables: `POST /api/journal/init`
5. Authenticate: Visit `/api/auth/init` → Schwab login
6. Backfill outcomes: `npx tsx scripts/backfill-outcomes.ts`

---

## Accessibility

Section 508 / WCAG AA: semantic HTML, ARIA attributes, focus management, 4.5:1 contrast, `prefers-reduced-motion`, labeled inputs, `role="alert"` for errors.

---

## Scripts Reference

| Command                                  | Description                         |
| ---------------------------------------- | ----------------------------------- |
| `npm run dev`                            | Vite dev server with HMR            |
| `npm run build`                          | TypeScript check + production build |
| `npm test`                               | Vitest watch mode                   |
| `npm run test:run`                       | Single test run (CI)                |
| `npm run test:coverage`                  | v8 coverage report                  |
| `npm run lint`                           | TypeScript type check               |
| `npx tsx scripts/backfill-outcomes.ts`   | Populate outcomes table from CSVs   |
| `npx tsx scripts/entry-time-analysis.ts` | Entry timing study (8:45 vs 9:00)   |

---

## Trading Workflow

### Daily Flow

```text
8:30 AM ET   Check term structure (VIX1D/VIX9D auto-filled)
             Check event day warning
             Check volatility clustering signal

8:45 AM CT   FIRST ENTRY
             Check Delta Guide ceiling + DOW + clustering badges
             Upload Market Tide + Net Flow + Periscope screenshots
             Run Pre-Trade analysis → get structure, delta, entry plan
             Execute Entry 1 per the plan
             Set $0.50 debit limit close order

10:00 AM ET  OPENING RANGE CHECK
             GREEN → proceed with Entry 2
             RED → skip or reduce size

10:00 AM CT  SECOND ENTRY (if conditions met)
             Swap Periscope gamma screenshot
             Run Mid-Day analysis → check if Entry 2 conditions met
             Execute if recommended

11:00 AM CT  OPTIONAL THIRD ENTRY
             Same flow as Entry 2

2:00 PM ET   MANAGEMENT
             Follow management rules from analysis
             Take 50% profit if available

4:15 PM ET   REVIEW
             Upload full-day charts
             Run Review analysis → lessons learned
```

### Structure Selection (from Chart Analysis)

| Market Tide Signal        | Structure          | Why                             |
| ------------------------- | ------------------ | ------------------------------- |
| NCP ≈ NPP (parallel)      | Iron Condor        | Ranging day, collect both sides |
| NCP >> NPP (diverging up) | Put Credit Spread  | Bullish, no call exposure       |
| NPP >> NCP (diverging up) | Call Credit Spread | Bearish, no put exposure        |
| Both declining sharply    | Sit out            | High uncertainty                |

---

## Position Sizing Guide

Conservative: 5% of account per day (survives 10+ max losses). Moderate: 10%. Aggressive: 15%.

Multiple positions on the same underlying and expiration are NOT diversified — always sum total buying power.

---

## Accuracy & Limitations

1. **VIX vs actual 0DTE IV**: VIX1D auto-apply mitigates this; chain verification shows actual per-strike deltas
2. **Single-σ model**: Calculator uses one σ for all strikes; real skew varies by strike distance. Chain endpoint addresses this.
3. **Put/call skew**: Linear model is a simplification of the real volatility smile
4. **Theoretical vs market premiums**: Black-Scholes assumes continuous hedging; real prices include bid/ask spreads
5. **Chart analysis limitations**: Claude reads charts visually — it estimates NCP/NPP values from line positions, not exact data. Image quality affects accuracy.
6. **Backtest limitations**: Periscope gamma profiles are point-in-time screenshots; historical gamma data is not available programmatically
7. **Database coverage**: VIX1D data available from May 2022 only; earlier outcomes have VIX close but not VIX1D close
