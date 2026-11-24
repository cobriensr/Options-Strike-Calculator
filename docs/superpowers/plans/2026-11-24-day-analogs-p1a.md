# Day-analogs P1a (builder and schema) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, from `futures_bars` ES, the 08:30 CT cash-window vectors
and prediction-only summaries for N ∈ {15, 30, 60}, plus the cash-session
labels, and create the table that will hold them. Nothing reads or writes
the table yet (P1b wires it), so this ships dark.

**Architecture:** One new module, `api/_lib/day-analog-builder.ts`. Its
pure core turns a sorted series of one-minute bars into window results
(a vector and summary, or a named refusal) and a label result. A thin
async entry point reads the bars through the existing `fetchFuturesBars`,
drops bars that are not finished at `asOf`, and calls the core. One
migration creates `day_analog_windows`, keyed
`(date, feature_set, n_minutes)`.

**Tech Stack:** TypeScript (Vercel Functions), Neon Postgres with
pgvector 0.8.0, Vitest.

**Spec:** `docs/superpowers/specs/day-analogs-rebuild-2026-10-02.md`
("Window decision", "P1 — P1a", "Risks", "Open questions",
"Thresholds / constants", "Phase 0 results"). The futures repair that
postdates the spec's P0 is in
`docs/superpowers/specs/futures-contract-mix-repair-2026-11-06.md`.

## Global Constraints

- Window, verbatim from the spec: "uses the bars stamped 08:30 …
  08:30+N−1 CT (America/Chicago, so DST is handled); takes each bar's
  close, carried forward over gaps; divides by the **open of the 08:30
  bar** and subtracts 1."
- N ∈ {15, 30, 60}. A vector has exactly N entries.
- `MIN_BARS` = 10. `PROXY_JUMP_PTS` = 15. The builder **refuses** a
  flagged window or one with fewer than `MIN_BARS` bars. It never
  repairs one.
- Flag rule (owner decision 2026-11-24, spec P1a): a bar has a `gap`
  when |open − previous bar's close| > 15. "Previous" means the
  neighbouring bar in the ts-sorted series, whatever its minute. A window
  or a session is `flagged` when one of its bars has a gap, or the first
  bar after its last bar does. That is where a bad last close shows. The
  P0 `spike` half is **not** used, and neither is `wide`.
- The summary is prediction-only: open, N-minute delta, N-minute high,
  low, range and volume. Nothing after minute N−1 goes into a vector or
  a summary.
- No date-span exclusion. The 2026-04-06 → 06-15 bars were repaired on
  2026-11-07 and go through the normal checks (owner decision
  2026-11-24, spec open question 6).
- No new env vars. No new dependency. No caller of the new module in
  this plan.
- `api/` code that imports `src/` uses explicit `.js`:
  `../../src/data/marketHours.js` and `../../src/utils/timezone.js`.
- The migration follows CLAUDE.md "DB Migrations" for
  `api/__tests__/db.test.ts`.
- One commit per task, each after a green `npm run review`.

## Owner decisions (2026-11-24)

- **A. The suspect-bar check: open gap only,** for windows and labels
  alike. The reverting-spike half of the P0 rule is dropped.
- **B. The April–June 2026 span: used,** with the normal checks.

The evidence behind both, read-only on production on 2026-11-24, using
the P0 rule on ES cash-session bars:

- **The repaired span is clean.** 2026-04-06 → 06-15: 0 of 51 CT dates
  with cash-hour bars have a flagged bar.
- **Across 2025-04-06 → 2026-11-23,** 6 of 417 sessions flag and 3 of
  417 first hours flag (2025-04-07, 2025-04-10 and 2026-11-23).
- **What the counts cover.** They are CT dates with cash-hour bars, so
  they include CME-only holiday sessions. By `marketHours.ts` there are
  50 and about 411 NYSE trading days. All six flagged dates are trading
  days.
- **The dates:** 2025-04-07, 04-09, 04-10, 2026-06-17, 06-26 and 11-23.
- **The 26 flagged bars are all `spike` with no `gap`:** every open is
  within 0.75 pt of the previous close. They are real fast-market
  reversals.
