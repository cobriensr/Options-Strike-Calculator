# Strike IV Anomaly Detector

## Goal

Auto-detect anomalous OTM option IV moves on SPX, SPY, and QQQ — surface
potential informed-flow signals in real time and persist snapshots + labeled
outcomes to Neon for future ML training.

## Motivation

During the 2026-04-23 session, heavy ASK-side 0DTE put buying on SPY 704P/705P
and QQQ 649P raised the question _"is this informed, or noise?"_. The answer is
visible in IV dynamics — specifically whether IV on the target strike is rising
faster than peers — but the app has no component that surfaces this. This
feature fills that gap and creates a labeled dataset for future ML.

The informed-flow signal is not "IV went up." It is:

1. **Cross-strike skew-delta** — target strike IV vs its 2 neighbors each side.
   Removes the common charm/gamma factor so only idiosyncratic demand remains.
2. **Rolling Z-score** — strike IV change vs its own intraday baseline. Filters
   constant decay drift.
3. **Ask-mid IV divergence** — MMs marking up the ask faster than the mid is a
   leading indicator of aggressive one-sided flow.

### Live validation (2026-04-23) — gold-standard fixture

SPX flushed 77 points (7147 → 7070) between ~11:50 and ~13:00 CT. The setup
was visible in SPY and QQQ option flow ~60–85 minutes before spot cracked.
**It was NOT visible in SPXW tape** — a structural insight documented below.

#### Observed tape (informed-flow staging)

**SPY 705P 0DTE** — final total: 454K vol / 9.1K OI = **49.8× OI turnover**

| Time (CT) | 5-min vol | % ask-side | Spot (SPY) |
| --------- | --------- | ---------- | ---------- |
| 10:05     | 1,601     | 92%        | 711.63     |
| 10:30     | 13,237    | 83%        | 712.13     |
| 10:45     | 5,076     | 78%        | 711.18     |
| 11:35     | 30,862    | 97%        | 711.07     |
| 12:00     | 14,714    | 44%        | 709.66     |

Flush begins at the 12:00 CT row (ask-side % collapses as earlier buyers
start scaling out; new participants are reactive, not informed).

**SPY 704P 0DTE** — 242K vol / 4.8K OI = **50.2× OI turnover**

| Time (CT) | 5-min vol | % ask-side | Spot (SPY) |
| --------- | --------- | ---------- | ---------- |
| 10:05     | 444       | 92%        | 711.62     |
| 10:40     | 3,116     | 97%        | 711.75     |
| 11:00     | 25,802    | 96%        | 710.87     |

**QQQ 649P 0DTE** — 186K vol / 3.4K OI = **55× OI turnover**

| Time (CT) | 5-min vol | % ask-side | Spot (QQQ) |
| --------- | --------- | ---------- | ---------- |
| 10:15     | 548       | 93%        | 656.14     |
| 10:35     | 8,592     | 98%        | 656.30     |
| 11:00     | 14,648    | 98%        | 655.24     |

#### Four stacked tells (textbook informed-flow fingerprint)

1. **Multi-ticker simultaneity.** At 11:00–11:01 CT, SPY 704P (25.8K × 96% ask)
   - QQQ 649P (14.6K × 98% ask) hit inside the same minute. Same-desk, same
     signal, across correlated tickers.
2. **Extreme ask-side dominance (96–98%).** Hedge desks negotiate or leg in;
   98% ask means "pay whatever, I need these now" — informed or mechanical.
   At this size + timing it's not mechanical.
3. **Volume/OI ≥ 50×.** 30–50 days of normal flow dumped in 2 hours. No
   background-hedge story explains it.
4. **Strike convergence.** All three contracts ~0.2–0.4% OTM at print time
   (equivalent to SPX 7110 — where spot ended up). Tail hedges sit at 1.5%+;
   this was a targeted downside bet.

#### Structural lesson: SPX is the reaction surface, SPY/QQQ is the setup surface

The signal was invisible on SPXW tape — 0 staging prints. That's because:

- 1 SPXW contract = 100× SPX notional (~$710K notional at spot 7100)
- 1 SPY contract = 100× SPY notional = ~1/10 of SPXW notional
- A $20M notional short needs ~28 SPXW contracts (spot-able as a 28-lot
  institutional block) OR ~280 SPY contracts smeared across many fills
  (invisible in the background noise)

**Informed flow that wants to stay hidden uses SPY/QQQ, not SPXW.** SPXW is
where dealers hedge AFTER price moves; SPY/QQQ is where the setup is built.
The detector's SPX channel should be treated as a **confirmation signal**
(did the setup flow from SPY/QQQ carry over?), not the primary surface.

#### Detector replay (gold-standard fixture for E2E test)

