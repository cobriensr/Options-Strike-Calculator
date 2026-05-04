# Lottery Finder — Per-Fire Net Flow Panel

**Status:** Draft v0.1 (2026-05-03)
**Owner:** user
**Depends on:** `lottery-finder-2026-05-02.md` v0.2 (live)
**Drives:** new daemon channel + new table + LotteryRow expand UX + new plateau detector

---

## Goal

Add a per-fire expandable panel that shows the ticker's net option
premium / volume flow alongside the contract's own bid/ask price
trajectory, so the user can spot exhaustion patterns (NCP plateau →
price decline) without leaving the app.

## User-observed motivating pattern (TSLA 2026-05-01, 395C)

- 12:45 PM CT → 1:50 PM CT: NCP flatlined 80–85M for ~65 minutes
- 1:25 PM CT: spot price started downtrending
- 1:42 PM CT: contract net volume flipped bullish → bearish, contract
  price collapsed shortly after

The 40-minute lead from NCP plateau onset to price-action confirmation
is the signal we want to surface. Whether it generalizes across the
50-ticker universe is open — Phase 3 validates with backtest.

---

## Phase 1 — Data pipeline (smallest end-to-end slice)

### 1.1 — Migration #N: `ws_net_flow_per_ticker`

```sql
CREATE TABLE IF NOT EXISTS ws_net_flow_per_ticker (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,
  net_call_prem   NUMERIC(18, 2) NOT NULL,
  net_call_vol    INTEGER NOT NULL,
  net_put_prem    NUMERIC(18, 2) NOT NULL,
  net_put_vol     INTEGER NOT NULL,
  raw_payload     JSONB NOT NULL
);

CREATE UNIQUE INDEX ws_net_flow_per_ticker_uq
  ON ws_net_flow_per_ticker (ticker, ts);

CREATE INDEX ws_net_flow_per_ticker_ticker_ts_idx
  ON ws_net_flow_per_ticker (ticker, ts DESC);

CREATE INDEX ws_net_flow_per_ticker_ts_idx
  ON ws_net_flow_per_ticker (ts);  -- for retention cron
```

Retention: 14 days rolling — matches the planned Lottery Finder
default panel window (we want to be able to look back across the
backfill range, but not store forever). 50 tickers × ~1 tick/sec
during market hours × 6.5h × 60 × 60 = ~1.2M rows/day → 17M rows over
14 days, comfortable on Neon.

### 1.2 — uw-stream daemon handler `net_flow.py`

Mirrors `option_trades.py`:

- Single shared `NetFlowHandler` instance for all `net_flow:<TICKER>`
  subscriptions.
- One `_transform()`: maps payload → row tuple.
- One `_flush()`: bulk insert with `ON CONFLICT (ticker, ts) DO NOTHING`.

Add `net_flow_lottery` shorthand to `Settings.channels` mirroring
`option_trades_lottery` so env-var stays compact:

```bash
WS_CHANNELS=flow-alerts,option_trades_lottery,net_flow_lottery
```

### 1.3 — Read endpoint `GET /api/net-flow-history`

```text
?ticker=TSLA&date=2026-05-01&from=09:00&to=14:00
```

Returns:

```json
{
  "ticker": "TSLA",
  "date": "2026-05-01",
  "from": "13:30Z",
  "to": "20:00Z",
  "rows": [
    { "ts": "...", "ncp": 1234, "ncv": 56, "npp": 789, "npv": 12 },
    ...
  ]
}
```

- Default window: full session (08:30 → 15:00 CT) on the date.
- `from` / `to` accept HH:MM CT.
- Ticker is required — no all-tickers mode.
- Owner-or-guest gated. Bot-protected (add to protect list).

### 1.4 — Tests + doc

- daemon: `tests/test_net_flow.py` — payload→tuple coverage, alias
  handling (UW pattern: `time` ms epoch → TIMESTAMPTZ).
- backend: `api/__tests__/net-flow-history.test.ts` — query-param
  validation + response shape.
- README: env var + WS_CHANNELS shorthand documented.

