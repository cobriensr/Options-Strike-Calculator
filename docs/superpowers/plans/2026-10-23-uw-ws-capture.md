# UW Schema + Websocket Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the schema for the new UW data, fix the uw-stream defects D13 and D15–D17, and start capturing `periscope:SPX`, `greek_flow_expiry:SPX`, `iv_term_structure:SPX` and `market_tide` (as a shadow).

**Architecture:** One migration batch (ids 191+) creates every new table and column. uw-stream gets new `Handler` subclasses registered in `channel_registry.py`; each writes with chunked multi-row upserts on source-derived or bucketed keys. Deploy happens outside market hours, and the handler goes live before `WS_CHANNELS` changes.

**Tech Stack:** Python 3 asyncio, `websockets`, `asyncpg`, `orjson`, pytest (uw-stream); TypeScript + Vitest for migrations.

**Spec:** `docs/superpowers/specs/uw-api-ws-alignment-2026-10-23.md`

**Requirement-level plan (ruling):** exact DDL, behaviours, constants and test cases are given. Handler code is written by the implementer against the current `uw-stream/src/handlers/base.py`.

## Global Constraints

- Worktree: `F:\dev\strike-calculator\.worktrees\2026-10-23-uw-ws` (branch `fix/2026-10-23-uw-ws`). Work only there.
- **uw-stream tests:** create a venv once with `python -m venv uw-stream/.venv`, install `uw-stream/requirements.txt` plus pytest, then run `uw-stream/.venv/Scripts/python -m pytest uw-stream/tests -q` from the worktree root (or `cd uw-stream` first if `conftest.py` needs it). The full uw-stream suite must be green before you commit. Run `npm run review` too when any `api/` file changes. Both run in the FOREGROUND with a long timeout (≥ 600000 ms).
- **Handler contract** (`uw-stream/src/handlers/base.py`):
  - `Handler.__init__(self, name)`; implement `_transform(self, payload: dict) -> tuple | None` and `async _flush(self, rows: list[tuple]) -> int | None`.
  - Batching is global (`ws_batch_size`, `ws_batch_interval_ms`).
  - Time flushes fire only when the batch is non-empty.
  - `_safe_flush` swallows DB errors and bumps counters.
  - `drain()` runs at shutdown.
  - One handler instance serves every channel mapped to its class.
  - For a stateful aggregator, follow the pattern in `uw-stream/src/handlers/futures_trades.py`. DB helpers are `uw-stream/src/db.py`: `bulk_insert_ignore_conflict` and `bulk_upsert_replace`. Dedupe and sort a batch by conflict key before an upsert (see `gex_strike_expiry.py:211-247`).
- **Registry:** `uw-stream/src/channel_registry.py` holds `EXACT_CHANNEL_NAMES`, `PREFIX_CHANNEL_NAMES`, `SHORTHAND_CHANNELS`, and the lazy `handler_class_for_channel` maps. `is_known_channel_token` must accept every new token.
- **NEVER open a UW websocket from this machine.** A token connected from more than one machine drops production sockets. Validate payload shapes from the saved docs (`C:\Users\Charlie\AppData\Local\Temp\claude\f--dev-strike-calculator\5fdfa02f-666f-452a-8c03-98198eab16bc\scratchpad\uw-docs\ws\channels\*.md`) and by re-fetching `https://api.unusualwhales.com/docs/websocket/<slug>.md` with `curl -sL`.
- **Prod DB:** `F:\dev\strike-calculator\.env.local` `DATABASE_URL` is PRODUCTION. SELECTs are fine. Writes only where a task says so.
- **Migrations:**
  - Add them to `api/_lib/db-migrations.ts` (code and DB are both at id 190).
  - Update `api/__tests__/db.test.ts` in three places: the applied-ids mock (~:623), the expected-descriptions list (~:831), and the call-count comment + `toHaveBeenCalledTimes` + transaction count (~:837-844). Also fix the stale "ids 1..189" title (~:960).
  - Each statement counts 1, plus 1 for the `schema_migrations` INSERT.
