# Zero-Gamma Level Calculator

## Goal

Compute the zero-gamma level (spot price where summed dealer gamma across
0DTE strikes = 0) every 5 min during market hours for SPX, using existing
GEX-by-strike data already ingested by `fetch-strike-exposure` (the actual
source — the spec originally said `spot_gex`, which doesn't exist here).
Store results to Neon and expose via an owner-gated read endpoint. Feeds
downstream features (analyze context, IV anomaly detector context snapshot).

## Motivation

The zero-gamma level is arguably the single highest-signal derived metric in
options microstructure:

- **Spot > zero-gamma:** dealers net long gamma → mean-reverting pressure,
  moves dampened, ranges hold.
- **Spot < zero-gamma:** dealers net short gamma → trend-continuation
  pressure, moves accelerate, ranges fail.
- **Crossing zero-gamma** is the structural signal for when a day's
  behavior regime changes.

On 2026-04-23, SPX crossed from positive-gamma territory into negative-gamma
territory somewhere between 7130–7135, which is where the flush accelerated.
We had the inputs (GEX by strike from `fetch-spot-gex`) but never computed
the derived zero-gamma level, so the regime flip was invisible.

SpotGamma charges thousands for this single number. It's trivially
computable from data already in Neon.

## Approach

For each minute during market hours:

1. Query the latest `spot_gex` snapshot (GEX per strike, the existing cron
   output).
2. Build a spot-price grid spanning ±3% around current spot (30 points).
3. For each candidate spot price, compute net-gamma(spot) as the sum across
   strikes of: `strike_gex × max(0, 1 - |strike - candidate_spot| / width)`
   or similar interpolation — this models "if spot were here, what would
   dealer gamma be?"
4. Find the candidate_spot where net-gamma changes sign → interpolate to
   get the zero-gamma level.
5. Write to `zero_gamma_levels` table.

## Files

**New (5 files):**

- `api/_lib/zero-gamma.ts` — pure calculator: `computeZeroGammaLevel(gexByStrike, spot, gridRange)` returns `{ level: number | null, confidence: number }`
- `api/cron/compute-zero-gamma.ts` — 1-min cron that queries latest
  `spot_gex`, calls the calculator, writes to `zero_gamma_levels`
- `api/zero-gamma.ts` — read endpoint: latest level + recent history
- `api/__tests__/zero-gamma.test.ts` — unit tests with synthetic GEX
  distributions (known zero-gamma locations)
- `api/__tests__/cron-compute-zero-gamma.test.ts` — cron handler test

**Modify:**

- `api/_lib/db-migrations.ts` — migration **82** (next available; 72 was
  taken by `futures_trade_ticks` when Task A shipped): `zero_gamma_levels`
  table
- `api/__tests__/db.test.ts` — mock sequence update
- `vercel.json` — register `4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5`
  (+1 offset from `fetch-strike-exposure` at `3,8,13,...` — ensures the
  source row is committed before we read it, repo convention for
  derivative jobs)
- `src/main.tsx` — add `/api/zero-gamma` to `initBotId({ protect: [...] })`

## Data

**Migration 72:**

```sql
CREATE TABLE zero_gamma_levels (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,              -- 'SPX' initially; 'SPY'/'QQQ' later
  spot NUMERIC(10,4) NOT NULL,
  zero_gamma NUMERIC(10,4),          -- nullable: insufficient data → NULL
  confidence NUMERIC(4,3),           -- 0-1 score based on curve steepness at crossing
  net_gamma_at_spot NUMERIC(14,2),   -- current dealer gamma notional $
  gamma_curve JSONB,                 -- optional: [{spot, net_gamma}, ...] for viz
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_zero_gamma_ticker_ts ON zero_gamma_levels (ticker, ts DESC);
```

**Cron registration:**

| Path                           | Schedule                                          |
| ------------------------------ | ------------------------------------------------- |
| `/api/cron/compute-zero-gamma` | `4,9,14,19,24,29,34,39,44,49,54,59 13-21 * * 1-5` |

Cadence: +1-minute offset from `fetch-strike-exposure` source (at
`3,8,13,...`) — ensures the source row is committed before we try to read
it, matching the repo's convention for derivative jobs (e.g.
`fetch-zero-dte-flow` at `4,9,14,...` after `fetch-flow-alerts` at
`0,5,10,...`). 5-min cadence also avoids writing 4-of-5 duplicate rows per
real snapshot.

