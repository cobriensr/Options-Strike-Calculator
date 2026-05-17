---
status: Likely Shipped
date: 2026-05-12
---

# Interval B/A Ask Alert — SPXW (and SPX) 0DTE

**Created:** 2026-05-12
**Trigger event:** 12:05-12:10 CT bucket on SPXW 7360c 0DTE printed **71% Interval B/A** on $1.33M premium; root cause was two back-to-back sweep-lit ASK prints at 12:06:23 ($408K @ 888 + $366K @ 796 = $774K in ~1 second). SPX rallied off that bucket.

## Goal

Real-time broadcast alert whenever an **SPX or SPXW 0DTE option contract's 5-minute Interval Bid/Ask ratio crosses ≥ 70% on the ASK side**, on either calls or puts. Alert payload surfaces the **dominant sweep(s) that drove the ratio** so the user can immediately inspect the per-trade tape.

## Why this signal has edge

SPX/SPXW NBBO is wide (often $0.50–$2.00 on liquid 0DTE strikes) and the public tape is **dominated by mid-fills** because most institutional flow is worked between the quote. A 70%+ ask-side interval is **structurally rare** for SPX/SPXW — it means somebody paid up to lift offers instead of resting. Threshold tuning is per-ticker; 70% is the right floor for SPXW specifically because of this mid-fill baseline. (User-validated heuristic, not a derived statistic — flagged as a candidate for empirical confirmation in Phase 5.)

## Data source

**Primary:** uw-stream `option_trades:SPXW` WS channel (already subscribed per `uw-stream/src/config.py:40`, added 2026-05-07). Per-trade payload includes NBBO snapshot, `size`, `premium`, `price`, `tags[]` containing `ask_side`/`bid_side`/`mid_side`/`floor`/`sweep`/`cross`. Mapping at `uw-stream/src/handlers/option_trades.py:67-69`.

**Corroboration:** `GET /api/option-contract/{OCC}/intraday` returns 1-min buckets with `premium_ask_side` / `premium_bid_side` / `premium_mid_side`. Used as a daily backfill/audit only.

**SPX (non-weekly root):** Not in the lottery universe today. Phase 2 adds it via `_LOTTERY_TICKERS` extension.

## Architecture

```
WS option_trades:SPXW  ──► IntervalBAHandler ──► Neon (interval_ba_alerts)
                              │
                              │   maintains in-memory rolling 5-min state:
                              │     per option_chain:
                              │       deque<(ts, premium, side, tags, size)>
                              │
                              │   on every tick:
                              │     1. append to deque, evict entries > 5min old
                              │     2. recompute ask_premium / total_premium
                              │     3. if ratio ≥ 0.70 AND total_premium ≥ floor
                              │        AND not already-fired-this-bucket:
                              │           emit alert row + Sentry event
                              ▼
                       /api/interval-ba-alerts (REST, polled 10s)
                              │
                              ▼
                  useIntervalBAAlerts ──► AlertBanner + chime + Notification
```

## Phases

### Phase 1 — Backend rolling-aggregate handler (uw-stream)

**Files to create:**

- `uw-stream/src/handlers/interval_ba.py` — new `IntervalBAHandler(Handler)` subclass. Subscribes to `option_trades:SPXW` (and Phase 2: `option_trades:SPX`). Maintains `dict[option_chain, deque[Tick]]` in memory; 5-min sliding window; emits alert when ratio crosses threshold AND total premium ≥ `INTERVAL_BA_PREMIUM_FLOOR` (default $250K, env-configurable). Dedupes by `(option_chain, 5min_bucket_start)` — one alert per contract per bucket.
- `uw-stream/tests/test_interval_ba.py` — fixture-driven tests: (a) ratio crosses threshold, fires; (b) below floor, suppressed; (c) duplicate within same bucket suppressed; (d) eviction past 5 min; (e) put contract path.

**Files to modify:**

- `uw-stream/src/channel_registry.py` — register new handler against `option_trades:SPXW` (in addition to existing OptionTradesHandler, which continues writing raw ticks to `ws_option_trades`).
- `uw-stream/src/config.py` — add `INTERVAL_BA_PREMIUM_FLOOR`, `INTERVAL_BA_RATIO_THRESHOLD` env vars with defaults.
- `uw-stream/src/sentry_setup.py` — N/A (uses existing tags).

**Verification:** `cd uw-stream && pytest tests/test_interval_ba.py -v` passes 5+ cases.

### Phase 2 — DB migration (api/\_lib/db-migrations.ts)

Add migration #N (next free id) creating `interval_ba_alerts`:

```sql
CREATE TABLE interval_ba_alerts (
  id BIGSERIAL PRIMARY KEY,
  option_chain TEXT NOT NULL,         -- OCC: SPXW260512C07360000
  ticker TEXT NOT NULL,                -- 'SPXW' or 'SPX'
  option_type CHAR(1) NOT NULL,        -- 'C' or 'P'
  strike NUMERIC(10,3) NOT NULL,
  expiry DATE NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,   -- 5-min boundary
  bucket_end TIMESTAMPTZ NOT NULL,
  fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ratio_pct NUMERIC(5,2) NOT NULL,     -- 71.23
  ask_premium NUMERIC(14,2) NOT NULL,  -- sum within bucket
  total_premium NUMERIC(14,2) NOT NULL,
  trade_count INTEGER NOT NULL,
  top_trade_premium NUMERIC(14,2),     -- largest single ASK print
  top_trade_size INTEGER,
  top_trade_executed_at TIMESTAMPTZ,
  top_trade_is_sweep BOOLEAN,
  top_trade_is_floor BOOLEAN,
  underlying_price NUMERIC(10,2),      -- SPX spot at fired_at
  acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE(option_chain, bucket_start)
);
CREATE INDEX idx_interval_ba_alerts_fired_at ON interval_ba_alerts(fired_at DESC);
CREATE INDEX idx_interval_ba_alerts_ack ON interval_ba_alerts(acknowledged, fired_at DESC) WHERE acknowledged = FALSE;
```