- **Python style:** match the surrounding handlers. Type hints, module docstring, `rate_limited_log` for per-frame warnings, never log every frame.
- **Commits:**
  - One per task, conventional style. The message file goes in your own scratch subdir `…\scratchpad\<task-id>\commit.txt`; print it, then `git add <explicit files> && git commit -F <file>`.
  - End with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Never `--amend`, `checkout --`, `restore`, `reset`, `stash` or `rm`. Do not push.
- Do not dispatch subagents.

## Review Focus

1. A periscope snapshot whose last frame never arrives is written `complete=false` by the reaper or by the next timestamp. It is never lost and never held forever (W5).
2. greek_flow_expiry partials arriving after a bucket was first written raise the stored total. The upsert writes the full accumulated sum (W6).
3. A UW error frame (`{"error": "..."}`) on join, e.g. periscope on a disallowed plan, is logged and reported to Sentry with its text, rate-limited, and does not crash the router (W3).
4. Strings and JSON numbers are both accepted for every numeric field UW documents ambiguously: periscope greeks, flow-alert greeks (W2, W5).
5. `WS_CHANNELS` containing the old `gex_strike_expiry_lottery` token still boots after deploy (W4), so the existing Railway value cannot crash-loop.

## Execution order

W1 (commit, then controller pushes and applies to prod) → W2 → W3 → W4 → W5 → W6 → W7 → W8 (controller ops) → W9 → W10 (after the 2026-10-23 RTH close) → W11.

---

### Task W1: Migrations 191–196

**Files:** `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`

**DDL (one migration id each, `IF NOT EXISTS` everywhere):**
- **191:** `ALTER TABLE flow_alerts ADD COLUMN IF NOT EXISTS iv DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS delta DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS gamma DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS theta DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS vega DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS rho DOUBLE PRECISION, ADD COLUMN IF NOT EXISTS theo DOUBLE PRECISION`
- **192:** the same seven columns on `ws_flow_alerts`. If the `ws_flow_alerts_enriched` view (migration 108) selects `*` and must be recreated, include that and say so.
- **193:** two tables.
  - `ws_periscope_snapshots (ticker TEXT NOT NULL, snapshot_ts TIMESTAMPTZ NOT NULL, total_rows INTEGER NOT NULL, received_rows INTEGER NOT NULL, nonzero_rows INTEGER NOT NULL, frames INTEGER NOT NULL, complete BOOLEAN NOT NULL, content_hash TEXT, duplicate_of TIMESTAMPTZ, first_frame_at TIMESTAMPTZ NOT NULL, last_frame_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (ticker, snapshot_ts))`
  - `ws_periscope_expiries (ticker TEXT NOT NULL, snapshot_ts TIMESTAMPTZ NOT NULL, expiry DATE NOT NULL, strikes REAL[] NOT NULL, gamma REAL[] NOT NULL, charm REAL[] NOT NULL, vanna REAL[] NOT NULL, PRIMARY KEY (ticker, snapshot_ts, expiry))`
- **194:** `ws_greek_flow_expiry (ticker TEXT NOT NULL, ts_minute TIMESTAMPTZ NOT NULL, expiry DATE NOT NULL, total_delta_flow NUMERIC, dir_delta_flow NUMERIC, otm_total_delta_flow NUMERIC, otm_dir_delta_flow NUMERIC, total_vega_flow NUMERIC, dir_vega_flow NUMERIC, otm_total_vega_flow NUMERIC, otm_dir_vega_flow NUMERIC, transactions INTEGER, volume INTEGER, partials INTEGER NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (ticker, ts_minute, expiry))`
- **195:** `ws_iv_term_structure (ticker TEXT NOT NULL, expiry DATE NOT NULL, ts_minute TIMESTAMPTZ NOT NULL, trade_date DATE NOT NULL, volatility DOUBLE PRECISION, implied_move DOUBLE PRECISION, implied_move_perc DOUBLE PRECISION, PRIMARY KEY (ticker, expiry, ts_minute))`
- **196:** `ws_market_tide (ts TIMESTAMPTZ PRIMARY KEY, net_volume BIGINT, net_call_premium NUMERIC, net_put_premium NUMERIC, otm_net_volume BIGINT, otm_net_call_premium NUMERIC, otm_net_put_premium NUMERIC, received_at TIMESTAMPTZ NOT NULL DEFAULT now())`

