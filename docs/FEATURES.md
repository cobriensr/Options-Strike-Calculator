# Features

Full feature surface of the strike calculator. For setup, see [LOCAL_DEV.md](LOCAL_DEV.md); for architecture, see [ARCHITECTURE.md](ARCHITECTURE.md); for the trading day it supports, see [TRADING_WORKFLOW.md](TRADING_WORKFLOW.md).

## Overview

This tool solves a specific problem for 0DTE options traders: given a spot price, time of day, and implied volatility, where should your delta-targeted strikes be, what are the theoretical premiums, what does your iron condor P&L look like, and what delta ceiling should you respect based on today's VIX regime, term structure, volatility clustering, and day-of-week effects?

All core option math runs client-side with no external dependencies. Public visitors get the full calculator and the Market Regime analysis with manual inputs. Owner and guest sessions add live data from Schwab (quotes, option chains, intraday candles), Unusual Whales (flow, per-trade option prints, dark pool, GEX, futures trades) and GEXBot (dealer gamma, charm and vanna state). Behind them, Neon Postgres stores the collected data and ML features, Anthropic powers chart analysis and lesson curation, and OpenAI supplies embeddings. Per the Unusual Whales data policy, no Unusual Whales or GEXBot data, raw or derived, is served to public visitors.

You input (or auto-receive) the current SPY price, the VIX (plus optionally VIX1D and VIX9D), and the time — and it gives you:

