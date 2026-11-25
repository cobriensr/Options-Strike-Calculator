# Interval B/A: right sweep flags, SPXW spot from the tape, and the gaps rebuilt from the tape

Status: design, waiting for the owner's approval. Written 2026-11-24. It was revised the same day after two spec reviews and the owner's later decisions (sections 3 and 14). All three questions in section 10 are decided.

Evidence: three read-only investigator reports in `docs/tmp/interval-ba-rebuild-2026-11-24/`:

- `detector-spec.md`: the live detector, step by step, and a DuckDB replay that matched live on 1,053 of 1,053 rows.
- `tape-facts.md`: the R2 Full Tape across all 225 days.
- `nightly-db-facts.md`: the nightly job, the table, its readers, monitoring and backup precedents.

Earlier work: `docs/tmp/interval-ba-data-gaps-2026-11-21.md`.

Section numbers like "spec §2.1" point into `detector-spec.md`.

## 1. Intent

The `interval_ba_alerts` table has three data bugs and three kinds of hole. The bugs:

- **The live sweep flag is never set.** The handler reads `tags`, but UW sends `report_flags`.
- **The live floor flag is never set either.**
- **Every live SPXW row has no spot price.** UW sends `""` for index options. That leaves the feed's ITM/OTM filter and the outcome study blind on SPXW.

The holes and the old rows:

- **Jan 2 to May 11 holds no live rows.** What is there comes from an old backfill script. That script had:
  - a 70% ratio for SPXW (3,700 of 12,077 rows sit between 70% and 75%);
  - no multi-leg gate;
  - canceled prints dropped;
  - a symmetric confluence tag.
- **May 12 and the morning of May 13 have no rows.** The live handler was not yet switched on.
- **Jul 22 (from 14:52Z) to Sep 4 has no rows.** uw-stream was dark.
- **Live misses alerts now and then.** It missed 2 keys in 13 sessions since 10-29, and on 05-20 it wrote 74 where the tape shows 108.

The owner wants three things:

- the live alerts kept exactly as they fired, with only the two broken columns corrected;
- the stretches where nothing was live filled from the tape with today's rule;
- one definition across the whole year available for studies, without overwriting the real record to get it.

## 2. Goals, non-goals, anti-goals

### Goals

1. **Fix the live flags.** The live handler sets sweep and floor from `report_flags`, from the day it deploys.
2. **Correct the two broken columns on every live row, May 13 on.**
   - The sweep and floor flags come from the tape.
   - SPXW `underlying_price` is filled where it is blank.
   - Nothing else on a live row changes.
3. **Replace the old backfill (Jan 2 to May 11)** with today's detector, for all three tickers.
4. **Fill the stretches with no live rows from the tape,** with today's rule: May 12, May 13 before the first live row, and Jul 22 after the last live row through Sep 4.
5. **Keep it fixed every night.** After the tape lands, the nightly job corrects the new session's live rows the same way, and adds the alerts live missed (Q2).
6. **Catch an outage within a day.** The nightly job alerts when live wrote far fewer alerts than the tape shows. The Jul to Sep outage ran 6 weeks before anyone noticed.
7. **One rule for studies.** A full-year replay with today's rule is written to R2 as its own file, separate from the table.

### Non-goals

- **No change to the alert rule.**
- **No change to which alerts push.**
- **No API field for `source`, and no "replayed" badge.** That could come later.
- **No rerun of the confluence study.**
- **No TypeScript port of the detector** (see Q1).

### Anti-goals (this fails even if the code works)

- **A live row deleted, or any live column changed** other than `top_trade_is_sweep`, `top_trade_is_floor`, and a blank SPXW `underlying_price`. Its real `fired_at`, values, confluence tags and acknowledgement all stay.
- **A push, chime or browser notification** for a rebuilt or tape-added row.
- **Tape rows added inside a session that live ran under a different rule.** For the May 13 to Oct 28 live days, nothing is added.
- **A production write without:**
  - the owner's go;
  - a backup that was read back, with a copy in R2;
  - a dry run whose exact write set the apply re-checks;
  - one or two rows per raw source recomputed by hand.
- **Tape rows the live handler would not have fired** in the nightly job, because of a different rule or a ticker switched off (6.1b, 6.4).

## 3. What the owner decided (2026-11-24)

- **Start the fixes**: the flags, the SPXW spot, and the history work.
- **Rebuild January with today's detector** ("yeah lets rebuild january").
- **SPXW spot, option A.** The nightly job fills the exact spot from the tape the next morning. Same-day rows keep the read-time 1-min candle fallback the API already does.
- **"lets not overwrite real writes."** No live row is deleted or recomputed, and real fire times stay. This replaces the earlier "A is fine", which would have replaced the May 13 to Oct 28 live rows with a replay.
- **"both"**: on live rows, fill the blank SPXW price and fix the sweep flag. My question named the sweep flag; floor is the same bug in the same code, so it is corrected the same way, per Q3.
- **All three tickers; back up first.** This was my playback, and the owner did not object.

## 4. Facts the design rests on

Detail and evidence are in the reports.

- **Replay accuracy.** A DuckDB replay of the Full Tape with today's rules reproduces live exactly on 11-16 to 11-20 and 11-23: 1,053 of 1,053 keys, and every numeric column (spec §5.1).
  - Over the 13 sessions it replayed since 10-29, 0.5% of rows differ in value and 2 keys differ, all from ticks the live socket missed before the mirror sockets (11-13/14). The worst session is 11-11: 4 of 119 rows (3.4%).
  - It cannot reproduce `fired_at`, which is wall clock (p50 0.1 s after the tick, up to 500 s in a backlog).
- **The live rule was not always today's rule.** Live ran 8 multi-leg codes, including `mfto` and without `cbmo` or `mctp`, from 05-13 until the 10-28 change (spec §1.7). So a today's-rule replay of a May to Oct day differs from what live sent. On 10-22, for example, 110 of 114 keys are in common.
- **Canceled prints.** The live handler counts them. The replay must too.
- **The tape covers the whole range.** It has 225 days, 2026-01-02 to 2026-11-23, with no gaps (tape-facts §1).
- **The tape changes layout on 2026-05-04** (tape-facts §2).
  - Before: `executed_at` is a naive `TIMESTAMP` holding UTC, numerics are `DECIMAL`, and `tags` and `report_flags` are bare comma strings.
  - After: `TIMESTAMPTZ`, `DOUBLE`, and brace-wrapped strings.
  - Use `epoch(executed_at)` for dates: `AT TIME ZONE` on the naive column misdates 48% of a day's rows.
  - Fetching a `TIMESTAMPTZ` into Python with `fetchall()` needs `pytz`, which the nightly image lacks. `epoch_us(executed_at)` gives the same integer on both layouts.
- **Tape spot.** SPY and QQQ have a spot on every row. SPXW lacks one only in the first 0.3 to 7 s after the open, on 29 days (tape-facts §3.1).
- **Where the flags live.** `intermarket_sweep` and `futures_floor` are in `report_flags` only, on the websocket and in the tape.
- **What `futures_floor` marks.** It is 93% multi-leg codes, so it is not a floor-broker marker. That is question Q3.
- **Table structure.**
  - The key is `UNIQUE (option_chain, bucket_start)`.
  - There are no FKs, triggers or views, and the table is not in the weekly backup cron.
  - The 17,893 old backfill rows (ids 1 to 18,207) hold no acknowledgements; live rows hold 965 (nightly-db-facts §2).
  - Neon's history window is 7 days.
