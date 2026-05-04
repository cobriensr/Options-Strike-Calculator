# UW WebSocket GEX Channel Probe — 2026-05-03 (Sunday, market closed)

Probe script: `docs/tmp/gex-ticker-probe/probe.mjs`
Raw output: `docs/tmp/gex-ticker-probe/raw-output.log`

## Setup

- Single websocket connection to `wss://api.unusualwhales.com/socket?token=<UW_API_KEY>`
- Sent 8 join frames, one per channel: `gex_strike_expiry:{SPX,NDX,SPY,QQQ}` and `gex:{SPX,NDX,SPY,QQQ}`
- Waited 60 seconds for acks + payloads
- Token read from `.env.local` `UW_API_KEY`; never logged

## Results

| Ticker | `gex_strike_expiry:<T>` ack | `gex:<T>` ack | Payload (`gex_strike_expiry`) | Payload (`gex`) |
| ------ | --------------------------- | ------------- | ----------------------------- | --------------- |
| SPX    | ok                          | ok            | none (market closed)          | none            |
| NDX    | ok                          | ok            | none (market closed)          | none            |
| SPY    | ok                          | ok            | none (market closed)          | none            |
| QQQ    | ok                          | ok            | none (market closed)          | none            |

All 8 channels returned `status: "ok"` on join — no plan-tier rejections, no errors.

## Notes

- Zero data frames arrived in the 60-second window. Expected: market is closed
  (Sunday 2026-05-03 evening), and these channels stream during regular session
  hours / after-hours updates.
- Connection closed with code `1006` (abnormal — server-side close from our
  `ws.close()` after we exited the listen window). Not an error.
- Re-run during market hours (Mon-Fri 09:30–16:00 ET) to capture sample
  payloads. The probe script is idempotent and self-contained:
  `node docs/tmp/gex-ticker-probe/probe.mjs > docs/tmp/gex-ticker-probe/run-$(date +%Y%m%d-%H%M%S).log 2>&1`

## Raw run log

See `raw-output.log` in this directory (81 lines, line-delimited JSON).
