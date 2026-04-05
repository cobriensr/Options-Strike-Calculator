# Futures Data Integration — Design Spec

**Date:** 2026-04-05
**Scope:** Replace Tradovate sidecar with Databento, expand to 7 futures symbols + ES options, automate pre-market data entry, add futures context to Claude analysis and ML pipeline, implement institutional-level market alerts

---

## Summary

Replace the single-symbol Tradovate ES sidecar with a multi-symbol Databento sidecar streaming 1-minute OHLCV bars for 7 futures contracts plus ES options. Automate the manual pre-market data entry flow. Feed futures data into Claude's analysis context, the ML feature pipeline, and the Twilio alert system.

### Goals

1. **Real-time futures data** — /ES, /NQ, /VXM (×2 months), /ZN, /RTY, /CL streaming 1-minute bars via Databento Live
2. **ES options institutional positioning** — ATM ±10 strikes OHLCV-1m for intraday volume + EOD Statistics for daily OI
3. **Pre-market automation** — overnight Globex high/low/close/VWAP computed from bars and pre-filled into the frontend component
4. **Claude prompt integration** — new `## Futures Context` section with momentum, basis, term structure, macro signals
5. **ML features** — ~25 new features across 6 groups (ES, NQ, VX, ZN, RTY, CL)
6. **Market alerts** — Twilio notifications for ES momentum spikes, VX backwardation, ES-NQ divergence, ZN flight-to-safety, CL intraday spikes, ES options unusual volume
7. **Historical backfill** — 1 year of OHLCV-1m for all symbols via Databento batch API

### Non-Goals

- L2/L3 order book data ($1,500+/month — not cost-justified)
- Sub-minute granularity (1-minute bars are sufficient for 0DTE credit spread decisions)
- Non-CME instruments (no forex, no crypto, no equities outside futures)

---

## Data Provider

**Databento** — $179/month flat subscription covering all CME, CBOT, NYMEX, COMEX products (futures, options, spreads). 650,000+ symbols. 1 year L1 history included. No per-symbol or per-API-call fees.

### Schemas Used

| Schema | Level | History | Purpose | Frequency |
|--------|-------|---------|---------|-----------|
| OHLCV-1m | L0 | 15+ years | 1-minute bars for all 7 futures | Real-time streaming via sidecar |
| Trades | L1 | 12 months | Tick-level trades for ES options — includes aggressor side (`side` field: A=sell aggressor, B=buy aggressor). Detects whether institutional volume is aggressive buying or selling, not just volume magnitude. | Real-time streaming via sidecar (ATM ±10 strikes) |
| Statistics | L0 | 15+ years | Official venue summary statistics. `stat_type` determines the record: opening price (1), settlement price (3, with flags for preliminary/final), session low/high (4/5), cleared volume (6), **open interest (9)**, fixing/VWAP (10/13), **implied volatility (14)**, **options delta (15)**, price limits (17/18). Provides exchange-computed Greeks for ES options — not model-estimated. | Daily cron post-settlement + live for intraday OI updates |
| Definition | L0 | 15+ years | Instrument reference data. Key fields for ES options: `instrument_class` (C=Call, P=Put, F=Future), `strike_price` (1e-9 units), `expiration` (nanosecond timestamp), `underlying` (symbol), `security_type` (OOF=Option on Future). Used for dynamic strike discovery and contract roll management. | On-demand at session start + when ES moves ±50 pts |

**Schemas NOT used** (and why):
- **MBO, MBP-10** (L2/L3) — too expensive for live streaming. Historical-only (1 month) insufficient for feature engineering.
- **BBO, CBBO, TBBO, TCBBO** — subsets of MBP-1 sampled at intervals. OHLCV-1m provides equivalent information more efficiently for our 1-minute decision cadence.
- **Imbalance** — auction imbalance data. Relevant for equities (MOC), not for continuous futures trading.
- **Status** — trading halts and session state changes. Low value — halt detection is implicit from price action stopping.
- **MBP-1, CMBP-1** — top-of-book tick data. More granular than needed (1-minute bars are sufficient for 0DTE credit spread decisions).

**Price handling**: All Databento prices are `int64_t` in 1e-9 units (nanodollars). The sidecar must convert: `price_decimal = raw_price / 1_000_000_000`. The Databento SDK may handle this conversion automatically — verify during implementation.

