# Strike Battle Map + Dealer Regime Tile — spec

**Date:** 2026-05-03
**Owner:** Charles O'Brien
**Status:** drafted, awaiting build approval

## Goal

Add two complementary 0DTE direction-prediction surfaces driven by the UW WebSocket `gex_strike_expiry:<TICKER>` and `gex:<TICKER>` channels:

1. **Strike Battle Map** — per-strike grid showing customer OTM directional flow vs dealer net gamma at the same strikes, so the trader can see at a glance which strikes are magnets (pin candidates) and which are amplifiers (cascade risk).
2. **Dealer Regime Tile** — a single-glance tile next to the Greek Flow Verdict that classifies dealer-mechanic regime (long-γ / short-γ / zero-flip / charm-pin direction), so the verdict's "Bull confluence" or "Pin / harvest" label is qualified by what dealers _will be forced to do_.

These two surfaces are derived from the same data (UW WS GEX feeds), share the ingestion pipeline, and ship in two phases (Battle Map first, Regime Tile second).

## Why

After fixing the `vega_flow_etf` data divergence, the four-panel Greek Flow + Verdict dashboard is correct but still tells you only about _customer intent_. Direction prediction needs a second axis — what dealers will _mechanically_ do once price arrives at a given strike — to distinguish:

- "Bull confluence + dealers short γ at top wall" → amplification, take size
- "Bull confluence + dealers long γ at top wall" → dampened up-move, smaller size
- "Pin/harvest + dealers long charm at K" → strong magnet to K
- Bullish tape + zero-γ flip nearby → vol expansion risk, stand down

Today TRACE/Periscope provide this via screenshot-driven Claude analysis (event-driven, manual). The UW WS GEX feeds give us a _continuous, real-time_ programmatic source for the same underlying mechanics. They don't replace TRACE/Periscope; they fill the always-on dashboard slot.

## Phasing

Two independently-shippable phases. Phase 1 has more visual real estate and more value standalone; Phase 2 is small but high-leverage atop the existing Verdict tile.

### Phase 1 — Strike Battle Map

**Scope estimate:** 1–2 days.

Renders, for each of SPY and QQQ:

- The 10 nearest 0DTE OTM strikes (5 above spot for calls, 5 below for puts), x-axis sorted
- For each strike: two stacked horizontal mini-bars
  - **Top:** customer cumulative OTM dir delta at that strike for today (from `flow-per-strike-intraday`, sign-colored green/red)
  - **Bottom:** dealer net gamma at that strike (from new `ws_gex_strike_expiry` table filtered to today's expiry; net = `call_gamma_oi + put_gamma_oi`, sign-colored blue/orange)
- Strike highlight: bold border on the top-1 customer-flow strike (the magnet candidate)
- Optional third row: charm pressure at strike (smaller tint bar) — power-hour pinning vector
- Tooltip per strike showing exact flow, gamma, charm, vanna values

### Phase 2 — Dealer Regime Tile

**Scope estimate:** half a day.

A small color-coded tile adjacent to the existing Verdict tile in `GreekFlowPanel`. Reads from new `ws_gex` table (whole-ticker GEX, one row per minute per ticker). Classifies into one of:

- **Long-γ / dampening** — net γ ≫ 0, dealers absorb both directions
- **Short-γ / amplifying** — net γ ≪ 0, dealers chase moves
- **Zero-flip risk** — abs(net γ) < threshold AND price near zero-gamma level
- **Charm pin (EOD)** — high charm magnitude in last hour, pin direction labeled

One line of "amplification regime" / "dampening regime" / "zero-flip risk" text underneath. Visible whenever the Verdict tile is — they read together.

## Files to create / modify

### Phase 1 — Strike Battle Map

**New (Python daemon):**

- `uw-stream/src/handlers/gex_strike_expiry.py` — handler matching the `flow_alerts.py` pattern; transforms WS payload into `ws_gex_strike_expiry` row, batched UPSERT.
- `uw-stream/tests/test_gex_strike_expiry.py` — unit test for the transform.
- `uw-stream/tests/fixtures/gex_strike_expiry_sample.json` — captured WS payload for fixture.

**Modified (Python daemon):**

- `uw-stream/src/main.py` — subscribe to `gex_strike_expiry:SPY` and `gex_strike_expiry:QQQ`; route to handler.
- `uw-stream/src/router.py` — register the new handler if dispatch table is centralized.
- `uw-stream/README.md` — note the two new channels.

**New (api):**

- `api/gex-strike-expiry.ts` — read endpoint. Query params: `ticker=SPY|QQQ`, `expiry=YYYY-MM-DD` (default = today ET), `at=ISO` (optional, for historical scrub). Owner-or-guest auth tier. Returns per-strike rows joined with same-day `flow-per-strike-intraday` cumulative dir delta.
- `api/__tests__/endpoint-gex-strike-expiry.test.ts` — endpoint tests (auth, empty, happy path, error).
- `api/_lib/db-gex-strike-expiry.ts` — query helpers (read-side; ingestion is daemon-owned).

**New (frontend):**

- `src/hooks/useGexStrikeExpiry.ts` — fetches the read endpoint, polls every 60s during market hours.
- `src/components/StrikeBattleMap/index.tsx` — section component, lays out SPY + QQQ side by side.
- `src/components/StrikeBattleMap/StrikeRow.tsx` — single strike row (flow bar + gamma bar + optional charm).
- `src/components/StrikeBattleMap/concentration.ts` — pure function computing top-N concentration ratio + magnet-strike detection.
- `src/components/StrikeBattleMap/__tests__/concentration.test.tsx` — test the pure logic.
- `src/__tests__/components/StrikeBattleMap.test.tsx` — render + happy-path tests.

**Modified (frontend):**

- `src/App.tsx` — mount `<StrikeBattleMap marketOpen={...} />` next to (or below) `<GreekFlowPanel />`.
- `src/main.tsx` — add `/api/gex-strike-expiry` to the `botid` `protect` array.

**Modified (DB schema + tests):**

- `api/_lib/db-migrations.ts` — new migration for `ws_gex_strike_expiry` table (next sequential id).
- `api/__tests__/db.test.ts` — applied-migrations mock + expected output + SQL call count update.

**Modified (vercel config):**

- `vercel.json` — no new cron in Phase 1 (WS daemon is on Railway). No change unless we add an ingestion-monitor cron later.

### Phase 2 — Dealer Regime Tile

**New (Python daemon):**

- `uw-stream/src/handlers/gex.py` — whole-ticker GEX handler.
- `uw-stream/tests/test_gex.py` — unit test.
- `uw-stream/tests/fixtures/gex_sample.json` — fixture.

**Modified (Python daemon):**

- `uw-stream/src/main.py` — subscribe `gex:SPY` and `gex:QQQ`.
- `uw-stream/src/router.py` — register handler.

**New (api):**

- `api/dealer-regime.ts` — read endpoint, returns latest `ws_gex` row per ticker plus regime classification + `/api/zero-gamma` overlay.
- `api/__tests__/endpoint-dealer-regime.test.ts` — endpoint tests.
- `api/_lib/dealer-regime-classifier.ts` — pure classifier (ws_gex row + zero-gamma → `'long-gamma' | 'short-gamma' | 'zero-flip-risk' | 'charm-pin'`).
- `api/_lib/__tests__/dealer-regime-classifier.test.ts` — pure-function test (covers all four regimes + edge cases).

**New (frontend):**

- `src/components/GreekFlowPanel/DealerRegime.tsx` — render-only tile.
- `src/hooks/useDealerRegime.ts` — fetches the endpoint.
- `src/components/GreekFlowPanel/__tests__/DealerRegime.test.tsx` — render tests.

**Modified (frontend):**

- `src/components/GreekFlowPanel/index.tsx` — include `<DealerRegime spy={...} qqq={...} />` next to the Verdict tile.
- `src/main.tsx` — add `/api/dealer-regime` to botid `protect`.

**Modified (DB schema + tests):**

- `api/_lib/db-migrations.ts` — migration for `ws_gex` table.
- `api/__tests__/db.test.ts` — update for new migration.

## Data dependencies

### New tables

**`ws_gex_strike_expiry`** (Phase 1):

```sql
CREATE TABLE IF NOT EXISTS ws_gex_strike_expiry (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT        NOT NULL,
  expiry          DATE        NOT NULL,
  strike          NUMERIC     NOT NULL,
  ts_minute       TIMESTAMPTZ NOT NULL,  -- UPSERT key, truncated to minute
  price           NUMERIC,
  call_gamma_oi   NUMERIC,
  put_gamma_oi    NUMERIC,
  call_charm_oi   NUMERIC,
  put_charm_oi    NUMERIC,
  call_vanna_oi   NUMERIC,
  put_vanna_oi    NUMERIC,
  call_gamma_vol  NUMERIC,
  put_gamma_vol   NUMERIC,
  call_charm_vol  NUMERIC,
  put_charm_vol   NUMERIC,
  call_vanna_vol  NUMERIC,
  put_vanna_vol   NUMERIC,
  call_gamma_ask_vol NUMERIC,
  call_gamma_bid_vol NUMERIC,
  put_gamma_ask_vol  NUMERIC,
  put_gamma_bid_vol  NUMERIC,
  call_charm_ask_vol NUMERIC,
  call_charm_bid_vol NUMERIC,
  put_charm_ask_vol  NUMERIC,
  put_charm_bid_vol  NUMERIC,
  call_vanna_ask_vol NUMERIC,
  call_vanna_bid_vol NUMERIC,
  put_vanna_ask_vol  NUMERIC,
  put_vanna_bid_vol  NUMERIC,
  raw_payload     JSONB,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, expiry, strike, ts_minute)
);
CREATE INDEX idx_ws_gex_se_ticker_expiry_ts
  ON ws_gex_strike_expiry (ticker, expiry, ts_minute DESC);
CREATE INDEX idx_ws_gex_se_ticker_strike_ts
  ON ws_gex_strike_expiry (ticker, strike, ts_minute DESC);
```

UW pushes this channel as fast as the underlying changes. Daemon truncates `ts_minute` to whole-minute boundaries and UPSERTs (last write wins per minute), keeping volume bounded. WS DataMartin's intraday restatement habit (confirmed for greek-flow) makes "last write wins per minute" the right model.

**`ws_gex`** (Phase 2):

```sql
CREATE TABLE IF NOT EXISTS ws_gex (
  id              BIGSERIAL PRIMARY KEY,
  ticker          TEXT        NOT NULL,
  ts_minute       TIMESTAMPTZ NOT NULL,
  price           NUMERIC,
  gamma_per_one_percent_move_oi    NUMERIC,
  delta_per_one_percent_move_oi    NUMERIC,  -- nullable: UW emits "" sometimes
  charm_per_one_percent_move_oi    NUMERIC,
  vanna_per_one_percent_move_oi    NUMERIC,
  gamma_per_one_percent_move_vol   NUMERIC,
  delta_per_one_percent_move_vol   NUMERIC,
  charm_per_one_percent_move_vol   NUMERIC,
  vanna_per_one_percent_move_vol   NUMERIC,
  gamma_per_one_percent_move_dir   NUMERIC,
  charm_per_one_percent_move_dir   NUMERIC,
  vanna_per_one_percent_move_dir   NUMERIC,
  raw_payload     JSONB,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticker, ts_minute)
);
CREATE INDEX idx_ws_gex_ticker_ts ON ws_gex (ticker, ts_minute DESC);
```

### External APIs

- **UW WebSocket** (Advanced plan required) at `wss://api.unusualwhales.com/socket?token=$UW_API_KEY`. Channels: `gex_strike_expiry:SPY`, `gex_strike_expiry:QQQ`, `gex:SPY`, `gex:QQQ`.
- **Existing `/api/zero-gamma`** read endpoint, used by Dealer Regime classifier.
- **Existing `flow-per-strike-intraday` data** (table populated by `fetch-strike-exposure.ts` cron), used by Strike Battle Map for the customer-flow bars.

### Env vars

No new env vars. `UW_API_KEY` already used by the daemon.

### Daemon throughput notes

`gex_strike_expiry:<TICKER>` fan-out depends on strike count and update frequency. SPY 0DTE has ~80 active strikes at any given time; UW pushes updates every few seconds. Estimated 1–10 writes/second per ticker. The existing batched-flush handler pattern in `flow_alerts.py` handles this load with margin.

`gex:<TICKER>` is one row per minute per ticker — trivial volume.

### Restatement assumption

Per the `unusual-whales-api` skill's "API quirks — value restatement" section: assume per-minute aggregates restate. Both new tables use `UPSERT … DO UPDATE` keyed on `(ticker, [expiry, strike,] ts_minute)`. No conflict-do-nothing.

## Open questions

| #   | Question                                                                                          | Default if unanswered                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Strike radius for Battle Map: top-K nearest or fixed % band?                                      | **Top-10 nearest 0DTE strikes (5 calls + 5 puts)** — fits a small panel and self-adjusts to spot                                                                              |
| 2   | Should the Battle Map also surface 1DTE/2DTE strikes during the last hour (charm pinning regime)? | **Phase 1: 0DTE only.** Add multi-DTE later if useful.                                                                                                                        |
| 3   | Backfill of historical `ws_gex_strike_expiry`?                                                    | **No.** WS-only, going forward. The historical scrub on the panel will silently render fewer days until the table fills out (~1 month of history before scrub is meaningful). |
| 4   | Frontend refresh cadence for Battle Map endpoint                                                  | **30s during market hours, frozen for date-scrubbed views.** Same pattern as `useGreekFlow`.                                                                                  |
| 5   | How to surface strike concentration ratio (top1/top5)?                                            | **Subtitle text under each ticker's section** — "concentration: 0.42 (smeared)" / "concentration: 0.71 (magnet @ 723)".                                                       |
| 6   | Sign convention for "dealer net gamma"                                                            | UW's `call_gamma_oi + put_gamma_oi` sum (no flip applied). **Document explicitly** in `concentration.ts` so future readers don't second-guess.                                |
| 7   | Visual when WS data not yet populated for a strike (e.g., backfill gap)                           | **Render the flow bar but leave the gamma bar greyed/empty with a "—" label.** Don't omit the strike entirely.                                                                |

## Thresholds / constants

| Constant                          | Value                                      | Rationale                                              |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| `BATTLE_MAP_STRIKE_COUNT`         | 10 (5 OTM call + 5 OTM put)                | Fits panel, captures the magnet zone                   |
| `BATTLE_MAP_REFRESH_MS`           | 30,000                                     | Match Greek Flow panel cadence                         |
| `CONCENTRATION_PIN_THRESHOLD`     | 0.50                                       | top1/top5 ≥ 0.50 → label "magnet"                      |
| `CONCENTRATION_SMEARED_THRESHOLD` | 0.30                                       | top1/top5 < 0.30 → label "smeared"                     |
| `REGIME_LONG_GAMMA_THRESHOLD`     | net γ > +50% of recent 5-day median abs(γ) | Avoid flipping label on noise                          |
| `REGIME_SHORT_GAMMA_THRESHOLD`    | net γ < −50% of recent 5-day median abs(γ) | Symmetric to above                                     |
| `REGIME_ZERO_FLIP_DISTANCE_PCT`   | 0.20                                       | Spot within 0.20% of zero-gamma level → flag flip risk |
| `REGIME_CHARM_PIN_HOUR_CT`        | 14:00                                      | Only show charm-pin label after 2:00 PM CT             |
| `WS_GEX_DAEMON_BATCH_SIZE`        | 100 rows                                   | Match `flow_alerts.py` batched flush                   |
| `WS_GEX_DAEMON_FLUSH_MS`          | 1,000                                      | Match daemon convention                                |

## Testing strategy

**Unit:**

- `concentration.ts` — concentration ratio, magnet detection, edge cases (all-zero, single-strike, missing strikes).
- `dealer-regime-classifier.ts` — every regime + zero/empty `delta_per_one_percent_move_oi` edge case.
- Python handler `_transform` — fixture-driven, including the empty-string-numeric quirk.

**Endpoint:**

- Auth (owner / guest / public), happy path, empty-table, malformed query.

**Component:**

- Render with sample data, verify strike ordering, magnet highlighting, tooltip text.

**Integration:**

- After Phase 1 ship, run a single market session + verify a screenshot of the panel against UW's TRACE/Periscope reference for the same minute. Smoke-test, no automation.

## Phasing rules

- Phase 1 ships green from `npm run review` plus a code-reviewer subagent verdict of `pass` before any Phase 2 work begins.
- Plan doc updates (this file) for any deviation from the file list above — keep this doc as the durable handoff if context is lost mid-build.
- Each phase commits in stages: (a) daemon handler + table + tests, (b) read endpoint + tests, (c) frontend + tests, (d) wire-up.

## Prerequisite — review zero-gamma logic before Phase 2

**Status (2026-05-03):** ✅ Audited and unblocked. Findings + 14-day telemetry plot in `docs/tmp/zero-gamma-audit/AUDIT_FINDINGS.md`.

Audit summary:

- Architecture is sound — pure calculator + cron + read endpoint with clean per-ticker expiry policy.
- Methodology uses kernel-smoothed sign-change detection (not full Black-Scholes re-pricing); known O(0.5%) approximation tradeoff for the regime-tile use case is acceptable.
- 14-day telemetry on `net_gamma_at_spot` shows healthy regime-change behavior: SPX 7 sign-flips, SPY 7, QQQ 11, NDX 14. Distribution is 56% positive for SPX, 60% SPY, 84% QQQ, 95% NDX — plausible per-ticker positioning skews.
- Two action items remain but DO NOT block Phase 2 build:
  1. **Sign-convention spot-check** against a TRACE screenshot you already have (5-min task). Confirms whether `net_gamma_at_spot > 0` means "dealers long γ at spot" (dampening) or just "calls dominate." Resolves how the regime classifier labels its output.
  2. **Confidence gate** at ≥ 0.10 in the regime classifier — most stored values land at 0.00–0.13, so consumers must filter low-confidence reads as "uncertain regime."

Phase 2 build can start. Spot-check + confidence gate are required before the Dealer Regime tile goes live to users.

## Risks and rollbacks

- **Daemon can't keep up** — `gex_strike_expiry` is high-frequency. Mitigations: batched flush, last-write-wins per minute, drop-oldest backpressure if queue depth ever exceeds a threshold (matches existing pattern). Rollback: stop subscribing to the channel; the read endpoint returns empty; frontend gracefully renders empty state.
- **UW WS plan tier** — Advanced plan required. Confirm key tier before merging Phase 1.
- **Strike count drift** — Battle Map is hard-coded to 10 strikes. If 0DTE skew puts top-1 customer flow OUTSIDE the visible band, we miss it. Add a "off-screen" indicator when top-1 customer-flow strike is outside the rendered range.
