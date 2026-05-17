---
status: Likely Shipped
date: 2026-05-16
---

# EDA Findings Implementation — 4 Cross-Section Signals — 2026-05-16

## Goal

Implement the 4 actionable findings from
`docs/tmp/lottery-silentboom-eda-findings-2026-05-15.md`. The EDA mined
626K LF rows + 15K SB rows across all-time data; these 4 features are
the only ones with both statistical power AND non-redundancy with the
current scoring/filtering surfaces.

## Findings Recap (ranked by ship priority — easiest/highest evidence first)

| #   | Finding                                                          | Lift                          | Implementation cost                     |
| --- | ---------------------------------------------------------------- | ----------------------------- | --------------------------------------- |
| 2   | LF: `trigger.vol_to_oi_window ≥ 0.5` → +1 score                  | 1.10–1.35×                    | LOW — 1 file                            |
| 3   | SB: Spread-Confirmed badge when `multi_leg_share ∈ [0.10, 0.50]` | 2.08× (display-only at N=217) | LOW — 4 files                           |
| 4   | LF: Macro Window badge 24–72h before CPI/FOMC/JOBS/PCE           | 1.32×/1.56×                   | MEDIUM — 5 files + economic_events join |
| 1   | LF: Range Kill — suppress fires when `range_pos < 0.10`          | 0.07× lift (kill)             | HIGH — migration + cron + backfill + UI |

## Phases (each ≤5 files; reviewer subagent between every phase)

### Phase A — LF vol_to_oi_window score (+1 floor)

**Change:** `api/_lib/lottery-score-weights.ts` `computeLotteryScore()`
gains a single +1 component when `triggerVolToOiWindow ≥ 0.5`. Tier
thresholds (18 / 12) unchanged.

**Why +1 not +2:** The 2-5 bucket regresses to 0.99× — adding +2 would
over-credit the tail. +1 captures the broad lift (1.10× across N=107K
rows in ≥0.5) without claiming the tail edge that's only in ≥5 (small
N).

**Backfill:** Historical lottery_fires.score is stable — no backfill
needed. New fires from the next cron run score with the new weight.
Existing tests for `computeLotteryScore` get a new case.

**Files:**

- `api/_lib/lottery-score-weights.ts` — add the +1 weight
- `api/_lib/__tests__/lottery-score-weights.test.ts` (if exists) or
  inline test — add a vol_to_oi_window case

### Phase B — SB Spread-Confirmed badge

**Change:** Expose `multi_leg_share` in `/api/silent-boom-feed`
response + `SilentBoomAlert` type. Add a small badge in `SilentBoomRow`
that renders `🟢 SPREAD-CONFIRMED` when `multiLegShare ∈ [0.10, 0.50]`.
Display-only — no score impact (sweet-spot N=217 is too small to score
yet per the EDA caveat).

**Files:**

- `api/silent-boom-feed.ts` — add multi_leg_share to AlertRow + response
- `src/components/SilentBoom/types.ts` — add `multiLegShare: number | null`
- `src/components/SilentBoom/SilentBoomRow.tsx` — render badge
- `src/__tests__/SilentBoomRow.test.tsx` — fixture + badge assertion
- `api/__tests__/silent-boom-feed.test.ts` — pass-through smoke test

### Phase C — LF Macro Window badge

**Change:** Add an `economic_events` LATERAL join in `/api/lottery-finder`
that computes `hoursToNextHighImpactEvent` per fire. Add to `LotteryFire`
type. Render `📅 MACRO 24-72h` badge in `LotteryFinderSection` (NOT in
LotteryRow — that file is parallel-session WIP).

**Definition of "high impact":** `economic_events.impact = 'high'` (or
the equivalent enum — check schema) AND ticker in (CPI, FOMC, JOBS,
PCE). Confirm field names by reading the migration before writing the
query.

**Files:**

- `api/lottery-finder.ts` — LATERAL join + map to response
- `src/components/LotteryFinder/types.ts` — add `hoursToNextMacroEvent: number | null`
- `src/components/LotteryFinder/LotteryFinderTickerGroup.tsx` — render badge inline (a small chip per fire row)
- `src/__tests__/LotteryFinderSection.test.tsx` — fixture
- `api/__tests__/lottery-finder.test.ts` (if exists) — pass-through test

