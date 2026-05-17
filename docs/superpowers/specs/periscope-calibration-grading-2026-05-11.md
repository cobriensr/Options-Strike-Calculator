---
status: Likely Shipped
date: 2026-05-11
---

# Periscope Calibration & Grading — EOD Playbook Scorer

**Date:** 2026-05-11
**Status:** draft
**Supersedes:** `periscope-daily-debrief-2026-05-11.md` (static debrief
visualization folds into this; the grading dashboard renders the
same lanes plus structured grades on top).

## Goal

A deterministic end-of-day grading system that for every
auto-generated Periscope playbook in a trading day, computes a
structured pass/fail score across N dimensions (regime call, bias,
trigger fires, IC blown, charm drift, simulated trade P&L on
SPX/ES/NQ), persists those grades to a new table, and exposes them
through a CLI command + Calibration tab. Aggregated over weeks, the
data answers "when is the system right, on what dimensions, at what
times of day, and would I be profitable trading futures off it?"

**Zero LLM spend** — every dimension is formula-computable from data
already in Neon (periscope_analyses, spx_candles_1m, futures_bars,
ws_option_trades). Deterministic = reproducible = re-graded if the
rubric evolves.

## Why now

- Auto-playbook is live forward-firing every 10 min RTH.
- The user has defined the grading rubric concretely: regime correct,
  triggers correct, IC blown vs safe, charm drift call, trade
  profitability on SPX/ES/NQ if entered at triggers, time-of-day
  accuracy.
- All inputs (price + flow + playbook output) already in Neon — no new
  ingestion.
- Without grades, the playbook is a black box: ~40 reads/day pile up
  with no feedback loop. Grades close the loop.

## What gets graded — per slot

For each `periscope_analyses` row with `auto_generated=true` and
`status='complete'`, compute the following grades using the playbook's
`panel_payload` against actual price+flow over two windows:

- **Short window**: `[slot_captured_at, slot_captured_at + 60 min]` —
  used for trigger-fire detection, charm-drift verification, immediate
  follow-through grading.
- **EOD window**: `[slot_captured_at, 15:00 CT same day]` — used for
  IC blown determination and "did the call play out by close" grading.

Grading dimensions (each binary unless noted):

1. **Regime correct** — playbook's `regime` (e.g. "drift-and-cap",
   "pin", "cone-breach-up") vs observed regime classified from price
   path over EOD window. Classifier rules:
   - `pin` = EOD close within ±5pt of magnet/charmZero AND no cone
     breach
   - `cone-breach-up` = high during window > cone.upper
   - `cone-breach-down` = low during window < cone.lower
   - `drift-and-cap` = sign(EOD return) matches bias call AND cone
     held
   - else `mixed`
2. **Bias correct** — playbook's `bias` (`long` | `short` |
   `two-sided`) vs sign of EOD return. `two-sided` counts as correct
   if absolute return < 0.2% (chop) — the call is "no direction".
3. **Cone held** — did spot stay strictly inside
   `[cone.lower, cone.upper]` for the full window?
4. **Gamma floor held** — did spot stay strictly above `gammaFloor`
   for the full window? (Floor is a downside structural level.)
5. **Gamma ceiling held** — did spot stay strictly below `gammaCeiling`
   for the full window?
6. **Charm drift correct** — playbook's `narrative` / `futuresPlan`
   typically encodes a charm-driven drift direction. We grade by:
   computed drift = sign(`charmZero` − `spot`) (mechanical hedging
   pushes price toward charm zero); observed = sign(price[+60min] −
   price[0]). Correct = signs match (or both flat under noise
   threshold).
7. **Long trigger fired** — `panel_payload.longTrigger` (number) — did
   spot touch ≥ trigger AND a subsequent 5-min bar close ≥ trigger
   within the 60-min window? Records `fired_at` timestamp when true.
8. **Short trigger fired** — same logic, mirrored on
   `panel_payload.shortTrigger`.
9. **Simulated trade per (asset, side)** — for each side that fired,
   for each asset in {SPX, ES, NQ}, simulate a trade with:
   - Entry: bar close at fire time
   - Stop: opposite trigger level (long fired → stop = shortTrigger;
     short fired → stop = longTrigger). When opposite trigger is
     null, use gamma floor (longs) or gamma ceiling (shorts) as stop.
   - Target: gamma ceiling (longs) or gamma floor (shorts)
   - Exit: first of stop hit, target hit, or 15:00 CT close
   - Records: `entry_price`, `exit_price`, `exit_reason`
     (`stop` | `target` | `eod`), `pnl_pct` (signed % return),
     `duration_min`
