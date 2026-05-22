# Vol Setup / Trigger Panel — 2026-05-21

## Goal

Build a single live intraday top-level section that surfaces the three
flow signals that fingerprinted today's 12:10 CT kickoff (and the 13:50
CT reversal) in real time:

1. **Vol Crush** — SPY 0DTE ATM IV grinding to session lows on a flat tape (the *setup*)
2. **Volume Burst** — 1-min trade count exceeding 3× the trailing 20-min average (the *trigger*)
3. **Delta Inflection** — rolling 30-min net customer delta on (SPY+QQQ+SPXW) flipping sign (the *confirmation*)

Stacked 3-row chart underneath, single time axis, minute granularity,
gated on `marketOpen`. Data sourced from the already-running `uw-stream`
WS daemon writing `ws_option_trades`.

## Why now

Today's post-mortem (see [docs/tmp/run-up-signal-hunt-2026-05-21-v2.log](../../tmp/run-up-signal-hunt-2026-05-21-v2.log))
shows the kickoff minute had n=26,716 trades vs ~3K trailing average,
+$2.36B net cust delta, on top of a 60-min IV crush from 0.209 → 0.196.
None of these are currently surfaced anywhere in the app. Building the
panel pays back immediately on the next vanna squeeze setup.

## Phases

Each phase is independently shippable. Phase 0 gates Phase 1.

### Phase 0 — Historical threshold tuning (~1 day)

> Per `feedback_tune_before_ship.md`: tune thresholds against historical data BEFORE locking the spec.