Had the detector existed at 10:30 CT it would have fired an escalating
sequence — this is the canonical fixture for any future backtest or E2E
integration test:

| CT time | Ticker/strike | Expected flags                         | Expected `flow_phase` |
| ------- | ------------- | -------------------------------------- | --------------------- |
| 10:30   | SPY 705P      | `skew_delta`, `ask_mid_div`            | `early`               |
| 10:35   | QQQ 649P      | `skew_delta`, `ask_mid_div`            | `early`               |
| 10:40   | SPY 704P      | `skew_delta`, `ask_mid_div`            | `early`               |
| 11:00   | SPY 704P      | `skew_delta`, `z_score`, `ask_mid_div` | `mid`                 |
| 11:00   | QQQ 649P      | `skew_delta`, `z_score`, `ask_mid_div` | `mid`                 |
| 11:35   | SPY 705P      | `skew_delta`, `z_score`, `ask_mid_div` | `mid`                 |

That's **~60–85 min of lead time** on the 11:50 CT flush. The 25.8K SPY 704P
print at 11:00 (@ ~$0.08 fill) was worth ~$5–10M of paper at the 12:30 low —
a 25–50× outlay-to-paper move that a detector-driven trader could have
partially ridden (or at minimum stayed out of longs).

This validation event also motivated the Phase 3 in-app banner + sound
alerting: a visible-list-only design wastes the signal if the owner isn't
actively watching the tab; the banner surfaces above other app content.

## Phases

### Phase 1 — Data ingestion cron (~3h)

Per-strike IV snapshot fetch for SPX/SPY/QQQ, filtered to OTM ±3%. Foundation
for everything else.

**Files:**

- `api/_lib/db-migrations.ts` — migration 70: `strike_iv_snapshots` table
- `api/__tests__/db.test.ts` — update applied-migration mock + SQL call count
- `api/cron/fetch-strike-iv.ts` — new cron, every 1min during market hours
  (matches existing 1-min cron pattern used by `fetch-spot-gex`,
  `fetch-gex-0dte`, `fetch-market-internals`, etc.)
- `api/__tests__/cron-fetch-strike-iv.test.ts` — mock Schwab fetch + DB inserts
- `vercel.json` — register `* 13-21 * * 1-5`
- **Chain-fetch location TBD** — `api/_lib/schwab.ts` is OAuth-only. The actual
  chain-fetch logic lives elsewhere (likely `api/chain.ts` or a helper).
  Locate in Phase 1 kickoff; Schwab's chain endpoint is symbol-parameterized so
  SPY/QQQ support should be free.

### Phase 2 — Anomaly detection + context capture (~6h)

Detection logic layered over Phase 1 snapshots. Flags strikes that exceed
cross-strike skew-delta, rolling Z-score, or ask-mid IV divergence thresholds.

**Critical addition (2026-04-23 post-validation):** at detection time, we
snapshot the full cross-asset state into `iv_anomalies.context_snapshot` so
we can forensically reconstruct what kicked off and sustained the flow. All
source data already exists in other cron streams — we're joining, not
ingesting new sources.

**Files:**

- `api/_lib/db-migrations.ts` — migration 71: `iv_anomalies` table (now
  includes `context_snapshot JSONB` + `flow_phase TEXT`)
- `api/__tests__/db.test.ts` — update mock sequence
- `api/_lib/iv-anomaly.ts` — new module: `computeSkewDelta()`,
  `computeRollingZ()`, `detectAnomalies()`, `classifyFlowPhase()`
- `api/_lib/anomaly-context.ts` — new module: `gatherContextSnapshot()`
  joins cross-ticker IV, futures, VIX term, macro, flow alerts, dark pool,
  NQ OFI, institutional-program, econ calendar at detection time
- `api/__tests__/iv-anomaly.test.ts` — detector unit tests with synthetic
  chains
- `api/__tests__/anomaly-context.test.ts` — context-gather tests with mocked
  DB responses
- `api/cron/fetch-strike-iv.ts` — call detector after snapshot insert,
  gather context, populate `iv_anomalies`

### Phase 3 — Frontend standalone component + in-app alerts (~4h)

Standalone section showing live anomalies and clickable per-strike IV history
charts. Does not touch GEX components. In-app banner alert + sound chime fire
on new-anomaly transitions (detected client-side by diffing the hook's result
set across polls). Fully self-contained — no external services, no webhook
URLs, no OS-level permissions.

**Files:**

- `api/iv-anomalies.ts` — new read endpoint (list recent anomalies, per-strike
  history)
- `api/_lib/validation.ts` — add Zod schema for query params
- `src/hooks/useIVAnomalies.ts` — new hook, polling gated on `marketOpen`,
  dedup logic for new-anomaly detection. On diff `known-set → new entry`
  the hook calls the banner store's push action + plays the sound chime.
