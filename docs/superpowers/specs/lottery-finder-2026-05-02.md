# Lottery Finder — replaces Gamma Squeezes (Velocity)

**Date:** 2026-05-02
**Author:** Session continued from options-flow-analysis backtest
**Status:** Spec — pending user approval before implementation
**Revision:** v0.2 — added macro-context display layer; negative-findings appendix for macro-feature regime gating (p30/p31)

---

## What this is

A **signal detector** (not a trading strategy) that surfaces options-flow setups historically associated with explosive right-tail outcomes. Replaces the existing `gamma_squeeze_events` velocity detector with a richer event-based trigger + RE-LOAD selection rule discovered in the 15-day backtest at `docs/tmp/options-flow-analysis/`.

## What this is NOT

- **Not a backtested profitable strategy.** The 15-day window had positive aggregate EV under multiple exit policies, but the edge is concentrated in 1-2 outlier days per 15. Without those days, only the most conservative exit (`act30_trail10`) is barely positive.
- **Not consistent income.** Expect 50-75% losing days. Wins come from rare big days.
- **Not validated on out-of-sample data.** Single 15-day window (2026-04-13 to 2026-05-01). Real validation needs 60-90+ days of data, ideally crossing volatility regimes.

The user is fully aware of these caveats and chose to ship this as a discretionary tool, not a black-box system.

---

## Honest backtest framing (must appear in UI tooltips)

| Fact | Value |
|------|-------|
| Backtest window | 2026-04-13 to 2026-05-01 (15 trading days) |
| Total v4 trigger fires | 179,890 |
| RE-LOAD-tagged subset | 783 |
| RE-LOAD lottery winners (≥+200% EoD peak) | 71 (9.1% of RE-LOAD) |
| RE-LOAD big lotteries (≥+500% EoD peak) | 27 (3.4% of RE-LOAD) |
| Cheap-call-PM RE-LOAD subset (selection rule) | 74 |
| Cheap-call-PM lottery rate (≥+200%) | **18.9%** (2.1× baseline) |
| Top-3/day cherry-pick total $ over 15 days, act30_trail10 | +$672 (88% from 2026-04-21 alone) |
| Top-3/day cherry-pick total $ excluding 4/21 + 5/1 | +$55 |
| Days profitable (LOO, act30_trail10) | 6/12 (50%) |
| Days profitable (LOO, hard_30m) | 3/12 (25%) — but mean +$127/day |
| Macro-feature regime gates tested (p30 + p31) | None improved total P&L; see Appendix A |

---

## Phase 1 — Backend: trigger detector + selection rule + writer

### Task 1.1 — Drop existing gamma_squeeze_events tables, indexes, cron, lib, endpoint, tests
- [ ] Add migration #N: `DROP TABLE IF EXISTS gamma_squeeze_events CASCADE;` (drops indexes too)
- [ ] Delete files: `api/_lib/gamma-squeeze.ts`, `api/gamma-squeezes.ts`, `api/__tests__/gamma-squeeze.test.ts`, `api/__tests__/gamma-squeezes.test.ts`, `api/__tests__/endpoint-gamma-squeezes.test.ts`
- [ ] Remove gamma_squeeze references from `api/_lib/validation.ts` (gammaSqueezesQuerySchema), `api/_lib/request-scope.ts`, `api/_lib/precision-stack.ts`, `api/_lib/strike-iv-detection.ts` (cross-check; some may stay if used elsewhere)
- [ ] Verify: `grep -r "gamma_squeeze\|GammaSqueez" api/` returns 0 lines (after deletion)
- **Verify:** `npm run lint` passes; `npm run test` doesn't fail on missing imports

### Task 1.2 — Create `lottery_finder_fires` table (migration)
- [ ] Add migration in `api/_lib/db-migrations.ts` with this schema (see Schema section below)
- [ ] Update `api/__tests__/db.test.ts` with `{id: N}` and SQL call count
- **Verify:** `npm run test:run -- db.test.ts` passes