**Verify:** `npm run review` clean; `pytest` clean; manual curl
returns rows for a backfilled date once daemon has ingested.

**Commit boundary:** Phase 1.1 + 1.2 + 1.3 + 1.4 ≤ 5 files per commit
batch (split if needed).

---

## Phase 2 — Expandable LotteryRow with twin panels

### 2.1 — Row state + expand button

Add a click-to-expand affordance to `LotteryRow.tsx`. When expanded,
the row reveals an inline panel below the existing two-line summary.

Disclosure pattern: small ▸/▾ glyph next to the existing ↗ link, OR
the entire row becomes clickable (not the ticker link area which
already opens UW).

Local state: `useState<boolean>(expanded)`. No URL persistence — the
row collapses on date/filter change which is fine.

### 2.2 — Twin chart layout

Inside the expanded panel, a 2-up grid:

**Left (contract price + bid/ask vol)** — the contract's intraday tape:

- Backed by a NEW endpoint `/api/lottery-contract-tape?chain=<OCC>&date=...`
  that reads `ws_option_trades` (already populated by daemon).
- X-axis: time (08:30 → 15:00 CT).
- Bars: bid vs ask vol per minute (red/green stacked).
- Line: contract avg price per minute (bid/ask/mid weighted).
- Vertical marker at the fire's `triggerTimeCt` (purple line).

**Right (ticker net flow + spot)** — the ticker's intraday flow:

- Backed by `/api/net-flow-history` from Phase 1.3.
- X-axis: same time range as the left chart.
- Lines: cumulative NCP (green) + cumulative NPP (red).
- Optional overlay: ticker spot price (yellow line on secondary axis).
- Vertical marker at fire time matches the left chart.

Library: **Recharts** (already in `src/components/GreekFlowPanel/`).
Mirror that styling so the look stays consistent with the rest of
the app.

### 2.3 — Charting infrastructure

- New `src/components/LotteryFinder/ContractTapeChart.tsx`
- New `src/components/LotteryFinder/TickerNetFlowChart.tsx`
- New hook `src/hooks/useContractTape.ts` (paginated tick reader)
- New hook `src/hooks/useNetFlowHistory.ts`
- Both hooks: poll only when expanded AND on today's date, otherwise
  one-shot (historical days are stable).

### 2.4 — Empty state

If no `ws_option_trades` rows for the chain (older backfilled fires
that pre-date the daemon), show a graceful "Tape unavailable for
backfilled fires before 2026-05-04" message. NCP/NPP same: missing
data → "Net flow capture started DATE; no data for prior fires."

**Verify:** Visual review on a recent fire (after Mon market open).
Manual probe: Network tab shows the two endpoint calls fire only
when the row is expanded, not on initial render.

**Commit boundary:** 2.1 + 2.2 + 2.3 + 2.4 likely splits into two
commits (charts + endpoints in one, expand UX wiring in another).

---

## Phase 3 — Plateau detector + flag (optional analytics layer)

### 3.1 — Detection algorithm

Per ticker, every minute (cron), compute over a rolling 30-minute
window of `ws_net_flow_per_ticker`:

```text
slope = (ncp[end] - ncp[start]) / 30  # per-minute rate
range = max(|ncp[i]|) over the window
plateau_score = |slope| / range  # dimensionless, smaller = flatter
```

Flag as plateau when `plateau_score < 0.05` for ≥ 30 consecutive
minutes (the 30-min window is the slope unit; the 30-min consecutive
flatness is the duration). User-observed window was ~65 min so 30 is
conservative.

### 3.2 — Storage

Two options to surface in the UI:

**(A) Per-ticker time series** in a new `net_flow_plateau_events`
table (one row per detected plateau onset, with start_ts, end_ts,
duration_min, ncp_level). Cleaner schema.

**(B) Stamp directly on `lottery_finder_fires`** as
`net_flow_plateau_active BOOLEAN` at fire time. Cheaper to query but
loses the plateau's full duration.

Recommend (A) so the row's chart can highlight the plateau band as
a shaded region.

### 3.3 — Backtest first

