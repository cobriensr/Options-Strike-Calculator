# Periscope Lottery Alerts — Implementation Spec

**Date:** 2026-05-19
**Status:** Spec ready for implementation
**Owner:** charles
**Source research:** docs/tmp/forensic-multi-day/ (refine_top5_findings.md through refine_spy_qqq_oos.md)

## What this builds

Two new alert detectors that fire on `periscope_snapshots` events and produce live tickets for the dual-panel UI Charles already mocked. The detectors mirror the existing `detect-lottery-fires` and `detect-silent-boom` architecture but trigger on Periscope MM-attributed gamma/charm events rather than on the WS option_trades stream.

- **Filter I (call lottery)** — buys 0DTE SPXW calls at `event_strike + 50` when MM gamma at an OTM call strike deepens negative and the broader market tape confirms.
- **Filter L (put lottery)** — buys 0DTE SPXW puts at `event_strike − 50` when charm signals deepen at OTM put strikes.

In-sample realized economics (26 days ex-5/18, optimal cells):

| Filter | n/26 | hit ≥150% | hit ≥200% | realR/ticket at TP=5R | max R |
|---|---:|---:|---:|---:|---:|
| **I v3** (gex_dollars<1e9) | 10 | 90% | 50% | +0.80R | 75.25 |
| **I v3-strict** (deep_neg + dist≥15) | 6 | 100% | 50% | +1.00R | 10.50 |
| **I v4** (v3 + QQQ_balance>0) | 6 | 83% | 67% | +2.00R | 75.25 |
| **L v3** (call_ratio<1.5) | 8 | 100% | 100% | +0.50R | 11.99 |
| **L v3 alt** (entry_px≤1.0) | 10 | 90% | 90% | +2.00R | 11.99 |

## Cron architecture

### New files

```
api/_lib/
  periscope-lottery-finder.ts       # Detection logic (mirrors lottery-finder.ts shape)
  periscope-lottery-types.ts        # PeriscopeLotteryFire interface
api/cron/
  detect-periscope-call-lottery.ts  # Filter I detection cron
  detect-periscope-put-lottery.ts   # Filter L detection cron
api/_lib/db-migrations.ts           # Add migration #N for periscope_lottery_fires table
```

### Schedule (vercel.json)

```jsonc
{
  "path": "/api/cron/detect-periscope-call-lottery",
  "schedule": "*/5 13-21 * * 1-5"   // every 5 min during RTH
},
{
  "path": "/api/cron/detect-periscope-put-lottery",
  "schedule": "*/5 13-21 * * 1-5"
}
```