- A complete strike table across 6 delta targets (5Δ through 20Δ) with theoretical put and call premiums
- A full iron condor breakdown split into put spread, call spread, and combined IC — with credit, max loss, buying power, return on risk, fat-tail adjusted probability of profit, and breakevens in both SPX and SPY terms
- Broken-wing butterflies for every delta row, plus a Settlement Pin Calculator (BWB and Iron Fly) with a gamma-anchored sweet spot
- A risk calculator with position sizing, risk tiers, stops, and buy/sell mode analysis
- A hedge calculator with DTE selection (1-21 days), extrinsic value modeling at EOD close, net cost breakdown, and crash/rally scenario tables
- A Delta Guide with a ceiling recommendation based on 9,102 days of historical VIX-to-SPX range data, adjusted for day-of-week effects and directional volatility clustering
- Market Regime analysis: VIX term structure and curve shape, realized vs implied volatility, opening range, volatility clustering, event-day warnings, pre-trade signal cards (realized vs implied vol, overnight gap, move breadth) and settlement pin risk from the live Schwab chain
- Owner and guest dashboards for dealer gamma (GEX Target, GEX Landscape, Zero Gamma, GEXBot, Periscope MM Exposure and more), flow (dark pool, Greek flow, directional vega spikes, Interval B/A alerts), rule-based setup detectors, and futures
- An Options Alerts view with two unusual-options feeds (Lottery Finder and Silent Boom), each alert carrying a calibrated Take-It probability
- AI-powered chart analysis (Claude Opus 4.7) that reads Periscope Gamma and Charm screenshots alongside structured flow, GEX, futures and positions data to recommend structure, delta, strike placement, entry plan, management rules, and hedge
- A self-improving lessons system where end-of-day reviews produce lessons that are vector-deduplicated and injected into future analyses
- Historical backtesting with candle-by-candle replay and settlement verification
- Live Schwab position tracking, a paper-trading position monitor and a contract tracker
- An ML research carousel of pipeline plots with Claude-written explanations
- Automatic data collection to Neon Postgres from Vercel crons and three Railway Python services (see [Data platform](#data-platform))

---

## Access levels

- **Public** visitors get the full calculator and Market Regime analysis with manual inputs.
- **Guests** enter an access key issued by the owner (a 30-day session) and get read-only access to the live-data dashboards, the Options Alerts view and the ML research carousel. A guest's own panel layout is the one thing a guest can save.
- **The owner** signs in with Schwab and alone can run the AI chart analysis, load Schwab positions and the position monitor, save pre-market inputs and tracker contracts, edit lessons, export CSVs and subscribe to Web Push.

Unusual Whales and GEXBot data, and anything computed from it, is never served to public visitors.

---

## Calculator

The Inputs group (Date & Time, Spot Price, Implied Volatility, Advanced, Risk Calculator) and the Results section. Public.

### Strike Calculation

- All 6 delta targets simultaneously: 5Δ, 8Δ, 10Δ, 12Δ, 15Δ, 20Δ
- SPX and SPY strikes: Both calculated and displayed, with SPX snapped to nearest 5-pt and SPY snapped to nearest $0.50
- Convex put skew: Power-curve model where further OTM puts get disproportionately more IV (convexity = 1.35), matching real SPX volatility smile behavior. Call skew is dampened at high z-scores to reflect how call skew flattens or inverts on rally days.
- Intraday IV acceleration: σ multiplier increases as the session progresses (1.0× at the open, ~1.21× at 2:00 PM ET, ~1.51× at 3:00 PM ET, capped at 1.8× in the last half hour), reflecting gamma acceleration. Strikes use base σ for placement stability; premiums and Greeks use accelerated σ for realistic pricing.
- Independent call skew override: Optional `callSkewOverride` parameter allows separate put/call skew modeling when call-side IV behavior diverges from put skew (e.g., rally days)
- Greeks per strike: actual Black-Scholes delta and gamma at the snapped strike, shown for each delta row
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
- VIX term structure readout and curve shape (see [Market Regime](#market-regime))

### Advanced

Skew, the iron condor and BWB toggles, wing width, contracts, BWB wing widths, the VIX OHLC field selector and the theta decay chart.

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
- Fat-tail kurtosis adjustment: Breach probabilities are inflated by a VIX-regime factor from `getKurtosisFactor(vix)`. The factor is asymmetric: the put (crash) tail gets 1.8× at VIX < 15 rising to 4.0× at VIX 30+, and the call (rally) tail gets 1.2× rising to 3.0×. Adjusted PoP is shown as the primary value; log-normal PoP is displayed struck-through underneath for reference. At 10Δ with VIX 15–20, this reduces IC PoP from ~82% to ~65% — matching empirical breach rates from 9,102 days of data.
- Base sigma for PoP: Settlement probability uses base σ (no IV acceleration) for placement stability — the accelerated σ is only used for premiums and Greeks.

### Broken-Wing Butterfly (Results section)

Toggle **BWB** in Advanced to add theoretical put and call broken-wing butterflies for every delta row: narrow wing 10–30 SPX points, wide wing 1.5–3× the narrow (snapped to the strike grid). Shows the legs, a P&L profile across settlement prices with fat-tail-adjusted probability of profit (log-normal struck through), and a one-click XLSX export.

### Risk Calculator & Position Sizing

- **Mode selection**: Sell (credit spreads, ICs) or Buy (debit spreads, directional)
- **Trade inputs**: Account balance, credit/premium, wing width, contracts, optional delta/PoP targets
- **Risk metrics**: Gross/net loss per contract, total loss % of account, buying power required, max positions allowed, risk-to-reward ratio, and expected value per contract when a PoP is entered
- **Stops**: sell-side stop at 2–5× credit or buy-side stop at 25/50/75% of premium, reflected in max loss
- **Credit check** (sell mode): target credit of 10–15% of wing width with an Excellent/OK/pass verdict; flags a short delta below 0.08
- **Portfolio cap**: 25–100% cap that sets the max-positions count
- **Risk tier table**: 1%, 2%, 3%, 5%, 10% of account, each with budget, max contracts, max loss and actual %; clicking a row sets the contract count

### Hedge Calculator (Reinsurance)

- Hedge delta: 1Δ, 2Δ, 3Δ or 5Δ (default 2Δ)
- DTE selector: 1d, 7d, 14d, or 21d hedge options (default 7d). Longer-dated hedges lose minimal theta during a single session.
- Extrinsic value modeling: Hedge scenario table values hedges at (DTE − 1 day) remaining using Black-Scholes, not intrinsic-only. A 7DTE hedge sold to close at EOD recovers 70-90% of purchase price if OTM.
- Net daily cost: Entry premium minus estimated EOD recovery, shown with gross → recovery → net breakdown.
- Sizing: Uses net payout (BS value at target minus entry premium) per contract for correct contract recommendations.
- IV expansion under stress: Hedge scenarios model IV expansion via `stressedSigma()` — crashes inflate σ by up to 4× sensitivity, rallies by 1.5×, capped at 3× base σ.

### Theta Decay Curve

`calcThetaCurve()` returns remaining-premium % and theta per hour at each point of the session. The Advanced section plots it as an SVG decay curve from open to close, with the peak θ/hour called out.

---

## Market Regime

Analysis built on 9,102 matched VIX/SPX trading days (1990–2026). Public with manual inputs; the pieces that need live data (opening range, pin risk, move breadth, the flow regime badge) fill in for owner and guest sessions.

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
- VVIX classification: STABLE, NORMAL, UNSTABLE, DANGER
- Combined worst-of signal
- **Curve shape classification**: Identifies 6 distinct term structure shapes with actionable advice:
  - **Contango** (VIX1D < VIX < VIX9D): Premium selling sweet spot — near-term calm
  - **Fear spike** (VIX1D > VIX > VIX9D): Event-driven near-term fear — IC dangerous, mean-reversion opportunity
  - **Backwardation** (VIX1D > VIX): Short-term stress — reduce size or widen
  - **Hump** (VIX1D < VIX > VIX9D): Event-driven mid-term spike (FOMC/CPI) — expect IV crush post-event
  - **Front calm** (VIX1D < VIX, VIX9D < VIX): Transitional environment
  - **Flat** (all within ±5%): No edge from term structure

### Realized vs Implied Volatility

- 5-day rolling Parkinson RV: `rollingParkinsonRV()` averages Parkinson variance across the last 5 completed trading days then takes sqrt — more stable than single-day estimate. Formula per day: `σ² = (1/(4·ln2)) × ln(H/L)²`; annualized via `× 252`
- RV/IV ratio: Compares rolling RV against today's IV (VIX1D preferred, VIX × 1.15 fallback)
- Classification: < 0.8 = IV Rich (favorable for selling), 0.8–1.2 = Fair Value, > 1.2 = IV Cheap (unfavorable)

### Opening Range Check

First 30 minutes of SPX trading vs expected daily range: GREEN (<40% consumed), MODERATE (40–65%), RED (>65%).

### Volatility Clustering

Yesterday's range percentile → today's range multiplier. Up to 1.87× at high VIX after a P90 day.

- **Directional asymmetry**: when clustering is active, the excess over 1.0 is split by yesterday's direction. After a down day (> 0.3% decline) the put side gets 1.3× the excess and the call side 1.1× (both widen; V-reversals are common). After an up day the call side gets 1.3× and the put side 0.6×. Flat days and calm-day tailwinds (multiplier < 1) stay symmetric. Separate put/call multipliers are displayed and passed to Claude.

### Event Day Warning

Severity-coded event banner from `/api/events`: CPI, NFP, GDP, PCE, PPI, Retail Sales and JOLTS release dates from the FRED API; FOMC and early-close dates from a static calendar (2025–2026); mega-cap earnings (AAPL, MSFT, NVDA, AMZN, GOOG, META, TSLA) from Finnhub.

### Pre-Trade Signals

Three compact cards: **Realized vs. Implied Vol** (yesterday's actual range ÷ the VIX-implied range), **Overnight Gap** (SPX open vs prior close) and **Move Breadth** (whether the move is broad or concentrated in a few mega-caps, from Schwab's top SPX movers; owner and guest). The ES overnight gap and GEX/charm readings feed the AI analysis instead (see [Pre-Market Futures Inputs](#pre-market-futures-inputs) and the GEX panels).

### Flow Regime Badge

A live pill (owner and guest) that flags when today's options flow is abnormal for the time of day, from 30-minute slots refreshed every 5 minutes. It is recognition only, not a forecast: the spec records that a 106-day point-in-time backtest found no forward edge in options flow (`docs/superpowers/specs/flow-regime-badge-2026-06-06.md`). Refreshes every 60 s while the market is open.

### Settlement Pin Risk

From the live Schwab 0DTE chain (owner and guest):

- OI table: the top 8 strikes by combined put+call open interest, plus any high-OI strike within 0.5% of spot, with put OI, call OI, total and distance, colored by put/call dominance
- Pin risk warning: Flags high-OI strikes within 0.5% of spot — MMs delta-hedging can pin price at settlement
- Max pain and the top-3 put/call OI walls are computed by `/api/chain` and used in the AI analysis context

### Live Option Chain (Schwab)

| Feature  | Detail                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Endpoint | `GET /api/chain`                                                                                        |
| Symbol   | `$SPX`, range=ALL, strikeCount=80                                                                       |
| Returns  | Nearest chain strike to each target delta with actual put/call delta, IV, credit, theta, vega           |
| Stale    | Excludes quotes with bid <= 0 or spread > 50% of mid price                                              |
| Max pain | `calcMaxPain()` -- strike minimizing total OI-weighted payout, with distance from spot                  |
| Pin risk | Top 3 put/call OI walls                                                                                 |
| Used by  | Settlement Pin Risk table; Chain Delta Rungs in the AI analysis (rungs 5–25Δ, preferred 12Δ, floor 10Δ) |
| Cache    | 30 seconds during market hours, 300 seconds after                                                       |
| Access   | Owner or guest                                                                                          |

This addresses the single-σ model limitation: VIX1D is aggregate IV across the entire strip, but on high-skew days OTM put IV ≠ VIX1D, so the AI analysis is given actual per-strike deltas from the Schwab chain.

---

## Market Context dashboards

Owner and guest. All of these read Unusual Whales or GEXBot data, poll only while the market is open, and most can replay a past date or moment. The Pre-Market Signals and Pre-Market Futures Inputs panels sit in the Inputs group of the nav.

### Pre-market

#### Pre-Market Signals

Two opening-session tools. The **Opening Flow Signal** applies a rule to large ($1M+) SPY and QQQ 0DTE option tickets streamed from Unusual Whales in the 08:30–08:40 CT window (two five-minute slices) and reports whether a directional signal fires, plus the contract it points to. It polls every 30 s from 08:25 to 08:50 CT, and past days replay from a stored daily record. The **0DTE Pin Setup** tile grades the SPX session ARMED, WATCH or NOT_TRIGGERED from three conditions: a dominant 0DTE gamma strike above a size threshold, on a 50-point multiple, within 15 points of spot. It refreshes every 60 s.

#### Pre-Market Futures Inputs

Owner only. Records the ES overnight Globex high, low, close and optional VWAP, with a live gap preview against the prior SPX close. A cron pre-fills the values at the open from streamed ES one-minute bars (auto-filled fields are highlighted). The owner can correct and save them, and the saved levels feed the overnight-gap context in the AI analysis.

### Dealer gamma and exposure

#### 0DTE Gamma Regime

Grades the SPX session from net 0DTE dealer gamma within ±1% of spot at the open: _Calm / mean-revert_ (positive), _Big move likely_ (mildly negative) or _Lean down_ (deeply negative), with _No read_ when data is missing. It also lights three intraday downside triggers: mostly-red 30-minute candles, ATM put IV breaking 2% above its 08:30–10:00 CT reference between 10:00 and 12:30 CT, and a deeply negative midday gamma re-read. A nightly job scores each day's verdict against what happened. Data: Unusual Whales 0DTE per-strike gamma, Schwab per-strike IV and one-minute index candles. Refreshes every 45 s from 08:30 to 15:00 CT.

#### GEX Target

Ranks SPX 0DTE strikes by how gamma exposure is building or decaying around them, to pick the session's likely price magnet. Open-interest, volume and directional views each score strikes, tag them as call or put walls, and assign a HIGH/MEDIUM/LOW/NONE conviction tier. A price chart and per-strike sparklines show the board changing, and the day can be scrubbed snapshot by snapshot. Data is Unusual Whales per-strike exposure captured every minute; it refreshes every 60 s. It currently loads for the owner only.

#### GEX Landscape

Sorts every SPX strike within ±50 points of spot into four gamma-and-charm quadrants: Max Launchpad, Fading Launchpad, Sticky Pin and Weakening Pin. Each strike is marked as a ceiling or floor, with 5-, 15- and 30-minute change columns and a volume-reinforcement flag. A board-level verdict (for example rangebound, gex-pull-up or breakdown-risk-down) is also passed to the AI analysis. Data is GEXBot per-strike exposure, captured every minute and scrubbable within the day; it refreshes every 60 s.

#### Zero Gamma

Tracks, for SPX, SPY and QQQ, the price where dealers' net gamma changes sign. The level is recomputed every five minutes from Unusual Whales per-strike exposures. Each card labels the regime SUPPRESSION (spot above the flip), ACCELERATION (below), KNIFE EDGE (within 0.3%) or NO FLIP, and a sparkline compares spot with the flip level. Past days can be browsed; it refreshes every 60 s.

#### Dealer Regime

Labels SPX, SPY and QQQ as long-γ, short-γ, transition (spot within 0.3% of zero gamma) or uncertain (low confidence or data older than 15 minutes), from the latest zero-gamma computation. It refreshes every 30 s and supports replay.

#### Strike Battle Map

Lines up customer directional gamma flow against dealer net gamma at the nearest out-of-the-money 0DTE strikes for SPY and QQQ. A concentration ratio (top strike vs top five) marks the setup as a _magnet_ (likely pin), _smeared_ (trend-friendly) or _partial_, and rings the magnet strike. Data is Unusual Whales per-strike, per-expiry gamma; it refreshes every 30 s with a minute scrubber.

#### 0DTE Greek Heatmap

Shows per-strike gamma, charm and vanna around the at-the-money strike (up to ±50 strikes) for any ticker in the Lottery Finder universe. It highlights the five largest net-gamma strikes and shows a Long Γ / Short Γ regime chip and the cumulative net call/put premium. Live data streams from the Unusual Whales websocket, with 90 days of history; it refreshes every 30 s while open.

#### GEXBot Dealer State

Summarizes dealer gamma, charm, convexity, 25Δ skew and order-flow velocity across 16 index, futures and ETF symbols (SPX, ES, NDX, NQ, RUT, VIX, SPY, QQQ, IWM, TLT, GLD, USO, TQQQ, UVXY, HYG, SLV), to show whether SPX positioning is confirmed by its siblings. A summary strip gives the headline regime, and a strike ladder shows the nearest dealer-gamma ceilings and floors around SPX. Data is GEXBot, captured every minute during market hours; it refreshes every 30 s.

#### Periscope MM Exposure

Turns SPX 0DTE market-maker gamma, charm and vanna into a trading map: structural levels around spot, long and short entry triggers with stops and targets, a WAIT band with a suggested options structure, and straddle-cone levels. The live map is computed by fixed rules (no AI) from one-minute GEXBot captures and refreshes every 60 s. A slot picker replays past 10-minute snapshots.

### Flow

#### Dark Pool Levels

Dark pool price levels for SPX, NDX, SPY and QQQ. Off-exchange prints from the Unusual Whales websocket are aggregated by price and ranked by total premium, with trade count and share volume. SPX and NDX levels are translated from SPY and QQQ prints using the per-minute index/ETF ratio. A date picker and time scrubber replay any point in a session, and the SPX view shows each level's distance from spot. Refreshes every 60 seconds; the AI analysis separately receives the $5M+ SPY blocks.

#### Greek Flow

Charts cumulative out-of-the-money directional delta and vega flow for SPY and QQQ through the session (0DTE or all expiries). Each chart flags slope, recent sign flips, late-day cliffs and SPY/QQQ divergence. A verdict tile reads _directional bull/bear confluence_, _pin / premium-harvest_, _vol expansion_ or _no confluence_. Data is Unusual Whales Greek flow, pulled every minute; it refreshes every 60 s with date replay.

#### Dir Vega Spikes

Lists moments when SPY or QQQ directional vega flow breaks sharply from its intraday baseline. A spike must clear a size floor, at least double the day's prior maximum, and score 6 or more on a robust (median/MAD) z-score. Simultaneous SPY and QQQ spikes are flagged as confluence, and each event gains 5/15/30-minute forward returns. Ranges: today, 7 days or 30 days; it refreshes every 60 s.

#### Interval B/A History

The uw-stream service watches SPY, SPXW and QQQ 0DTE prints. An alert fires when, within a five-minute window, at least 75% of a contract's premium (and at least $250K) trades at the ask, excluding buckets dominated by spread legs. Alerts are graded warning, critical ($500K+) or extreme ($1M+) and flagged as confluence when several tickers fire the same direction within 90 seconds. This panel filters past alerts by time window, call/put, premium, confluence and moneyness. Live alerts are described under [Alerts, notifications and PWA](#alerts-notifications-and-pwa).

### Setup detectors

#### Periscope Lottery

Monitors cheap, far out-of-the-money SPX 0DTE call and put setups. Detectors run every five minutes on GEXBot-derived 10-minute exposure slices. They flag a strike when its gamma change (calls) or charm change (puts) ranks at the top of the day, subject to fixed filters on distance from spot, dealer dollar gamma and entry price. Each fire lists its context and, after the hold window, its realized outcome. It refreshes every 60 s.

#### Gamma-Node Composite Detector

Watches SPX one-minute bars against the nearest positive-gamma floor and ceiling. It flags three rule-based setups: E1, a ceiling breakthrough with a 3-bar hold (long call); E5, a failed reversal below a floor (long put); and PCS, a Monday floor rejection (put credit spread). A day banner rates confidence MAXIMUM/HIGH/MEDIUM with anti-filter warnings, and a stats strip reports trailing 7–90-day fires, win rate and mean move, with CSV export. Detection runs every minute; the tile refreshes every 60 s.

---

## Futures

Owner and guest. ES, NQ, RTY, CL, GC and ZN with price, one-hour and daily change, relative volume and the ES-SPX basis, plus a VIX/VIX3M term-structure read (contango at 0.90 or below, backwardation at 1.00 or above). Prices come from one-minute bars that uw-stream builds from the Unusual Whales `futures_trades` stream, summarized every five minutes; a daily job repairs gaps. A date-time picker rebuilds the snapshot for any past moment. A built-in calculator handles ES/NQ/MES/MNQ trade P&L and risk-based position sizing in the browser. It refreshes every 30 s.

---

## Chart Analysis (Claude Opus 4.7)

The centerpiece feature (owner only; guests see the panel with submit disabled): upload up to two Unusual Whales Periscope screenshots (Gamma and SPX Charm). Claude Opus 4.7 with adaptive thinking reads them alongside structured flow, GEX, futures, dark-pool, positions and calculator context, then produces a complete trading plan. Market Tide, Net Flow, ETF Tide, 0DTE Index Flow, Delta Flow, aggregate and per-strike GEX are all fetched as data; none are screenshots.

### Three Analysis Modes

| Mode      | When                                 | What it produces                                                                                                   |
| --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Pre-Trade | Before entry (~8:45 AM CT)           | Full plan: structure, delta, 3 laddered entries, strike placement from gamma zones, management rules, hedge, risks |
| Mid-Day   | During position (~10:00–11:00 AM CT) | Update: has flow shifted, should you close legs, is it safe to add Entry 2/3                                       |
| Review    | After close (~4:00 PM ET)            | Retrospective: was the structure correct, what signals predicted the outcome, lessons learned                      |

### What Claude Receives

- Up to 2 chart images (Zod `max(2)`, 5 MB each), labelled Periscope (Gamma) and Periscope Charm (SPX)
- Full calculator context: SPX, VIX, VIX1D, VIX9D, VVIX, σ, T, hours remaining, delta ceiling, spread ceilings, regime zone, cluster multiplier (symmetric + directional put/call), DOW label, opening range signal, term structure signal + curve shape, RV/IV ratio, IV acceleration multiplier, overnight gap
- Chain Delta Rungs: actual strikes at 5–25Δ from the live Schwab chain, with the preferred 12Δ entry and the 10Δ floor
- Live Schwab positions: Current SPX 0DTE spreads with strikes, credits, P&L, cushion distances, and net greeks — auto-fetched before each analysis so Claude knows what's already open
- Database-driven market context: flow data (Market Tide, SPX/SPY/QQQ Net Flow, ETF Tide, 0DTE Index Flow, Delta Flow), Greek exposure, aggregate and per-strike GEX, SPX candles, dark pool blocks, max pain, economic events — all assembled by `buildAnalysisContext()`
- **Futures context**: 6 futures symbols (ES, NQ, ZN, RTY, CL, GC, fed by the Unusual Whales futures stream) with ES-SPX basis, NQ-ES divergence, ZN flight-to-safety, and VIX term structure (VIX/VIX3M)
- **UW deltas** (Phase 5b): dark pool velocity, GEX delta, whale net, ETF divergence — delta-based reads that outperform absolute levels for directional signal
- **Analog range forecast** (supplied to the AI analysis; not shown in the UI): cohort-conditional strike-placement hints from the 15 text-embedding-nearest historical mornings, plus a VIX-regime-stratified cohort (same-VIX-bucket mornings only) that adaptively widens on elevated/crisis-VIX days and falls back to the unstratified cohort below 8 matches
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
- Hedge recommendation: NO HEDGE, PROTECTIVE LONG, DEBIT SPREAD HEDGE, REDUCED SIZE, or SKIP
- Optional directional opportunity (long call or long put) with confidence, entry timing, stop, target and key levels
- End-of-day review with wasCorrect, whatWorked, whatMissed, optimalTrade, lessonsLearned, plus a per-entry recommendation chain graded CORRECT / WRONG_RESCUED / WRONG_UNRESCUED

The structure-selection rules, sizing tiers and rule priorities Claude applies are summarized in [TRADING_WORKFLOW.md](TRADING_WORKFLOW.md).

### UI Features

- Drag-and-drop, file picker, or clipboard paste for image upload (max 2 images, `api/_lib/validation/snapshot.ts`)
- Per-image label selector (Periscope (Gamma), Periscope Charm (SPX))
- Two-step confirmation: Analyze button → confirmation bar showing image count, mode, and labels → Confirm/Go Back
- Thinking indicator with progress bar, elapsed timer, rotating status messages, and Cancel button
- TL;DR summary card always visible with structure, confidence, delta, hedge badge, Entry 1 details, profit target
- Collapsible detail sections: Strike Guidance and Entry Plan expanded by default, all others collapsed
- Image issues: Claude flags genuinely unreadable images with Replace button for each
- Raw response fallback when JSON parsing fails

### Technical Details

- Model: Claude Opus 4.7 (`claude-opus-4-7`), effort `medium`
- Fallback: Sonnet 4.6 (`claude-sonnet-4-6`, effort `high`) if Opus is unavailable (availability errors only — request errors do not trigger fallback)
- Pre-check: a fast Claude Sonnet 4.6 call (up to 3 tool turns, 90 s budget) can fetch extra database context before the main Opus call
- Adaptive thinking: `thinking: { type: 'adaptive' }` — Claude decides how much thinking budget to use per request
- Max tokens: 128,000 (Opus primary) / 64,000 (Sonnet fallback)
- Vercel function timeout: 780 seconds (`maxDuration: 780`)
- Client-side timeout: 800 seconds per attempt (AbortController)
- Streaming: NDJSON response with 30-second keepalive pings
- Cost: ~$0.40–0.60 per analysis
- Prompt caching: the stable system prompt is one `cache_control: { type: 'ephemeral', ttl: '1h' }` block; lessons and similar-analysis context sit after it, outside the cache
- Owner-gated: requires authenticated session cookie
- Rate limited: 3 analyses per minute via Upstash Redis

---

## Lessons Learned System

A self-improving closed-loop system where Claude's end-of-day review analyses produce lessons that are automatically curated, deduplicated, and injected back into future analyses — making each trading session's recommendations smarter than the last.

### How It Works

1. **Review mode produces lessons.** When Claude runs an end-of-day review, it generates `lessonsLearned[]` — actionable insights about what worked, what was missed, and what to do differently next time.

2. **Friday cron curates lessons.** Every Friday night, a Vercel cron job (`/api/cron/curate-lessons`) extracts lessons from the week's reviews and deduplicates them against the existing compendium using OpenAI `text-embedding-3-large` vector similarity + Claude Opus judgment.

3. **Lessons injected at analysis time.** When `/api/analyze` is called, all active lessons are fetched from the `lessons` table and injected as a separate `<lessons_learned>` system block after the cached static prompt (outside the cache boundary, so lesson changes don't invalidate the cache). Claude selectively references applicable lessons based on current market conditions.

### Friday Cron Pipeline

| Step | Description                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Bootstrap a `lesson_reports` row (upsert for crash safety)                                                                                                                                     |
| 1    | Query unprocessed review analyses from the past 7 days                                                                                                                                         |
| 2    | **Phase A** (outside transaction): For each lesson — generate embedding via OpenAI, find 5 most similar existing lessons by cosine distance, call Claude Opus to decide ADD / SUPERSEDE / SKIP |
| 3    | **Phase B** (inside transaction): Batch all DB writes for a review atomically via `sql.transaction()`. Pre-allocate IDs via `nextval` for SUPERSEDE operations.                                |
| 4    | Build weekly changelog report and save to `lesson_reports`                                                                                                                                     |

Claude's curation rules enforce safety: it may NEVER edit existing lesson text, NEVER merge two lessons into one, and must ADD rather than SUPERSEDE when in doubt.

**Schedule:** `0 3 * * 6` (Saturday 03:00 UTC: Friday 11 PM ET in summer, 10 PM ET in winter)

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

## History panels

- **Analysis History** (owner) browses saved chart analyses by date and mode (Pre-Trade, Mid-Day, Review).
- **Periscope History** (owner and guest) is a read-only archive of past AI-assisted Periscope chart reads with their images and annotations.
- **Periscope Lesson Library** (owner and guest can read; edits are owner-only) lets the owner review, promote and archive lessons extracted from those debriefs by a weekly job.

---

## ML Insights

A carousel of research plots from the ML pipeline, on Pipeline and Vega tabs, shown to owner and guest sessions. Each plot comes with a Claude-written (Sonnet 4.6) "what the data means / how to apply it" explanation, and a findings summary sits above. The owner can re-run the explanations from the UI. The scheduled GitHub Actions pipeline has been paused since its last run on 2026-04-17, so the carousel shows the last published plots.

---

## Trading

### Live Position Tracking

Owner only. Real-time SPX 0DTE position awareness via the Schwab Trader API or manual CSV upload from thinkorswim paperMoney. Before each chart analysis, the frontend auto-fetches current positions so Claude can factor in what's already open.

#### Schwab Trader API (Live Accounts)

| Feature              | Detail                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| Endpoint             | `GET /api/positions?spx=5700&date=2026-03-16`                                                      |
| Data source          | Schwab Trader API (`/accounts/{hash}?fields=positions`)                                            |
| Filtering            | SPX options only (`$SPX` underlying), expiring today (0DTE), non-zero quantity                     |
| Spread grouping      | Matches short + long legs by put/call type and closest strike (max 50-pt width)                    |
| Spread types         | `CALL CREDIT SPREAD`, `PUT CREDIT SPREAD`, `IRON CONDOR`, `SINGLE` (unpaired naked short)          |
| Summary for Claude   | Human-readable text with strikes, contracts, credit, width, cushion from SPX, and aggregate greeks |
| DB persistence       | Saved to `positions` table with snapshot linkage, ON CONFLICT DO UPDATE for re-fetches             |
| Rate limit           | 20/min via Upstash Redis                                                                           |
| Graceful degradation | Positions are optional — if the fetch fails, analysis proceeds without them                        |

#### PaperMoney CSV Upload (Paper Trading)

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

#### What Claude Sees

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

### Position Monitor (Paper Dashboard)

Owner only. Full-featured position monitor with statement parsing and P&L analysis:

- **Account overview**: Cash, buying power, margin, portfolio value
- **Position table**: Strike pairs, quantity, entry/current price, P&L (open, unrealized %), per-contract Greeks (Delta, Gamma, Theta, Vega), DTE countdown
- **Execution quality analysis**: Entry execution price vs. theoretical, slippage analysis
- **Risk summary**: Portfolio Delta, Gamma, Theta, Vega exposure, max loss scenario
- **Portfolio risk warning**: fires when total effective max loss reaches 12% of account value (default threshold)
- **Strike map**: Visual representation of opened positions relative to spot
- **Theta decay simulator**: Time picker with Black-Scholes re-estimation at future time
- **Stop-loss modeling**: Adjustable multiplier (0 = theoretical max loss, 2–4× = stop at N× credit)

### Contract Tracker

Follows specific option contracts with entry price and size. A market-hours job refreshes them every five minutes from Unusual Whales and raises alerts on percentage moves, underlying price levels, or reaching 7 days to expiry. Alerts show as in-app toasts. Tabs split Active, Watchlist and Archive, and the archive reports win rate, average hold and P&L. Polls every 30 s while open; reads are owner and guest, edits owner-only.

### Settlement Pin Calculator (BWB + Iron Fly)

A trade-entry tool for pin plays (owner and guest; nav label "BWB Calculator"). Enter a sweet-spot strike and wing widths (default 20/40), or type the three strikes. Then enter your actual fill as a credit or debit to see max profit, max loss on each side, breakevens and a settlement P&L ladder in 5-point steps for a BWB (calls or puts) and an Iron Fly side by side. A gamma anchor, the proximity-weighted 0DTE/1DTE gamma centroid from Unusual Whales per-strike exposures, can fill the sweet spot in one click, optionally charm-adjusted, with HIGH/MEDIUM/LOW confidence. A VIX regime banner sits on top.

---

## Options Alerts

A full-screen view (header toggle, or `#alerts`) with two live unusual-options feeds: side by side on wide screens, stacked on narrow ones. Owner and guest; CSV exports are owner-only. Both read per-trade option prints that the uw-stream service streams from the Unusual Whales websocket into Postgres. Both refresh every 30 seconds while the market is open, and both can replay past days.

### Lottery Finder

Every minute, a cron scans an 86-ticker universe for contracts up to 7 days out. A fire needs a 5-minute window with at least 5 prints, volume of at least 5% of open interest (10% cumulative since the open), mean IV of 0.35 or more, mean |delta| of 0.13 or more, and at least 52% ask-side volume, with a 5-minute cooldown per contract. Each fire gets a quality score and a tier (Tier 1 at 13 or more, Tier 2 at 10 or more), plus macro and GEXBot context and a Take-It probability. After the close, realized outcomes are filled in under several exit policies. Banners summarize tier counts, the time-of-day session quality and the day's regime. A pinned "Hot Right Now" list surfaces multi-fire contracts that went quiet for 30+ minutes and then fired at least twice more.

### Silent Boom

Every 5 minutes, a cron flags contracts that were quiet (median of 500 contracts or fewer across their prior four traded 5-minute buckets) and then printed one sudden bucket. That bucket needs at least 1,000 contracts and 5× the baseline, at least 70% at the ask, volume of at least 25% of OI, and OI of 100 or more. Buckets dominated by spread legs are excluded, and there is a 60-minute cooldown. Alerts carry a score tier, a "spread-confirmed" badge and a day-level regime strip.

### Take-It score

Each Lottery Finder and Silent Boom alert carries a calibrated probability that the contract's peak reached at least +20% from entry. It is scored at detection time by per-feed gradient-boosted models with isotonic calibration, run in TypeScript inside the detection crons. The sidecar service adds the top SHAP drivers as green and red flags. Feeds default to a 0.70 probability floor, and each row shows the probability, its peak and the time of the peak. Retraining runs in the paused GitHub Actions ML pipeline.

### Multileg labels

The classifier service writes multileg structure labels onto Lottery Finder and Silent Boom fires, where the Take-It feature builder reads them; no panel shows them. Its retirement was approved on 2026-10-28 (`docs/superpowers/specs/2026-10-28-classifier-replacement-design.md`), but it still runs.

---

## Backtesting System

Full historical replay using 5-minute SPX candles from the Schwab API (owner or guest):

- Select any past date → calculator auto-fills from historical candle data at the selected time
- Running OHLC computed from market open to selected time (not end-of-day)
- VIX, VIX1D, VIX9D, VVIX resolved from historical data with CBOE static fallback for VIX1D
- Opening range computed from first 6 candles (30 minutes)
- Settlement check: which of the 5–15Δ strikes survived vs breached at the close
- Candle-by-candle navigation: change time to step through the day
- Backtest diagnostic panel: shows mode, date, candle index, all prices, gap, opening range, yesterday's range
- Chart analysis works during backtesting with correct historical values (not contaminated by live quotes)
- Snapshots and analyses auto-save to Postgres with `is_backtest: true`

---

## Alerts, notifications and PWA

- **Interval B/A alerts** (owner and guest): live alerts from the detector described under [Interval B/A History](#interval-ba-history) appear as a toast with a chime and a per-device mute.
- **Flow-ratio banner** (owner): a top banner surfaces sudden shifts in the 0DTE put/call premium ratio, checked every minute.
- **Web Push** (owner): confluence Interval B/A alerts, and a reminder to re-sign in to Schwab, arrive even when the app is closed.
- **PWA**: installable, with a one-click reload prompt when a new version is available.

---

## UI

- Light and dark modes with WCAG AA contrast in both modes
- 508 accessibility compliance: ARIA labels, roles, focus management, keyboard navigation, screen reader support
- Responsive: Works on desktop and mobile
- Section navigation generated from the panel registry (Inputs, Market Context, Futures, Charts & History, Trading, Results), filtered by access level, as a sidebar on wide screens and a sticky bar on narrow ones
- Header toggle between the Calculator and the full-screen Options Alerts view (`#alerts`)
- Customizable layout: a layout dialog shows and hides panels and drag-reorders panels within a group and the groups themselves; keyboard reordering is supported. Layouts are saved per owner and per guest key, so they follow you across devices. Public visitors keep a browser-local layout.
- Debounced inputs: Text fields recalculate after 250ms; dropdowns and sliders update instantly
- Quote status badge: LIVE, STALE (quotes 90 s+ old) or CLOSED, replaced by BACKTEST / NO INTRADAY when viewing a past moment (owner or guest)
- Collapsible section boxes with badge counts; collapse/expand all
- A "Resume live" chip after you edit the time
- Toast notifications for success/error states
- Error boundary with Sentry integration for graceful component failure

---

## VIX Data Management

Loading order: localStorage cache → static JSON → `/api/vix-ohlc` (derived from collected snapshots) for dates after the static file, with manual CSV upload as an override. VIX1D comes from a daily-refreshed `/api/vix1d-daily` map with the static file as fallback.

Built-in: 9,137 days of VIX OHLC (Jan 1990–Mar 2026) and 980 days of VIX1D (May 2022–Apr 2026).

VIX OHLC field selector: Choose resolution strategy for VIX from daily candles (smart, open, high, low, close).

---

## Excel Export

One-click XLSX with three sheets: P&L Comparison (7 wing widths × 6 deltas × 3 sides = 126 rows), IC Summary, and Inputs snapshot with methodology notes.

BWB export: Separate XLSX with BWB P&L profile across scenarios.

---

## Accessibility

Section 508 / WCAG 2.1 AA: semantic HTML, ARIA attributes, focus management, 4.5:1 contrast, `prefers-reduced-motion`, labeled inputs, `role="alert"` for errors. Automated accessibility scanning via `@axe-core/playwright` runs on every E2E test run against the home page, results, dark mode, live-data views, Chart Analysis, the Options Alerts view (including narrow layouts), the panel-layout dialog, and the 0DTE Gamma Regime and Dir Vega Spikes panels. Skip-to-content link and full keyboard navigation support.

---

## Data platform

As of 2026-10-29:

- Neon Postgres: about 90 tables, managed by 194 numbered migrations
- Vercel crons: 76 scheduled handlers in `api/cron/` (83 schedule entries in `vercel.json`)
- Railway Python services:
  - `uw-stream`: the Unusual Whales websocket consumer. It ingests per-trade option prints, flow alerts and futures trades (building 1-minute bars for 6 CME futures), with further handlers for net flow, per-strike GEX, dark pool prints and Interval B/A alerts
  - `classifier`: multileg structure labels on Lottery Finder and Silent Boom fires (retirement approved 2026-10-28; still running)
  - `sidecar`: Take-It SHAP explanations (filled by the `takeit-fill-shap` cron) and DuckDB queries over the frozen historical Parquet archive
- The ML pipeline (`ml/`) runs as a GitHub Actions workflow that is currently paused (last run 2026-04-17)

---

## Accuracy & Limitations

1. **VIX vs actual 0DTE IV**: VIX1D auto-apply mitigates this; the live chain gives the AI analysis actual per-strike deltas
2. **IV acceleration is empirical**: The intraday σ multiplier (0.6 coefficient) is calibrated from observed behavior, not derived from a formal model. Actual gamma acceleration varies by VIX regime and market structure. The multiplier is capped at 1.8× to prevent extreme values near close.
3. **Fat-tail kurtosis is stepped, not continuous**: The VIX-dependent kurtosis factor (`getKurtosisFactor(vix)`) uses five discrete VIX bands (put tail 1.8× at VIX < 15 → 4.0× at VIX 30+; call tail 1.2× → 3.0×). Real kurtosis varies continuously and by time of day. A smoothly interpolated kurtosis curve would be more accurate.
4. **Convex skew exponent is static**: The 1.35 put convexity is empirically reasonable for typical VIX 15-25 days. On extreme fear days (VIX 35+), real put skew can be significantly steeper. The chain endpoint shows actual per-strike IV for comparison.
5. **Theoretical vs market premiums**: Black-Scholes assumes continuous hedging; real prices include bid/ask spreads
6. **Parkinson RV estimator**: Uses a 5-day rolling window of daily high-low ranges. Smoother than single-day, but still sensitive to outlier days. A longer window (10-20 days) or GARCH-based estimator could improve stability.
7. **Chart analysis limitations**: Claude reads the two Periscope screenshots visually, so per-strike gamma and charm magnitudes are estimates from bar lengths. Flow data (Market Tide, Net Flow, ETF Tide and others) arrives as exact API values. Image quality affects accuracy.
8. **Backtest limitations**: historical per-strike dealer exposure exists only from when collection began (GEXBot captures and 10-minute Periscope snapshots). Screenshots used in past analyses are point-in-time.
9. **Database coverage**: VIX1D data available from May 2022 only; earlier outcomes have VIX close but not VIX1D close
10. **Pin risk requires live chain**: OI table only available during market hours with an owner or guest session. Historical OI data is not persisted.
11. **ML pipeline maturity**: Phase 2 (structure classification) is in early feasibility with ~35 labeled days — no model yet beats the majority-class baseline. Full training expected at 60+ labeled days (see `ml/docs/PHASE-2-STRUCTURE-CLASSIFICATION.md`). The scheduled pipeline is currently paused.
12. **Futures data**: Futures bars come from the Unusual Whales `futures_trades` websocket (uw-stream). Minutes lost to restarts or socket drops are repaired daily from UW REST candles, which reach back only ~3.5 trading days at 1-minute depth. DX, VX futures, ES options and TBBO microstructure have no Unusual Whales source and are unavailable.