**Verification:** Update `api/__tests__/db.test.ts` with the new id + expected SQL call count. `npm run test:run -- db.test` passes.

### Phase 3 — REST endpoint + frontend hook

**Files to create:**

- `api/interval-ba-alerts.ts` — GET endpoint, owner-or-guest gated (`guardOwnerOrGuestEndpoint`), `?since=ISO` incremental param, returns max 20 unacknowledged rows. Add to `protect` array in `src/main.tsx` `initBotId()` call.
- `api/interval-ba-alerts-ack.ts` — POST endpoint to acknowledge by `id`, stops chime repeats.
- `src/hooks/useIntervalBAAlerts.ts` — mirror of `useAlertPolling.ts`. 10s poll during `marketOpen`, dedupe via `seenIdsRef`, fires chime + browser notification on new rows. Severity = `'extreme'` if `total_premium ≥ $1M`, `'critical'` if `≥ $500K`, else `'warning'`.

**Files to modify:**

- `src/main.tsx` — add `/api/interval-ba-alerts` to botid `protect` array.
- `src/App.tsx` — wire `useIntervalBAAlerts()` and pipe results into existing `<AlertBanner>` (alongside `useAlertPolling`).

**Verification:** `curl -s http://localhost:3000/api/interval-ba-alerts | jq` returns `{ alerts: [] }` shape; `npm run review` clean.

### Phase 4 — Audio cue + Web Push background

**Files to modify:**

- `src/utils/anomaly-sound.ts` — add `playSweepAlarm()` — distinctive 3-tone urgent pattern (E5→A5→C6, faster/louder than existing chimes). Hook calls this on every new alert.
- `src/sw.ts` — add `self.addEventListener('push', e => ...)` to handle background pushes; show `Notification` from SW context. (Currently no push handler exists per the infra map — this is the only net-new SW code.)
- `api/interval-ba-alerts.ts` — when emitting (i.e., handler write path triggers a Web Push fan-out): out of scope for v1. v1 relies on in-app polling only; v2 adds VAPID push.

**Verification (v1):** Open the app during RTH, watch for an alert during normal flow; chime + banner + Notification appear. The push handler ships but stays dormant until v2.

### Phase 5 — Empirical threshold tuning (post-soak)

After 7-10 days of alerts, run a query (one-off `scripts/analyze-interval-ba-edge.mjs`):

- Distribution of ratios across all SPXW 0DTE contracts during RTH
- Per-decile forward 5/15/30-min underlying move
- Sweep-count correlation
- Confirm 70% threshold sits in the right percentile (likely 95th+) and the floor of $250K isn't filtering too aggressively

**Verification:** Output report saved to `docs/tmp/interval-ba-edge-report.md`; threshold/floor adjusted if data warrants.

## Open questions

| Q                                                         | Default                                                                                        | Where it's settled                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- |
| Premium floor per alert?                                  | **$250K** (filters retail noise; the validating event was $1.33M so safely above)              | Phase 1 env var, Phase 5 empirical |
| 0DTE only or all SPX/SPXW expiries?                       | **0DTE only** in v1 (per `feedback_periscope_0dte_only`); handler filters `expiry == today_ct` | Phase 1 transform                  |
| Fire on calls AND puts?                                   | **Yes both** — but distinct chime tones (call = bullish tone, put = bearish tone)              | Phase 4 audio                      |
| SPX (non-weekly) included?                                | **No in v1**, add in v2 — SPXW covers the 0DTE chain user trades                               | Phase 2 channel reg                |
| Bid-side (≤30% ask = bearish conviction) symmetric alert? | **No in v1** — user spec is ask-side only                                                      | —                                  |
| Web Push fan-out?                                         | **No in v1** — in-app poll only; push handler ships dormant                                    | Phase 4                            |
| Guest access?                                             | **Yes** — same `guardOwnerOrGuestEndpoint` as `/api/alerts`                                    | Phase 3                            |

## Thresholds / constants

```
INTERVAL_BA_RATIO_THRESHOLD = 0.70    # 70% ask-side
INTERVAL_BA_PREMIUM_FLOOR   = 250_000 # USD
INTERVAL_BA_WINDOW_SEC      = 300     # 5-min rolling
INTERVAL_BA_DEDUPE_KEY      = (option_chain, floor(ts / 5min))
```

## Out of scope (v1)

- SPX (non-weekly root)
- Bid-side mirror alert
- VAPID web push fan-out
- Backfill/historical scan via `/api/option-contract/{OCC}/intraday`
- Per-strike historical context in alert payload (yesterday's same-strike ratio comparison)
- ML scoring of which alerts had highest forward edge (Phase 5 may inform a future v2)

## Files touched (final tally)

**New (8):**

- `uw-stream/src/handlers/interval_ba.py`
- `uw-stream/tests/test_interval_ba.py`
- `uw-stream/tests/fixtures/interval_ba_sample.json`
- `api/interval-ba-alerts.ts`
- `api/interval-ba-alerts-ack.ts`
- `src/hooks/useIntervalBAAlerts.ts`
- `api/__tests__/interval-ba-alerts.test.ts`
- `scripts/analyze-interval-ba-edge.mjs` (Phase 5)

**Modified (7):**

- `uw-stream/src/channel_registry.py`
- `uw-stream/src/config.py`
- `api/_lib/db-migrations.ts`
- `api/__tests__/db.test.ts`
- `src/main.tsx`
- `src/App.tsx`
- `src/utils/anomaly-sound.ts`
- `src/sw.ts`