- **Why `gap` still matters:** it is the merge-writer signature (a
  back-month open winning the first write). A stray bad closing print
  also shows up as a `gap` on the next bar.

## Decisions this plan makes (the spec leaves them open)

1. **Table name and shape.** `day_analog_windows`, keyed
   `(date, feature_set, n_minutes)`. `features` is an untyped `vector`
   with a table CHECK `vector_dims(features) = n_minutes`, so one column
   holds 15-, 30- and 60-dim rows. A plain HNSW index needs fixed
   dimensions. A partial expression index per N
   (`(features::vector(15)) … WHERE n_minutes = 15`) is still possible
   later.
2. **Text-backend columns now.** Production runs the text backend (spec
   open question 5), so the table gets nullable `embedding vector(2000)`
   and `embedding_model` now. P1b and P2 fill them, and no second
   migration is needed.
3. **No vector indexes in P1a.** The query shape that decides the index
   (one HNSW per N, partial on `n_minutes`, or iterative scan) is written
   in P1b. Building an index on an empty table buys nothing. P1b picks
   the index from its own `EXPLAIN`.
4. **Feature set name** `cash_open_pct_change_v2`.
5. **Summary has no date and a generic symbol.** The spec lists the
   fields as "open, N-minute delta, N-minute high/low/range and N-minute
   volume". v1 began with the date and the outright symbol. In an
   embedding, both pull neighbours toward nearby dates and the same
   contract month. The v2 line starts `ES | `. The absolute prices
   (open, high, low) stay, by owner decision on 2026-11-24. P2's
   calibration compares a variant with distances from the open.
6. **Labels live in the builder module, and P2 mirrors all the rules.**
   P1b's nightly row calls `cashSessionLabels` and `buildCashWindow`.
   P2's backfill is Python (`ml/src/day_analog_backfill.py`), so it
   can't call them, and it must mirror every rule here:
   - the anchor: the bar stamped exactly 08:30 CT;
   - `MIN_BARS` for windows; 390 bars, or 210 on a half day, for labels;
   - carry-forward of closes;
   - `bad_bar`, including the bars before and after;
   - canonical contract names;
   - the open-gap rule: the bar before the first bar feeds the anchor's
     gap, and the bar after the last bar is gap-checked too;
   - no date-span exclusion;
   - the summary format and its rounding (decisions 5 and 10).
   The module header lists them, and the parity file (decision 12)
   tests them.
7. **Contract check (defensive).** `futures_bars.contract` names the
   outright on bars since 2026-07-28. The uw-stream era switches
   contracts only at 17:00 CT, so `mixed_contract` should never fire
   inside one 07:30–15:01 read. The check guards older and repaired rows
   and any future writer change.
   - Contracts are compared in canonical form: root, month code and the
     last year digit, so `ESZ26` equals `ESZ6`. The column CHECK allows
     both spellings.
   - A NULL contract means unknown and is accepted.
8. **A window is complete 75 s after its end.** uw-stream writes minute
   M only once a print in minute M+1 arrives, then flushes every 2 s
   (`uw-stream/src/handlers/futures_trades.py:118-125`,
   `uw-stream/src/config.py:203`). `WINDOW_GRACE_MS = 75_000` covers the
   last window bar and the bar after it, so the gap check sees the bar
   that would reveal a bad last close. Labels use the same grace after
   the session end.
   - Example: N = 30 is ready at 09:01:15 CT, not 09:00:00.
   - P1b picks the largest window that came back ok, rather than
     re-deriving N from the clock, and the block names its length.
     The owner approved this fallback on 2026-11-24.
9. **Reuse the existing formatters.** `formatVolume` and `formatDelta` in
   `api/_lib/postgres-day-summary.ts:53-63` already match the sidecar's
   format, so Task 2 exports them and uses them. It does not write a
   third copy.
10. **Rounding ties.** JS `toFixed` rounds an exact binary tie up
    (`(412.25).toFixed(1)` = `412.3`), and Python's format rounds it to
    even (`412.2`). The TS strings are canonical. To match them, P2's
    Python writer rounds with `Decimal(v).quantize(…, ROUND_HALF_UP)`
    on the exact float value. The module header says so.
