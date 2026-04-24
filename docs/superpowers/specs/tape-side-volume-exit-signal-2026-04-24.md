# Tape-Side Volume for Exit-Signal Detection

## Goal

Replace the IV-proxy exit signals in `useIVAnomalies` with real UW tape-side
volume data (per-minute bid-side vs ask-side volume per strike), unlocking
gold-standard distribution detection: **"bid-side volume surge ≥ 50% of
accumulated ask-side entry volume within 15 min."**

## Motivation

Exit detection shipped 2026-04-23 as commit `3425d73`. It uses three proxies:

1. IV regression (peak-to-current drop ≥ 30%) — moderately noisy
2. Ask-mid compression (iv_ask − iv_mid < 0.2vp) — clean
3. Detector-firing-rate surge with flat IV — **weakest proxy**; substitutes
   "how often did the detector re-fire?" for "did bid-side volume surge?"

Signal #3 is how pros actually read distribution phase: the same desk that
aggressively lifted the ask during accumulation now hits the bid. Our current
approximation is directionally correct but noisy — any rapid IV oscillation
looks like distribution. Real tape-side data would let us see the actual
liquidation signature.

The 2026-04-23 fixture (spec `strike-iv-anomaly-detector-2026-04-23.md`,
"Live validation" section) had a clear tape fingerprint: SPY 705P hit 454K
vol at 97% ask during accumulation, then ask-side % collapsed to 44% as
holders scaled out around 12:00 CT. That collapse is directly observable
from tape data, invisible from IV alone.

### Interim proxy (shipped 2026-04-24)

Until UW per-strike side-split volume is wired, the detector uses an
**IV-spread skew proxy** as the secondary side-dominance gate (see
`api/_lib/iv-anomaly.ts` `IV_SIDE_SKEW_THRESHOLD` and migration 86 columns
`side_skew` + `side_dominant`):

```text
ask_skew = (iv_ask - iv_mid) / (iv_ask - iv_bid)
bid_skew = (iv_mid - iv_bid) / (iv_ask - iv_bid)
gate     = max(ask_skew, bid_skew) >= 0.65
```

The signal lives in Schwab's `mark` field — when MMs lean the displayed mid
toward the bid (closer-to-bid mark → ask_skew up) or toward the ask
(closer-to-ask mark → bid_skew up), the IV inversion at those three prices
amplifies that asymmetry into a side-dominance score. The cron now uses
`mark` instead of `(bid+ask)/2` for `iv_mid` whenever mark is in-band.

This is directionally correct but lossy — it can't see actual tape side
volume; it only sees the MM's displayed mark. It exists to filter out the
2-sided unwinding noise (e.g., 0DTE strikes pin-trading at 50/50) that
slipped through the vol/OI gate alone in the 2026-04-24 production run.

**When this spec ships, the proxy is REPLACED, not augmented.** The
`side_skew` / `side_dominant` columns become real `bid_pct` / `ask_pct`
values from the UW tape stream, and the threshold is re-tuned against the
new (much cleaner) signal. The constant name `IV_SIDE_SKEW_THRESHOLD` and
the proxy code path can be deleted at that point.

## Phases

### Phase 0 — UW endpoint investigation (~30min)

Confirm which UW API endpoint provides **per-minute per-strike bid-side vs
ask-side vs mid volume**. Candidates to check (verify via UW API docs + test
call against real contract):

- `/option-contract/{symbol}/volume-profile` (if exists)
- `/option-contract/{symbol}/interpolated-iv` (no — IV only)
- `/option-trades/flow` — trade-level tape; would require aggregation
- `/option-contract/{symbol}/hour_summary` or `/intraday` variant

Expected shape: per-minute rows with at minimum `{ticker, strike, expiry,
side, timestamp, bid_side_vol, ask_side_vol, mid_vol, total_vol}`. If UW
returns only trade-level ticks, Phase 1 cron must aggregate to per-minute
buckets before insert.

Document the chosen endpoint + response shape in a kickoff comment on the
Phase 1 cron before implementing.