---

## Symbol Selection

### Futures Contracts (7)

| Symbol | Instrument | Exchange | Signal Category |
|--------|-----------|----------|-----------------|
| /ES | E-mini S&P 500 | CME | Equity momentum, overnight gap, ES-SPX basis, institutional volume |
| /NQ | E-mini Nasdaq 100 | CME | Tech sector health, NQ/ES ratio, QQQ flow cross-validation |
| /VXM | Micro VIX (front month) | CFE | Vol regime — current VIX futures price |
| /VXM+1 | Micro VIX (second month) | CFE | Vol term structure — contango/backwardation spread |
| /ZN | 10-Year Treasury Note | CBOT | Macro regime — rates, flight-to-safety, risk-on/risk-off |
| /RTY | E-mini Russell 2000 | CME | Market breadth — small cap divergence signals narrow vs broad moves |
| /CL | WTI Crude Oil | NYMEX | Macro — inflation expectations, geopolitical risk, direct equity correlation |

### ES Options (~20 contracts, rolling)

Subscribe to **Trades** schema (not OHLCV) for the 10 nearest put strikes and 10 nearest call strikes around the current ES ATM level. Re-center every 50 pts of ES movement or at session open. Use **Definition** schema at session start to discover available strikes and expirations.

**Why Trades instead of OHLCV for ES options**: The Trades schema includes the `side` field (aggressor side: `A`=sell aggressor hitting bids, `B`=buy aggressor lifting offers). This is the difference between "volume happened" and "institutions are aggressively buying puts." A 5,000-lot ES put trade at the ask (sell aggressor) means a market maker is selling to a buyer — institutional hedge being placed. The same volume at the bid (buy aggressor) means someone is dumping — unwinding a hedge. OHLCV would only show "5,000 contracts traded" with no directional intent.

**EOD**: Pull Statistics schema for all ES option strikes — gives daily OI (`stat_type=9`), settlement price (`stat_type=3`), exchange-computed **implied volatility** (`stat_type=14`), and **options delta** (`stat_type=15`). This means the "futures-side gamma wall" includes actual exchange-published Greeks, not model-estimated values. Comparing exchange-computed ES option delta profiles against Unusual Whales' SPX gamma walls gives two independent reads on the same positioning question.

---

## Architecture

### Sidecar (Railway) — Databento Rewrite

```
Databento Live TCP Client
  │
  ├── OHLCV-1m subscriptions (7 futures contracts):
  │     /ES, /NQ, /VXM front, /VXM second, /ZN, /RTY, /CL
  │
  ├── Trades subscription (ES options ATM ±10 strikes):
  │     ~20 contracts, includes aggressor side (buy/sell)
  │     Re-centered via Definition schema when ES moves ±50 pts
  │
  ├── Definition subscription (ES options chain):
  │     Pulled at session start for strike/expiry discovery
  │
  └── Statistics subscription (all instruments):
        Captures OI, settlement, IV, delta as published by venue
        ↓
  Write to Neon Postgres
  ├── futures_bars (OHLCV per symbol per minute)
  ├── futures_options_trades (ES option trades with aggressor side)
  └── futures_options_daily (EOD OI, settlement, IV, delta per strike)
        ↓
  Alert Engine (in-sidecar)
  ├── Evaluate conditions on every new bar/trade
  ├── Rate limit: max 1 alert per condition per cooldown period
  └── Fire via Twilio SMS when triggered
```

### What Gets Removed (Tradovate)

| File | Status |
|------|--------|
| `sidecar/src/tradovate-ws.ts` | Delete — replaced by Databento client |
| `sidecar/src/tradovate-auth.ts` | Delete |
| `sidecar/src/bar-aggregator.ts` | Delete — Databento provides pre-aggregated OHLCV-1m |
| `sidecar/src/contract-roller.ts` | Delete — Databento handles continuous contracts |
| Railway env vars: `TRADOVATE_*` | Remove — replace with `DATABENTO_API_KEY` |

### What Gets Added