### Task 1.3 — Implement trigger detector + selection in `api/_lib/lottery-finder.ts`
- [ ] Port `scan_chain_v4` logic from `docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py` to TypeScript. Operates on a stream of trades for a chain. Returns one or more "fires" per chain per day with full feature set.
- [ ] Implement `applyReloadTag(fires)` — compares each fire to its prior fire on same chain.
- [ ] Implement `applyCheapCallPMFlag(fire)` — pure function: `entry_price < 1 AND option_type = 'call' AND tod = 'PM'`.
- [ ] Implement realized exit simulators in `api/_lib/lottery-exit-policies.ts`:
  - `realizedTrailAct30Trail10(prices, entry)` — default
  - `realizedHardStop30m(prices, entry, ts_minutes)` — EV-best in backtest
  - `realizedTier50HoldEod(prices, entry, ts_minutes)` — middle ground
  - `peakCeiling(prices, entry)` — diagnostic only
- [ ] Unit tests: each function tested against fixtures derived from the SNDK 1175C 5/1 fire #4 case (entry $1.30 → peak $14.25). Assert known outputs from `docs/tmp/options-flow-analysis/outputs/p27_policy_grid.csv`.
- **Verify:** `npm run test:run -- lottery-finder lottery-exit-policies` all pass

### Task 1.4 — Cron handler `api/cron/detect-lottery-fires.ts`
- [ ] Use `cronGuard` per CLAUDE.md pattern
- [ ] Pull new minute-level trade data from existing source (likely Databento sidecar or UW per-strike intraday — confirm during implementation)
- [ ] Run trigger detector on each chain's day-to-date trade stream
- [ ] For each fire: compute features, RE-LOAD tag, cheap-call-PM flag
- [ ] **Attach macro-context snapshot at fire time (asof lookup):**
  - From `flow_data` table: latest `market_tide.ncp/npp`, `market_tide_otm.ncp/npp`, `spx_flow.ncp/npp`, `spy_etf_tide.ncp/npp`, `qqq_etf_tide.ncp/npp`, `zero_dte_greek_flow.ncp/npp`, all at or before fire timestamp
  - From `spot_exposures` table: latest SPX `gamma_oi`, `gamma_vol`, `charm_oi`, `vanna_oi`
  - From `strike_exposures` table (only when `underlying_symbol IN ('SPX','SPXW','NDX','NDXP','SPY','QQQ')`): per-strike GEX with bid/ask vol breakdown at the alert's strike
  - Macro snapshot is **display-only** — NOT used as a selection gate (per p30/p31 negative findings, see Appendix A)
- [ ] Write to `lottery_finder_fires` table with `ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING`
- [ ] Schedule in `vercel.json` every 5 min during market hours
- [ ] Add path to `protect` array in `src/main.tsx` `initBotId()` call
- [ ] Add `api/__tests__/detect-lottery-fires.test.ts` mocking `getDb` per CLAUDE.md cron test pattern
- **Verify:** `npm run test:run -- detect-lottery-fires` passes; cron registered in vercel.json

### Task 1.5 — Read endpoint `api/lottery-finder.ts`
- [ ] GET endpoint returning recent fires + computed exit-policy-realized returns (live)
- [ ] Query params: `?ticker=`, `?reload=true|false`, `?cheapCallPm=true|false`, `?since=`
- [ ] Returns: row per fire with all features + the live realized return under each exit policy (computed from current price)
- [ ] Zod schema in `api/_lib/validation.ts` for query params
- [ ] Bot protection (add to `src/main.tsx` initBotId protect list)
- [ ] Test in `api/__tests__/lottery-finder-endpoint.test.ts`
- **Verify:** `npm run test:run -- lottery-finder` passes; manual curl against dev returns valid JSON

---

## Phase 2 — Frontend: Lottery Finder component

### Task 2.1 — Delete existing GammaSqueezes component tree
- [ ] Delete `src/components/GammaSqueezes/` (GammaSqueezeFeed, SqueezeRow, types, __tests__)
- [ ] Delete `src/hooks/useGammaSqueezes.ts` and its test
- [ ] Remove GammaSqueezeFeed import + render from `src/App.tsx`
- **Verify:** `npm run build` passes (no broken imports)

