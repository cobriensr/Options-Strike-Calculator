# Schwab Replacement — UW + Theta-Sidecar Facade

**Date:** 2026-08-16 · **Status:** Phase 1–2 implementing · **Owner:** soonerdude28 fork

## Goal

Remove the Schwab dependency from all market-data paths by turning
`api/_lib/schwab-fetch.ts` into a path-dispatching facade that assembles
Schwab-shaped responses from Unusual Whales REST and the Railway sidecar's
Theta Terminal (Index Data PRO entitlement), so that all 14 `schwabFetch`
call sites keep working byte-identically with zero edits.

**Why this shape:** `schwabFetch<T>(path)` never throws and returns
`ApiResult<T> = {ok:true,data:T} | {ok:false,error,status,code?}`; callers
parse exact Schwab response shapes with no runtime validation. Rebuilding
those shapes behind the same function is the only replacement that requires
no changes to consumers. It also erases the 7-day refresh-token re-auth
treadmill — the single biggest operational pain of Schwab.

## Source mapping (from recon 2026-08-16, wf_999e31a3-3da)

| Schwab surface | Consumers | Replacement source | Fidelity notes |
|---|---|---|---|
| `/chains` ($SPX 0DTE) | chain.ts, compute-cone, analyze-context-fetchers | UW `GET /api/stock/SPX/option-contracts?expiry=` (2–3 pages @ limit 500) + sidecar Theta SPX snapshot for `underlying.last`/`close` | UW gives per-contract delta/gamma/theta/vega/`implied_volatility` (decimal — Schwab shape wants PERCENT ×100), `open_interest`, `nbbo_bid/ask`, volume. SPXW roots arrive under ticker SPX. Rebuild `{call,put}ExpDateMap` keys as `YYYY-MM-DD:DTE`. |
| `/chains` (17 tickers, every min) | fetch-strike-iv | UW `GET /api/stock/{t}/greeks?expiry=` — **cadence drops to */5 min** | Every-minute ×17 (~40–50 req/min) cannot fit UW's 120/min cap (measured baseline peak 95–110, self-cap 115). At */5: ~3.4 req/min amortized — fits. 5-min IV granularity accepted; alternative (keep 1-min) has no viable UW budget. |
| `/pricehistory` $SPX/$VIX/$VIX1D/$VIX9D/$VVIX (5-min candles) | history.ts, intraday.ts, yesterday.ts, compute-es-overnight, fetch-outcomes | **Sidecar** `GET /theta/index/history?root=&date=` (Theta `/v2/hist/index/ohlc`, Index PRO entitled) | Indices have no volume — shape emits `volume: 0` (recon: no caller reads candle volume). VIX-family coverage is the whole reason Theta Index PRO matters here; UW has none of VIX1D/VIX9D/VVIX. |
| `/pricehistory` equity tickers | ticker-candles.ts | UW `/api/stock/{t}/ohlc/1m` (already used elsewhere in repo) | Same helper pattern as `spx-candles.ts`. |
| `/quotes` ($SPX,$VIX,$VIX1D,…) | quotes.ts, fetch-outcomes, fetch-spx-candles-1m, fetch-market-internals ($ADD part) | **Sidecar** `GET /theta/index/price?root=` (Theta `/v2/snapshot/index/price`) | Full VIX family + SPX from one source. |
| `/movers/$SPX` | movers.ts | UW stock screener `is_s_p_500=true&order=perc_change` (2 calls) | Percent-change derived from close vs prev_close; semantic drift accepted. |
| `/pricehistory`+`/quotes` $TICK/$ADD/$VOLD/$TRIN | fetch-market-internals | **NOT COVERABLE** by UW or Theta | Consumers are fail-open (NULL feature columns). Facade returns `{ok:false, status:501, code:'SOURCE_UNAVAILABLE'}`; cron logs once, columns stay NULL. Revisit if a breadth source is added. |
| Trader API (positions) | positions.ts (`schwabTraderFetch`) | **Kept as-is** | Real brokerage positions are inherently Schwab; dormant without creds, untouched. |

## Phases

1. **Sidecar Theta index routes** (Python, TDD): `ThetaClient.snapshot_index_price(root)`
   + `hist_index_price/ohlc(root, date, ivl)`; routes `GET /theta/index/price` and
   `GET /theta/index/history` in health.py dispatch; bearer =
   `TAKEIT_SIDECAR_SHARED_SECRET` (already provisioned both sides);
   `ThetaClient(timeout_s=5, max_retries=1)` for interactive latency; no DB changes.
2. **TS facade** (TDD): `api/_lib/market-data-adapters.ts` (UW chain→ExpDateMap,
   UW screener→movers, UW ohlc→candles, sidecar index→quotes/candles assemblers)
   + dispatch inside `schwab-fetch.ts` keyed on path prefix; `[SCHWAB_*]` error
   codes preserved verbatim; `fetch-strike-iv` cron cadence `* → */5` in vercel.json.
3. **Rollout**: env plumbing already live (SIDECAR_URL, SIDECAR_TAKEIT_SECRET,
   UW_API_KEY); deploy; verify weekend-testable paths (history/yesterday vs
   known EOD values); Monday 13:30 UTC live validation of quotes/chain/candles.
4. **(separate approval) Schwab OAuth removal**: owner login page setting the
   `OWNER_SECRET` cookie directly; delete token machinery + `/api/health` schwab
   check. Not started until user signs off.

## Data dependencies

- UW budget: chain snapshot ~3–4 req; strike-iv */5 ~3.4 req/min amortized —
  fits inside `UW_PER_MINUTE_CAP=115` with measured 5–20 req/min headroom;
  all calls go through the existing `uw-rate-limit.ts` limiter.
- Theta Index Data PRO (active since 2026-08-16) — SPX + VIX family values.
  Index **options** (SPXW EOD) remain gated behind Options PRO; unrelated here.
- No new env vars; no DB migrations.

## Thresholds / constants

- Facade timeout budgets: sidecar calls 8s; UW paged chain 3 pages max.
- IV unit conversion: UW decimal → Schwab percent (×100) in the chain adapter.
- `fetch-strike-iv` cadence: `*/5 13-21 * * 1-5`.

## Open questions (defaults chosen)

- Strike-IV granularity 1-min → 5-min: **accepted** (no UW budget for 1-min).
- Internals: **degrade** (fail-open) rather than keep Schwab half-alive.
- Movers percent-change derivation: **accepted** semantic drift.