- **Live day edges.**
  - The first live row is 2026-05-13 15:55:37Z.
  - 2026-07-22 has 11 live rows, the last at 14:52:46Z.
  - Live resumes 2026-09-08. 09-07 is a holiday; 09-04 is the last outage day.
- **Pushes and the poll.** A plain INSERT sends no push. But the app's cursor poll (`api/interval-ba-alerts.ts:223`, `fired_at > since`) has no date or ack filter, and the hook's cursor survives the market-hours gate (`useIntervalBAAlerts.ts:228, 274-275, 332`). So an inserted row with a later `fired_at` than a tab's cursor would ring at the next open. Section 6.7 fixes this first.
- **Settings the nightly job cannot read.** The live detector's settings are env values on Railway (`uw-stream/src/config.py:227-250`):
  - the ratio, floor, window and share;
  - the enabled switch and the ticker list.

  The codes and the confluence window are constants in `uw-stream/src/handlers/interval_ba.py` (`:119-131`, `:109`).

## 5. Approaches

### 5.1 How the old backfill is replaced (Jan 2 to May 11)

- **Delete and insert, per day (chosen, my call).** For each day:
  - delete the day's `source = 'replay'` rows;
  - insert the day's tape alerts;
  - all in one transaction.
- **Why this is safe.** Those rows hold no acknowledgements, no live writes and nothing that references their ids, except the old outcome CSVs, which are regenerated anyway.
- **Rejected:** reconcile-by-key, which would keep ids. It only mattered while May to Oct live rows were to be replaced.

### 5.2 How live rows are corrected

The live rows from May 13 on take UPDATEs of the two flags and a blank SPXW spot only. Everything about which rows exist, and their other values, stays as live wrote it (owner, section 3).

### 5.3 Which rule fills the stretches with no live rows

- **Today's rule (chosen, my call).** It is one code path, the same rule as the rebuilt January to May rows, and the rule a study would want.
- **The rule live ran then** (8 codes) would make the outage look like the live days around it. It needs a second rule in the detector and gains little.

Either way, the rows are marked `source = 'replay'`.

### 5.4 What the nightly job does each morning

- **N1.** Correct flags and spot on the new session's live rows. Alert when live wrote far fewer alerts than the tape.
- **N2 (recommended).** N1, plus **insert the alerts the live feed missed** as `source = 'replay'`. That covers only tickers live had on, under settings equal to the replay's rule (6.4).
  - An outage then both alerts and repairs itself the next morning, as the owner's "automate, don't operate" and "always backfill" rules ask.
  - This is Q2. Everything else is needed for the alert and the spot anyway.

## 6. Design

### 6.1 uw-stream: sweep and floor from `report_flags`

`uw-stream/src/handlers/interval_ba.py`:

- **Read the flags.** At `:332`, also read `report_flags = payload.get("report_flags")`. It is a JSON list on the websocket.
- **Set the flags by membership, never equality.** A list can hold two values.
  - `is_sweep = "intermarket_sweep" in report_flags`.
  - `is_floor = "futures_floor" in report_flags` (Q3, decided).
- **Helper.** Replace `_has_tag` (`:695-697`) with `_has_flag(flags, name)`, and delete whatever is left unused.

The tests that change are listed in spec §3.3:

- `test_interval_ba.py:156`;
- `:763-786`;
- `:1289-1301`;
- the payloads at `:1176, 1620, 1676`;
- the `_payload()` helper at `:78-107`, which needs a `report_flags` parameter;
- the fixture `uw-stream/tests/fixtures/interval_ba_sample.json`, where the marker moves to `"report_flags": ["intermarket_sweep"]`.

New tests:

- a real-shape frame (`report_flags: ["intermarket_sweep"]`, `tags` without it) sets sweep true;
- a `sweep` tag with empty `report_flags` sets it false;
- a two-value list sets both.

### 6.1b uw-stream records its detector settings at start

Once per process start, uw-stream writes one row to `interval_ba_live_settings` (6.2) through its asyncpg pool, with `ON CONFLICT DO NOTHING`.

- **Where.** In the code that builds the three Interval B/A handlers. They are registered at `channel_registry.py:156-158`; the builder finds the construction site.
- **What the row holds.** The effective values the handlers will use:
  - `enabled`, from `INTERVAL_BA_ENABLED`;
  - `tickers`: the sorted intersection of `INTERVAL_BA_TICKERS_CSV` and the tickers whose `option_trades:<T>` channel is in `WS_CHANNELS`. A handler exists only for a subscribed channel (`main._build_handlers`), so dropping a channel switches that ticker off too;
  - the ratio, the premium floor, the window and the multi-leg share;
  - the sorted multi-leg codes and the confluence window.
- **A Railway variable change is covered.** Railway redeploys the service on a variable change, so every change of settings starts a new process and writes a new row.
- **A failed write never stops the detector.** The first failure in a process is sent to Sentry once; the write is retried quietly on later flushes.
  - While it keeps failing, the nightly job covers the day with the previous process's row, which may hold other settings. The Sentry event is what flags that gap.
  - Only when no earlier row exists does the nightly find no record and hold its inserts.
- **`booted_at` is a safe conflict key (R6).** It is set once per process at import, so it stays the same across every retry. It is not a fresh `now()` per attempt.

### 6.2 Migration (one id, the next free one)

Before applying it, check other sessions' unapplied migrations. Apply with `scripts/migrate-db.ts`. The statements:

```sql
ALTER TABLE interval_ba_alerts ADD COLUMN source TEXT NOT NULL DEFAULT 'live';
ALTER TABLE interval_ba_alerts ADD CONSTRAINT interval_ba_alerts_source_check
  CHECK (source IN ('live', 'replay'));
UPDATE interval_ba_alerts SET source = 'replay' WHERE expiry < DATE '2026-05-13';

CREATE TABLE interval_ba_live_settings (
  booted_at             TIMESTAMPTZ PRIMARY KEY,
  enabled               BOOLEAN NOT NULL,
  tickers               TEXT[] NOT NULL,
  ratio_threshold       NUMERIC(6,4) NOT NULL,
  premium_floor         NUMERIC(14,2) NOT NULL,
  window_sec            INTEGER NOT NULL,
  multi_leg_share_max   NUMERIC(6,4) NOT NULL,
  multi_leg_codes       TEXT[] NOT NULL,
  confluence_window_sec INTEGER NOT NULL
);

CREATE TABLE interval_ba_tape_days (
  day              DATE PRIMARY KEY,
  done_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  tape_alerts      INTEGER NOT NULL,   -- counts are over the tickers live had on
  live_rows        INTEGER NOT NULL,
  live_missed      INTEGER NOT NULL,   -- tape keys with no live row
  live_only        INTEGER NOT NULL,   -- live keys the tape does not fire
  value_mismatched INTEGER NOT NULL,   -- same key, a detector column differs (diagnostic)
  inserted         INTEGER NOT NULL,
  inserts_held     TEXT,               -- NULL, or why the inserts were held (6.4)
  removed          INTEGER NOT NULL,   -- stale replay rows deleted on a re-landed tape
  flags_changed    INTEGER NOT NULL,
  flags_unmatched  INTEGER NOT NULL,
  spot_filled      INTEGER NOT NULL
);
```