10. **IC blown at EOD** — for the playbook's
    `[gammaFloor, gammaCeiling]` range: did the EOD close (15:00 CT
    SPX) land OUTSIDE that range? `blown=true` means a long
    iron-condor centered at floor/ceiling would have gone ITM at
    settle.
11. **Recommended structures correct** — for each entry in
    `recommended` (e.g. `debit_put_spread`, `iron_condor`,
    `directional_long_put`), apply a structure-specific outcome rule
    (see Appendix A) and emit a per-structure bool.
12. **Avoid structures correct** — same rule applied to `avoid`
    entries; correct = the avoided structure would have lost money.

Each grade row also records the slot's `mode` (pre_trade/intraday/
debrief) and `confidence` (low/medium/high) for cohort analysis.

## Architecture

```text
                            ┌───────────────────────────────────────────┐
                            │ scripts/grade-periscope-day.mjs           │
                            │   node grade-periscope-day.mjs --date=…   │
EOD command                 │                                            │
(manual, ~15:30 CT)         │ For each completed auto-playbook in day:  │
                            │   1. fetch playbook                        │
                            │   2. fetch SPX 1m + ES 1m + NQ 1m         │
                            │      for [slot, EOD]                       │
                            │   3. gradePlaybook() (pure fn)            │
                            │   4. UPSERT into periscope_grades         │
                            │ Print: N graded, regime%, bias%, …        │
                            └───────────────┬───────────────────────────┘
                                            │
                                            ▼
                            ┌───────────────────────────────────────────┐
                            │ periscope_grades  (NEW, migration #N)     │
                            │   id, periscope_analysis_id, trading_date,│
                            │   slot_captured_at, mode, confidence,     │
                            │   regime_call, regime_observed,            │
                            │   regime_correct, bias_*, cone_held,      │
                            │   gamma_floor/ceiling_held,                │
                            │   charm_drift_*, long/short_trigger_*,    │
                            │   trade_sims JSONB (per asset × side),    │
                            │   ic_blown_at_eod, structures_correct,    │
                            │   graded_at, grader_version               │
                            └───────────────┬───────────────────────────┘
                                            │
                                            ▼
                            ┌───────────────────────────────────────────┐
                            │ GET /api/periscope-grades?date=YYYY-MM-DD │
                            │ GET /api/periscope-grades/aggregate       │
                            │     ?since=YYYY-MM-DD&groupBy=mode|hour   │
                            │ guardOwnerOrGuestEndpoint                  │
                            └───────────────┬───────────────────────────┘
                                            │
                                            ▼
                            ┌───────────────────────────────────────────┐
                            │ PeriscopeCalibrationTab.tsx (new tab)     │
                            │   - Aggregate stats (last 7/30 days)       │
                            │     regime%, bias%, IC safe%, sim PnL …   │
                            │   - Per-day timeline: slot rows with grade│
                            │     chips (✓/✗ per dimension)             │
                            │   - Click slot → expanded view w/ playbook│
                            │     lane + price chart + trade sim panel  │
                            └───────────────────────────────────────────┘
```

## Phases

### Phase 1 — DB migration + Zod types

**Files:**

- `api/_lib/db-migrations.ts` — migration #N adding `periscope_grades`
  table with FK to `periscope_analyses.id` ON DELETE CASCADE. Unique
  index on `(periscope_analysis_id, grader_version)` so re-grading
  with a new rubric version doesn't collide.
- `api/_lib/periscope-grades-types.ts` — `Grade`, `TradeSim`,
  `StructureGrade` Zod schemas + TS types. Versioning: bump
  `GRADER_VERSION` constant when rubric changes; old grades preserved
  for compare.
- `api/__tests__/db.test.ts` — add migration to mock sequence
  (per CLAUDE.md `db.test.ts` update protocol).

### Phase 2 — Deterministic grading function

**Files:**

- `api/_lib/periscope-grader.ts` — pure function
  `gradePlaybook(args) → Grade`:
  ```ts
  function gradePlaybook(args: {
    playbook: PlaybookPanelPayload;
    slotCapturedAt: Date;
    spxCandles: Candle[]; // 1m, [slot, EOD]
    esCandles: Candle[]; // 1m, [slot, EOD]
    nqCandles: Candle[]; // 1m, [slot, EOD]
    eodClose: { spx: number; ts: Date };
  }): Grade;
  ```
  Contains all 12 grading rules as small named helpers
  (`gradeRegime`, `gradeBias`, `gradeConeHeld`, `gradeTrigger`,
  `simulateTrade`, `gradeICBlown`, `gradeStructure`).
