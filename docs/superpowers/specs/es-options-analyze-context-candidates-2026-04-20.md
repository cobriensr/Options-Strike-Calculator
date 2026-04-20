# ES Options Analyze-Context Candidates — Post-SIDE-015 Menu

## Purpose

On 2026-04-20, the ES options ingest pipeline was fixed (SIDE-015 — the
`definition` schema was being subscribed after `client.start()`, so the
session snapshot never replayed and `_option_definitions` stayed empty).
Before that fix, `futures_options_trades` and `futures_options_daily`
had **zero rows ever**. After the fix, Definitions cache correctly and
the tables will start filling from the first Monday RTH open.

This doc catalogs the candidate signals we could surface to Claude's
analyze prompt now that the data is live, along with an empirical
validation methodology. It is **not an implementation plan yet** — it's
a menu to revisit after 3–10 trading days of real data, when signal
quality can be evaluated against actual intraday outcomes.

The intended workflow:

1. Let the sidecar populate the tables for N trading days (suggested
   minimum N=3 RTH sessions, ideal N=10).
2. For each candidate below, run the validation query + compare to that
   session's realized outcome (direction, range, pin).
3. Keep the candidates that show signal, drop the ones that don't,
   then promote the winners into the analyze prompt.

---

## What's already wired (baseline)

### `futures_options_daily` → already in the analyze prompt

Flow:

- `api/_lib/futures-context.ts:145` queries the top 20 ES option strikes
  by `open_interest` (where OI IS NOT NULL), ordered DESC, for the
  analysis date.
- Called from `api/_lib/analyze-context-fetchers.ts:617` via
  `formatFuturesForClaude()`.
- Included in Claude's user message at `api/_lib/analyze-context.ts:371`
  with framing: *"Futures signals lead options flow by 10-30 minutes.
  When futures and flow disagree, futures are usually right."*
- System prompt has a `<futures_context_rules>` block at
  `api/_lib/analyze-prompts.ts:771-856`.

What Claude sees today (once data flows):

- Up to 20 strikes with OI + volume
- Derived max pain (from `api/cron/fetch-es-options-eod.ts` EOD)
- OI concentration ratios

### `futures_options_trades` → NOT used anywhere in analyze

The tick-trade table is written to but never read by analyze or any
cron. Only reference in `api/` is a commented-out line at
`api/cron/build-features.ts:345`:

```ts
// await engineerFuturesFeatures(sql, dateStr, features);
```

and a comment at line 341 planning
`es_put/call_buy_aggressor_pct: from futures_options_trades`.

Net: all the tick-level data SIDE-015 unlocks is currently an orphan
asset. Every candidate below that uses `futures_options_trades` would
be the *first* consumer.

---

## Candidate #1 — ES options IV skew + ATM term structure

**Data source:** `futures_options_daily.implied_vol` per
`(strike, option_type, expiry, trade_date)`.

**Hypothesis:** ES options IV is an *independent* derivatives-side
read on volatility pricing — exchange-computed, model-free from our
side. The gap between ES priced skew vs SPX priced skew (which we
already get via UW) is the diagnostic signal. When ES put skew is
steeper than SPX put skew, institutional hedging flow is happening in
ES first (classic pre-positioning before reflecting into SPX). This
is a well-documented lead-lag relationship in professional vol desks.

**Why it'd help Claude's 0DTE SPX analysis:**

Today Claude sees SPX skew from UW. Adding ES skew gives a second
independent volatility tape. Two specific add-ons:

1. **25Δ put / 25Δ call skew ratio** per expiry — standard "skew
   steepness" metric. Highly elevated = crash risk premium; flat =
   complacency.
2. **ATM IV term structure** — IV at the ATM strike across 0DTE /
   1DTE / 7DTE / 30DTE expiries. Inverted (0DTE > 30DTE) = stress now;
   contango (0DTE < 30DTE) = calm.

Both exist in SPX but ES-computed equivalents let Claude cross-check.

