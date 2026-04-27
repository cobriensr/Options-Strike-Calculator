# Dir Vega Spike Monitor (SPY + QQQ)

## Goal

Detect and alert on massive intraday `dir_vega_flow` outliers in SPY and QQQ
— the kind of single-minute spikes that dwarf the day's noise floor (e.g.
SPY +5.6M while baseline is ±200k) and frequently lead price by minutes.
Persist all minute-bar greek-flow data for backfill + EDA + future ML, and
surface qualifying spikes in the frontend with forward-return context.

## Motivation

The 2026-04-27 session's UW dashboard observation: a single +5.6M `dir_vega_flow`
print on SPY at 12:00 PM CT preceded a sustained ramp; concurrent +500k QQQ
spikes did the same. These are dealer-net-short-vega events — when traders
buy that much directional vega in 60 seconds, dealers must dynamically hedge
by buying delta (futures/shares), and price tends to follow.

UW's chart shows the noise; the _signal_ is the ~28× outlier. UW does not
expose `dir_vega_flow` as an alert primitive (`/api/alerts/configuration`
covers Market Tide, GEX/VEX/CEX, flow alerts, etc. — not vega flow). So we
build it ourselves and earn three benefits UW can't provide:

1. **Custom thresholds** tuned to the user's pain tolerance.
2. **Forward-return columns** in the spike log (UW shows the spike but not
   "what did price do after?").
3. **A labeled dataset** of dealer-flow spike events for ML downstream.

## Architecture

```
                       UW /api/stock/{SPY,QQQ}/greek-flow
                                    │  (1-min bars)
                                    ▼
              fetch-greek-flow-etf.ts  (cron, 1-min cadence)
                                    │  raw bars
                                    ▼
                       vega_flow_etf  (Postgres, all 8 metrics)
                                    │
            ┌───────────────────────┼───────────────────────┐
            ▼                       ▼                       ▼
   monitor-vega-spike.ts    /api/vega-spikes        backfill script
   (cron, runs after        (frontend feed)         (one-shot 30-day)
    fetch each minute)              │
            │                       ▼
            ▼               <SpikeFeedPanel/>
   alerts table             (dashboard)
   + Sentry metric
   + toast (frontend)
```

## Phases

Each phase is independently shippable. Total estimated scope: ~3-4 days.

---

### Phase 1 — Ingest + Storage (~3 hr)

Pull SPY and QQQ greek-flow at 1-min resolution and store all 8 fields.

**Files to create:**

- `api/cron/fetch-greek-flow-etf.ts` — new cron, 1-min cadence (12 calls/min
  budget × 2 tickers = 2 UW calls/min; safe against 429s). Stagger 15s off
  the minute to avoid colliding with `fetch-spx-candles-1m`.
- `api/__tests__/fetch-greek-flow-etf.test.ts` — cron handler test
  (mock UW, assert 8 fields persist, assert idempotent ON CONFLICT).

**Files to modify:**

- `api/_lib/db-migrations.ts` — add migration for `vega_flow_etf` table.
- `api/__tests__/db.test.ts` — applied-migrations mock + expected output +
  SQL call count.
- `vercel.json` — register cron at `* * * * *` (every minute, market hours
  gating happens in `cronGuard`).
- `src/main.tsx` — add `/api/cron/fetch-greek-flow-etf` to BotID protect list.

**Schema:**

```sql
CREATE TABLE vega_flow_etf (
  id           BIGSERIAL PRIMARY KEY,
  ticker       TEXT NOT NULL,           -- 'SPY' or 'QQQ'
  date         DATE NOT NULL,           -- US/Eastern trading date
  timestamp    TIMESTAMPTZ NOT NULL,    -- minute bar timestamp (UTC)

  dir_vega_flow         NUMERIC NOT NULL,
  otm_dir_vega_flow     NUMERIC NOT NULL,
  total_vega_flow       NUMERIC NOT NULL,
  otm_total_vega_flow   NUMERIC NOT NULL,
  dir_delta_flow        NUMERIC NOT NULL,
  otm_dir_delta_flow    NUMERIC NOT NULL,
  total_delta_flow      NUMERIC NOT NULL,
  otm_total_delta_flow  NUMERIC NOT NULL,

  transactions INT NOT NULL,
  volume       INT NOT NULL,

  inserted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, timestamp)
);

CREATE INDEX vega_flow_etf_ticker_date_idx
  ON vega_flow_etf (ticker, date);
```