- `api/_lib/periscope-grader-structures.ts` — Appendix A: per-structure
  outcome rules (one function per structure name).
- `api/__tests__/periscope-grader.test.ts` — table-driven tests:
  - regime pin → spot stays ±5pt → regime_correct=true
  - bias long → return positive → correct
  - long_trigger fires when 5-min bar closes ≥ trigger
  - long_trigger does NOT fire when only a wick touches
  - sim_trade hits stop → exit_reason='stop', negative pnl
  - sim_trade hits target → positive pnl
  - sim_trade times out at EOD → exit_reason='eod'
  - IC blown when EOD close > ceiling
  - structure debit_put_spread correct when spot drops ≥ spread width
  - …~25 cases covering each rule's happy + edge cases

### Phase 3 — Grading CLI + endpoint

**Files:**

- `scripts/grade-periscope-day.mjs` — modeled on
  `backfill-periscope-playbook.mjs`. Args: `--date YYYY-MM-DD`
  (default: today CT). For the date:
  1. Query all completed auto-generated playbooks
  2. Parallel-fetch SPX/ES/NQ candles over [day_start, day_end]
  3. For each playbook: filter candles to its window, call
     `gradePlaybook`, UPSERT grade
  4. Print summary table (N graded, % correct per dimension, sim
     PnL totals)
  - Idempotent: ON CONFLICT (periscope_analysis_id, grader_version)
    DO UPDATE — re-running on the same day re-grades cleanly.
  - Dry-run: `--dry-run` prints what it would grade without writing.
- `api/periscope-grades.ts` — GET endpoint. Two modes:
  - `?date=YYYY-MM-DD` → all grades for that day, joined with
    playbook payloads for context
  - `?since=YYYY-MM-DD&groupBy=mode|hour|confidence` → aggregate
    stats (% correct per dimension, mean sim PnL by asset, count by
    bucket)
- `api/__tests__/periscope-grades.test.ts` — endpoint contract tests.

### Phase 4 — Calibration frontend tab

**Files:**

- `src/hooks/usePeriscopeGrades.ts` — fetches `?date=` for the per-day
  view; mirrors `usePeriscopePlaybook` polling discipline (no
  polling on historical, single fetch).
- `src/hooks/usePeriscopeGradeAggregate.ts` — fetches the aggregate
  endpoint; manual refresh only.
- `src/components/Periscope/CalibrationTab.tsx` — new tab, owns the
  date + range pickers + groupBy toggle. Renders:
  - `AggregateStatsCard` at top
  - `DailyGradeTimeline` — vertical list, one row per slot, each row
    shows grade chips
  - On row click: `SlotGradeDetailModal` overlay with playbook lane +
    SPX/ES/NQ chart overlay + trade-sim entry/exit markers
- `src/components/Periscope/AggregateStatsCard.tsx` — top-line
  metrics: regime %, bias %, IC safe %, mean sim PnL per asset.
  Toggle: 7d / 30d / all.
- `src/components/Periscope/DailyGradeTimeline.tsx` — per-row layout
  with grade chips (small ✓/✗ badges per dimension).
- `src/components/Periscope/SlotGradeDetailModal.tsx` — expansion
  view, includes the playbook lane render + price chart + sim panel.
- `src/__tests__/CalibrationTab.test.tsx` — interaction tests.

### Phase 5 — Historical backfill

**Files:**

- `scripts/grade-periscope-day.mjs` already supports a date range via
  loop: `BACKFILL_START=… BACKFILL_END=…
node grade-periscope-day.mjs` calls the same function per day.
- One-shot script invocation grades the post-deploy auto-playbook
  history (Mon 2026-05-11 forward) — small dataset, <5 min runtime.
- For pre-deploy historical playbooks (if the Phase 5 of the
  auto-playbook spec ever runs), this grader works against them
  unchanged.

### Phase 6 — Verification

- `npm run review` clean.
- Manual: run `node scripts/grade-periscope-day.mjs --date 2026-05-08`
  against Friday's 40 playbook rows. Spot-check 3 grades against
  the actual price chart for that day. Especially verify a slot
  where regime_call='pin' that did pin, and one where it didn't.