- **`source` means:**
  - `live`: written by uw-stream, so `fired_at` is wall clock at detection.
  - `replay`: written from the tape, so `fired_at` is the crossing tick's time.
- **Why the `UPDATE`.** The 17,893 rows before 05-13 are an old tape replay, so they are marked `replay` at once. uw-stream's alert INSERT needs no change: the default covers it.
- **`interval_ba_live_settings`** is written only by 6.1b.
- **`interval_ba_tape_days`** is the nightly job's "done" marker and a durable per-day health record.
- **The api tests.** Update `db.test.ts` per CLAUDE.md "DB Migrations". Use the next free id: the highest was 211 on 2026-11-24, and another session may add more.

No endpoint reads any of the three.

### 6.3 The shared replay module: `nightly/src/interval_ba_replay.py`

- **Purpose.** One implementation of the detector, used by the nightly step and by the one-off tool.
- **Imports.** Only `duckdb`, `psycopg2` and the standard library. Both `nightly/requirements.txt` and `ml/requirements.txt` carry those, at DuckDB 1.5.x.
- **Input.** It takes a DuckDB connection and a tape location: a local file in the nightly job, an `s3://` URL on the workstation.
- **What it never does.** It never opens R2 or Neon itself, and never sets DuckDB limits. The caller sets `memory_limit`, `threads` and `temp_directory`.
- **Times leave DuckDB as integers.** It reads every time as `epoch_us(...)` and builds aware UTC `datetime`s in Python. It never fetches a `TIMESTAMP` or `TIMESTAMPTZ` column directly.

#### Rules: today's detector, exactly (spec §1, §2)

The ticks:

| Rule | Value |
|---|---|
| Contracts | Scan with `underlying_symbol IN ('SPXW','SPY','QQQ','SPX')`, so the filter pushes down to the file. `SPX` is in the list because the websocket labels SPXW prints `SPX`, and only two tape days were checked. Then keep a row only when its OCC root, `left(option_chain_id, length(option_chain_id) - 15)`, is one of `SPXW`, `SPY` or `QQQ`; the root is the truth, as in the live handler, and SPX-root rows are dropped. Never use DuckDB's `[:-15]` slice, which is end-inclusive. Every replay counts the kept rows whose `underlying_symbol` differs from their root (`root_label_mismatch`) and reports it; it does not stop on it. |
| Rows kept | `price > 0` and `size > 0` |
| Canceled rows | kept, and counted like any other tick |
| Hours | no time-of-day filter |
| 0DTE | `expiry = CAST(to_timestamp(epoch(executed_at)) AT TIME ZONE 'America/Chicago' AS DATE)`. This works on both tape layouts under any session time zone. A unit test runs it in the nightly suite, which installs the same DuckDB wheel as the image. |
| Order | `executed_at`, then the file's row order (`read_parquet(..., file_row_number = true)`) |

- **The order is my call.** `executed_at, id` and `executed_at, created_at` gave identical output. File order is just as deterministic and halves the bytes read. §8.2 confirms it.

Each tick:

| Field | Rule |
|---|---|
| Bucket | `floor(epoch(executed_at) / 300) * 300`, per contract |
| Premium, in cents | `round(CAST(price AS DOUBLE) * 10000) * size` |
| Ask | the first side token in `tags` is `ask_side`; this works on both layouts |
| Multi-leg | `lower(upstream_condition_detail)` is one of `mlat, mlet, mlft, masl, mesl, mfsl, mlct, cbmo, mctp` |

- **The fire.** The first tick, in order, after which, over the bucket's ticks so far, all three of these hold:
  - `total ≥ 25,000,000` cents ($250,000);
  - `4 × ask ≥ 3 × total` (75%);
  - `2 × multi_leg < total`.
- **After the fire,** the bucket is frozen: later ticks are ignored.

The row, taken at the crossing tick:

| Column | Rule |
|---|---|
| `option_chain`, `ticker` | the OCC string, and its root (`SPXW`, `SPY`, `QQQ`) |
| `ask_premium`, `total_premium`, `trade_count` | sums and the count up to and including the crossing tick |
| `ratio_pct` | `ask / total × 100`, rounded half-even to 2 decimals (Python `Decimal`) |
| top trade | the largest-premium ask tick up to the crossing tick; the earliest wins a tie |
| `top_trade_premium`, `top_trade_size` | from the top trade |
| `top_trade_executed_at` | the top trade's time, truncated to the millisecond |
| `fired_at` | the crossing tick's `executed_at`, truncated to the millisecond |
| `bucket_start`, `bucket_end` | the bucket, and the bucket + 300 s |
| `option_type`, `strike`, `expiry` | from the OCC string |
| `underlying_price` | the crossing tick's own spot, `Decimal(str(x))` rounded half-up to 2 decimals |
| `top_trade_is_sweep` | the top trade's `report_flags` contains `intermarket_sweep` |
| `top_trade_is_floor` | the top trade's `report_flags` contains `futures_floor` (Q3, decided) |
| `confluence_tickers` | below |
| `source` | `'replay'` |
| `acknowledged` | false |

- **SPXW spot in the opening seconds.** If an SPXW crossing tick has no spot, the module takes the first print with a spot after it, among the SPXW rows the scan kept. That is 0.3 to 7 s later on the 29 gap days. My call.
- **Confluence is the live rule** (spec §4.3):
  - Sort the tape fires being written, all three tickers, by `fired_at`.
  - A fire's tags are the other tickers with a same-`option_type` fire at `fired_at − 90 s ≤ t ≤ fired_at`: backward only, inclusive at both ends.
  - Sorted, with `[]` when there are none.
  - Live rows' tags are never changed, and live rows are not used as partners for tape rows. My call: live tags were built on live's own clock.

It exposes three functions:

- `replay_day(con, tape, day) -> list[TapeAlert]`;
- `top_trade_flags(con, tape, day, rows) -> dict[id, (sweep, floor) | None]`;
- `live_spot(con, tape, day, rows) -> dict[id, Decimal | None]`.

The two helpers work on live rows, for any day, under any rule live ran:

- **Flags.** The ask prints on the row's contract whose millisecond time, size and premium equal the row's top trade.
  - One or more matches that all agree give the flags.
  - Zero matches, or matches that disagree, give `None`. That leaves the row's flags as they are, counted as `flags_unmatched`.
- **SPXW spot, rule-free.** Take the row's bucket: its contract's 0DTE ticks in tape order, canceled ones included. The crossing tick is tick number `trade_count`: the tick where live fired, whenever live saw every tick.
  - Its spot, with the same opening-seconds forward fill.
  - If the bucket has fewer ticks than `trade_count`, the last SPXW print with a spot at or before the row's `fired_at` instead.
  - This needs no replay rule, so it serves the May to Oct live days too.
  - On 11-16 to 11-23 it equals the replay's crossing tick on every row, because every `trade_count` matched.

