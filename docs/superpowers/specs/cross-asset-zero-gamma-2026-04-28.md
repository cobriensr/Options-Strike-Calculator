# Cross-Asset Zero-Gamma (SPX + NDX + SPY + QQQ)

## Goal

Extend the existing SPX-only zero-gamma pipeline to **NDX, SPY, and QQQ**, and
surface the resulting intraday level on the frontend chart so we have a
self-hosted equivalent of Gexbot's zero-gamma overlay across the four
tickers we actually trade against.

## Motivation

The user observed Gexbot's Zero Gamma line (7129.17 at 13:05 CT on
2026-04-28) and asked whether the project could compute it without paying
for a third-party feed. Investigation found:

1. UW does **not** publish a "zero gamma" scalar. The line is derived from
   per-strike OI gamma, which UW _does_ publish via
   `/stock/{ticker}/spot-exposures/expiry-strike`.
2. The project already has the full pipeline for SPX:
   - `fetch-strike-exposure` (5-min cron) populates `strike_exposures`.
   - `compute-zero-gamma` (5-min, +1m offset) reads the latest snapshot
     and writes `zero_gamma_levels` with full curve and confidence.
   - `/api/zero-gamma` returns the latest + last 100 history rows.
3. Both existing tables (`strike_exposures`, `zero_gamma_levels`) already
   carry a `ticker` column — schema-ready for cross-asset.

The remaining work is **generalizing the two crons to loop over N tickers**
and **rendering the level as an intraday chart overlay**. No new tables.
No new endpoint contracts. No futures, no single names — out of scope by
explicit user decision (single names have weaker dealer-mechanics signal,
NDX/QQQ futures-options ingestion is a separate larger piece of work).

## Architecture

```
            UW /api/stock/{SPX,NDX,SPY,QQQ}/spot-exposures/expiry-strike
                                  │  (per-strike OI gamma, front-week expiry)
                                  ▼
                fetch-strike-exposure.ts  (cron, 5-min cadence)
                                  │  rows tagged by ticker + expiry
                                  ▼
                          strike_exposures  (existing — ticker col reused)
                                  │
                                  ▼
                compute-zero-gamma.ts  (cron, 5-min +1m offset)
                                  │  one zero_gamma_levels row per ticker per cycle
                                  ▼
                          zero_gamma_levels  (existing — ticker col reused)
                                  │
                                  ▼
                          /api/zero-gamma?ticker=NDX  (existing — already accepts ticker param)
                                  │
                                  ▼
                  <ZeroGammaOverlay/>  (new chart component on intraday SPX/SPY/NDX/QQQ panels)
```

## Decisions (defaults locked)

| Decision          | Default                                                     | Rationale                                                                                                                                                                                                                                                                    |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expiry scope      | **Front-available expiry per ticker**                       | SPX/SPY/QQQ have daily expirations — front-week = today (0DTE). NDX has Mon/Wed/Fri only — front-available picks today if it's an NDX expiration day, else the next listed expiration. Mirrors SPX's existing 0DTE-focused choice while staying robust to non-daily tickers. |
| Cron shape        | **Single generalized handler, looped over tickers**         | Repo precedent for similar fetchers (e.g. `STRIKE_IV_TICKERS` loop in `fetch-strike-iv`). Simpler ops, one Sentry tag per cycle, atomic failure surface.                                                                                                                     |
| Confidence gate   | **Reuse existing 0.5 threshold**                            | SPX's threshold is calibrated for SPX strike density. SPY/QQQ have $1 strikes (denser), NDX has $5/$10 (similar to SPX). Likely fine, but Phase 4 audits the null-rate and adjusts per ticker if needed.                                                                     |
| Storage           | **No new tables**                                           | Both `strike_exposures` (mig 7) and `zero_gamma_levels` (mig 82) have `ticker NOT NULL` columns. Adding more values is a pure cron-loop change.                                                                                                                              |
| API contract      | **Reuse `/api/zero-gamma?ticker=X`**                        | Endpoint already accepts a ticker query param (default 'SPX'). Frontend just calls it 4 times or batches via `?tickers=` if we add that later.                                                                                                                               |
| Rate limit budget | **4 tickers × 1 expiry × 5-min = 4 calls per 5-min window** | Down from SPX's current 2 (0DTE + 1DTE) → 4 total. Well under UW's per-minute limit. Drop the 1DTE pull from SPX as part of this work to keep the loop uniform; 1DTE was for the Periscope view, separate concern from zero-gamma.                                           |

