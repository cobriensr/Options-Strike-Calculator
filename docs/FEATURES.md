# Features

Full feature surface of the strike calculator. For setup, see [LOCAL_DEV.md](LOCAL_DEV.md); for architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

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
- Automatic data collection to Neon Postgres (50+ tables, 77+ migrations, 38 cron jobs) feeding a multi-phase ML pipeline
- Analog range forecast: strike-placement hints from 15 text-embedding-nearest historical mornings, VIX-regime-stratified for elevated/crisis days
- Microstructure signals: validated NQ 1h OFI (ρ=0.313, p<0.001) + historical percentile rank against a 1-year TBBO archive
- Futures-side structural levels from ES options EOD open interest, compared against SPX gamma walls
- ML Insights section with nightly pipeline plots analyzed by Claude vision
- Railway Python sidecar: Databento Live (6 futures + ES options) + Theta Data Terminal (nightly SPX EOD chains) + DuckDB query layer over a 3.9 GB TBBO Parquet archive

---

## Calculator features

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

- All uploaded chart images (up to 4, validated at the Zod boundary) with labels (Market Tide, Net Flow SPY, Net Flow QQQ, Net Flow SPX, Periscope Delta Flow, Periscope Gamma, Net Charm SPX, and SpotGamma Delta Pressure + Charm Pressure heatmaps)
- Full calculator context: SPX, VIX, VIX1D, VIX9D, VVIX, σ, T, hours remaining, delta ceiling, spread ceilings, regime zone, cluster multiplier (symmetric + directional put/call), DOW label, opening range signal, term structure signal + curve shape, RV/IV ratio, IV acceleration multiplier, overnight gap
- Live Schwab positions: Current SPX 0DTE spreads with strikes, credits, P&L, cushion distances, and net greeks — auto-fetched before each analysis so Claude knows what's already open
- Database-driven market context: Flow data (last 24h), GEX snapshots, SPX candles, dark pool clusters, max pain, economic events — all assembled by `buildAnalysisContext()`
- **Futures context**: 6 futures symbols (ES, NQ, ZN, RTY, CL, GC) with ES-SPX basis, NQ-ES divergence, VIX futures term structure, ZN flight-to-safety, and ES options top-Put/top-Call OI strikes as futures-side structural levels (treated as SPX gamma walls projected from the futures option chain)
- **Microstructure signals** (Phase 5a): ES and NQ Order Flow Imbalance (OFI) at 1h window with historical 1-year percentile rank — the NQ 1h OFI is a Bonferroni-significant predictor of next-day NQ return (ρ=0.313, p<0.001, n=312)
- **UW deltas** (Phase 5b): dark pool velocity, GEX delta, whale net, ETF divergence — delta-based reads that outperform absolute levels for directional signal
- **Analog range forecast**: cohort-conditional strike-placement hints from the 15 text-embedding-nearest historical mornings, plus a VIX-regime-stratified cohort (same-VIX-bucket mornings only) that adaptively widens on elevated/crisis-VIX days
- **Similar days context**: top-k analog sessions from `day_embeddings` (Phase B text-embedding backend) or `day_features` (Phase C engineered-feature backend), switchable via `DAY_ANALOG_BACKEND` env
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

## VIX Data Management

Three-tier strategy: localStorage cache (instant) → static JSON (first load) → manual CSV upload (override).

Built-in: 9,137 days of VIX OHLC (1990–2026) + 960 days of VIX1D daily OHLC (May 2022–March 2026).

VIX OHLC field selector: Choose resolution strategy for VIX from daily candles (smart, open, high, low, close).

---

## Excel Export

One-click XLSX with three sheets: P&L Comparison (7 wing widths × 6 deltas × 3 sides = 126 rows), IC Summary, and Inputs snapshot with methodology notes.

BWB export: Separate XLSX with BWB P&L profile across scenarios.

---

## Accessibility

Section 508 / WCAG 2.1 AA: semantic HTML, ARIA attributes, focus management, 4.5:1 contrast, `prefers-reduced-motion`, labeled inputs, `role="alert"` for errors. Automated accessibility scanning via `@axe-core/playwright` runs against home, results, and dark mode views on every E2E test run. Skip-to-content link and full keyboard navigation support.

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