### Phase D — Range Kill schema + cron

**Change:** New migration adds `range_pos_at_trigger NUMERIC` to
`lottery_fires`. The `detect-lottery-fires` cron computes range_pos at
fire time by calling UW stock-ohlc endpoint (`/api/stock/{ticker}/ohlc/1m`)
for the trigger date, deriving `(spot - low) / (high - low)` from
candles ≤ `trigger_time_ct`.

**On UW failure:** column stays NULL — feature degrades gracefully.

**Files:**

- `api/_lib/db-migrations.ts` — migration (next available id)
- `api/__tests__/db.test.ts` — update mock sequence
- `api/cron/detect-lottery-fires.ts` — fetch UW candles + compute
- `api/_lib/uw-stock-candles.ts` (new) — UW client helper
- `api/__tests__/uw-stock-candles.test.ts` — happy + failure tests

### Phase E — Range Kill UI + score

**Change:** Expose `rangePosAtTrigger` in `/api/lottery-finder`
response + type. Add a tri-state filter chip in `LotteryFinderSection`
(`all / hide bottom-10% / hide top-10%`). Add −3 score component in
`computeLotteryScore()` when `range_pos < 0.10` (the kill bucket).
Display `📍 TOP-RANGE` badge for top-10% fires.

**Why −3 for bottom-10%:** the kill cohort win rate is 2.4% (0.07×
lift). −3 pulls every bottom-10% fire below tier3 boundary, which
effectively suppresses them from any Tier 2+ conviction filter.

**Files:**

- `api/lottery-finder.ts` — add to response
- `src/components/LotteryFinder/types.ts` — add `rangePosAtTrigger: number | null`
- `src/components/LotteryFinder/LotteryFinderSection.tsx` — filter chip
- `api/_lib/lottery-score-weights.ts` — −3 weight for range_pos < 0.10
- Tests in both touched test files

### Phase F — Range Kill backfill script

One-off script in `scripts/backfill-range-pos.mjs` that iterates over
`lottery_fires` rows where `range_pos_at_trigger IS NULL`, calls UW per
(ticker, date), computes, and writes. Idempotent. Rate-limit aware.

**Files:**

- `scripts/backfill-range-pos.mjs` — the script
- `package.json` — add `npm run backfill:range-pos` task (optional)

## Open Questions

- **Is `economic_events.impact` the right field name?** Check before
  writing the LATERAL. Migration ~#33 in db-migrations.ts.
- **What's UW's stock-ohlc rate limit?** Backfill script may need
  conservative pacing; for new fires the cron only fires ~50× per session
  so rate is fine.
- **Score recomputation for historical LF rows?** Phase A adds +1 to
  new fires only; historical scores stay frozen. Same for Phase E. If
  the user wants historical tier reshuffling, add a `recompute-lottery-
scores.mjs` script in a follow-up. Out of scope for the 4-finding
  ship.

## Constants (post 2026-05-16 EDA-rerun retune)

| Constant                              | Value | Where                        |
| ------------------------------------- | ----- | ---------------------------- |
| `LF_VOL_TO_OI_WINDOW_BONUS_THRESHOLD` | 0.5   | lottery-score-bonuses.ts     |
| `LF_VOL_TO_OI_WINDOW_BONUS_POINTS`    | 1     | lottery-score-bonuses.ts     |
| `SB_SPREAD_CONFIRMED_LO`              | 0.10  | SilentBoomRow.tsx (local)    |
| `SB_SPREAD_CONFIRMED_HI`              | 0.50  | SilentBoomRow.tsx (local)    |
| `LF_MACRO_WINDOW_LO_HOURS`            | 72    | LotteryFinderTickerGroup.tsx |
| `LF_MACRO_WINDOW_HI_HOURS`            | 168   | LotteryFinderTickerGroup.tsx |
| `LF_NEW_HIGH_THRESHOLD`               | 1.0   | LotteryFinderTickerGroup.tsx |