| File | Purpose |
|------|---------|
| `sidecar/src/databento-client.ts` | Databento Live TCP connection, subscription management for OHLCV-1m + Trades + Statistics |
| `sidecar/src/symbol-manager.ts` | Contract roll logic, ES options strike re-centering using Definition schema |
| `sidecar/src/trade-processor.ts` | Process ES options Trades stream — extract aggressor side, aggregate rolling volume by strike, detect unusual activity |
| `sidecar/src/alert-engine.ts` | Evaluate alert conditions on each new bar/trade, fire Twilio SMS |
| `sidecar/src/alert-config.ts` | Configurable thresholds (DB-backed via `alert_config` table for runtime adjustment) |

### Existing Files Modified

| File | Change |
|------|--------|
| `sidecar/src/db.ts` | Add `futures_bars` and `futures_options_bars` upserts |
| `sidecar/src/index.ts` | Wire up Databento client instead of Tradovate |
| `sidecar/Dockerfile` | Update dependencies |
| `sidecar/package.json` | Replace `tradovate-*` deps with `databento` |

---

## Database Schema

### `futures_bars` (replaces `es_bars`)

```sql
CREATE TABLE IF NOT EXISTS futures_bars (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,           -- 'ES', 'NQ', 'VXM1', 'VXM2', 'ZN', 'RTY', 'CL'
  ts TIMESTAMPTZ NOT NULL,        -- Bar timestamp (UTC, normalized to minute)
  open NUMERIC(12,4) NOT NULL,
  high NUMERIC(12,4) NOT NULL,
  low NUMERIC(12,4) NOT NULL,
  close NUMERIC(12,4) NOT NULL,
  volume BIGINT NOT NULL DEFAULT 0,
  UNIQUE(symbol, ts)
);

CREATE INDEX IF NOT EXISTS idx_futures_bars_symbol_ts
  ON futures_bars (symbol, ts DESC);
```

**Migration**: Migrate existing `es_bars` data into `futures_bars` with `symbol = 'ES'`, then drop `es_bars`.

**Storage estimate**: 6 symbols × ~1,050 bars/day × 252 days × ~100 bytes ≈ 160 MB for 1-year backfill. With live accumulation: ~630 KB/day ongoing.

### `futures_options_trades` (new — tick-level ES option trades)

```sql
CREATE TABLE IF NOT EXISTS futures_options_trades (
  id BIGSERIAL PRIMARY KEY,
  underlying TEXT NOT NULL,       -- 'ES'
  expiry DATE NOT NULL,           -- Option expiration date
  strike NUMERIC(10,2) NOT NULL,  -- Strike price
  option_type CHAR(1) NOT NULL,   -- 'C' or 'P'
  ts TIMESTAMPTZ NOT NULL,        -- Trade timestamp (nanosecond precision from venue)
  price NUMERIC(10,4) NOT NULL,   -- Trade price
  size INT NOT NULL,              -- Number of contracts
  side CHAR(1) NOT NULL,          -- 'A' = sell aggressor (hitting bid), 'B' = buy aggressor (lifting ask), 'N' = none
  trade_date DATE NOT NULL        -- For partitioning/cleanup
);

CREATE INDEX IF NOT EXISTS idx_fot_strike_ts
  ON futures_options_trades (underlying, strike, ts DESC);
CREATE INDEX IF NOT EXISTS idx_fot_trade_date
  ON futures_options_trades (trade_date);
```

**Note**: No UNIQUE constraint — multiple trades can occur at the same nanosecond. Indexed by strike + timestamp for fast "recent volume at this strike" queries. The `trade_date` index supports daily cleanup (retain 5 trading days of tick data, archive or drop older).

### `futures_options_daily` (new — EOD Statistics with Greeks)

```sql
CREATE TABLE IF NOT EXISTS futures_options_daily (
  id BIGSERIAL PRIMARY KEY,
  underlying TEXT NOT NULL,
  trade_date DATE NOT NULL,
  expiry DATE NOT NULL,
  strike NUMERIC(10,2) NOT NULL,
  option_type CHAR(1) NOT NULL,
  open_interest BIGINT,           -- stat_type=9: outstanding contracts
  volume BIGINT,                  -- stat_type=6: cleared volume
  settlement NUMERIC(10,4),       -- stat_type=3: official settlement price
  implied_vol NUMERIC(8,6),       -- stat_type=14: exchange-computed IV (decimal, e.g. 0.2450)
  delta NUMERIC(8,6),             -- stat_type=15: exchange-computed delta (decimal, e.g. -0.3200)
  is_final BOOLEAN DEFAULT false, -- stat_flags: preliminary vs final settlement
  UNIQUE(underlying, trade_date, expiry, strike, option_type)
);
```