- `src/components/IVAnomalies/IVAnomaliesSection.tsx` — main section, per-
  ticker tabs (SPX/SPY/QQQ)
- `src/components/IVAnomalies/AnomalyRow.tsx` — single-anomaly row
- `src/components/IVAnomalies/StrikeIVChart.tsx` — per-strike IV history
  (Recharts, matches existing chart patterns)
- `src/components/IVAnomalies/AnomalyBanner.tsx` — fixed-position top banner
  stack (z-index above GEX components). Shows ticker/strike/side + flag
  reasons; auto-dismiss after N seconds or on click. Stacks up to 3 visible;
  older ones collapse into a "+N more" indicator.
- `src/utils/anomaly-sound.ts` — plays chime via `new Audio(chimeUrl).play()`.
  Honors a localStorage `anomalySoundEnabled` flag (default: true). Throttled
  to max 1 play per 3 seconds to avoid spam if many anomalies hit at once.
- `public/sounds/anomaly-chime.mp3` — short chime (~0.5s). Source: royalty-
  free library (mixkit/zapsplat) or generate a simple tone.
- `src/App.tsx` — mount the new section + global `<AnomalyBanner />`
- `src/main.tsx` — add `/api/iv-anomalies` to `initBotId({ protect: [...] })`
- `src/components/IVAnomalies/__tests__/*.test.tsx` — component tests
  (including banner lifecycle + sound-throttle tests)

### Phase 4 — ML-ready labeling + retrospective catalyst analysis (~3.5h)

End-of-day cron that scores each anomaly: did spot move toward the strike, did
IV keep rising, what's the P&L of a notional 1-contract trade? Populates
`resolution_outcome` for future ML training.

**Retrospective catalyst analysis (added 2026-04-23):** in addition to
scoring, scan the T-60 → T+0 window to identify what MOVED FIRST —
leading-lag correlations across TLT/VIX/DXY/NQ vs the anomaly ticker, large
dark pool prints (filtered per `feedback_darkpool_filters.md`), whale/flow
alerts, range breaks on correlated assets. This identifies likely catalysts.

**Files:**

- `api/cron/resolve-iv-anomalies.ts` — new cron, runs 5 min after close
- `api/__tests__/cron-resolve-iv-anomalies.test.ts`
- `vercel.json` — register `5 21 * * 1-5`
- `api/_lib/iv-anomaly.ts` — add `resolveAnomaly()` scoring function
- `api/_lib/anomaly-catalyst.ts` — new module: `analyzeCatalysts()` scans
  cross-asset leading-lag in the T-60 → T+0 window; writes structured
  output into `resolution_outcome.catalysts`

### Phase 5 (future, out of scope) — ML classifier

Train on labeled dataset, expose prediction via Claude analyze context. Not part
of this spec.

## Files to create/modify (summary)

**New (16 files + 1 asset):**

- `api/cron/fetch-strike-iv.ts`
- `api/cron/resolve-iv-anomalies.ts`
- `api/iv-anomalies.ts`
- `api/_lib/iv-anomaly.ts`
- `api/_lib/anomaly-context.ts`
- `api/_lib/anomaly-catalyst.ts`
- `src/hooks/useIVAnomalies.ts`
- `src/utils/anomaly-sound.ts`
- `src/components/IVAnomalies/IVAnomaliesSection.tsx`
- `src/components/IVAnomalies/AnomalyRow.tsx`
- `src/components/IVAnomalies/StrikeIVChart.tsx`
- `src/components/IVAnomalies/AnomalyBanner.tsx`
- `api/__tests__/cron-fetch-strike-iv.test.ts`
- `api/__tests__/cron-resolve-iv-anomalies.test.ts`
- `api/__tests__/iv-anomaly.test.ts`
- `api/__tests__/anomaly-context.test.ts`
- `public/sounds/anomaly-chime.mp3` (static asset, royalty-free)

**Modify:**

- `api/_lib/db-migrations.ts`
- `api/_lib/validation.ts`
- `api/_lib/schwab.ts` (verify SPY/QQQ support in Phase 1)
- `api/__tests__/db.test.ts`
- `vercel.json`
- `src/App.tsx`
- `src/main.tsx`

## Data dependencies

**New tables (Neon Postgres):**