11. **The VIX bucket is the prior trading day's** (owner decision
    2026-11-24, spec P1b). `vix_bucket` holds `vixBucketOf` of the VIX
    close of the trading day before `date`, never that day's own close.
    P1a computes no bucket; it only defines the column, and its
    description says what the value means. P1b's writer and the analyze
    side both use this rule, and P2's backfill does too.
12. **One shared parity file both builders must pass** (owner decision
    2026-11-24, spec P2). `api/__tests__/fixtures/day-analog-parity.json`
    holds sample bars and hand-computed expected results. The precedent
    is `lottery-score-parity.json`, which `ml/tests/test_lottery_weights.py`
    also reads.
    - The TS builder's tests run every case now. P2's
      `ml/tests/test_day_analog_backfill.py` must run the same file.
    - This turns decision 6's "must mirror" into a failing test.
    - The expected values are worked out by hand from the rules, never
      copied from either program's output. A regenerated file would only
      prove a builder agrees with itself.

## Review Focus

1. **DST dates.** On 2026-03-06 (CST), 08:30 CT is 14:30Z. On 2026-03-09
   (CDT) it is 13:30Z. Reading the wrong hour would silently build a
   vector from the wrong minutes. Task 3 pins both read bounds.
2. **A live call at a window's edge.** At 09:00:30 CT, N = 30 must be
   `incomplete` (ready at 09:01:15), not a vector whose 08:59 slot was
   carried from 08:58. A still-forming bar must not count. Task 3 pins
   both.
3. **Half day.** On 2026-11-27 the labels need 210 bars, not 390, and
   the read ends at 12:01 CT. Task 2 (labels) and Task 3 (read bound)
   pin it.
4. **Contract names.** `ESZ6` with `ESH7` is refused `mixed_contract`,
   but `ESZ6` with `ESZ26` is the same contract and is accepted. Task 2
   pins both.
5. **Malformed or NaN prices.** The driver returns NUMERIC as text, and
   Postgres NUMERIC can hold `NaN`. A non-finite value must refuse the
   window or the labels as `bad_bar`. It must never put NaN in a vector
   or a range. NaN slips through the flag rule and `Math.max`, because
   a NaN comparison is false. Task 2 pins it on the core, Task 3 on the
   conversion.

---

### Before Task 1 (controller, done 2026-11-24)

The vector SQL was probed on production, read-only. pglite here has no
pgvector, and the migration test is mocked, so nothing else checks it:

`SELECT vector_dims('[1,2,3]'::vector) = 3::smallint, pg_typeof(NULL::vector), vector_dims(<2000 zeros>::vector(2000)), extversion`

The result was `true`, `vector`, `2000` and `0.8.0`.

### Task 1: The `day_analog_windows` migration

**Files:**

- Modify: `api/_lib/db-migrations.ts` (append the next free id: 211 at
  plan time. Re-check `origin/main` before writing, since another session
  may have taken it.)
- Modify: `api/__tests__/db.test.ts`

**Interfaces:**

- Produces: table `day_analog_windows`. P1b and P2 write it, and the
  analyze fetchers read it.

- [ ] **Step 1: Update `db.test.ts` first** per CLAUDE.md: add
      `{ id: 211 }` to the applied-ids mock and `#211: <description>` to
      the expected output. Raise the `mockSql` total by 2 (one statement
      plus the tracking INSERT) and the `mockSql.transaction` total by 1.
      Extend both breakdown comments, and name 211 as the top id.
- [ ] **Step 2: Run the test and watch it fail.**
      Run: `npx vitest run api/__tests__/db.test.ts`
      Expected: FAIL on the counts and the missing `#211` line.
- [ ] **Step 3: Append migration 211** with one statement, exactly this
      shape:

```sql
CREATE TABLE IF NOT EXISTS day_analog_windows (
  date            DATE NOT NULL,
  feature_set     TEXT NOT NULL,
  n_minutes       SMALLINT NOT NULL,
  symbol          TEXT NOT NULL,
  contract        TEXT,
  source          TEXT NOT NULL,
  features        vector NOT NULL,
  summary         TEXT NOT NULL,
  embedding       vector(2000),
  embedding_model TEXT,
  vix_bucket      TEXT,
  session_open    DOUBLE PRECISION,
  session_high    DOUBLE PRECISION,
  session_low     DOUBLE PRECISION,
  session_close   DOUBLE PRECISION,
  range_pt        DOUBLE PRECISION,
  up_exc          DOUBLE PRECISION,
  down_exc        DOUBLE PRECISION,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, feature_set, n_minutes),
  CONSTRAINT day_analog_windows_n_chk CHECK (n_minutes IN (15, 30, 60)),
  CONSTRAINT day_analog_windows_dims_chk
    CHECK (vector_dims(features) = n_minutes),
  CONSTRAINT day_analog_windows_source_chk
    CHECK (source IN ('archive', 'futures_bars')),
  CONSTRAINT day_analog_windows_vix_chk
    CHECK (vix_bucket IN ('low', 'normal', 'elevated', 'crisis')),
  CONSTRAINT day_analog_windows_embedding_chk
    CHECK ((embedding IS NULL) = (embedding_model IS NULL))
)
```

The description follows the repo's long-form style and says:

- what each column holds;
- that `features` is untyped so that one column carries all three N;
- that the labels are ES points from the 08:30 CT open over the full
  cash session, NULL until that session is complete;
- that `source` is `archive` for P2 rows up to 2026-04-17 and
  `futures_bars` after;
- that `vix_bucket` is the bucket of the prior trading day's VIX close,
  so it is known before the open and never reflects the day itself
  (decision 11);
- that nothing reads or writes the table until P1b, so the apply order
  is free;
- that there are no vector indexes yet, and why (decision 3);
- the spec path.

- [ ] **Step 4: Run the test and watch it pass.**
      Run: `npx vitest run api/__tests__/db.test.ts`
      Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then
      `git add -- api/_lib/db-migrations.ts api/__tests__/db.test.ts &&
      git commit` with the message
      `feat(db): Add the day_analog_windows table for the cash-open analogs`.

### Task 2: The builder's pure core

**Files:**

- Create: `api/_lib/day-analog-builder.ts`
- Create: `api/__tests__/day-analog-builder.test.ts`
- Create: `api/__tests__/fixtures/day-analog-parity.json` (decision 12)
- Modify: `api/_lib/postgres-day-summary.ts` (export `formatVolume` and
  `formatDelta`; behaviour unchanged)

**Interfaces:**

- Consumes:
  - `isTradingDay`, `cashSessionMinutes` from
    `../../src/data/marketHours.js`;
  - `ctWallClockToUtcIso` from `../../src/utils/timezone.js`;
  - `formatVolume`, `formatDelta` from `./postgres-day-summary.js`.
- Produces (exported, exact):

```ts
export const DAY_ANALOG_FEATURE_SET = 'cash_open_pct_change_v2';
export const ANALOG_WINDOW_MINUTES = [15, 30, 60] as const;
export type AnalogWindowMinutes = (typeof ANALOG_WINDOW_MINUTES)[number];
export const CASH_OPEN_MIN_CT = 8 * 60 + 30;
export const MIN_BARS = 10;
export const PROXY_JUMP_PTS = 15;
export const WINDOW_GRACE_MS = 75_000;

/** One ES minute bar; ts is the UTC ISO minute stamp. */
export interface AnalogBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  contract: string | null;
}

export type Refusal =
  | 'not_trading_day'
  | 'incomplete'
  | 'no_anchor'
  | 'too_few_bars'
  | 'bad_bar'
  | 'mixed_contract'
  | 'flagged';

export interface AnalogWindow {
  nMinutes: AnalogWindowMinutes;
  features: number[];
  summary: string;
  open: number;
  close: number; // last carried close, minute N−1
  high: number;
  low: number;
  volume: number;
  bars: number; // window bars present, ≤ N
  contract: string | null; // canonical, or null when every bar is NULL
}

export type WindowResult =
  | { ok: true; window: AnalogWindow }
  | { ok: false; nMinutes: AnalogWindowMinutes; reason: Refusal };

export interface CashSessionLabels {
  open: number;
  high: number;
  low: number;
  close: number;
  rangePt: number;
  upExc: number;
  downExc: number;
}

export type LabelResult =
  | { ok: true; labels: CashSessionLabels }
  | { ok: false; reason: Refusal };

/** gaps[i]: i > 0 and |bars[i].open − bars[i−1].close| > PROXY_JUMP_PTS. */
export function openGaps(bars: readonly AnalogBar[]): boolean[];
export function buildCashWindow(
  date: string,
  nMinutes: AnalogWindowMinutes,
  bars: readonly AnalogBar[],
): WindowResult;
export function formatWindowSummary(w: AnalogWindow): string;
export function cashSessionLabels(
  date: string,
  bars: readonly AnalogBar[],
): LabelResult;
```