**Note**: `implied_vol` and `delta` are exchange-published values from the Statistics schema, not model-estimated. These provide the "institutional Greeks" view — what the CME's settlement process computed, which is what clearing firms and institutional risk systems use for margin calculations.

### `futures_snapshots` (new — computed intraday context)

```sql
CREATE TABLE IF NOT EXISTS futures_snapshots (
  id SERIAL PRIMARY KEY,
  trade_date DATE NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  symbol TEXT NOT NULL,
  price NUMERIC(12,4) NOT NULL,
  change_1h_pct NUMERIC(8,4),
  change_day_pct NUMERIC(8,4),
  volume_ratio NUMERIC(8,4),     -- current volume / 20-day avg
  UNIQUE(symbol, ts)
);
```

### `alert_config` (new — configurable thresholds)

```sql
CREATE TABLE IF NOT EXISTS alert_config (
  id SERIAL PRIMARY KEY,
  alert_type TEXT NOT NULL UNIQUE,  -- 'es_momentum', 'vx_backwardation', etc.
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL,            -- threshold values (configurable at runtime)
  cooldown_minutes INT NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

Default alert configs:

```json
{
  "es_momentum": { "pts_threshold": 30, "window_minutes": 10, "volume_multiple": 2.0 },
  "vx_backwardation": { "spread_threshold": 0 },
  "es_nq_divergence": { "divergence_pct": 0.5, "window_minutes": 30 },
  "zn_flight_to_safety": { "zn_move_pts": 0.5, "es_move_pts": -20, "window_minutes": 30 },
  "cl_spike": { "change_pct": 2.0, "window_minutes": 60 },
  "es_options_volume": { "volume_multiple": 5.0, "window_minutes": 15 }
}
```

---

## Pre-Market Automation

### Current Flow (manual)

1. User looks up Globex high/low/close/VWAP from external source
2. Types 4 numbers into PreMarketInput component
3. Hits "Update" → saves to `market_snapshots.pre_market_data`
4. `compute-es-overnight.ts` cron runs at 9:35 AM ET, computes classifications
5. Claude analysis queries the snapshot for overnight context

### New Flow (automated)

1. Sidecar writes ES bars from 5 PM CT through 8:30 AM CT to `futures_bars`
2. At 8:30 AM CT, new cron `auto-prefill-premarket.ts` runs:
   - Queries `futures_bars` for symbol='ES', ts between yesterday 5 PM CT and today 8:30 AM CT
   - Computes: Globex high, low, close (last bar's close), VWAP (volume-weighted average of all bars)
   - Writes to `market_snapshots.pre_market_data` for today's date
3. At 8:35 AM CT, existing `compute-es-overnight.ts` runs (unchanged) — reads the auto-populated data
4. Frontend PreMarketInput loads pre-filled values on mount — user sees data, can verify/override
5. Claude analysis gets overnight context automatically, even if user doesn't touch the form

### Component Changes

- PreMarketInput loads saved `pre_market_data` on mount (already does this for manual saves)
- Add a "Pre-filled from live data" badge when data was auto-populated
- "Update" button remains for manual override if needed
- Remove required field validation on initial load (fields are pre-populated)

---

## Claude Analysis Integration

### New System Prompt Section: `<futures_context_rules>`

```
<futures_context_rules>
Futures data provides institutional-level signals that lead options flow by 10-30 minutes.
When futures signals disagree with options flow, futures are usually more reliable because
institutional desks execute in futures first (fastest, deepest liquidity), then hedge via
options — not the other way around.

ES-SPX Basis:
- Normal range: ±2 pts. Basis tracks fair value (dividends + interest).
- Widening beyond ±5 pts signals liquidity stress — reduce confidence by one tier.
- Persistent premium (ES > SPX fair value) = institutional demand for upside exposure.

NQ-QQQ Divergence:
- When NQ momentum agrees with QQQ flow → signals are reinforcing, trust the direction.
- When NQ momentum DISAGREES with QQQ flow → futures market (institutional) is usually
  right. Fade the options flow signal. Reduce QQQ flow weight in Rule 8 to 10%.

