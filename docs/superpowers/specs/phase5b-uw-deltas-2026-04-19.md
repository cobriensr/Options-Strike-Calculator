# Phase 5b — UW Data Deltas + Rates-of-Change — 2026-04-19

Part of the max-leverage roadmap. Phase 5b computes four derived
signals on UW data already ingested into Neon by existing crons, and
injects them into Claude's analyze context. Same architectural
pattern as Phase 1 (cross-asset regime, volume profile, VIX
divergence) and Phase 2b (microstructure signals): compute-on-demand
from existing DB state, no new crons, no new UW calls at analyze
time.

## Goal

Give Claude four new signals on every analyze call, each one turning
a "point-in-time level" UW measurement into a delta / rate-of-change /
cumulative summary. Raw UW point-in-time values are already in the
analyze context today; Phase 5b adds the _velocity_ dimension.

## Why deltas, not levels

UW tells you the current state (dark pool prints so far today, GEX at
this moment, total whale premium). The deltas tell you _what changed
over the last N minutes_, which is the actionable read for an
intraday 0DTE trader:

- A steady dark pool print rate is baseline; a sudden surge is
  institutional accumulation / distribution.
- GEX at +$1B means nothing in isolation; GEX that dropped $300M in
  the last hour means dealer positioning flipped.
- Whale cumulative net premium is a _direction_ and _magnitude_ read
  that raw flow-alert rows don't surface.
- SPY tide up 2% and QQQ tide down 2% is a tech-disfavor signal that
  neither tide alone makes obvious.

## The four signals

### 1. Dark pool velocity

Source table: whatever `api/cron/fetch-darkpool.ts` writes to. (Spec
reviewer should verify; expected name: `dark_pool_prints`.)

Compute at analyze time:

- Count of qualifying prints in the last 5 minutes.
- Count of qualifying prints per 5-min window over the last 60 minutes
  (12 buckets).
- `dp_velocity_zscore` = `(latest_5m - rolling_mean_12) / rolling_std_12`
- Classification: `SURGE` (z > 2.0), `DROUGHT` (z < -2.0),
  `NORMAL` otherwise.

**Qualifying prints must already be filter-clean.** If
`fetch-darkpool.ts` doesn't filter at ingest time, apply the skill's
filter rules at query time:

- Drop `sale_cond_codes = 'average_price_trade'` or
  `'derivative_price_trade'`.
- Drop `sale_cond_codes = 'extended_hours_trade'`.
- `contingent_trade` envelope filter is optional in this phase —
  skip unless ingest already handles it.

Restrict to RTH 13:30-20:00 UTC (08:30-15:00 CT) by default.

### 2. GEX intraday delta

Source table: whatever `fetch-greek-exposure.ts` writes to. Expected:
a per-snapshot `greek_exposure` or similar with `total_gex` and a
timestamp.

Compute at analyze time:

- `gex_open` = total_gex at the first snapshot with
  `ts >= today 13:30 UTC`.
- `gex_now` = most recent total_gex for today.
- `gex_intraday_delta_pct` = `(gex_now - gex_open) / abs(gex_open)`.
- Classification: `STRENGTHENING` (abs pct > 20%, same sign as open),
  `WEAKENING` (abs pct > 20%, opposite sign or halved), `STABLE`
  otherwise.

Null-safe: if either open or current is missing, return null.

### 3. Whale flow net positioning

Source: flow-alerts stored by `fetch-flow-alerts.ts`. Expected table
includes `premium`, `option_type` ('C' or 'P'), `ts`.

Compute at analyze time:

- `whale_call_premium_cumulative` = sum of premium for calls, today,
  RTH only.
- `whale_put_premium_cumulative` = sum of premium for puts, today,
  RTH only.
- `whale_net_premium` = call - put (positive = bullish whale
  positioning).