`bars` is the whole ts-sorted read series (07:30 CT onward, Task 3). It
is not just the window, so the gap check sees the bar before the anchor
and the bar after the last window bar. Task 3 never passes an
unfinished window or session. The core does not use `incomplete`; Task 3
sets it.

Both functions run the same checks, in this order, over their bars (the
window's N minutes, or the session's 390 or 210). The first failure
names the refusal:

1. `not_trading_day`: `isTradingDay(date)` is false.
2. `no_anchor`: no bar is stamped exactly 08:30 CT.
3. `too_few_bars`: a window has fewer than `MIN_BARS` bars, or a session
   has fewer than `cashSessionMinutes(date)`.
4. `bad_bar`: a bar has a non-finite or ≤ 0 price, or a non-finite or
   negative volume. The bar before the first one and the bar after the
   last one are checked too, when present, because the gap check reads
   their close and open.
5. `mixed_contract`: two distinct canonical non-null contracts appear.
6. `flagged`: one of the bars, or the first bar after the last one, has
   an open gap.

The test helper is `bars(date, fromCtMin, rows)`. It stamps consecutive
minutes from `fromCtMin` with `ctWallClockToUtcIso`, and each row gives
`[open, high, low, close, volume, contract?]`. Use 2026-11-23 (a Monday,
CST) unless a test names another date.