```sql
-- Migration 70
CREATE TABLE strike_iv_snapshots (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,               -- 'SPX', 'SPY', 'QQQ'
  strike NUMERIC(10,2) NOT NULL,
  side TEXT NOT NULL,                 -- 'call' | 'put'
  expiry DATE NOT NULL,
  spot NUMERIC(10,4) NOT NULL,
  iv_mid NUMERIC(8,5),
  iv_bid NUMERIC(8,5),
  iv_ask NUMERIC(8,5),
  mid_price NUMERIC(8,4),
  oi INTEGER,
  volume INTEGER,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_strike_iv_snapshots_ticker_ts
  ON strike_iv_snapshots (ticker, ts DESC);
CREATE INDEX idx_strike_iv_snapshots_lookup
  ON strike_iv_snapshots (ticker, strike, side, expiry, ts DESC);

-- Migration 71
CREATE TABLE iv_anomalies (
  id BIGSERIAL PRIMARY KEY,
  ticker TEXT NOT NULL,
  strike NUMERIC(10,2) NOT NULL,
  side TEXT NOT NULL,
  expiry DATE NOT NULL,
  spot_at_detect NUMERIC(10,4) NOT NULL,
  iv_at_detect NUMERIC(8,5) NOT NULL,
  skew_delta NUMERIC(6,4),            -- strike IV minus neighbor-avg IV
  z_score NUMERIC(6,4),               -- rolling Z over last N=60 samples
  ask_mid_div NUMERIC(6,4),           -- iv_ask - iv_mid
  flag_reasons TEXT[] NOT NULL,       -- e.g. ['skew_delta', 'z_score']
  flow_phase TEXT,                    -- 'early' | 'mid' | 'reactive'
  context_snapshot JSONB,             -- cross-asset state at T=detection
  resolution_outcome JSONB,           -- populated EOD by Phase 4
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_iv_anomalies_ticker_ts
  ON iv_anomalies (ticker, ts DESC);
CREATE INDEX idx_iv_anomalies_unresolved
  ON iv_anomalies (ts) WHERE resolution_outcome IS NULL;
```

**context_snapshot JSONB schema (Phase 2, populated at detection time):**

All fields below are joined from EXISTING data streams — no new ingestion.

```ts
interface ContextSnapshot {
  // Own-ticker dynamics
  spot_delta_5m: number; // % change over last 5 min
  spot_delta_15m: number;
  spot_delta_60m: number;
  vwap_distance: number; // % above/below session VWAP
  volume_percentile: number; // intraday-volume rank vs 30-day at same time

  // Cross-ticker (macro tape check)
  spx_delta_15m: number;
  spy_delta_15m: number;
  qqq_delta_15m: number;
  iwm_delta_15m: number;

  // Futures (leading indicators)
  es_delta_15m: number;
  nq_delta_15m: number;
  ym_delta_15m: number;
  rty_delta_15m: number;
  nq_ofi_1h: number | null; // validated microstructure signal (ρ=0.31)

  // Vol regime
  vix_level: number;
  vix_delta_5m: number;
  vix_delta_15m: number;
  vix_term_1d: number | null; // VIX1D
  vix_term_9d: number | null; // VIX9D
  vix_term_30d: number; // standard VIX

  // Macro backdrop
  dxy_delta_15m: number | null;
  tlt_delta_15m: number | null;
  gld_delta_15m: number | null;
  uso_delta_15m: number | null;

  // Flow context (last 15 min, same ticker)
  recent_flow_alerts: Array<{ ts: string; type: string; premium: number }>;
  recent_dark_prints: Array<{ ts: string; price: number; size: number }>;
  // dark_prints FILTERED per feedback_darkpool_filters.md:
  //   drop average_price_trade + derivative_price_trade + contingent_trade
  //   restrict to 08:30-15:00 CT, exclude extended_hours_trade

  // Event proximity
  econ_release_t_minus: number | null; // mins since last release (null if none in last 60m)
  econ_release_t_plus: number | null; // mins until next release (null if none in next 60m)
  econ_release_name: string | null;

  // Institutional context
  institutional_program_latest: {
    ts: string;
    premium: number;
    side: string;
  } | null;

  // Options aggregates (added 2026-04-23 — post-mortem revealed these
  // were the missing cross-sectional signals that would have caught today's
  // flush independently of the per-strike IV anomaly)
  net_flow_5m: number | null; // net options flow $ (call prem - put prem) last 5 min
  nope_current: number | null; // Net Options Pricing Effect, latest
  put_premium_0dte_pctile: number | null;
  // total 0DTE put premium $ today vs trailing-30d same-time-of-day distribution
  // value 99 = top 1% flow intensity, 50 = median

  // Gamma structure (added 2026-04-23 — derived from the Zero-Gamma Level
  // Calculator spec, which runs on every `fetch-spot-gex` tick)
  zero_gamma_level: number | null; // spot price where net dealer gamma = 0
  zero_gamma_distance_pct: number | null;
  // signed: (spot - zero_gamma) / spot * 100
  // negative = spot below zero-gamma = dealers short gamma = destabilizing
  // positive = spot above zero-gamma = dealers long gamma = stabilizing
}
```