- `whale_net_ratio` = (call - put) / (call + put) ∈ [-1, +1].
- Classification: `AGGRESSIVE_CALL_BIAS` (ratio > 0.4 AND total > $5M),
  `AGGRESSIVE_PUT_BIAS` (ratio < -0.4 AND total > $5M), `BALANCED`
  otherwise.

$5M total floor is a small-sample guard — early morning with 10
whale prints isn't meaningfully directional.

### 4. ETF tide rate of change + cross-ETF divergence

Source: `etf_tide` table written by `fetch-etf-tide.ts`. SPY + QQQ.
Columns likely include `ticker`, `net_flow`, `ts`.

Compute at analyze time:

- `spy_tide_5m_delta` = SPY net_flow latest - SPY net_flow 5 min ago.
- `qqq_tide_5m_delta` = same for QQQ.
- `tide_divergence_classification`:
  - `SPY_LEADING_BULL` if SPY > +$X threshold AND QQQ < -$X threshold
    (tech underperforming as broad market rallies)
  - `QQQ_LEADING_BEAR` if QQQ < -$Y threshold AND SPY flat/positive
    (tech selling off while broad market holds)
  - `ALIGNED_RISK_ON` both strongly positive
  - `ALIGNED_RISK_OFF` both strongly negative
  - `MIXED` otherwise

Threshold X/Y calibrated from historical ETF tide distributions; start
with $50M absolute as a placeholder, revisit after a week of
observation.

## Files

### New

- `api/_lib/uw-deltas.ts` — four compute functions + a dual-symbol
  orchestrator, matching the shape of `microstructure-signals.ts`:

  ```ts
  export interface UwDeltas {
    darkPool: DarkPoolVelocity | null;
    gex: GexIntradayDelta | null;
    whaleFlow: WhaleFlowPositioning | null;
    etfTide: EtfTideDivergence | null;
    computedAt: string;
  }

  export async function computeUwDeltas(now: Date): Promise<UwDeltas | null>;
  export function formatUwDeltasForClaude(d: UwDeltas | null): string | null;

  // Individual helpers exported for testability:
  export async function computeDarkPoolVelocity(conn, now): Promise<...>;
  export async function computeGexIntradayDelta(conn, now): Promise<...>;
  export async function computeWhaleFlowPositioning(conn, now): Promise<...>;
  export async function computeEtfTideDivergence(conn, now): Promise<...>;
  ```

  Run the four compute helpers in parallel via `Promise.allSettled` so
  one source being stale doesn't kill the whole block.

- `api/__tests__/uw-deltas.test.ts` — mirror the
  `microstructure-signals.test.ts` pattern. Use synthetic DB fixtures
  (via `vi.mocked(getDb)` + `mockResolvedValueOnce`) for each helper
  independently, plus integration happy-path.

### Modified

- `api/_lib/analyze-context-fetchers.ts` — add
  `fetchUwDeltasBlock()` wrapping `computeUwDeltas` with the usual
  `logger.error` + `metrics.increment('analyze_context.uw_deltas_error')`
  - `return null` on failure.

- `api/_lib/analyze-context.ts` — wire the new fetcher into the
  existing `Promise.all` block and into the prompt assembly, placed
  next to the existing microstructure block.

- `api/_lib/analyze-prompts.ts` — extend `SYSTEM_PROMPT_PART1`
  (cached) with a new `<uw_deltas_rules>` block documenting what each
  delta means, how to weight it, thresholds for classifications, and
  known limits. Concrete text covering:
  - Dark pool SURGE: "Large institutional accumulation / distribution.
    Confirm with whale flow and GEX delta before treating as
    directional."
  - GEX STRENGTHENING: "Dealer long-gamma regime intensifying;
    volatility likely compressed into close."
  - WEAKENING: "Dealer positioning deteriorating; tail-risk day."
  - WHALE AGGRESSIVE_CALL_BIAS: "Institutional call premium is
    skewed aggressively long; combine with ETF tide for conviction."
  - ETF tide SPY_LEADING_BULL: "Broad-market rally without tech
    participation; prefer SPY-proxy trades over NDX-proxy."
  - Cross-signal combos: what it means when 3 of 4 agree vs conflict.

  Do NOT interpolate any runtime values into the cached section — all
  thresholds and classifications are durable prose.