- [ ] **Step 1: Write the failing tests.** Each `it` is named as below.
  - `openGaps marks an open more than 15 pt from the previous close`:
    closes 6000, 6000 and a second open of 6016 → `[false, true]`. An
    open of 6015 is no gap. The first bar is never a gap.
  - `builds the 15-minute vector from the 08:30 open with carry-forward`:
    the 08:30 open is 6000 and the closes are 6000, 6003, 6006; minute 3
    is missing; minutes 4–14 close 6012. Expect `features.length` 15,
    `features[0]` 0, `features[2]` 0.001, `features[3]` 0.001 (carried)
    and `features[4]` 0.002, with `toBeCloseTo(x, 12)`. Expect `bars`
    14, `close` 6012 and `open` 6000.
  - `uses only bars 08:30 to 08:30+N−1 and ignores the 07:30 lead-in`:
    lead-in bars closing at 6005 do not change the vector, and the 08:45
    bar is not in N = 15. Keep the lead-in within 15 pt of the 08:30
    open, so the anchor gets no gap.
  - `never reads past minute N−1`: changing the close, high and low of
    the 08:45 bar by 40 pt (its open unchanged) leaves the N = 15 window
    equal (`toEqual`).
  - `refuses each reason in order`: one case per refusal 1–6:
    1. 2026-11-26 (Thanksgiving);
    2. a series starting 08:31;
    3. 9 bars;
    4. a NaN close → `bad_bar`, not `flagged`;
    5. ESZ6 plus ESH7 (Review Focus 4);
    6. a 16-pt open gap on the 08:40 bar.

    Add one case where both 3 and 6 hold and expect `too_few_bars`.
  - `gap-checks the anchor against the bar before it`: with the 08:29
    close at 6000 and the 08:30 open at 6050, both N = 15 and the labels
    are `flagged`. This is P0's main contamination signature: a
    back-month open that moves the anchor about 50 pt. An 08:29 close of
    NaN gives `bad_bar` for both.
  - `flags a bad last close through the next bar's open gap`: N = 15
    where the 08:45 bar opens 20 pt from the 08:44 close → `flagged`.
    With no bar after 08:44 in the series → ok.
  - `keeps a real fast move` (owner decision A): a 20-pt close spike at
    08:40 that reverts at 08:41, each open equal to the previous close
    → ok.
  - `accepts a date in the repaired April–June span` (owner decision
    B): 2026-05-12 with clean bars → ok.
  - `treats contract spellings and NULLs as one contract`: ESZ6 plus
    ESZ26 → ok, `contract` `ESZ6`. NULL plus ESZ6 → ok, `ESZ6`. All NULL
    → ok, `null`.
  - `formats the summary line exactly`: open 6000, close 6012.25, high
    6015.25, low 5995.5, volume 412_340, N 30 →
    `'ES | open 6000.00 | 30m delta +12.25 | 30m high 6015.25 | 30m low 5995.50 | 30m range 19.75 | 30m vol 412.3K'`.
    Pin 3_250_000 → `3.25M`, 421 → `421`, and a delta of −3.5 →
    `-3.50`.
  - `labels a full day from the 08:30 open`: 390 session bars, open
    6000, max high 6040, min low 5980, last close 6010 → ok with
    `rangePt` 60, `upExc` 40, `downExc` 20, `close` 6010.
    - The fixture also carries the 15:00 bar after the session (high
      6100, close 6090, open equal to the 14:59 close), as Task 3's read
      does.
    - The labels must not change, so the session is rel 0 …
      `cashSessionMinutes(date)` − 1 and nothing later.
  - `labels a half day from 210 bars` (Review Focus 3): 2026-11-27 with
    210 bars plus the 12:00 bar after them, with a different high and
    close → ok and unchanged by that bar. With 209 bars plus the 12:00
    bar → `too_few_bars`.
  - `refuses labels with a reason`:
    - 2026-11-26 → `not_trading_day`;
    - 389 bars on a full day (the 13:07 bar missing) plus the 15:00 bar
      → `too_few_bars`;
    - a 20-pt open gap on the 15:00 bar after the session → `flagged`;
    - one bar with high NaN → `bad_bar`, and no `rangePt` is computed;
    - ESZ6 plus ESH7 → `mixed_contract`;
    - a 16-pt open gap on the 13:00 bar → `flagged`;
    - a 20-pt reverting close spike with no gap (a crash-day minute) →
      ok.
  - `matches every case in the shared parity fixture` (decision 12):
    `describe.each` over the file's three arrays. Each case is checked
    against its `expect`, with features `toBeCloseTo(x, 12)`, the
    summaries exactly, and the refusal reasons exactly.

    The file format:

    ```json
    {
      "version": 1,
      "note": "Hand-computed from the rules in docs/superpowers/specs/day-analogs-rebuild-2026-10-02.md (P1a). Never regenerate from either builder's output. P2's Python backfill must pass every case.",
      "windows": [
        {
          "name": "…",
          "date": "2026-11-23",
          "nMinutes": 15,
          "bars": [["2026-11-23T13:29:00.000Z", "6000.0000", "6001.0000", "5999.5000", "6000.0000", 1200, null]],
          "expect": { "ok": true, "window": { "features": [], "summary": "…", "open": 6000, "close": 6012, "high": 6014, "low": 5998, "volume": 18000, "bars": 14, "contract": null } }
        }
      ],
      "labels": [ { "name": "…", "date": "…", "bars": [], "expect": { "ok": false, "reason": "too_few_bars" } } ],
      "summaries": [ { "name": "…", "window": { "nMinutes": 30, "open": 6000, "close": 6012.25, "high": 6015.25, "low": 5995.5, "volume": 412340 }, "expect": "ES | open 6000.00 | 30m delta +12.25 | …" } ]
    }
    ```

    - A bar is `[ts UTC ISO, open, high, low, close, volume, contract]`.
      Prices are NUMERIC text, as the Neon driver returns them, so
      `"NaN"` can appear. Each side converts with `Number()` or
      `float()`.
    - The window and labels expectations hold the same fields as
      `WindowResult` and `LabelResult`, without `nMinutes`.

    The cases, at minimum:

    - **windows:**
      - the carry-forward vector (CST);
      - a clean N = 15 on 2026-03-09 (CDT, anchor 13:30Z), which pins the
        time-zone mapping;
      - an anchor gap against 08:29 → `flagged`;
      - a gap on the bar after the window → `flagged`;
      - a real spike and revert → ok;
      - a NaN close → `bad_bar`;
      - ESZ6 with ESZ26 → ok, `ESZ6`;
      - ESZ6 with ESH7 → `mixed_contract`;
      - 9 bars → `too_few_bars`;
      - no 08:30 bar → `no_anchor`;
      - 2026-11-26 → `not_trading_day`;
      - one N = 60 case.
    - **labels:**
      - a full day of 390 bars plus the 15:00 bar → ok;
      - 2026-11-27 with 210 bars plus the 12:00 bar → ok;
      - 389 bars plus 15:00 → `too_few_bars`;
      - a gap on the 15:00 bar → `flagged`.
    - **summaries:**
      - the 412,340 case;
      - the tie 412,250 → `412.3K` (decision 10);
      - 3,125,000 → `3.13M`;
      - 3,250,000 → `3.25M`;
      - 421 → `421`;
      - a negative delta.