`LF_RANGE_KILL_THRESHOLD`, `LF_RANGE_KILL_PENALTY`, and
`LF_RANGE_TOP_THRESHOLD` were removed on 2026-05-16 as part of the
post-rerun retire. See "EDA Rerun & retire" below.

## EDA Rerun & retire (2026-05-16)

After Phase F (backfill) populated 604K rows of `range_pos_at_trigger`,
a re-validation in `ml/findings/eda-rerun-2026-05-16/` revealed:

- The original Range Kill / TOP-RANGE finding was driven by a
  **dimensional bug** in `ml/src/cross_section_eda.py:328-359`: it
  computed `range_pos = (stock_spot − SPX_session_low) / (SPX_session_high − SPX_session_low)`,
  which for any non-index ticker (AAPL, TSLA, NVDA, …) produces large
  negative values that `pd.cut(bins=[0, 0.1, …, 1.0001])` silently
  drops to NaN. Only ~126 dimensional-accident rows survived in the
  original bottom-10% cohort; the 2.4% win50 / 0.07× lift was 3 winners
  out of 126 — sampling noise on a degenerate filter.
- On the corrected 604K column, **bottom-10%** has win50 = 34.4% / lift
  0.97×; **top-10%** has win50 = 36.1% / lift 1.01×. No edge at either
  tail of the equity-ticker session range. Even inside tier1+2
  (N=106K), the spread is 0.96×–1.06×.
- The **saturated-1.0 sub-bucket** (N=143 — fires whose spot punched
  above session high mid-bar, clamped at the upper bound) shows win50
  = 55.9% / win100 = 46.9% — a real ~2.4× win100 lift. Small N but
  clean directional rationale (breakout-momentum tell).
- The **Macro Window** finding flipped buckets: the original EDA
  claimed 1.32×/1.56× lift on the 24–72h bucket; the rerun on full
  data shows 24–72h is 0.92×/0.87× (slightly anti-edge) and **72-168h**
  is the actual edge bucket at **1.19×/1.28× lift on N=57,533**.
- F2 (vol/OI ≥ 0.5) and F3 (SB Spread-Confirmed 10-50%) reproduced
  exactly — those used DB columns directly with no derivation step.

### Code actions taken 2026-05-16

| Decision                        | Before                           | After                                                          |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| Range Kill -3 score penalty     | applied when `range_pos < 0.10`  | retired; `lottery-score-bonuses.ts` no longer reads range_pos  |
| "hide range-bottom" filter chip | rendered in LotteryFinderSection | removed                                                        |
| "TOP-RANGE" badge               | rendered when `range_pos ≥ 0.90` | retargeted to "🔺 NEW HIGH" when `range_pos ≥ 1.0` (saturated) |
| Macro Window threshold          | 24-72h                           | 72-168h                                                        |

The `range_pos_at_trigger` column + cron-time UW candle fetch stay in
place — the data has measurable value at the saturated-1.0 sub-bucket
and is cheap to keep collecting (~50 UW calls/day, well under the
120/min ceiling). Re-validate the NEW HIGH badge's scoring effect at
N≥300 before adding any score weight.

## Out of scope

- SB Spread-Confirmed scoring (waiting for sweet-spot N to grow past 500
  per the EDA caveat).
- SB Range Kill (the EDA showed SB inverts vs LF at extremes, and SB N
  was underpowered).
- Score backfill for historical LF rows.
- Cross-asset confirmation, gamma-flip distance, day-stacking, chain
  sequence — all tested and rejected by the EDA.

## Files NOT to touch (parallel-session WIP per git status)

- `src/components/LotteryFinder/LotteryRow.tsx`
- `src/components/LotteryFinder/ContractTapeChart.tsx`
- `src/components/LotteryFinder/TickerNetFlowChart.tsx`
- `src/__tests__/ContractTapeChart.test.tsx`
- `src/__tests__/TickerNetFlowChart.test.tsx`
- `src/__tests__/utils/ticker-rollup-aggregates.test.ts`
- `uw-stream/src/handlers/gex_strike_expiry.py` and its test
- `vercel.json`
- `ml/pyproject.toml`
- The other `??` spec docs (alert-takeit-score, futures-setups-backtest,
  round-trip-suppression)
