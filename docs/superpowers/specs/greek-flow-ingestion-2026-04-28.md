# Greek Flow UI Panel (SPY + QQQ)

## Goal

Surface the SPY+QQQ Greek flow data already being ingested (table `vega_flow_etf`, ~12K rows/ticker, 42 days backfilled) in a UI panel matching the 8 Unusual Whales chart views (Δ / V × Dir / OTM × all-strikes / OTM-only). Compute cumulative + slope + flip + cliff + divergence on read for actionable signal.

**Not** fed to the analyze prompt — UI / human read only.

## Status (already shipped)

- ✅ **Cron `api/cron/fetch-greek-flow-etf.ts`** — every minute during market hours, SPY + QQQ from `/stock/{ticker}/greek-flow`, 1-min resolution.
- ✅ **Table `vega_flow_etf`** (migration 92) — all 8 fields + transactions + volume, indexed on (ticker, date), unique (ticker, timestamp), `ON CONFLICT DO NOTHING`.
- ✅ **Backfill `scripts/backfill-greek-flow-etf.mjs`** — defaults to 30 days, idempotent. **Already populated** through 2026-04-28.
- ✅ **Spike monitor (separate signal)** — `monitor-vega-spike.ts` + `vega_spike_events` table (migration 93). Surfaced via existing `api/vega-spikes.ts`. **Not** part of this work — separate UI surface.

## Phases

### Phase 1 — DONE

Data ingestion + backfill already shipped.

### Phase 2 — API endpoint + derived metrics

- [ ] Add `greekFlowQuerySchema` to `api/_lib/validation.ts` — optional `date` (YYYY-MM-DD).
- [ ] `api/_lib/db-greek-flow.ts` — `getGreekFlowSession(date)` returns rows for SPY + QQQ with cumulative columns computed via Postgres window function (`SUM(field) OVER (PARTITION BY ticker ORDER BY timestamp)` for each of the 8 fields).
- [ ] `api/_lib/greek-flow-metrics.ts`:
  - `slopeLast15min(cumulative)` — linear regression slope on last 15 cumulative points
  - `recentFlip(cumulative, lookbackMin=30)` — sign change within window with magnitude
  - `lateDayCliff(cumulative)` — abs Δ in trailing 10-min during 14:00–15:00 CT
  - `divergence(spy, qqq, field)` — sign disagreement detector
- [ ] `api/greek-flow.ts` — owner-or-guest endpoint mirror `api/zero-gamma.ts` shape; returns `{ date, tickers: { SPY, QQQ }, divergence, asOf }`.
- [ ] Add `/api/greek-flow` to `protect` array in `src/main.tsx` `initBotId()`.
- [ ] Tests: `api/__tests__/greek-flow-metrics.test.ts`, `api/__tests__/endpoint-greek-flow.test.ts`.

### Phase 3 — UI panel

- [ ] `src/hooks/useGreekFlow.ts` — fetcher hook polling 60s when `marketOpen`, exposes `{ data, loading, error }`.
- [ ] `src/components/GreekFlowPanel/index.tsx` — header + ticker tabs (SPY/QQQ) + 8 mini-chart grid + metrics bar.
- [ ] `src/components/GreekFlowPanel/FlowChart.tsx` — single signed line chart (red below 0, green above), reusing existing chart primitives.
- [ ] `src/components/GreekFlowPanel/MetricsBar.tsx` — slope arrow, flip badge, cliff alert, divergence indicator.
- [ ] Mount in `src/App.tsx`; nav constant in `src/constants/index.ts`.
- [ ] Tests: `src/__tests__/hooks/useGreekFlow.test.ts`, `src/__tests__/components/GreekFlowPanel.test.tsx`.

### Phase 4 — DONE

Backfill already populated via existing script.

### Phase 5 — Verification

- [ ] `npm run review` passes.
- [ ] Browser smoke: panel loads, both tickers render, polling works during market hours.
- [ ] Code-reviewer subagent verdict: pass.

## Thresholds (initial — tune later)

- **Slope window**: last 15 minutes (15 cumulative points)
- **Flip lookback**: 30 minutes
- **Cliff window**: 10-min Δ during 14:00–15:00 CT
- **Cliff trigger**: abs(Δ) ≥ 50% of session-to-date stdev of 10-min Δs
- **Divergence flag**: sign(SPY) ≠ sign(QQQ) for the same metric

## Files

**Created:**

- `api/_lib/db-greek-flow.ts`
- `api/_lib/greek-flow-metrics.ts`
- `api/greek-flow.ts`
- `api/__tests__/greek-flow-metrics.test.ts`
- `api/__tests__/endpoint-greek-flow.test.ts`
- `src/hooks/useGreekFlow.ts`
- `src/components/GreekFlowPanel/index.tsx`
- `src/components/GreekFlowPanel/FlowChart.tsx`
- `src/components/GreekFlowPanel/MetricsBar.tsx`
- `src/__tests__/hooks/useGreekFlow.test.ts`
- `src/__tests__/components/GreekFlowPanel.test.tsx`

**Modified:**

- `api/_lib/validation.ts` (`greekFlowQuerySchema`)
- `src/App.tsx` (mount panel)
- `src/constants/index.ts` (nav constant)
- `src/main.tsx` (botid protect)

## Done When

- `/api/greek-flow` returns SPY+QQQ cumulative + metrics + divergence, gated owner-or-guest.
- UI panel renders 8 charts × 2 tickers + metrics bar, polls every 60s during session.
- All tests pass; code-reviewer verdict pass.