**Implementation sketch:**

New helper in `api/_lib/futures-context.ts`:

```sql
-- 25Δ put skew: avg IV at strikes where delta ∈ [-0.30, -0.20]
-- 25Δ call skew: avg IV at strikes where delta ∈ [+0.20, +0.30]
-- ATM: avg IV at strikes where |delta| < 0.05
SELECT
  expiry,
  AVG(implied_vol) FILTER (WHERE option_type='P' AND delta BETWEEN -0.30 AND -0.20) AS put_25d_iv,
  AVG(implied_vol) FILTER (WHERE option_type='C' AND delta BETWEEN 0.20 AND 0.30)   AS call_25d_iv,
  AVG(implied_vol) FILTER (WHERE ABS(delta) < 0.05)                                  AS atm_iv
FROM futures_options_daily
WHERE underlying = 'ES'
  AND trade_date = $1
  AND implied_vol IS NOT NULL
  AND delta IS NOT NULL
GROUP BY expiry
ORDER BY expiry
LIMIT 4;
```

Format as:

```
ES IV Skew (today):
  0DTE:  ATM=13.2%  25Δ-put=15.8%  25Δ-call=12.9%  skew-steepness=2.9pts
  1DTE:  ATM=13.5%  25Δ-put=15.4%  25Δ-call=13.1%  skew-steepness=2.3pts
  7DTE:  ATM=14.1%  25Δ-put=16.2%  25Δ-call=13.8%  skew-steepness=2.4pts
  Term structure: 0DTE < 7DTE (CONTANGO — normal vol regime)
```

Add interpretive rules to the system prompt (new `<es_iv_skew_rules>`
section in `analyze-prompts.ts`).

**Files to touch (if promoted):**

- `api/_lib/futures-context.ts` — add `fetchEsIvSkew()` + new section
  builder
- `api/_lib/analyze-prompts.ts` — add `<es_iv_skew_rules>` block
- `api/__tests__/futures-context.test.ts` — new test cases
- `api/_lib/analyze-context.ts` — wire the new section into the assembled context

**Effort estimate:** ~4 hours (small).

**Validation after N days:**

- Collect N daily rows of `(0DTE-ATM-IV, 0DTE-skew-steepness)` and the
  realized next-day absolute SPX return.
- Test: does IV > ATM-IV-median predict a larger realized range? Does
  skew-steepness > median predict more-negative-skewed returns?
- Target: Spearman ρ > 0.2 at p < 0.05 for at least one of the signals
  across N=10+ days. Below that, the data is noise and doesn't belong
  in the prompt.

**Risks / failure modes:**

- ES IV may just track SPX IV 1:1, offering no independent signal.
  Quick test: `corr(ES_ATM_IV, SPX_ATM_IV)` — if > 0.98, ES adds no
  information. If 0.85-0.95, there's room for ES to lead/lag.
- Exchange-computed Greeks assume an interest-rate model we don't
  control. Check a few days vs our Black-Scholes to calibrate.

---

## Candidate #2 — Buy-aggressor flow at ATM strikes

**Data source:** `futures_options_trades.side` ('A'/'B'/'N') per
`(strike, option_type, expiry, ts)`.

**Hypothesis:** Large institutional desks often execute in ES options
*before* reflecting the same position into SPX — ES options are
cheaper to hedge, have tighter BBOs at size, and let the desk build
delta exposure across the futures leg. So "ES ATM call buy-aggressor
% in the last 15 min" is a leading indicator of SPX direction that
the current prompt (which only sees SPX-option flow via UW) is blind
to.

**Why it'd help:**

UW flow data Claude already consumes is SPX options only. ES option
flow is a *different tape* — different counterparties, different
pricing dynamics, different frontrunning patterns. Even if ES and SPX
are highly correlated, the flow sides may lead/lag each other
consistently.

**Implementation sketch:**

Pre-compute aggregates in a cron (not at analyze-time — the tick table
will be large):