#### Drift test

`nightly/tests/test_interval_ba_drift.py` reads three files as text and asserts that their values equal the module's constants:

- `uw-stream/src/config.py`: the 0.75 ratio, the 250,000 floor, the 300 s window and the 0.5 share, at `:228-242`;
- `uw-stream/src/handlers/interval_ba.py`: the nine codes (`:119-131`) and the 90 s confluence window (`:109`);
- `uw-stream/src/handlers/recent_fires.py`: the backward-only, inclusive window test.

CI filters in `.github/workflows/ci.yml`:

- **`nightly`:** those three uw-stream files join it, so a uw-stream-only change runs the test. The `uw_stream` filter already does the same for `src/data/marketHours.ts` (`ci.yml:106-109`).
- **`ml`:** `nightly/src/interval_ba_replay.py` joins it, because `scripts/test_interval_ba_tape.py` imports the module and the scripts tests run in the `ml` job (`ci.yml:69-80, 318-320`).

### 6.4 One day's pass over live rows: `heal_day(conn, con, tape, day, settings, *, insert_missed, apply) -> DayPlan`

This also lives in the shared module. It is used only for days on or after `LIVE_START = 2026-05-13`, and it refuses an earlier day.

**`insert_missed`.**

- **True only for days on or after `INSERT_MISSED_FROM = 2026-10-29`,** when live ran today's rule, and only with Q2 = yes.
- **For 05-13 to 10-28 it is false.** Those days get flags and spot only (anti-goals).

**`settings`, the live settings that cover the day.**

- **The nightly step reads them from `interval_ba_live_settings`.** The covering rows are the latest row with `booted_at` before the day's 00:00 CT, plus every row during the day.
- **The tool's `heal` mode** may pass the code defaults with all three tickers on (`--assume-default-settings`), but only for days before the first `interval_ba_live_settings` row. The §8.2 parity run is the evidence that 10-29 onward ran the defaults.

The steps:

1. **Replay and compare.** Replay the day and read its rows from Neon. Count only the tickers that were on in every covering row ("on tickers"). Compare on the key:
   - `tape_alerts`, `live_rows` (`source = 'live'` only), `live_missed` and `live_only`;
   - `value_mismatched`: matched keys where any of `ratio_pct`, `ask_premium`, `total_premium`, `trade_count`, `top_trade_premium` or `top_trade_size` differs. It is a diagnostic and gates nothing.
2. **Settings check (only when `insert_missed`).** The inserts are held when:
   - no row covers the day (`inserts_held = 'no live settings record'`);
   - a covering row's ratio, floor, window, share, codes or confluence window differs from the module's constants (`'live settings differ from the tape rule'`);
   - `enabled` is false in every covering row (`'live detector off'`).
3. **Insert what live missed (only when `insert_missed` and not held).** Tape alerts for on tickers whose key has no row are INSERTed as `source = 'replay'`, with `ON CONFLICT DO NOTHING`.
4. **Remove stale replay rows.** Delete `source = 'replay'` rows on the day whose key the replay no longer fires. Only a re-landed tape makes any. Nothing is removed when the replay fired no alerts at all: an empty replay with live rows present means the tape read broke, not that the alerts went away.
5. **Flags on live rows.** `UPDATE ... SET top_trade_is_sweep, top_trade_is_floor WHERE id = v.id AND source = 'live' AND (the two flags) IS DISTINCT FROM (v.sweep, v.floor)`.
6. **SPXW spot on live rows.** `UPDATE ... SET underlying_price WHERE id = v.id AND source = 'live' AND underlying_price IS NULL`, with `live_spot`.
7. **Record the day.** Upsert the `interval_ba_tape_days` row.

It returns a `DayPlan`: the counts and the exact write set (ids and values per UPDATE, ids to delete, rows to insert), with a sha256 over it.

Writes and what it never touches:

- **One transaction.** With `apply = True`, steps 3 to 7 run in one transaction, in batches of 500 rows.
- **Autocommit is switched off for the day.** The nightly's `connect_db` connection is autocommit (`resources.py:49,66`). `heal_day` sets `autocommit = False`, commits at the end, and rolls back on any exception.
- **A failed day leaves no row and no marker,** so it is retried.
- **The dry run.** With `apply = False` nothing is written.
- **Never touched:**
  - a live row's other columns, and `acknowledged` on any row;
  - `underlying_price` on a row that already has one;
  - any live row's existence: it is never deleted.

### 6.5 The one-off tool: `scripts/interval_ba_tape.py`

- **How it runs.** With `ml/.venv`, the venv CI runs `scripts/test_*.py` in (`ci.yml:318-320`). `nightly/.venv` cannot import `ml/src/utils`, which needs scipy.
- **Reading the tape.** It reads R2 through httpfs with `ml/src/utils/r2.py` (`fulltape_connection(threads=4, memory_limit="3000MiB")`, `r2_url`), as the probes did.
- **Importing the module.** It puts `nightly/src` on `sys.path` to import the replay module.
- **Credentials and R2 writes.** It reads `DATABASE_URL` and the four `R2_*` names from `.env.local` and never prints them. That URL is production. R2 writes follow the `r2-storage` skill: one boto3 client, and a verified upload.
- **Exit codes.** 0 ok, 1 error, 2 bad arguments, 3 refused. This is the `scripts/repair-range-pos-splits.mjs` precedent.
- **Refusals.** Every writing mode refuses to start:
  - on weekdays from 08:15 to 16:00 CT (curb prints fire alerts until about 15:59 CT);
  - on any day from 07:15 to 12:30 UTC (the nightly run).
  - `--allow-market-hours` overrides only the first window.

#### Run folders, plans and applies

Both writing modes, `rebuild` and `heal`, work the same way:

1. **A dry run creates a run folder,** `docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/` (gitignored). It holds:
   - `plan.json`: per day and ticker, the counts and the sha256 of that day's exact write set;
   - the git blob hash of `interval_ba_replay.py` and of the tool;
   - `report.md`: the same, readable.
2. **`--apply --run <folder> --expect-...` takes the backup once.** On the run's first apply it writes every row of `interval_ba_alerts`, all columns including `id`, to the folder's `backup.jsonl`.
   - It reads the file back and checks the row count and a checksum.
   - It uploads the file to R2 at `backups/interval-ba-alerts/<UTC stamp>.jsonl`, with sha256 and row-count metadata. It reads the object's metadata back and checks it.
   - A failure of either check stops the run before any write.
   - A later apply in the same folder takes no new backup: the backup is the state before the run.
3. **It refuses to start when something has moved:**
   - the module's or the tool's blob hash differs from the plan's;
   - any `--expect-*` total differs from `plan.json`'s total over the days not yet applied.

   The expected totals:
   - `rebuild`: `--expect-delete`, `--expect-insert`;
   - `heal`: `--expect-insert`, `--expect-remove`, `--expect-flags`, `--expect-spot`.