- `api/__tests__/analyze-context.test.ts` — regression-test the new
  block renders when fetcher returns data, drops cleanly when null.

## Before coding — verify against source

Do NOT guess table names or column names. Each compute helper queries
a table written by an existing cron; confirm actual shape:

```
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
.venv/bin/python -c "
import os, psycopg2
from dotenv import load_dotenv
load_dotenv('sidecar/.env')
conn = psycopg2.connect(os.environ['DATABASE_URL'])
cur = conn.cursor()
# Identify the darkpool / GEX / flow-alerts / etf-tide tables:
cur.execute(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'dark%' OR table_name LIKE '%greek%' OR table_name LIKE '%flow%' OR table_name LIKE '%tide%' OR table_name LIKE '%whale%') ORDER BY table_name\")
print(cur.fetchall())
"
```

Then for each table, `SELECT column_name, data_type FROM
information_schema.columns WHERE table_name='...'`.

Alternative: read the cron handler for each data source
(`api/cron/fetch-darkpool.ts`, `fetch-greek-exposure.ts`,
`fetch-flow-alerts.ts`, `fetch-etf-tide.ts`) and trace the INSERT to
find the table + columns. This is cheaper than a DB probe if
`DATABASE_URL` isn't accessible from the subagent sandbox.

## Constraints

- **No new crons, no new UW endpoints, no new DB migrations.** All data
  already exists in Neon.
- **No live UW API calls from the analyze endpoint.** Respect the
  `analyze.ts` hot path — the whole point of the crons is to
  pre-stage UW data.
- **Filter rules at query time if ingest didn't apply them:** drop
  synthetic dark pool prices + extended-hours. (See skill doc.)
- **RTH only (13:30-20:00 UTC / 08:30-15:00 CT)** for all intraday
  aggregations.
- **Memory and runtime:** each analyze call currently takes ~2-3s end
  to end. Adding four parallel SQL queries should add <200ms.
- **Cache boundary:** interpretation rules in `SYSTEM_PROMPT_PART1`,
  signal values in dynamic per-call context.
- **No Phase 4c/4d ML code touched.**

## Done when

- `npm run review` passes with zero errors (tsc + eslint + prettier +
  vitest).
- All four helpers return null gracefully when their source table is
  empty for today.
- All four classifications have explicit tests.
- Prompt rules block exists in the cached section with no runtime
  interpolation.
- Integration test confirms the new `<uw_deltas>` block renders in a
  mocked analyze prompt.
- Smoke check: after deploy, a Monday-morning analyze call shows the
  block populated with real numbers (human verification, not scripted).

## Out of scope

- Backfilling historical UW deltas for ML training — separate phase if
  signal validation needed.
- New UW endpoints (flow-per-strike, skew, etc.) — this phase uses
  what's already being ingested.
- Frontend UI surfacing of these deltas.
- Fixing the ES spread-widening aggregator from Phase 4c's TODO —
  separate concern.

## Open questions (default picks noted)

- **Dark pool "qualifying prints" definition:** default =
  `size * price >= $1M` (block trades only). Adjustable if a smaller
  threshold surfaces more signal.
- **GEX source:** `total_gex` from `greek_exposure` base table is a
  scalar per snapshot. If the table is per-strike only, sum across
  strikes per snapshot to get the total. Confirm during implementation.
- **ETF tide threshold X/Y:** placeholder $50M absolute. Check the
  historical distribution during implementation and pick a 80th-pctile
  value.
- **Flow-alerts "whale" definition:** UW's flow-alerts endpoint already
  filters for unusual volume / size. Use every flow alert row as a
  whale print, no further filter.