VIX Futures Term Structure:
- Contango (VXM front < back, normal) = vol expected to mean-revert. Favorable for
  premium selling. Straddle cones are reliably sized. IC structures viable.
- Backwardation (VXM front > back) = market expects vol to peak TODAY. Straddle cones
  may be understated. Widen IC strikes by 5-10 pts or avoid IC entirely. Require
  flow agreement ≥ 7/9 before entering any structure.
- Contango collapse (spread narrowing rapidly) = regime transition in progress. Treat
  as high-uncertainty — reduce to MODERATE confidence regardless of other signals.

ZN Flight-to-Safety:
- ZN rallying (yields falling) + ES selling = institutional capital leaving equities
  for duration. This is a TRENDING day signal — the selloff has institutional sponsorship
  and is unlikely to reverse on flow signals alone. Require HIGH confidence + ≥ 7/9
  agreement to enter, or SIT OUT.
- ZN selling + ES selling = liquidity crisis or forced selling. Different animal — more
  likely to produce a snapback reversal. Standard rules apply.
- ZN flat while ES moves = equity-specific event (earnings, sector rotation). Macro
  backdrop is not driving the move. Flow signals are more reliable in this regime.

RTY Breadth:
- RTY and ES moving together = broad market move with institutional backing. Higher
  confidence in directional credit spreads.
- RTY diverging from ES = narrow market driven by mega-cap tech. The move is fragile
  and more likely to reverse. Reduce confidence by one tier on directional structures.

CL Crude Oil:
- CL down >2% intraday → inflation expectations falling → rate cut expectations
  rising → equity vol should compress. Favorable for premium selling, IC-friendly.
- CL up >2% intraday → inflation/geopolitical risk repricing → equity vol likely
  expands. Widen strikes, prefer directional credit spreads over IC.
- CL and ES correlated (moving same direction) → macro-driven session. Flow
  agreement should be weighted more heavily.
- CL and ES decorrelated → something unusual happening. Be cautious with
  macro-based confidence.

ES Options Institutional Positioning:
- Heavy ES put buying at a specific strike = institutional hedge being placed.
  This strike becomes a "futures-side support level" that may reinforce or
  contradict SPX gamma walls.
- AGGRESSOR SIDE MATTERS: Trades with side='B' (buy aggressor, lifting offers)
  are active institutional buying — strongest signal. Trades with side='A' (sell
  aggressor, hitting bids) are active selling or hedge unwinding. Trades with
  side='N' are crossed/block trades — institutional but direction ambiguous.
- ES options OI concentrated at a strike with >2x surrounding OI = institutional
  consensus on a price target. Treat like a SPX gamma wall from the futures side.
- Exchange-published delta and IV from Statistics provide the INSTITUTIONAL view
  of Greeks — what clearing firms use for margin. When exchange delta disagrees
  with model-estimated SPX delta at the same strike level, the exchange values
  are more reliable for institutional positioning inference.
- When ES options gamma walls AGREE with SPX gamma walls → very high confidence
  in those levels.
- When they DISAGREE → the market is structurally uncertain at those levels.
  Widen strikes to avoid the contested zone.
</futures_context_rules>
```

### New Context Section: `## Futures Context`

Auto-populated by `buildAnalysisContext()` from `futures_snapshots` and `futures_bars`:

```
## Futures Context

ES Futures (/ES):
  Current: 5,847.50 | 1H: +12.75 (+0.22%) | Day: +28.50 (+0.49%)
  Volume: 1.2M contracts (1.4× 20-day avg — ELEVATED)
  ES-SPX Basis: +3.25 pts (normal)
  Overnight: Globex 5,820–5,855, VWAP 5,838, Gap: +8 DOWN (SMALL)

NQ Futures (/NQ):
  Current: 20,450 | 1H: +85 (+0.42%) | Day: +165 (+0.81%)
  NQ/ES Ratio: 3.496 (above 20-day avg 3.485 — tech outperforming)
  NQ-QQQ Divergence: ALIGNED

VIX Futures (/VXM):
  Front Month: 24.80 | Second Month: 23.15
  Term Structure: BACKWARDATION (spread: +1.65, front > back)
  20-day Avg Spread: -0.85 (contango) → Current: +1.65 = REGIME SHIFT
  Signal: Near-term stress priced in. Straddle cones may understate range.

10Y Treasury (/ZN):
  Current: 110-24 | 1H: +0-08 (yields falling)
  SPX-ZN 5-day Correlation: -0.72 (normal inverse)
  Signal: Bonds bid, no flight-to-safety detected (ES also positive)

Russell 2000 (/RTY):
  Current: 2,015 | 1H: +8.5 (+0.42%) | Day: +22 (+1.10%)
  RTY-ES Divergence: ALIGNED (broad rally, not mega-cap only)

Crude Oil (/CL):
  Current: 61.25 | 1H: -0.85 (-1.4%) | Day: -1.75 (-2.8%)
  CL-ES 5-day Correlation: +0.68 (elevated — macro-driven)
  Signal: Oil weakness → inflation expectations easing → vol compression favorable

ES Options Institutional Activity:
  Notable Volume: 5850P — 12,400 contracts (4.2× avg) in last 30 min
  Daily OI Concentration: 5800P (85K OI), 5900C (72K OI)
  Futures Gamma Wall: 5800 support (put OI), 5900 resistance (call OI)
  Agreement with SPX Gamma Walls: 5800 support AGREES, 5900 resistance DISAGREES
  (SPX shows 5920 as ceiling — 20 pt gap between futures and cash gamma)
```

---

## ML Feature Engineering

### New Feature Groups (add to `build-features.ts` and `ml/src/utils.py`)

```python
ES_FEATURES = [
    "es_momentum_t1",        # ES 1H return at T1 checkpoint (%)
    "es_momentum_t2",        # ES 1H return at T2 checkpoint (%)
    "es_spx_basis_t1",       # ES - SPX fair value at T1 (pts)
    "es_volume_ratio_t1",    # ES volume / 20-day avg at T1
    "es_overnight_range",    # Globex high - low (pts)
    "es_overnight_gap",      # Cash open - Globex close (pts)
    "es_gap_fill_pct_t1",    # How much of the gap filled by T1
    "es_vwap_deviation_t1",  # ES price - overnight VWAP at T1 (pts)
]

NQ_FEATURES = [
    "nq_momentum_t1",        # NQ 1H return at T1 (%)
    "nq_es_ratio_t1",        # NQ/ES ratio at T1 (tech strength)
    "nq_es_ratio_change",    # NQ/ES ratio change from prior day close
    "nq_qqq_divergence_t1",  # sign(NQ momentum) vs sign(QQQ NCP) agreement (1/-1)
]

VX_FEATURES = [
    "vx_front_price",         # VXM front month close/last
    "vx_term_spread",         # VXM front - VXM second (pts)
    "vx_term_slope_pct",      # (front - back) / back as percentage
    "vx_contango_signal",     # 1 = contango, -1 = backwardation
    "vx_basis",               # VXM front - spot VIX (futures premium)
]

ZN_FEATURES = [
    "zn_momentum_t1",         # ZN 1H return at T1 (%)
    "zn_daily_change",        # Prior day ZN change (%)
    "spx_zn_correlation_5d",  # 5-day rolling correlation SPX vs ZN
]

RTY_FEATURES = [
    "rty_momentum_t1",        # RTY 1H return at T1 (%)
    "rty_es_divergence_t1",   # sign(RTY momentum) vs sign(ES momentum) agreement
]

CL_FEATURES = [
    "cl_overnight_change_pct",  # % change from prior settlement to Globex close
    "cl_intraday_momentum_t1",  # % change from open to T1
    "cl_es_correlation_5d",     # 5-day rolling correlation CL vs ES
]

ES_OPTIONS_FEATURES = [
    "es_put_oi_concentration",    # OI at largest put strike / total put OI (from Statistics stat_type=9)
    "es_call_oi_concentration",   # OI at largest call strike / total call OI
    "es_options_max_pain_dist",   # Distance from current ES to max pain strike (pts)
    "es_spx_gamma_agreement",     # Do ES and SPX gamma walls agree? (0-1 score)
    "es_put_buy_aggressor_pct",   # % of ES put volume from buy aggressors (side='B') — institutional demand
    "es_call_buy_aggressor_pct",  # % of ES call volume from buy aggressors — institutional bullishness
    "es_options_net_delta",       # Sum of exchange-computed delta × OI across ATM strikes (from Statistics stat_type=15)
    "es_atm_iv",                  # Exchange-computed IV at nearest ATM strike (from Statistics stat_type=14)
]
```