Re-run [docs/tmp/run-up-signal-hunt-2026-05-21-v2.py](../../tmp/run-up-signal-hunt-2026-05-21-v2.py)
against the last 30 trading days of EOD CSVs (Downloads/EOD-OptionFlow/*.csv
or the equivalent archive). For each day, label run-ups (e.g., 30-min SPY advance ≥ 0.4%)
and reversals. Measure precision/recall of each candidate threshold:

| Signal           | Candidate                                       | Vary                                          |
| ---------------- | ----------------------------------------------- | --------------------------------------------- |
| Volume Burst     | 1-min trades > k × trailing-20m avg             | k ∈ {2, 2.5, **3**, 4, 5}                     |
| Vol Crush        | ATM IV drop ≥ p% in 30 min AND range < r%       | p ∈ {3,4,5,7,10}, r ∈ {0.1,0.15,0.2}          |
| Delta Inflection | 30-min cum cust delta crosses 0 AND \|Δ\| > $X  | X ∈ {$200M, $500M, $1B}                       |

**Output**: a JSON file at `docs/tmp/vol-setup-tuning-2026-05-21.json` with
{threshold, precision, recall, alerts_per_session} per parameter combo,
and the locked values for Phase 1.

Lock criterion: ≤ 3 fires/session on average, recall ≥ 0.6 on labeled run-ups.

### Phase 1 — Minute-bar aggregator (~5 files, ~3 hours)

Backend pipeline reading `ws_option_trades` → minute bars → API.

**Files**:

- `api/_lib/db-migrations.ts` — add migration #N for `vol_setup_bars_1m` (DDL below)
- `api/cron/build-vol-setup-bars.ts` — runs every minute during RTH, reads last 5 min of `ws_option_trades`, computes signed delta + IV + counts, UPSERTs bars
- `vercel.json` — register cron `* 13-21 * * 1-5` (every minute, RTH UTC, Mon-Fri)
- `api/vol-setup-panel.ts` — GET endpoint returning the day's bars + computed signal states
- `api/__tests__/build-vol-setup-bars.test.ts` — mock `ws_option_trades` rows for kickoff window, assert bar values + signal flags

**Migration DDL (inline, source of truth)**:

```sql
CREATE TABLE IF NOT EXISTS vol_setup_bars_1m (
  bucket_utc          TIMESTAMPTZ PRIMARY KEY,
  spy_spot            NUMERIC(12,4),
  qqq_spot            NUMERIC(12,4),
  spxw_spot           NUMERIC(12,4),
  spy_atm_iv_call     NUMERIC(10,6),   -- median IV, delta in [0.35, 0.65]
  spy_atm_iv_put      NUMERIC(10,6),   -- median IV, delta in [-0.65, -0.35]
  net_cust_delta_d    NUMERIC(18,2),   -- $ delta, SPY+QQQ+SPXW 0DTE combined
  trade_count         INTEGER,          -- 0DTE trade count, same tickers
  spy_ask_call_prem   NUMERIC(18,2),
  spy_ask_put_prem    NUMERIC(18,2),
  computed_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vol_setup_bars_1m_bucket_idx
  ON vol_setup_bars_1m (bucket_utc DESC);
```

Tickers filter: `WHERE ticker IN ('SPY','QQQ','SPXW') AND expiry = current_date::date`.
Customer delta sign: `(side='ask' ? +1 : side='bid' ? -1 : 0) * delta * size * 100 * underlying_price`.

Wrap handler with `withCronInstrumentation('build-vol-setup-bars', ...)`
per repo convention. Idempotent via PRIMARY KEY conflict → DO UPDATE.

### Phase 1.5 — Historical backfill from parquet archive (~3 files, ~2 hours)

> Powered by the 96-day full-tape parquet archive at `~/Desktop/Eod-Full-Tape-parquet/{YYYY-MM-DD}-fulltape.parquet`. Local-only invocation — parquets live on user's Desktop, not on Vercel/Railway. Output goes to Neon via `DATABASE_URL` in `.env.local`.

**Files**:

- `scripts/backfill-vol-setup-bars.py` — Python (needs pyarrow). Iterates trading days, reads each parquet, filters SPY/QQQ/SPXW + `expiry == date`, aggregates to 1-min bars, UPSERTs into `vol_setup_bars_1m`. Idempotent via `ON CONFLICT (bucket_utc) DO UPDATE`. Follows the date-iteration + per-day logging pattern from `scripts/backfill-etf-tide.mjs` (but Python because of the parquet source).
- `scripts/replay-vol-setup-fires.py` — separate pass: reads `vol_setup_bars_1m` for a date range, evaluates the three signals against the locked thresholds from Phase 0, writes detected fires to `vol_setup_fires`. Idempotent via `ON CONFLICT (bucket_utc, signal_type) DO UPDATE`. Re-runnable when thresholds change.
- `api/_lib/db-migrations.ts` — add migration #N+1 for `vol_setup_fires` (DDL below). Promoted from Phase 4 to Phase 1.5 because backfill needs to write to it.

**Invocation**:

```bash
# Backfill bars for the last 30 trading days
ml/.venv/bin/python scripts/backfill-vol-setup-bars.py --days 30

# Or explicit date range
ml/.venv/bin/python scripts/backfill-vol-setup-bars.py --from 2026-01-02 --to 2026-05-20

# Re-run fires after threshold change (does not touch bars)
ml/.venv/bin/python scripts/replay-vol-setup-fires.py --from 2026-01-02 --to 2026-05-20
```

**Migration DDL for `vol_setup_fires`** (promoted from Phase 4):

```sql
CREATE TABLE IF NOT EXISTS vol_setup_fires (
  bucket_utc      TIMESTAMPTZ NOT NULL,
  signal_type     TEXT NOT NULL,        -- 'vol_crush' | 'volume_burst' | 'delta_inflection'
  state           TEXT NOT NULL,        -- 'armed' | 'fired'
  magnitude       NUMERIC(18,4),         -- signal-specific (e.g., IV drop %, burst ratio, |cum delta|)
  spy_spot        NUMERIC(12,4),
  spy_atm_iv      NUMERIC(10,6),
  net_cust_delta_d NUMERIC(18,2),
  threshold_set_id TEXT NOT NULL,       -- e.g., 'phase0-2026-05-22' — lets us re-tune without losing history
  computed_at     TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (bucket_utc, signal_type, threshold_set_id)
);

CREATE INDEX IF NOT EXISTS vol_setup_fires_bucket_idx
  ON vol_setup_fires (bucket_utc DESC);
CREATE INDEX IF NOT EXISTS vol_setup_fires_type_state_idx
  ON vol_setup_fires (signal_type, state, bucket_utc DESC);
```

The `threshold_set_id` column means re-tuning thresholds in Phase 4 does not invalidate the historical fire record — you keep both and can compare. The frontend always reads the latest set.

**Endpoint extension**: `GET /api/vol-setup-panel/dates` returns the list of dates that have rows in `vol_setup_bars_1m`. Powers the date picker's available-dates datalist.

### Phase 2 — Frontend panel (~5 files, ~3 hours)

**Files**:

- `src/hooks/useVolSetupBars.ts` — polls `/api/vol-setup-panel`, 30s cadence during RTH, gated on `marketOpen && date === todayCt()`. Mirrors `useNetFlowHistory.ts` exactly: `historical = date !== todayCt()` → single fetch, no polling. Accepts `{ date, from, to }`.
- `src/hooks/useVolSetupDates.ts` — fetches `/api/vol-setup-panel/dates` once on mount to populate the date picker's available dates.
- `src/components/VolSetupSection/VolSetupPanel.tsx` — `lightweight-charts` v5 instance with three rows; copies pane setup from `src/components/charts/TickerNetFlowChart.tsx`. Renders fires as price-line markers on the relevant pane.
- `src/components/VolSetupSection/VolSetupControls.tsx` — date + time-range picker bar at the top of the section. Uses existing `<DateInput>` from `src/components/ui/DateInput.tsx` with `list` populated from `useVolSetupDates`. Time-range uses two `<input type="time">` controls bound to CT. Adds prev/next-day buttons via existing `useScrubController` for keyboard-friendly day navigation.
- `src/components/VolSetupSection/VolSetupSignalCards.tsx` — 3 status cards above the chart (Vol Crush, Volume Burst, Delta Inflection). For historical mode, cards show "X fires today" summary; for live mode, current IDLE/ARMED/FIRED state.
- `src/App.tsx` — render `<VolSetupSection>` above the calculator (new top-level section)

Wrap in existing `<SectionBox label="Vol Setup / Trigger" badge="0DTE" defaultCollapsed={false}>`. Show a `HIST` badge in `badgeColor='amber'` when `date !== todayCt()` so it's obvious the panel is not live.

**UI shape (ASCII mock)**:

```text
┌─ VOL SETUP / TRIGGER ─────────────────────────── 0DTE ─┐
│ ┌─ Vol Crush ──┐ ┌─ Vol Burst ──┐ ┌─ Δ Inflection ─┐   │
│ │   ARMED      │ │    IDLE      │ │     IDLE       │   │
│ │ IV −6.2%/30m │ │  1.2× trail  │ │  −$120M cum    │   │
│ └──────────────┘ └──────────────┘ └────────────────┘   │
│                                                        │
│  SPY ────╮                ╭─────                       │
│       ╮  ╰╮╮      ╭───────╯                            │
│ ────────────────────────────────────                   │
│  ATM IV ─╮                                             │
│           ╰──╮───────╭──                               │
│ ────────────────────────────────────                   │
│  net cust Δ ($M)               █ ← burst               │
│        ▍   ▌▍       ▎ ▋                                │
│ ──────┼──────────────────────────                      │
│       ▌ ▌    ▎  ▌ ▍                                    │
└────────────────────────────────────────────────────────┘
```

Top pane: SPY spot line (left axis). Middle pane: SPY ATM IV call line +
session-low horizontal marker. Bottom pane: BaselineSeries (signed
net-delta bars, green positive / red negative) + LineSeries overlay
showing trade-count ratio with markers when burst threshold is crossed.

### Phase 3 — Alerts (~2 files, ~1 hour)

- `src/utils/vol-setup-alerts.ts` — pure functions evaluating each signal state from latest bar; classified IDLE / ARMED / FIRED
- Wire to existing toast/sound infrastructure (find via grep `playAudio` / `useToast`)
- Audio fires once per FIRED transition (not on each poll while still FIRED)

### Phase 4 — Soak + post-soak tune (~30 days passive)

Capture every FIRED event in a new `vol_setup_fires` table. After 30
trading days, replay against intraday OHLC: was there a ≥0.3% SPY move
in the next 30 min? Re-tune thresholds if precision < 0.55. Spec the
follow-up at that point.

## Data dependencies

| Source                              | Kind                            | Status                                          |
| ----------------------------------- | ------------------------------- | ----------------------------------------------- |
| `ws_option_trades`                  | Existing table, migration #109  | Live, contains SPY/QQQ/SPXW 0DTE ticks          |
| `uw-stream` Lottery universe        | `uw-stream/src/config.py` 39-40 | Already subscribes to SPY/QQQ/SPXW option_trades|
| `~/Desktop/Eod-Full-Tape-parquet/`  | 96-day parquet archive          | Local-only; powers Phase 1.5 backfill           |
| `vol_setup_bars_1m`                 | New table                       | Phase 1                                         |
| `vol_setup_fires`                   | New table                       | Phase 1.5 (promoted from Phase 4)               |
| UW WS feed                          | `UW_API_KEY` (Advanced tier)    | Already configured on Railway                   |

No new env vars. No new external API.

## Open questions

1. **Index breadth.** Stick to SPY+QQQ+SPXW, or pool IWM as a 4th leg? Decision default: **SPY+QQQ+SPXW only**. IWM tape behaves differently and would dilute signal. Revisit Phase 4.
2. **ATM IV ticker.** SPY only, or median across SPY+QQQ+SPXW? Default: **SPY only**. SPXW IV has wider strike grid (5pt) but lower volume per strike → noisier minute medians.
3. **0DTE filter on Mondays/Wednesdays.** SPY and QQQ have M/W/F expiries; SPXW has daily. The `expiry = current_date` filter handles this automatically — no special-case needed.
4. **Alert mode**. Visual-only (toast + badge) vs visual + audio. Default: **visual + soft audio for FIRED transitions only**, no sound for ARMED.
5. **Backfill.** Should the cron also backfill the last hour on cold start? Default: **no**. Polling at 30s + 5-min computation window self-heals within 5 minutes.

## Thresholds (locked 2026-05-21 from Phase 0 sweep)

Phase 0 swept the candidate thresholds against the full 96-day UW
full-tape archive (37,440 bars, 417 labeled run-up starts, 1.11% base
rate). Full results in [docs/tmp/vol-setup-tuning-2026-05-21.json](../../tmp/vol-setup-tuning-2026-05-21.json).

**Honest finding**: no single signal hit the original lock criterion of
precision ≥ 0.5 AND ≤ 3 fires/session. The best train→test precision
across the three signals is 5–20% — real edge over the 1.1% base rate
(5–18× lift), but not alert-grade. The panel ships as a **visual /
descriptive** tool with a single low-frequency audio alert; not as a
loud signal generator.

**Locked thresholds for Phase 1**:

```typescript
export const VOL_SETUP_THRESHOLDS = {
  // Volume Burst — only audio-armed signal. Train prec 17.9% @ 1.0
  // fires/session. Treat each fire as "something is happening RIGHT
  // NOW" — bet direction confirmed by spot + delta-bar polarity, not
  // by this signal alone.
  VOLUME_BURST_MULTIPLIER: 4.0,        // 1-min count > 4 × trailing-20m

  // Vol Crush — visual chart marker only, NO audio. Any threshold
  // fires 15–80× per session at 5–8% precision. The signal is
  // descriptive of regime, not predictive of any specific minute.
  VOL_CRUSH_IV_DROP_PCT: 5.0,           // ATM IV down ≥ 5% relative in 30m
  VOL_CRUSH_RANGE_MAX_PCT: 0.20,        // AND SPY 30-min range < 0.20%
                                         // (loosened from 0.15 to surface more setups)

  // Delta Inflection — visual chart marker only. Use the $1B threshold
  // for the panel; below that fires too often to read.
  DELTA_INFLECTION_MIN_ABS_D: 1_000_000_000, // 30-min cum delta crosses 0 with |cum| ≥ $1B
  DELTA_INFLECTION_PRIOR_MIN_DURATION_MIN: 20, // prior sign sustained ≥ 20m
} as const;
```

These live in `api/_lib/constants.ts` and are imported by both the cron
and the frontend hook so the panel and the alerts use identical math.

**Implication for Phase 3 alerts**: only Volume Burst fires audio. Vol
Crush and Delta Inflection render as on-chart markers (color-coded
bands or dots) but do not page. Spec the COMPOSITE signal experiment in
Phase 4: "Volume Burst armed AND Vol Crush armed within prior 30 min"
is the high-precision combo from today's tape; back-test it after the
30-day soak.

## Success criteria

Phase 1 done when:

- [ ] `build-vol-setup-bars` cron runs every minute during RTH and writes a row per minute with no gaps
- [ ] `vol_setup_bars_1m` for 2026-05-21 (backfilled) reproduces the 12:10 bucket: trade_count > 25K, net_cust_delta_d > $2B
- [ ] `api/vol-setup-panel` returns the day's bars in < 500ms

Phase 1.5 done when:

- [ ] `scripts/backfill-vol-setup-bars.py --days 30` populates 30 days of bars from the parquet archive
- [ ] `scripts/replay-vol-setup-fires.py --from 2026-01-02 --to 2026-05-21` populates `vol_setup_fires` with the locked Phase 0 threshold set
- [ ] Re-running either script is a no-op (idempotency confirmed)

Phase 2 done when:

- [ ] Panel renders all three rows under SectionBox on `marketOpen=true`
- [ ] Date + time-range picker switches between live and historical mode; `HIST` badge appears on historical dates
- [ ] Manual back-paint of 2026-05-21 data via `?date=2026-05-21` shows the kickoff visible at 12:10 and the reversal at 13:50
- [ ] Prev/next-day buttons step through available dates from `useVolSetupDates`
- [ ] `npm run review` green

Phase 3 done when:

- [ ] Replaying 2026-05-21 bars triggers Volume Burst FIRED at 12:10 CT and 13:50 CT (sanity)
- [ ] Replaying triggers Vol Crush ARMED at ~11:30 CT and ARMED again at ~13:20 CT
- [ ] No alert spam: < 5 distinct FIRED events for the whole 2026-05-21 session

Phase 4 done when:

- [ ] 30 trading days of `vol_setup_fires` captured in production (live, not backfilled)
- [ ] Precision report written; thresholds confirmed or revised

## Notes

- All polling gates on `marketOpen` per `useMarketData.ts` pattern. After-hours the panel renders the last completed RTH session.
- ATM IV computation uses median across trades with `|delta| ∈ [0.35, 0.65]` to dampen single-strike outliers (matches the Phase 2 analysis script).
- Volume burst is computed at read time in the endpoint, not stored — the bar table stores raw counts and the rolling trailing average is computed in SQL via window function `AVG(trade_count) OVER (ORDER BY bucket_utc ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING)`. Keeps the table compact and lets the threshold be tuned without rewriting historical rows.
- Panel does NOT replace Periscope — Periscope shows dealer hedge regime, this shows the trigger window. Complementary.