## Phases

Each phase independently shippable. Total estimated scope: ~3-4 hours of
implementation + verification.

---

### Phase 1 — Generalize ingest (~1 hr)

Refactor `fetch-strike-exposure.ts` to loop over a `ZERO_GAMMA_TICKERS`
constant and pull one front-week expiry per ticker.

**Files to modify:**

- `api/cron/fetch-strike-exposure.ts` — replace hardcoded SPX + dual-expiry
  with a ticker loop. Add helper `getFrontExpiry(ticker, today)` that picks
  today if it's a listed expiration day for that ticker, else the next
  listed expiration (use UW's `/stock/{ticker}/expirations` endpoint, cached
  per cron run).
- `api/__tests__/fetch-strike-exposure.test.ts` — extend mock sequence to
  cover 4 tickers × 1 expiry. Use `mockResolvedValueOnce` per ticker pull.

**Files to create:** none.

**Constants:**

```ts
const ZERO_GAMMA_TICKERS = ['SPX', 'NDX', 'SPY', 'QQQ'] as const;
const ATM_RANGE_BY_TICKER = {
  SPX: 200, // existing
  NDX: 500, // ~3% of 18k
  SPY: 20, // ~3% of 600
  QQQ: 20, // ~3% of 500
} as const;
```

**Verification:** Run cron locally with `CRON_SECRET=...`, query
`SELECT ticker, COUNT(*) FROM strike_exposures WHERE date = CURRENT_DATE
GROUP BY ticker;` — expect 4 tickers, each with ~40-100 strikes.

---

### Phase 2 — Generalize compute (~45 min)

Refactor `compute-zero-gamma.ts` to loop the same ticker list and write one
`zero_gamma_levels` row per ticker per cycle.

**Files to modify:**

- `api/cron/compute-zero-gamma.ts` — remove hardcoded `TICKER = 'SPX'` and
  `expiry = today` filter. Loop `ZERO_GAMMA_TICKERS`, load latest snapshot
  per ticker (front-week expiry, whatever Phase 1 wrote), call
  `computeZeroGammaLevel`, insert per-ticker row.
- `api/__tests__/compute-zero-gamma.test.ts` — extend mock sequence for
  4 tickers.

**Files to create:** none.

**Verification:** After Phase 1 cron runs, run compute cron locally. Query
`SELECT ticker, spot, zero_gamma, confidence FROM zero_gamma_levels WHERE
ts > NOW() - INTERVAL '10 min' ORDER BY ticker;` — expect 4 rows, one per
ticker, with finite confidence values.

---

### Phase 3 — Frontend chart overlay (~1.5 hr)

Render the live zero-gamma level (and recent history line) on each intraday
chart panel for SPX, NDX, SPY, QQQ.

**Files to create:**

- `src/hooks/useZeroGamma.ts` — fetch hook keyed by ticker, polling every
  60s during market hours via the existing `/api/zero-gamma?ticker=X` endpoint.
  Gate refresh on `marketOpen` per repo polling convention.
- `src/components/ZeroGammaOverlay.tsx` — renders a horizontal dashed line
  at the latest `zero_gamma` level on the parent chart, with label
  "ZG \[ticker\]: \$X.XX" and a faded historical drift trail using the last
  100 rows. Color: amber (regime boundary, distinct from call/put walls).

**Files to modify:**

- The existing intraday chart components for each ticker. Need to confirm
  exact component paths during implementation — likely
  `src/components/spx/`, `src/components/futures/` mounts, etc.
  Mount `<ZeroGammaOverlay ticker="SPX" />` etc. on each.

**Verification:** Open the app during market hours, see a horizontal amber
line drawn at the current zero-gamma level on SPX/SPY/NDX/QQQ intraday
charts. Hover label shows "ZG SPX: 7129.17" or similar. Refresh after 5
min — line moves with the new compute cron output.

---

### Phase 2.5 — Historical backfill (~1 hr, ships with Phase 2)

Two scripts that hydrate `strike_exposures` and `zero_gamma_levels` for
the last N trading days so the user can scrub back through history and
see how price reacted around past zero-gamma levels.

UW's `/spot-exposures/expiry-strike?date=YYYY-MM-DD` returns the
**most recent** snapshot for that date — so historical backfill yields
**one zero-gamma data point per (ticker, date)**, not a 5-min time series.
Going-forward intraday granularity starts when Phase 2 went live.