**Total: ~32 new features** added to the training_features table.

---

## Market Alerts (Twilio)

### Alert Engine (sidecar-resident)

The alert engine runs inside the sidecar process (not on Vercel cron) for minimum latency. It evaluates conditions every time a new 1-minute bar arrives.

### Alert Types

| Alert Type | Default Condition | Cooldown | Message Example |
|-----------|-------------------|----------|-----------------|
| `es_momentum` | /ES moves ±30 pts in 10 min at ≥2× volume | 30 min | "⚡ ES ALERT: /ES -35 pts in 8 min (2.4× vol). Price: 5812. SPX impact imminent." |
| `vx_backwardation` | VXM front crosses above VXM second | 60 min | "🔴 VIX BACKWARDATION: Front 25.80 > Back 24.90. Near-term stress priced in." |
| `es_nq_divergence` | /ES and /NQ diverge ≥0.5% in 30 min | 30 min | "⚠️ ES-NQ SPLIT: ES -0.3% but NQ +0.4% (30 min). Sector rotation active." |
| `zn_flight_safety` | /ZN +0.5 pts while /ES -20 pts in 30 min | 60 min | "🏃 FLIGHT TO SAFETY: ZN rallying while ES dumping. Institutional exit." |
| `cl_spike` | /CL moves ±2% in 60 min | 30 min | "🛢️ CRUDE SPIKE: /CL +2.8% in 45 min. Inflation repricing — vol expansion likely." |
| `es_options_volume` | ES option strike hits ≥5× avg volume in 15 min, with aggressor breakdown | 30 min | "📊 ES OPTIONS: 5800P — 15K contracts in 12 min (5.2× avg). 82% buy aggressor (lifting asks). Institutional put buying." |

### Configuration

Thresholds stored in `alert_config` Postgres table. Adjustable via:
- Direct DB update (simplest)
- Future: small admin endpoint `POST /api/alerts/config` (optional)

### Rate Limiting

- Max 1 alert per alert_type per cooldown period (default 30 min)
- Global cap: max 10 alerts per hour across all types (safety valve)
- Track last-fired timestamps in memory (sidecar process, resets on restart)

---

## Historical Backfill

### One-Time Script: `scripts/backfill-futures.ts`

Uses Databento's batch/historical API:

| Data | Symbols | Schema | Level | History Available | Rows (estimated) |
|------|---------|--------|-------|-------------------|-------------------|
| Futures bars | ES, NQ, VXM, ZN, RTY, CL | OHLCV-1m | L0 | 15+ years (pulling 1 year) | ~1.6M rows (~160 MB) |
| Futures daily | ES, NQ, VXM, ZN, RTY, CL | OHLCV-1d | L0 | 15+ years (pulling 1 year) | ~1,500 rows |
| ES options daily stats | All ES option strikes | Statistics | L0 | 15+ years (pulling 1 year) | ~500K rows (~50 MB) |
| ES options trades | ATM ±50 strikes | Trades | L1 | 12 months max | ~2M rows (~200 MB) — optional, can skip for initial build |

**Total without trades backfill**: ~210 MB. Well within Neon free tier.
**Total with trades backfill**: ~410 MB. Approaching limit — may need Neon upgrade or retention policy (keep only 3 months of tick trades, full year of daily stats).

### Backfill Process

1. Pull OHLCV-1m for each symbol, 1 month at a time (API pagination)
2. Bulk insert into `futures_bars` with `ON CONFLICT DO NOTHING`
3. Pull Statistics for ES options by date range
4. Insert into `futures_options_daily`
5. Compute derived features for historical dates (rolling correlations, ratios)
6. Log progress and row counts

---

## Frontend Changes

### PreMarketInput Component (modified)

- Auto-loads pre-filled Globex data from `market_snapshots.pre_market_data`
- Shows "Auto-filled from live data ✓" badge when data was auto-populated by the sidecar
- "Update" button remains for manual override
- Computed fields (O/N Range, ES vs SPX) remain as-is

### New: Futures Panel Component