```sql
-- New cron: api/cron/compute-es-option-flow.ts (runs every 5 min in RTH)
-- Writes to new table: es_option_flow_5m (strike, option_type, window_start,
--                                          buy_agg_count, sell_agg_count,
--                                          total_count, buy_agg_pct)
INSERT INTO es_option_flow_5m
SELECT
  strike,
  option_type,
  date_trunc('minute', ts) - (EXTRACT(minute FROM ts)::int % 5) * interval '1 minute' AS window_start,
  COUNT(*) FILTER (WHERE side = 'B') AS buy_agg_count,
  COUNT(*) FILTER (WHERE side = 'A') AS sell_agg_count,
  COUNT(*)                            AS total_count,
  CASE WHEN COUNT(*) > 0
    THEN COUNT(*) FILTER (WHERE side='B')::numeric / COUNT(*)
  END AS buy_agg_pct
FROM futures_options_trades
WHERE underlying = 'ES'
  AND ts > now() - interval '10 minutes'
GROUP BY strike, option_type, window_start
ON CONFLICT ... -- idempotent upsert
```

At analyze-time, read the last 15 min of the flow table, filter to
ATM ±10 strikes, compute call-side and put-side aggregate buy-agg %.

Format as:

```
ES Options Flow (last 15 min, ATM ±10 strikes):
  ATM Call buy-aggressor: 62% (n=140)   → skewed bullish
  ATM Put buy-aggressor:  48% (n=85)    → neutral
  Directional bias: MODESTLY BULLISH
```

**Files to touch (if promoted):**

- `api/_lib/db-migrations.ts` — new migration for `es_option_flow_5m`
  table
- `api/__tests__/db.test.ts` — migration test update
- `api/cron/compute-es-option-flow.ts` — new cron (every 5 min during
  RTH)
- `api/__tests__/compute-es-option-flow.test.ts` — new test
- `vercel.json` — cron schedule entry
- `api/_lib/futures-context.ts` — read helper
- `api/_lib/analyze-prompts.ts` — new `<es_options_flow_rules>` block
- Wire into `analyze-context.ts`

**Effort estimate:** ~1.5 days (medium — new table, new cron, prompt
work).

**Validation after N days:**

Per-session, compute:

- For each 15-min window where buy-agg pct diverged >15 pts from
  neutral (50%), was the next 15-min SPX return in the same direction
  more often than baseline?
- Target: directional accuracy > 55% on diverged windows, with n > 30
  windows across N days for statistical relevance.
- Below 52% = noise, drop it.

**Risks / failure modes:**

- 15-min window may be wrong — too short and it's microstructure
  noise, too long and the signal decays. Worth running the same
  validation at 5m / 10m / 30m and picking the best.
- "Side" attribution from Databento is heuristic (based on which quote
  the trade crossed). In fast markets this gets miscoded more often.
  Can validate by checking if buy-agg % skews wildly on high-volatility
  days — if it does, the heuristic is breaking.
- Block trades distort buy-agg % heavily. Should exclude size > some
  threshold (e.g., 50 contracts) from the aggregate, or at least flag
  them separately.

---

## Candidate #3 — Gamma-agreement score (ES ↔ SPX)

**Data source:** `futures_options_daily.delta` × `open_interest` per
strike (ES side). Compare to SPX GEX walls from the existing UW pipeline.

**Hypothesis:** You already feed Claude SPX GEX walls (gamma max-pain
strikes where dealer hedging concentrates). If the equivalent ES
gamma-concentration strikes *agree* with SPX GEX walls, the wall is
structurally real (both dealer books concentrate positioning there). If
they *disagree*, one of them may be positioning-driven rather than
structural — specifically, if SPX GEX wall is at 5850 but ES gamma
concentration is at 5870, the SPX wall might break on a move toward
5870.

**Why it'd help:**