### Task 2.2 — Create `src/components/LotteryFinder/` component
- [ ] `LotteryFinderFeed.tsx` — list of recent fires
- [ ] `LotteryRow.tsx` — single fire display
- [ ] `types.ts` — types mirroring `api/lottery-finder.ts` response
- [ ] `useLotteryFinder.ts` hook — polls `/api/lottery-finder` every 30s during market hours
- [ ] Tests in `__tests__/`
- **Verify:** `npm run build` passes; `npm run test:run -- LotteryFinder` passes

### Task 2.3 — UI requirements (per user spec)
- [ ] Component title: **"Lottery Finder"**
- [ ] Subtitle / caption: **"Signal detector — not a backtested profitable strategy. Most days lose; wins come from rare explosive moves. See methodology."**
- [ ] Per-row display: ticker, strike, side, entry, time, RE-LOAD badge, cheap-call-PM badge, alert_seq
- [ ] Per-row display: realized return under each exit policy (live), peak ceiling
- [ ] **Default exit policy = `act30_trail10`** (most conservative; positive in 50% of LOO days)
- [ ] **Toggles** for: `hard_30m` (EV-best) and `tier_50_holdEod` (middle ground)
- [ ] **Per-row macro context badges (display-only, not selection):**
  - "Market Tide: ⬆️ +12M / ⬇️ -8M / ➡️ flat" — NCP minus NPP at fire time, color by sign
  - "0DTE Flow: ⬆️ / ⬇️ / ➡️" — zero_dte_greek_flow diff at fire time
  - "SPX Charm: 🔥 extreme / regular" — Q1 (most negative charm_oi) gets a fire emoji
  - "SPX Spot GEX: 🔴 negative / 🟢 positive" — gamma_oi sign
  - For SPY/QQQ/SPX/NDX alerts only: "Strike GEX: 🔴 net-short / 🟢 net-long" — call_minus_put gamma at strike
  - Tooltips on each macro badge explain the metric AND link to the negative-findings caveat: "Macro context is informational only — backtest showed these features did not improve our specific selection rule. See Appendix A in the spec."
- [ ] **Day-level macro banner** at top of feed: "Regime today: Market Tide [diff], 0DTE flow [diff], SPX gamma [sign]" — gives the trader at-a-glance context independent of any specific alert
- [ ] Tooltips required on EVERY metric (see Tooltip Catalog below)
- [ ] Filter chips: "RE-LOAD only", "Cheap-call-PM only", "Mode A (0DTE) only", "Mode B (DTE 1-3 stocks) only"
- [ ] Sort: most recent fire first by default; option to sort by current realized %
- [ ] Empty state: "No fires today yet. The detector emits during market hours; expect 0-5 cheap-call-PM RE-LOAD fires per day."
- **Verify:** Visual review in dev; verify all tooltips populated; verify filter chips work; verify macro badges populated for at least 50% of fires (some macro lookups may miss for very early-session fires)

### Task 2.4 — Wire into App.tsx
- [ ] Lazy-import `LotteryFinderFeed` (matches existing pattern from GammaSqueezeFeed)
- [ ] Render in same slot the GammaSqueezeFeed previously occupied
- **Verify:** Component appears in app, populates from API

---

## Phase 3 — Repeatable analysis pipeline (for new daily parquet)

### Goal
After every trading day, the user drops a new `2026-MM-DD-trades.parquet` into `/Users/charlesobrien/Desktop/Bot-Eod-parquet/`. Another agent (or future Claude session) needs to be able to:
1. Re-run the trigger detection on the full extended dataset
2. Re-validate the cheap-call-PM RE-LOAD selection rule still holds
3. Update the per-ticker / per-setup tables
4. Detect regime shifts (e.g., the rule stops working)

### Task 3.1 — Create `docs/tmp/options-flow-analysis/PIPELINE.md`
Write step-by-step instructions for a fresh agent to pick up the analysis. Must include:

```markdown
# Lottery Finder Pipeline — append a new trading day

## Prerequisites
- Repo at /Users/charlesobrien/Documents/Workspace/strike-calculator
- Python venv at ml/.venv (use ml/.venv/bin/python explicitly)
- New parquet file dropped into /Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-MM-DD-trades.parquet

## Pipeline (sequential — each step depends on prior)

### Step 1: Re-run v4 trigger detection
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py
# - Auto-discovers all parquet files (no list to update)
# - Outputs outputs/p14_event_triggers.csv (overwrites)
# - Expected runtime: ~10 min for 15 days, +1 min per added day

### Step 2: Fix UTC->CT timezone (one-time per p14 re-run)
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p16_fix_tz.py
# - Modifies p14_event_triggers.csv in place

### Step 3: Re-run canonical realized exits
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p26_canonical_realized.py
# - Outputs p26_per_trade_realized.csv, per_ticker_summary, per_setup_summary

### Step 4: Re-run policy grid (optional — only if exit policy is being re-evaluated)
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p27_exit_policy_grid.py
# - Outputs p27_policy_grid.csv, p27_policy_summary.csv

### Step 5: Re-run lottery discriminator + stress test
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p28_lottery_discriminator.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p29_stress_test.py
# - p28: validates cheap-call-PM still has 1.5×+ lottery lift
# - p29: validates rule isn't entirely driven by 1-2 outlier days

### Step 5b: Re-run macro feature validation (informational)
npx tsx docs/tmp/options-flow-analysis/scripts/dump_macro_tables.ts
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p30_macro_features.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p31_put_regime_rule.py
# - dump_macro_tables: pulls latest flow_data, spot_exposures, strike_exposures
# - p30: re-validates the macro-vs-rule discriminator analysis
# - p31: re-validates the put regime-switching rule
#
# Pass criteria (informational): if EITHER macro AND-rule beats the
# cheap-call-PM-only baseline by ≥ 10% on top-3/day total $ realized,
# OPEN A NEW SPEC to upgrade the selector. Do NOT change the rule silently.
# (At v0.1: both macro AND-rules underperformed; we re-test as data grows.)

### Step 6: Verify selection rule still holds (PASS/FAIL)
Pass criteria (all must hold):
- p28 cheap-call-PM lottery rate ≥ 1.5× baseline (Q5 lift in univariate sweep)
- p29 LOO: at least 40% of days profitable under act30_trail10
- p29 bootstrap: at least 80% of resampled windows profitable under act30_trail10

If FAIL on any: regime change detected. Open a new spec
docs/superpowers/specs/lottery-finder-rule-rederivation-YYYY-MM-DD.md
to investigate. Do NOT silently update the production rule.

### Step 7: Update production rule (only if PASS)
The production rule lives in api/_lib/lottery-finder.ts as constants.
Currently:
  CHEAP_CALL_PM_ENTRY_MAX = 1.0
  RELOAD_BURST_RATIO_MIN = 2.0
  RELOAD_ENTRY_DROP_MAX = -30.0

If p28 univariate sweep suggests a tighter or looser threshold,
update with explicit comment + commit message citing the analysis date
and supporting metric.
```

- [ ] Write that file with the exact commands and pass/fail criteria
- [ ] Include a **state-tracking section** (see Task 3.2)
- **Verify:** A fresh Claude session reading PIPELINE.md should be able to run the steps without ambiguity

### Task 3.2 — State-tracking file `docs/tmp/options-flow-analysis/PIPELINE_STATE.md`
- [ ] Append-only log: each entry has date appended, p28 lottery lift, p29 LOO win-rate, pass/fail verdict, agent who ran it
- [ ] Schema:
  ```markdown
  ## 2026-MM-DD (added day 2026-MM-DD)
  - p28 cheap-call-PM lottery rate: X.X% (vs Y.Y% baseline, Z.Zx lift)
  - p29 LOO act30_trail10 profitable days: X / Y (Z%)
  - p29 bootstrap % > $0 (act30_trail10): X.X%
  - Verdict: PASS / FAIL
  - Notes: ...
  - Run by: <agent name or "user">
  ```