4. **Per day, it checks before writing.** It re-plans the day and compares the fresh write set's sha256 with the plan's. A difference stops the run: the day's data or the code has changed since the owner saw the plan.
5. **A day already applied is skipped.** If the day's current rows already equal the plan's end state, it was applied, perhaps by a run that died between its commit and its marker. The tool writes the marker and goes on.
6. **Then, per day:** one transaction, then a `<day>.applied` marker.

#### The modes

| Mode | What it does |
|---|---|
| `verify --from D --to D` | Read-only. Replays each day and compares with the stored rows: key sets, then every column except `fired_at`, `confluence_tickers`, the two flags and SPXW spot. Prints a per-day table like spec §5.1 and lists each differing row. |
| `rebuild` | The 5.1 delete-and-insert over the days with no live rows in reach. See the list after the table. |
| `heal --from 2026-05-13 --to D [--assume-default-settings]` | `heal_day` per landed day, with `insert_missed` true from 10-29 only. This is the supervised first pass before the nightly step ships. |
| `export --from 2026-01-02 --to D` | Read-only for Neon. Writes the full-year replay with today's rule, every day and all three tickers, to R2 at `research/interval-ba/replay-<D>.parquet`, with sha256 and row-count metadata, and to the run folder. It records the module's blob hash and the rule constants in the file's metadata. This is the one-definition dataset for studies (goal 7). |
| `undo --run <folder>` | Restores the run's applied days from its backup: those marked `.applied`, and any whose rows equal the plan's end state. See the list after the table. |

`rebuild` covers these days:

- every trading day from 2026-01-02 to 2026-05-12;
- 2026-05-13, only for tape alerts whose `fired_at` is before that day's first live row;
- 2026-07-22, only for tape alerts whose `fired_at` is after that day's last live row;
- every trading day from 2026-07-23 to 2026-09-04.

On each, it deletes the day's `source = 'replay'` rows and inserts the tape alerts in the window, `ON CONFLICT DO NOTHING`. A tape key that already has a live row is handled by day type:

- **The two edge days (05-13, 07-22):** such keys are expected. Live's `fired_at` is wall clock, about 0.1–0.4 s after the tape's crossing tick, so live's first row has a tape twin just inside the window. A bucket in progress when the handler booted also fires earlier on the tape. Those keys are skipped and listed in `report.md`.
- **Every other rebuild day:** such a key stops the dry run, because no live rows should exist there. `plan.json` also has the largest day's row count, since the feed shows at most 500 a day. `rebuild` refuses every other day.

`undo` restores those days by mode:

- **`rebuild` days:** it deletes the day's `source = 'replay'` rows and re-inserts the backup's replay rows for that day, with their original ids.
- **`heal` days:**
  - it sets the two flags and `underlying_price` back to the backup's values, only on live rows whose values still equal what the heal wrote;
  - it deletes the replay rows the heal inserted.

It never deletes or re-inserts a live row. It leaves `interval_ba_tape_days` alone, so the nightly job won't redo an undone day.

### 6.6 The nightly step: `interval-ba-tape`

- **Where it lives.** Module `nightly/src/interval_ba_step.py`, registered right after `outcome-check`. My call: it writes Neon like the enrich step, and it carries the outage alert, so it should not be the one squeezed when time runs short.
- **Shape.** It copies the per-day loop of `enrich_step._enrich_days` (`enrich_step.py:259-302`):
  - its own cache dir, `WORK_DIR / "interval-ba"`, because `open_reader` empties its dir;
  - newest day first;
  - a fresh Neon connection per day, after the download;
  - a failing day is counted and sent once, and the loop goes on;
  - after `INTERVAL_BA_MAX_DAY_FAILURES = 3` failed days the step stops as `failed`;
  - leftover days make the step `partial` with `days_left`.
- **Work.** Trading days from `INSERT_MISSED_FROM` (10-29) through `ctx.last_session` that have a landed tape and no `interval_ba_tape_days` row. Each runs `heal_day(..., insert_missed = <Q2>)`.
  - A day that landed or re-landed tonight (`ctx.tape` status `landed` or `relanded`) has its marker deleted first, the same way enrich resets its markers.
  - A day with no tape yet waits. That is not an alert.
  - A day whose inserts were held keeps its marker, because a retry would hold again. The alert asks for a decision: fix the settings, or change the constants. After that, deleting the marker redoes the day.
- **Reading the tape.** The step downloads the day with the existing `TapeReader` and reads the local file with DuckDB. That is the path proven in the image; httpfs inside the image is unverified.
  - DuckDB runs with `INTERVAL_BA_DUCKDB_MEMORY`, 2 threads, and `temp_directory` under the step's work dir.
  - Phase 9 reads the nightly service's memory limit on Railway first, then sets the DuckDB limit to at most a quarter of it, and at most 2000MiB.
- **Health alerts, separate from the step's own status.** The step's `StepResult` carries one `detail`, which "days left" or a failed day would hide (`steps.py:79-89`, `monitoring.py:189`). So after each day commits, the step sends at most one `sentry_sdk.capture_message` for that day:
  - level `error`;
  - tags `service=nightly`, `step=interval-ba-tape`, `day`;
  - fingerprint `["interval-ba-live-health", <phrase>, <day ISO>]`.

  The fingerprint names the day, as `report_tape_day` does (`monitoring.py:136-156`). So each day opens a new issue, which rule 6262727 ("nightly: any new issue", events tagged `service=nightly`) mails. No new Sentry rule is needed.

  When more than one phrase applies, the first one in this table wins:

  | Phrase | When |
  |---|---|
  | the `inserts_held` reason (6.4 step 2) | the inserts were held |
  | `"tape fired no alerts"` | `tape_alerts = 0` and `live_rows > 0` (the replay or the tape read broke) |
  | `"live wrote no alerts"` | `tape_alerts > 0` and `live_rows = 0`, for on tickers |
  | `"live missed alerts"` | `live_missed ≥ 5` and `live_missed > 10%` of `tape_alerts` |
  | `"live and tape rows disagree"` | either of these holds: matched keys ≥ 20 and `value_mismatched > 5%` of them; or `live_only ≥ 5` and `> 10%` of `live_rows`. This is the alert for a rule change hidden from the settings record. |

  The counts go in the extras. The thresholds are my call: live missed 2 keys in 13 sessions since 10-29, and 34 of 108 on 05-20.
- **Budget.** `INTERVAL_BA_DAY_BUDGET_SECONDS = 900`, the same as the other two per-day tape steps.
  - The reserve goes from 7,500 to 8,400 s, and the tape window from 6,900 to 6,000 s.
  - `test_deadline_constants_bound_the_run` computes from `STEPS` and still holds: 8,400 + 7,200 ≤ 18,000.
- **Registry pins and docs to update** (nightly-db-facts §1.3–1.4):
  - `pipeline.py`, plus the constants in `constants.py`;
  - `test_pipeline.py`: the order, the reserve sum, the constants table, and one "registered step runs its module" test;
  - a new `nightly/tests/test_interval_ba_step.py` in the `test_enrich_step.py` style;
  - the README:
    - the intro and the step list;
    - the reserve table and arithmetic ("fourteen" becomes "fifteen");
    - the `DATABASE_URL` writers paragraph, the alert table with the phrases, and line 1404;
  - CLAUDE.md:
    - line 3 and the nightly block's step list and Neon writers;
    - the "6,900 s ... 6,000 s at the enrich budget's cap" numbers.

  The module sits under `nightly/src/**`, so no Dockerfile, `.dockerignore`, `IMAGE_FILES` or watch-path change. The CI filter changes are in 6.3.

