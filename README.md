# 0DTE Options Strike Calculator

A production-grade 0DTE SPX options analysis platform combining Black-Scholes pricing, AI-powered chart analysis (Claude Opus 4.7), live market data (Schwab + Unusual Whales), position tracking, and a multi-phase ML pipeline — designed for professional same-day SPX/SPY options trading.

Built with React 19, TypeScript (strict mode), Vite, and Tailwind CSS 4. Deployed on Vercel with Neon Postgres, Upstash Redis, Schwab API, Anthropic API, OpenAI, Unusual Whales, and Sentry integrations. ES futures relay runs on Railway.

Live at: [theta-options.com](https://theta-options.com)

## Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [Strike Calculation](#strike-calculation)
  - [SPY/SPX Conversion](#spyspx-conversion)
  - [IV Input](#iv-input)
  - [Iron Condor & Credit Spread Analysis](#iron-condor--credit-spread-analysis)
  - [Probability of Profit (PoP)](#probability-of-profit-pop)
  - [Broken-Wing Butterfly (BWB) Calculator](#broken-wing-butterfly-bwb-calculator)
  - [Risk Calculator & Position Sizing](#risk-calculator--position-sizing)
  - [Hedge Calculator (Reinsurance)](#hedge-calculator-reinsurance)
  - [Realized vs Implied Volatility](#realized-vs-implied-volatility)
  - [Theta-Weighted Entry Timing](#theta-weighted-entry-timing)
  - [Settlement Pin Risk](#settlement-pin-risk)
  - [UI](#ui)
- [Chart Analysis (Claude Opus 4.7)](#chart-analysis-claude-opus-47)
  - [Three Analysis Modes](#three-analysis-modes)
  - [What Claude Receives](#what-claude-receives)
  - [What Claude Returns](#what-claude-returns)
  - [UI Features](#ui-features)
  - [Technical Details](#technical-details)
- [Lessons Learned System](#lessons-learned-system)
  - [How It Works](#how-it-works)
  - [Friday Cron Pipeline](#friday-cron-pipeline)
  - [Safety Mechanisms](#safety-mechanisms)
  - [Backfill](#backfill)
- [Live Option Chain Verification](#live-option-chain-verification)
- [Backtesting System](#backtesting-system)
- [Live Position Tracking](#live-position-tracking)
  - [Schwab Trader API (Live Accounts)](#schwab-trader-api-live-accounts)
  - [PaperMoney CSV Upload (Paper Trading)](#papermoney-csv-upload-paper-trading)
  - [Position Monitor (Paper Dashboard)](#position-monitor-paper-dashboard)
  - [What Claude Sees](#what-claude-sees)
- [Market Regime Intelligence](#market-regime-intelligence)
  - [VIX Regime Card](#vix-regime-card)
  - [Delta Guide](#delta-guide)
  - [VIX Term Structure](#vix-term-structure)
  - [Opening Range Check](#opening-range-check)
  - [Volatility Clustering](#volatility-clustering)
  - [Event Day Warning](#event-day-warning)
  - [Pre-Trade Signals](#pre-trade-signals)
  - [Dark Pool Levels](#dark-pool-levels)
- [Data Collection & ML Pipeline](#data-collection--ml-pipeline)
  - [Database Schema (40+ Tables)](#database-schema-40-tables)
  - [Intraday Data Collection (35 Cron Jobs)](#intraday-data-collection-35-cron-jobs)
  - [ML Pipeline (Python)](#ml-pipeline-python)
  - [Nightly Automation (GitHub Actions)](#nightly-automation-github-actions)
  - [ML Insights (Frontend)](#ml-insights-frontend)
- [Futures + ES Options Sidecar (Railway)](#futures--es-options-sidecar-railway)
- [Live Market Data API](#live-market-data-api)
  - [Architecture](#architecture)
  - [Owner Gating](#owner-gating)
  - [Authentication Flow](#authentication-flow)
  - [Token Storage](#token-storage)
- [The Math](#the-math)
  - [Strike Calculation Formula](#strike-calculation-formula)
  - [Option Pricing (Black-Scholes)](#option-pricing-black-scholes)
  - [Iron Condor P&L](#iron-condor-pl)
  - [Delta Guide — Range-to-Delta Mapping](#delta-guide--range-to-delta-mapping)
  - [Time-to-Expiry](#time-to-expiry)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Development](#development)
  - [Environment Variables](#environment-variables)
  - [Database Setup](#database-setup)
- [Project Structure](#project-structure)
- [Architecture & Design](#architecture--design)
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
  - [Unit Tests (Vitest)](#unit-tests-vitest)
  - [E2E Tests (Playwright — Chromium, Firefox, WebKit)](#e2e-tests-playwright--chromium-firefox-webkit)
- [Deployment](#deployment)
  - [Vercel (Production)](#vercel-production)
  - [Railway (ES Sidecar)](#railway-es-sidecar)
  - [Post-Deploy Setup](#post-deploy-setup)
- [Accessibility](#accessibility)
- [Scripts Reference](#scripts-reference)
- [Trading Workflow](#trading-workflow)
  - [Daily Flow](#daily-flow)
  - [Structure Selection (from Chart Analysis)](#structure-selection-from-chart-analysis)
  - [Structure Selection Rules (Empirical)](#structure-selection-rules-empirical)
- [Position Sizing Guide](#position-sizing-guide)
- [Accuracy & Limitations](#accuracy--limitations)
- [License](#license)

---

## Overview

This tool solves a specific problem for 0DTE options traders: given a spot price, time of day, and implied volatility, where should your delta-targeted strikes be, what are the theoretical premiums, what does your iron condor P&L look like, and what delta ceiling should you respect based on today's VIX regime, term structure, volatility clustering, and day-of-week effects?

All financial calculations run client-side with zero external dependencies. For the site owner, integrations with Schwab (market data + option chains + positions), Anthropic (Claude chart analysis + lessons curation), Unusual Whales (flow, GEX, dark pool, candles), OpenAI (embeddings), and Neon Postgres (data collection + ML features) provide a complete AI-augmented trading workflow. Public visitors use the same full calculator with manual input.

You input (or auto-receive) the current SPY price, the VIX (plus optionally VIX1D and VIX9D), and the time — and it gives you:

- A complete strike table across 6 delta targets (5Δ through 20Δ) with theoretical put and call premiums
- A full iron condor breakdown split into put spread, call spread, and combined IC — with credit, max loss, buying power, return on risk, fat-tail adjusted probability of profit, and breakevens in both SPX and SPY terms
- A broken-wing butterfly calculator with gamma-anchored sweet spot placement and full P&L scenarios
- A risk calculator with position sizing, risk tiers, and buy/sell mode analysis
- A hedge calculator with DTE selection (1-21 days), extrinsic value modeling at EOD close, net cost breakdown, and crash/rally scenario tables
- A Delta Guide with a ceiling recommendation based on 9,102 days of historical VIX-to-SPX range data, adjusted for day-of-week effects and directional volatility clustering
- AI-powered chart analysis that reads Market Tide, Net Flow, and Periscope screenshots to recommend structure, delta, strike placement, entry plan, management rules, and hedge
- A self-improving lessons system where end-of-day reviews produce lessons that are vector-deduplicated and injected into future analyses
- Live option chain verification comparing theoretical strikes to actual Schwab chain deltas
- VIX term structure signals with curve shape classification (contango, fear-spike, backwardation, hump, flat)
- Realized vs implied volatility ratio using 5-day rolling Parkinson RV, showing whether IV is rich or cheap
- Settlement pin risk analysis with OI heatmap from live Schwab chain data
- Pre-trade signal cards (RV/IV, overnight gap, breadth, GEX regime, charm decay)
- Dark pool support/resistance levels from Unusual Whales ($5M+ block clustering)
- Opening range check comparing the first 30 minutes of trading against the expected daily range
- Volatility clustering analysis with directional asymmetry (bigger put-side expansion after down days)
- Event day warnings for FOMC, CPI, NFP, GDP, and earnings with severity-coded alerts and actionable advice
- Historical backtesting with full candle-by-candle replay and settlement verification
- Position monitor with paper dashboard, execution quality analysis, and theta decay simulation
- Automatic data collection to Postgres (40+ tables, 35 cron jobs) feeding a multi-phase ML pipeline
- ML Insights section with nightly pipeline plots analyzed by Claude vision
- ES futures WebSocket relay on Railway for overnight session data

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

### Broken-Wing Butterfly (BWB) Calculator

Advanced multi-leg strategy builder for directional premium collection (owner-only):

- **Side selector**: Put BWB or Call BWB
- **Three-leg strikes**: Low, Mid (sweet spot), High — auto-generated from narrow wing width × wide multiplier
- **Wing width configuration**: Narrow wing 10–30 SPX points, wide multiplier 1.5–3.0×
- **Gamma anchor integration**: Fetch optimal gamma zone anchor from `/api/bwb-anchor`, with charm-adjusted anchor option (GEX + charm flow). One-click populate sweet spot from anchor.
- **Full P&L profile**: Scenarios from −5% to +5% SPX move with per-contract and total P&L, max profit/loss zones, breakeven level
- **Greeks & metrics**: Net credit received, max profit at sweet spot, max loss on wide side, return on risk, probability of profit (fat-tail adjusted)
- **Excel export**: One-click XLSX export of BWB P&L comparison

### Risk Calculator & Position Sizing

Comprehensive position sizing and risk management tool:

- **Mode selection**: Sell (credit spreads, ICs) or Buy (debit spreads, directional)
- **Trade inputs**: Account balance, credit/premium, wing width, contracts, optional delta/PoP targets
- **Risk metrics**: Gross/net loss per contract, total loss % of account, buying power required, max positions allowed, risk-to-reward ratio, expected value per contract
- **Risk tier table**: 1%, 2%, 3%, 5%, 10% of account risk scenarios
- **Position count matrix**: Wing width × contracts combinations showing max positions at each risk level

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
- SVG line chart showing premium % retained vs. hours to close with theta per hour table

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
- Sticky section navigation with 11 sections: Inputs, Settings, Risk, Regime, Dark Pool, Charts, History, ML Insights, Positions, BWB, Results
- Debounced inputs: Text fields recalculate after 250ms; dropdowns and sliders update instantly
- Live data indicator: Shows "● LIVE" or "● CLOSED" badge when market data is streaming (owner-only)
- Collapsible section boxes with badge counts
- Toast notifications for success/error states
- Error boundary with Sentry integration for graceful component failure

---

## Chart Analysis (Claude Opus 4.7)

The centerpiece feature: upload screenshots of Market Tide, Net Flow (SPY/QQQ/SPX), and Periscope (Delta Flow/Gamma) from Unusual Whales, and Claude Opus 4.7 with adaptive thinking analyzes them alongside the calculator's full context to produce a complete trading plan.

### Three Analysis Modes

| Mode      | When                                 | What it produces                                                                                                   |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Pre-Trade | Before entry (~8:45 AM CT)           | Full plan: structure, delta, 3 laddered entries, strike placement from gamma zones, management rules, hedge, risks |
| Mid-Day   | During position (~10:00–11:00 AM CT) | Update: has flow shifted, should you close legs, is it safe to add Entry 2/3                                       |
| Review    | After close (~4:00 PM ET)            | Retrospective: was the structure correct, what signals predicted the outcome, lessons learned                      |

### What Claude Receives

- All uploaded chart images (up to 4, validated at the Zod boundary) with labels (Market Tide, Net Flow SPY, Net Flow QQQ, Net Flow SPX, Periscope Delta Flow, Periscope Gamma, Net Charm SPX)
- Full calculator context: SPX, VIX, VIX1D, VIX9D, VVIX, σ, T, hours remaining, delta ceiling, spread ceilings, regime zone, cluster multiplier (symmetric + directional put/call), DOW label, opening range signal, term structure signal + curve shape, RV/IV ratio, IV acceleration multiplier, overnight gap
- Live Schwab positions: Current SPX 0DTE spreads with strikes, credits, P&L, cushion distances, and net greeks — auto-fetched before each analysis so Claude knows what's already open
- Database-driven market context: Flow data (last 24h), GEX snapshots, SPX candles, dark pool clusters, max pain, economic events — all assembled by `buildAnalysisContext()`
- Active lessons from the lessons compendium, formatted with market condition metadata for selective application
- Previous recommendation (for mid-day/review continuity — auto-fetched from DB via `getPreviousRecommendation()`, with client-side `lastAnalysisRef` fallback for first-run or backtest scenarios)
- Data availability notes (VIX1D missing, pre-10AM opening range, backtest mode)

### What Claude Returns

- Structure: IRON CONDOR, PUT CREDIT SPREAD, CALL CREDIT SPREAD, or SIT OUT
- Confidence: HIGH, MODERATE, or LOW
- Suggested delta with per-chart confidence breakdown
- Strike placement guidance from Periscope gamma zones with straddle cone analysis
- Multi-entry laddering plan (3 entries with timing, conditions, size percentages)
- Position management rules (profit target, stop conditions, time rules, flow reversal signal)
- Hedge recommendation: NO HEDGE, REDUCED SIZE, PROTECTIVE LONG, or SKIP
- End-of-day review with wasCorrect, whatWorked, whatMissed, optimalTrade, lessonsLearned

### UI Features

- Drag-and-drop, file picker, or clipboard paste for image upload (max 4 images per the Zod schema in `api/_lib/validation.ts`)
- Per-image label selector (Market Tide, Net Flow SPY, Net Flow QQQ, Net Flow SPX, Periscope Delta Flow, Periscope Gamma, Net Charm SPX)
- Two-step confirmation: Analyze button → confirmation bar showing image count, mode, and labels → Confirm/Go Back
- Thinking indicator with progress bar, elapsed timer, rotating status messages, and Cancel button
- TL;DR summary card always visible with structure, confidence, delta, hedge badge, Entry 1 details, profit target
- Collapsible detail sections: Strike Guidance and Entry Plan expanded by default, all others collapsed
- Image issues: Claude flags genuinely unreadable images with Replace button for each
- Raw response fallback when JSON parsing fails

### Technical Details

- Model: Claude Opus 4.7 (`claude-opus-4-7`)
- Adaptive thinking: `thinking: { type: 'adaptive' }` — Claude decides how much thinking budget to use per request
- Max tokens: 128,000 (Opus primary) / 64,000 (Sonnet fallback)
- Vercel function timeout: 800 seconds (`maxDuration: 800`)
- Client-side timeout: 750 seconds / 12m 30s (AbortController)
- Cost: ~$0.40–0.60 per analysis (4 images with thinking)
- System prompt caching: `cache_control: { type: 'ephemeral' }` for ~90% cost reduction on static prompt parts (~23K tokens)
- Owner-gated: requires authenticated session cookie
- Rate limited: 3 analyses per minute via Upstash Redis
- Fallback: Sonnet 4.6 (`claude-sonnet-4-6`) if Opus unavailable (availability errors only — request errors do not trigger fallback)

---

## Lessons Learned System

A self-improving closed-loop system where Claude's end-of-day review analyses produce lessons that are automatically curated, deduplicated, and injected back into future analyses — making each trading session's recommendations smarter than the last.

### How It Works

1. **Review mode produces lessons.** When Claude runs an end-of-day review, it generates `lessonsLearned[]` — actionable insights about what worked, what was missed, and what to do differently next time.

2. **Friday cron curates lessons.** Every Friday at 10:00 PM ET, a Vercel cron job (`/api/cron/curate-lessons`) extracts lessons from the week's reviews and deduplicates them against the existing compendium using OpenAI `text-embedding-3-large` vector similarity + Claude Opus judgment.

3. **Lessons injected at analysis time.** When `/api/analyze` is called, all active lessons are fetched from the `lessons` table and injected into Claude's system prompt as a `<lessons_learned>` block between `</structure_selection_rules>` and `<data_handling>`. Claude selectively references applicable lessons based on current market conditions.

### Friday Cron Pipeline

| Step | Description                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Bootstrap a `lesson_reports` row (upsert for crash safety)                                                                                                                                     |
| 1    | Query unprocessed review analyses from the past 7 days                                                                                                                                         |
| 2    | **Phase A** (outside transaction): For each lesson — generate embedding via OpenAI, find 5 most similar existing lessons by cosine distance, call Claude Opus to decide ADD / SUPERSEDE / SKIP |
| 3    | **Phase B** (inside transaction): Batch all DB writes for a review atomically via `sql.transaction()`. Pre-allocate IDs via `nextval` for SUPERSEDE operations.                                |
| 4    | Build weekly changelog report and save to `lesson_reports`                                                                                                                                     |

Claude's curation rules enforce safety: it may NEVER edit existing lesson text, NEVER merge two lessons into one, and must ADD rather than SUPERSEDE when in doubt.

**Schedule:** `0 3 * * 6` (Saturday 3:00 AM UTC = Friday 10:00 PM ET)

**Endpoint:** `GET /api/cron/curate-lessons` (auth: `Authorization: Bearer <CRON_SECRET>`)

### Safety Mechanisms

- **Append-only** — Lesson text is never modified after insertion
- **Provenance chain** — Every lesson traces back to a specific review analysis via `source_analysis_id` (ON DELETE RESTRICT)
- **Vector-assisted dedup** — Pre-filters to 5 nearest lessons before Claude judges, reducing hallucination risk
- **Conservative curation prompt** — "When in doubt, ADD rather than SUPERSEDE"
- **Per-review atomicity** — All lesson writes for a single review succeed or fail together
- **Weekly changelog** — `lesson_reports` table stores full add/supersede/skip details with reasoning
- **Manual override** — Flip lesson status directly in Neon UI (`active` → `archived` or `superseded` → `active`)
- **CHECK constraints** — `status` and `category` columns are database-constrained to valid values

### Backfill

To seed the compendium from all historical review analyses (not just the last 7 days):

```bash
curl -X GET "https://theta-options.com/api/cron/curate-lessons?backfill=true" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

This processes every review-mode analysis in the database. One-time operation — after that, the weekly cron handles new reviews automatically.

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

Real-time SPX 0DTE position awareness via the Schwab Trader API or manual CSV upload from thinkorswim paperMoney. Before each chart analysis, the frontend auto-fetches current positions so Claude can factor in what's already open.

### Schwab Trader API (Live Accounts)

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

### PaperMoney CSV Upload (Paper Trading)

Schwab's Trader API doesn't expose thinkorswim paperMoney positions. To work around this, you can export an account statement CSV from paperMoney and upload it directly.

| Feature         | Detail                                                                                 |
| --------------- | -------------------------------------------------------------------------------------- |
| Endpoint        | `POST /api/positions?spx=5700`                                                         |
| Data source     | thinkorswim paperMoney account statement CSV export                                    |
| Body format     | Raw CSV text or JSON `{ csv: "..." }`                                                  |
| CSV parsing     | Extracts the "Options" section, filters for SPX, parses strikes/qty/prices/mark values |
| Date parsing    | Converts thinkorswim format (`17 MAR 26`) to ISO (`2026-03-17`)                        |
| Value parsing   | Handles `$450.00` and parenthesized negatives `($1,050.00)`                            |
| Spread grouping | Same logic as live — matches short + long legs by closest strike                       |
| DB persistence  | Saved with `accountHash: 'paperMoney'`, same pipeline as live positions                |
| UI              | "Upload paperMoney Positions (.csv)" button in the Chart Analysis section              |
| Feedback        | Shows spread count on success or error message on failure                              |

**How to use:**

1. In thinkorswim paperMoney, go to **Monitor** > **Account Statement** and export to CSV
2. In the Chart Analysis section, click **Upload paperMoney Positions (.csv)** and select the file
3. The parsed positions are saved to the database and automatically included in Claude's analysis context

### Position Monitor (Paper Dashboard)

Full-featured position monitor with statement parsing and P&L analysis:

- **Account overview**: Cash, buying power, margin, portfolio value
- **Position table**: Strike pairs, quantity, entry/current price, P&L (open, unrealized %), per-contract Greeks (Delta, Gamma, Theta, Vega), DTE countdown
- **Execution quality analysis**: Entry execution price vs. theoretical, slippage analysis
- **Risk summary**: Portfolio Delta, Gamma, Theta, Vega exposure, max loss scenario
- **Strike map**: Visual representation of opened positions relative to spot
- **Theta decay simulator**: Time picker with Black-Scholes re-estimation at future time
- **Stop-loss modeling**: Adjustable multiplier (0 = theoretical max loss, 2–4× = stop at N× credit)

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

Static calendar of FOMC (8/year), CPI (12/year), NFP (12/year), GDP (4/year) for 2025–2026 with severity-coded banners. Dynamic economic events from FRED API (PCE, PPI, Retail Sales, JOLTS) + Finnhub earnings calendar. Early close dates for day-before-holiday sessions.

### Pre-Trade Signals

Compact signal cards displayed before trade entry:

- **RV/IV ratio**: Realized vs. implied volatility classification (Rich/Fair/Cheap)
- **Overnight gap**: ES futures gap size, direction, and fill probability
- **GEX regime**: Aggregate gamma exposure classification
- **Charm decay profile**: Positive/negative charm direction
- **Flow agreement**: Cross-source flow direction alignment
- **Risk status**: Aggregate pre-trade risk summary

### Dark Pool Levels

Real-time dark pool support/resistance from Unusual Whales (owner-only):

- Clusters $5M+ SPY dark pool blocks by price, translates to SPX via ratio
- Identifies buyer/seller-initiated trades
- Shows current support and resistance levels with strength indicators
- Relationship to spot price (above/below/at)
- Updated every minute during market hours via cron

---

## Data Collection & ML Pipeline

### Database Schema (40+ Tables)

**Core Trading Tables:**

| Table              | Purpose                                 | Key Fields                                           | Constraint             |
| ------------------ | --------------------------------------- | ---------------------------------------------------- | ---------------------- |
| `market_snapshots` | Complete calculator state (50+ columns) | Prices, vol surface, regime, strikes JSONB, events   | UNIQUE(date, time)     |
| `analyses`         | Claude chart analysis responses         | mode, structure, confidence, delta, full_response    | FK → snapshots         |
| `outcomes`         | End-of-day settlement data              | OHLC, range, close_vs_open, vix_close, vix1d_close   | UNIQUE(date)           |
| `positions`        | Live SPX 0DTE position snapshots        | legs JSONB, net greeks, unrealized P&L               | UNIQUE(date, time)     |
| `lessons`          | Self-improving trading compendium       | text, status, embedding vector(2000), category, tags | UNIQUE(analysis, text) |
| `lesson_reports`   | Weekly curation changelog               | reviews processed, adds/supersedes/skips, report     | UNIQUE(week_ending)    |

**Market Data Tables (intraday time series):**

| Table              | Purpose                          | Key Fields                               | Granularity     |
| ------------------ | -------------------------------- | ---------------------------------------- | --------------- |
| `flow_data`        | Market Tide & net flow by source | ncp, npp, net_volume, source             | 5-minute        |
| `greek_exposure`   | MM Greek exposure per expiration | gamma, charm, delta, vanna (call/put)    | Daily by expiry |
| `spot_exposures`   | Aggregate GEX per timestamp      | gamma/charm/vanna (oi/vol/dir)           | 5-minute        |
| `strike_exposures` | Per-strike Greek profile         | gamma/charm/delta/vanna by strike+expiry | 5-minute        |

**ML Tables:**

| Table               | Purpose                                   | Key Fields                                            | Granularity       |
| ------------------- | ----------------------------------------- | ----------------------------------------------------- | ----------------- |
| `training_features` | Engineered feature vectors (100+ columns) | Flow checkpoints, GEX, Greeks, dark pool, options     | 1 row/trading day |
| `day_labels`        | ML training labels from review analyses   | structure_correct, flow signals, settlement direction | 1 row/trading day |
| `economic_events`   | FRED + Finnhub calendar                   | event_name, event_time, type, forecast, previous      | Per event         |

### Intraday Data Collection (35 Cron Jobs)

All cron jobs are guarded by `CRON_SECRET` and run during market hours (13–21 UTC, Mon–Fri) unless otherwise noted.

**Every 5 minutes (market hours):**

| Cron                    | Source         | Target Table       | Data                           |
| ----------------------- | -------------- | ------------------ | ------------------------------ |
| `fetch-flow`            | Unusual Whales | `flow_data`        | Market Tide (all-in + OTM)     |
| `fetch-net-flow`        | Unusual Whales | `flow_data`        | SPX, SPY, QQQ net flow         |
| `fetch-etf-tide`        | Unusual Whales | `flow_data`        | SPY, QQQ ETF fund flow         |
| `fetch-zero-dte-flow`   | Unusual Whales | `flow_data`        | 0DTE-specific flow             |
| `fetch-greek-flow`      | Unusual Whales | `flow_data`        | Delta flow per symbol          |
| `fetch-greek-exposure`  | Unusual Whales | `greek_exposure`   | Agg + by-expiry Greek exposure |
| `fetch-spot-gex`        | Unusual Whales | `spot_exposures`   | Aggregate GEX snapshot         |
| `fetch-strike-exposure` | Unusual Whales | `strike_exposures` | Per-strike Greeks (0DTE)       |
| `fetch-strike-all`      | Unusual Whales | `strike_exposures` | All-strike composite data      |

**Every minute (market hours):**

| Cron                 | Source         | Target Table        | Data                          |
| -------------------- | -------------- | ------------------- | ----------------------------- |
| `monitor-iv`         | Internal       | `training_features` | IV snapshots + crush rate     |
| `monitor-flow-ratio` | Internal       | `training_features` | Flow ratio dynamics           |
| `fetch-darkpool`     | Unusual Whales | (DB)                | $5M+ dark pool block tracking |

**Post-close and daily:**

| Cron                      | Schedule          | Data                                   |
| ------------------------- | ----------------- | -------------------------------------- |
| `fetch-outcomes`          | 4:25, 5:25 PM ET  | SPX OHLC settlement + VIX close        |
| `fetch-oi-change`         | 5:30 PM ET        | Open interest changes                  |
| `fetch-oi-per-strike`     | 10:00 AM ET       | Per-strike OI snapshot                 |
| `fetch-vol-surface`       | 5:35 PM ET        | IV term structure by strike/expiry     |
| `fetch-economic-calendar` | 9:25, 10:25 AM ET | FRED + Finnhub events                  |
| `compute-es-overnight`    | 9:35, 10:35 AM ET | ES futures overnight session summary   |
| `build-features`          | 4:45, 5:45 PM ET  | ML feature engineering (100+ features) |
| `curate-lessons`          | Sat 3:00 AM UTC   | Weekly lessons curation pipeline       |
| `backup-tables`           | Sun 5:00 AM UTC   | Database backup to Vercel Blob         |
| `health`                  | Mon 9:25 AM ET    | Postgres + Redis + Schwab token check  |

### ML Pipeline (Python)

A multi-phase machine learning system (~8,000 lines of Python) that augments the rule-based system with statistical validation. Located in `ml/`.

**Pipeline Phases:**

| Phase     | Name                           | Status          | Purpose                                                                                     |
| --------- | ------------------------------ | --------------- | ------------------------------------------------------------------------------------------- |
| Phase 0   | Data Infrastructure            | ✅ Complete     | 100+ feature columns, daily engineering, feature tracking                                   |
| Phase 1   | Day Type Clustering            | ✅ Complete     | K-Means, GMM, hierarchical clustering with PCA                                              |
| Phase 1.5 | Exploratory Data Analysis      | ✅ Complete     | 9 analysis sections: rule validation, feature importance, flow reliability, dark pool, etc. |
| Phase 2   | Structure Classification       | 🔄 Early        | 5-model comparison (XGBoost, LR, RF, NB, DT) with walk-forward validation                   |
| Phase 3   | Charm Divergence Predictor     | 📊 Accumulating | Predict when naive charm chart misleads vs. Periscope                                       |
| Phase 4   | Intraday Range Regression      | 📊 Accumulating | Predict daily H-L range, beating VIX baseline                                               |
| Phase 5   | Optimal Exit Timing            | ⏸ Blocked       | Survival analysis — requires timestamped entry/exit data                                    |
| Phase 6   | Flow-Price Divergence Detector | 📊 Accumulating | Automate Rule 10 with learned thresholds                                                    |

**Python Scripts (`ml/src/`):**

| Script               | Lines  | Purpose                                            |
| -------------------- | ------ | -------------------------------------------------- |
| `utils.py`           | 400+   | DB connection, feature groups, validation helpers  |
| `eda.py`             | 1,500+ | 9-section exploratory analysis                     |
| `clustering.py`      | 600+   | Phase 1 unsupervised clustering                    |
| `phase2_early.py`    | 450+   | 5-model walk-forward comparison                    |
| `visualize.py`       | 700+   | 21 publication-quality plots                       |
| `backtest.py`        | 500+   | P&L simulation comparing 3 strategies              |
| `pin_analysis.py`    | 600+   | Settlement pin risk using per-strike gamma         |
| `health.py`          | 800+   | 5 pipeline health checks (freshness, stationarity) |
| `milestone_check.py` | 500+   | Data milestone tracker + script recommendations    |
| `explore.py`         | 200+   | Data export/summary with CSV output                |

**Feature Engineering Pipeline (`build-features` cron):**

The feature engineering cron (`/api/cron/build-features`) runs 4 phases after market close:

1. **Flow checkpoints** — NCP/NPP agreement at T1–T8 intervals across 6 sources
2. **GEX features** — Gamma OI/vol/dir at checkpoints, slopes, Greek exposure, per-strike gamma walls + charm slopes
3. **Phase 2 temporal** — Previous day metrics, realized vol, max pain, dark pool, options volume/premium/PCR
4. **Monitor dynamics** — IV crush rate, spike counts, flow ratio trends from minute-level data

Output: One row per trading day in `training_features` (100+ columns) + `day_labels`.

### Nightly Automation (GitHub Actions)

**Workflow:** `.github/workflows/ml-pipeline.yml`

- **Schedule:** 01:45 UTC Tue–Sat (9:45 PM ET, after `build-features` completes)
- **Trigger:** Cron + manual dispatch
- **Pipeline:**
  1. Setup Python 3.13 + Node 24
  2. Run `make -C ml all` (health → EDA → clustering → visualize → phase2 → backtest → pin)
  3. Upload all plots to Vercel Blob (`ml-plots/latest/`)
  4. Trigger Claude vision analysis (`POST /api/ml/analyze-plots`) for AI interpretation of each plot
  5. Commit `findings.json` if changed

### ML Insights (Frontend)

Owner-only section displaying nightly pipeline results:

- **Findings summary**: Key insights, plot count, analysis date, pipeline status
- **Plot carousel**: Navigate through ML-generated charts (21 plot types) with AI analysis overlay
- **Plot types include**: Feature correlations, range by regime, flow reliability, GEX vs. range, daily timeline, structure confidence, day-of-week patterns, stationarity, clusters (PCA + heatmap), SHAP importance, backtest equity, pin risk composite, dark pool vs. range, and more
- **Refresh button**: Manual trigger for latest results

---

## Futures + ES Options Sidecar (Railway)

A Python ingest service deployed separately on Railway, pulling 7 futures symbols (ES, NQ, ZN, RTY, CL, GC, DX) and ES options data from [Databento](https://databento.com) and writing directly to Neon Postgres. Runs outside Vercel because Databento's Python client expects a long-lived process, and because Railway offers cheaper sustained compute than Vercel Functions for this batch-ingest workload.

**Architecture:**

```text
Databento API
  ↓ (databento SDK + psycopg2)
[sidecar/src/main.py]
  ├─ symbol_manager.py  → resolve ES → ESH26 front month
  ├─ databento_client.py → fetch futures OHLCV + ES options chains
  ├─ db.py              → direct psycopg2 upserts (not @neondatabase/serverless)
  └─ health.py          → /health endpoint for Railway probe
  ↓
Neon Postgres [futures_snapshots, futures_options_daily, ...]
```

**Key features:**

- **Python, not Node** — `sidecar/` is its own project with `pyproject.toml`, `requirements.txt`, and a Dockerfile. Uses `psycopg2` directly (not `@neondatabase/serverless`) since it's not running in a serverless context.
- **7 futures symbols** covering the full macro picture: ES (equities), NQ (tech equities), ZN (10Y Treasury), RTY (small caps), CL (crude), GC (gold), DX (dollar index). VX (VIX futures) is planned but deferred pending Databento availability.
- **ES options ingest** — end-of-day chain snapshots for 14 DTE directional signal, populating `futures_options_daily`.
- **Sentry SDK** for error tracking (`sentry_setup.py`); separate DSN from the Vercel side.
- **Railway-specific config** — `railway.toml` for build + deploy; env vars (`DATABENTO_API_KEY`, `DATABASE_URL`, `SENTRY_DSN`) live in Railway's secret store, NOT Vercel's.
- **Vercel build gating** — the root `vercel.json` `ignoreCommand` skips Vercel deploys when only `sidecar/`, `ml/`, or `scripts/` change, so sidecar commits don't trigger wasted frontend rebuilds.

**Consumed by the Vercel side via:**

- `api/_lib/futures-context.ts` — reads `futures_snapshots` + `futures_options_daily` into Claude's analysis context, with Zod row-parsing for schema drift safety.
- `api/cron/backfill-futures-gaps.ts` — fills in weekend / holiday gaps when Databento backfills late.

---

## Live Market Data API

### Architecture

| Endpoint                     | Source                                | Returns                                     | Cache (market) | Cache (closed) |
| ---------------------------- | ------------------------------------- | ------------------------------------------- | -------------- | -------------- |
| `GET /api/quotes`            | Schwab (`getQuotes`)                  | Real-time SPY, SPX, VIX, VIX1D, VIX9D, VVIX | 60s            | 5 min          |
| `GET /api/intraday`          | Schwab (`priceHistory`, 5-min)        | Today's OHLC + 30-min opening range         | 2 min          | 10 min         |
| `GET /api/yesterday`         | Schwab (`priceHistory`, daily)        | Prior 5 days SPX OHLC for rolling RV        | 1 hour         | 1 day          |
| `GET /api/chain`             | Schwab (`chains`, 0DTE)               | Live option chain with per-strike deltas    | 30s            | —              |
| `GET /api/history`           | Schwab (`priceHistory`, multi-symbol) | Historical candles for backtesting          | 1 hour         | 1 day          |
| `GET /api/movers`            | Schwab (`movers`)                     | Market movers                               | 5 min          | 10 min         |
| `GET /api/positions`         | Schwab Trader API                     | Live SPX 0DTE positions + spreads           | —              | —              |
| `GET /api/events`            | FRED + Finnhub                        | Economic calendar events                    | 7d Redis       | 7d Redis       |
| `GET /api/darkpool-levels`   | Unusual Whales                        | Dark pool support/resistance                | 60s            | —              |
| `GET /api/iv-term-structure` | Unusual Whales                        | Volatility term structure                   | —              | —              |
| `GET /api/bwb-anchor`        | Internal (GEX + charm)                | BWB gamma anchor level                      | —              | —              |
| `POST /api/analyze`          | Anthropic Messages API                | Claude chart analysis                       | —              | —              |
| `GET /api/analyses`          | Neon Postgres                         | Browse past analyses (public)               | —              | —              |
| `POST /api/snapshot`         | Neon Postgres                         | Save market snapshot                        | —              | —              |
| `GET /api/journal`           | Neon Postgres                         | Query saved analyses                        | —              | —              |
| `GET /api/journal/status`    | Neon Postgres                         | DB connection + table counts                | —              | —              |
| `POST /api/journal/init`     | Neon Postgres                         | Create tables + run migrations              | —              | —              |
| `POST /api/journal/migrate`  | Neon Postgres                         | Add new columns (idempotent)                | —              | —              |
| `GET /api/health`            | Postgres + Redis + Schwab             | Service health check                        | —              | —              |
| `GET /api/alerts`            | Neon Postgres                         | Active market alerts                        | —              | —              |
| `POST /api/alerts-ack`       | Neon Postgres                         | Acknowledge alerts                          | —              | —              |
| `GET /api/pre-market`        | ES sidecar / manual                   | Overnight gap analysis                      | —              | —              |
| `GET /api/snapshot`          | Neon Postgres                         | Retrieve market snapshot                    | —              | —              |
| `GET /api/vix-ohlc`          | Neon Postgres                         | VIX OHLC from snapshots                     | —              | —              |

### Owner Gating

All data, analysis, and database endpoints are gated behind an HTTP-only session cookie (`sc-owner`) set during the Schwab OAuth flow, except `/api/analyses` (public read-only access to past analyses) and `/api/events` (public economic calendar). Public visitors get the full calculator with manual input.

### Authentication Flow

1. Owner visits `/api/auth/init` → redirects to Schwab login
2. After login, Schwab redirects to `/api/auth/callback` → tokens stored in Upstash Redis + owner cookie set
3. All subsequent API calls auto-refresh the access token using the refresh token
4. After 7 days, the refresh token expires → owner re-authenticates

**Token management:** Distributed lock in Redis prevents concurrent token refresh across parallel serverless invocations. In-memory fallback cache mitigates Redis blips during active invocation.

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
npm run dev:full     # Frontend + API functions via Vercel dev (localhost:3000)
```

### Environment Variables

See [.env.example](.env.example) for a copy-paste template with descriptions.

| Variable                   | Source                       | Purpose                           |
| -------------------------- | ---------------------------- | --------------------------------- |
| `SCHWAB_CLIENT_ID`         | developer.schwab.com         | Schwab API app key                |
| `SCHWAB_CLIENT_SECRET`     | developer.schwab.com         | Schwab API app secret             |
| `OWNER_SECRET`             | `openssl rand -hex 32`       | Owner session cookie value        |
| `UPSTASH_REDIS_REST_URL`   | Auto-set by Vercel (Upstash) | Redis REST endpoint               |
| `UPSTASH_REDIS_REST_TOKEN` | Auto-set by Vercel (Upstash) | Redis auth token                  |
| `ANTHROPIC_API_KEY`        | console.anthropic.com        | Claude API key for chart analysis |
| `OPENAI_API_KEY`           | platform.openai.com          | Embeddings for lesson dedup       |
| `DATABASE_URL`             | Auto-set by Vercel (Neon)    | Postgres connection string        |
| `SENTRY_DSN`               | Auto-set by Vercel (Sentry)  | Sentry error tracking DSN         |
| `FRED_API_KEY`             | fred.stlouisfed.org          | Economic calendar data (optional) |
| `FINNHUB_API_KEY`          | finnhub.io                   | Mega-cap earnings data (optional) |
| `UW_API_KEY`               | unusualwhales.com            | Market flow, GEX, dark pool data  |
| `CRON_SECRET`              | Auto-set by Vercel           | Cron job auth (auto in prod)      |

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
```

---

## Project Structure

```text
├── api/                                  # Vercel Serverless Functions
│   ├── __tests__/                        # 116 test files — endpoints, cron jobs, _lib
│   ├── _lib/                             # 51 shared backend modules
│   │   ├── schwab.ts                     # Schwab OAuth token lifecycle (Redis + distributed lock)
│   │   ├── api-helpers.ts                # Shared fetch, cache, owner-gate, rate limiting, bot check
│   │   ├── db.ts                         # Neon Postgres: initDb() + migrateDb() (35+ migrations)
│   │   ├── db-migrations.ts              # Numbered migration definitions (40+ tables)
│   │   ├── db-analyses.ts                # Analysis CRUD
│   │   ├── db-flow.ts                    # Flow data queries + formatters
│   │   ├── db-snapshots.ts               # Snapshot persistence
│   │   ├── db-positions.ts               # Position CRUD
│   │   ├── db-darkpool.ts                # Dark pool snapshot storage
│   │   ├── db-oi-change.ts               # OI change tracking
│   │   ├── db-strike-helpers.ts          # Per-strike exposure queries
│   │   ├── db-nope.ts                    # SPY NOPE time series
│   │   ├── analyze-prompts.ts            # Static Anthropic prompt text
│   │   ├── analyze-context.ts            # Orchestrator — wires fetchers + assembles template
│   │   ├── analyze-context-fetchers.ts   # 13 focused per-data-source fetchers
│   │   ├── analyze-context-formatters.ts # Pure `format*` helpers (tests target these)
│   │   ├── analyze-context-helpers.ts    # numOrUndef, parseEntryTimeAsUtc + shared types
│   │   ├── analyze-calibration.ts        # Mode-specific example outputs
│   │   ├── build-features-flow.ts        # ML: flow checkpoint features
│   │   ├── build-features-gex.ts         # ML: GEX + Greek exposure features
│   │   ├── build-features-phase2.ts      # ML: prev day, realized vol, dark pool, options
│   │   ├── build-features-monitor.ts     # ML: IV monitor + flow ratio dynamics
│   │   ├── build-features-types.ts       # FeatureRow, featureNum() narrow helper
│   │   ├── plot-analysis-*.ts            # ML plot analysis (3 files)
│   │   ├── embeddings.ts                 # OpenAI text-embedding-3-large + vector search
│   │   ├── lessons.ts                    # Lessons CRUD + curation logic
│   │   ├── darkpool.ts                   # Unusual Whales dark pool fetcher (Sentry visibility)
│   │   ├── max-pain.ts                   # Max pain from all SPX expirations
│   │   ├── overnight-gap.ts              # ES overnight gap analysis
│   │   ├── spx-candles.ts                # 5-min SPX candles via SPY translation
│   │   ├── futures-context.ts            # Reads futures_snapshots w/ Zod row validation
│   │   ├── csv-parser.ts                 # thinkorswim CSV export parser
│   │   ├── validation.ts                 # Zod schemas (all API request bodies + position CSV)
│   │   ├── logger.ts                     # Structured JSON logger (pino)
│   │   ├── sentry.ts                     # Sentry server-side init + metrics wrappers
│   │   ├── env.ts                        # Centralized env access (requireEnv / optionalEnv)
│   │   └── constants.ts                  # Hard-coded values
│   ├── auth/
│   │   ├── init.ts                       # GET → redirect to Schwab login
│   │   └── callback.ts                   # GET → exchange code for tokens
│   ├── journal/
│   │   ├── init.ts                       # POST → create tables + run migrations
│   │   ├── migrate.ts                    # POST → add new columns (idempotent)
│   │   └── status.ts                     # GET → DB connection diagnostics
│   ├── cron/                             # 34 scheduled jobs (35 schedules in vercel.json)
│   │   ├── fetch-flow.ts                 # Market Tide (all-in + OTM)
│   │   ├── fetch-net-flow.ts             # SPX/SPY/QQQ net flow
│   │   ├── fetch-etf-tide.ts             # SPY/QQQ ETF fund flow
│   │   ├── fetch-zero-dte-flow.ts        # 0DTE-specific flow
│   │   ├── fetch-greek-flow.ts           # Delta flow per symbol
│   │   ├── fetch-greek-exposure.ts       # Agg + by-expiry Greek exposure
│   │   ├── fetch-spot-gex.ts             # Aggregate GEX snapshots
│   │   ├── fetch-strike-exposure.ts      # Per-strike Greeks (0DTE)
│   │   ├── fetch-strike-all.ts           # All-strike composite data
│   │   ├── fetch-gex-0dte.ts             # 0DTE-targeted GEX + target scoring
│   │   ├── fetch-outcomes.ts             # SPX settlement + VIX close
│   │   ├── fetch-oi-change.ts            # Open interest changes
│   │   ├── fetch-oi-per-strike.ts        # Per-strike OI
│   │   ├── fetch-vol-surface.ts          # IV term structure
│   │   ├── fetch-darkpool.ts             # $5M+ dark pool blocks
│   │   ├── fetch-economic-calendar.ts    # FRED + Finnhub events
│   │   ├── fetch-market-internals.ts     # $TICK / $ADD / $VOLD / $TRIN
│   │   ├── fetch-whale-alerts.ts         # UW whale positioning
│   │   ├── fetch-flow-alerts.ts          # Flow-ratio breach alerts
│   │   ├── compute-es-overnight.ts       # ES futures overnight summary
│   │   ├── build-features.ts             # ML feature engineering orchestrator
│   │   ├── curate-lessons.ts             # Weekly lessons curation pipeline
│   │   ├── monitor-iv.ts                 # IV monitoring (minute-level)
│   │   ├── monitor-flow-ratio.ts         # Flow ratio analytics (minute-level)
│   │   ├── backfill-futures-gaps.ts      # Fill Databento weekend/holiday gaps
│   │   └── backup-tables.ts              # Database backup to Vercel Blob
│   ├── ml/                               # ML data export + plot analysis endpoints
│   ├── options-flow/                     # Whale positioning + options flow endpoints
│   ├── market-internals/                 # Breadth indicators (TICK/ADD/VOLD/TRIN)
│   ├── analyze.ts                        # POST → Claude Opus 4.7 chart analysis
│   ├── analyses.ts                       # GET → browse past analyses (public)
│   ├── chain.ts                          # GET → live option chain
│   ├── events.ts                         # GET → economic calendar (public)
│   ├── history.ts                        # GET → historical candles
│   ├── intraday.ts                       # GET → today's OHLC + opening range
│   ├── journal.ts                        # GET → query saved analyses
│   ├── positions.ts                      # GET/POST → live/CSV positions (Zod-validated)
│   ├── quotes.ts                         # GET → real-time quotes
│   ├── snapshot.ts                       # POST → save market snapshot
│   ├── health.ts                         # GET → service health check
│   ├── alerts.ts                         # GET → active alerts
│   ├── alerts-ack.ts                     # POST → acknowledge alerts (Zod-validated)
│   ├── bwb-anchor.ts                     # GET → BWB gamma anchor
│   ├── darkpool-levels.ts                # GET → dark pool S/R levels
│   ├── gex-target-history.ts             # GET → GEX target scoring history
│   ├── iv-term-structure.ts              # GET → vol term structure
│   ├── movers.ts                         # GET → market movers
│   ├── pre-market.ts                     # GET/POST → pre-market data
│   ├── vix-ohlc.ts                       # GET → VIX OHLC from snapshots
│   └── yesterday.ts                      # GET → prior day SPX OHLC
├── src/                                  # React 19 SPA
│   ├── __tests__/                        # 161 unit test files (components, hooks, utils, data)
│   │   └── setup.ts                      # Vitest setup (jsdom, mocks)
│   ├── components/                       # 138 TSX component files, grouped by feature folder
│   │   ├── GexPerStrike/                 # 0DTE GEX panel (Phase 2.1 decomposition, 10 files)
│   │   │   ├── index.tsx                 # Thin orchestrator (<200 LOC)
│   │   │   ├── useGexViewState.ts        # State + derived memos
│   │   │   ├── Header.tsx                # Date picker + scrubber + visible-count stepper
│   │   │   ├── OverlayControls.tsx       # Charm/vanna/dex + OI/VOL/DIR + legend
│   │   │   ├── StrikesTable.tsx          # Price-ladder bar chart
│   │   │   ├── SummaryCards.tsx          # Bottom aggregate tiles
│   │   │   ├── Tooltip.tsx               # Row hover readout
│   │   │   ├── formatters.ts             # formatNum, formatFlowPressure, formatTime
│   │   │   ├── mode.ts                   # ViewMode accessors
│   │   │   └── colors.ts                 # Overlay accent constants
│   │   ├── FuturesCalculator/            # Day-trade P&L (Phase 2.2 decomposition, 16 files)
│   │   │   ├── index.tsx                 # Orchestrator (<250 LOC)
│   │   │   ├── useFuturesCalc.ts         # Trade inputs + derived P&L memos
│   │   │   ├── useAccountSettings.ts     # localStorage-backed balance + risk %
│   │   │   ├── ScenarioInputs.tsx        # Account + direction + entry/exit/contracts
│   │   │   ├── TradeResults.tsx          # Full P&L results block
│   │   │   ├── TickLadderTable.tsx       # Entry-only tick ladder
│   │   │   ├── ExcursionPanels.tsx       # MAE + MFE panels (shared template)
│   │   │   ├── PositionSizingPanel.tsx   # Risk-budget-based sizing
│   │   │   ├── CalcHeader.tsx            # Title + symbol chips + clear
│   │   │   ├── SpecBar.tsx               # Contract spec ribbon
│   │   │   ├── ui-primitives.tsx         # FieldLabel, PriceInput, ResultRow
│   │   │   ├── formatters.ts             # fmtPrice, fmtDollar, pnlColor
│   │   │   └── ...                       # FuturesGrid, FuturesPanel, VixTermStructure, futures-calc.ts
│   │   ├── GexTarget/                    # GEX target scoring panel (tile, strike box, sparklines)
│   │   ├── ChartAnalysis/                # Claude chart analysis UI (19 files)
│   │   ├── DeltaRegimeGuide/             # Delta ceiling with DOW + clustering
│   │   ├── HedgeSection/                 # Hedge calculator (reinsurance)
│   │   ├── IronCondorSection/            # Iron condor analysis
│   │   ├── IVInputSection/               # IV mode selection + term structure
│   │   ├── BWBSection/                   # Broken-wing butterfly analysis
│   │   ├── OpeningRangeCheck/            # First-30-min range signal
│   │   ├── PositionMonitor/              # Paper dashboard + statement parser
│   │   ├── PreTradeSignals/              # Pre-trade signal cards
│   │   ├── SettlementCheck/              # Backtest settlement verification
│   │   ├── VIXRangeAnalysis/             # Historical range + survival heatmap
│   │   ├── VIXTermStructure/             # VIX1D/VIX9D/VVIX panel
│   │   ├── VolatilityCluster/            # Volatility clustering signal
│   │   ├── MarketFlow/                   # Cross-ticker flow orchestrator
│   │   ├── MarketInternals/              # Breadth indicators panel
│   │   ├── MLInsights/                   # ML pipeline results (plot carousel)
│   │   ├── GexLandscape/                 # Full-session gamma landscape
│   │   ├── OptionsFlow/                  # Whale positioning + options flow
│   │   ├── PositionVisuals/              # P&L over time, waterfall, strike map
│   │   ├── RiskCalculator/               # Position-sizing + risk tiers
│   │   └── (standalone)                  # Pin Risk, Export, Error Boundary, etc.
│   ├── hooks/                            # 32 custom React hooks
│   │   ├── useAppState.ts                # Top-level UI state (focused memoization, no 26-dep trap)
│   │   ├── useCalculation.ts             # Main calculation engine
│   │   ├── useComputedSignals.ts         # All derived signals (single source of truth)
│   │   ├── useMarketData.ts              # Live Schwab data polling (fetchers split out)
│   │   ├── useChainData.ts               # Option chain polling (60s)
│   │   ├── useChartAnalysis.ts           # Chart analysis API hook
│   │   ├── useHistoryData.ts             # Historical candles for backtesting
│   │   ├── useSnapshotSave.ts            # Auto-save snapshots to Postgres
│   │   ├── useAlertPolling.ts            # Market alert polling (typed response guards)
│   │   ├── useDarkPoolLevels.ts          # Dark pool data polling
│   │   ├── useMLInsights.ts              # ML pipeline results
│   │   ├── useAnalysisContext.ts         # Context assembly for Claude
│   │   ├── useGexPerStrike.ts            # Per-strike GEX for GexPerStrike panel
│   │   ├── useGexTarget.ts               # GEX target scoring hook
│   │   ├── useOptionsFlow.ts             # Whale + flow polling
│   │   ├── useMarketInternals.ts         # Breadth indicator polling
│   │   ├── useNopeIntraday.ts            # SPY NOPE intraday polling
│   │   ├── useVixData.ts                 # VIX static + API (race-safe single effect)
│   │   └── ...                           # useAutoFill, useDebounced, useVIXTrajectory, etc.
│   ├── utils/                            # ~30 pure calculation modules
│   │   ├── black-scholes.ts              # BS pricing + Greeks (CDF, PDF, delta, gamma, vega, theta)
│   │   ├── iron-condor.ts                # IC builder + PoP
│   │   ├── hedge.ts                      # Hedge sizing + scenarios
│   │   ├── bwb.ts                        # Broken-wing butterfly
│   │   ├── strikes.ts                    # Strike placement + snapping
│   │   ├── pin-risk.ts                   # OI aggregation + pin risk detection
│   │   ├── settlement.ts                 # Settlement survival computation
│   │   ├── market-regime.ts              # TICK/ADD/VOLD/TRIN → range/trend/neutral
│   │   ├── extreme-detector.ts           # Breadth extremes detector
│   │   ├── candle-momentum.ts            # ROC + range expansion classifier
│   │   ├── zero-gamma.ts                 # Gamma flip level
│   │   ├── gex-target/                   # GEX target scoring (Phase 2.3 split, 7 files)
│   │   │   ├── index.ts                  # Public API barrel
│   │   │   ├── scorers.ts                # 6 component scorers + computeAttractingMomentum
│   │   │   ├── features.ts               # Feature extraction + compute helpers
│   │   │   ├── pipeline.ts               # pickUniverse, scoreStrike, scoreMode, computeGexTarget
│   │   │   ├── tiers.ts                  # assignTier, assignWallSide
│   │   │   ├── config.ts                 # GEX_TARGET_CONFIG
│   │   │   └── types.ts                  # All shared types
│   │   ├── formatting.ts                 # round0/1/2/4, roundToHalf, snapToSpyHalf
│   │   ├── exportXlsx.ts                 # Excel export (multi-sheet)
│   │   └── ...                           # calculator, classifiers, time, timezone, csvParser, etc.
│   ├── types/                            # Shared TypeScript types
│   ├── data/                             # Static data (event calendar, VIX range stats)
│   ├── constants/                        # App-wide constants
│   ├── themes/                           # Light/dark theme definitions
│   ├── App.tsx                           # Root component
│   └── main.tsx                          # React entry point + Sentry init
├── ml/                                   # Python ML pipeline
│   ├── src/                              # Python scripts (clustering, EDA, phase2, pin, viz, ...)
│   ├── tests/                            # 14 pytest files
│   ├── docs/                             # Phase specs + roadmap
│   ├── plots/                            # Generated plots (tracked in git, NOT gitignored)
│   ├── experiments/                      # JSON experiment results
│   ├── Makefile                          # Pipeline runner (make all, make eda, etc.)
│   ├── requirements.txt                  # Python dependencies
│   └── conftest.py                       # Adds ml/src/ to sys.path
├── sidecar/                              # Futures + ES options Python ingest (Railway)
│   ├── src/                              # Python — main, databento_client, db, symbol_manager, health, sentry_setup
│   ├── pyproject.toml                    # Python packaging
│   ├── requirements.txt                  # databento, psycopg2, sentry-sdk, ...
│   ├── railway.toml                      # Railway build + deploy config
│   └── Dockerfile                        # Container build for Railway
├── scripts/                              # Backfill + utility scripts (.mjs, shell)
├── e2e/                                  # 32 Playwright E2E specs
├── docs/                                 # Design documents + superpowers specs
├── public/
│   ├── vix-data.json                     # VIX OHLC history (1990–present, CBOE export)
│   └── vix1d-daily.json                  # VIX1D daily history (May 2022–present)
├── .github/workflows/
│   ├── ml-pipeline.yml                   # Nightly ML pipeline automation
│   └── neon_workflow.yml                 # Neon branching workflow
├── vercel.json                           # Crons, security headers, CSP, rewrites, ignoreCommand
├── vite.config.ts                        # Vite + Vitest + PWA + bundle analysis
├── .env.example                          # Environment variable template
└── .nvmrc                                # Node 24 version pin
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
                    ┌─── Unusual Whales ──────────────────────────┐
                    │  35 cron jobs → flow, GEX, dark pool, etc.  │
                    │  → flow_data, greek_exposure, spot_exposures │
                    │  → strike_exposures, training_features       │
                    └──────────────────┬───────────────────────────┘
                                       │
                                       ▼
SPY + VIX + Time ──→ useCalculation() ──→ results (strikes, premiums, ICs, BWBs)
                                            │
            useComputedSignals() ◄──────────┤ ← VIX, spot, T, skew, clusterMult
                    │                       │
                    ├──→ useSnapshotSave() ──→ POST /api/snapshot ──→ Neon Postgres
                    │                       │
                    ├──→ ChartAnalysis ──→ GET /api/positions ──→ Schwab Trader API
                    │        context      │
                    │                     └──→ POST /api/analyze ──→ Claude Opus 4.7
                    │                              │                      │
                    │                              ├─── lessons injection ←── lessons table
                    │                              ├─── flow/GEX/candles ←── market data tables
                    │                              └─── save analysis ───→ Neon Postgres
                    │
                    ├──→ Display components (DeltaRegimeGuide, OpeningRangeCheck, etc.)
                    │
                    └──→ MLInsights ──→ GET /api/ml/* ──→ Vercel Blob plots + findings

                    ┌─── Nightly Pipeline ─────────────────────────┐
                    │  build-features cron → training_features     │
                    │  GH Actions → ml/ scripts → plots → Blob    │
                    │  Claude vision → findings.json → frontend    │
                    └──────────────────────────────────────────────┘

                    ┌─── Railway Sidecar ─────────────────────────┐
                    │  Tradovate WebSocket → es_bars (1-min OHLCV) │
                    │  → /api/compute-es-overnight → gap analysis  │
                    └──────────────────────────────────────────────┘

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
- **Polling gates**: All data-fetching hooks gate refresh on `marketOpen` — no unconditional polling during closed hours.

---

## Security

### Headers (vercel.json)

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `X-XSS-Protection: 1; mode=block`
- `Content-Security-Policy`: `default-src 'self'`, strict `script-src` (with Sentry CDN), `frame-ancestors 'self'`, `connect-src` limited to self + Schwab + Vercel Analytics + Sentry ingest

### Authentication

- Owner cookie: HttpOnly, Secure, 7-day expiry, matched against `OWNER_SECRET` env var
- Hint cookie: Non-HttpOnly `sc-hint=1` for frontend page-load detection
- All API endpoints: `rejectIfNotOwner()` returns 401 for unauthenticated requests
- All API keys (Schwab, Anthropic, Postgres) are server-side only, never in client bundle
- Bot protection: `botid` checks on production endpoints, skipped in local dev

### Rate Limiting

All owner-gated endpoints are rate-limited via Upstash Redis:

| Endpoint         | Limit  | Purpose                               |
| ---------------- | ------ | ------------------------------------- |
| `/api/analyze`   | 3/min  | Prevent Opus cost abuse (~$0.30/call) |
| `/api/analyses`  | 30/min | Public browse endpoint                |
| `/api/positions` | 20/min | Auto-fetched before each analysis     |
| `/api/snapshot`  | 30/min | Generous for normal use               |
| `/api/journal`   | 20/min | Query endpoint                        |
| `/api/auth/init` | 5/min  | OAuth flow protection                 |

### Input Validation

- Image payload: Max 4 images, max 5MB per image (base64), validated by Zod schemas
- Anthropic errors: Sanitized to generic messages, full details logged server-side only
- DB errors: Sanitized, never expose connection details to client
- SQL injection: Neon tagged templates auto-parameterize all queries
- All request bodies: Validated via Zod schemas in `api/_lib/validation.ts` at system boundaries

---

## VIX Data Management

Three-tier strategy: localStorage cache (instant) → static JSON (first load) → manual CSV upload (override).

Built-in: 9,137 days of VIX OHLC (1990–2026) + 960 days of VIX1D daily OHLC (May 2022–March 2026).

VIX OHLC field selector: Choose resolution strategy for VIX from daily candles (smart, open, high, low, close).

---

## Excel Export

One-click XLSX with three sheets: P&L Comparison (7 wing widths × 6 deltas × 3 sides = 126 rows), IC Summary, and Inputs snapshot with methodology notes.

BWB export: Separate XLSX with BWB P&L profile across scenarios.

---

## Observability

### Structured Logging

All API routes use [pino](https://github.com/pinojs/pino) for structured JSON logging. Each log entry includes severity level, timestamp, and contextual fields (error objects, request metadata, usage metrics). Logs are searchable and filterable in Vercel function logs.

For local development with human-readable output, pipe through `pino-pretty`:

```bash
vercel dev 2>&1 | npx pino-pretty
```

### Error Tracking (Sentry)

Client-side errors are automatically captured via `@sentry/react` with browser tracing (20% sample rate, production only). The `ErrorBoundary` component forwards caught errors to Sentry with component stack traces. Server-side: `@sentry/node` with isolation scope helpers for per-request context.

### Performance Analytics

Core Web Vitals (LCP, FID, CLS, TTFB) are reported to the Vercel dashboard via `@vercel/speed-insights`, alongside page view analytics from `@vercel/analytics`.

### Bundle Analysis

Generate an interactive treemap of the production bundle:

```bash
npm run build:analyze    # Opens dist/bundle-stats.html
```

---

## Testing

**6,897 unit tests across 277 test files** + 32 Playwright E2E specs (Chromium, Firefox, and WebKit), all passing with TypeScript strict mode. ML pipeline has 14 additional pytest files. Overall coverage: 95.3% statements / 87.9% branches / 96.3% functions.

### Unit Tests (Vitest)

Tests are organized by source type:

```text
src/__tests__/     161 test files — components, hooks, utils, data
api/__tests__/     116 test files — API endpoints, cron jobs, _lib modules
```

| File                                | Focus                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `utils/calculator.test.ts`          | 150+ tests: BS pricing, Greeks (delta/gamma/theta/vega), strikes, kurtosis, stressed sigma |
| `components/ChartAnalysis.test.tsx` | 64 tests: image management, confirmation, cancel, analyze flow, modes, error handling      |
| `hooks/useComputedSignals.test.ts`  | 70 tests: regime, DOW, range, opening range, term shape, RV/IV, directional clustering     |
| `utils/skewAndIC.test.ts`           | 63 tests: convex skew, IC legs, per-side PoP, breakevens                                   |
| `utils/hedge.test.tsx`              | 32 tests: hedge sizing, scenarios, DTE pricing, breakevens, real-world scenario            |
| `utils/settlement.test.ts`          | 16 tests: survived/breached cases, cushion calculations, settledSafe                       |
| `utils/pin-risk.test.ts`            | 17 tests: OI aggregation, top-N sorting, side classification, formatting                   |
| `hooks/useChartAnalysis.test.ts`    | 13 tests: fetch, retry, abort, timeout, mode completion, elapsed timer                     |
| `hooks/useImageUpload.test.ts`      | 12 tests: add/remove/clear, drag-drop, paste, label management, 8-image limit              |
| `utils/analysis.test.ts`            | 10 tests: buildPreviousRecommendation with all field combinations                          |
| `utils/classifiers.test.ts`         | 14 tests: opening range classification, boundary values                                    |
| `utils/bwb.test.ts`                 | BWB P&L scenarios, wing width calculations, anchor integration                             |

### E2E Tests (Playwright — Chromium, Firefox, WebKit)

32 spec files covering user workflows, accessibility, and cross-browser compatibility:

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
| `chart-analysis-flow.spec.ts` | Full chart analysis flow with rendering                      |
| `risk-calculator.spec.ts`     | Risk tiers, buy/sell modes, position sizing                  |
| `pnl-profile.spec.ts`         | P&L diagram rendering                                        |
| `positions-upload.spec.ts`    | PaperMoney CSV upload and position parsing                   |
| `export-download.spec.ts`     | CSV and Excel export/download verification                   |
| `validation-errors.spec.ts`   | Input validation, error states, clearing                     |
| `extreme-inputs.spec.ts`      | Edge cases: extreme values, boundary inputs                  |
| `responsive.spec.ts`          | iPhone, iPad, desktop viewports                              |
| `theme-persistence.spec.ts`   | Dark mode persistence across page reloads                    |
| `error-recovery.spec.ts`      | Error handling and recovery                                  |
| `a11y-automated.spec.ts`      | Axe-core WCAG 2.1 AA scans (home, results, dark mode)        |
| `accessibility.spec.ts`       | Keyboard navigation, ARIA attributes, focus management       |
| `a11y-live-data.spec.ts`      | Live region testing for dynamic content                      |
| `cross-section.spec.ts`       | Cross-section interaction flows                              |
| `date-lookup.spec.ts`         | Date picker with event day integration                       |
| `delta-regime-guide.spec.ts`  | Delta guide ceiling and regime badges                        |
| `opening-range.spec.ts`       | Opening range check signals                                  |
| `parameter-summary.spec.ts`   | Parameter summary display                                    |
| `pre-market.spec.ts`          | Pre-market data analysis                                     |
| `pre-trade-signals.spec.ts`   | Signal validation                                            |
| `vix-range-analysis.spec.ts`  | VIX/range analysis with fine-grained bars                    |
| `event-day-warning.spec.ts`   | Event day alerts and severity coding                         |

### ML Tests (pytest)

```bash
cd ml && .venv/bin/pytest -v     # 14 test files covering all pipeline phases
```

| File                 | Coverage                                        |
| -------------------- | ----------------------------------------------- |
| `test_utils.py`      | Validation, formatting, DB helpers              |
| `test_clustering.py` | K-Means, GMM, dimensionality reduction          |
| `test_eda.py`        | Rule validation, correlation, confidence        |
| `test_phase2.py`     | Walk-forward validation, multi-model comparison |
| `test_backtest.py`   | P&L simulation, equity curves, drawdowns        |
| `test_pin.py`        | Gamma wall detection, pin accuracy metrics      |
| `test_health.py`     | Freshness checks, stationarity alerts           |
| `test_milestone.py`  | Milestone tracking, feature accumulation        |
| `test_visualize.py`  | Plot generation, output validation              |
| `test_explore.py`    | Data export, CSV formatting                     |

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

**Requirements**: Vercel Pro plan (required for 780-second function timeout on `/api/analyze`).

**Framework Preset**: Must be set to "Other" (not Vite) for API routes to work alongside SPA.

**Ignore command**: `git diff --quiet HEAD^ HEAD -- ':!sidecar' ':!ml' ':!scripts'` — skips builds when only sidecar, ML, or scripts change.

**Long-running functions**: `api/analyze.ts` (780s), `api/cron/curate-lessons.ts` (780s), `api/cron/build-features.ts` (300s).

### Railway (ES Sidecar)

```bash
cd sidecar
docker build -t es-relay .
# Deploy via Railway dashboard or CLI
```

Deployed separately with its own `package.json`, `Dockerfile`, and environment variables (`TRADOVATE_*`, `DATABASE_URL`, Redis). Not part of the Vercel build.

### Post-Deploy Setup

1. Add Neon Postgres: Vercel Marketplace → Connect Database → Neon
2. Add Upstash Redis: Vercel Marketplace → Connect Database → Upstash for Redis
3. Add Sentry: Vercel Integrations → Sentry (auto-sets `SENTRY_DSN`)
4. Set environment variables: `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET`, `OWNER_SECRET`, `ANTHROPIC_API_KEY`, `UW_API_KEY`
5. Initialize tables: `POST /api/journal/init`
6. Authenticate: Visit `/api/auth/init` → Schwab login
7. Run backfill scripts for historical data ingestion

---

## Accessibility

Section 508 / WCAG 2.1 AA: semantic HTML, ARIA attributes, focus management, 4.5:1 contrast, `prefers-reduced-motion`, labeled inputs, `role="alert"` for errors. Automated accessibility scanning via `@axe-core/playwright` runs against home, results, and dark mode views on every E2E test run. Skip-to-content link and full keyboard navigation support.

---

## Scripts Reference

| Command                 | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `npm run dev`           | Vite dev server with HMR                         |
| `npm run dev:full`      | Vercel dev (frontend + API functions)            |
| `npm run build`         | TypeScript check + production build              |
| `npm run build:analyze` | Production build + interactive bundle treemap    |
| `npm test`              | Vitest watch mode                                |
| `npm run test:run`      | Single test run (CI)                             |
| `npm run test:coverage` | v8 coverage report                               |
| `npm run lint`          | TypeScript + ESLint check                        |
| `npm run review`        | tsc + ESLint + Prettier + Vitest coverage (full) |
| `npm run test:e2e`      | Playwright E2E tests (Chromium, Firefox, WebKit) |
| `npm run test:e2e:ui`   | Playwright interactive UI mode                   |
| `npm run format`        | Prettier format all files                        |
| `npm run format:check`  | Prettier check (CI)                              |

**ML Pipeline:**

| Command                 | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `make -C ml all`        | Full ML pipeline (health → EDA → cluster → viz) |
| `make -C ml eda`        | Exploratory data analysis only                  |
| `make -C ml early`      | Phase 2 early feasibility experiment            |
| `make -C ml early-shap` | Phase 2 with SHAP importance plots              |
| `make -C ml pin`        | Settlement pin risk / gamma correlation         |
| `make -C ml backtest`   | Simplified P&L backtest                         |
| `make -C ml health`     | Pipeline health check (freshness, stationarity) |
| `make -C ml milestone`  | Data milestones + script recommendations        |
| `make -C ml test`       | Run ML pytest suite                             |
| `make -C ml test-cov`   | ML tests with coverage report                   |

**Backfill Scripts (18):**

| Script                                 | Description                           |
| -------------------------------------- | ------------------------------------- |
| `scripts/backfill-darkpool.mjs`        | Dark pool levels history              |
| `scripts/backfill-etf-tide.mjs`        | ETF Tide flow history                 |
| `scripts/backfill-flow-ratio.mjs`      | Flow ratio snapshots                  |
| `scripts/backfill-greek-exposure.mjs`  | Greek exposure by expiry              |
| `scripts/backfill-greek-flow.mjs`      | Delta flow history                    |
| `scripts/backfill-iv-monitor.mjs`      | IV snapshots (1-min)                  |
| `scripts/backfill-local.mjs`           | Local ES bars                         |
| `scripts/backfill-netflow.mjs`         | Net flow aggregates                   |
| `scripts/backfill-oi-change.mjs`       | OI change metrics                     |
| `scripts/backfill-oi-per-strike.mjs`   | Per-strike OI                         |
| `scripts/backfill-spot-gex.mjs`        | Spot GEX panel                        |
| `scripts/backfill-strike-all.mjs`      | Strike Greeks (all expiry)            |
| `scripts/backfill-strike-exposure.mjs` | Strike Greeks (0DTE)                  |
| `scripts/backfill-vol-surface.mjs`     | IV term structure                     |
| `scripts/backfill-zero-dte-flow.mjs`   | 0DTE flow isolation                   |
| `scripts/convert-vix-csv.mjs`          | VIX CSV conversion                    |
| `scripts/entry-time-analysis.ts`       | 8:45 vs 9:00 AM CT entry timing study |
| `scripts/verify-darkpool.mjs`          | Dark pool data validation             |

---

## Trading Workflow

### Daily Flow

```text
8:30 AM ET   Check term structure (VIX1D/VIX9D auto-filled)
             Check event day warning (Rule 12 — FOMC? CPI? NFP?)
             Check volatility clustering signal
             Check pre-trade signals (RV/IV, overnight gap, GEX regime)

9:00 AM CT   FIRST ENTRY (wait for 30-min opening range)
             Check Delta Guide ceiling + DOW + clustering badges
             Check dark pool levels for support/resistance
             Upload 6-7 charts: Market Tide, SPX Flow, SPY Flow, QQQ Flow,
               Periscope (Delta Flow + Gamma), Net Charm (SPX)
             Run Pre-Trade analysis → get structure, delta, entry plan
             Execute Entry 1 per the plan
             Set $0.50 debit limit close order

10:00 AM ET  OPENING RANGE CHECK
             GREEN → proceed with Entry 2
             RED → skip or reduce size

10:00 AM CT  SECOND ENTRY (if conditions met)
             Swap Periscope gamma screenshot + fresh Net Charm
             Run Mid-Day analysis → check if Entry 2 conditions met
             Execute if recommended

11:00 AM CT  OPTIONAL THIRD ENTRY
             Same flow as Entry 2

1:45 PM ET   EVENT DAY EXIT (if FOMC/Fed speech at 2:00 PM)
             Close ALL positions — Rule 12 hard exit

2:00 PM ET   MANAGEMENT (non-event days)
             Follow management rules from analysis
             Take 50% profit if available

4:15 PM ET   REVIEW
             Upload full-day charts
             Run Review analysis → lessons learned
             (Weekly cron auto-curates lessons into compendium)

9:45 PM ET   NIGHTLY PIPELINE
             build-features cron assembles 100+ features
             GitHub Actions runs full ML pipeline
             Plots uploaded to Blob, Claude analyzes them
             Results visible in ML Insights next morning
```

### Structure Selection (from Chart Analysis)

| Market Tide Signal        | Structure          | Why                             |
| ------------------------- | ------------------ | ------------------------------- |
| NCP ≈ NPP (parallel)      | Iron Condor        | Ranging day, collect both sides |
| NCP >> NPP (diverging up) | Put Credit Spread  | Bullish, no call exposure       |
| NPP >> NCP (diverging up) | Call Credit Spread | Bearish, no put exposure        |
| Both declining sharply    | Sit out            | High uncertainty                |

### Structure Selection Rules (Empirical)

These rules are derived from backtesting and live trading. They are coded into the Claude system prompt and override default flow-based structure selection when applicable. Each rule traces to specific sessions where the rule would have prevented a loss or captured a missed opportunity.

#### Chart Input Lineup (up to 4 images per the Zod schema — pick the most relevant for the session)

| Slot | Chart                          | Question It Answers                                |
| ---- | ------------------------------ | -------------------------------------------------- |
| 1    | Market Tide                    | Broad market sentiment (25% weight)                |
| 2    | SPX Net Flow                   | Flow in the trader's exact instrument (50% weight) |
| 3    | SPY Net Flow                   | Confirmation/contradiction (15% weight)            |
| 4    | QQQ Net Flow                   | Tech sector divergence (10% weight)                |
| 5    | Periscope (Delta Flow + Gamma) | Gamma walls, acceleration zones, straddle cone     |
| 6    | Net Charm (SPX)                | Which gamma walls hold vs decay into the afternoon |
| 7    | _(optional)_                   | Second Periscope timeframe for midday comparison   |

#### Rule 1: Gamma Asymmetry Overrides Neutral Flow

When flow is neutral but Periscope shows massive negative gamma within 30–40 pts on ONE side and clean air on the other, do not recommend IC — the short strike near the negative gamma cliff has asymmetric acceleration risk. Recommend a directional credit spread AWAY from the danger zone.

#### Rule 2: QQQ Divergence Weighting

When SPX + Market Tide + SPY agree but QQQ diverges: weight the agreeing signals at 90%, QQQ at 10%. If QQQ price is also moving with SPX/SPY despite bullish QQQ flow, the flow is hedging — discount further. QQQ divergence reduces confidence (HIGH → MODERATE), not structure.

#### Rule 3: Friday Afternoon Hard Exit

Close ALL IC positions by 2:00 PM ET on Fridays if VIX > 19. Friday afternoon gamma acceleration + weekend hedging creates outsized risk not compensated by remaining theta.

#### Rule 4: VIX1D > VIX on Friday = Bearish Lean

Inverted intraday term structure on Fridays typically resolves bearishly from weekend hedging demand. Bias toward CCS, away from IC.

#### Rule 5: Direction-Aware Stop Conditions

Stops must account for the structure: a downside cone break CONFIRMS a CCS thesis (don't close), while an upside approach threatens it (close). Always frame stops relative to the short strike side.

#### Rule 6: Dominant Positive Gamma Confirms IC

A single positive gamma concentration 10x+ larger than surrounding negative gamma is a strong IC signal. Price mean-reverts to the wall repeatedly. Consider widening delta 1–2Δ beyond the ceiling. Place stops at the straddle cone boundary, not at intermediate negative gamma.

#### Rule 7: Stop Placement Must Avoid Negative Gamma Zones

Never place stops AT negative gamma bars — MM delta hedging creates brief spikes that trigger stops before the dominant structure reasserts. Place stops at straddle cone boundaries, positive gamma walls, or flow-based thresholds.

#### Rule 8: SPX Net Flow Is the Primary Flow Signal

Weighting hierarchy: SPX Net Flow (50%) → Market Tide (25%) → SPY (15%) → QQQ (10%). When SPX and Market Tide agree: HIGH confidence. When they contradict: use SPX for structure, reduce confidence one level.

#### Rule 9: Minimum Premium Threshold (8Δ Floor)

The trader's minimum tradeable delta is 8Δ. When the structurally correct structure can't achieve 8Δ+ (e.g., gamma favors CCS but premium above the wall is 3–5Δ), evaluate the opposite structure or SIT OUT. Don't recommend untradeable structures just because gamma favors them.

#### Rule 10: SPX Net Flow Hedging Divergence

When SPX NCP diverges from price direction AND 3+ other signals confirm the opposite direction, treat SPX flow as CONFLICTED/LOW regardless of magnitude — the flow is institutional hedging. Reduce SPX weight from 50% to 25%, redistribute to Market Tide (37.5%) and SPY (22.5%). Validated across multiple sessions where positive SPX NCP persisted during 25–50 pt sell-offs.

#### Rule 11: Net Charm Confirms Directional Spread

When charm shows massive positive values below price (downside walls strengthening) and negative values above (upside walls decaying), this confirms CCS. Mirror pattern confirms PCS. Aligned charm upgrades confidence one level. Positive charm wall = reliable all day. Neutral charm = checkpoint after 1:00 PM ET. Negative charm = morning-only ally.

#### Rule 12: High-Impact Event Day Management

**Afternoon events (FOMC, Fed speeches):** HARD EXIT all positions 15 minutes before the announcement. No exceptions. Overrides all other time-based rules. No re-entry if press conference follows.

**Pre-market events (CPI, NFP, PCE at 8:30 AM ET):** By the 9:00 AM CT entry, the reaction is absorbed. Often favorable for premium selling as VIX deflates. Widen delta 1–2Δ.

**Mid-morning events (ISM, JOLTS at 10:00 AM ET):** Set tight stop before release if already in position. Wait 15 minutes after release if not yet in. No Entry 2 within 30 minutes of release.

---

## Position Sizing Guide

Conservative: 5% of account per day (survives 10+ max losses). Moderate: 10%. Aggressive: 15%.

Multiple positions on the same underlying and expiration are NOT diversified — always sum total buying power.

---

## Accuracy & Limitations

1. **VIX vs actual 0DTE IV**: VIX1D auto-apply mitigates this; chain verification shows actual per-strike deltas
2. **IV acceleration is empirical**: The intraday σ multiplier (0.6 coefficient) is calibrated from observed behavior, not derived from a formal model. Actual gamma acceleration varies by VIX regime and market structure. The multiplier is capped at 1.8× to prevent extreme values near close.
3. **Fat-tail kurtosis is stepped, not continuous**: The VIX-dependent kurtosis factor (`getKurtosisFactor(vix)`) uses discrete VIX bands (1.5× at VIX < 15 → 3.5× at VIX > 30). Real kurtosis varies continuously and by time of day. A smoothly interpolated kurtosis curve would be more accurate.
4. **Convex skew exponent is static**: The 1.35 put convexity is empirically reasonable for typical VIX 15-25 days. On extreme fear days (VIX 35+), real put skew can be significantly steeper. The chain endpoint shows actual per-strike IV for comparison.
5. **Theoretical vs market premiums**: Black-Scholes assumes continuous hedging; real prices include bid/ask spreads
6. **Parkinson RV estimator**: Uses a 5-day rolling window of daily high-low ranges. Smoother than single-day, but still sensitive to outlier days. A longer window (10-20 days) or GARCH-based estimator could improve stability.
7. **Chart analysis limitations**: Claude reads charts visually — it estimates NCP/NPP values from line positions, not exact data. Image quality affects accuracy.
8. **Backtest limitations**: Periscope gamma profiles are point-in-time screenshots; historical gamma data is not available programmatically
9. **Database coverage**: VIX1D data available from May 2022 only; earlier outcomes have VIX close but not VIX1D close
10. **Pin risk requires live chain**: OI heatmap only available during market hours with authenticated Schwab session. Historical OI data is not persisted.
11. **ML pipeline maturity**: Phase 2 (structure classification) is in early feasibility with ~35 labeled days — no model yet beats the majority-class baseline. Full training expected at 60+ labeled days.
12. **ES sidecar data**: Tradovate market data access is subject to API mode restrictions. Overnight data may have gaps during maintenance windows.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE.md). See the [LICENSE.md](LICENSE.md) file for details.