Adds a cross-check against GEX walls. The analyze prompt today treats
GEX walls as strong structural signals. A gamma-agreement score would
let Claude *discount* walls when ES disagrees, and *strengthen* calls
when both agree.

**Implementation sketch:**

Compute per-strike "gamma proxy" (|delta| × (1 - |delta|) × OI — this
is a rough gamma estimator since we don't have exchange gamma). Find
top-3 gamma-proxy strikes for ES, compare to SPX GEX walls.

```sql
SELECT
  strike,
  SUM(ABS(delta) * (1 - ABS(delta)) * open_interest) AS gamma_proxy
FROM futures_options_daily
WHERE underlying = 'ES'
  AND trade_date = $1
  AND delta IS NOT NULL
  AND open_interest IS NOT NULL
GROUP BY strike
ORDER BY gamma_proxy DESC
LIMIT 3;
```

Then: are the top-3 ES gamma strikes within ±0.3% of SPX GEX walls?
Compute an "agreement score" (0 = no walls match, 1 = all walls match
within tolerance).

Format:

```
ES/SPX Gamma Agreement:
  SPX GEX walls: [5820, 5850, 5875]
  ES gamma-concentration strikes: [7070, 7100, 7140]  (SPX-equiv: [5820, 5844, 5877])
  Agreement: 2/3 walls aligned (5820 exact, 5875 within 0.1%)
  Interpretation: gamma walls at 5820/5875 are STRUCTURALLY REAL (both desks).
                  Wall at 5850 is SPX-only (may break on test).
```

**Files to touch:** similar shape to Candidate #1 (no new cron, just
new context fetcher + prompt rules).

**Effort estimate:** ~1 day (medium — the SPX↔ES strike conversion
math needs care).

**Validation after N days:**

- For each session, record the 3 SPX GEX walls and the top-3 ES
  gamma-concentration strikes.
- Track which walls "held" intraday (SPX respected the strike as S/R)
  vs "broke."
- Test: do agreeing-walls hold more often than disagreeing-walls?
- Target: > 15 pt difference in "hold rate" between agree and
  disagree across N=10+ sessions.

**Risks / failure modes:**

- SPX-equiv conversion ratio (ES × ~0.85) may drift with futures
  basis. Needs live basis ratio, not a hardcoded constant.
- "Gamma proxy" (|Δ|(1-|Δ|)OI) is a rough approximation; real gamma
  from the exchange would be better but isn't in the `delta` column.
  Could request "gamma" field from Databento if their Statistics schema
  carries it.

---

## Candidate #4 — Block-print alerts

**Data source:** `futures_options_trades` rows with `size > threshold`
and `trade_date = current_date`.

**Hypothesis:** Large block prints in ES options often precede SPX
desk activity. "3 block prints ≥100 contracts on ES 7100 puts in
last 30 min" is actionable info Claude doesn't see today.

**Why it'd help:**

It's the classic "pay attention to smart money" signal. ES option
blocks are nearly always institutional — retail doesn't print 100+
contracts at a time. Current prompt sees UW "whale" flag for SPX
blocks, but ES option blocks are their own tape.

**Implementation sketch:**

```sql
-- At analyze time, pull recent block prints
SELECT
  ts, strike, option_type, size, price, side,
  expiry
FROM futures_options_trades
WHERE underlying = 'ES'
  AND trade_date = $1
  AND size >= $threshold   -- suggest 50 to start
  AND ts > now() - interval '2 hours'
ORDER BY size DESC
LIMIT 10;
```

Format as:

```
ES Option Blocks (last 2h, ≥50 contracts):
  12:34:22  100 ES 7100 P @ 8.25  BUY  (exp 2026-04-25)
   12:18:05   85 ES 7150 C @ 12.50 SELL (exp 2026-06-19)
   11:57:40  200 ES 7075 P @ 6.75  BUY  (exp 2026-04-25)
  Net directional: 3 block prints, 2 put-buyer / 1 call-seller → bearish
```