**Verify:** Cron runs locally via `vercel dev`; `SELECT count(*) FROM
vega_flow_etf WHERE date = CURRENT_DATE GROUP BY ticker` returns ~390 rows
per ticker after a full session. `npm run review` passes.

---

### Phase 2 — Backfill + Empirical Threshold Derivation (~2 hr)

Pull 30 days of historical bars and use the distribution to set the magnitude
floor.

**Files to create:**

- `scripts/backfill-greek-flow-etf.mjs` — one-shot, parallel to
  `backfill-greek-exposure.mjs`. Iterates 30 trading days × 2 tickers,
  inserts via the same SQL path. Idempotent (`ON CONFLICT DO NOTHING`).
- `scripts/derive-vega-spike-floors.mjs` — reads `vega_flow_etf`, computes
  per-ticker p99.5 of `abs(dir_vega_flow)` over the backfill window, prints
  recommended `FLOOR` constant for each ticker.

**Run:**

```bash
node scripts/backfill-greek-flow-etf.mjs --days 30
node scripts/derive-vega-spike-floors.mjs
# → SPY: FLOOR ≈ XXX,XXX
# → QQQ: FLOOR ≈ XXX,XXX
```

**Files to modify:**

- `api/_lib/constants.ts` — add `VEGA_SPIKE_FLOORS` map keyed by ticker,
  populated from script output.

**Verify:** ~30 × 390 × 2 = ~23,400 rows present after backfill.
Floor script prints sane numbers (SPY ≫ QQQ — order of magnitude difference
expected from chart visuals).

---

### Phase 3 — Spike Monitor (~4 hr)

Compute robust z-score on each new bar, write qualifying spikes to `alerts`,
emit Sentry metric.

**Files to create:**

- `api/cron/monitor-vega-spike.ts` — runs every minute at `:30s` (15s after
  ingest). For each ticker:
  1. Load today's bars from `vega_flow_etf` ordered by timestamp.
  2. If fewer than 30 bars → exit (insufficient baseline).
  3. Compute robust z-score on the latest bar:
     `score = abs(dir_vega_flow) / MAD(abs(dir_vega_flow), prior bars)`.
  4. Check all four gates:
     - elapsed_minutes ≥ 30
     - `abs(dir_vega_flow) ≥ FLOOR` (from constants)
     - `score ≥ 6`
     - `abs(dir_vega_flow) ≥ 2 × max(abs(prior bars today))`
  5. If all gates pass and no alert exists for `(ticker, timestamp)` →
     INSERT into `alerts` table with payload below.
  6. If both SPY and QQQ alerted within the same minute (or ±1 min),
     mark `confluence = true` on both rows.
- `api/vega-spikes.ts` — new endpoint `GET /api/vega-spikes` that returns
  the most recent N spike rows joined with forward-return data
  (see Phase 5). For now, stub the forward-return columns as `null`.
- `api/__tests__/monitor-vega-spike.test.ts` — unit test the spike-detection
  function with synthetic bar series; assert all four gates fire correctly.
- `api/__tests__/vega-spikes.test.ts` — endpoint test.

**Files to modify:**

- `api/_lib/db-migrations.ts` — add `vega_spike_events` table (or reuse
  existing `alerts`; decision in Open Questions). If new table:

```sql
CREATE TABLE vega_spike_events (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  date            DATE NOT NULL,
  timestamp       TIMESTAMPTZ NOT NULL,
  dir_vega_flow   NUMERIC NOT NULL,
  z_score         NUMERIC NOT NULL,
  vs_prior_max    NUMERIC NOT NULL,    -- ratio
  prior_max       NUMERIC NOT NULL,
  baseline_mad    NUMERIC NOT NULL,
  bars_elapsed    INT NOT NULL,
  confluence      BOOLEAN NOT NULL DEFAULT false,
  fwd_return_5m   NUMERIC,             -- nullable, populated in Phase 5
  fwd_return_15m  NUMERIC,
  fwd_return_30m  NUMERIC,
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, timestamp)
);
```

- `vercel.json` — register monitor cron at offset minute.
- `src/main.tsx` — add monitor + endpoint paths to BotID protect.

