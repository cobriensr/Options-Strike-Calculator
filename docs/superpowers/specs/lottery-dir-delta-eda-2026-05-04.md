# Lottery Dir-Delta Inversion EDA

**Date:** 2026-05-04
**Author:** Session continuation from lottery-otm-flow-eda
**Status:** Spec — pending user approval before implementation
**Predecessors:**

- [lottery-flow-inversion-exit-2026-05-04.md](./lottery-flow-inversion-exit-2026-05-04.md) — flow-inversion shipped (all-NCP)
- [lottery-otm-flow-eda-2026-05-04.md](./lottery-otm-flow-eda-2026-05-04.md) — OTM-NCP killed (-0.82pp)

---

## What this is

Test whether **delta-weighted directional flow** (`dir_delta_flow`) produces a stronger inversion-exit signal than the all-strikes net call/put premium we currently use. Theory: dir_delta captures the actual directional bet size (a $1M ATM call buy with delta 0.5 vs a $1M deep-OTM call buy with delta 0.1 have very different directional impact, but identical NCP), so it should be a cleaner signal of "net long delta added by buyers."

UW probe (2026-05-04) confirmed `/api/stock/{ticker}/greek-flow` is per-ticker AND works for arbitrary lottery tickers (verified RDDT). Retention extends to at least 2026-01-15. So we can do a real REST backfill, no parquet hack needed.

## What this is NOT

- **Not a production rollout.** Same as the OTM EDA: research first, ship-decision second. If dir_delta wins by ≥+3pp on lottery rate AND concentration check passes, open a follow-up spec for production wiring.
- **Not a multi-feature search.** Dir Delta only this iteration. Dir Vega and OTM-Dir-Delta variants get their own specs if Dir Delta succeeds.

---

## Goal

> Determine whether `dir_delta_flow`-based inversion beats all-NCP-based inversion on the same 47k-fire sample. Pre-committed decision: ship if ≥+3pp lottery rate, kill if ≤−2pp, tie if in between.

---

## Data dependencies

| Source                               | What we need                                                                      | Notes                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| UW REST `/stock/{ticker}/greek-flow` | Per-minute dir_delta_flow + dir_vega_flow + OTM variants for 51 tickers × 90 days | New table required (different schema from net-prem-ticks) |
| `lottery_finder_fires`               | Already populated                                                                 | No change                                                 |
| `exit_simulation_results.parquet`    | Existing all-NCP inversion results — for head-to-head                             | No change                                                 |

---

## Phases

### Phase 1 — Backend: schema + REST backfill

#### Task 1.1 — Migration: `greek_flow_per_ticker_history`

