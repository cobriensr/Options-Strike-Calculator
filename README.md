# 0DTE Options Strike Calculator

A Black-Scholes-based calculator for determining delta-targeted strike prices, theoretical option premiums, credit spread P&L, iron condor profiles, and VIX regime-aware position guidance for same-day (0DTE) SPX and SPY options. Includes AI-powered chart analysis via Claude Opus 4.6, live position tracking via Schwab Trader API, live option chain verification via Schwab API, historical backtesting, and a Postgres database for ML-ready data collection.

Built with React 19, TypeScript (strict mode), and Vite. Deployed on Vercel with Neon Postgres, Upstash Redis, Schwab API, Anthropic API, and Sentry integrations.

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
    - [Realized vs Implied Volatility](#realized-vs-implied-volatility)
    - [Theta-Weighted Entry Timing](#theta-weighted-entry-timing)
    - [Settlement Pin Risk](#settlement-pin-risk)
    - [UI](#ui)
  - [Chart Analysis (Claude Opus 4.6)](#chart-analysis-claude-opus-46)
    - [Three Analysis Modes](#three-analysis-modes)
    - [What Claude Receives](#what-claude-receives)
    - [What Claude Returns](#what-claude-returns)
    - [UI Features](#ui-features)
    - [Technical Details](#technical-details)
  - [Live Option Chain Verification](#live-option-chain-verification)
  - [Backtesting System](#backtesting-system)
  - [Live Position Tracking](#live-position-tracking)
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
  - [Observability](#observability)
    - [Structured Logging](#structured-logging)
    - [Error Tracking (Sentry)](#error-tracking-sentry)
    - [Performance Analytics](#performance-analytics)
    - [Bundle Analysis](#bundle-analysis)
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
- A full iron condor breakdown split into put spread, call spread, and combined IC — with credit, max loss, buying power, return on risk, fat-tail adjusted probability of profit, and breakevens in both SPX and SPY terms
- A hedge calculator with DTE selection (1-21 days), extrinsic value modeling at EOD close, net cost breakdown, and crash/rally scenario tables
- A Delta Guide with a ceiling recommendation based on 9,102 days of historical VIX-to-SPX range data, adjusted for day-of-week effects and directional volatility clustering
- AI-powered chart analysis that reads Market Tide, Net Flow, and Periscope screenshots to recommend structure, delta, strike placement, entry plan, management rules, and hedge
- Live option chain verification comparing theoretical strikes to actual Schwab chain deltas
- VIX term structure signals with curve shape classification (contango, fear-spike, backwardation, hump, flat)
- Realized vs implied volatility ratio using 5-day rolling Parkinson RV, showing whether IV is rich or cheap
- Settlement pin risk analysis with OI heatmap from live Schwab chain data
- Opening range check comparing the first 30 minutes of trading against the expected daily range
- Volatility clustering analysis with directional asymmetry (bigger put-side expansion after down days)
- Event day warnings for FOMC, CPI, NFP, and GDP release days with severity-coded alerts and actionable advice
- Historical backtesting with full candle-by-candle replay and settlement verification
- Automatic data collection to Postgres for ML training pipeline

---

## Features

### Strike Calculation

- All 6 delta targets simultaneously: 5Δ, 8Δ, 10Δ, 12Δ, 15Δ, 20Δ
- SPX and SPY strikes: Both calculated and displayed, with SPX snapped to nearest 5-pt and SPY snapped to nearest $0.50
- Convex put skew: Power-curve model where further OTM puts get disproportionately more IV (convexity = 1.35), matching real SPX volatility smile behavior. Call skew is dampened at high z-scores to reflect how call skew flattens or inverts on rally days.
- Intraday IV acceleration: σ multiplier increases as session progresses (1.0× at open → 1.12× at 2 PM → 1.56× at 3:30 PM), reflecting gamma acceleration. Strikes use base σ for placement stability; premiums and Greeks use accelerated σ for realistic pricing.
- Independent call skew override: Optional `callSkewOverride` parameter allows separate put/call skew modeling when call-side IV behavior diverges from put skew (e.g., rally days)
- Greeks per strike: Theta (daily decay via `calcBSTheta()`) and vega (per-1%-vol sensitivity via `calcBSVega()`) displayed per delta row
- Theoretical option premiums: Black-Scholes pricing for puts and calls at every delta

### SPY/SPX Conversion

- SPY price input: Primary input designed for reading directly from Market Tide
- Optional SPX input: Enter the actual SPX price to derive the exact SPX/SPY ratio
- Configurable ratio slider: 9.95–10.05 range for manual ratio adjustment when SPX price isn't available
- Auto-derived ratio: When both prices are entered, the ratio is computed automatically to 4 decimal places

### IV Input

- VIX mode: Enter VIX value with a configurable 0DTE adjustment multiplier (default 1.15×, range 1.0–2.0× to accommodate event days like FOMC/CPI)
- Direct IV mode: Enter σ directly as a decimal for traders with access to actual 0DTE IV data (or use the VIX1D → Direct IV button)
- VIX1D auto-apply: When live VIX1D data is available (via Schwab API), automatically switches to Direct IV mode with VIX1D/100

### Iron Condor & Credit Spread Analysis

- Full 4-leg structure: Long put, short put, short call, long call — all with SPX and SPY strikes
- Wing width selection: 5, 10, 15, 20, 25, 30, or 50 SPX points
- Contracts counter: Adjustable 1–999 with +/− stepper
- Per-side spread breakdown: Each delta row shows put credit spread, call credit spread, and combined iron condor with credit, max loss, buying power, RoR, PoP, and breakevens
- Per-side breakevens: IC breakevens use per-side credit (not total credit) for accurate narrower BEs
- Dual breakeven display: Both SPX BE and SPY BE columns for cross-referencing with Market Tide

### Probability of Profit (PoP)

- Iron condor PoP: Uses the correct formula `P(S_T > BE_low) + P(S_T < BE_high) − 1`, NOT the product of individual spread PoPs
- Individual spread PoPs: Single-tail probabilities for each side — always higher than the combined IC PoP
- Skew-adjusted: Put-side uses `putSigma` for lower breakeven, call-side uses `callSigma` for upper breakeven
- Fat-tail kurtosis adjustment: Breach probabilities inflated by a VIX-regime-dependent factor via `getKurtosisFactor(vix)` (1.5× in calm markets → 3.5× in crisis vol). Adjusted PoP shown as primary value; log-normal PoP displayed struck-through underneath for reference. At 10Δ with VIX 15–20, this reduces IC PoP from ~82% to ~65% — matching empirical breach rates from 9,102 days of data.
- Base sigma for PoP: Settlement probability uses base σ (no IV acceleration) for placement stability — the accelerated σ is only used for premiums and Greeks.

### Hedge Calculator (Reinsurance)

- DTE selector: 1d, 7d, 14d, or 21d hedge options (default 7d). Longer-dated hedges lose minimal theta during a single session.
- Extrinsic value modeling: Hedge scenario table values hedges at (DTE − 1 day) remaining using Black-Scholes, not intrinsic-only. A 7DTE hedge sold to close at EOD recovers 70-90% of purchase price if OTM.
- Net daily cost: Entry premium minus estimated EOD recovery, shown with gross → recovery → net breakdown.
- Sizing: Uses net payout (BS value at target minus entry premium) per contract for correct contract recommendations.
- IV expansion under stress: Hedge scenarios model IV expansion via `stressedSigma()` — crashes inflate σ by up to 4× sensitivity, rallies by 1.5×, capped at 3× base σ.
- Vega exposure: Per-contract and total vega displayed for put/call hedges (`putVegaPer1Pct`, `callVegaPer1Pct`, `totalVegaPer1Pct`).

### Realized vs Implied Volatility

- 5-day rolling Parkinson RV: `rollingParkinsonRV()` averages Parkinson variance across the last 5 completed trading days then takes sqrt — more stable than single-day estimate. Formula per day: `σ² = (1/(4·ln2)) × ln(H/L)²`; annualized via `× 252`
- RV/IV ratio: Compares rolling RV against today's IV (VIX1D preferred, VIX × 1.15 fallback)
- Classification: < 0.8 = IV Rich (favorable for selling), 0.8–1.2 = Fair Value, > 1.2 = IV Cheap (unfavorable)

### Theta-Weighted Entry Timing

- `calcThetaCurve()`: Computes theta across the remaining session to identify optimal entry timing where decay is maximized
- Produces `ThetaCurvePoint[]` with time, theta, and cumulative decay at each interval

### Settlement Pin Risk

- OI heatmap: Top 8 strikes by combined put+call open interest from live Schwab chain data
- Max pain analysis: `calcMaxPain()` finds the strike where total OI-weighted intrinsic payout is minimized (where MMs lose least). Returns max pain strike, distance, and distance percentage from spot
- Pin risk warning: Flags high-OI strikes within 0.5% of spot — MMs delta-hedging can pin price at settlement
- Directional breakdown: Shows whether OI concentration is put-dominated, call-dominated, or balanced
- Top OI walls: Top 3 put and call OI strikes returned for gamma pinning analysis

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
- Full calculator context: SPX, VIX, VIX1D, VIX9D, VVIX, σ, T, hours remaining, delta ceiling, spread ceilings, regime zone, cluster multiplier (symmetric + directional put/call), DOW label, opening range signal, term structure signal + curve shape, RV/IV ratio, IV acceleration multiplier, overnight gap
- Live Schwab positions: Current SPX 0DTE spreads with strikes, credits, P&L, cushion distances, and net greeks — auto-fetched before each analysis so Claude knows what's already open
- Previous recommendation (for mid-day/review continuity — auto-fetched from DB via `getPreviousRecommendation()`, with client-side `lastAnalysisRef` fallback for first-run or backtest scenarios)
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
- Extended thinking: `type: "enabled"`, `budget_tokens: 16000`
- Max tokens: 20,000 (16K thinking + 4K response)
- Vercel function timeout: 300 seconds (`maxDuration: 300`)
- Client-side timeout: 240 seconds (AbortController)
- Cost: ~$0.30–0.40 per analysis
- Owner-gated: requires authenticated session cookie
- Rate limited: 10 analyses per minute via Upstash Redis

---

## Live Option Chain Verification

Compares theoretical calculator strikes to actual Schwab option chain data:

| Feature          | Detail                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Endpoint         | `GET /api/chain`                                                                              |
| Symbol           | `$SPX`, range=ALL, strikeCount=80                                                             |
| Target deltas    | 5, 8, 10, 12, 15, 20                                                                          |
| Returns          | Nearest chain strike to each target delta with actual put/call delta, IV, credit, theta, vega |
| Stale filtering  | Excludes quotes with bid <= 0 or spread > 50% of mid price                                    |
| Max pain         | `calcMaxPain()` -- strike minimizing total OI-weighted payout, with distance from spot        |
| Pin risk         | Top 3 put/call OI walls returned for gamma pinning analysis                                   |
| Divergence alert | Flags when theoretical vs chain strikes diverge >10 pts                                       |
| Cache            | 30 seconds during market hours                                                                |

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

## Live Position Tracking

Real-time SPX 0DTE position awareness via the Schwab Trader API. Before each chart analysis, the frontend auto-fetches current positions so Claude can factor in what's already open.

| Feature              | Detail                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Endpoint             | `GET /api/positions?spx=5700&date=2026-03-16`                                                      |
| Data source          | Schwab Trader API (`/accounts/{hash}?fields=positions`)                                            |
| Filtering            | SPX options only (`$SPX` underlying), expiring today (0DTE), non-zero quantity                     |
| Spread grouping      | Matches short + long legs by put/call type and closest strike (max 50-pt width)                    |
| Spread types         | `CALL CREDIT SPREAD`, `PUT CREDIT SPREAD`, `SINGLE` (unpaired naked short)                         |
| Summary for Claude   | Human-readable text with strikes, contracts, credit, width, cushion from SPX, and aggregate greeks |
| DB persistence       | Saved to `positions` table with snapshot linkage, ON CONFLICT DO UPDATE for re-fetches             |
| Rate limit           | 20/min via Upstash Redis                                                                           |
| Graceful degradation | Positions are optional — if the fetch fails, analysis proceeds without them                        |

### What Claude Sees

When positions exist, the analysis prompt includes a structured summary like:

```text
=== Open SPX 0DTE Positions (2 spreads) ===
SPX at fetch time: 5700

PUT CREDIT SPREADS (1):
  Short 5600P / Long 5575P | 1 contracts | Credit: $1.50 | Width: 25 pts | Cushion: 100 pts below SPX

CALL CREDIT SPREADS (1):
  Short 5800C / Long 5825C | 1 contracts | Credit: $1.20 | Width: 25 pts | Cushion: 100 pts above SPX

AGGREGATE:
  Net delta: -0.012 | Net theta: 0.45
  Total unrealized P&L: $85.00
  Nearest short call: 5800 (100 pts above SPX)
  Nearest short put: 5600 (100 pts below SPX)
```

This lets Claude make position-aware recommendations — e.g., "You already have a put spread at 5600, don't add more put-side risk" or "Your call spread is being tested, consider closing the short call leg."

---

## Data Collection & ML Pipeline

Four Postgres tables automatically collect data for future ML training:

### Tables

**`market_snapshots`** — Complete calculator state at each date+time (50+ features):

| Category            | Fields                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Prices              | SPX, SPY, open, high, low, prev close                               |
| Volatility surface  | VIX, VIX1D, VIX9D, VVIX, VIX1D/VIX ratio, VIX/VIX9D ratio           |
| Calculator          | σ, sigma source, T, hours remaining, skew                           |
| Regime              | zone (go/caution/stop/danger), cluster multiplier, DOW multipliers  |
| Directional cluster | cluster_put_mult, cluster_call_mult (asymmetric after up/down days) |
| Delta guide         | IC ceiling, put/call spread ceilings, moderate/conservative deltas  |
| Range thresholds    | median O→C %, median H-L %, P90 O→C %, P90 H-L %, P90 points        |
| Opening range       | available flag, high, low, % consumed, signal (GREEN/MODERATE/RED)  |
| Term structure      | combined signal, curve shape (contango/fear-spike/flat/etc.)        |
| RV/IV               | rv_iv_ratio, rv_iv_label (IV Rich/Fair/Cheap), rv_annualized        |
| IV acceleration     | iv_accel_mult (intraday σ multiplier at entry time)                 |
| Strikes             | JSONB with put/call at every delta (5/8/10/12/15/20)                |
| Events              | early close flag, event day flag, event names array                 |
| Metadata            | is_backtest flag, created_at timestamp                              |

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

**`positions`** — Live Schwab SPX 0DTE positions:

| Column                                      | Purpose                                         |
| ------------------------------------------- | ----------------------------------------------- |
| snapshot_id                                 | FK to market_snapshots (linked at fetch time)   |
| date, fetch_time                            | When positions were fetched                     |
| account_hash                                | Schwab account identifier                       |
| spx_price                                   | SPX spot at fetch time                          |
| summary                                     | Human-readable text for Claude prompt injection |
| legs                                        | JSONB array of individual option legs           |
| total_spreads, call_spreads, put_spreads    | Spread counts by type                           |
| net_delta, net_theta, net_gamma             | Aggregate portfolio greeks                      |
| total_credit, current_value, unrealized_pnl | P&L tracking                                    |

Uniqueness: `UNIQUE(date, fetch_time)` with `ON CONFLICT DO UPDATE`.

### Data Flow

- **Snapshots**: Auto-save via `useSnapshotSave` hook whenever results compute with a new date+time. All 40+ fields populated from `useComputedSignals` hook which lifts derived values from child components.
- **Analyses**: Saved server-side in the analyze endpoint (awaited before response) with snapshot_id lookup.
- **Outcomes**: Backfilled from historical CSVs via `scripts/backfill-outcomes.ts`. ~960 days with VIX1D coverage (May 2022+).
- **Positions**: Auto-fetched from Schwab Trader API before each chart analysis. Saved with snapshot linkage. Previous analyses auto-fetched from DB for mid-day/review continuity via `getPreviousRecommendation()`.

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
- **Curve shape classification**: Identifies 6 distinct term structure shapes with actionable advice:
  - **Contango** (VIX1D < VIX < VIX9D): Premium selling sweet spot — near-term calm
  - **Fear spike** (VIX1D > VIX > VIX9D): Event-driven near-term fear — IC dangerous, mean-reversion opportunity
  - **Backwardation** (VIX1D > VIX): Short-term stress — reduce size or widen
  - **Hump** (VIX1D < VIX > VIX9D): Event-driven mid-term spike (FOMC/CPI) — expect IV crush post-event
  - **Front calm** (VIX1D < VIX, VIX9D < VIX): Transitional environment
  - **Flat** (all within ±5%): No edge from term structure

### Opening Range Check

First 30 minutes of SPX trading vs expected daily range: GREEN (<40% consumed), MODERATE (40–65%), RED (>65%).

### Volatility Clustering

Yesterday's range percentile → today's range multiplier. Up to 1.87× at high VIX after a P90 day.

- **Directional asymmetry (post-2020 updated)**: After a big down day, both sides expand — put-side by 1.6× the base cluster multiplier, call-side by 1.2× (V-reversals are common post-COVID). After a big up day, call-side compresses more aggressively (0.85×) while put-side stays elevated (1.15×). Flat days and tailwinds (mult < 1) are symmetric. Separate put/call multipliers displayed and passed to Claude.

### Event Day Warning

Static calendar of FOMC (8/year), CPI (12/year), NFP (12/year), GDP (4/year) for 2025–2026 with severity-coded banners.

---

## Live Market Data API

### Architecture

| Endpoint                    | Schwab Call                                    | Returns                                  | Cache (market) | Cache (closed) |
| --------------------------- | ---------------------------------------------- | ---------------------------------------- | -------------- | -------------- |
| `GET /api/quotes`           | `getQuotes(SPY,$SPX,$VIX,$VIX1D,$VIX9D,$VVIX)` | Real-time spot prices                    | 60s            | 5 min          |
| `GET /api/intraday`         | `priceHistory($SPX, 5-min, 1 day)`             | Today's OHLC + 30-min opening range      | 2 min          | 10 min         |
| `GET /api/yesterday`        | `priceHistory($SPX, daily, 1 month)`           | Prior 5 days SPX OHLC for rolling RV     | 1 hour         | 1 day          |
| `GET /api/chain`            | `chains($SPX, 0DTE)`                           | Live option chain with per-strike deltas | 30s            | —              |
| `GET /api/events`           | FRED API                                       | Economic calendar events                 | 1 hour         | 1 day          |
| `GET /api/history`          | `priceHistory($SPX+$VIX+$VIX1D+$VIX9D)`        | Historical candles for backtesting       | 1 hour         | 1 day          |
| `GET /api/movers`           | `movers($SPX)`                                 | Market movers                            | 5 min          | 10 min         |
| `GET /api/positions`        | Schwab Trader API                              | Live SPX 0DTE positions + spreads        | —              | —              |
| `POST /api/analyze`         | Anthropic Messages API                         | Claude chart analysis                    | —              | —              |
| `POST /api/snapshot`        | Neon Postgres                                  | Save market snapshot                     | —              | —              |
| `GET /api/journal`          | Neon Postgres                                  | Query saved analyses                     | —              | —              |
| `GET /api/journal/status`   | Neon Postgres                                  | DB connection + table counts             | —              | —              |
| `POST /api/journal/init`    | Neon Postgres                                  | Create tables + run migrations           | —              | —              |
| `POST /api/journal/migrate` | Neon Postgres                                  | Add new columns to existing tables       | —              | —              |

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
drift  = −σ²/2 × T                          # negative drift correction for log-normal diffusion
K_put  = S × e^(drift − z × σ_put  × √T)
K_call = S × e^(drift + z × σ_call × √T)
```

Where S = SPX spot, T = hours remaining ÷ 1638, r = 0.

Skew model (convex put, dampened call):

```text
σ_put  = σ × (1 + skew × (z / z_ref)^1.35)     # convex: far OTM puts get disproportionately more IV
σ_call = σ × (1 − skew × (z / z_ref) × dampen)  # dampened: call skew flattens further OTM
dampen = 1 / (1 + 0.5 × max(0, z/z_ref − 1))
```

IV acceleration (applied to premiums and Greeks, not strike placement):

```text
σ_effective = σ × (1 + 0.6 × (1/hours_remaining − 1/6.5))   # capped at 1.8×
```

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
Credit      = (short_put − long_put) + (short_call − long_call)
Put credit  = short_put − long_put
Call credit = short_call − long_call
Max Loss    = wing_width − credit
BE Low      = short_put − put_credit     # per-side credit, not total
BE High     = short_call + call_credit   # per-side credit, not total
PoP         = P(S_T > BE_low) + P(S_T < BE_high) − 1

Fat-tail adjustment (VIX-regime-dependent via getKurtosisFactor):
  kurtosis = 1.5 (VIX<15) / 2.0 (15-20) / 2.5 (20-25) / 3.0 (25-30) / 3.5 (30+)
  P_adj(breach_low)  = min(1, P(S_T < BE_low)  × kurtosis)
  P_adj(breach_high) = min(1, P(S_T > BE_high) × kurtosis)
  PoP_adjusted       = 1 − P_adj(breach_low) − P_adj(breach_high)
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

- Node.js 24+ (see `.nvmrc`)
- npm 9+
- Vercel CLI (`npm i -g vercel`) — for local development with serverless functions

### Installation

```bash
git clone https://github.com/cobriensr/Options-Strike-Calculator.git
cd Options-Strike-Calculator
cp .env.example .env.local   # Fill in your values
npm install
```

### Development

```bash
npm run dev          # Frontend only (localhost:5173)
vercel dev           # Frontend + API functions (localhost:3000)
```

### Environment Variables

See [.env.example](.env.example) for a copy-paste template with descriptions.

| Variable                  | Source                        | Purpose                           |
| ------------------------- | ----------------------------- | --------------------------------- |
| `SCHWAB_CLIENT_ID`        | developer.schwab.com          | Schwab API app key                |
| `SCHWAB_CLIENT_SECRET`    | developer.schwab.com          | Schwab API app secret             |
| `SCHWAB_REDIRECT_URI`     | Your Schwab app settings      | OAuth callback URL                |
| `OWNER_SECRET`            | `openssl rand -hex 32`        | Owner session cookie value        |
| `UPSTASH_REDIS_REST_URL`  | Auto-set by Vercel (Upstash)  | Redis REST endpoint               |
| `UPSTASH_REDIS_REST_TOKEN`| Auto-set by Vercel (Upstash)  | Redis auth token                  |
| `ANTHROPIC_API_KEY`       | console.anthropic.com         | Claude API key for chart analysis |
| `DATABASE_URL`            | Auto-set by Vercel (Neon)     | Postgres connection string        |
| `SENTRY_DSN`              | Auto-set by Vercel (Sentry)   | Sentry error tracking DSN         |
| `FRED_API_KEY`            | fred.stlouisfed.org           | Economic calendar data (optional) |
| `FINNHUB_API_KEY`         | finnhub.io                    | Mega-cap earnings data (optional) |

### Database Setup

```bash
# 1. Add Neon Postgres from Vercel Marketplace (Storage → Connect Database → Neon)
# 2. Pull env vars
vercel env pull .env.local

# 3. Deploy and initialize tables (one-time, also runs migrations)
curl -X POST https://theta-options.com/api/journal/init \
  -b "sc-owner=YOUR_COOKIE_VALUE"

# 3b. Or run migrations only (safe to repeat — adds new columns to existing tables)
curl -X POST https://theta-options.com/api/journal/migrate \
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
│   │   ├── db.ts                      # Neon Postgres: schema, snapshots, analyses, outcomes, positions
│   │   └── logger.ts                  # Structured JSON logger (pino)
│   ├── auth/
│   │   ├── init.ts                    # GET /api/auth/init → redirect to Schwab login
│   │   └── callback.ts               # GET /api/auth/callback → exchange code for tokens
│   ├── journal/
│   │   ├── init.ts                    # POST /api/journal/init → create tables + run migrations
│   │   ├── migrate.ts                 # POST /api/journal/migrate → add new columns (idempotent)
│   │   └── status.ts                  # GET /api/journal/status → DB connection diagnostics
│   ├── analyze.ts                     # POST /api/analyze → Claude Opus 4.6 chart analysis
│   ├── chain.ts                       # GET /api/chain → live option chain with per-strike deltas
│   ├── events.ts                      # GET /api/events → FRED economic calendar
│   ├── history.ts                     # GET /api/history → historical candles for backtesting
│   ├── intraday.ts                    # GET /api/intraday → today's OHLC + opening range
│   ├── journal.ts                     # GET /api/journal → query saved analyses
│   ├── movers.ts                      # GET /api/movers → market movers
│   ├── positions.ts                   # GET /api/positions → live Schwab SPX 0DTE positions
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
│   ├── __tests__/                     # 1700 tests across 71 test files
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
│   │   ├── PinRiskAnalysis.tsx        # Settlement pin risk OI heatmap
│   │   ├── PreTradeSignals.tsx        # Pre-trade signal summary
│   │   ├── RvIvCard.tsx               # Realized vs implied volatility card
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
│   └── main.tsx                       # React entry point + Sentry init
├── e2e/                               # Playwright E2E tests (22 spec files)
├── .env.example                       # Environment variable template
├── .nvmrc                             # Node 24 version pin
├── vercel.json                        # Rewrites + security headers + CSP
└── vite.config.ts                     # Vite + Vitest + PWA + bundle analysis config
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
                    │  /api/positions → live SPX 0DTE positions     │
                    └──────────────────┬───────────────────────────┘
                                       │ (auto-populate)
                                       ▼
SPY + VIX + Time ──→ useCalculation() ──→ results (strikes, premiums, ICs)
                                            │
            useComputedSignals() ◄──────────┤ ← VIX, spot, T, skew, clusterMult
                    │                       │
                    ├──→ useSnapshotSave() ──→ POST /api/snapshot ──→ Neon Postgres
                    │                       │
                    ├──→ ChartAnalysis ──→ GET /api/positions ──→ Schwab Trader API
                    │        context      │                           │
                    │                     └──→ POST /api/analyze ──→ Claude Opus 4.6
                    │                              │                      │
                    │                              └─── save analysis ───→ Neon Postgres
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

- **`useComputedSignals`**: Single hook that computes ALL derived signals (regime zone, DOW multipliers, delta ceilings, range thresholds, opening range, term structure + curve shape including hump detection, directional cluster multipliers with post-2020 weights, 5-day rolling Parkinson RV/IV ratio, price context, events). Feeds display components, Claude analysis context, and database writer from one source of truth.
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
- `Content-Security-Policy`: `default-src 'self'`, strict `script-src` (with Sentry CDN), `frame-ancestors 'none'`, `connect-src` limited to self + Schwab + Vercel Analytics + Sentry ingest

### Authentication

- Owner cookie: HttpOnly, Secure, 7-day expiry, matched against `OWNER_SECRET` env var
- All API endpoints: `rejectIfNotOwner()` returns 401 for unauthenticated requests
- All API keys (Schwab, Anthropic, Postgres) are server-side only, never in client bundle

### Rate Limiting

All owner-gated endpoints are rate-limited via Upstash Redis:

| Endpoint         | Limit  | Purpose                               |
| ---------------- | ------ | ------------------------------------- |
| `/api/analyze`   | 10/min | Prevent Opus cost abuse (~$0.30/call) |
| `/api/positions` | 20/min | Auto-fetched before each analysis     |
| `/api/snapshot`  | 30/min | Generous for normal use               |
| `/api/journal`   | 20/min | Query endpoint                        |
| Auth endpoints   | 5/min  | Brute-force protection                |

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

## Observability

### Structured Logging

All API routes use [pino](https://github.com/pinojs/pino) for structured JSON logging. Each log entry includes severity level, timestamp, and contextual fields (error objects, request metadata, usage metrics). Logs are searchable and filterable in Vercel function logs.

For local development with human-readable output, pipe through `pino-pretty`:

```bash
vercel dev 2>&1 | npx pino-pretty
```

### Error Tracking (Sentry)

Client-side errors are automatically captured via `@sentry/react` with browser tracing (20% sample rate, production only). The `ErrorBoundary` component forwards caught errors to Sentry with component stack traces. Requires `SENTRY_DSN` environment variable (auto-set via Vercel Sentry integration).

### Performance Analytics

Core Web Vitals (LCP, FID, CLS, TTFB) are reported to the Vercel dashboard via `@vercel/speed-insights`, alongside page view analytics from `@vercel/analytics`.

### Bundle Analysis

Generate an interactive treemap of the production bundle:

```bash
npm run build:analyze    # Opens dist/bundle-stats.html
```

---

## Testing

1,700 unit tests across 71 test files + Playwright E2E tests across 22 spec files (Chromium, Firefox, and WebKit), all passing with TypeScript strict mode.

### Unit Tests (Vitest)

| File                         | Focus                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `calculator.test.ts`         | 150+ tests: BS pricing, Greeks (delta/gamma/theta/vega), strikes, kurtosis, stressed sigma |
| `ChartAnalysis.test.tsx`     | 64 tests: image management, confirmation, cancel, analyze flow, modes, error handling      |
| `useComputedSignals.test.ts` | 70 tests: regime, DOW, range, opening range, term shape, RV/IV, directional clustering     |
| `skewAndIC.test.ts`          | 63 tests: convex skew, IC legs, per-side PoP, breakevens                                   |
| `hedge.test.tsx`             | 32 tests: hedge sizing, scenarios, DTE pricing, breakevens, real-world scenario            |
| `PinRiskAnalysis.test.tsx`   | 7 tests: OI table, pin risk warning, empty state, K formatting                             |
| `RvIvCard.test.tsx`          | 6 tests: ratio display, all 3 labels, RV/IV percentages                                    |
| `positions.test.ts`          | 17 tests: handler, spread grouping, summary building, DB save, error paths                 |
| `db.test.ts`                 | 34 tests: schema init, migrations, snapshots, analyses, outcomes, positions, previous recs |
| `journal-migrate.test.ts`    | 5 tests: migration endpoint, idempotency, error handling                                   |

### E2E Tests (Playwright — Chromium, Firefox, WebKit)

| File                          | Coverage                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| `calculator-flow.spec.ts`     | Full calculation flow, mode switching, dark mode             |
| `strike-table.spec.ts`        | Delta rows, ordering invariants, VIX sensitivity             |
| `iron-condor.spec.ts`         | IC legs, hedge toggle, contracts, hide/show                  |
| `hedge-dte.spec.ts`           | DTE selector, EOD recovery, net cost labels, scenarios       |
| `iv-acceleration.spec.ts`     | σ multiplier at different times, late session warning        |
| `fat-tail-pop.spec.ts`        | Adjusted PoP display, struck-through log-normal              |
| `market-regime-new.spec.ts`   | Clustering, term structure shapes (contango/fear-spike/flat) |
| `entry-time.spec.ts`          | Time selects, AM/PM, timezone, recalculation                 |
| `advanced-section.spec.ts`    | Skew slider, wing width, contracts counter                   |
| `chart-analysis.spec.ts`      | Mode selector, drop zone, mocked analysis                    |
| `validation-errors.spec.ts`   | Input validation, error states, clearing                     |
| `responsive.spec.ts`          | iPhone, iPad, desktop viewports                              |
| `a11y-automated.spec.ts`      | Axe-core WCAG 2.1 AA scans (home, results, dark mode)        |
| `accessibility.spec.ts`       | Keyboard navigation, ARIA attributes, focus management       |
| `cross-section.spec.ts`       | Cross-section interaction flows                              |
| `export-download.spec.ts`     | CSV and Excel export/download verification                   |
| `extreme-inputs.spec.ts`      | Edge cases: extreme values, boundary inputs                  |
| `theme-persistence.spec.ts`   | Dark mode persistence across page reloads                    |
| `date-lookup.spec.ts`         | Date picker with event day integration                       |
| `delta-regime-guide.spec.ts`  | Delta guide ceiling and regime badges                        |
| `opening-range.spec.ts`       | Opening range check signals                                  |
| `parameter-summary.spec.ts`   | Parameter summary display                                    |

```bash
npm test                 # Watch mode
npm run test:run         # Single run (CI)
npm run test:coverage    # v8 coverage report
npm run test:e2e         # Playwright E2E tests (all browsers)
npm run test:e2e:ui      # Playwright interactive UI mode
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
3. Add Sentry: Vercel Integrations → Sentry (auto-sets `SENTRY_DSN`)
4. Set environment variables: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SECRET`, `ANTHROPIC_API_KEY`
5. Initialize tables: `POST /api/journal/init`
6. Authenticate: Visit `/api/auth/init` → Schwab login
7. Backfill outcomes: `npx tsx scripts/backfill-outcomes.ts`

---

## Accessibility

Section 508 / WCAG 2.1 AA: semantic HTML, ARIA attributes, focus management, 4.5:1 contrast, `prefers-reduced-motion`, labeled inputs, `role="alert"` for errors. Automated accessibility scanning via `@axe-core/playwright` runs against home, results, and dark mode views on every E2E test run.

---

## Scripts Reference

| Command                                  | Description                                      |
| ---------------------------------------- | ------------------------------------------------ |
| `npm run dev`                            | Vite dev server with HMR                         |
| `npm run build`                          | TypeScript check + production build              |
| `npm run build:analyze`                  | Production build + interactive bundle treemap    |
| `npm test`                               | Vitest watch mode                                |
| `npm run test:run`                       | Single test run (CI)                             |
| `npm run test:coverage`                  | v8 coverage report                               |
| `npm run lint`                           | TypeScript + ESLint check                        |
| `npm run test:e2e`                       | Playwright E2E tests (Chromium, Firefox, WebKit) |
| `npm run test:e2e:ui`                    | Playwright interactive UI mode                   |
| `npm run format`                         | Prettier format all files                        |
| `npm run format:check`                   | Prettier check (CI)                              |
| `npx tsx scripts/backfill-outcomes.ts`   | Populate outcomes table from CSVs                |
| `npx tsx scripts/entry-time-analysis.ts` | Entry timing study (8:45 vs 9:00)                |

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
2. **IV acceleration is empirical**: The intraday σ multiplier (0.6 coefficient) is calibrated from observed behavior, not derived from a formal model. Actual gamma acceleration varies by VIX regime and market structure. The multiplier is capped at 1.8× to prevent extreme values near close.
3. **Fat-tail kurtosis is a constant**: The 2× kurtosis factor is calibrated from 9,102 days of SPX data. Real kurtosis varies by VIX level (higher VIX = fatter tails) and time of day. A VIX-dependent kurtosis curve would be more accurate.
4. **Convex skew exponent is static**: The 1.35 put convexity is empirically reasonable for typical VIX 15-25 days. On extreme fear days (VIX 35+), real put skew can be significantly steeper. The chain endpoint shows actual per-strike IV for comparison.
5. **Theoretical vs market premiums**: Black-Scholes assumes continuous hedging; real prices include bid/ask spreads
6. **Parkinson RV estimator**: Uses only yesterday's single-day high-low range. A multi-day rolling RV (5-20 days) would be smoother but requires more historical data access.
7. **Chart analysis limitations**: Claude reads charts visually — it estimates NCP/NPP values from line positions, not exact data. Image quality affects accuracy.
8. **Backtest limitations**: Periscope gamma profiles are point-in-time screenshots; historical gamma data is not available programmatically
9. **Database coverage**: VIX1D data available from May 2022 only; earlier outcomes have VIX close but not VIX1D close
10. **Pin risk requires live chain**: OI heatmap only available during market hours with authenticated Schwab session. Historical OI data is not persisted.