- [ ] Include current entry as the seed (2026-05-02 state from this session's analysis)

### Task 3.3 — Bootstrap script for new agent context
- [ ] Create `docs/tmp/options-flow-analysis/AGENT_CONTEXT.md` summarizing:
  - What the project is (1 paragraph)
  - Where data lives (parquet location, intermediate CSVs in outputs/)
  - The spec rule + thresholds
  - The honest caveats (regime dependence, sample size)
  - Pointer to PIPELINE.md for "what to run"
  - Pointer to PIPELINE_STATE.md for "what's been validated"
  - Pointer to this spec doc as the source of truth
- **Verify:** Manually read it as if you were a new agent and confirm it gives complete context

---

## Schema — `lottery_finder_fires`

```sql
CREATE TABLE IF NOT EXISTS lottery_finder_fires (
  id                          BIGSERIAL PRIMARY KEY,

  -- Identity
  date                        DATE NOT NULL,
  trigger_time_ct             TIMESTAMPTZ NOT NULL,
  entry_time_ct               TIMESTAMPTZ NOT NULL,
  option_chain_id             TEXT NOT NULL,
  underlying_symbol           TEXT NOT NULL,
  option_type                 TEXT NOT NULL CHECK (option_type IN ('call', 'put')),
  strike                      NUMERIC(12, 4) NOT NULL,
  expiry                      DATE NOT NULL,
  dte                         SMALLINT NOT NULL,

  -- Trigger features (5-min rolling, from v4 detector)
  trigger_vol_to_oi_window    NUMERIC NOT NULL,
  trigger_vol_to_oi_cum       NUMERIC NOT NULL,
  trigger_iv                  NUMERIC NOT NULL,
  trigger_delta               NUMERIC NOT NULL,
  trigger_ask_pct             NUMERIC NOT NULL,
  trigger_window_size         INTEGER NOT NULL,
  trigger_window_prints       INTEGER NOT NULL,

  -- Entry context
  entry_price                 NUMERIC NOT NULL,
  open_interest               INTEGER NOT NULL,
  spot_at_first               NUMERIC NOT NULL,
  alert_seq                   INTEGER NOT NULL,
  minutes_since_prev_fire     NUMERIC NOT NULL DEFAULT 0,

  -- Derived discriminators
  flow_quad                   TEXT NOT NULL,             -- call_ask, call_bid, call_mixed, put_*
  tod                         TEXT NOT NULL,             -- AM_open, MID, LUNCH, PM
  mode                        TEXT NOT NULL,             -- A_intraday_0DTE, B_multi_day_DTE1_3
  reload_tagged               BOOLEAN NOT NULL,
  cheap_call_pm_tagged        BOOLEAN NOT NULL,
  burst_ratio_vs_prev         NUMERIC,                   -- NULL on alert_seq=1
  entry_drop_pct_vs_prev      NUMERIC,                   -- NULL on alert_seq=1

  -- Macro context snapshot at fire time (display-only, NOT used as a selector
  -- per p30/p31 negative findings — see Appendix A). Sourced via asof lookup
  -- against flow_data, spot_exposures, strike_exposures.
  mkt_tide_ncp                NUMERIC,
  mkt_tide_npp                NUMERIC,
  mkt_tide_diff               NUMERIC,                  -- ncp - npp; signed regime indicator
  mkt_tide_otm_diff           NUMERIC,                  -- OTM-only NCP - NPP
  spx_flow_diff               NUMERIC,                  -- SPX-specific NCP - NPP
  spy_etf_diff                NUMERIC,                  -- SPY ETF tide
  qqq_etf_diff                NUMERIC,                  -- QQQ ETF tide
  zero_dte_diff               NUMERIC,                  -- 0DTE greek flow
  spx_spot_gamma_oi           NUMERIC,
  spx_spot_gamma_vol          NUMERIC,
  spx_spot_charm_oi           NUMERIC,
  spx_spot_vanna_oi           NUMERIC,
  -- Per-strike GEX (NULL for non-index/ETF tickers; ~4% coverage in backtest)
  gex_strike_call_minus_put   NUMERIC,
  gex_strike_call_ask_minus_bid NUMERIC,
  gex_strike_put_ask_minus_bid  NUMERIC,
  gex_strike_actual_strike    NUMERIC,                  -- nearest available strike

  -- Outcome (populated by enrich cron later in the day)
  realized_trail30_10_pct     NUMERIC,
  realized_hard30m_pct        NUMERIC,
  realized_tier50_holdeod_pct NUMERIC,
  realized_eod_pct            NUMERIC,
  peak_ceiling_pct            NUMERIC,
  minutes_to_peak             NUMERIC,

  inserted_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enriched_at                 TIMESTAMPTZ
);

CREATE UNIQUE INDEX uniq_lottery_finder_fire_key
  ON lottery_finder_fires (option_chain_id, trigger_time_ct);

CREATE INDEX idx_lottery_finder_date_ts
  ON lottery_finder_fires (date DESC, trigger_time_ct DESC);

CREATE INDEX idx_lottery_finder_cheap_call_pm
  ON lottery_finder_fires (date DESC, cheap_call_pm_tagged, reload_tagged)
  WHERE cheap_call_pm_tagged = TRUE;
```

---

## Tooltip Catalog (per UI requirement c — "lots of tooltips, explain everything")

Every metric on the UI gets a tooltip. Source of truth list:

| UI label | Tooltip text |
|----------|--------------|
| **Lottery Finder** (header) | "Surfaces options-flow setups historically associated with explosive returns. NOT a backtested profitable strategy. Most days lose; wins come from rare big days. See methodology link." |
| RE-LOAD | "Tagged when this fire's burst is ≥2× the prior fire on the same chain AND entry price dropped ≥30% since prior fire. Marks the SNDK-style continuation pattern (chain getting cheaper while volume re-accelerates). 9.1% historical lottery rate vs 1.4% on non-RE-LOAD." |
| Cheap-call-PM | "Tagged when entry < $1 AND option_type = call AND time-of-day = PM. The selection rule from the 15-day backtest — 18.9% lottery rate (vs 9.1% RE-LOAD baseline). Caveat: edge is concentrated in 1-2 outlier days per 15." |
| alert_seq | "How many fires this chain has emitted today. seq=1 is the first fire; later fires are confirmation/re-acceleration. Most lottery winners are seq 4-12, not the first fire." |
| trail30_10% (default exit) | "Realized return if you used a trailing stop: activates at +30%, exits when current return drops 10pp below running peak. The most psychologically sustainable policy in our backtest (50% of days profitable). Historical median realized: +8% per RE-LOAD trade." |
| hard_30m% | "Realized return if you exit at minute 30 from entry, no matter what. Highest expected value in our backtest (+$127/day mean), but only 25% of days are profitable — wins are bigger but rarer." |
| tier_50_holdEod% | "Realized return if you sell half at +50% and hold the rest to end-of-session. Middle ground between the trailing stop and hard exit." |
| peak ceiling | "Best possible exit (chain's max price - entry). DIAGNOSTIC ONLY — not achievable in real trading. Shown so you can see how much upside the chosen exit policy left on the table." |
| flow_quad | "option_type + dominant trigger side. call_ask = call options bought aggressively. call_mixed = balanced flow on calls. put_mixed = balanced flow on puts (rarely a lottery, 2% rate)." |
| Mode A | "0-DTE intraday — SPY, QQQ, IWM, SPX-style. Designed for fast scalps." |
| Mode B | "DTE 1-3 multi-day — META, AMD, NVDA-style stock options. Different trade dynamics; the cheap-call-PM rule is much weaker here." |
| TOD | "Time-of-day bucket. PM (12:30-15:00 CT) had the highest lottery rate (12.4%) in our backtest." |

---

## Open questions (must answer before coding)

1. **Trade data source:** the existing v4 detector ran offline against parquet. Live, do we read from:
   - The Databento sidecar (sidecar/) trade stream — likely best, lowest latency
   - UW per-strike intraday flow (existing cron in api/cron/fetch-strike-trade-volume.ts) — easier integration but may miss prints
   - Determine during Phase 1.4 implementation. Confirm with user before writing the cron.

2. **Outcome enrichment cadence:** when do we compute the realized exit returns?
   - Option a: live, every 30s (UI computes from current price)
   - Option b: at fixed checkpoints (T+5min, T+30min, EoD)
   - Option c: enrichment cron at EoD that backfills all outcomes
   - Recommended: live for the displayed metric (UI shows current realized) + EoD enrichment cron to lock historical outcomes for the analysis pipeline.

3. **Mode B treatment:** the analysis showed RE-LOAD doesn't transfer well to Mode B. Should we:
   - a) Show Mode B fires with a warning badge
   - b) Hide Mode B fires entirely from the default view (toggle to show)
   - Recommend (a) — discoverability matters even if performance is weaker.