### 6.7 API and UI

- **The poll's cursor query** (`api/interval-ba-alerts.ts:223`) becomes `WHERE a.fired_at > ${since} AND a.expiry = ${today}`.
  - `today` is the same `getETDateStr(new Date())` the default query uses (`:188`, `:251`).
  - It keeps every past-day row, a tape-added one or a rebuilt one, out of the chime.
  - The test pins that a newer `fired_at` on yesterday's `expiry` is not returned.
  - This ships before any write that inserts.
- **The spot caption.** `IntervalBARow.tsx:392-398` reads `spx` for SPXW rows and the ticker in lower case for the others. Update `IntervalBARow.test.tsx:386,391` and add an SPY case.
- **The feed header copy** at `IntervalBAFeed.tsx:114-119` changes to: "SPXW, SPY and QQQ Interval B/A ask-side alerts. Pick a date and intraday CT time window — the table shows every alert that fired in that slice; click ↗ to open the contract on Unusual Whales. Alerts before the live feed started (May 13 2026) and from the days it was down (Jul 22 – Sep 4) were rebuilt from the Full Tape with today's rule. The rest are the live alerts as they fired; since Oct 29 the tape also adds, the next morning, any the live feed missed."
  - If Q2 says no, the last clause is dropped.
  - The file comment at `:13` ("6,851 backfilled rows") goes.
  - `src/__tests__/IntervalBAFeed.test.tsx:153` changes with it.
  - This ships after the nightly step, when the copy is true.
- **No feed change.** Both endpoints already `COALESCE(a.underlying_price, spx.close)`, so a filled spot wins and same-day rows keep the candle fallback.

### 6.8 Research script and retired scripts

`scripts/enrich_interval_ba_outcomes.py` (hand-run, writes CSV and MD under `docs/tmp/`):

- **Read the tape from R2,** with `ml/src/utils/r2.py`, instead of the Mac path `PARQUET_DIR`.
- **Select SPXW by OCC root,** not by `underlying_symbol`.
- **Read either source,** behind a flag:
  - the table, which is the live record;
  - the `export` file, which has one rule all year.
- **Change the t=0 point, flagged as a methodology change.** t=0 becomes the last print at or before `fired_at`. Today it is the last print of the minute containing `fired_at`, which can sit up to 59 s after the alert.
- **Add tests.** A new `scripts/test_enrich_interval_ba_outcomes.py` pins the t=0 rule, the SPXW selection and both sources on a small local parquet.
- **Regenerate after the run.** After the production run, run it again. Move the old `interval-ba-outcomes-*.csv` files into `docs/tmp/interval-ba-outcomes-pre-rebuild/`.

Three scripts are retired (deleted), along with any `scripts/README.md` lines naming them. Each would write the old rules back into the table:

- `scripts/backfill_interval_ba_alerts.py`;
- `scripts/backfill_confluence_tags.py`;
- `scripts/scrub_interval_ba_multileg.py`.

`scripts/test_fulltape_parquet_dir.py` imports the first one (`:23`, `:53`, `:115` on) and loses those cases in the same commit. My call.

## 7. Order of work

Each phase ships on its own, with its tests in the same commit, and touches at most 5 files. Pushes follow the windows:

- a uw-stream change after 15:00 CT;
- a nightly watch-path change (`nightly/src/**`) after 15:00 CT and outside 07:15 to 12:30 UTC;
- Vercel any time.