**Files to touch:** same shape as #1 — fetch helper + prompt rules.

**Effort estimate:** ~2-3 hours (low — simple query, simple prompt).

**Validation after N days:**

- Log every session's blocks with direction attribution.
- Compare to SPX return in the next 30 min after each block print.
- Target: directional hit rate > 55% on "net bearish" or "net bullish"
  block-flag sessions.

**Risks / failure modes:**

- Threshold is the hard part. 50 contracts is fine for weekly options
  at ATM but miss larger signals on LEAPs; 100 contracts may be too
  rare for weeklies. Probably need per-expiry thresholds.
- Spread-leg block prints would show up as two big simultaneous trades
  at adjacent strikes — could be mislabeled as directional. May need
  "cluster detection" to identify spreads and not count them as single
  blocks.
- Block prints cluster intraday (opens, FOMC, OpEx). Need to normalize
  for expected volume.

---

## Candidate #5 — Session-over-session OI change

**Data source:** `futures_options_daily` snapshots, current_date vs
previous trading day, same strike × option_type × expiry.

**Hypothesis:** Total OI is a stale signal — some of it has been there
for weeks. Δ-OI from yesterday's settle to today's settle shows *new
positioning*. The strikes that grew OI the most today are where new
money is placing bets; the strikes that lost the most are where old
positions are unwinding.

**Why it'd help:**

Cleanest signal of today's institutional positioning. Current prompt
sees OI levels but not changes. "ES 7100P added 2,500 OI today" is
materially different information from "ES 7100P has 10,000 OI."

**Implementation sketch:**

```sql
SELECT
  today.strike, today.option_type, today.expiry,
  today.open_interest - yday.open_interest AS oi_change,
  today.open_interest AS oi_now,
  yday.open_interest   AS oi_yday
FROM (
  SELECT * FROM futures_options_daily
  WHERE underlying='ES' AND trade_date = $1
) today
LEFT JOIN (
  SELECT * FROM futures_options_daily
  WHERE underlying='ES' AND trade_date = $2   -- previous trading day
) yday USING (strike, option_type, expiry)
WHERE today.open_interest IS NOT NULL AND yday.open_interest IS NOT NULL
ORDER BY ABS(today.open_interest - yday.open_interest) DESC
LIMIT 10;
```

Format:

```
ES Options OI Change (vs yesterday):
  +2500  ES 7100 P  (exp 2026-04-25)   [new defensive put positioning]
  +1800  ES 7200 C  (exp 2026-06-19)   [new call buying on longer-dated]
  -1200  ES 7075 P  (exp 2026-04-22)   [covering yesterday's puts]
```

**Files to touch:** minimal — one query in `futures-context.ts`, one
prompt rule, one test.

**Effort estimate:** ~2 hours (lowest).

**Validation after N days:**

- For each session's top-3 OI-add strikes, check if SPX gravitated
  toward (as magnet) or away from (as rejection) those strikes in
  the next session.
- Target: ≥ 55% of top-OI-add strikes acted as intraday magnets within
  ±10 pts of spot the next day.

**Risks / failure modes:**

- Contract rolls distort OI massively around monthly/quarterly
  expirations. Need to filter or flag expiry days.
- First 30 days of OI data needs to warm up — this is the only
  candidate where pre-existing historical data doesn't help.

---

## Recommended sequence

Assume we prioritize by "signal ceiling / effort" and "dependency
order":

### Phase 1 — Ship these together (low risk, complementary, small)

- **Candidate #1 (IV skew + term structure)** — 4h — already-derived
  data, no new cron, well-understood signal.
- **Candidate #5 (Session-over-session OI change)** — 2h — adds to
  the same `futures-context.ts` query block.
- **Candidate #4 (Block-print alerts)** — 2-3h — no infrastructure
  needed, just needs threshold tuning.

**Total effort: ~1 day.**
**Why together:** all three are non-invasive reads, zero new tables or
crons, all fit the existing `formatFuturesForClaude` pattern. Risk of
shipping is low.