4. **Holdout for live comparison:** since this is replacing destructively, we lose the ability to A/B compare against the old detector. Acceptable per user's earlier answer ("Option B - destructive replace") — confirming.

---

## Done When (top-level success criteria)

- [ ] Old `gamma_squeeze_events` table dropped, all related code removed
- [ ] New `lottery_finder_fires` table created and migrated
- [ ] `api/cron/detect-lottery-fires.ts` runs every 5 min during market hours, populates the table
- [ ] `/api/lottery-finder` endpoint returns the data
- [ ] `LotteryFinder` component renders fires with default `act30_trail10`, toggles for `hard_30m` + `tier_50_holdEod`, full tooltip coverage, honest framing in subtitle
- [ ] `docs/tmp/options-flow-analysis/PIPELINE.md`, `PIPELINE_STATE.md`, `AGENT_CONTEXT.md` written
- [ ] `npm run review` passes (lint + typecheck + tests)
- [ ] Manual smoke test: run dev server, see Lottery Finder render, see at least one fire (or "no fires today" empty state)
- [ ] User has read this spec and approved it before any destructive action

---

## Notes

- **Cron schedule:** every 5 min during market hours (13:30-20:00 UTC, Mon-Fri). Stagger off the top of the minute (e.g., `*/5 * * * *` offset by 1 minute) to avoid bursting against the data source if it's UW.
- **Sentry:** instrument the cron with `cron.lottery_finder.fires_per_run` metric.
- **Backfill story:** when the table is first created, leave it empty. The cron starts populating fresh. The historical analysis (15 days) lives in `docs/tmp/options-flow-analysis/outputs/p26_per_trade_realized.csv` and is referenced by the spec, not in the production table.
- **Sample size growth plan:** target 60+ days of live data before calling this "validated". Until then, the UI subtitle should remain explicit about caveats.