| # | Phase | Files | Push |
|---|---|---|---|
| 1 | Flags fix in uw-stream | `uw-stream/src/handlers/interval_ba.py`, `uw-stream/tests/test_interval_ba.py`, `uw-stream/tests/fixtures/interval_ba_sample.json` | after 15:00 CT |
| 2 | Poll cursor limited to today | `api/interval-ba-alerts.ts`, `api/__tests__/interval-ba-alerts.test.ts` | any time |
| 3 | Migration, then apply it | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts` | any time |
| 3b | uw-stream records its settings (6.1b); needs 3 applied | the handler-construction module and its test, at most 3 files | after 15:00 CT |
| 4 | Replay module, its tests, the drift test and both CI filters | `nightly/src/interval_ba_replay.py`, `nightly/tests/test_interval_ba_replay.py`, `nightly/tests/test_interval_ba_drift.py`, `.github/workflows/ci.yml` | nightly window |
| 5 | `heal_day` and `live_spot` | `nightly/src/interval_ba_replay.py`, `nightly/tests/test_interval_ba_heal.py` | nightly window |
| 6 | The tool, all modes. Then run `verify` (read-only, §8.2). | `scripts/interval_ba_tape.py`, `scripts/test_interval_ba_tape.py` | any time |
| 7 | Retire the three scripts | the three files, `scripts/README.md`, `scripts/test_fulltape_parquet_dir.py` | any time |
| 8 | **Production run, owner's go** (§8.3); needs 2, 3 and 6; 1 deployed first is best | none | none |
| 9 | Nightly step; needs 3b deployed | `nightly/src/interval_ba_step.py`, `nightly/src/pipeline.py`, `nightly/src/constants.py`, `nightly/tests/test_interval_ba_step.py`, `nightly/tests/test_pipeline.py` | with 10, nightly window |
| 10 | Nightly docs | `nightly/README.md`, `CLAUDE.md` | with 9 |
| 11 | UI copy and caption | `IntervalBARow.tsx`, `IntervalBAFeed.tsx`, `IntervalBARow.test.tsx`, `IntervalBAFeed.test.tsx` | after 9 |
| 12 | Research script, then regenerate the outcome CSVs | `scripts/enrich_interval_ba_outcomes.py`, `scripts/test_enrich_interval_ba_outcomes.py` | after 8 |

Ordering rules:

- **Phase 9 waits for phases 8 and 3b.** The first pass over 05-13 onward happens under the supervised dry run, and every day the nightly processes has a settings record.
- **Phase 2 ships before anything inserts.**
- **Phase 1 first is best.** Then only the deploy day's own rows still have the old flags when the heal runs. Any order is correct, because the heal corrects flags from the tape.

Q3 kept floor as `futures_floor`, so no drop-floor phases are needed.

## 8. Testing and acceptance

### 8.1 Unit tests (no network, no database)

**The replay module** is tested against small parquet files in `tmp_path`, in both tape layouts. The cases:

- **Floor:** exactly $250,000 fires; $249,999.99 does not.
- **Ratio:** exactly 75% fires.
- **Multi-leg share:** exactly 0.5 does not fire.
- **Firing tick:** a bid tick can be the crossing tick, and the spot comes from it.
- **Canceled ticks** count.
- **Top trade:** on a tie, the earliest wins.
- **Freeze:** a bucket is frozen after its fire.
- **Bucket boundaries:** 14:34:59.999 and 14:35:00.000 fall in different buckets.
- **Excluded rows:** SPX-root and non-0DTE rows are left out.
- **CT date:** a naive-timestamp day gets the right CT date.
- **Rounding:** `ratio_pct` rounds half-even; the spot rounds half-up.
- **Milliseconds:** times come back as aware UTC `datetime`s, truncated to the millisecond. The nightly venv has no `pytz`, so the suite also proves that no column is fetched as a timestamp.
- **Flags:** sweep and floor come from a two-value `report_flags`; a `sweep` tag alone is false.
- **SPXW opening seconds:** the spot is forward-filled.
- **Confluence:** asymmetric (A `[]`, B `[A]`, C `[A,B]`), with 90 s in and 90.001 s out.
- **`live_spot`:**
  - picks tick number `trade_count`, counting canceled ticks;
  - falls back to as-of when the bucket is short;
  - forward-fills in the opening seconds.

**`heal_day`** is tested with `psycopg2` patched at the module boundary (R3). The cases:

- **Dry run:** writes nothing, and its sha256 is stable across two runs.
- **What the UPDATEs touch:** only the two flags and a NULL `underlying_price`, on `source = 'live'` rows. No DELETE ever names a live row.
- **`insert_missed` false** (a day before 10-29): no inserts even with missed keys.
- **Held** for each of the three settings reasons, with flags and spot still written.
- **A ticker off in the settings:** no inserts for it, and it is left out of the counts.
- **A setting change mid-day:** the covering rows include the mid-day boot.
- **Outage day:** with no live rows, the inserts are not held.
- **Re-landed day:** stale replay rows are removed.
- **DB error mid-day (R4):** it rolls back, writes no marker, and raises.

**The tool** is tested with `psycopg2`, DuckDB and boto3 patched at the boundary. The cases:

- **`rebuild`:**
  - it refuses a day outside its list, and on 05-13 and 07-22 it inserts only outside the live window;
  - it never deletes a `source = 'live'` row;
  - a tape key that collides with a live row stops the dry run.
- **`heal`:**
  - it refuses a day before 05-13;
  - `--assume-default-settings` is refused for a day that has a settings row.
- **Plan checks:**
  - `--expect-*` mismatches are refused, and on resume the totals count only the not-yet-applied days;
  - a changed module hash is refused;
  - a day whose fresh write set differs from the plan stops the run.
- **Resume:** a day already in its planned end state is marked and skipped.
- **Refusals:** both windows.
- **Backup:**
  - a local read-back failure, or an R2 metadata mismatch, stops the run before any write;
  - a resume takes no new backup.
- **`undo`:** restores replay rows and live columns as in 6.5, never touches a live row's existence, and round-trips.
- **`export`:** writes no Neon row, and its metadata holds the hash and the constants.

**The nightly step** is tested in the `test_enrich_step.py` style. The cases:

- newest day first;
- the marker reset on a re-land;
- one connection per day;
- a failing day doesn't stop the others;
- the failure cap;
- one health message per day by the 6.6 precedence, even on a night that also leaves days or fails a day;
- no exception text in a detail.

**uw-stream 6.1b:** the row holds the effective values, and a failed write is reported and does not stop the handlers.

**The API:** the cursor query excludes a newer row on yesterday's `expiry`.

Gates: `npm run review` for the TypeScript phases; each Python package's own suite (nightly, uw-stream, scripts) for the rest.

### 8.2 Parity (phase 6, read-only, before anything writes)

`verify --from 2026-10-29 --to 2026-11-23` covers 18 sessions:

- 10-29, 10-30, 11-02, 11-03, 11-04, 11-05, 11-06, 11-09, 11-10, 11-11, 11-12;
- 11-13, 11-16, 11-17, 11-18, 11-19, 11-20, 11-23.

What each group must show:

- **From 11-13 (the mirror sockets), 7 sessions:** every key and every compared column equal.
- **Before 11-13, 11 sessions:** per session, at most 5% of matched rows may differ in value and at most 2 keys may differ, and every one is listed.
  - The measured worst cases are 4 of 119 (3.4%, 11-11) and 1 key (10-30, 11-10).
  - 11-02, 11-03, 11-04, 11-06 and 11-09 have not been replayed before, so their lists are read in the hand check.
- **Anything over those limits,** or any difference from 11-13 on, stops the work.

This checks the detector against live where live ran today's rule. May to Oct live days are not compared, because they ran another rule.

### 8.3 The production run (phase 8)

**Steps, in order,** each after the owner's go:

1. `rebuild` dry run, with `report.md` shown to the owner.
2. The hand check.
3. `rebuild --apply --run ... --expect-...`. Its first apply takes the backup, locally and in R2.
4. `heal` dry run over 05-13 to the last landed day. It uses `--assume-default-settings` from 10-29 up to the day phase 3b deployed; before 10-29 nothing is inserted.
5. Its hand check.
6. `heal --apply`.
7. `verify` over the rebuilt days and 10-29 on.
8. `export` of the full year.

**The pass rule for step 7.**

- **The rebuilt days** equal the replay on every compared column, within their windows.
- **10-29 on** stays within the §8.2 limits.

**The hand check.** Recompute one or two rows per raw source by hand from the raw prints: list the bucket's prints with DuckDB and add them up outside the tool. The raw sources:

- **The old tape layout:** a January SPXW row and a March SPY row.
- **The new tape layout:** an August SPXW row and an August QQQ row from the outage.
- **For the heal:**
  - a June live SPXW row's spot, so the `trade_count` crossing tick is checked on an old-rule day;
  - a November live SPXW row's spot;
  - one live row with an `intermarket_sweep` top trade.

**When.** On a weekday after 16:00 CT, and never from 07:15 to 12:30 UTC. Run in the background, one heavy command at a time. The estimates:

- the rebuild covers about 124 days;
- the heal about 140;
- the export 225;
- at 17 to 27 s a day, that is roughly 40 to 55 minutes for the rebuild, 40 to 65 for the heal, and 65 to 100 for the export.

**The report.** Before and after counts per ticker and month go in each run folder's `report.md`.

## 9. Constants

| Name | Value |
|---|---|
| Ratio, floor, bucket, multi-leg share | 0.75, $250,000, 300 s, < 0.5 (`uw-stream/src/config.py:228-242`) |
| Codes, confluence window | the nine codes, 90 s backward and inclusive (`uw-stream/src/handlers/interval_ba.py:119-131`, `:109`) |
| `LIVE_START` | 2026-05-13 (first live row 15:55:37Z) |
| `INSERT_MISSED_FROM` | 2026-10-29 |
| Rebuild days | 2026-01-02 to 05-12; 05-13 before the first live row; 07-22 after the last live row; 07-23 to 09-04 |
| Pre-live boundary for the `source` update | `expiry < 2026-05-13` |
| Health alerts | inserts held; `tape_alerts = 0` with `live_rows > 0`; `live_rows = 0` with `tape_alerts > 0`; `live_missed ≥ 5` and > 10% of `tape_alerts`; rows disagree (matched ≥ 20 and `value_mismatched` > 5%, or `live_only ≥ 5` and > 10% of `live_rows`) — the first that applies, one per day |
| `INTERVAL_BA_DAY_BUDGET_SECONDS` | 900 |
| `INTERVAL_BA_MAX_DAY_FAILURES` | 3 |
| `INTERVAL_BA_DUCKDB_MEMORY` | at most a quarter of the service's memory and at most 2000MiB; 2 threads; spill under the step's work dir |
| Write batch | 500 rows |
| Tool refusal windows | weekdays 08:15 to 16:00 CT; every day 07:15 to 12:30 UTC |
| Parity limits before 11-13 | ≤ 5% of matched rows differ in value, ≤ 2 keys differ, per session |
| Run folders | `docs/tmp/interval-ba-rebuild/<UTC stamp>-<mode>/` (gitignored) |
| R2 keys | `backups/interval-ba-alerts/<UTC stamp>.jsonl`; `research/interval-ba/replay-<D>.parquet` |

## 10. Questions for the owner (defaults marked)

- **Q1. Language. Decided (owner, 2026-11-24): "python is fine for now".** The replay module, the tool and the nightly step are written in Python.
  - The 11-13 rule ("everything in TypeScript instead of Python outside of the ML work") left open whether nightly and the `scripts/*.py` repair tools count.
  - "For now" means this work moves with uw-stream when uw-stream moves to TypeScript.
- **Q2. Missed alerts, from 10-29 on. Decided (owner, 2026-11-24): add them (N2).** They are marked `source = 'replay'`. They are added only for tickers live had on, and only under settings equal to the replay's rule. `insert_missed` is true from `INSERT_MISSED_FROM`.
- **Q3. "Floor". Decided (owner, 2026-11-24): "keep it".** Floor means `report_flags` contains `futures_floor`, in uw-stream, the replay and the tape correction of live rows.
  - UW's only floor flag marks multi-leg spread prints 93% of the time, so the label reads as "futures-linked spread print", not "floor broker".

## 11. My calls (for the owner to check while reading)

1. **The old backfill is deleted and re-inserted per day.** It holds no acks and no live writes.
2. **Today's rule fills the outage and the pre-live days.** Not the 8-code rule live ran then.
3. **The SPXW spot for a live row** comes from the bucket's `trade_count`-th tick, a rule-free way to find where live fired.
4. **Tape rows' confluence uses tape fires only,** and live rows' tags are never changed.
5. **A `source` column**, so the two meanings of `fired_at` stay visible.
6. **uw-stream records its settings at each start.** The nightly adds rows only when they match the replay's rule.
7. **Tie order and the SPXW opening seconds.** Replay order is `executed_at`, then file row order. SPXW rows in the opening seconds take the first spot 0.3 to 7 s later.
8. **The nightly step:**
   - it runs right after `outcome-check`, with a 900 s budget (the tape window shrinks from 6,900 to 6,000 s);
   - it downloads the day rather than using httpfs;
   - the alert thresholds are as in §9;
   - one mail per affected day.
9. **The banner poll** only returns today's alerts.
10. **The backup** also goes to R2, and the full-year study file lives in R2 under `research/`.
11. **Three old scripts retired.**
12. **The outcome study's t=0** moves to the last print at or before the alert. This is a methodology change, so it is flagged here.
13. **The caption** shows the row's own ticker.

## 12. Left to the builder

- The migration id: the next free one, once other sessions' pending migrations are checked.
- Function and file names beyond those given.
- The uw-stream construction site for 6.1b.
- How the tool loads `.env.local`.
- The exact tie-break when two fires share a millisecond.
- Whether `heal` and `export` share one tape read per day.

## 13. Risks

- **The year is not one rule in the table.** May 13 to Oct 28 holds what live sent under the 8-code rule; the rest is today's rule.
  - `source` and the dates tell them apart.
  - The `export` file is the one-rule dataset for studies.
- **Rule drift from 10-29 on.**
  - The drift test pins the code defaults.
  - The settings record pins what actually ran.
  - A change hidden from both, such as a hand-patched container, would show in `value_mismatched`.
- **`live_spot` on a bucket where live missed ticks** picks a tick a few prints off where live fired: the same index level to within seconds. As-of covers a short bucket.
- **`fired_at` means two things.** Replay rows hold the tick time, about 0.1 s before live's wall clock. A study across the boundary should read `source`.
- **A day over 500 rows** would be cut by the feed's cap. The dry run reports the largest day.
- **The image's DuckDB time zone support** is proven by the nightly unit test on the same wheel, not by a run on Railway. The first nightly run fails loudly (`days_failed`) if it is wrong.
- **Container memory** is not measured. Phase 9 reads the service's limit first.

## 14. What changed, and when (2026-11-24)

**Review 1** (verdict "revise", one blocker and 16 other findings):

- **The blocker.** A tape-added row could ring a tab left open overnight. The cursor query is now limited to today (6.7).
- **Health alerts** are their own Sentry message per day (6.6).
- **A Railway override** can no longer get "healed" into the table (6.4; now the settings record).
- **CI filters, the parity list, the tool's venv, resume and undo, transactions, the failure cap and memory limits**, plus missed edits and phases split to at most 5 files.

**Review 2** (verdict "revise", no blocker):

- **Parity limits** come from the measured worst cases.
- **Both apply modes re-check the plan** by sha256 and module hash.
- **Crash recovery** for a day committed without its marker.
- **Path fixes.**
- **Times leave DuckDB as integers** (no `pytz` in the image).
- **Phase F2 is split by layer.**
- **Q3 has a default.**
- **The value-comparison drift gate became the uw-stream settings record** (6.1b), which also respects a ticker switched off on Railway.
- **One mail per outage day.**
- **The `ml` CI filter** covers the module the tool imports.

**Owner, after review 2:**

- **"lets not overwrite real writes".** Live rows from May 13 on are never deleted or recomputed. That changed:
  - the history work: only the old backfill is replaced, and the stretches with no live rows are filled (5.1, 5.3, 6.5 `rebuild`);
  - `heal_day`: it starts at May 13, inserts only from Oct 29, and has a rule-free `live_spot` (6.3, 6.4);
  - `undo`: it never touches a live row's existence;
  - the rest: the full-year `export` for studies, the R2 backup copy, and the header copy.
- **"both"**: on live rows, the flags are corrected and the blank SPXW price is filled.

**The changes made after review 2 have not been reviewed.** The two-review cap was reached. They are:

- 6.1b and the settings check in 6.4;
- everything the owner's "lets not overwrite real writes" changed.

The plan's own review read the plan against this doc.

**The plan review fixed these spec details (2026-11-24):**

- **The settings row's `tickers`** also reflect `WS_CHANNELS` (6.1b).
- **A failed settings write** is reported once per process. The text no longer claims the nightly finds no record in that case.
- **`booted_at`** is noted as R6-safe.
- **The scan includes `SPX`-labelled rows** and keys on the OCC root, with a reported `root_label_mismatch` count (6.3).
- **Nothing is removed when the replay is empty** (6.4 step 4).
- **Two health phrases were added:** "tape fired no alerts" and "live and tape rows disagree" (6.6).
- **Live-row collisions on the 05-13 and 07-22 edge days** are skipped and listed, not stopped on (6.5).
- **The migration id** is the next free one.
