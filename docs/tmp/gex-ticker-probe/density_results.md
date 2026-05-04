# ws_gex_strike_expiry density probe

Generated: 2026-05-04T00:56:55.033Z
Probe day (RTH UTC window): 2026-05-01T13:30:00Z → 2026-05-01T20:00:00Z
Total RTH minutes assumed: 390

## Probe 1 — Coverage span per ticker

| ticker | min_ts                   | max_ts                   | rows | expiries | strikes | distinct_minutes |
| ------ | ------------------------ | ------------------------ | ---- | -------- | ------- | ---------------- |
| QQQ    | 2026-02-09T21:14:00.000Z | 2026-05-01T20:14:00.000Z | 8340 | 58       | 317     | 61               |
| SPY    | 2026-02-09T21:14:00.000Z | 2026-05-01T20:14:00.000Z | 9318 | 58       | 382     | 72               |

## Probe 2 — Per (ticker, expiry) minute density on 2026-05-01 RTH (390 min)

| ticker | expiry | distinct_minutes | minute_coverage_pct | strikes | rows |
| ------ | ------ | ---------------- | ------------------- | ------- | ---- |

### Approx closing spot used for ATM strike picks

| ticker | spot |
| ------ | ---- |
| QQQ    | n/a  |
| SPY    | n/a  |

## Probe 3 — 20 strikes nearest spot for 2026-05-01 0DTE expiry

### QQQ: spot unknown, skipped

### SPY: spot unknown, skipped

## Probe 4 — Gap distribution for QQQ 2026-05-01 strike=null

No ATM strike resolved; skipped.

## Probe 4 — Gap distribution for SPY 2026-05-01 strike=null

No ATM strike resolved; skipped.

---

## Follow-up Probe — actual ts_minute layout

### Distinct ts_minute values per (ticker, day) — last 14 days

