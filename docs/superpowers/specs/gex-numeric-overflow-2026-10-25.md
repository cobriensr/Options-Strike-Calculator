# GEX numeric field overflow (2026-10-25)

## Goal

Widen the capped greek columns on `gex_strike_0dte`, `strike_exposures` and
`spot_exposures` from `NUMERIC(20,4)` to `NUMERIC(30,4)` so end-of-day 0DTE
charm stops failing whole inserts.

## Root cause

`NUMERIC(20,4)` holds absolute values below 10^16. UW's 0DTE charm grows
without bound as expiry approaches (delta snaps to 0 or 1 in the last
minutes), and October's 0DTE open interest pushed the closing spike past the
cap:

| Month   | Max \|charm\| in `spot_exposures`     |
| ------- | ------------------------------------- |
| 2026-07 | 4.52e15                               |
| 2026-09 | 4.77e15                               |
| 2026-10 | 9.56e15 (stored); failing rows > 1e16 |

Intraday shape on 2026-10-22 (`gex_strike_0dte`, max per ET hour): 6.9e12 at
09:00, 3.1e14 at 14:00, 3.6e15 at 15:00, 9.05e15 at 16:00. Every
`fetch-gex-0dte` failure landed between 15:58 and 16:05 ET. Gamma, delta and
vanna stay below 0.1% of the cap; only charm overflows. Other tables
with capped greek columns (`greek_exposure`, `greek_exposure_strike`,
`nope_ticks`, `periscope_lottery_fires`, `training_features`) use at most 1%
of their caps.

Reproduced on PGlite (PostgreSQL 18.3): 1.5e16 into `NUMERIC(20,4)` raises
`22003 numeric field overflow` from `apply_typmod`, the production error.

## Sentry issues

| Issue | Writer                        | Events | Failure shape                                                                                            |
| ----- | ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| HS    | `fetch-gex-0dte`              | 29     | One multi-row INSERT per minute; whole minute lost                                                       |
| J1    | `fetch-spot-gex`              | 11     | Per-row inserts behind a high-water mark; the overflowing row blocks every later row until the day rolls |
| HT    | `rollup-ws-gex-strike-expiry` | 4      | One INSERT...SELECT per day; whole day lost (10-12, 10-13, 10-20, 10-21)                                 |
| J0    | `fetch-strike-all`            | 2      | Prior-day close row re-fetched at 09:28 ET                                                               |

Loss: 29 minutes of 0DTE strike data, the 16:00 ET tick of 10-19 in
`spot_exposures`, and four days of WS rollup. `ws_gex_strike_expiry` keeps
about one day, so the rollup days cannot be re-copied.

## Fix (single phase)

Migration #191: one `ALTER TABLE ... ALTER COLUMN ... TYPE NUMERIC(30,4)` per
table covering every `NUMERIC(20,4)` column (18 on `gex_strike_0dte`, 16 on
`strike_exposures`, 9 on `spot_exposures`). `strike`/`price`
(`NUMERIC(10,2)`) are unchanged.

- **Metadata-only.** Raising precision at the same scale needs no table
  rewrite and no index rebuild (no index covers these columns). Verified on
  PGlite: relfilenode unchanged, rows kept. A scale change does rewrite, so
  the scale stays 4.
- **Scale 4 kept on purpose.** UW sends some values with 28 decimal places;
  unconstrained `NUMERIC` would store them all across 59M `strike_exposures`
  rows. `NUMERIC(30,4)` keeps today's rounding and lifts the cap to 10^26.
- **`SET LOCAL lock_timeout`** first in the transaction, so the ACCESS
  EXCLUSIVE lock fails fast instead of queueing writers behind a long read.

### Files

- `api/_lib/db-migrations.ts` — migration #191
- `api/__tests__/db.test.ts` — applied-migrations mock, expected output, call count
- `api/__tests__/gex-numeric-widen-pglite.test.ts` — PGlite regression test:
  overflow before, no rewrite, 1.5e16 stores after, scale-28 input rounds to 4

### Data dependencies