---

## Appendix A — Macro-feature gating: tested, not adopted (p30 + p31)

This appendix documents a serious experiment that produced a clean negative result. **Future agents: do not re-derive this from scratch.** If a new approach to macro gating shows promise, treat it as a new hypothesis and run the same tests (univariate quintile, AND-rule, realistic-trader top-N/day) as p30/p31.

### Hypothesis

The cheap-call-PM rule's edge concentrated on 1-2 outlier days per 15. This suggests **regime dependence** — most lottery winners happen on days with extreme macro readings (high vol, big tide moves, negative gamma). If we could detect "today is a lottery-prone regime" from existing macro features, we could either:
- Tighten cheap-call-PM (only fire on bullish-regime days), OR
- Add a symmetrical cheap-put-PM rule for bearish-regime days

### What we tested

**Inputs (all already collected by existing crons; coverage 15/15 days for our window):**
- `flow_data` table: `market_tide`, `market_tide_otm`, `spx_flow`, `spy_flow`, `qqq_flow`, `spy_etf_tide`, `qqq_etf_tide`, `zero_dte_greek_flow` (NCP, NPP, net_volume; 5-min granularity)
- `spot_exposures` table: SPX `gamma_oi`, `gamma_vol`, `charm_oi`, `vanna_oi` (1-min granularity)
- `strike_exposures` table: per-strike GEX with bid/ask volume breakdown for SPX/NDX/SPY/QQQ only

**Methodology:** for each of 783 RE-LOAD fires, attach the latest macro snapshot at or before fire time. Run univariate quintile sweeps + AND-rule combinations + realistic-trader top-N/day P&L.

### What the data showed (univariate)

Several macro features DID predict lottery rate at the population level (1.5-2.1× lift in Q1 or Q5 quintile):

| Feature | Best quintile | Lottery % | Lift |
|---------|---------------|-----------|------|
| spy_flow_diff | Q1 (most bearish) | 16.6% | 1.8× |
| zero_dte_diff | Q1 (most bearish) | 19.1% | 2.1× |
| spx_spot_charm_oi | Q1 (most negative) | 18.5% | 2.0× |
| spx_spot_gamma_vol | Q1 (most negative) | 17.2% | 1.9× |
| mkt_tide_diff | U-shaped (Q1+Q5 both 13.4%) | 13.4% | 1.5× |