**resolution_outcome JSONB schema (Phase 4, populated EOD):**

```ts
interface ResolutionOutcome {
  // Trade economics
  iv_at_detect: number;
  iv_peak: number;
  iv_at_close: number;
  spot_at_detect: number;
  spot_min: number; // for puts: best case
  spot_max: number; // for calls: best case
  spot_at_close: number;
  notional_1c_pnl: number; // hypothetical 1-contract P&L by close
  mins_to_peak: number; // time from detection to IV peak
  outcome_class: string; // 'winner_fast' | 'winner_slow' | 'flat' | 'loser'

  // Catalyst analysis (backward scan T-60 → T+0)
  catalysts: {
    leading_assets: Array<{
      ticker: string;
      lag_mins: number; // positive = this asset moved FIRST
      correlation: number;
    }>;
    large_dark_prints: Array<{ ticker: string; ts: string; notional: number }>;
    range_breaks: Array<{ ticker: string; ts: string; direction: string }>;
    flow_alerts_in_window: Array<{
      ts: string;
      ticker: string;
      premium: number;
    }>;
    likely_catalyst: string; // narrative tag, e.g. 'TLT bid → SPX flush'
  };
}
```

**External APIs:**

- Schwab option chain (already configured) — extend to SPY + QQQ in Phase 1
- No other external services. Alerting is fully in-app.

**New env vars:**

- None. Alerting is fully in-browser (banner + sound), so no webhook secrets
  or cross-service config needed.

**Cron registrations:**

| Path                             | Schedule          | Phase |
| -------------------------------- | ----------------- | ----- |
| `/api/cron/fetch-strike-iv`      | `* 13-21 * * 1-5` | 1     |
| `/api/cron/resolve-iv-anomalies` | `5 21 * * 1-5`    | 4     |

**Snapshot volume estimate:**

~30 strikes × 3 tickers × 3 expiries × 540 polls/day ≈ **145.8K rows/day
(~38M/year)**. Still fine for Neon at current pricing — storage is negligible
for numeric/text types of this size. Composite index on
`(ticker, strike, side, expiry, ts)` covers Phase 3's per-strike history query
shape. **No retention policy — keep everything for ML training depth** (user
decision 2026-04-23).

## Thresholds / constants

Initial defaults (tune after accumulating data — define in
`api/_lib/constants.ts` as named exports):