**Sentry metric:** `vega_spike.fired` with tags `ticker`, `confluence`.

**Verify:** Synthetic test bars produce expected gate behavior; on a live
day with a real spike (or replay from backfill), `vega_spike_events` row
appears within 90s of the bar.

---

### Phase 4 — Frontend Spike Feed Panel (~3 hr)

Surface qualifying spikes as a compact table on the dashboard.

**Files to create:**

- `src/components/VegaSpikeFeed/VegaSpikeFeed.tsx` — main panel component.
- `src/components/VegaSpikeFeed/VegaSpikeRow.tsx` — single-row component
  (memoized).
- `src/hooks/useVegaSpikes.ts` — polling hook (5-min cadence, gated on
  `marketOpen`), fetches `/api/vega-spikes`.
- `src/__tests__/VegaSpikeFeed.test.tsx` — render test with fixture data.

**Files to modify:**

- `src/App.tsx` — register the panel in the dashboard layout.
- `src/main.tsx` — register component name in nav metadata if applicable.

**Visual spec:**

| Time  | Tkr | Dir Vega | z     | vs prior max | +5m    | +15m   | +30m   |
| ----- | --- | -------- | ----- | ------------ | ------ | ------ | ------ |
| 12:00 | SPY | +5.62M   | 28.4σ | 4.8×         | +0.18% | +0.41% | +0.62% |
| 11:32 | QQQ | +0.51M   | 6.7σ  | 2.1×         | -0.04% | +0.09% | +0.21% |

- Rows with `confluence=true` get a highlighted border (the most informative
  case — concurrent SPY+QQQ vega buys = market-wide thesis).
- Sign-colored Dir Vega cell (green positive, red negative).
- Toast notification when a new spike row arrives during the polling window.
- Default view: today only; toggle for "last 7 days" historical browse.

**Verify:** Component renders with fixture; toast appears when fetch returns
new row; `npm run review` passes (including a11y rules).

---

### Phase 5 — Forward-Return Enrichment (~3 hr)

Join spike events to actual price action so the feed columns are populated.

**Problem:** We store SPY-derived SPX prices via `fetch-spx-candles-1m`, but
not raw SPY OHLC, and no QQQ candles at all.

**Files to create:**

- `api/cron/fetch-etf-candles-1m.ts` — fetches `/stock/SPY/ohlc/1m` and
  `/stock/QQQ/ohlc/1m` raw, stores in new `etf_candles_1m` table.
- `api/cron/enrich-vega-spike-returns.ts` — runs every 5 min during market
  hours; finds `vega_spike_events` rows with null forward-return columns
  whose `timestamp + 30min` has passed; computes `(close_at_t+N - close_at_t)
/ close_at_t` for N ∈ {5,15,30}; updates the row.
- `scripts/backfill-etf-candles-1m.mjs` — 30-day backfill of SPY/QQQ minute
  candles to support forward-return joins on backfilled spikes.
- Tests for both crons.

**Files to modify:**

- `api/_lib/db-migrations.ts` — `etf_candles_1m` table.
- `api/vega-spikes.ts` — remove the null stub, return the populated columns.
- `vercel.json` — register both new crons.

**Verify:** Re-run backfill; spike rows from 30-day window now have
non-null forward-return columns. Frontend feed shows them.

---

### Phase 6 — Verification (LAST)

- `npm run review` clean across all phases.
- E2E spec: `e2e/vega-spike-feed.spec.ts` — assert the panel renders, toast
  fires on mock new-row arrival, axe-core a11y clean.
- Manual: confirm 1 trading day of live data shows expected spike count
  (target: 0–3 spikes per ticker per session; if > 5/day, gates are too lax).

## Data Dependencies

| Resource                   | Source               | Notes                     |
| -------------------------- | -------------------- | ------------------------- |
| `vega_flow_etf` table      | New migration        | Phase 1                   |
| `vega_spike_events` table  | New migration        | Phase 3                   |
| `etf_candles_1m` table     | New migration        | Phase 5                   |
| UW `/stock/SPY/greek-flow` | UW API, existing key | 1/min, 390 calls/day      |
| UW `/stock/QQQ/greek-flow` | UW API, existing key | 1/min, 390 calls/day      |
| UW `/stock/SPY/ohlc/1m`    | UW API, existing key | already pulled (SPX cron) |
| UW `/stock/QQQ/ohlc/1m`    | UW API, existing key | new — 1/min for Phase 5   |
| BotID `protect` list       | `src/main.tsx`       | 3 new paths to add        |