Periscope snapshots arrive on 10-min cadence, so 5-min cron with idempotent `ON CONFLICT` is sufficient. (Tighter polling wouldn't surface new events.)

```jsonc
"api/cron/detect-periscope-call-lottery.ts": { "maxDuration": 30 },
"api/cron/detect-periscope-put-lottery.ts":  { "maxDuration": 30 }
```

## DB schema

### New table: `periscope_lottery_fires`

```sql
-- Migration #172 (applied; see api/_lib/db-migrations.ts:4920+)
CREATE TABLE periscope_lottery_fires (
  id              BIGSERIAL PRIMARY KEY,
  fire_type       TEXT NOT NULL CHECK (fire_type IN ('call_lottery','put_lottery')),
  fire_time       TIMESTAMPTZ NOT NULL,    -- = periscope_snapshots.captured_at
  expiry          DATE NOT NULL,            -- always 0DTE for SPX
  event_strike    INTEGER NOT NULL,
  trade_strike    INTEGER NOT NULL,         -- event_strike ± 50
  spot_at_event   NUMERIC(10,4) NOT NULL,
  strike_dist     NUMERIC(10,4) NOT NULL,
  -- Event greek values
  greek_post      NUMERIC(20,4) NOT NULL,   -- gamma_post (I) or charm_post (L)
  greek_delta     NUMERIC(20,4) NOT NULL,
  greek_lvl_rank  REAL,                     -- per-day percentile (NULL when only 1 candidate this slice)
  greek_chg_rank  REAL,
  -- Discriminator features (snapshotted at fire time)
  gex_dollars     NUMERIC(20,4),
  call_ratio      REAL,
  qqq_net_prem_balance_30m REAL,            -- I only — NULL for L
  entry_px        NUMERIC(10,4),
  vix             NUMERIC(8,2),
  -- Filter pass flags (set TRUE at detection time)
  v3_strict_pass  BOOLEAN NOT NULL DEFAULT FALSE,
  v4_badge        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Outcome (filled by enrich-periscope-lottery-outcomes job, post-EOD)
  peak_px         NUMERIC(10,4),
  peak_pct        NUMERIC(10,4),            -- peak_px / entry_px (user-preferred metric)
  peak_time       TIMESTAMPTZ,
  eod_close_px    NUMERIC(10,4),            -- secondary realized outcome
  realized_r_peak NUMERIC(10,4),            -- (peak - entry) / entry
  realized_r_eod  NUMERIC(10,4),            -- (eod_close - entry) / entry
  outcome_locked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fire_type, fire_time, event_strike)
);

CREATE INDEX periscope_lottery_fires_lookup_idx
  ON periscope_lottery_fires (fire_type, fire_time DESC);
CREATE INDEX periscope_lottery_fires_expiry_idx
  ON periscope_lottery_fires (expiry, fire_type);
-- Partial index for the enrichment cron's unlocked scan:
CREATE INDEX periscope_lottery_fires_unlocked_idx
  ON periscope_lottery_fires (outcome_locked, fire_time)
  WHERE outcome_locked = FALSE;
```

**Per user direction (open question #3): we track BOTH peak R and EOD-close R.** Peak is the user-preferred metric (matches their "peak %" framing); EOD is secondary for realistic-exit estimation. The enrichment cron fills both.

Migration goes into `db-migrations.ts` as the next sequential id.

## Detection logic — Filter I (call lottery)

### Core SQL (per cron tick)

```sql
-- Latest two slices of gamma for today's 0DTE
WITH latest_slot AS (
  SELECT MAX(captured_at) AS captured_at
  FROM periscope_snapshots
  WHERE panel = 'gamma' AND expiry = CURRENT_DATE
),
prior_slot AS (
  SELECT MAX(captured_at) AS captured_at
  FROM periscope_snapshots
  WHERE panel = 'gamma' AND expiry = CURRENT_DATE
    AND captured_at < (SELECT captured_at FROM latest_slot)
),
slices AS (
  SELECT s.captured_at, s.strike, s.value AS gamma_post,
         p.value AS gamma_prior, s.value - p.value AS gamma_delta
  FROM periscope_snapshots s
  JOIN periscope_snapshots p
    ON p.strike = s.strike AND p.expiry = s.expiry
   AND p.panel = s.panel
   AND p.captured_at = (SELECT captured_at FROM prior_slot)
  WHERE s.panel = 'gamma' AND s.expiry = CURRENT_DATE
    AND s.captured_at = (SELECT captured_at FROM latest_slot)
),
day_thresholds AS (
  -- Top-1% per-day filter on |gamma_delta| (stage 1)
  SELECT PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY ABS(value - LAG(value)
           OVER (PARTITION BY strike ORDER BY captured_at))) AS delta_p99
  FROM periscope_snapshots
  WHERE panel = 'gamma' AND expiry = CURRENT_DATE
),
candidates AS (
  -- Apply top-1% filter then top-10% AND rank-within-subset (stage 2)
  SELECT s.*,
         PERCENT_RANK() OVER (ORDER BY ABS(gamma_post)) AS lvl_rank,
         PERCENT_RANK() OVER (ORDER BY ABS(gamma_delta)) AS chg_rank
  FROM slices s
  WHERE ABS(gamma_delta) >= (SELECT delta_p99 FROM day_thresholds)
)
SELECT c.*,
       i.close AS spot_at_event
FROM candidates c
CROSS JOIN LATERAL (
  SELECT close FROM index_candles_1m
  WHERE symbol = 'SPX' AND timestamp <= c.captured_at
  ORDER BY timestamp DESC LIMIT 1
) i
WHERE c.lvl_rank >= 0.90 AND c.chg_rank >= 0.90
  AND c.gamma_post < 0                       -- deep_neg
  AND c.strike > i.close                     -- above-spot
  AND (c.strike - i.close) >= 15             -- strike_dist
```

### Filter cascade in code

```typescript
async function detectCallLottery(slot: Slice): Promise<PeriscopeLotteryFire[]> {
  const candidates = await runCandidateQuery(slot);

  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    // Pull gex_target_features for the event strike
    const gex = await fetchGexTargetFeatures(c.strike, c.captured_at);
    if (!gex || gex.gex_dollars >= 1e9) continue;              // v3 filter

    // Optional v4 confirmation: QQQ net prem balance
    const qqqBalance = await fetchQqqNetPremBalance30m(c.captured_at);
    const v4Confirmed = qqqBalance !== null && qqqBalance > 0;

    // Pull entry premium estimate (first ws_option_trade at trade strike)
    const tradeStrike = c.strike + 50;
    const entry = await fetchEntryPx(tradeStrike, 'call', c.captured_at);
    if (!entry) continue;

    // VIX from latest market_snapshots
    const vix = await fetchLatestVix(c.captured_at);

    fires.push({
      fireType: 'call_lottery',
      fireTime: c.captured_at,
      expiry: today(),
      eventStrike: c.strike,
      tradeStrike,
      spotAtEvent: c.spot_at_event,
      strikeDist: c.strike - c.spot_at_event,
      greekPost: c.gamma_post,
      greekDelta: c.gamma_delta,
      greekLvlRank: c.lvl_rank,
      greekChgRank: c.chg_rank,
      gexDollars: gex.gex_dollars,
      callRatio: gex.call_ratio,
      qqqNetPremBalance30m: qqqBalance,
      entryPx: entry.price,
      vix,
      v4Confirmed,
    });
  }
  return fires;
}
```

## Detection logic — Filter L (put lottery)

### Core SQL

```sql
-- Same shape as I but on 'charm' panel
-- Replace gamma_post/gamma_delta with charm_post/charm_delta
-- Filter conditions:
--   c.charm_post < 0 OR c.charm_post > 0   (no sign filter — both work for L)
--   c.strike < i.close                      (below-spot)
--   (i.close - c.strike) >= 10              (strike_dist)
```

```typescript
async function detectPutLottery(slot: Slice): Promise<PeriscopeLotteryFire[]> {
  const candidates = await runCharmCandidateQuery(slot);

  const fires: PeriscopeLotteryFire[] = [];
  for (const c of candidates) {
    const gex = await fetchGexTargetFeatures(c.strike, c.captured_at);
    // Filter: call_ratio < 1.5 (puts work when not call-dominated)
    if (gex && gex.call_ratio >= 1.5) continue;

    const tradeStrike = c.strike - 50;
    const entry = await fetchEntryPx(tradeStrike, 'put', c.captured_at);
    if (!entry) continue;

    // L variant: entry_px gate is alternative discriminator
    const entryGate = entry.price <= 1.0;

    fires.push({
      fireType: 'put_lottery',
      fireTime: c.captured_at,
      expiry: today(),
      eventStrike: c.strike,
      tradeStrike,
      spotAtEvent: c.spot_at_event,
      strikeDist: c.spot_at_event - c.strike,
      greekPost: c.charm_post,
      greekDelta: c.charm_delta,
      greekLvlRank: c.lvl_rank,
      greekChgRank: c.chg_rank,
      gexDollars: gex?.gex_dollars,
      callRatio: gex?.call_ratio,
      qqqNetPremBalance30m: null,         // not used for L
      entryPx: entry.price,
      vix: await fetchLatestVix(c.captured_at),
      v4Confirmed: entryGate,              // re-used flag for "premium <= $1"
    });
  }
  return fires;
}
```

## Outcome enrichment

Add `api/cron/enrich-periscope-lottery-outcomes.ts` running once at 20:10 UTC (post-RTH) per day. For each fire not yet `outcome_locked`:

```sql
UPDATE periscope_lottery_fires SET
  peak_px = (SELECT MAX(price) FROM ws_option_trades
             WHERE option_chain_id = $occ AND executed_at > fire_time
               AND executed_at <= fire_time + interval '180 minutes'),
  realized_r = (peak_px - entry_px) / entry_px,
  outcome_locked = TRUE
WHERE id = $fire_id;
```

Hold horizons: 120m for `call_lottery`, 180m for `put_lottery` (matching in-sample tuning).

## UI integration

The existing two-panel mockup (call lottery on left, put lottery on right) consumes a single endpoint:

```typescript
// api/periscope-lottery-feed.ts (new)
GET /api/periscope-lottery-feed?date=YYYY-MM-DD&type=call_lottery|put_lottery

Response: {
  fires: Array<{
    fireTime: string;
    eventStrike: number;
    tradeStrike: number;
    spotAtEvent: number;
    strikeDist: number;
    greekPost: number;
    greekDelta: number;
    gexDollars: number;
    callRatio: number;
    qqqNetPremBalance30m: number | null;   // call only
    entryPx: number;
    v4Confirmed: boolean;
    peakPx: number | null;
    peakPct: number | null;
    realizedR: number | null;
  }>;
}
```

Frontend hook `useLotteryAlerts(type)` polls every 30s during market hours (matching existing `useFuturesData` pattern). Cards highlight `v4Confirmed=true` rows with a green badge for the call panel.

## Sizing & risk

Default suggested size in the UI: **1 contract per ticket**. The in-sample max loss on any single ticket is the entry premium (100% loss when option expires OTM). Across both panels combined, ~1 ticket per day. Across a month: ~20 tickets × $20–100 entry = $400–2000 total premium at risk. Per-week realized P&L estimate (in-sample-based): +5R to +15R, i.e., +$100 to +$1500 depending on entry size.

## Testing requirements

Following the project's standard test pattern (mirroring `lottery-finder-endpoint.test.ts`):

- `api/__tests__/detect-periscope-call-lottery.test.ts` — mocks `getDb()` with 5/18 18:43 fixture; asserts that a fire is produced with the expected greek_post/gex_dollars.
- `api/__tests__/detect-periscope-put-lottery.test.ts` — same for the 4/23 15:00 L fixture.
- `api/__tests__/periscope-lottery-feed.test.ts` — asserts the GET handler returns sorted fires.
- `src/__tests__/PeriscopeLotteryPanel.test.tsx` — renders the dual panel with a mock feed.

Each test must include `CRON_SECRET` in `process.env` and use `vi.mocked(getDb).mockResolvedValueOnce(...)` for each SQL call in sequence.

## Open questions (need user input before implementation)

1. **Should QQQ confirmation be a HARD filter or a DISPLAY badge?** In-sample shows the QQQ filter cuts 4 of 10 v3 events but only marginally improves hit rate. Recommend: **badge only**, not a hard filter — preserves the call-lottery candidate pool.
2. **What's the desired ticket size in the UI?** Defaulting to 1 contract per ticket assumes lottery sizing; user may want a configurable multiplier.
3. **Should EOD-close R also be tracked alongside peak R?** In-sample analysis uses peak max, but real exit timing matters. Recommend: track both, surface peak prominently with realized-EOD as secondary.
4. **Should the cron also write to existing `lottery_finder_fires` table or stay in its own `periscope_lottery_fires`?** They're orthogonal triggers (UW WS vs Periscope), so separate table avoids confusion in downstream analysis. Recommend: separate table.

## Caveats reminder

- All filter thresholds derived from 26-day in-sample window (2026-04-13 → 2026-05-18 ex-5/18).
- n=6–10 per filter is small. Hit rates may compress in forward data.
- v4 in-sample improvement is marginal vs v3 — QQQ filter is a "nice-to-have," not load-bearing.
- Naive `gex_strike_0dte` data is NOT a substitute for Periscope MM-attributed data — confirmed in prior analysis.
- 5/18 outlier excluded throughout; 4/23 75x is the next-best non-outlier datapoint.