| Constant                | Value        | Rationale                                          |
| ----------------------- | ------------ | -------------------------------------------------- |
| `OTM_RANGE_PCT`         | 0.03 (±3%)   | Covers 1% (today's example) through tail hedges    |
| `MIN_STRIKE_OI_SPX`     | 500          | SPX strikes are 5-wide; OI concentrates per strike |
| `MIN_STRIKE_OI_SPY_QQQ` | 250          | SPY/QQQ strikes are 1-wide; OI disperses wider     |
| `SKEW_DELTA_THRESHOLD`  | 1.5 vol pts  | Target strike IV vs avg of 2 neighbors each side   |
| `Z_SCORE_THRESHOLD`     | 2.0σ         | Rolling Z over last N snapshots                    |
| `Z_WINDOW_SIZE`         | 60           | ~1h at 1min cadence — stabilizes σ, still reactive |
| `ASK_MID_DIV_THRESHOLD` | 0.5 vol pts  | Tracked separately, not a gate                     |
| `EXPIRIES`              | 0DTE + 2 Fri | Most informed flow is near-dated                   |

## Decisions (locked 2026-04-23)

- **Backend ingestion cadence:** 1min during market hours (`* 13-21 * * 1-5`).
  Matches existing 1-min cron pattern in this repo.
- **Frontend polling cadence:** 60s via the same `POLL_INTERVALS` pattern as
  `useChainData` (with 2x backoff after 3+ consecutive fails).
- **Retention:** no TTL. Keep all snapshots + anomalies forever for ML
  training depth.
- **Anomaly UI TTL:** display until `resolution_outcome IS NOT NULL` (i.e.,
  until the EOD resolve cron labels it). Simplest query shape, no rolling
  window to maintain.
- **IV source of truth:** recompute from mid price via Black-Scholes
  (`src/utils/black-scholes.ts`). Schwab's quoted IV may use a different
  model/forward — recomputing ensures consistency across SPX/SPY/QQQ.
- **Detection side:** both call-side and put-side. Informed call buying is
  equally informative.
- **UI layout:** per-ticker tabs (SPX/SPY/QQQ) to prevent visual overload.
- **Alerting (added 2026-04-23 post-validation; revised to in-app only):**
  fixed-position in-app banner stack + sound chime on new-anomaly transition.
  Fully self-contained — no Discord/Slack/webhook, no OS-level Notification
  API permission prompt. Dedup logic in the `useIVAnomalies` hook diffs the
  result set across polls and only fires on new IDs. Sound is throttled
  (max 1 play per 3s) and user-toggleable via a localStorage flag. Banner
  auto-dismisses after ~10s or on click.
- **Context capture (added 2026-04-23 post-validation):** at detection time,
  `iv_anomalies.context_snapshot` (JSONB) captures the full cross-asset
  state (~35 fields: own-ticker/cross-ticker/futures/vol/macro/flow/
  institutional/econ/options-aggregates/gamma-structure). At EOD resolve,
  `resolution_outcome.catalysts` adds retrospective leading-lag analysis
  in the T-60 → T+0 window. No new data ingestion — all sources already
  in existing cron streams.
- **Dependency on Zero-Gamma Level Calculator:** `zero_gamma_level` and
  `zero_gamma_distance_pct` in the context snapshot require the Zero-Gamma
  Level Calculator feature (separate spec, ~1h). Ship that first or in
  parallel — the IV anomaly detector fails gracefully if those fields are
  null, so it's not a hard blocker.
- **Flow phase classification:** each anomaly tagged `early | mid | reactive`
  based on spot-vs-strike distance + VIX delta + ASK-skew persistence at
  detection time. Separates tradeable alpha (`early`) from chase/hedge
  noise (`reactive`) for ML labeling.

## Open questions

1. **Existing `api/cron/monitor-iv.ts`** — what does it monitor? Potential
   overlap with this feature. Check on Phase 1 kickoff; if it monitors VIX or
   IVR rather than per-strike IV, no conflict. If it's per-strike, we may
   fold into it instead of adding a new cron.

2. **Chain-fetch location** — `api/_lib/schwab.ts` is OAuth-only. The actual
   chain fetcher lives elsewhere (likely `api/chain.ts` or a helper). Locate
   in Phase 1 kickoff and confirm it accepts arbitrary symbols.

3. **Cross-ticker correlation meta-signal (v2)** — if SPY puts + QQQ puts
   spike in the same 1min window, upgrade to a "macro tail" signal?
   → **Default: v2 feature.** Ship single-ticker anomalies first.

## Verification (per-phase)

Each phase ends with `npm run review` passing, reviewer subagent verdict =
pass, then commit to main (per project's direct-to-main convention).

- **Phase 1:** hit `/api/cron/fetch-strike-iv` locally with `CRON_SECRET`,
  verify rows appear in `strike_iv_snapshots` for all 3 tickers.
- **Phase 2:** seed synthetic anomaly chain in unit test, verify `iv_anomalies`
  row written with correct `flag_reasons` array, `flow_phase` classification,
  and `context_snapshot` populated with all ~30 cross-asset fields.
- **Phase 3:** run `npm run dev`, confirm the new section appears, real data
  populates, no console errors, no regression in GEX components. Seed a
  synthetic anomaly via direct DB insert and verify: (a) banner appears on
  next poll with correct ticker/strike/flag reasons, (b) chime plays once
  (subsequent anomalies within 3s are throttled), (c) banner auto-dismisses
  after ~10s, (d) toggling `anomalySoundEnabled = false` in localStorage
  suppresses the chime but keeps the banner.
- **Phase 4:** run resolve cron after an ingestion day, verify
  `resolution_outcome` JSONB populated for every anomaly from that day —
  including the `catalysts` sub-object with leading-lag assets, range
  breaks, and a `likely_catalyst` narrative tag.

## Out of scope

- ML model training (Phase 5, future spec)
- Backtesting framework (labeled data enables this later)
- Claude analyze context integration (add after we trust the signal, likely
  after 2 weeks of labeled data)

## 2026-04-25 expansion — multi-theme broadening (TSLA, META, MSFT, MSTR, MU, SMH)

**Trigger:** 10-day EOD option-flow rollup across all 0DTE-capable tickers
revealed substantial informed-flow surface outside the 7-ticker watchlist
(SPXW, NDXP, SPY, QQQ, IWM, NVDA, SNDK):

| Ticker | 10d premium | Avg vol/OI | Peak vol/OI | ASK win rate  | Notes                                          |
| ------ | ----------- | ---------- | ----------- | ------------- | ---------------------------------------------- |
| TSLA   | $439M       | 190×       | 29907×      | 55% (17W/14L) | Single biggest non-index outsized premium      |
| META   | $184M       | 54.8×      | 2922×       | 83% (5W/1L)   | AI capex play; highest win-rate of the set     |
| MSTR   | $178M       | 26.1×      | 158×        | 75% (3W/1L)   | Bitcoin proxy — non-correlated to tech complex |
| MSFT   | $205M       | 19.9×      | 224×        | 67% (2W/1L)   | AI/cloud leader, sustained activity            |
| MU     | $258M       | 17.4×      | 222×        | 50% (2W/2L)   | Memory peer to SNDK for pair-trade context     |
| SMH    | $182M       | 62.1×      | 2605×       | 100% (1W/0L)  | AI-silicon ETF; small ASK sample but clean     |

**Explicitly excluded:** AMD (267 chains, 85 ASK-dominant, 1W/7L = 12% win
rate — textbook dumb-money fingerprint). Adding it would generate false
alerts.

**Watchlist after expansion (13 tickers):**

```text
SPXW, NDXP, SPY, QQQ, IWM, SMH, NVDA, TSLA, META, MSFT, SNDK, MSTR, MU
```

**OI tier reorganization:**

- `STRIKE_IV_MIN_OI_NVDA` (1000) renamed to `STRIKE_IV_MIN_OI_HIGH_LIQ` —
  now applies to NVDA + TSLA + META + MSFT (all share deep ATM 0DTE OI).
- New `STRIKE_IV_MIN_OI_SECTOR_ETF` (150) for SMH.
- Existing `STRIKE_IV_MIN_OI_SINGLE_NAME` (200) extends to MSTR + MU
  alongside SNDK.

**Schwab API budget impact:** 13 chains/min × 60 min × 8 hr = 6,240 chain
fetches per market day, up from ~3,360. Still well under per-app rate
limit.

**Strategy intentionally NOT baked in.** The expansion captures entry
signals across a broader informed-flow surface; trading-strategy
decisions (sizing, exit logic, hold horizon) are downstream of detection
and intentionally separate from the detector. Per-ticker signal vs price
movement will be analyzed via ML once enough labeled data accumulates.

**Files touched (this expansion only):**

- `api/_lib/constants.ts` — STRIKE_IV_TICKERS array, OI tier rename + new SECTOR_ETF tier
- `api/cron/fetch-strike-iv.ts` — schwabSymbol/minOiFor/matchesRoot exhaustive switches
- `api/__tests__/cron-fetch-strike-iv.test.ts` — mockChainSequence calls extended to 13 entries
- `api/__tests__/endpoint-iv-anomalies.test.ts` — list-mode mock counts 7 → 13
- `api/__tests__/fixtures/build-2026-04-23-flush.ts` — quiet baselines + strike grids for 6 new tickers
- `api/__tests__/e2e-2026-04-23-flush.test.ts` — TICKERS replay array
- `scripts/preview-flush-alerts.ts` — TICKERS replay array
- `src/components/IVAnomalies/types.ts` — IVAnomalyTicker union + IV_ANOMALY_TICKERS array
- Mobile push notifications (Discord acts as the mobile channel for now)

## 2026-04-25 gate loosening — single-name capture rebalance

**Trigger:** the multi-theme expansion alone wasn't enough. 10-day
backfill replay against the original gates (vol/OI ≥ 5×, OI floor 1000
on high-liq tier, OTM ±3%) showed that 60-89% of single-name rollup
chains were dropped by the OI floor alone, and another 75-90% were
dropped by the narrow OTM gate. Net result: only 13 alerts captured
across all six new tickers in 10 days — too thin to justify their
addition.

**OI floors lowered across the board:**

| Tier                                 | Old  | New     | Constant                       |
| ------------------------------------ | ---- | ------- | ------------------------------ |
| Index (SPXW/NDXP)                    | 500  | **300** | `STRIKE_IV_MIN_OI_INDEX`       |
| SPY/QQQ                              | 250  | **150** | `STRIKE_IV_MIN_OI_SPY_QQQ`     |
| IWM                                  | 150  | **75**  | `STRIKE_IV_MIN_OI_IWM`         |
| Sector ETF (SMH)                     | 150  | **100** | `STRIKE_IV_MIN_OI_SECTOR_ETF`  |
| High-liq names (NVDA/TSLA/META/MSFT) | 1000 | **500** | `STRIKE_IV_MIN_OI_HIGH_LIQ`    |
| Mid-liq (SNDK/MSTR/MU)               | 200  | **100** | `STRIKE_IV_MIN_OI_SINGLE_NAME` |

**OTM range bifurcated** (was uniform `STRIKE_IV_OTM_RANGE_PCT = 0.03`):

- `STRIKE_IV_OTM_RANGE_PCT_INDEX = 0.03` — SPXW, NDXP, SPY, QQQ, IWM
- `STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME = 0.05` — SMH, NVDA, TSLA, META,
  MSFT, SNDK, MSTR, MU

Resolved by new `otmRangePctFor(ticker)` exhaustive switch in
`fetch-strike-iv.ts`, mirroring `minOiFor()`.

**Backfill impact (10-day replay):**

| Ticker    | Before  | After   | Δ        |
| --------- | ------- | ------- | -------- |
| SPXW      | 47      | 125     | +166%    |
| SPY       | 124     | 151     | +22%     |
| QQQ       | 167     | 215     | +29%     |
| IWM       | 68      | 89      | +31%     |
| SMH       | 1       | 6       | +500%    |
| NVDA      | 0       | **7**   | +∞       |
| TSLA      | 2       | 3       | +50%     |
| MSFT      | 4       | 5       | +25%     |
| MSTR      | 3       | 10      | +233%    |
| MU        | 3       | 7       | +133%    |
| **Total** | **419** | **618** | **+47%** |

META and SNDK still 0 — likely structural (META 0DTE flow is balanced;
SNDK directional flow concentrates in long-dated 2028 strikes outside
even the widened ±5% OTM gate). To be revisited if their detector
silence persists past 2 weeks.

**Files touched (this gate change):**

- `api/_lib/constants.ts` — OI floors + bifurcated OTM constants
- `api/cron/fetch-strike-iv.ts` — added `otmRangePctFor()` resolver
- `api/__tests__/cron-fetch-strike-iv.test.ts` — updated boundary probes
- `scripts/backfill-iv-anomalies-from-csv.py` — mirror constants for replay parity

## 2026-04-25 cash-index whale capture — three-tier OTM gate

**Trigger:** 2026-04-24 NDXP flow review surfaced lottery-ticket whale
prints at 11% OTM (e.g. 27300C 0DTE: $1.90 → $42.85, +2,155% on 51×
vol/OI) that the prior ±3% index gate filtered out completely. Same
pattern repeats across cash-index roots — institutional desks routinely
buy 8-12% OTM 0DTE strikes for high-leverage directional bets.

**Gate restructured into three tiers** (was two):

| Tier | Tickers | OTM range | Constant |
| ---- | ------- | --------- | -------- |
| Cash-index weeklies | SPXW, NDXP | **±12%** | `STRIKE_IV_OTM_RANGE_PCT_CASH_INDEX` |
| Broad ETFs | SPY, QQQ, IWM | ±3% | `STRIKE_IV_OTM_RANGE_PCT_BROAD_ETF` |
| Sector ETF + single names | SMH, NVDA, TSLA, META, MSFT, SNDK, MSTR, MU | ±5% | `STRIKE_IV_OTM_RANGE_PCT_SINGLE_NAME` |

**OI floor for cash-index dropped from 300 → 50** to capture deep-OTM
whale strikes that cluster at low OI but carry massive vol/OI ratios
(verified: NDXP 27300C had OI=70, vol=3592 = 51× ratio — all rejected
by 300 floor). New constant: `STRIKE_IV_MIN_OI_CASH_INDEX = 50`,
replacing the prior `STRIKE_IV_MIN_OI_INDEX`.

**Implementation note — UW CSV missing NDX spot.** The UW EOD CSV does
not include `underlying_price` for NDX/NDXP options across any of the
10 days reviewed. The aggregator works around this by deriving NDX
spot per minute from same-minute QQQ spot × 40.5 (the empirical
NDX/QQQ ratio). Good to ±1-2% on any given day, plenty accurate for
the ±12% OTM gate. Live cron is unaffected — Schwab returns NDX spot
directly via the chain endpoint.

**Backfill impact:**

| Metric | Before | After | Δ |
| ------ | ------ | ----- | -- |
| iv_anomalies (backfill rows) | 15,741 | 15,886 | +145 |
| strike_iv_snapshots (10 days) | 614,687 | 740,120 | +125,433 |
| NDXP alerts (was 0) | 0 | **148** | new tier captured |
| NDXP whale-strike captures (4/24, 11% OTM) | 0 | **14 unique strikes** | including 27300C, 27260C, 27250C, 27200C |

**Files touched (this gate change):**

- `api/_lib/constants.ts` — split index OTM into CASH_INDEX/BROAD_ETF, lowered cash-index OI floor 300 → 50
- `api/cron/fetch-strike-iv.ts` — three-tier `otmRangePctFor()`, `minOiFor()` cash-index update
- `api/__tests__/cron-fetch-strike-iv.test.ts` — updated boundary probes (250/350 → 25/75 for cash-index)
- `scripts/backfill-aggregate.py` — JOIN to derive NDX spot from QQQ × 40.5 fallback
- `scripts/backfill-snapshots.ts` — three-tier OTM lookup mirror