**Direction was opposite to the original hypothesis: bearish/volatile regime → lotteries, not bullish.** Mostly because RUTW puts on 4/21 dominated lottery counts.

### What the data showed (combined rules — failed)

When we combined macro features with cheap-call-PM (p30) and cheap-put-PM (p31):

| Rule | n | Lottery % | Lift | Top-3/day act30 total $ |
|------|---|-----------|------|--------------------------|
| **cheap-call-PM only (current)** | **74** | **18.9%** | **2.1×** | **+$672** |
| cheap-call-PM AND mkt_tide_otm > 0 | 23 | 17.4% | 1.9× | (smaller subset) |
| cheap-call-PM AND ALL macro > 0 | 7 | 14.3% | 1.6× | -$142 |
| cheap-put-PM only | 91 | 9.9% | 1.1× | (worse than baseline) |
| cheap-put-PM AND spy_flow Q1 | 24 | 12.5% | 1.4× | (small lift, tiny n) |
| **2-mode regime-gated (call neutral, put bearish)** | **78** | **10.3%** | **1.1×** | **+$27** |

**Every macro-augmented rule UNDERPERFORMED the cheap-call-PM-only baseline on total realized P&L.** The 2-mode rule lost 95% of cheap-call-PM's total $ because the regime gate switched from calls to puts on 4/21 (the day calls were the lottery), and the cheap-put-PM rule couldn't catch the RUTW PUT lottery.

### Root causes of the negative result

1. **Lotteries are concentrated on a few days, not evenly distributed.** Macro features predict "today might be a lottery day" but DON'T tell us "this specific alert will lottery." The signal is at the day level, not the trade level.

2. **Puts have an inherently lower lottery rate** (3.4% vs calls 16.1%) because options decay; the put lotteries that exist (RUTW 4/21) have specific characteristics our discriminator (cheap entry + PM + RE-LOAD) doesn't capture.

3. **Per-strike GEX is mostly unavailable** for our alert universe. Only 30 of 783 RE-LOAD fires are on SPX/NDX/SPY/QQQ (the tickers we run per-strike GEX crons for); the rest are single stocks (TSLA, SNDK, etc.) where we'd need new cron infrastructure.

4. **The cheap-call-PM rule already implicitly absorbs some regime signal** (calls don't tend to lottery on heavily-bearish days), so adding "regime is bullish" as an extra gate just shrinks the qualifying set without improving precision.

### What we adopted

- Macro features are computed and stored on every fire (display-only).
- UI shows them as informational badges so the trader can see regime context.
- They are NOT used as a selection gate.

### When to re-test

Open a new spec to re-evaluate macro gating if ANY of these are true:
- Sample grows to ≥ 60 days AND p30 univariate lift on a single feature reaches ≥ 3.0× (suggests a stronger signal we're not seeing in 15 days)
- We add per-strike GEX crons for the top RE-LOAD-frequent single stocks (TSLA, SNDK, MU, AMD) — would close the 96% coverage gap
- We test a new feature class entirely (e.g., overnight gap, premarket move, IV-RV spread, dealer hedging proxy)
- A specific failure mode emerges in production (rule keeps firing on chop days that everyone can see are bad)

### Reproducibility

All scripts and intermediate artifacts are saved:
- `docs/tmp/options-flow-analysis/scripts/dump_macro_tables.ts` — pulls flow_data + spot/strike exposures
- `docs/tmp/options-flow-analysis/scripts/p30_macro_features.py` — feature attachment + discriminator
- `docs/tmp/options-flow-analysis/scripts/p31_put_regime_rule.py` — put + regime-switching test
- `docs/tmp/options-flow-analysis/outputs/p30_reload_with_macro.csv` — per-fire macro features
- `docs/tmp/options-flow-analysis/outputs/p31_combined_rule_features.csv` — 2-mode rule output

To re-validate as data grows, see "Step 5b" in the Pipeline section above.