- [ ] Add migration to `api/_lib/db-migrations.ts` (next available ID; spec assumes #125 but check actual at write-time):

```sql
CREATE TABLE IF NOT EXISTS greek_flow_per_ticker_history (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  dir_delta_flow NUMERIC,
  dir_vega_flow NUMERIC,
  otm_dir_delta_flow NUMERIC,
  otm_dir_vega_flow NUMERIC,
  total_delta_flow NUMERIC,
  total_vega_flow NUMERIC,
  otm_total_delta_flow NUMERIC,
  otm_total_vega_flow NUMERIC,
  transactions INTEGER,
  volume INTEGER,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS greek_flow_per_ticker_history_ticker_ts_src_idx
  ON greek_flow_per_ticker_history (ticker, ts, source);
CREATE INDEX IF NOT EXISTS greek_flow_per_ticker_history_ticker_ts_idx
  ON greek_flow_per_ticker_history (ticker, ts DESC);
```

- [ ] Update `api/__tests__/db.test.ts`: applied list + expected output + counts (+4 SQL = +1 transaction). Verify against the actual current count at write-time.
- **Verify:** `npx vitest run api/__tests__/db.test.ts` passes.

#### Task 1.2 — `scripts/backfill-greek-flow.mjs`

Mirror of `scripts/backfill-net-prem-ticks.mjs` with these adaptations:

- Endpoint: `/stock/{ticker}/greek-flow?date=YYYY-MM-DD`
- Same 51-ticker lottery universe
- 90-day window with the fixed `getTradingDays()` (CT-aware) we shipped earlier
- Parse all 8 numeric fields (UW returns most as JSON strings — parseFloat each)
- Filter to 08:30–15:00 CT session window
- Batched INSERT (500/query) via `sql.query()` pattern
- ON CONFLICT (ticker, ts, source) DO NOTHING
- Resumability: same MAX(ts) per ticker check + BYPASS_RESUME env override
- Same semaphore=3 + jitter pacing, same 429 retry

**Verify:** Smoke test on 1 ticker × 2 days. Then full run. Expected ~570k rows (51 × ~63 trading days × ~390 min, with some gaps).

### Phase 2 — Re-run inversion simulation with dir_delta

#### Task 2.1 — `ml/experiments/lottery-dir-delta-eda/exit_simulation_dirdelta.py`

Adapt the inversion-exit simulator to read `dir_delta_flow` from the new table instead of `net_call_prem`/`net_put_prem` from `net_flow_per_ticker_history`. Critical difference:

- All-NCP: matched_side = call → net_call_prem; put → net_put_prem (separate series per side)
- Dir Delta: `dir_delta_flow` is a single signed series capturing both directions
  - Call fires (bullish): use `dir_delta_flow` as-is — slope >0 = bullish; inversion = slope <0
  - Put fires (bearish): negate it — slope >0 of `-dir_delta_flow` = bearish; inversion = slope <0 of `-dir_delta_flow`

Same exit logic otherwise (peak detection, slope inversion, 3-min persistence, EOD fallback). Output `exit_simulation_dirdelta_results.parquet`.

#### Task 2.2 — `ml/experiments/lottery-dir-delta-eda/compare.py`

Same shape as the OTM EDA's compare.py but comparing trail vs all-NCP-inversion vs dir-delta-inversion. Concentration check on dir-delta winners. Pre-committed verdict.

### Phase 3 — Decision

Pre-committed decision rules (same as OTM EDA):

- **Dir Delta wins** if lottery rate ≥ all-NCP + 3pp AND concentration check passes → open follow-up spec to ship as 5th policy
- **Tie** if delta is within ±2pp → keep all-NCP, document, move to Dir Vega
- **Loses** if delta is < −2pp → kill, move to Dir Vega

---

## Files to create

- `scripts/backfill-greek-flow.mjs`
- `ml/experiments/lottery-dir-delta-eda/README.md`
- `ml/experiments/lottery-dir-delta-eda/exit_simulation_dirdelta.py`
- `ml/experiments/lottery-dir-delta-eda/compare.py`
- `ml/experiments/lottery-dir-delta-eda/exit_simulation_dirdelta_results.parquet` (output)
- `ml/experiments/lottery-dir-delta-eda/compare.md` (output)

## Files modified

- `api/_lib/db-migrations.ts` (new migration)
- `api/__tests__/db.test.ts` (mock counts + applied list)

---

## Locked thresholds

| Constant           | Value                                      | Source                                 |
| ------------------ | ------------------------------------------ | -------------------------------------- |
| Backfill window    | 90 calendar days                           | UW retention (verified to ≥2026-01-15) |
| Universe           | LOTTERY_V3 ∪ LOTTERY_EXTENDED (51 tickers) | Same as prior EDAs                     |
| Session window     | 08:30–15:00 CT                             | `feedback_extended_hours`              |
| Inversion window   | 5min slope, 3min negative persistence      | Match prior work for fair comparison   |
| Decision threshold | ±3pp ship / ±2pp tie band                  | Match OTM spec                         |
| Batch insert size  | 500                                        | `feedback_batched_inserts`             |

---

## Open questions

1. **Sign convention for puts.** UW's `dir_delta_flow` is signed: positive = net long delta added (bullish), negative = net short delta (bearish). For put fires, the bullish-equivalent is negative `dir_delta_flow`. Negating before peak-detection keeps the existing logic intact. Default: negate for puts.

2. **Should we test OTM-dir-delta in this EDA too?** The endpoint returns `otm_dir_delta_flow` for free. Testing both adds little code. But per the leakage-discipline rule, run ONE test at a time. Default: dir-delta-only this round; OTM-dir-delta gets its own follow-up spec if dir-delta wins.

---

## Done when

- [ ] `greek_flow_per_ticker_history` populated for ≥45 tickers × ≥60 trading days
- [ ] `exit_simulation_dirdelta_results.parquet` covers the same fire_ids as the all-NCP simulation
- [ ] `compare.md` exists with verdict
- [ ] Decision recorded in this spec (appended)

---

## Notes

- Endpoint behavior verified 2026-05-04 with curl probe on RDDT — 388 rows for the most recent date, retention extends through at least 2026-01-15 (~4 months).
- Greek-flow timestamps are reported per-minute, same cadence as net-prem-ticks. The two endpoints don't share timestamps row-for-row but are both per-minute snapshots — separate tables avoids any reconciliation bugs.
