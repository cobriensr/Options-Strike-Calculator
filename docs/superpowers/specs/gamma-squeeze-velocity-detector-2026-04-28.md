# Gamma Squeeze Velocity Detector

## Goal

Detect 0DTE gamma-squeeze setups in the 14 watchlist tickers in real time. The current IV anomaly detector requires asymmetric tape (≥65% one-sided), so it correctly filters out balanced-tape setups like TSLA 375C and NVDA 212.5C 2026-04-27 — both of which were "stupidly profitable" via dealer hedging reflexivity, not informed flow. This new detector keys off **velocity** (rate of change in vol/OI) instead of side concentration, so we catch the gamma-squeeze archetype without contaminating the IV anomaly board.

Sibling — not replacement — to the IV anomaly detector. Different signal, different table, different alert path.

## Why now

2026-04-27 review case studies:

- TSLA 375C 0DTE: 32% ask / 56% bid (balanced) → IV anomaly detector correctly filtered. Profitable due to spot trending into strike + 31× vol/OI.
- NVDA 212.5C 0DTE: 44% ask / 43% bid (balanced) → same.
- GOOGL 350C 0DTE: not on watchlist (now added 2026-04-28).

The detector will catch **vol/OI added in last 15 min ≥ 5×** at strikes near spot — which would have flagged both contracts ~30-60 min before their peak.

## Phases

### Phase 1 — Migration + db.test.ts update (2 files)

- `api/_lib/db-migrations.ts` — migration 96: `gamma_squeeze_events` table with strike-side identity columns, velocity metrics (15-min and prior 15-min), proximity, trend, NDG sign, phase, and outcome columns. Two indexes: `(ticker, ts DESC)` and `(ticker, strike, side, expiry, ts DESC)`.
- `api/__tests__/db.test.ts` — bump migration count, applied-list mocks, and tx count.
- Verify `npm run review`.

### Phase 2 — Pure detector module + unit tests (2 files)

- `api/_lib/gamma-squeeze.ts` — `detectGammaSqueezes(windowByKey, ticker, nowIso, ndgByStrike)` pure function. Takes a 45-minute trailing window grouped by `(strike, side, expiry)` and runs six gates: velocity (≥5× vol/OI added in last 15 min), acceleration (current 15-min ≥ 1.5× prior 15-min), proximity (spot within ±1.5% of strike on the OTM side), trend (5-min spot move toward strike), time-of-day (9:00–14:00 CT), NDG sign (skip when dealers are net-long gamma at the strike). Phase classification: `forming` / `active` / `exhausted`.
- `api/__tests__/gamma-squeeze.test.ts` — boundary tests for each gate plus integration tests that replay synthetic squeeze fixtures.
- Verify `npm run review`.

### Phase 3 — Cron wiring (2 files)

- `api/cron/fetch-strike-iv.ts` — extend `runDetection()` to load the squeeze window via `loadSqueezeWindowForTicker()` (45-min trailing snapshots) and net-dealer-gamma via `loadNetDealerGammaForTicker()` (joined from `strike_exposures`, SPX/SPY/QQQ only — single names get `unknown` NDG and skip Gate 6). Run the gamma squeeze detector in parallel with the IV anomaly detector. INSERT firing flags into `gamma_squeeze_events`.
- `api/__tests__/cron-fetch-strike-iv.test.ts` — extend the existing happy-path test with a stubbed squeeze window and assert squeeze events are inserted with the right column values.
- Verify `npm run review`.

### Phase 4 — Read API + tests (2 files)

- `api/gamma-squeezes.ts` — `GET /api/gamma-squeezes`, owner-or-guest gated (same level as IV anomalies — derived from OPRA-licensed Schwab data). List mode with optional `?ticker=` filter; latest + 24h history per ticker.
- `api/__tests__/endpoint-gamma-squeezes.test.ts` — auth gate, query validation, mock response shape.
- Verify `npm run review`.

### Phase 5 — UI hook + types + section + tests (5 files)

- `src/components/GammaSqueezes/types.ts` — `GammaSqueezeRow`, `GammaSqueezePhase`, `ActiveSqueeze` shapes.
- `src/components/GammaSqueezes/GammaSqueezeRow.tsx` — per-active-squeeze row with velocity + acceleration pills, spot-vs-strike, phase pill, sparkline placeholder.
- `src/components/GammaSqueezes/GammaSqueezeFeed.tsx` — section wrapper, polls the endpoint via the new `useGammaSqueezes` hook.
- `src/hooks/useGammaSqueezes.ts` — fetch + aggregate by compound key, gate polling on market hours.
- `src/App.tsx` — wire the new section into the layout.
- Tests for hook + components.
- Verify `npm run review`.

## Data dependencies

- `strike_iv_snapshots` (already populated minute-by-minute by `fetch-strike-iv` cron for all 14 tickers).
- `strike_exposures` (already populated for SPX/SPY/QQQ — used for the NDG sign gate).
- No new external API calls. Pure derivation from existing tables.

## Open questions / decisions

- **Aggregation window: 45 min trailing.** Long enough to compute both `velocity(t)` (last 15 min) and `velocity(t-15)` (prior 15 min) plus 15-min trend lookback. Shorter would miss the acceleration check.
- **Gates are AND-combined.** All six must pass. Could relax to OR for two-of-N once we have outcome data, but for v1 the stricter version produces a cleaner board.
- **NDG gate applies only when known.** Single names (NVDA, TSLA, etc.) lack `strike_exposures` rows; for those tickers we skip Gate 6 and rely on the other five. Acceptable for v1; if false-positive rate is too high on single names we can pull NDG for the watchlist via UW.
- **Phase classification:**
  - `forming` — first 1–2 firings on a compound key, spot still > 0.5% from strike.
  - `active` — sustained velocity ≥ threshold AND spot within 0.5% of strike.
  - `exhausted` — spot pierced strike OR velocity dropped below 0.5× threshold for 2+ samples. Rendered grayed-out in UI.
- **Time-of-day cutoff:** Gate 5 is 9:00–14:00 CT. Outside that window: skip. Rationale: pre-9:00 has too much open-noise; post-14:00 charm dominates and the squeeze trade has already played out.
- **Threshold tuning:** Initial values are bias-toward-strict. Once we have 2-4 weeks of outcome data, tune via `pac_backtest`-style sweep on the resolution column.

## Resolution path (deferred)

- Future cron `resolve-gamma-squeezes.ts` — runs at close, fills `spot_at_close`, `reached_strike`, `max_call_pnl_pct` for outcome labeling and ML pipeline integration. Out of scope for this PR.

## Out of scope

- The single-name NDG join (Phase 6 follow-up).
- Velocity-based exit signal (different problem — we'll add when we have resolution data).
- Backtesting harness (deferred until enough live data).