**Cadence decision:** 1-min polling to match `fetch-strike-iv`. Drop to 5-min
only if UW rate limits tighten (doubtful — this is 3 tickers × 30 strikes
per poll, well below existing flow crons' load).

### Phase 1 — Ingestion cron (~2h)

**Migration 85: `strike_trade_volume` table**

```sql
CREATE TABLE strike_trade_volume (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  strike NUMERIC(10,2) NOT NULL,
  side TEXT NOT NULL,                  -- 'call' | 'put'
  expiry DATE NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  bid_side_vol INTEGER NOT NULL DEFAULT 0,
  ask_side_vol INTEGER NOT NULL DEFAULT 0,
  mid_vol INTEGER NOT NULL DEFAULT 0,
  total_vol INTEGER NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_strike_trade_volume_lookup
  ON strike_trade_volume (ticker, strike, side, expiry, ts DESC);
CREATE INDEX idx_strike_trade_volume_ticker_ts
  ON strike_trade_volume (ticker, ts DESC);
```

Use the next available migration id (85 assuming no intervening migrations).
Update `db.test.ts` per the standard pattern (mock entry + SQL call count +
transaction count).

**Cron `api/cron/fetch-strike-trade-volume.ts`**

- Standard `cronGuard`, market-hours gate
- For each ticker in `STRIKE_IV_TICKERS` (SPX / SPY / QQQ / IWM / TLT /
  XLF / XLE / XLK as of the 2026-04-24 expansion — keep this loop
  sourced from the constant so future ticker adds auto-propagate):
  1. Fetch per-strike tape-side volume from the Phase 0 endpoint
  2. Filter to OTM ±3% of spot (reuse `STRIKE_IV_OTM_RANGE_PCT` constant)
  3. Filter to 0DTE + next 2 Fridays (reuse existing expiry logic)
  4. Apply per-ticker min-OI gate (reuse `minOiFor(ticker)` helper from
     `fetch-strike-iv.ts` — it already covers all 8 tickers with the
     SPX / SPY+QQQ / IWM / sector-ETF tiers)
  5. Batch INSERT with per-ticker fault isolation (same pattern as
     `fetch-strike-iv`)
- Register at `* 13-21 * * 1-5` in `vercel.json`

**Tests:**

- Happy path — 3 tickers with synthetic tape response → batch insert verified
- Missing `CRON_SECRET` → 401
- Outside market hours → skip
- Schwab/UW fault for one ticker → other tickers proceed, Sentry capture
- Empty tape for a ticker → no-op, log
- Match the pattern used in `cron-fetch-strike-iv.test.ts`

### Phase 2 — Read endpoint (~45min)

**`api/strike-trade-volume.ts`** — owner-gated read endpoint.

Supports two query modes via Zod schema:

1. **Bulk mode** — `GET /api/strike-trade-volume?ticker=SPX&since=<ISO>` →
   returns tape-side data for ALL strikes of that ticker since timestamp.
   Used by the hook to get data for all currently-active compound keys in
   a single query rather than N parallel queries.

2. **Single-key mode** — `GET /api/strike-trade-volume?ticker=SPY&strike=705&side=put&expiry=YYYY-MM-DD&since=<ISO>` →
   returns a single compound key's time series. Used for drill-down views.

Response shape:

```ts
{
  series: Array<{
    ticker: string;
    strike: number;
    side: 'call' | 'put';
    expiry: string;
    data: Array<{
      ts: string;
      bid_side_vol: number;
      ask_side_vol: number;
      mid_vol: number;
    }>;
  }>;
}
```

Owner-gated via `rejectIfNotOwner` (matches sibling OPRA-derived endpoints).
Zod schema in `api/_lib/validation.ts`. Botid-protect list update in
`src/main.tsx`.

Tests: method, bot, owner, Zod, empty, happy-bulk, happy-single, 500.

### Phase 3 — Hook integration (~1h)

Update `src/hooks/useIVAnomalies.ts`:

1. **New fetch**: alongside the existing `/api/iv-anomalies` poll, also poll
   `/api/strike-trade-volume?ticker=<T>&since=<active-span-start>` for each
   active compound key's ticker, once per ticker (not per strike).

2. **Extend `ActiveAnomaly`** with:
   - `bidSideVolHistory: Array<{ ts, bid_side_vol, ask_side_vol }>` — rolling
     15-min window
   - `accumulatedAskSideVol: number` — sum over the active span (entry → now)
   - `accumulatedBidSideVol: number` — same, for bid side

3. **New primary exit signal — `BidSideSurge`**: detects when
   `bidSideVolInLast15Min >= accumulatedAskSideVol * BID_SIDE_SURGE_RATIO`
   AND `bidSideVolInLast15Min >= BID_SIDE_MIN_VOL`. Transitions
   `active → distributing` with reason `'bid_side_surge'`.

4. **Replace proxy signal**: remove the `firingHistory`-based distribution
   check. The new bid-side signal replaces it. Keep IV regression and
   ask-mid compression — they're independent signals and still useful.

5. **Update `exitReason` enum**: add `'bid_side_surge'` alongside existing
   `'iv_regression' | 'ask_mid_compression'` (the old `'firing_rate_surge'`
   goes away).

Constants (add to `src/constants/index.ts`):

```ts
export const BID_SIDE_SURGE_RATIO = 0.5; // 50% of accumulated ask-side
export const BID_SIDE_SURGE_WINDOW_MS = 15 * 60 * 1000; // 15 min rolling
export const BID_SIDE_MIN_VOL = 1000; // noise floor
```

**Tests**: new synthetic tape-volume sequences → bid-side surge transitions;
signal is more decisive than the old firing-rate proxy; multi-signal
priority preserved (IV regression can still fire, distributing still wins
display priority).

### Phase 4 — UI polish (~30min)

`src/components/IVAnomalies/AnomalyRow.tsx`:

- Update `buildExitSubtitle()` to show concrete numbers for bid-side surge:
  e.g., "Bid-side surge: 28K vs 54K ask-side (52%)"
- Remove the "signal is a proxy" caveat from the hook's top-of-file comment
- Update `ActiveAnomaly` display to optionally show accumulated bid/ask-side
  volumes in the expanded view (debug affordance for the owner)

## Files to create/modify (summary)

**New (5 files):**

- `api/cron/fetch-strike-trade-volume.ts`
- `api/strike-trade-volume.ts`
- `api/__tests__/cron-fetch-strike-trade-volume.test.ts`
- `api/__tests__/endpoint-strike-trade-volume.test.ts`
- (migration 85 lives inline in `db-migrations.ts`, not a new file)

**Modify:**

- `api/_lib/db-migrations.ts` — migration 85
- `api/_lib/validation.ts` — new Zod schema
- `api/__tests__/db.test.ts` — mock sequence
- `vercel.json` — cron registration
- `src/main.tsx` — botid protect list
- `src/constants/index.ts` — 3 new thresholds
- `src/hooks/useIVAnomalies.ts` — new fetch + state + signal
- `src/components/IVAnomalies/types.ts` — extend `ActiveAnomaly`
- `src/components/IVAnomalies/AnomalyRow.tsx` — subtitle + accumulated vol display
- Hook tests + row tests updated

## Data dependencies

**New table (Neon Postgres):** `strike_trade_volume` (migration 85)

**External APIs:**

- UW endpoint to be confirmed in Phase 0 (existing `UW_API_KEY` reused)
- No Blob, no Railway changes

**Cron registrations:**

| Path                                  | Schedule          |
| ------------------------------------- | ----------------- |
| `/api/cron/fetch-strike-trade-volume` | `* 13-21 * * 1-5` |

**Volume estimate:** 30 strikes × 8 tickers × 3 expiries × 540 polls/day ≈
388K rows/day (~100M/year) with the 2026-04-24 ticker-scope expansion
(IWM / TLT / XLF / XLE / XLK added to the 3-ticker baseline). Still
fine for Neon — largest single-day writer in the project — but flag the
larger scale when planning retention or index maintenance. Same
no-retention stance as `strike_iv_snapshots` (keep everything for ML
training, per 2026-04-23 decision precedent). Real footprint may be
smaller than the ceiling since TLT / XLF / XLE / XLK frequently have
no 0DTE listed.

## Thresholds / constants

| Constant                   | Value          | Rationale                                |
| -------------------------- | -------------- | ---------------------------------------- |
| `BID_SIDE_SURGE_RATIO`     | 0.50           | 50% of accumulated ask-side vol to fire  |
| `BID_SIDE_SURGE_WINDOW_MS` | 15 × 60 × 1000 | Rolling window matches silence threshold |
| `BID_SIDE_MIN_VOL`         | 1000           | Noise floor — below this, ignore         |

## Open questions

1. **UW endpoint** — resolved in Phase 0 before implementation begins.
   Expected: per-minute per-strike bid/ask/mid side volume.

2. **Polling cadence** — 1 min to match `fetch-strike-iv`. Revisit if UW
   rate limits tight.

3. **Aggregation responsibility** — if UW returns trade-level ticks (not
   pre-aggregated to per-minute buckets), cron does the aggregation before
   inserting. Simplifies downstream consumers.

4. **Multi-ticker bulk fetch on the read endpoint** — current spec has
   single-ticker per request. Could extend to `?ticker=SPX,SPY,QQQ` if the
   hook's per-ticker parallelism turns out to dominate poll latency. Start
   single-ticker.

5. **Backfill** — do we want to backfill historical tape volume for the
   past N days once the cron is live? Out of scope for this spec; revisit
   if ML training needs deeper history.

## Verification (per-phase)

Each phase ends with `npm run review` passing + reviewer subagent verdict
= pass, then commit to main.

- **Phase 0:** document the chosen UW endpoint + sample response in a
  markdown note; no code changes.
- **Phase 1:** hit `/api/cron/fetch-strike-trade-volume` locally with
  `CRON_SECRET`, verify rows in `strike_trade_volume` for all 3 tickers.
- **Phase 2:** curl the endpoint bulk + single mode, verify response shape
  matches Zod schema.
- **Phase 3:** synthetic test showing `BidSideSurge` fires before the old
  firing-rate proxy would have (cleaner, earlier). E2E regression test
  (`e2e-2026-04-23-flush.test.ts`) unchanged — it tests the detector, not
  exit signals.
- **Phase 4:** run `npm run dev`, confirm the subtitle shows concrete
  numbers when a distributing transition fires.

## Out of scope

- Historical backfill of tape volume for pre-launch days
- ML training integration (later, after accumulating ~2-4 weeks of data)
- Per-strike tape visualization (could be a v2 — a mini-chart overlay showing
  bid-side vs ask-side volume over the active span)
- Integration with the analyze endpoint's Claude context (separate decision;
  tape-side data is valuable there too but adds token count)

