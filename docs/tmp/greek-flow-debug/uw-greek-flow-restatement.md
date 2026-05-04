# UW Greek Flow API — preliminary vs reconciled value divergence

**Endpoint:** `GET /api/stock/{ticker}/greek-flow?date=YYYY-MM-DD` (all-expiries variant)
**Reporter:** Charles O'Brien — strike-calculator app
**Reported:** 2026-05-03

## Summary

The per-minute aggregates returned by `/stock/{ticker}/greek-flow?date=…` during market hours don't match the values returned by the same endpoint after the close, for the same date and same minute. The post-close values match the UW web Greek Flow widget exactly. Any API consumer who fetches the data live and stores it permanently (e.g. an idempotent cron with `INSERT … ON CONFLICT DO NOTHING`) ends up with preliminary values that diverge from UW's own web display by **5–40×** across the session.

This is undocumented as far as we can find, and there's no field on the response indicating whether a row is preliminary vs reconciled.

## Reproducible example — SPY, 2026-05-01, `otm_dir_delta_flow`

We had a cron storing every minute returned by this endpoint during market hours, idempotent on `(ticker, timestamp)`. Below is what we stored vs what the **same endpoint** returns now (queried on 2026-05-03):

| Minute (CT) | Value stored from live cron | Same endpoint re-queried 2026-05-03 |
| ----------- | --------------------------: | ----------------------------------: |
| 08:30       |                   87,958.19 |                            5,539.23 |
| 08:31       |                  -53,579.61 |                         -106,080.16 |
| 08:32       |                   65,166.68 |                           46,736.37 |
| 08:33       |                    3,492.55 |                           71,413.99 |
| 08:34       |                   30,798.85 |                          -54,050.72 |
| 08:35       |                   34,044.71 |                          -69,054.85 |

Cumulative `otm_dir_delta_flow`:

| Reference point               | Stored from live | Re-queried 2026-05-03 | UW web tooltip     |
| ----------------------------- | ---------------: | --------------------: | ------------------ |
| Cumulative at 08:33 CT        |       103,037.80 |         **17,609.44** | **17,609.44** ✓    |
| End-of-session min cumulative |         -725,207 |        **-3,564,941** | ≈ **-3,570,000** ✓ |

The post-close API value (17,609.44) matches the UW web display exactly. The same applies to all eight `*_flow` columns, not just `otm_dir_delta_flow`.

## Multi-day stability check

To confirm post-close reconciliation has completed (the values are stable, not still drifting), we queried the endpoint twice with a 30-second gap on 2026-05-03 (Sunday) for each of the prior trading days:

| Date       | Ticks |    Cum EOD |    Cum max |    Cum min | Stable on 30s re-read |
| ---------- | ----: | ---------: | ---------: | ---------: | --------------------- |
| 2026-04-28 |   405 | +1,375,843 | +2,024,470 |    -68,125 | yes                   |
| 2026-04-29 |   406 |   -721,278 |   +113,763 | -1,161,612 | yes                   |
| 2026-04-30 |   406 |   +194,659 | +1,730,511 |   -175,337 | yes                   |
| 2026-05-01 |   405 |   -645,886 |    +17,609 | -3,564,941 | yes                   |

All four most-recent trading days are stable on a 30-second re-read, so the API does converge on a final value — we just don't know within what window post-close, and there's no signal in the response telling consumers when a row is final.

## Implication for API consumers

The natural pattern when ingesting per-minute data is `INSERT … ON CONFLICT (ticker, timestamp) DO NOTHING` — once a row exists you skip it on subsequent fetches. With this endpoint, that pattern silently produces a permanent mismatch with UW's own web display:

- Our stored cumulative for SPY on 2026-05-01 ended at **-96k**
- UW's web display shows the day ending around **-3.57M**
- Same date, same field, same source — different by **37×** in magnitude _and_ opposite-side trajectory

We've been running our dashboard for weeks against stored preliminary data without noticing, because it was internally self-consistent — it just didn't match anyone else's view of the same flow. Reconciling against the public web display is what surfaced the issue.

## Workaround we shipped

For anyone else hitting this:

1. Switch from `INSERT … ON CONFLICT DO NOTHING` to `INSERT … ON CONFLICT DO UPDATE SET …` so every minute-cadence cron run is itself a continuous intraday reconciliation.
2. Add a separate post-close pass (we run it at 22:00 UTC = 17:00 ET, one hour after close) that re-fetches the just-closed session and UPSERTs again, in case UW's final reconciliation lands after the last live cron tick at 21:59 UTC.
3. Backfill any historical dates whose stored values predate the UPSERT change.

## Asks (any one of these would have prevented the issue)

1. **Documentation** in the endpoint description noting per-minute aggregates may be restated as late prints / cancellations resolve, with a typical reconciliation window.
2. **A freshness field** on each response row — e.g. `reconciled: bool`, `as_of: timestamp` distinct from `timestamp`, or `revision: int`.
3. **An explicit `final=true` query flag** that returns only finalized bars, so cron consumers know when it's safe to stop re-fetching.

Happy to share full per-minute datasets across additional dates / tickers if useful for your team's investigation.

## Reproduction scripts

For reference, the probes used to generate this report:

- `docs/tmp/greek-flow-debug/probe_uw_endpoints.ts` — per-endpoint single-day probe at minute resolution.
- `docs/tmp/greek-flow-debug/multi_day_probe.mjs` — multi-day stability check (two reads 30s apart).
- `docs/tmp/greek-flow-debug/inspect_spy_may01.ts` — local DB introspection (used to retrieve the original stored live-cron values before we corrected them).
