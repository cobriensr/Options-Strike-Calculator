---
status: Draft — pending approval
date: 2026-05-19
---

# Opening Flow Signal — Historical Persistence

## Goal

Let the user (and guests) browse Opening Flow Signal results for
arbitrary past trading days — including days where no signal fired —
even after the underlying `ws_option_trades` retention window
(2 days) has aged out the source trades. Today the OFS endpoint
re-computes from raw trades for every request; that works for live
+ yesterday but goes empty on day 3.

## Why now

Wonce's request after Monday's window: "I need to be able to go
back and see previous days, even if there was no signal, so these
need to be written to the DB if they are not already, not just
local storage." Confirmed with code grep:

- [api/cron/cleanup-ws-option-trades.ts:44](../../../api/cron/cleanup-ws-option-trades.ts#L44)
  sets `RETENTION_DAYS = 2`.
- The OFS endpoint already accepts `?date=YYYY-MM-DD` (see
  [api/_lib/validation/opening-flow.ts:15](../../../api/_lib/validation/opening-flow.ts#L15))
  and re-computes from `ws_option_trades`. So the endpoint surface
  is ready; the missing piece is durable storage of the result so
  it survives the trade-table sweep.

The same-day localStorage hotfix shipped in commit `4eb432eb` keeps
the panel populated through the trading day. This spec is the
durable-history complement.

## Architecture

Add a per-date snapshot table that the same daily evaluator
populates. The endpoint reads from the table for historical dates
and only does live evaluation for today (when the table row
doesn't yet exist or is stale).

```text
       08:50 CT cron               GET /api/opening-flow-signal?date=YYYY-MM-DD
            │                                       │
            ▼                                       ▼
  ┌─────────────────────────┐         ┌────────────────────────┐
  │ evaluateOpeningFlow(d)  │◄────────│ requestedDate provided │
  │ (shared lib)            │         │ ┌─────────────────────┐│
  └─────────────┬───────────┘         │ │ d === today?       ││
                │                     │ │  yes → live compute││
                ▼                     │ │  no  → table read  ││
  ┌─────────────────────────┐         │ └─────────────────────┘│
  │ INSERT INTO             │         └────────────────────────┘
  │ opening_flow_signals    │
  │ ON CONFLICT (date,      │
  │ ticker) DO UPDATE       │
  └─────────────────────────┘
```

Single canonical evaluator function used by **both** code paths so
historical reads and live reads produce byte-identical shapes.

## Operating rules

Same as the frontend-cleanup spec — every phase commit gates on
`npm run review` green + coverage at-or-above the current floor +
code-reviewer subagent verdict `pass` before commit + push.
Max 5 files per phase commit. Tier checkpoint review when all
phases done before declaring complete.

## Phases

### Phase 1 — Migration #173: `opening_flow_signals` table

**New file:** `api/_lib/db-migrations.ts` — append migration #173
to the `MIGRATIONS` array.

**Schema:**

```sql
CREATE TABLE IF NOT EXISTS opening_flow_signals (
  date           DATE NOT NULL,
  ticker         TEXT NOT NULL,
  window_status  TEXT NOT NULL,
  -- Full payload pieces — JSONB so we don't fight a column proliferation
  -- when slice1/slice2/signal grow new fields. Same shape as the
  -- endpoint's OpeningFlowTickerPayload type.
  slice1         JSONB,
  slice2         JSONB,
  signal         JSONB,
  -- Wall-clock when the evaluator finished — useful for "is this
  -- snapshot fresh?" without re-querying ws_option_trades.
  as_of_utc      TIMESTAMPTZ NOT NULL,
  -- Stop loss / exit-minute constants used at capture time. Live
  -- constants drift; freezing per-row lets a historical replay use
  -- the rule as it was that morning.
  stop_pct                  NUMERIC(6,4) NOT NULL,
  exit_minutes_from_entry   INTEGER NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (date, ticker)
);

CREATE INDEX IF NOT EXISTS opening_flow_signals_date_idx
  ON opening_flow_signals (date DESC);
```

**Test:** extend `api/__tests__/db.test.ts` — add `{ id: 173 }`
to the applied-migrations mock, add the migration to the expected
output, bump SQL call count.

### Phase 2 — Lib refactor: extract `evaluateOpeningFlow(date)`

**Goal:** the SQL pull + slice computation that
`/api/opening-flow-signal` does inline at lines ~150-200 becomes a
named exported function in `api/_lib/opening-flow.ts` (or a new
`opening-flow-evaluator.ts` if the lib is getting crowded). Both
the cron and the endpoint will call it. Same return shape.

**Files:**

- Modify: `api/_lib/opening-flow.ts` (or new
  `opening-flow-evaluator.ts`)
- Modify: `api/opening-flow-signal.ts` — replace inline SQL +
  evaluation with `await evaluateOpeningFlow(targetDate)`
- Test: extend `api/__tests__/opening-flow.test.ts` to cover the
  extracted function with a known fixture

**Verify:** endpoint behavior byte-identical for live + historical
dates that have raw trades. No DB shape change in this phase.

### Phase 3 — Capture cron: `capture-opening-flow-signal`

**New files:**

- `api/cron/capture-opening-flow-signal.ts` — runs daily at
  ~08:50 CT (after slice 2 ends, before the next day's trades
  pour in). Calls `evaluateOpeningFlow(today CT date)`. UPSERTs
  one row per `{date, ticker}` into `opening_flow_signals`.
- `api/__tests__/capture-opening-flow-signal.test.ts` — mocks db
  + evaluator; asserts the cron hits ON CONFLICT upsert with the
  right shape; asserts CRON_SECRET guard; asserts market-hours
  gate (no-op on weekends / holidays).

**Schedule:** add to `vercel.json` cron list — `0 14 * * 1-5` UTC
(08:50 CT in CDT; will need DST consideration — match the same
DST pattern other crons use, e.g. `cron-schedules.ts` helpers
already in place).

**Idempotency:** ON CONFLICT DO UPDATE so re-running the cron
overwrites — useful if there was a transient failure and the cron
re-runs an hour later. Critical for the backfill window in Phase 5.

### Phase 4 — Endpoint: prefer table for historical dates

**Modify:** `api/opening-flow-signal.ts`

Decision rule for which path to use:

```ts
const today = getETDateStr(new Date());
const isLive = !requestedDate || requestedDate === today;
if (isLive) {
  // Today, possibly mid-window — live compute from raw trades.
  payload = await evaluateOpeningFlow(today);
} else {
  // Historical — read from the table. If the row is missing,
  // either the date is before this feature shipped, or the
  // capture cron didn't run. Fall back to live compute (may
  // return empty if ws_option_trades has aged out, which is
  // the documented limit).
  const row = await readOpeningFlowSnapshot(requestedDate);
  payload = row ?? (await evaluateOpeningFlow(requestedDate));
}
```

**Verify:** unit tests cover all 3 branches (today, historical
hit, historical miss).

### Phase 5 — Frontend: date picker + hook date param

**Files:**

- `src/hooks/useOpeningFlowSignal.ts` — accept optional
  `date?: string` arg, thread to URL query, key the localStorage
  cache by date (`openingFlowSignal.lastGood:${date}`) so
  selecting yesterday doesn't overwrite today's cache.
- `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx` — add
  a `<DateInput />` above the SignalCard grid. Reuses the existing
  `src/components/ui/DateInput.tsx` primitive. Restrict to past
  trading days via `max={getETToday()}`.
- Tests — extend `src/__tests__/OpeningFlowSignal.test.tsx`:
  picking a past date triggers a fetch with `?date=`; cache is
  keyed per-date; switching dates doesn't clobber the other date's
  cache.

### Phase 6 — Backfill: capture today's snapshot at deploy time

**Tactical, one-shot:** the capture cron only fills forward.
Tuesday morning when this ships, we'll have Monday's trades in
`ws_option_trades` (still inside the 2-day window). Run the
capture cron manually for `date=yesterday` so Monday's data lands
in the table before it ages out.

Optional one-off script: `scripts/backfill-opening-flow-signal.ts`
that takes a date range and runs the evaluator for each, upserting
into the table. Useful if we ever rebuild the table from raw
trades (won't be — they age out).

**No code change** beyond the optional script — just an
operational note to run the cron manually after deploy.

## Files index

**New:**
- `api/cron/capture-opening-flow-signal.ts`
- `api/__tests__/capture-opening-flow-signal.test.ts`
- Optional: `scripts/backfill-opening-flow-signal.ts`

**Modified:**
- `api/_lib/db-migrations.ts` (migration #173)
- `api/_lib/opening-flow.ts` (or new `opening-flow-evaluator.ts`)
- `api/opening-flow-signal.ts` (extract evaluator + add
  historical read branch)
- `vercel.json` + maybe `api/_lib/cron-schedules.ts` (new cron
  entry)
- `src/hooks/useOpeningFlowSignal.ts` (date arg)
- `src/components/OpeningFlowSignal/OpeningFlowSignal.tsx`
  (date picker)
- `src/__tests__/OpeningFlowSignal.test.tsx`
- `api/__tests__/db.test.ts` (migration count + mock sequence)

## Data dependencies

- **`opening_flow_signals` table** — created by migration #173.
- **`ws_option_trades`** — source for the capture cron. Available
  for the current day and yesterday only.
- **`CRON_SECRET`** — gate on the new cron handler.

## Thresholds / constants

- **Stop %** and **exit minutes** — both already constants in
  `api/_lib/opening-flow.ts` (`OPENING_FLOW_CONSTANTS`). Capture
  them per-row at evaluation time so historical reads use the
  rule that was in effect that morning (constants can change).
- **Cron schedule:** 08:50 CT daily, weekdays only. DST-aware via
  the existing `cron-schedules.ts` helpers.
- **Cache key:** `openingFlowSignal.lastGood:${date}` (was
  `openingFlowSignal.lastGood`).

## Open questions

1. **Holiday + early-close days:** the cron should still fire on
   early-close days (markets open, just close at 1 PM ET). On full
   holidays, the cron will run but produce an empty/before_open
   payload — fine, but it'll write a useless row. Default: write
   the row anyway (consistent shape); UI shows "Market closed" for
   those dates.
2. **Display of pre-feature-ship dates:** UI should make it
   visually obvious when a selected date predates this feature (no
   data, not "the day was empty"). Default: when the response
   shows `windowStatus='closed'` AND all ticker payloads are
   `null`, show a "Data not captured for this date" message
   instead of the empty grid.
3. **Backfill ergonomics:** do we want a one-shot `?backfill=true`
   query param on the cron handler (lets us POST a date range from
   the admin tool) or a separate `scripts/` file? Default:
   `scripts/` file — keeps the cron handler tight.
4. **JSONB vs columns:** I chose JSONB for slice1/slice2/signal
   because the shapes are deep and JSON-stringify is the natural
   read path. Open to flattening if you'd prefer SQL-queryable
   fields (e.g. `bias_side`, `bias_ratio`, `fired`, etc. as
   columns). Default: JSONB.

## Out of scope

- **Cross-date analytics** — "all days where signal fired on SPY
  but not QQQ" — not in this spec. Separate query API if we want.
- **Beyond-OFS panels** — DealerRegime, ZeroGamma, etc. also have
  per-date views via their own snapshots. This spec is OFS-only.
- **Schema-versioning per-row** — if the OFS rule itself changes
  (V5, V6), we'd need a `rule_version` column to know which rule
  produced each historical row. Default for now: assume rule
  doesn't change frequently; add the column when V5 actually
  ships.
- **Guest auth surface** — the existing endpoint is owner-or-guest;
  this spec inherits that auth, no changes.

## Done when

- All 6 phases shipped + tier checkpoint reviewer verdict `pass`
- Date picker on the OFS panel; picking any past date returns
  data (within capture window) or a clear "not captured" state
- The capture cron has run at least once on a real trading day
  + the row is visible via SQL
- Backfill for the prior day (the only one still in ws_option_trades)
  is complete
- Coverage floors held or improved