## Time estimate

**~4h total** — split across 4 phases per above. Phase 0 (investigation)
dominates risk; rest is execution.

Actual time depends on whether the UW endpoint exists in the expected
shape. If UW only provides trade-level ticks and we have to aggregate
ourselves, Phase 1 grows by ~1h. If UW has a per-minute per-strike
summary endpoint that exactly matches what we need, Phase 1 shrinks to
~1.5h. Expect 3.5–5h range.

## Relationship to existing features

- **Strike IV Anomaly Detector** (live on main): the hook currently produces
  entries using IV-based signals. This spec adds tape-side exit signals on
  top of the existing aggregation state machine. No changes to detection
  of ENTRY signals.
- **IV-proxy exit detection** (shipped `3425d73` on 2026-04-23): keeps its
  IV regression + ask-mid compression signals. The Phase 3 change REPLACES
  the firing-rate-surge proxy with real bid-side-surge, but preserves the
  other two proxies as independent signals.
- **Zero-gamma feature** (live on main): unrelated; no changes needed.

## Rollout considerations

- **First week**: monitor `strike_trade_volume` write rate + size; verify
  UW endpoint rate limits are respected.
- **Threshold tuning**: 50% bid-to-ask ratio is an educated starting point
  from the 2026-04-23 fixture. After 2 weeks of live data, compare
  distributing-signal precision to the proxy version's historical behavior.
- **Backward compatibility**: when tape data is UNAVAILABLE (fetch fails for
  a ticker, or cron hasn't populated yet), the hook should fall back to
  IV-proxy signals gracefully. Don't remove the proxy codepath — use it as
  degraded mode when tape data is missing.