| ticker | day        | distinct_minutes | first_ts | last_ts  | rows |
| ------ | ---------- | ---------------- | -------- | -------- | ---- |
| QQQ    | 2026-05-01 | 1                | 20:14:00 | 20:14:00 | 244  |
| SPY    | 2026-05-01 | 1                | 20:14:00 | 20:14:00 | 224  |
| QQQ    | 2026-04-30 | 1                | 20:14:00 | 20:14:00 | 192  |
| SPY    | 2026-04-30 | 2                | 20:13:00 | 20:14:00 | 231  |
| QQQ    | 2026-04-29 | 1                | 20:14:00 | 20:14:00 | 167  |
| SPY    | 2026-04-29 | 1                | 20:14:00 | 20:14:00 | 151  |
| QQQ    | 2026-04-28 | 1                | 20:14:00 | 20:14:00 | 151  |
| SPY    | 2026-04-28 | 1                | 20:14:00 | 20:14:00 | 147  |
| QQQ    | 2026-04-27 | 1                | 20:14:00 | 20:14:00 | 143  |
| SPY    | 2026-04-27 | 1                | 20:14:00 | 20:14:00 | 152  |
| QQQ    | 2026-04-24 | 1                | 20:14:00 | 20:14:00 | 209  |
| SPY    | 2026-04-24 | 1                | 20:14:00 | 20:14:00 | 207  |
| QQQ    | 2026-04-23 | 1                | 20:14:00 | 20:14:00 | 140  |
| SPY    | 2026-04-23 | 1                | 20:14:00 | 20:14:00 | 158  |
| QQQ    | 2026-04-22 | 1                | 20:14:00 | 20:14:00 | 148  |
| SPY    | 2026-04-22 | 1                | 20:14:00 | 20:14:00 | 157  |
| QQQ    | 2026-04-21 | 1                | 20:14:00 | 20:14:00 | 155  |
| SPY    | 2026-04-21 | 1                | 20:14:00 | 20:14:00 | 174  |
| QQQ    | 2026-04-20 | 1                | 20:14:00 | 20:14:00 | 156  |
| SPY    | 2026-04-20 | 1                | 20:14:00 | 20:14:00 | 176  |
| QQQ    | 2026-04-17 | 1                | 20:14:00 | 20:14:00 | 226  |
| SPY    | 2026-04-17 | 1                | 20:14:00 | 20:14:00 | 259  |
| QQQ    | 2026-04-16 | 1                | 20:14:00 | 20:14:00 | 132  |
| SPY    | 2026-04-16 | 2                | 20:13:00 | 20:14:00 | 155  |
| QQQ    | 2026-04-15 | 1                | 20:14:00 | 20:14:00 | 128  |
| SPY    | 2026-04-15 | 1                | 20:14:00 | 20:14:00 | 148  |
| QQQ    | 2026-04-14 | 1                | 20:14:00 | 20:14:00 | 124  |
| SPY    | 2026-04-14 | 1                | 20:14:00 | 20:14:00 | 149  |
| QQQ    | 2026-04-13 | 1                | 20:14:00 | 20:14:00 | 129  |
| SPY    | 2026-04-13 | 1                | 20:14:00 | 20:14:00 | 145  |
| QQQ    | 2026-04-10 | 1                | 20:14:00 | 20:14:00 | 135  |
| SPY    | 2026-04-10 | 1                | 20:14:00 | 20:14:00 | 202  |
| QQQ    | 2026-04-09 | 1                | 20:14:00 | 20:14:00 | 123  |
| SPY    | 2026-04-09 | 2                | 20:13:00 | 20:14:00 | 136  |
| QQQ    | 2026-04-08 | 1                | 20:14:00 | 20:14:00 | 108  |
| SPY    | 2026-04-08 | 1                | 20:14:00 | 20:14:00 | 142  |
| QQQ    | 2026-04-07 | 1                | 20:14:00 | 20:14:00 | 106  |
| SPY    | 2026-04-07 | 1                | 20:14:00 | 20:14:00 | 139  |
| QQQ    | 2026-04-06 | 1                | 20:14:00 | 20:14:00 | 108  |
| SPY    | 2026-04-06 | 1                | 20:14:00 | 20:14:00 | 140  |
| QQQ    | 2026-04-02 | 1                | 20:14:00 | 20:14:00 | 148  |
| SPY    | 2026-04-02 | 1                | 20:14:00 | 20:14:00 | 198  |
| QQQ    | 2026-04-01 | 1                | 20:14:00 | 20:14:00 | 125  |
| SPY    | 2026-04-01 | 1                | 20:14:00 | 20:14:00 | 160  |
| QQQ    | 2026-03-31 | 1                | 20:14:00 | 20:14:00 | 234  |
| SPY    | 2026-03-31 | 1                | 20:14:00 | 20:14:00 | 311  |
| QQQ    | 2026-03-30 | 1                | 20:14:00 | 20:14:00 | 108  |
| SPY    | 2026-03-30 | 1                | 20:14:00 | 20:14:00 | 136  |
| QQQ    | 2026-03-27 | 1                | 20:14:00 | 20:14:00 | 149  |
| SPY    | 2026-03-27 | 1                | 20:14:00 | 20:14:00 | 183  |
| QQQ    | 2026-03-26 | 1                | 20:14:00 | 20:14:00 | 122  |
| SPY    | 2026-03-26 | 1                | 20:14:00 | 20:14:00 | 168  |
| QQQ    | 2026-03-25 | 1                | 20:14:00 | 20:14:00 | 122  |
| SPY    | 2026-03-25 | 1                | 20:14:00 | 20:14:00 | 170  |
| QQQ    | 2026-03-24 | 1                | 20:14:00 | 20:14:00 | 126  |
| SPY    | 2026-03-24 | 1                | 20:14:00 | 20:14:00 | 165  |
| QQQ    | 2026-03-23 | 2                | 10:27:00 | 20:14:00 | 119  |
| SPY    | 2026-03-23 | 2                | 10:26:00 | 20:14:00 | 171  |
| QQQ    | 2026-03-20 | 1                | 20:14:00 | 20:14:00 | 217  |
| SPY    | 2026-03-20 | 1                | 20:14:00 | 20:14:00 | 253  |

