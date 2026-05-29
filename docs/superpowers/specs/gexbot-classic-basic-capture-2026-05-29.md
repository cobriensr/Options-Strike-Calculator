# GexBot `/classic` basic-response capture — revive the 10 dead snapshot columns

**Date:** 2026-05-29
**Status:** spec → implement

## Goal

Populate the 10 `gexbot_snapshots` columns that have been 100% NULL since the
table was created, by capturing GexBot's `/{ticker}/classic/{category}` **basic**
(non-maxchange) endpoint. This also auto-revives the `gex_zero_gamma` context
column on `silent_boom_alerts` / `lottery_finder_fires` (#180/#181), which reads
from `gexbot_snapshots` via `getLatestGexbotSnapshotAt()`.

## Root cause (verified 2026-05-29)

The `gexbot_snapshots` schema was built to the GexBot OpenAPI spec's
`orderflow_response` schema, which **lists** these 10 fields. But the **live**
`/orderflow/orderflow` payload omits all 10 (verified: 37 keys returned, none of
the 10). The fields are real and live — just on a different endpoint:

| Field | live `/orderflow` | live `/classic/{gex_zero}` (basic) |
| --- | --- | --- |
| `zero_gamma` | ❌ absent | ✅ `7589.17` |
| `sum_gex_vol`, `sum_gex_oi` | ❌ | ✅ |
| `major_pos_vol/oi`, `major_neg_vol/oi` | ❌ | ✅ |
| `delta_risk_reversal` | ❌ | ✅ |
| `min_dte`, `sec_min_dte` | ❌ | ✅ |

This is OpenAPI spec-vs-live drift (same pattern as the UW spec). Probes:
`scripts/_probe-gexbot-zerogamma.ts`, `_probe-gexbot-capture-recoverable.ts`,
`_probe-gexbot-live-endpoints.ts`.

## Design

**Endpoint:** `GET /{ticker}/classic/gex_zero` (basic_response, 0DTE bucket).
We capture only the `gex_zero` bucket — it's a 0DTE tool and the snapshot's
existing scalar columns are single-valued (not per-bucket). `gex_one`/`gex_full`
basic capture is out of scope (optional future research add via `api_capture`).

**Call budget:** +16 calls/min (one per ticker) on `fetch-gexbot-fast`:
112 → **128 calls/min**. Well within the existing concurrency cap (32) and the
60s `maxDuration`.

**Merge:** the orderflow body and the classic-gex_zero body are fetched as
separate tasks in the same tick. Before insert, merge per ticker: orderflow
supplies the 37 flow fields (z*/o*/dex/flow), classic-gex_zero supplies the 10
listed above. No field overlap — `spot`/`ticker`/`timestamp` stay sourced from
orderflow (canonical). `strikes`/`max_priors` from classic are ignored.

**Fail-open:** if the classic call fails for a ticker, its orderflow snapshot is
still stored with the 10 columns NULL (current behavior). No regression.

**No migration:** all 10 columns already exist in `gexbot_snapshots`. This change
only starts populating them. Forward-only — historical NULLs are not recoverable.

**#180/#181 auto-fix:** `detect-silent-boom` / `detect-lottery-fires` need NO
change — `getLatestGexbotSnapshotAt()` reads `gexbot_snapshots`, so `gex_zero_gamma`
(and the others) start filling forward automatically once snapshots carry them.

## Files

**Modify:**
- `api/_lib/gexbot-client.ts` — add `fetchClassicBasic(apiKey, ticker, category)`
  → `gexbotFetch('/{ticker}/classic/{category}')`. Fix the stale `fetchOrderflow`
  doc comment that claims orderflow returns `zero_gamma`/`strikes`/`delta_risk_reversal`.
- `api/cron/fetch-gexbot-fast.ts` — add `classic-basic` task kind (gex_zero only);
  collect results into a `Map<ticker, body>`; merge into the snapshot row in
  `storeSnapshots`. Update the header docstring (112 → 128, add the new endpoint).
- `api/__tests__/gexbot-client.test.ts` — test `fetchClassicBasic` path/URL.
- `api/__tests__/fetch-gexbot-fast.test.ts` — test the merge: orderflow + classic
  → one snapshot row with the 10 columns filled; classic-missing → row with NULLs.

**No new tables, env vars, or migrations.**

## Verification

- `npm run review` green.
- Re-run `scripts/_probe-gexbot-capture-2026-05-29.ts` after first prod tick:
  `zgNull%` should drop from 100% toward 0% for the 16 tickers.

## Open questions (defaults chosen)

- **Which bucket feeds the snapshot?** → `gex_zero` (0DTE). Default chosen.
- **Capture `gex_one`/`gex_full` too?** → No, out of scope. Revisit if dealer-state
  research wants full-DTE `zero_gamma`/`sum_gex`.
- **Backfill?** → Not possible (data was never captured). Forward-only.
