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

| Schema | Purpose | Frequency |
|--------|---------|-----------|
| OHLCV-1m | 1-minute bars for all 7 futures + ES options | Real-time streaming via sidecar |
| OHLCV-1h | Pre-aggregated hourly bars for ML features | Derived from 1m bars or requested directly for backfill |
| OHLCV-1d | Daily bars for historical correlation features | Batch pull for backfill |
| Statistics | EOD session summary — OI, settlement, volume | Daily cron post-settlement |
| Definition | Instrument reference — expiration, strike, tick size | On-demand for contract rolls and ES options strike mapping |

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

Subscribe to OHLCV-1m for the 10 nearest put strikes and 10 nearest call strikes around the current ES ATM level. Re-center every 50 pts of ES movement or at session open.

**Purpose**: Detect institutional hedge placement and directional bets in real-time. Heavy put buying at a specific ES strike = institutions positioning for downside. This leads SPX options flow by 10-30 minutes because institutional desks hit ES options first (fastest execution, deepest liquidity).

**EOD**: Pull Statistics schema for all ES option strikes — daily OI by strike gives the "futures-side gamma wall" to compare against the SPX-side gamma walls from Unusual Whales.

---

## Architecture

### Sidecar (Railway) — Databento Rewrite

```
Databento Live TCP Client
  ├── /ES OHLCV-1m bars
  ├── /NQ OHLCV-1m bars
  ├── /VXM front month OHLCV-1m bars
  ├── /VXM second month OHLCV-1m bars
  ├── /ZN OHLCV-1m bars
  ├── /RTY OHLCV-1m bars
  ├── /CL OHLCV-1m bars
  └── ES options (ATM ±10) OHLCV-1m bars
        ↓
  Write to Neon Postgres
  ├── futures_bars (OHLCV per symbol per minute)
  └── futures_options_bars (ES options OHLCV per strike per minute)
        ↓
  Alert Engine (in-sidecar)
  ├── Evaluate alert conditions every minute
  ├── Rate limit: max 1 alert per condition per 30 minutes
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
| `sidecar/src/databento-client.ts` | Databento Live TCP connection, subscription management |
| `sidecar/src/symbol-manager.ts` | Contract roll logic, ES options strike re-centering |
| `sidecar/src/alert-engine.ts` | Evaluate alert conditions, fire Twilio SMS |
| `sidecar/src/alert-config.ts` | Configurable thresholds (or DB-backed for runtime adjustment) |

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

### `futures_options_bars` (new)

```sql
CREATE TABLE IF NOT EXISTS futures_options_bars (
  id BIGSERIAL PRIMARY KEY,
  underlying TEXT NOT NULL,       -- 'ES'
  expiry DATE NOT NULL,           -- Option expiration date
  strike NUMERIC(10,2) NOT NULL,  -- Strike price
  option_type CHAR(1) NOT NULL,   -- 'C' or 'P'
  ts TIMESTAMPTZ NOT NULL,
  open NUMERIC(10,4) NOT NULL,
  high NUMERIC(10,4) NOT NULL,
  low NUMERIC(10,4) NOT NULL,
  close NUMERIC(10,4) NOT NULL,
  volume BIGINT NOT NULL DEFAULT 0,
  UNIQUE(underlying, expiry, strike, option_type, ts)
);
```

### `futures_options_daily` (new — EOD Statistics)

```sql
CREATE TABLE IF NOT EXISTS futures_options_daily (
  id BIGSERIAL PRIMARY KEY,
  underlying TEXT NOT NULL,
  trade_date DATE NOT NULL,
  expiry DATE NOT NULL,
  strike NUMERIC(10,2) NOT NULL,
  option_type CHAR(1) NOT NULL,
  open_interest BIGINT NOT NULL,
  volume BIGINT NOT NULL,
  settlement NUMERIC(10,4),
  UNIQUE(underlying, trade_date, expiry, strike, option_type)
);
```

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
- ES options OI concentrated at a strike with >2x surrounding OI = institutional
  consensus on a price target. Treat like a SPX gamma wall from the futures side.
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
    "es_put_oi_concentration",    # OI at largest put strike / total put OI
    "es_call_oi_concentration",   # OI at largest call strike / total call OI
    "es_options_max_pain_dist",   # Distance from current ES to max pain strike (pts)
    "es_spx_gamma_agreement",     # Do ES and SPX gamma walls agree? (0-1 score)
]
```

**Total: ~28 new features** added to the training_features table.

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
| `es_options_volume` | ES option strike hits ≥5× avg volume in 15 min | 30 min | "📊 ES OPTIONS: 5800P — 15K contracts in 12 min (5.2× avg). Institutional hedge." |

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

Uses Databento's batch/historical API to pull 1 year of data:

| Data | Symbols | Schema | Rows (estimated) |
|------|---------|--------|-------------------|
| Futures bars | ES, NQ, VXM, ZN, RTY, CL | OHLCV-1m | ~1.6M rows (~160 MB) |
| Futures daily | ES, NQ, VXM, ZN, RTY, CL | OHLCV-1d | ~1,500 rows |
| ES options daily OI | All ES option strikes | Statistics | ~500K rows (~50 MB) |

**Total**: ~210 MB. Well within Neon free tier's 0.5 GB limit (currently at 0.09 GB).

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