Descriptions follow the house style (look at #188–#190).

**Tests:**
- [ ] `db.test.ts` updated in all three places plus the stale title.
- [ ] `npm run review` green; commit.
- [ ] **Do NOT apply to prod**; the controller applies after review.

### Task W2: flow_alerts — `created_at` from `end_time`; store greeks

**Files:** `uw-stream/src/handlers/flow_alerts.py` (`_COLUMNS` :40-82, `_transform` :93-186), `uw-stream/tests/test_flow_alerts.py` (or the existing flow-alerts test file; add a new file if the existing one is crowded)

**Requirements:**
- `created_at` = `end_time` when it is a positive ms epoch; else `executed_at` when positive; else skip the row with a `rate_limited_log` warning. Doc: "`executed_at` … Same as `end_time` (kept for backwards compatibility)". UW sends `executed_at: 0`.
- Add `iv`, `delta`, `gamma`, `theta`, `vega`, `rho` and `theo` to `_COLUMNS` and the tuple. Parse as float from a number or a numeric string; None/empty → None.
- Write a repair SQL file at `uw-stream/sql/repair_ws_flow_alerts_1970.sql`: `UPDATE ws_flow_alerts SET created_at = end_time WHERE created_at < '2000-01-01' AND end_time IS NOT NULL AND end_time > '2000-01-01';` with a header comment. The controller runs it in W8.

**Tests:**
- [ ] `executed_at: 0`, valid `end_time` → `created_at` from `end_time`.
- [ ] Both missing or 0 → None (row skipped).
- [ ] Greeks as numbers → floats; as strings → floats; missing → None.
- [ ] Full uw-stream pytest green; commit.

### Task W3: Handshake User-Agent; explicit error-frame handling

**Files:** `uw-stream/src/connector.py` (:233-238), `uw-stream/src/router.py` (:59-146, envelope check :79-86), the tests for each (existing `test_connector*.py` / `test_router*.py`, or new files)

**Requirements:**
- Pass a real User-Agent on the handshake, e.g. `strike-calculator-uw-stream/1.0`. `requirements.txt` floors `websockets>=12.0`. Check the INSTALLED version's `connect` signature (`user_agent_header=` on the legacy and asyncio clients ≥ 10.1/≥ 13; confirm) and pin a compatible floor if needed.
- **Router:** when the parsed frame is a dict containing `"error"`, call `rate_limited_log.warning` with the error text and `sentry_sdk.capture_message` with the error text. Rate-limit Sentry to once per distinct text per hour, with an in-memory dict capped at 100 keys (R1: cap module state). Then return. It must NOT be logged as `malformed_envelope`. Everything else is unchanged.

**Tests:**
- [ ] `connect` is called with the UA kwarg (mock `websockets.connect`).
- [ ] An `{"error": "x"}` frame → warning + Sentry once; a second identical frame within the hour → no second Sentry; not counted as malformed.
- [ ] A non-dict, non-list frame still → `malformed_envelope`.
- [ ] Full pytest green; commit.

### Task W4: Off-lit synthetic-price filter; `gex_strike_expiry_0dte` shorthand

**Files:** `uw-stream/src/handlers/off_lit_trades.py` (:170-176), `uw-stream/src/config.py` (shorthands :73-75, expansion :318-363), `uw-stream/src/channel_registry.py` (`SHORTHAND_CHANNELS` :67-73), tests (off-lit + config)

**Requirements:**
- **Off-lit:** first `SELECT DISTINCT sale_cond_codes FROM dark_pool_prints WHERE executed_at > now() - interval '5 days'` on prod to get the exact strings. Then drop prints whose `sale_cond_codes` marks an average-price or derivative-priced trade (`average_price_trade`, `derivative_price_trade`, or whatever the DB shows; list the exact strings in a module constant with a comment citing the repo rule).
- **0DTE shorthand:**
  - Add `gex_strike_expiry_0dte`, expanding to `gex_strike_expiry:<T>` for a module constant `_DAILY_EXPIRY_TICKERS`.
  - Derive that set from evidence:
    1. `SELECT ticker, count(DISTINCT date) FROM ws_gex_strike_expiry WHERE date > current_date - 30 GROUP BY 1`, plus the REST `fetch-gex-strike-expiry-etfs.ts` ticker list.
    2. UW's doc on whether `gex_strike_expiry:SPXW` folds into SPX.
    3. Which tickers list an expiry every weekday.
  - Document the evidence in a comment.
  - Make `gex_strike_expiry_lottery` an ALIAS that expands to the same 0DTE set, with a one-time startup log noting the rename, so the current Railway `WS_CHANNELS` keeps booting.
  - Both tokens must pass `is_known_channel_token`.

**Tests:**
- [ ] Average-price and derivative prints are dropped; a normal print is kept.
- [ ] `gex_strike_expiry_0dte` expands to exactly `_DAILY_EXPIRY_TICKERS`.
- [ ] `gex_strike_expiry_lottery` expands to the same set.
- [ ] The validator accepts both.
- [ ] Full pytest green; commit.

### Task W5: Periscope capture handler

**Files:**
- Create: `uw-stream/src/handlers/periscope.py`, `uw-stream/tests/test_periscope_handler.py`
- Modify: `uw-stream/src/channel_registry.py` (add the `periscope:` prefix → `PeriscopeHandler`)

**Payload** (doc `channels/periscope.md`): `{"ticker","timestamp"(ms),"total_rows","has_more","rows":[{"strike":"8475","expiry":"2027-03-19","gamma","charm","vanna"}]}`. Up to 1024 rows per frame. All frames of a snapshot share `timestamp`, and a new `timestamp` starts the next one. Values are typed `float` in the doc, but UW's own greeks page and a moderator sample show decimal strings, so accept both.

**Requirements:**
- `_transform` validates and normalizes one frame. It returns None and calls `rate_limited_log` on bad input.
- **`_flush` assembles snapshots:**
  - In-flight state is a dict keyed by `(ticker, timestamp)` holding rows deduped by `(expiry, strike)`, plus the frame count and first/last frame wall times.
  - **Finalize** on a `has_more=false` frame. `complete` = received rows == `total_rows`.
  - **A newer timestamp** for the same ticker finalizes any older in-flight snapshot as incomplete.
  - **Reaper:** on every `_flush`, in-flight snapshots older than 180 s are finalized incomplete.
  - At most 2 in-flight snapshots per ticker; the oldest is finalized if exceeded.
  - **`drain()`** finalizes everything in flight.
  - Use an injectable clock only through a module-level function the tests patch with `monkeypatch`. No constructor seam (R3).
- **On finalize:**
  - Drop rows where gamma == charm == vanna == 0, and count the non-zero rows.
  - Group by expiry, with arrays sorted by strike (`real[]`).
  - `content_hash` = sha256 of the sorted non-zero `(expiry, strike, gamma, charm, vanna)` tuples.
  - **If the hash equals the last stored hash for that ticker** (in memory), write the header only, with `duplicate_of` = the previous `snapshot_ts`.
  - **Otherwise** write the header plus expiry rows in ONE transaction:
    - Header: `INSERT … ON CONFLICT (ticker, snapshot_ts) DO UPDATE SET … WHERE EXCLUDED.received_rows > ws_periscope_snapshots.received_rows` (the more complete version wins).
    - Expiry rows: replace upsert.

    Add a small helper in `db.py` only if neither existing helper fits, and test it.
- Log one INFO line per finalized snapshot: ticker, `snapshot_ts`, rows, nonzero, complete, duplicate.

**Tests:**
- [ ] 3 frames (has_more T, T, F) summing to `total_rows` → one complete snapshot, correct per-expiry arrays.
- [ ] 2 frames, then a frame with a newer timestamp → the first is written `complete=false`.
- [ ] Reaper: an in-flight snapshot plus a patched clock +181 s, then a flush → written incomplete.
- [ ] Duplicate `(expiry, strike)` across frames → kept once.
- [ ] String values and number values both parse.
- [ ] All-zero rows are excluded from the arrays and `nonzero_rows` is correct.
- [ ] An identical consecutive snapshot → header-only with `duplicate_of`.
- [ ] `drain()` writes in-flight snapshots.
- [ ] DB failure → logged; not silently counted as written.
- [ ] Registry: `periscope:SPX` → `PeriscopeHandler`; `is_known_channel_token('periscope:SPX')` is true.
- [ ] Full pytest green; commit.

### Task W6: greek_flow_expiry + iv_term_structure handlers

**Files:**
- Create: `uw-stream/src/handlers/greek_flow_expiry.py`, `uw-stream/src/handlers/iv_term_structure.py`, `uw-stream/tests/test_greek_flow_expiry_handler.py`, `uw-stream/tests/test_iv_term_structure_handler.py`
- Modify: `uw-stream/src/channel_registry.py`

**greek_flow_expiry** (doc `channels/greek-flow-by-expiry.md`):
- Each message is a PARTIAL sum for one `(ticker, timestamp, expiry)`, flushed ~1/s. A client must ADD the messages. Decimal strings. SPXW is folded into SPX.
- Accumulate in memory per `(ticker, ts_minute, expiry)`: sum all 8 flow fields (as `Decimal`), `transactions` and `volume`, and count `partials`.
- On each `_flush`, upsert the FULL accumulated totals for every bucket touched since the last flush (replace upsert on `(ticker, ts_minute, expiry)`).
- Evict buckets 180 s after their minute ends.
- Discard any bucket whose minute had already started when the handler was created; we saw only part of it. Log once.

**iv_term_structure** (doc `channels/iv-term-structure.md`):
- No message timestamp; ≤ every ~5 s per ticker, one message per changed expiry.
- `ts_minute` = floor(receive wall time, minute), via the patchable module clock.
- Replace upsert on `(ticker, expiry, ts_minute)`, so the last value in the minute wins. `date` → `trade_date`.

**Registry:** prefixes `greek_flow_expiry:` and `iv_term_structure:`.

**Tests:**
- [ ] greek_flow: 3 partials in the same key → the stored values are the sums.
- [ ] A partial arriving after the first flush → the second upsert carries the larger full sum, not the partial.
- [ ] A bucket whose minute started before handler creation → never written.
- [ ] Eviction after 180 s.
- [ ] Decimal-string parsing.
- [ ] iv: two messages in the same minute → one row with the last values.
- [ ] Messages in different minutes → two rows.
- [ ] Registry tokens accepted.
- [ ] Full pytest green; commit.

### Task W7: market_tide shadow handler

**Files:**
- Create: `uw-stream/src/handlers/market_tide.py`, `uw-stream/tests/test_market_tide_handler.py`
- Modify: `uw-stream/src/channel_registry.py` (exact name `market_tide`)

**Payload** (doc `channels/market-tide.md`): `timestamp` (ISO), `net_volume` (int), `net_call_premium`, `net_put_premium` (decimal strings), and the `otm_net_*` equivalents.

**Requirements:**
- Write every message to `ws_market_tide`: replace upsert on `ts` = the parsed payload `timestamp`.
- This is a SHADOW: do not write `flow_data` (W10 decides the swap after validation). The module docstring says so.

**Tests:**
- [ ] Parse and store all 6 values.
- [ ] Duplicate `ts` → one row with the last values.
- [ ] A malformed timestamp → skipped with a warning.
- [ ] Registry exact name accepted.
- [ ] Full pytest green; commit.

### Task W8: Deploy + WS_CHANNELS + data repair (controller ops)

- [ ] Confirm W1 is applied to prod: `schema_migrations` max id = 196 and the tables exist.
- [ ] Rebase onto `origin/main` and push. Allowed only before 08:30 CT or after 15:00 CT.
- [ ] Wait for the uw-stream Railway deploy on that commit to report SUCCESS and the logs to show shards connected.
- [ ] Read the current `WS_CHANNELS` (`railway variables`). Then set it: same value with `gex_strike_expiry_lottery` → `gex_strike_expiry_0dte`, plus `periscope:SPX,greek_flow_expiry:SPX,iv_term_structure:SPX,market_tide` appended.
- [ ] Verify:
  - acks / `subscribed` for each new channel;
  - no error frames in the logs;
  - rows arriving in `ws_periscope_snapshots` (if UW publishes overnight), `ws_iv_term_structure`, `ws_greek_flow_expiry` and `ws_market_tide` (RTH).
- [ ] Run `uw-stream/sql/repair_ws_flow_alerts_1970.sql` against prod. Report the row count before and after.

### Task W9: SPXW net_flow divergence investigation (read-only)

**Files:** Create `docs/tmp/spxw-net-flow-divergence-2026-10-23.md`

**Context:** on 2026-10-01 the SPXW session sums disagreed: WS calls −20.7M vs REST −140.8M, puts +51.8M vs −7.9M. Every other ticker matched within ~1%.

**Requirements:**
- Compare `ws_net_flow_per_ticker` SPXW session sums against REST `/stock/SPXW/net-prem-ticks` and `/stock/SPX/net-prem-ticks` for 3 recent sessions.
- Test the hypotheses:
  - SPX/SPXW root folding (the WS channel carries SPX root, REST SPXW is weeklies only, or the reverse)
  - premium sign or scale
  - dropped frames
- Report the conclusion with numbers and a recommended fix. Do NOT change code.
- [ ] Commit the report.

### Task W10: market_tide validation and writer swap (after the 2026-10-23 RTH close)

**Files:** `api/cron/fetch-flow.ts`, `uw-stream/src/handlers/market_tide.py`, and their tests

**Requirements:**
1. **Read-only comparison** of `ws_market_tide` vs `flow_data` rows with `source IN ('market_tide','market_tide_otm')` for 2026-10-23. Answer:
   - Are WS values cumulative for the day or per-update?
   - How do WS timestamps align with REST's 5-min bucket timestamps?
   - Do they match within 1%?
   Write the evidence into the report.
2. **Only if they match:**
   - The handler ALSO writes `flow_data` rows (`market_tide` and `market_tide_otm`) at REST's timestamp convention: replace upsert of the latest value per 5-min bucket.
   - `fetch-flow.ts` keeps REST as a gap-filler. Its `ON CONFLICT DO NOTHING` already yields to WS rows.
   - Tests on both sides.
3. **If they don't match:** keep the shadow, document why, and stop.

- [ ] Gates: `npm run review` and pytest green; commit.

### Task W11: Resync the `unusual-whales-websocket` skill

**Files:** `.claude/skills/unusual-whales-websocket/SKILL.md`

**Requirements:** Re-fetch the docs, then:
- Update the sync date.
- Docs at `/docs/websocket/<slug>.md`.
- One machine per token; real User-Agent.
- Kafka is Enterprise Startup + Kafka (72 h).
- **Channel table:**
  - Add `otm_market_tide`, `greek_flow[:T]`, `greek_flow_expiry[:T]`, `futures_blocks[:SYM]`, `stock_screener`, `ta_1d_live:<T>` and the `sec:*` channels.
  - `net_flow` has no global form.
  - `quotes` is stock-only with no timestamp.
  - `futures_trades` is undocumented.
  - SPXW/NDXP/VIXW/RUTW folding.
- **Periscope facts:** up to 1024 rows/frame, ~1/min, shared timestamp, number-or-string values, net values (no call/put split), not on the REST scale, no REST/Kafka/backfill.
- **Footguns:**
  - `net_flow` doc says cumulative but the wire sends deltas.
  - `""` index `underlying_price`.
  - `executed_at` can be 0.
  - Bare error frames.
  - Off/lit trades ≥ $100K only.
  - greek_flow messages are partial sums.
  - `risk_reversal_skew` 04:00–16:00 ET.
- **Registered channels:** add `futures_trades` and the 4 new families.
- `user_agent_header` in the sketch.

- [ ] Commit (md only).