Compact dashboard section showing:
- /ES, /NQ, /VXM, /ZN, /RTY, /CL — current price + 1H change + day change
- VIX term structure status badge (CONTANGO / FLAT / BACKWARDATION)
- ES-SPX basis
- RTY-ES breadth indicator (ALIGNED / DIVERGING)
- CL-ES correlation indicator

**Data source**: `GET /api/futures/snapshot` — reads from `futures_snapshots` table (updated every 5 min by a Vercel cron that queries `futures_bars`)

**Owner-gated**: Yes (matches ML Insights pattern)

---

## Cron Jobs (new or modified)

| Cron | Schedule | Purpose |
|------|----------|---------|
| `auto-prefill-premarket.ts` | 8:30 AM CT (13:30 UTC) weekdays | Compute Globex high/low/close/VWAP from overnight ES bars, write to market_snapshots |
| `compute-futures-overnight.ts` | 8:35 AM CT weekdays | Expand existing ES overnight computation to all 7 symbols |
| `fetch-futures-snapshot.ts` | Every 5 min during market hours | Query latest bars, compute momentum/basis/correlation, write to futures_snapshots |
| `fetch-es-options-eod.ts` | 5:00 PM CT weekdays | Pull EOD Statistics for ES options (OI, settlement), write to futures_options_daily |
| `build-features.ts` (modified) | 9:00 PM ET weekdays (existing) | Add 28 new futures features to training_features computation |

---

## Build Phases

| Phase | Scope | Files | Depends On |
|-------|-------|-------|------------|
| **1** | DB migrations: futures_bars, futures_options_bars, futures_options_daily, futures_snapshots, alert_config. Migrate es_bars → futures_bars. | `api/_lib/db-migrations.ts` | Nothing |
| **2** | Sidecar rewrite: Databento client, multi-symbol subscriptions, bar writing | `sidecar/src/` (full rewrite) | Phase 1 (tables exist) |
| **3** | Historical backfill script | `scripts/backfill-futures.ts` | Phase 1 |
| **4** | Alert engine: condition evaluation, Twilio integration, configurable thresholds | `sidecar/src/alert-engine.ts` | Phase 2 |
| **5** | Pre-market automation: cron + component update | `api/cron/auto-prefill-premarket.ts`, `src/components/PreMarketInput.tsx` | Phase 2 |
| **6** | Claude prompt integration: futures_context_rules + auto-populated context | `api/_lib/analyze-prompts.ts`, `api/_lib/analyze-context.ts` | Phase 2 |
| **7** | ML features: 28 new features in build-features + utils.py feature groups | `api/cron/build-features.ts`, `ml/src/utils.py` | Phase 3 (needs historical data) |
| **8** | Frontend: Futures panel component | `src/components/futures/` | Phase 2 |
| **9** | Snapshot cron + API endpoint for frontend | `api/cron/fetch-futures-snapshot.ts`, `api/futures/snapshot.ts` | Phase 2 |
| **10** | EOD options cron | `api/cron/fetch-es-options-eod.ts` | Phase 2 |

Phases 1-3 are infrastructure (DB + sidecar + history). Phases 4-10 can be parallelized after the sidecar is live.

---

## Cost Summary

| Item | Cost |
|------|------|
| Databento subscription | $179/month (flat, all symbols) |
| Railway sidecar | ~$5/month (same as current Tradovate sidecar) |
| Twilio alerts | ~$0.02/text × ~5-15 alerts/day ≈ $2-9/month |
| Neon storage increase | Free tier (0.09 → ~0.30 GB, within 0.5 GB limit) |
| **Total** | ~$186-193/month |

---

## Migration Checklist

- [ ] Remove Tradovate env vars from Railway (`TRADOVATE_*`)
- [ ] Add Databento env var to Railway (`DATABENTO_API_KEY`)
- [ ] Add Twilio env vars to Railway (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERT_PHONE_NUMBER`)
- [ ] Run migration to create new tables and migrate `es_bars` → `futures_bars`
- [ ] Deploy new sidecar to Railway
- [ ] Run historical backfill script
- [ ] Deploy Vercel cron jobs
- [ ] Verify pre-market auto-fill on next trading day
- [ ] Verify Claude analysis includes futures context
- [ ] Test alert thresholds and adjust as needed