**Net new UW load:** ~1,560 calls/day (4 × 390). Below daily limits.

## Constants

| Name                       | Value (planned)          | Where              |
| -------------------------- | ------------------------ | ------------------ |
| `Z_SCORE_THRESHOLD`        | 6.0                      | `constants.ts`     |
| `VS_PRIOR_MAX_RATIO`       | 2.0                      | `constants.ts`     |
| `MIN_BARS_ELAPSED`         | 30                       | `constants.ts`     |
| `VEGA_SPIKE_FLOORS.SPY`    | TBD — derived in Phase 2 | `constants.ts`     |
| `VEGA_SPIKE_FLOORS.QQQ`    | TBD — derived in Phase 2 | `constants.ts`     |
| `CONFLUENCE_WINDOW_SEC`    | 60                       | `constants.ts`     |
| Polling cadence (frontend) | 5 min                    | `useVegaSpikes.ts` |

## Open Questions

1. **New `vega_spike_events` table vs reuse existing `alerts`?**
   Default pick: **new table.** The `alerts` table is generic; vega spikes
   need 8+ specialized columns (z-score, ratio, MAD, forward returns).
   Mixing them would force everything into a JSONB blob. Cleaner as its
   own table; the frontend toast can still cross-reference by joining if
   we want a unified "alerts inbox" view later.

2. **Should the spike monitor run inside `fetch-greek-flow-etf.ts` instead
   of as a separate cron?** Default pick: **separate cron.** Decoupling
   means a monitor bug doesn't block ingest, and the monitor becomes
   easier to backfill-replay. Costs one extra Vercel invocation per minute
   — negligible.

3. **MAD computation window — full session or trailing N bars?**
   Default pick: **full session up to `t-1`.** Simpler, more bars = more
   stable MAD, and the "vs prior intraday max" gate already enforces the
   "within today" semantics. Trailing window adds tuning surface without
   clear benefit.

4. **Confluence flag — exact match or ±1 min window?**
   Default pick: **±1 min (60s window via `CONFLUENCE_WINDOW_SEC`).** Bar
   timestamps are nominally aligned to the minute but execution lag in
   either UW pipeline or our cron could push by a second. ±1 min is
   forgiving without being so wide it false-flags unrelated spikes.

5. **Toast persistence?** Default pick: **dismiss on click; auto-dismiss
   after 30s.** Sentry metric is the durable record; toast is an attention
   ping.

## Risks & Mitigations

| Risk                                           | Mitigation                                                |
| ---------------------------------------------- | --------------------------------------------------------- |
| First-bar-of-day always sets a "new max"       | `MIN_BARS_ELAPSED = 30` gate                              |
| Std-dev contaminated by the very spike we want | MAD instead of std-dev                                    |
| Too many alerts on choppy days                 | Empirical p99.5 floor + 4-gate AND logic                  |
| 429 rate limits from minute cadence            | Existing `uwFetch` 429 telemetry; staggered cron offset   |
| Toast spam if monitor double-fires             | `UNIQUE (ticker, timestamp)` constraint + ON CONFLICT     |
| Forward-return join has no candle data yet     | Phase 5 backfill closes this; nullable columns until then |
| Backfill script hits 429 doing 60 fast calls   | Add 200ms sleep between calls in the script               |

## Out of Scope (Explicit Non-Goals)

- Real-time websocket streaming. UW exposes minute aggregates; faster than
  1/min buys nothing.
- Reproducing UW's chart on our frontend. Spike feed > chart for this use
  case (acknowledged in scoping conversation).
- ML model. EDA + threshold tuning first; ML only after we have ≥3 months
  of labeled events.
- Alerting on `dir_delta_flow`, `total_vega_flow`, or OTM variants. These
  are stored for future analysis but not monitored.
- Push notifications. Reconsider after the toast-based version proves
  itself in real use.

## Done When

- All 6 phases pass their per-phase verify.
- One full session of live data produces a manageable spike count (target
  0–3 per ticker per day) with no obvious false positives.
- Backfill window has populated forward-return columns and the user can
  browse 30 days of historical spikes in the panel.