Production apply is manual (`OWNER_SECRET` is empty, so `/api/journal/migrate`
401s). The owner runs the same statements plus the `schema_migrations` insert
in one transaction before Monday's close. `audit-migration-drift` warns at
12:00 UTC until it is applied.

Paste this block into psql as one unit:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE gex_strike_0dte
  ALTER COLUMN call_gamma_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_gamma_vol TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_vol  TYPE NUMERIC(30,4),
  ALTER COLUMN call_gamma_ask TYPE NUMERIC(30,4),
  ALTER COLUMN call_gamma_bid TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_ask  TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_bid  TYPE NUMERIC(30,4),
  ALTER COLUMN call_charm_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_charm_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_charm_vol TYPE NUMERIC(30,4),
  ALTER COLUMN put_charm_vol  TYPE NUMERIC(30,4),
  ALTER COLUMN call_delta_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_delta_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_vanna_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_vanna_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_vanna_vol TYPE NUMERIC(30,4),
  ALTER COLUMN put_vanna_vol  TYPE NUMERIC(30,4);

ALTER TABLE strike_exposures
  ALTER COLUMN call_gamma_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_gamma_ask TYPE NUMERIC(30,4),
  ALTER COLUMN call_gamma_bid TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_ask  TYPE NUMERIC(30,4),
  ALTER COLUMN put_gamma_bid  TYPE NUMERIC(30,4),
  ALTER COLUMN call_charm_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_charm_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_charm_ask TYPE NUMERIC(30,4),
  ALTER COLUMN call_charm_bid TYPE NUMERIC(30,4),
  ALTER COLUMN put_charm_ask  TYPE NUMERIC(30,4),
  ALTER COLUMN put_charm_bid  TYPE NUMERIC(30,4),
  ALTER COLUMN call_delta_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_delta_oi   TYPE NUMERIC(30,4),
  ALTER COLUMN call_vanna_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN put_vanna_oi   TYPE NUMERIC(30,4);

ALTER TABLE spot_exposures
  ALTER COLUMN gamma_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN gamma_vol TYPE NUMERIC(30,4),
  ALTER COLUMN gamma_dir TYPE NUMERIC(30,4),
  ALTER COLUMN charm_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN charm_vol TYPE NUMERIC(30,4),
  ALTER COLUMN charm_dir TYPE NUMERIC(30,4),
  ALTER COLUMN vanna_oi  TYPE NUMERIC(30,4),
  ALTER COLUMN vanna_vol TYPE NUMERIC(30,4),
  ALTER COLUMN vanna_dir TYPE NUMERIC(30,4);

INSERT INTO schema_migrations (id, description) VALUES (191, 'Widen the greek columns of gex_strike_0dte, strike_exposures and spot_exposures from NUMERIC(20,4) to NUMERIC(30,4) because 0DTE charm near the close exceeds 1e16, the NUMERIC(20,4) cap. Scale stays 4, so the change is metadata-only with no table rewrite.');
COMMIT;

ANALYZE gex_strike_0dte, strike_exposures, spot_exposures;
```

`BEGIN` matters because outside a transaction block `SET LOCAL` is a no-op
(Postgres only warns) and each `ALTER TABLE` would commit on its own.
`ANALYZE` matters because `ALTER COLUMN ... TYPE` drops the altered columns'
`pg_statistic` rows even when nothing is rewritten (checked on PGlite), so the
planner has no statistics for them until it runs.

## Out of scope (reported, not fixed here)

- `fetch-gex-0dte` catches the batch insert error and still reports `success`
  (R4).
- `fetch-spot-gex` per-row inserts behind the high-water mark: any row-level
  error stalls the day (R5 shape; no remaining trigger after this fix).
- `rollup-ws-gex-strike-expiry` wrote no WS rows on 10-15, 10-16, 10-19,
  10-22 and 10-23, days with no overflow event. Separate cause, not yet
  diagnosed.

## Thresholds

- New type: `NUMERIC(30,4)` (cap 10^26, scale 4)
- `lock_timeout`: 5s