- [ ] **Step 2: Run the tests and watch them fail.**
      Run: `npx vitest run api/__tests__/day-analog-builder.test.ts`
      Expected: FAIL, because the module is missing.
- [ ] **Step 3: Implement the exports above** in
      `api/_lib/day-analog-builder.ts`, and export the two formatters
      from `postgres-day-summary.ts`.
  - The relative minute is `(Date.parse(ts) − anchorMs) / 60_000`, where
    `anchorMs` is `ctWallClockToUtcIso(date, CASH_OPEN_MIN_CT)`.
  - Session bars are relative minutes 0 … `cashSessionMinutes(date)` −
    1.
  - The module header cites the spec. It says that P2's Python writer
    must produce the same summary string (decision 10's rounding) and
    the same label rules (decision 6).
- [ ] **Step 4: Run the tests and watch them pass.** Same command, and
      also `npx vitest run api/__tests__/postgres-day-summary.test.ts`.
      Expected: PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then
      `git add -- api/_lib/day-analog-builder.ts api/__tests__/day-analog-builder.test.ts api/__tests__/fixtures/day-analog-parity.json api/_lib/postgres-day-summary.ts &&
      git commit` with the message
      `feat(analogs): Build cash-open analog windows and labels from ES bars`.

### Task 3: The async entry point

**Files:**

- Modify: `api/_lib/day-analog-builder.ts`
- Modify: `api/__tests__/day-analog-builder.test.ts`

**Interfaces:**

- Consumes: `fetchFuturesBars(symbol, startIso, endIso)` from
  `./futures-bars.js`, which returns `StoredFuturesBar[]` with NUMERIC
  prices as text; the Task 2 exports.
- Produces:

```ts
export interface DayAnalogBuild {
  date: string;
  windows: WindowResult[]; // one per ANALOG_WINDOW_MINUTES, in order
  labels: LabelResult;
}
export async function buildDayAnalogWindows(
  date: string,
  asOf?: Date, // default new Date()
): Promise<DayAnalogBuild>;
```

The entry point works in four steps:

1. **No read on a non-trading day.** Every window and the labels are
   refused `not_trading_day`, without reading the database.
2. **One read.** Otherwise it makes one `fetchFuturesBars('ES', start,
   end)` call. `start` is `ctWallClockToUtcIso(date, CASH_OPEN_MIN_CT −
   60)`. `end` is `ctWallClockToUtcIso(date, CASH_OPEN_MIN_CT +
   cashSessionMinutes(date) + 1)`, which includes the bar after the
   session for the gap check on the last close.
3. **Convert and keep finished bars.** Prices go through `Number()`, and
   a NaN stays NaN so the core refuses it. It keeps bars with
   `Date.parse(ts) + 60_000 ≤ asOf`.
4. **Build the results.** A window is `incomplete` while `asOf <
   anchorMs + N·60_000 + WINDOW_GRACE_MS`; otherwise it goes to
   `buildCashWindow`. Labels are `incomplete` while `asOf` is before the
   session end plus `WINDOW_GRACE_MS`, and come from `cashSessionLabels`
   after that.

A database error rejects; it is not caught. The P1b callers decide how
to degrade.

- [ ] **Step 1: Write the failing tests** with
      `vi.mock('../_lib/futures-bars.js', …)` (R3: mock at the module
      boundary).
  - `reads 07:30 CT to the bar after the close in UTC, across DST`
    (Review Focus 1): on 2026-03-06 the call is `('ES',
    '2026-03-06T13:30:00.000Z', '2026-03-06T21:01:00.000Z')`. On
    2026-03-09 it is `('ES', '2026-03-09T12:30:00.000Z',
    '2026-03-09T20:01:00.000Z')`. On 2026-11-27 the end is
    `'2026-11-27T18:01:00.000Z'`.
  - `holds a window until 75 s after its end` (Review Focus 2):
    - at 09:01:14 CT, N = 30 is `incomplete`;
    - at 09:01:15, N = 30 is ok;
    - at 09:09:30, N = 15 and N = 30 are ok, N = 60 is `incomplete`,
      and the labels are `incomplete`;
    - on a full day the labels are `incomplete` at 15:01:14 and ok at
      15:01:15;
    - on 2026-11-27 they are `incomplete` at 12:01:14 and ok at
      12:01:15.
  - `drops the still-forming bar from the series`: the mock returns bars
    through 09:09 with no 08:45 bar, and the 08:46 bar opens 20 pt from
    the 08:44 close. That makes 08:46 the first bar after N = 15.
    - At `asOf` 08:46:30 CT, N = 15 is ok. The 08:46 bar finishes at
      08:47, so it is dropped and its gap is never seen.
    - At 08:47:00, the 08:46 bar is finished and kept, so N = 15 is
      `flagged`.
    - At 08:46:14, N = 15 is `incomplete` (ready at 08:46:15).
    - Without the `ts + 60 s ≤ asOf` filter, the first bullet fails.
  - `builds all three windows and labels after the close`: with a full
    day and `asOf` at 15:05 CT, there are three ok windows in the order
    15, 30, 60, and the labels are ok.
  - `skips the read on a holiday`: on 2026-11-26, `fetchFuturesBars` is
    not called, and every window and the labels carry
    `not_trading_day`.
  - `refuses a bar whose price text is malformed` (Review Focus 5):
    `close: 'abc'` on the 08:35 bar → N = 15 `bad_bar`, and the labels
    `bad_bar` after the close. No NaN appears in any result.
  - `rejects when the database read fails` (R4):
    `fetchFuturesBars` rejects with `new Error('neon down')` →
    `buildDayAnalogWindows` rejects with that error.
- [ ] **Step 2: Run the tests and watch the new ones fail.**
      Run: `npx vitest run api/__tests__/day-analog-builder.test.ts`
      Expected: FAIL, because `buildDayAnalogWindows` is missing.
- [ ] **Step 3: Implement `buildDayAnalogWindows`** as described above.
- [ ] **Step 4: Run the tests and watch them pass.** Same command;
      expected PASS.
- [ ] **Step 5: Gate and commit.** Run `npm run review`, then
      `git add -- api/_lib/day-analog-builder.ts api/__tests__/day-analog-builder.test.ts &&
      git commit` with the message
      `feat(analogs): Read ES bars for a CT date into analog windows`.

## After the tasks

- **Record the build in the spec** (docs only):
  - In the Status table, set P1 – P3 to "P1a built (`day_analog_windows`,
    `day-analog-builder.ts`); P1b next".
  - Under P1a, add one line naming decisions 1–10.
- **Push** to main (needs the owner's OK). This touches `api/` only, so
  Vercel deploys and no Railway service redeploys.
- **Apply migration 211** with
  `npx tsx --env-file=.env.local scripts/run-pending-migrations.mts`.
  It writes to production and applies every pending migration,
  including other sessions' migrations, so it waits for the owner's OK.
  Nothing reads the table yet, so it can wait.

## Out of scope (later phases)

- P1b: the analyze fetchers (the largest window that came back ok; no
  block before 08:45 CT), `embed-yesterday` writing v2 rows (labels, VIX
  bucket, embedding), the vector indexes, the ES − SPX basis check.
- P2: the history backfill (the archive up to 2026-04-17,
  `futures_bars` after), the re-embed, the calibration, the v1 drop.