### Phase 2 — After Phase 1 proves value

- **Candidate #2 (Buy-aggressor flow)** — 1.5d — requires new
  aggregation table + cron. Biggest-ceiling signal but needs real
  volume data to tune windows and thresholds.

**Condition to proceed:** Phase 1 shows ≥ 1 signal meeting its
validation target (ρ > 0.2 or hit-rate > 55%).

### Phase 3 — Highest-complexity, save for last

- **Candidate #3 (Gamma agreement)** — 1d — requires reconciling
  SPX↔ES strike space, needs Phase 1 IV data for validation context.

**Condition to proceed:** Phases 1 and 2 both showed signal, and UW
GEX walls are still being consumed downstream at analyze-time (they
are today).

---

## Validation methodology (how to "walk through" this doc with data)

After N trading days (minimum 3, ideal 10), sit down with:

- `futures_options_daily` — one row per (date, strike, option_type,
  expiry)
- `futures_options_trades` — tick-level (will be large — 10M+ rows
  after a week of RTH)
- SPX OHLC for the same N days (already in `day_embeddings` table
  after the recent analog-range-forecast work)
- Review analyses from those days (already in `analyses` table)

### Per-candidate validation pattern

For each candidate, run this four-step comparison:

1. **Compute the signal retrospectively** for each of the N days.
2. **Compute the outcome** for each of those days (e.g., next-15-min
   SPX return, realized daily range, session pin to max-pain).
3. **Correlate** (Spearman ρ, hit rate, or conditional-mean
   difference, whichever fits the signal).
4. **Target threshold** (candidate-specific — see above).

### Aggregate ranking

- Signals meeting target → promote to analyze prompt with
  interpretive rules.
- Signals near target (e.g., ρ = 0.1-0.2) → collect more data
  (N ≥ 30 days) before deciding.
- Signals below target → drop, note in this doc why.

### Keep-or-kill decision framework

For each candidate that passes validation, ask:

1. **Does it add information Claude can't derive from existing
   context?** (If ES IV correlates 1:1 with SPX IV, it adds nothing
   even if individually predictive.)
2. **Does it survive in different regimes?** (Split N days by VIX
   regime — low/mid/high. A signal that only works in low-VIX may not
   generalize.)
3. **Is the prompt-rule writable?** If Claude can't be given clear
   interpretive guidance in 3-5 lines, the signal is probably too
   noisy or regime-dependent to be useful.

Kill candidates that fail any of these three even if the raw
correlation is there.

### Expected time to complete all validations

- Phase 1 candidates (3): ~4 hours total once data exists
- Phase 2 candidate: ~3 hours (plus the prior cron build if promoted)
- Phase 3 candidate: ~2 hours

Allocate half a day to sit with data for a first pass, then schedule
follow-up sessions as signals accumulate.

---

## Session-context rules (for when we revisit this doc)

When you come back to this doc with data, before starting validation:

1. **Confirm both tables have non-zero rows for the validation window.**
   If either is empty, the pipeline regressed again — check SIDE-015
   fix still in place, check Railway didn't roll back the sidecar.
2. **Note the VIX regime over the validation days.** A calm-market N=3
   is not the same as a stressed-market N=3 — flag regime in the
   analysis.
3. **Avoid post-hoc feature engineering.** If a signal doesn't meet
   target at its first formulation, don't add features until it does.
   That's p-hacking. Drop it or collect more data, don't engineer.

## Hidden value: this doc IS the validation

Every candidate above has a stated hypothesis, a stated target, and a
stated kill-condition. When you come back to data, the main output
should be: for each candidate, *"target met / target missed / inconclusive,
need more data."* Don't introduce new candidates during the first
review session — if a new idea surfaces, add it to this doc as
Candidate #6+ for the NEXT validation pass.

The goal of the doc is to keep the bar consistent across candidates so
signal promotion is disciplined rather than vibes-driven.