### All distinct ts_minute values on 2026-05-01 (SPY)

Count: 1

- 2026-05-01T20:14:00.000Z

### Hour-of-day histogram for ts_minute (UTC), all data, both tickers

| hour_utc | rows  | distinct_ts |
| -------- | ----- | ----------- |
| 10       | 46    | 2           |
| 11       | 18    | 1           |
| 20       | 12120 | 50          |
| 21       | 5474  | 20          |

### Latest 5 ts_minute snapshots for SPY: expiry coverage and row count

| ts_minute                | expiries | strikes | rows | rows_with_price |
| ------------------------ | -------- | ------- | ---- | --------------- |
| 2026-05-01T20:14:00.000Z | 1        | 224     | 224  | 224             |
| 2026-04-30T20:14:00.000Z | 1        | 30      | 30   | 30              |
| 2026-04-30T20:13:00.000Z | 1        | 201     | 201  | 201             |
| 2026-04-29T20:14:00.000Z | 1        | 151     | 151  | 151             |
| 2026-04-28T20:14:00.000Z | 1        | 147     | 147  | 147             |

### 0DTE (expiry=2026-05-01) ts_minute snapshots, per ticker

| ticker | ts_minute                | strikes |
| ------ | ------------------------ | ------- |
| QQQ    | 2026-05-01T20:14:00.000Z | 244     |
| SPY    | 2026-05-01T20:14:00.000Z | 224     |

---

## Verdict

The table is **NOT** intraday — it is a once-per-day end-of-session
snapshot.

- 80 calendar days of history (2026-02-09 → 2026-05-01) yields only 61
  distinct `ts_minute` values for QQQ and 72 for SPY. ~1 per day.
- Every recent day has exactly **1** `ts_minute`, almost always
  `20:14:00 UTC` (~16:14 ET, just after RTH close). A handful of days
  have a second neighboring minute (`20:13:00`) — that is restatement
  noise, not a stream.
- The 0DTE expiry on 2026-05-01 has exactly **1** ts_minute (`20:14:00Z`)
  for both SPY and QQQ. There is no 09:31, 09:32, 10:00, etc.
- Hour-of-day histogram: 99% of all distinct ts_minute values fall in
  UTC hour 20 (50 ts) or 21 (20 ts). RTH morning (UTC 13–19) is empty.
- The handler in `uw-stream/src/handlers/gex_strike_expiry.py` is
  capable of per-minute writes (truncates payload timestamp to minute,
  UPSERTs on `(ticker, expiry, strike, ts_minute)`), so the schema and
  daemon design support intraday density. The producer is just not
  emitting intraday on Railway today — the data we have looks like a
  single end-of-day pull or a daemon that only receives one push from
  UW per session.

**Server-side intraday Δ% over 1m / 5m / 10m / 15m / 30m windows is
NOT possible from this table as currently populated.** A `LAG OVER
PARTITION BY (ticker, expiry, strike) ORDER BY ts_minute` would just
return NULL for every row (no prior row inside the day) or compare
today's EOD snapshot to yesterday's EOD snapshot — which is a
day-over-day Δ%, not an intraday window.

## Path forward (any one)

1. **Fix the producer first.** Confirm the `uw-stream` daemon for the
   `gex_strike_expiry:SPY` / `:QQQ` channels is actually running and
   subscribed during RTH on Railway. Once it ships per-minute UPSERTs,
   re-run this probe; if density is ≥ 95% per minute the LAG approach
   becomes viable.
2. **Pivot to client-side accumulation.** Keep the existing pattern
   (`Snapshot[]` ring buffer in the GEX Landscape component, per-poll
   snapshot, `computeDeltaMap` on the client) and skip the server-side
   refactor. The current client-side code already handles missing
   intervals via `findClosestSnapshot(toleranceMs)`.
3. **Day-over-day Δ% only.** If the EOD snapshot is the actual product,
   the only Δ% the table can serve is N-day-over-N-day at the close,
   not 1m/5m/10m/15m/30m intraday windows.
