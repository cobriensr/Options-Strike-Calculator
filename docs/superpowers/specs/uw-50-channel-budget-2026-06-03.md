# Surviving a 50-channel-per-ACCOUNT UW WS cap (2026-06-03)

## The reframe (read first)

If UW's "Channel subscription limit of 50 reached" is **per account** (not
per connection), then **multi-connection sharding does NOT help** — every
connection under the one account draws from the same 50-channel budget. The
problem changes from "split 260 channels across N sockets" to "**fit the most
valuable ≤50 channels into the budget**." This plan is that reallocation.

(If it turns out to be per-*connection*, ignore this plan — the fix is the
simpler connection-sharding sketch and we keep all 260 channels. Confirm with
UW before building either.)

## Current footprint vs the cap

260 channels = 86 tickers × {`option_trades:`, `net_flow:`, `gex_strike_expiry:`}
+ `flow-alerts` + `off_lit_trades`. Cap = 50. We are ~5× over.

## The key lever: global fan-out channels

The catalog has **global** channels that deliver ALL tickers on ONE
subscription (filter client-side), collapsing whole per-ticker families:

| per-ticker family (×86) | global replacement (×1) | tradeoff |
|---|---|---|
| `option_trades:<T>` | `option_trades` (firehose, 6–10M/day) | client-filter to our universe; higher ingest volume |
| `net_flow:<T>` | `interval_flow` (global) | **5-min** net-prem vs continuous → coarser chart/alignment; MUST verify payload carries per-ticker net call/put premium |
| `gex_strike_expiry:<T>` | **none exists** | stays per-ticker — the binding constraint |

## Proposed 50-channel budget

| channels | count | covers |
|---|---|---|
| `option_trades` (global) | 1 | trades → ws_option_trades (detection + tape), ALL tickers |
| `interval_flow` (global) | 1 | net-prem (5-min) → net-flow chart + alignment, ALL tickers |
| `flow-alerts` (global) | 1 | flow alerts |
| `off_lit_trades` (global) | 1 | dark pool |
| `gex_strike_expiry:<T>` | **46** | per-strike GEX for the 46 highest-value tickers |
| **total** | **50** | |

(Drop `market_tide` from the WS budget — it's REST-derivable; keep the slot
for a 46th GEX ticker.)

## What this preserves / degrades / loses — the cancel-decision view

- **Preserved (all 86 tickers):** lottery/silent-boom detection (still reads
  ws_option_trades), flow-alerts, dark pool, the contract tape.
- **Degraded:** net-flow drops from continuous to **5-min** resolution
  (interval_flow) — the net-flow chart + the alignment/inversion gate
  (`cum_ncp/npp`) get coarser. Acceptable for a cumulative line; verify it
  doesn't break the flow-inversion outcome metric.
- **Lost:** per-strike-per-expiry GEX for **~40 tickers** (only 46 of 86 fit).
  Periscope/GEX coverage shrinks to the prioritized set.

If coarse net-flow + GEX on only 46 of 86 tickers is unacceptable, a
50/account cap means the product can't be fully served on UW Advanced —
**canceling is a rational call**, and this plan quantifies exactly what you'd
be giving up to stay.

## Tasks (only if cap confirmed per-account AND you choose to stay)

- [ ] **Prereq A:** Probe `interval_flow` live — confirm payload has per-ticker
  net call/put premium + volume at 5-min cadence. → Verify: capture one frame,
  fields map to `ws_net_flow_per_ticker` columns. (Blocks the net_flow swap.)
- [ ] **Prereq B:** Confirm global `option_trades` firehose volume is drainable
  by the existing queue/batch pipeline at full-market rate. → Verify: soak test
  or back-of-envelope vs current ws_option_trades/day (~1.7M filtered today;
  firehose is 6–10M).
- [ ] **Task 1:** `option_trades` handler — add a ticker allow-list filter
  (it currently assumes per-ticker pre-filtering). → Verify: only universe
  tickers reach ws_option_trades; row volume sane.
- [ ] **Task 2:** New `interval_flow` handler → writes net-prem into
  `ws_net_flow_per_ticker` (or a 5-min sibling table). → Verify: net-flow chart
  renders from it.
- [ ] **Task 3:** Pick the 46 GEX tickers (V3 0DTE core + top single-names by
  fire volume); add `GEX_PRIORITY_TICKERS` to config. → Verify: list length 46.
- [ ] **Task 4:** Rewrite `config.channels` expansion: globals
  (`option_trades`, `interval_flow`, `flow-alerts`, `off_lit_trades`) + 46
  `gex_strike_expiry:<T>`; assert total ≤ 50 at Settings construction (fail
  fast). → Verify: `len(channels) == 50`.
- [ ] **Task 5:** Router/registry — register the new exact channels; ensure
  the "malformed frame" path now also surfaces a Sentry alert (the limit error
  was invisible for ~20h — see [[project_uw_50_channel_cap]]).
- [ ] **Phase Verification (LAST):** deploy to Railway; confirm
  `ws_net_flow_per_ticker` + `ws_option_trades` resume for the full universe and
  `ws_gex_strike_expiry` for the 46; zero "limit of 50 reached" in logs.

## Open questions
1. **Per-connection vs per-account?** THE gating fact. Per-connection → this
   plan is unnecessary (shard sockets instead). Confirm with UW first.
2. interval_flow net-prem fidelity (Prereq A) — if it lacks net call/put
   premium, net-flow can't be served at all under the cap.
3. Which 46 tickers get GEX (Task 3) — trader call.

## Constants
- UW WS cap (assumed worst case): 50 channels / account.
- Budget: 4 globals + 46 `gex_strike_expiry` = 50.
