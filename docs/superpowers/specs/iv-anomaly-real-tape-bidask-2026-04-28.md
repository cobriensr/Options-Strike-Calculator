# IV Anomaly — Real Bid/Ask Tape Volume (replace IV-spread proxy)

## Goal

Replace the IV-spread-position proxy in the side-skew gate of `detectAnomalies` with real bid/ask trade volume from the existing `strike_trade_volume` table. The proxy was producing systematically inverted labels (SPY showing "BID 100%" while UW tape showed 88% ask-side flow) because Schwab's `mark` field rounds to penny ticks for low-priced options, pinning `iv_mid = iv_ask` and tripping `bidSkew = 1.0` everywhere.

## Why now

Diagnostic on 2026-04-27 across 4 contracts that the user surfaced from UW screenshots:

| Contract         | Real tape (UW + DB)   | Proxy label                     |
| ---------------- | --------------------- | ------------------------------- |
| TSLA 375C 0DTE   | 32% ask / 56% bid     | uniform "BID 100%" (45 alerts)  |
| NVDA 212.5C 0DTE | 44% ask / 43% bid     | uniform "BID 100%" (9 alerts)   |
| SPY 706P 0DTE    | **88% ask** / 10% bid | uniform "BID 100%" (137 alerts) |

Cross-ticker pinning rate (iv_mid ≥ 95% of way to iv_ask) on the same day:
SPY 35%, QQQ 25%, NVDA 24%, TSLA 21%, IWM 19%, MSFT 13%, META 10% — only SPXW/NDXP escape because they're dollar-priced. The `mark`-as-mid heuristic in `extractRows` is the root cause.

## Phases

### Phase 1 — Migration + detector signature change (5 files)

- `api/_lib/db-migrations.ts` — migration 95 adds `bid_pct`, `ask_pct`, `mid_pct`, `total_vol_at_detect` to `iv_anomalies`. Nullable for legacy rows.
- `api/__tests__/db.test.ts` — bump migration count and applied-list mocks.
- `api/_lib/iv-anomaly.ts` — change `detectAnomalies` signature to accept `tapeByKey: Map<string, TapeStats>` keyed by `${ticker}:${strike}:${side}`. Replace IV-spread skew gate with real-volume gate. Extend `AnomalyFlag` with `bid_pct` / `ask_pct` / `mid_pct` / `total_vol_at_detect`. Keep `side_skew`/`side_dominant` populated (= max(bid_pct, ask_pct) and dominant side respectively) so existing readers don't break.
- `api/__tests__/iv-anomaly.test.ts` — update fixtures (now require tape stats) and add tape-gate boundary tests.
- Verify `npm run review`.

### Phase 2 — Cron wiring + API surface (3 files)

- `api/cron/fetch-strike-iv.ts` — add `loadTapeStatsForTicker(sql, ticker, today, sampledAt)` that aggregates `strike_trade_volume` by `(ticker, strike, side)` for today up to `sampledAt`. Pass into `detectAnomalies`. INSERT new columns into `iv_anomalies`.
- `api/iv-anomalies.ts` — extend `IVAnomalyRow` with new fields, project them in `mapAnomaly`, SELECT them.
- Existing endpoint test (if present) — update fixture.
- Verify `npm run review`.

### Phase 3 — UI swap (2-3 files)

- `src/components/IVAnomalies/types.ts` — extend `IVAnomalyRow` with `bidPct` / `askPct` / `midPct` / `totalVolAtDetect`.
- `src/components/IVAnomalies/AnomalyRow.tsx` — rewrite `SideSkewPill` to render `ASK 88%` from `askPct` directly (use `sideDominant` for amber/cyan tier; show `BID 56%` on bid-dominant). Update tooltip to "X% of N trades printed at the ask/bid" with the real volume in the title. Fall back to old `sideSkew` for legacy rows where `bidPct` is null.
- Update related test files (`AnomalyRow.test.tsx`, `banner-store.test.ts`, hook tests).
- Verify `npm run review`.

## Data dependencies

- `strike_trade_volume` table (migration 87) — already populated every minute by `fetch-strike-trade-volume` cron for all `STRIKE_IV_TICKERS`.
- The table aggregates ACROSS expiries (no `expiry` column). Anomaly is per-expiry but the tape signal is per (ticker, strike, side) — acceptable; volume on a strike is volume on a strike regardless of expiry, and our existing exit-signal already uses this same join.

## Open questions / decisions

- **Aggregation window.** Cumulative since open (today's date, ts ≤ `sampledAt`). NOT a rolling 15-min window — the gate measures "is there directional concentration at this strike today," not "is flow currently surging." A rolling window at 9:32 AM would be 100% one-sided after 1 trade. Cumulative grows in stability as the session matures. → Picked: **cumulative since open**.
- **What if no tape rows yet?** Skip the strike entirely (don't emit anomaly). Stricter than the old gate — old gate was always satisfied by some IV math. New gate requires real prints on the strike today before flagging. Acceptable: vol/OI gate already requires meaningful volume, so a strike with zero tape rows but high Schwab `volume` is suspect and worth dropping. → Picked: **skip when total_vol = 0**.
- **Threshold.** Keep `IV_SIDE_SKEW_THRESHOLD = 0.65`. Same number, cleaner meaning ("65% of today's traded volume on this strike printed on the same side"). → Picked: **no constant change**.
- **Mid-vol classification.** `mid_pct` doesn't add to ask or bid for the gate. `max(ask_pct, bid_pct) ≥ 0.65` over total. A strike that's 50% mid / 30% ask / 20% bid fails the gate (correctly — that's pure rolling, not directional).
- **Backfill.** No backfill of old rows — too many, semantics differ. Old rows keep their proxy values; new rows have real-tape values. UI falls back to the old field when the new ones are null.
- **Should we also fix Schwab `mark`-as-mid in `extractRows`?** Independent question — even after this swap, `iv_mid` is biased and feeds `iv_at_detect` / `ask_mid_div`. Worth a separate small PR to switch to `(bid+ask)/2` always; out of scope here.

## Out of scope (note for follow-ups)

- TSLA 400C 5/1 was missed at 11% OTM (single-name band is ±5%). Worth widening the high-liq band, but separate.
- GOOGL not on watchlist. Adding it is a separate config + load-test pass.
- Schwab `mark`-as-mid bias still distorts `iv_at_detect` and `ask_mid_div`. Not in this PR.