**Volume estimate:** ~108 rows/day × 1 ticker = 108/day (~28K/year). Trivial.

## Thresholds / constants

- `GRID_POINTS` = 30 — candidate spots sampled around current level
- `GRID_RANGE_PCT` = 0.03 — ±3% of spot, matches IV anomaly OTM range
- `CONFIDENCE_MIN` = 0.5 — below this, store `zero_gamma` as NULL with the
  low-confidence flag (prevents downstream features trusting a noisy read)

## Decisions (locked 2026-04-23)

- **Data source:** `strike_exposures` table (migration 8), populated every
  5 min by `api/cron/fetch-strike-exposure.ts` from UW
  `/spot-exposures/expiry-strike`. Signed dealer gamma = `call_gamma_oi +
put_gamma_oi` (UW publishes signed per-side values; sum is signed per
  repo convention — see `api/_lib/build-features-gex.ts:77`).
- **Expiry scope:** 0DTE-only (`expiry = today`). Overrides spec's original
  open-question default of "combined book across all expiries." Rationale:
  this app is 0DTE-focused; 0DTE-only zero-gamma is most actionable for
  intraday regime-flip detection. Can add a combined-book variant later
  (e.g. `SPX-ALL` ticker) if needed for comparison.
- **Cadence:** 5-min cron at `4,9,14,...` — +1-minute offset from the
  `fetch-strike-exposure` source at `3,8,13,...`. Ensures the source row
  is committed before we read it (repo convention for derivative jobs,
  e.g. `fetch-zero-dte-flow`). Original spec said "every minute" but the
  source only updates every 5 min — 1-min cron would produce 4-of-5
  duplicate rows per real snapshot.
- **Auth posture:** owner-gated via `rejectIfNotOwner` after `checkBot`,
  matching sibling OPRA-derived endpoints (`spot-gex-history`,
  `greek-exposure-strike`, `gex-per-strike`). The `gamma_curve` response
  contains per-strike-derived aggregates from UW/OPRA data.
- **Migration id:** 82 (next available; 72 was taken by `futures_trade_ticks`
  when Task A shipped).
- **net_gamma_at_spot derivation:** closest grid point from calculator curve
  (approach A of three options). Grid step ~0.2% of spot is below
  monitoring noise; more elaborate interpolation adds machinery without
  meaningful precision gain.

## Open questions

1. **Interpolation method** — linear between strikes, or curve-fit? Start
   linear for MVP; revisit if the calculator produces jittery output
   over consecutive 5-min snapshots.

2. **Ticker scope** — SPX only for MVP? The detector context uses SPX/SPY/QQQ;
   Phase 1 is SPX only, expand later if SPY/QQQ zero-gamma turns out useful.

## Verification

- Unit tests with synthetic GEX distributions: construct a chain where the
  zero-gamma level is known by construction (e.g., symmetric straddle-heavy
  at strike X → zero-gamma = X). Calculator should return that value within
  0.1% tolerance.
- Live verification: compare the first few days of output against SpotGamma's
  published zero-gamma number if the user has a reference subscription.
- Integration: after shipping, verify the `iv_anomalies.context_snapshot`
  Phase 2 JSONB receives a non-null `zero_gamma_level` field within 1 minute
  of a detected anomaly.

## Out of scope

- Vanna and charm derived levels (extensions; same pattern but different
  signed-sum). Can follow the zero-gamma impl as template later.
- Per-expiry zero-gamma (0DTE-only vs full book). Revisit if combined-book
  level turns out too noisy.
- Frontend visualization — backend + endpoint only in this spec. UI can
  consume the endpoint and display on the existing gamma chart separately.

## Time estimate

**~1h** — pure calculator is ~15 LOC, cron handler is boilerplate, migration
trivial. Tests are the bulk of the work.