**DO NOT** ship the plateau detector to production until we've
validated it on the parquet archive. Probe:

- For all backfilled fires, attach the plateau-active flag at fire time
- Bucket fires by `(plateau_active, mode, optionType)`
- Compare realized P&L distributions

If plateau-active subset shows materially worse outcomes (which our
hypothesis says it should — entering when premium has stalled is
late), then it's worth surfacing. If no signal, treat as informational
only and don't filter on it.

**Verify:** Analysis notebook in `docs/tmp/` documents the
distribution shift before any code that uses the flag for selection.

---

## Open questions

1. **NCP "stall" magnitude vs slope** — user described 80-85M absolute
   range. Should we ALSO surface the magnitude (e.g. 80M is
   institutional-large)? Could be a secondary heuristic: plateau-AT-
   high-magnitude is more meaningful than plateau-at-low-magnitude.

2. ~~**Cumulative vs delta NCP**~~ **ANSWERED 2026-05-03 from UW
   reference notebook**
   ([net_prem_ticks_dashboard_v2.ipynb](https://github.com/unusual-whales/api-examples/blob/main/examples/net-prem-ticks-dashboard/net_prem_ticks_dashboard_v2.ipynb)):
   each emission is a per-minute (REST) or per-tick (WS) DELTA, not
   cumulative. UW's example does `cumsum()` to render the daily
   chart. Decision: daemon stores raw deltas; cumulative is computed
   at read time via `SUM(net_call_prem) OVER (PARTITION BY ticker,
date ORDER BY ts)`. Single source of truth, no double-counting
   risk on retries.

3. **Tickers without enough flow** — RUTW, USAR, SOUN may have
   sparse net_flow ticks (UW only emits on activity). The plateau
   detector should require a minimum N ticks in the window before
   firing, otherwise sparse-but-flat = false positive.

4. ~~**WS payload vs REST payload field set**~~ **ANSWERED 2026-05-03
   — REST is not viable + side-splits derivable from existing data**:

   Two findings collapsed this question:
   - REST polling 50 tickers/min would compound with the existing
     ~17 per-minute UW crons (fetch-spot-gex, fetch-greek-flow-etf,
     monitor-vega-spike, fetch-strike-iv, fetch-strike-trade-volume,
     etc.). UW's rate limiter is burst-aware; the user already saw
     random 429s with semaphore=3 + jitter at lower load. Adding
     50/min on top is operationally fragile.
   - The side-split volumes the REST endpoint exposes
     (`call_volume_bid_side`, `call_volume_ask_side`, etc.) are
     computable from `ws_option_trades` directly — every per-tick
     row has the OPRA `side` classification (ask/bid/mid/no_side)
     and option_type. A per-ticker per-minute aggregation gives the
     same data with zero extra UW load.

   Decision: **WS-only**. The daemon writes raw deltas to
   `ws_net_flow_per_ticker`; if the panel ever needs side-splits we
   compute them at read time from `ws_option_trades` (`SUM(size) FILTER (WHERE option_type=X AND side=Y) GROUP BY date_trunc('minute', executed_at)`).

---

## Success criteria

**Phase 1:**

- [ ] Daemon ingests `net_flow:<TICKER>` for all lottery tickers
- [ ] Table populated with ≥1 day of data
- [ ] Endpoint returns valid time-series for any subscribed ticker

**Phase 2:**

- [ ] LotteryRow expands inline with both charts visible
- [ ] Charts load only when expanded (lazy network)
- [ ] Fire-time vertical marker aligned across both charts
- [ ] Empty-state messages render for pre-backfill fires

**Phase 3 (optional):**

- [ ] Backtest documented in docs/tmp/
- [ ] Plateau-flag adds ≥10pp lift on at least one fire subset OR
      gets explicitly shipped as informational-only with the
      negative finding documented

---

## Out of scope

- Building a full charting library (use Recharts).
- Tracking net_flow for non-lottery tickers (universe = lottery only).
- Real-time streaming to the browser (server-side ingest + REST poll).
- Cross-ticker plateau correlation (Phase 4+ if ever).
