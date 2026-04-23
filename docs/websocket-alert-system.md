# Real-Time Burst Alert System — Design Doc

**Status:** Specification only. Not yet implemented.
**Author:** Charles, with Claude
**Date:** 2026-04-23
**Depends on findings in:** `ml/src/eod_flow_*.py`, `ml/plots/eod-flow-*/`

## Table of contents

- [Overview](#overview)
- [Research findings this system encodes](#research-findings-this-system-encodes)
- [Design principles](#design-principles)
- [Architecture](#architecture)
- [Components](#components)
- [Alert payload schema](#alert-payload-schema)
- [Deployment](#deployment)
- [Persistence schema](#persistence-schema)
- [Cost, latency, and observability](#cost-latency-and-observability)
- [Rule lifecycle](#rule-lifecycle)
- [Build order](#build-order)
- [Known risks and mitigations](#known-risks-and-mitigations)
- [Open design questions](#open-design-questions)
- [Summary one-pager](#summary-one-pager)

## Overview

Consume the Unusual Whales [`option_trades` WebSocket](https://api.unusualwhales.com/api/socket/option_trades) in real time, detect premium bursts matching validated signal cells (0.3-1% OTM, mixed flow, ≥$100k premium in a 5-min window), and dispatch actionable alerts within seconds of bucket completion. Each alert carries the historical expected touch rate / MFE / MAE for its cell so the trader can size the trade.

## Research findings this system encodes

The system's rules are derived directly from empirical analysis on 8 days of EOD flow data (2026-04-13 through 2026-04-22, 18.8M 0DTE prints on SPY/QQQ/SPXW). See `ml/findings.json` and `ml/plots/eod-flow-*/` for supporting numbers.

| Finding                                                                                                                | Source script                   | Design implication                                                                           |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| **Signal lives only in 0.3-1% OTM band.** Touch rate drops to 0% at 1%+ OTM at any premium level.                      | `eod_flow_premium_threshold.py` | Hard filter at distance 0.3-1% in upstream WebSocket handler.                                |
| **Touch rate monotonic with premium** at tight distances. Doubles from 23% (baseline) to 45% (QQQ 0.3-0.5% at $100k+). | `eod_flow_premium_threshold.py` | Premium threshold ≥$100k becomes core trigger criterion.                                     |
| **Mixed flow beats one-sided flow.** QQQ 0.3-0.5% calls: mixed=45%, buy-dom=35%, sell-dom=31%.                         | `eod_flow_decomp.py`            | `buy_premium_pct` gate: `0.40 ≤ x ≤ 0.60`.                                                   |
| **QQQ strongest, SPY/SPXW ~half the effect, NDXP too thin**                                                            | `eod_flow_premium_threshold.py` | Per-ticker rule config; NDXP not subscribed.                                                 |
| **Gamma-weighted threshold is no better than dollar-weighted** in signal band.                                         | `eod_flow_decomp.py`            | Use `total_premium` (dollars), not gamma notional.                                           |
| **Effect decays past 30-60 min.** MFE and MAE peak within 60 min of bucket end.                                        | `eod_flow_forward_returns.py`   | Observation window in outcome tracking caps at 120 min; trade horizon guidance is 15-60 min. |
| **MFE ≈ MAE on median.** Typical outcome is 17 bps toward vs 19 bps against.                                           | `eod_flow_forward_returns.py`   | Alert payload must include MAE so trader knows drawdown budget.                              |
| **Leave-one-out stable** — 53% of signal cells robust (LOO range <5pp), 99% at least moderate.                         | `eod_flow_stability.py`         | Signal not driven by 1-2 lucky days; safe to trade.                                          |

## Design principles

| Principle                                     | Why                                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **Filter aggressively upstream**              | 85% of UW trades are not in our signal band. Don't buffer what you'll discard.               |
| **5-min bucket is the unit of decision**      | Signal lives here. 1-min is too noisy for alerts.                                            |
| **Fire at `bucket_end`, not mid-bucket**      | The signal is the fully-accumulated 5-min premium, not partial.                              |
| **Dedup aggressively**                        | Same strike / adjacent time windows = same event. Don't spam.                                |
| **Include historical context in every alert** | User needs expected touch rate / MFE / MAE to size the trade.                                |
| **Persist everything to Neon**                | Every alert becomes a labeled training example for the next data refresh.                    |
| **Config > code for rules**                   | Thresholds evolve as more data arrives. Deploy rule changes without redeploying the service. |

## Architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Railway Python service (always-on during RTH)                    │
│                                                                  │
│  UW WebSocket ── Upstream filter ── Bucket aggregator           │
│   │              │ 0DTE              │ in-memory                 │
│   │              │ OTM                │ sliding 5-min windows    │
│   │              │ 0.3-1.0% dist     │ keyed by contract        │
│   │              ▼                    ▼                           │
│   │         Drop & continue     Trigger evaluator                 │
│   │                                   │                           │
│   │                                   ▼                           │
│   │                             Alert dispatcher                  │
│   │                             ├── Pushover (iOS)                │
│   │                             ├── Discord webhook               │
│   │                             └── Neon logging                  │
│   └─► Reconnect on disconnect (exponential backoff)              │
└──────────────────────────────────────────────────────────────────┘

                  ▲                                    ▲
                  │                                    │
            Market-hours          Historical           │
            RTH gate              touch-rate           │
            (08:30-15:00 CT,      lookup table        │
             weekdays only)       (from research      │
                                   artifacts)         │
                                                       │
                                          Daily outcome-tracking
                                          cron: join alerts vs
                                          actual spot path → fills
                                          burst_alert_outcomes table
```

## Components

### 1. WebSocket client (`ws_client.py`)

- Connect to `wss://api.unusualwhales.com/socket?token=${UW_API_KEY}`
- Subscribe to per-ticker channels (smaller packet volume than firehose):
  - `option_trades:QQQ`
  - `option_trades:SPY`
  - `option_trades:SPXW`
- **Per-ticker rationale**: the firehose `option_trades` channel includes every equity option — ~10× more traffic, 90% of which would be filtered out anyway.
- Auto-reconnect on disconnect with exponential backoff (start 1s, cap 60s).
- Heartbeat monitor: if no messages received for 60s during RTH, force reconnect.
- Wrap the receive loop in a single asyncio task; publish validated trades to an internal asyncio.Queue for downstream consumers.

### 2. Upstream filter

For each incoming trade, drop immediately unless it matches our signal band:

```python
# Trade-condition codes that carry directional signal. Everything
# else is multi-leg spread legs, floor blocks, or stock-proxy ITM
# trades — informative in other ways but not directional alerts.
SINGLE_LEG_CONDS = {"auto", "slan"}

# Codes to explicitly exclude (and optionally route to a separate
# "institutional block detected" alert class, see Component 8).
MULTILEG_CONDS = {"mlet", "mlat", "mfsl", "cbmo", "slft", "late"}

def keep_trade(msg: dict, today: date) -> bool:
    # 0DTE only
    if msg["expiry"] != today.isoformat():
        return False
    # Drop cancelled prints — not in our training distribution.
    if msg.get("canceled"):
        return False
    # Regular session only — matches EOD CSV filters used for training.
    ct_hhmm = to_ct_hhmm(msg["executed_at"])
    if not (830 <= ct_hhmm <= 1500):
        return False
    # Single-leg only. `mlet`/`mlat`/`mfsl`/`cbmo` are spread-leg
    # reports; their "buy-side aggression" is an artifact of how
    # multi-leg trades decompose. Validated via
    # ml/src/eod_flow_singles_only.py: filtering to auto/slan
    # adds +2.3pp touch rate at the QQQ 0.3-0.5% × $100k cell.
    cond = msg.get("trade_code", "").lower()
    if cond not in SINGLE_LEG_CONDS:
        return False
    # Drop deep-ITM synthetic-stock proxies. |delta| > 0.90 means the
    # option is effectively stock; its "burst" carries no directional
    # signal. Source: raw-flow analysis in docs/0dte-findings.md
    # Finding 7.
    delta = float(msg.get("delta", 0))
    if abs(delta) > 0.90:
        return False
    # OTM only
    strike = float(msg["strike"])
    spot = float(msg["underlying_price"])
    if msg["option_type"] == "call" and strike <= spot:
        return False  # ITM call
    if msg["option_type"] == "put" and strike >= spot:
        return False  # ITM put
    # Distance band 0.3-1.0% — outside this, touch rate is 0%.
    mny = abs(strike - spot) / spot
    return 0.003 <= mny <= 0.010
```

This filter discards ~96% of incoming messages before they hit the bucket store (the 1-pp increase from the original 95% comes from adding the multi-leg + deep-ITM exclusions, which remove ~26% of the remaining candidates).

**Why these extra filters matter** (from `docs/0dte-findings.md`):

- **Single-leg filter**: Multi-leg conditions (`mlet`/`mlat`/`mfsl`/`cbmo`) represent ~35% of 0DTE premium but are spread legs where the per-leg "buy" or "sell" is artifactual — a buy on one leg is paired with a sell on another. Filtering them out gives +2.3pp touch rate at the headline cell and ~25% fewer false-positive alerts.
- **Deep-ITM filter**: Recurring deep-ITM call blocks (strikes 5000-6300 when SPX is 7100) are synthetic-stock positions, not directional bets. These clutter any aggression-based metric without predicting anything.
- **`mfsl` institutional blocks deserve their own alert stream** — they carry information (institutional ceiling/floor markers) but aren't our 0DTE directional signal. See Component 8 below.

### 3. Bucket aggregator (`burst_engine.py`)

**State**: in-memory dict keyed by `(symbol, option_chain_id, bucket_start_5min)`.

```python
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class BucketState:
    symbol: str
    option_chain_id: str
    strike: float
    option_type: str        # 'call' or 'put'
    bucket_start: datetime  # UTC
    bucket_end: datetime    # = bucket_start + 5min
    first_spot: float       # underlying_price at first print
    last_spot: float        # updated on each print
    n_prints: int = 0
    total_premium: float = 0.0
    buy_premium: float = 0.0   # trades tagged 'ask_side'
    sell_premium: float = 0.0  # trades tagged 'bid_side'
    mid_premium: float = 0.0   # neither
    total_size: int = 0
    gamma_shares_accum: float = 0.0  # Σ(gamma × size × 100)
    fired: bool = False        # trigger-once flag
```

On each kept trade:

1. Compute `bucket_start = floor(executed_at, 5 minutes)`.
2. Look up or create the `BucketState`.
3. Accumulate all fields.
4. Classify aggression from UW's `tags` array:
   - `"ask_side"` → buy-aggressive (increments `buy_premium`)
   - `"bid_side"` → sell-aggressive (increments `sell_premium`)
   - neither → mid (increments `mid_premium`)
5. Call `check_triggers(bucket_state)`.
6. Evict buckets whose `bucket_end < now() - 10 minutes` — they cannot fire anymore and keeping them wastes memory.

**IMPORTANT — aggression mapping validation**: Our training data derived `aggression_side` from the `side` column in the EOD CSV (`ask`/`bid`). UW's live `tags` field uses strings like `ask_side`/`bid_side`. Before going live, run a 1-day side-by-side: stream UW live data → bucket pipeline vs the EOD CSV from the same day. Aggression splits should match within sampling noise. If they don't, `side` and `tags` are populated differently and we need to remap.

### 4. Trigger evaluator

Rules are defined as config (see [Rule lifecycle](#rule-lifecycle)). Evaluator skeleton:

```python
def check_triggers(bucket: BucketState, rules: list[Rule]) -> Alert | None:
    # Only fire once the 5-min window has closed.
    if now() < bucket.bucket_end:
        return None
    if bucket.fired:
        return None

    for rule in rules:
        if bucket.symbol not in rule.symbols:
            continue
        mny = abs(bucket.strike - bucket.last_spot) / bucket.last_spot
        if not (rule.distance_pct_min <= mny <= rule.distance_pct_max):
            continue
        if bucket.total_premium < rule.min_premium_usd:
            continue
        if bucket.option_type not in rule.option_types:
            continue
        buy_pct = bucket.buy_premium / max(bucket.total_premium, 1e-9)
        if not (rule.buy_pct_min <= buy_pct <= rule.buy_pct_max):
            continue
        # Dedup: query Neon for recent alerts on same strike.
        if recently_fired(bucket, cooldown_min=15):
            continue

        bucket.fired = True
        return build_alert(bucket, rule)
    return None
```

### 5. Dedup and cooldown

Before firing any alert, query `burst_alerts` table in Neon:

- **Same strike cooldown**: no alert for the same `(symbol, strike, option_type)` within 15 minutes.
- **Cross-rule dedup**: if QQQ 500C already fired on the primary rule, don't also fire on the secondary rule for an adjacent 5-min bucket.
- **Moneyness-bucket cooldown** (optional v2): no alert for the same `(symbol, moneyness_bucket)` within 15 minutes to prevent 500C → 501C double-fire as spot drifts.

### 6. Alert dispatcher (`alert_dispatch.py`)

Three channels in parallel:

- **Discord webhook** — instant notification with a rich embed containing the full payload. Primary UX during market hours (visible on desktop and phone).
- **Pushover** (or APNs) — short push notification: `"QQQ 500C burst — 45% expected touch, $287k premium"`.
- **Neon log** — persist the full payload to `burst_alerts` for outcome tracking.

All dispatches are non-blocking (`asyncio.create_task`) so a slow webhook doesn't delay the next trigger evaluation.

### 7. Outcome tracker (`outcome_cron.py`)

Runs once daily at ~15:30 CT (after close) via Vercel cron or Railway scheduled job:

1. Query `burst_alerts` for today's alerts.
2. For each alert, load minute-level spot series for the symbol for `[bucket_end, bucket_end + 120 min]` (capped at session close).
3. Compute:
   - `touched_strike` — did minute high/low cross the strike in the toward-strike direction?
   - `minutes_to_touch` — time to first touch
   - `peak_toward_bps` (MFE), `peak_against_bps` (MAE)
   - `end_of_window_ret_bps`
4. Insert into `burst_alert_outcomes`.

This creates a feedback loop: every day you see live hit rate vs expected touch rate, per rule. Rules that systematically underperform get retired.

## Alert payload schema

Every alert produces a JSON payload in this shape, stored in `burst_alerts.payload_json` and embedded in Discord/Pushover messages:

```json
{
  "alert_id": "qqq_500c_20260423_1305",
  "fired_at": "2026-04-23T18:05:03Z",
  "rule_id": "qqq_mixed_3_5",
  "rule_version": "v1",

  "symbol": "QQQ",
  "strike": 500.0,
  "option_type": "call",
  "option_chain_id": "QQQ260423C00500000",
  "expiry": "2026-04-23",

  "bucket_start": "2026-04-23T18:00:00Z",
  "bucket_end": "2026-04-23T18:05:00Z",
  "spot_at_bucket_end": 498.32,
  "distance_to_strike_bps": 33.7,

  "burst": {
    "n_prints": 892,
    "total_premium_usd": 287450,
    "buy_premium_pct": 0.52,
    "mixed_regime": true,
    "gamma_notional_per_pct_usd": 14200000
  },

  "historical_expectation": {
    "touch_pct": 45.2,
    "median_minutes_to_touch": 55,
    "median_mfe_bps": 19.0,
    "median_mae_bps": 18.0,
    "loo_range_pp": 8.0,
    "verdict": "moderate",
    "sample_size_in_cell": 466
  },

  "trade_ideas": [
    {
      "type": "debit_spread",
      "direction": "long_call",
      "buy_strike": 500.0,
      "sell_strike": 502.0,
      "rationale": "Capped risk; profits if spot touches 500 within 60m. Cost should be ≤40% of width given 45% expected touch."
    }
  ],

  "market_context": {
    "ct_time": "13:05:03",
    "minutes_to_close": 115,
    "vix_spot": 15.2,
    "same_strike_fired_today": false
  }
}
```

## Deployment

### Railway service

- New project: `strike-calculator-alerts`.
- **Not scale-to-zero** — WebSocket needs persistent connection during RTH. Use Railway's hobby tier (~$5/mo) or a 0.5 CPU instance (~$15/mo).
- **Market-hours handling**: service runs 24/7 with an internal RTH gate (`now().weekday() < 5 and 830 <= ct_hhmm <= 1500`). Outside that window, the WebSocket disconnects and triggers are skipped. Simpler than cron-based start/stop; costs only a few dollars more.
- **Python 3.13+** matching `ml/.venv`. Dependencies: `websockets`, `httpx`, `psycopg2-binary`, `sentry-sdk`, `python-dotenv`, `pyyaml`.

### Repo layout

```
alerts/                       # New top-level folder
  src/
    main.py                   # Entry point + asyncio event loop
    ws_client.py              # UW WebSocket connection + reconnect
    burst_engine.py           # Bucket state + trigger evaluator
    alert_dispatch.py         # Discord + Pushover + Neon dispatchers
    persistence.py            # Neon connection, inserts, cooldown queries
    outcome_cron.py           # Daily outcome-tracking job
    config.py                 # Rule loader, env var access
  rules/
    v1.yaml                   # Initial rule set (see below)
  requirements.txt
  Dockerfile
  railway.json
  tests/
    test_burst_engine.py
    test_filter.py
    test_dispatch.py
```

### Env vars (new, alongside existing)

| Variable                    | Source   | Purpose                                         |
| --------------------------- | -------- | ----------------------------------------------- |
| `UW_API_KEY`                | existing | WebSocket auth                                  |
| `DATABASE_URL`              | existing | Neon connection                                 |
| `SENTRY_DSN`                | existing | Error tracking                                  |
| `ALERT_DISCORD_WEBHOOK_URL` | new      | Alert channel                                   |
| `PUSHOVER_USER_KEY`         | new      | Push notifications                              |
| `PUSHOVER_APP_TOKEN`        | new      | Push notifications                              |
| `RULE_CONFIG_VERSION`       | new      | Which `rules/vN.yaml` to load (default: latest) |

## Persistence schema

Add two new Neon tables (via a new migration in `api/_lib/db-migrations.ts`):

```sql
CREATE TABLE burst_alerts (
  alert_id TEXT PRIMARY KEY,
  fired_at TIMESTAMPTZ NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strike DOUBLE PRECISION NOT NULL,
  option_type TEXT NOT NULL,
  option_chain_id TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  bucket_end TIMESTAMPTZ NOT NULL,
  spot_at_bucket_end DOUBLE PRECISION NOT NULL,
  distance_to_strike_bps DOUBLE PRECISION NOT NULL,
  n_prints INTEGER NOT NULL,
  total_premium_usd DOUBLE PRECISION NOT NULL,
  buy_premium_pct DOUBLE PRECISION NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX idx_burst_alerts_symbol_time ON burst_alerts (symbol, fired_at DESC);
CREATE INDEX idx_burst_alerts_dedup ON burst_alerts (symbol, strike, option_type, fired_at DESC);

CREATE TABLE burst_alert_outcomes (
  alert_id TEXT PRIMARY KEY REFERENCES burst_alerts(alert_id),
  touched_strike BOOLEAN,
  minutes_to_touch DOUBLE PRECISION,
  peak_toward_bps DOUBLE PRECISION,
  peak_against_bps DOUBLE PRECISION,
  end_of_window_ret_bps DOUBLE PRECISION,
  window_end TIMESTAMPTZ,
  computed_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Cost, latency, and observability

| Metric                                       | Target                                           |
| -------------------------------------------- | ------------------------------------------------ |
| Time from trade event to bucket state update | < 50 ms                                          |
| Time from bucket_end to alert dispatch       | < 3 s                                            |
| Memory usage                                 | < 256 MB (a few thousand active buckets at peak) |
| Monthly compute cost                         | Railway $5-15                                    |
| Additional data cost                         | UW Advanced plan (WebSocket access)              |

Instrumentation:

- **Sentry** for errors (`sentry-sdk`, matching the sidecar wiring).
- **Heartbeat metric** every 60s to an uptime service (UptimeRobot or BetterUptime): `"alive, {n_buckets_active} buckets, {trades_per_sec} tps"`.
- **Structured logs** via `pino`-equivalent (use `structlog` for Python): one log line per alert, one per minute aggregate stats.
- **Daily summary** cron — one line in Discord at close: `"Today: 12 alerts fired, 3 touched, $X paper P&L if spreads were bought at theoretical prices."`

## Rule lifecycle

Rules are YAML config, not code:

```yaml
# alerts/rules/v1.yaml
version: v1
effective_from: 2026-04-23
source_backtest: eod_flow_decomp.py @ git SHA abcdef
cooldown_minutes: 15

rules:
  - id: qqq_mixed_3_5_calls
    description: |
      QQQ 0DTE OTM calls, 0.3-0.5% above spot, mixed aggression,
      total premium ≥ $100k in 5-min window. Highest-touch-rate cell
      observed (45.2% in 8-day sample).
    symbols: [QQQ]
    option_types: [call]
    distance_pct_min: 0.003
    distance_pct_max: 0.005
    min_premium_usd: 100000
    buy_pct_min: 0.40
    buy_pct_max: 0.60
    expected_touch_pct: 45.2
    expected_mfe_bps: 19.0
    expected_mae_bps: 18.0
    expected_minutes_to_touch: 55
    loo_range_pp: 8.0

  - id: qqq_any_5_10
    description: |
      QQQ 0DTE OTM (either side), 0.5-1.0% distance, any aggression,
      ≥ $100k. Most stable LOO-robust cell. Smaller lift but reliable.
    symbols: [QQQ]
    option_types: [call, put]
    distance_pct_min: 0.005
    distance_pct_max: 0.010
    min_premium_usd: 100000
    buy_pct_min: 0.0
    buy_pct_max: 1.0
    expected_touch_pct: 13.4
    expected_mfe_bps: 17.0
    expected_mae_bps: 19.0
    expected_minutes_to_touch: 65
    loo_range_pp: 3.2

  - id: spy_mixed_3_5_calls
    description: QQQ-equivalent rule on SPY. Weaker lift but useful diversification.
    symbols: [SPY]
    option_types: [call]
    distance_pct_min: 0.003
    distance_pct_max: 0.005
    min_premium_usd: 100000
    buy_pct_min: 0.40
    buy_pct_max: 0.60
    expected_touch_pct: 21.3
    expected_mfe_bps: 16.0
    expected_mae_bps: 16.0
    expected_minutes_to_touch: 55
    loo_range_pp: 5.8

  - id: spxw_mixed_3_5_calls
    description: SPXW 0DTE version.
    symbols: [SPXW]
    option_types: [call]
    distance_pct_min: 0.003
    distance_pct_max: 0.005
    min_premium_usd: 100000
    buy_pct_min: 0.40
    buy_pct_max: 0.60
    expected_touch_pct: 17.1
    expected_mfe_bps: 15.0
    expected_mae_bps: 15.0
    expected_minutes_to_touch: 60
    loo_range_pp: 5.9
```

**Update flow** (whenever a new batch of data lands):

1. Rerun `eod_flow_decomp.py` on the expanded dataset.
2. Recompute expected outcomes per rule.
3. Bump config version to v2, deploy to Railway.
4. Old alerts reference their own `rule_version` in the payload — never retroactive.
5. `burst_alerts` table retains the rule_version of each alert so you can compare performance across rule iterations.

## Build order

**Phase 1 — Core loop (console only, no dispatch)**

- WebSocket client with reconnect logic
- Upstream filter
- Bucket aggregator
- Trigger evaluator with rule loader
- Console logging of every triggered bucket
- **Goal**: validate by watching live triggers match the patterns from backtest. Running for 3-5 sessions should produce ~10-20 triggers across rules.

**Phase 2 — Neon persistence**

- Migration for `burst_alerts` + `burst_alert_outcomes`
- Dedup / cooldown queries
- Insert on every fire
- **Goal**: build up a labeled dataset of real triggers for later analysis.

**Phase 3 — Dispatch**

- Discord webhook (easiest to eyeball; mobile-native with rich embeds)
- Pushover push notifications (lock-screen alerts)
- Error handling + Sentry
- **Goal**: alerts land on your phone within 3 seconds of `bucket_end`.

**Phase 4 — Outcome tracking**

- `outcome_cron.py` scheduled to run ~15:30 CT daily
- Populates `burst_alert_outcomes`
- Daily summary message to Discord: "5 alerts fired, 2 touched (40% vs 45% expected)"
- **Goal**: live feedback loop on rule performance; early warning of signal decay.

**Phase 5 — Operational hardening**

- Heartbeat monitoring
- RTH gate
- Deploy to Railway
- Rule config versioning
- **Goal**: unattended reliability during market hours.

**Phase 6 — Tune**

- After 2-3 weeks of live data, compare live hit rate vs expected.
- Retire rules that systematically miss (live < 0.5 × expected over 20+ alerts).
- Promote rules that outperform (tighten thresholds to reduce false positives).

## Known risks and mitigations

| Risk                                                               | Mitigation                                                                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **UW `tags` classification may not match our EOD `side` labeling** | Before going live, run 1-day side-by-side: UW live data → bucket pipeline vs same-day EOD CSV. Aggression splits per bucket should match within sampling noise. |
| **Signal decay over time**                                         | Outcome-tracking cron measures live hit rate. Kill-criterion: rule dropped to <50% of its expected touch rate over 20+ alerts → retire.                         |
| **WebSocket drops near critical bursts**                           | Heartbeat monitoring + Sentry alerts on reconnect. Accept occasional misses; the signal isn't time-sensitive below 30s.                                         |
| **UW API rate limits during high-vol events**                      | Per-ticker streams have been reliable in practice. Monitor `ws_errors` metric; fall back to per-minute REST polling if streaming fails for >60s.                |
| **"Expected touch rate 45%" becomes psychological crutch**         | Every alert shows the LOO range (±8 pp), not just the point estimate. Payload includes sample size in cell.                                                     |
| **Thin liquidity on chosen strikes**                               | 0DTE SPXW 0.3-1% OTM is liquid enough for retail-scale sizing. Start small. Capacity drops fast past 50-100 contracts.                                          |
| **FOMC / earnings days flood all rules**                           | Add `vix_change_today > 3pts` suppression flag to rules. Also suppress for 30 min before and after scheduled macro events (wired to a calendar check).          |
| **Missed dedup under WebSocket message reordering**                | Use both in-memory `fired` flag AND Neon cooldown query. Both must agree before firing. Accept slight over-suppression.                                         |

## Open design questions

1. **Adjacent-strike grouping for dedup.** If QQQ 500C fires at 13:05 and QQQ 501C looks hot at 13:08, is that one event or two? **Current recommendation:** 15-min cooldown per `(symbol, moneyness_bucket)` where bucket is 0.3-0.5% or 0.5-1%.

2. **Urgent tier that bypasses dedup.** If premium ≥ $2M (99.5th percentile of sample), fire even if the same strike alerted 10 min ago. **Not in v1** — revisit after 2 weeks of data.

3. **IV-regime gating.** FOMC days may trigger every rule. Solution: gate on same-day VIX change. If VIX up > 3 points pre-alert, suppress (flow is noise, not signal). **Not in v1** — revisit.

4. **Graduating to ITM alerts.** Explicitly excluded from signal pool based on training data. **Never in v1.** Revisit only if a month of fresh data surfaces something new.

5. **Absolute vs relative premium thresholds.** Fixed $100k → QQQ fires often, SPXW rarely. Alternative: "2× this symbol's trailing-20-day average 5-min max premium". **Deferred to v2** — requires more per-symbol calibration data.

6. **Automatic trade execution.** Currently alerts are informational. Eventual goal might be one-click execution via broker API. **Not in scope here.** Would need: broker integration, position sizing rules, stop-loss automation, kill switch.

7. **Hit-rate–dependent rule activation.** Rule only alerts if its trailing-20-day live hit rate ≥ 50% of expected. Automatic retirement. **Good v2 feature** — requires 20+ alerts per rule first (so ~1-2 months of live data).

## Summary one-pager

> **Real-time WebSocket consumer on Railway** filters UW trades to 0DTE + OTM + 0.3-1% distance, accumulates into 5-min buckets per `(symbol, strike)`, and fires alerts when total premium ≥ $100k AND (mixed flow OR moderate-OTM criteria) on QQQ/SPY/SPXW. Each alert includes historical expected touch rate (~45% for QQQ mixed calls, ~13-21% for other cells), MFE/MAE, and a suggested debit spread. Daily cron compares alerts vs actual spot outcomes in Neon to self-police rule performance. Build cost: ~1-2 weeks of engineering. Ongoing cost: ~$5-15/mo Railway plus UW Advanced plan.