- Manual: run aggregate endpoint over the 3-day backfill range and
  confirm the stats are sane (no NaN, no 100% pass).
- Manual: load Calibration tab in browser, verify chips render and
  modal opens on row click.

## Data dependencies

- `periscope_analyses` — populated by auto-playbook (live since
  2026-05-10).
- `spx_candles_1m` — populated by SPX candle cron.
- `futures_bars` — populated by Databento sidecar for ES + NQ (and 5
  other symbols we ignore for this feature). Querying:
  ```sql
  SELECT ts, close FROM futures_bars
   WHERE symbol IN ('ES', 'NQ')
     AND ts BETWEEN ${slot} AND ${eod}
   ORDER BY symbol, ts
  ```
- Optional: `ws_option_trades` for the Slot Detail modal's flow
  context (not used in grading, only display).

No new tables besides `periscope_grades`. No new ingestion.

## Thresholds / constants

- Trigger fire = touch + 5-min bar close on breakout side.
- Trade exit: stop at opposite trigger (fallback: gamma floor/ceiling
  if null); target at gamma ceiling/floor; otherwise hold to 15:00
  CT.
- Two-sided bias correctness threshold: absolute EOD return < 0.2%.
- Charm-drift noise threshold: absolute 60-min return < 0.05%.
- Pin regime threshold: ±5 SPX points from magnet/charmZero AND no
  cone breach.
- `GRADER_VERSION = 1` (bump on rubric change to preserve historical
  grades).
- IC settle time: 15:00 CT (0DTE SPX cash-settle reference).

## Open questions

- **EOD = 15:00 vs 15:15 CT?** SPX cash-settled options reference the
  3:00 PM CT close (4:00 PM ET) for 0DTE. **Default: 15:00.**
- **What if ES/NQ has thin overnight data outside RTH?** The sidecar
  ingests near-24h. We restrict to RTH ([08:30, 15:00] CT) to match
  the playbook's intended trading hours. Slots outside this window
  shouldn't exist (auto-playbook 422s pre-market/post-close), but
  defensive check inside the grader.
- **Confidence calibration grading** — should we report sim PnL
  conditional on confidence (was high-conviction actually higher
  P&L)? **Default: yes, surface in aggregate endpoint groupBy.**
- **Re-grading old playbooks when rubric changes** — keep all
  `grader_version=1` rows when shipping `v2`, or drop and re-grade?
  **Default: keep both. The compare itself is useful data.**

## Out of scope

- LLM-based prose grading. Pure formula only.
- Live (intraday) grading. EOD command runs once per day.
- Cross-day correlation analysis (does Monday accuracy predict
  Tuesday?). Future spec.
- Position-sizing / Kelly-criterion sizing from grade history.
  Future spec.
- Comparing grader_version 1 vs 2 side-by-side in UI. Future spec.
- Static debrief visualization standalone — folded into the Slot
  Detail modal in Phase 4.

## Appendix A — Per-structure outcome rules

For each `recommended` and `avoid` entry, apply:

- `debit_put_spread`: correct when spot drops ≥ 1× ATR within EOD
  window (favorable for long puts).
- `debit_call_spread`: correct when spot rises ≥ 1× ATR within EOD
  window.
- `broken_wing_butterfly`: correct when spot pins within
  ±10pt of magnet at EOD (BWB benefits from pin).
- `iron_condor`: correct when spot stays inside
  `[gammaFloor, gammaCeiling]` at EOD (= `!ic_blown_at_eod`).
- `iron_butterfly`: correct when spot pins within ±5pt of magnet
  at EOD.
- `directional_long_put`: correct when EOD return ≤ -0.3%.
- `directional_long_call`: correct when EOD return ≥ +0.3%.
- `credit_call_spread`: correct when spot < lower breakeven at EOD
  (call spread expires worthless).
- `credit_put_spread`: correct when spot > upper breakeven at EOD.
- `long_straddle`: correct when absolute EOD return ≥ 0.4% (vol
  expansion).
- `naked_directional_call` / `naked_directional_put`: correct on
  same return thresholds as their `directional_long_*` cousins.

ATR computed from SPX 1m candles over the prior 30 min at slot time
(rough intraday volatility proxy). If a structure name appears that
isn't in this list, grade as `null` (unknown) so it's surfaced
without polluting accuracy metrics.

## Cost

Zero LLM spend. Grading is pure arithmetic over candle data
already in Neon. Storage: ~5KB per grade row × 40 slots/day ×
250 trading days = ~50MB/year — trivial.