**Files added:**

- `scripts/backfill-strike-exposure.mjs` — generalized from SPX-only to
  loop all 4 tickers with the same per-ticker primary-expiry policy as
  the live cron. Run first.
- `scripts/backfill-zero-gamma.ts` — TypeScript so it can import the
  shared `computeZeroGammaLevel` calculator. Reads `strike_exposures`
  per (ticker, date), computes the level, writes to `zero_gamma_levels`
  with the snapshot's `timestamp` as `ts`. Idempotent via
  delete-by-range before insert.

**Usage:**

```bash
# Step 1: pull historical strike data for all 4 tickers
UW_API_KEY=... DATABASE_URL=... node scripts/backfill-strike-exposure.mjs 30

# Step 2: derive zero-gamma rows from the strike data
DATABASE_URL=... npx tsx scripts/backfill-zero-gamma.ts 30
```

**Verification:** Query
`SELECT ticker, MIN(ts), MAX(ts), COUNT(*) FROM zero_gamma_levels
GROUP BY ticker ORDER BY ticker;` — expect 4 tickers each with ~30 rows
spanning the requested window.

---

### Phase 4 — Confidence audit (~30 min, deferrable)

After Phases 1-3 ship and 2-3 sessions of data accumulate, run a SQL audit
on `zero_gamma_levels` to see how often the 0.5 confidence gate produces
NULLs per ticker. If any ticker is >40% NULL, drop the gate to 0.4 for that
ticker only via a `CONFIDENCE_MIN_BY_TICKER` map. If <5% NULL across all
tickers, the gate is fine as-is.

**Files to modify (only if calibration is needed):**

- `api/cron/compute-zero-gamma.ts` — replace scalar `CONFIDENCE_MIN` with
  per-ticker map.

**Verification:** SQL query result + brief decision note appended to this
spec under a "Calibration outcome" section.

---

## Data dependencies

- **No new env vars.** Everything reuses `UW_API_KEY` and `CRON_SECRET`.
- **No new tables.** `strike_exposures` and `zero_gamma_levels` already
  carry `ticker` columns and accept arbitrary values.
- **No new UW endpoints.** `/stock/{ticker}/spot-exposures/expiry-strike`
  works for all 4 tickers per the OpenAPI spec (`SingleTicker` schema, no
  whitelist). Need to verify NDX is supported with a one-off probe in
  Phase 1 — UW sometimes maps index tickers to alternate symbols.

## Open questions (decided defaults — reopen if Phase 1 surprises us)

1. **NDX vs NDXP for the UW pull?** UW's IV anomaly pipeline uses `NDXP`
   for index options (Phase 3 onwards). If `/stock/NDX/spot-exposures` returns
   404 or empty, retry with `NDXP`. Resolve in Phase 1 with a probe call.
2. **Drop the existing SPX 1DTE pull from `fetch-strike-exposure`?**
   **Resolved 2026-04-28: NO.** Investigation found multiple active
   consumers of the 1DTE rows: `build-features-gex.ts` (1DTE column in
   the ML feature vector), the Periscope view, and the gamma-squeeze
   detector. The SPX dual-expiry pull stays. Total UW calls per cycle
   becomes 5 instead of 4: SPX × 2 (today + tomorrow), plus 1 each for
   NDX (front Mon/Wed/Fri), SPY (today), QQQ (today).
3. **Volume-weighted variant ("gex by volume" like Gexbot's label)?**
   Deferred. Out of scope for this spec — current OI-only matches the
   existing SPX implementation. Revisit only if the OI-weighted line
   visibly diverges from intuition for NDX/SPY/QQQ.

## Verification

- `npm run review` passes with zero TS / ESLint / vitest failures.
- After Phase 2, manual SQL check: 4 distinct tickers in
  `zero_gamma_levels` for the current session.
- After Phase 3, browser check: amber zero-gamma line visible on each of
  the 4 intraday charts during market hours.

## Out of scope (explicitly)

- Futures zero gamma (ES/NQ) — separate spec required, depends on Databento
  sidecar work.
- Single-name zero gamma (NVDA/TSLA/META/MSFT/MSTR/MU/SNDK) — signal
  quality is weaker; revisit if cross-asset zero-gamma proves valuable
  enough for the four indices/ETFs.
- Volume-weighted variant — see open question 3.
- Cross-asset zero-gamma in the analyze endpoint context — separate change,
  depends on this landing first.
