# UW futures order flow — Phases 0 and 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Probe what UW's futures feed actually carries, then add per-minute aggressor buy/sell volume and print counts to `futures_bars`, written by `uw-stream` from data it already receives.

**Architecture:**
- **REST probes** run locally on the owner's key (REST is safe on a second host).
- **The websocket probe** is a temporary, deterministic-sampled log capture inside the prod `futures_trades` handler, removed after one session.
- **Order flow** rides in the existing completed-minute `futures_bars` INSERT (`ON CONFLICT DO NOTHING`), as four new nullable columns.

**Tech Stack:** Python 3 asyncio + asyncpg (`uw-stream/`, pytest + ruff), TypeScript (`api/_lib/db-migrations.ts`, vitest), Neon Postgres, Railway, UW REST + websocket.

**Spec:** `docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md` (Phases 0 and 2; decisions D1–D3). Phases 1, 3, 4, 5, 6 and 6b get their own plans after this one, informed by the probe results.

## Global Constraints

- **Railway timing:** no `uw-stream` push between 08:30 and 15:00 CT. Pushing `main` deploys Railway and Vercel; there's no manual CLI deploy.
- **Commits:** straight to `main`, staged by explicit path, chained `git add … && git commit` (see the `commit` skill). One implementer at a time.
- **Gates:**
  - Any `api/` change needs `npm run review` green, read from the log's `Test Files` line. Never trust a wrapper's exit code.
  - `uw-stream` changes need `ruff check`, `ruff format --check` and `pytest`, all green in `uw-stream/` (see `uw-stream/README.md`).
- **`futures_bars` writes stay `ON CONFLICT (symbol, ts) DO NOTHING`.** Never an accumulating `DO UPDATE`.
- **NULL vs 0:** `NULL` = unknown, `0` = known to be none.
- **The UW key never opens a second websocket.** Never print the UW key or `DATABASE_URL`; read them from `.env.local` without echoing.
- **Migration id** = the next free id in `api/_lib/db-migrations.ts` at build time (192 on 2026-10-28; parallel sessions take numbers).
- **UW sends numbers as JSON strings.** Parse with `_to_decimal` / `_to_int`, never compare raw strings.

## Review Focus

1. **Migration not yet applied when `uw-stream` deploys.** Every bar INSERT would fail, and every bar would be lost. Task 4 ends with a read-only `information_schema` check, and Task 5's deploy step is blocked on it.
2. **Websocket frames with no `side` key at all** (P1 may show this). The bar must write `NULL` buy/sell, not `0`. Pinned by Task 5's `test_bar_without_any_side_key_writes_null_flow`.
3. **A re-delivered copy of a counted print, arriving after its minute was evicted.** It must not add to the session tally or create a phantom bar. Pinned by Task 6's `test_print_for_emitted_minute_is_dropped`.
4. **A calendar-spread sym with the most raw volume.** It must never become the front month. Pinned by Task 5's `test_spread_print_never_wins_front_month`.
5. **Block frames on `futures_trades`** (`is_block: true`, `qty` but no `size`). They must be skipped quietly, without spamming `invalid_price_or_size`. Pinned by Task 5's `test_block_print_skipped_without_warning`.

---

### Task 1: REST probes P6, P3, P4, P7 (scratch; results into the spec)

**Files:**
- Create: `docs/tmp/uw-futures-probe/rest_probe.py` (gitignored scratch)
- Modify: `docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md` (append `## Probe results (0a)`)

**Interfaces:**
- Consumes: UW REST `/api/futures/contracts?days=5`, `/api/futures/{contract}/trades`, `/api/futures/{contract}/stats`, and a read-only Neon `futures_bars` query.
- Produces: settled D3, the P6 lookback (which settles D8), and P4 and P7 notes in the spec.

- [ ] **Step 1: Write `rest_probe.py`.**
  - Run it with `ml/.venv` Python. Send an explicit `User-Agent`, because UW 403s the Python-urllib default.
  - Read the key from `.env.local` into the `Authorization: Bearer` header.
  - Pick ES's and NQ's front contracts: the top non-spread contract by volume from `/futures/contracts`.
- [ ] **Step 2: P6, run first.**
  - **Lookback:** call `/futures/{ES front}/trades?limit=1&older_than=<D>T15:00:00Z` for D stepping back from 2026-09-29. Find the oldest D that returns rows; record whether the stop came from an empty page or `historic_data_access_missing`. Check the prior ES contract too, for dates before the roll.
  - **Page density:** count the 500-row pages (`skip_blocks=true`) needed to cover 14:30–14:31 UTC on the latest full session.
- [ ] **Step 3: P3 (side sanity).**
  - Pull 30 minutes of ES front prints from the latest RTH session.
  - Dedup by `trade_id`, drop `is_spread`, and sort by `executed_at`.
  - For prints whose price differs from the previous print, measure the share where `side` equals the tick-test call (up → `buy`, down → `sell`).
  - Also report the share with `side = none`.
- [ ] **Step 4: P4.** Compare the same window's deduped `sum(size)` per minute with `futures_bars.volume` (`symbol='ES'`) through a read-only query, and report the per-minute ratio.
- [ ] **Step 5: P7.** Record `/stats` output for the ES and NQ front contracts now, and write down the two re-check times (12:30 UTC tomorrow, and after 15:00 CT tomorrow).
- [ ] **Step 6: Write `## Probe results (0a)` in the spec.**
  - P6: earliest date and pages per minute.
  - P3: agreement %, `none` %.
  - P4: ratio.
  - P7: values and times.
  - **D3:** pass if agreement ≥ 75%. **If it fails, stop the plan here and report to the owner.** Task 5 must not start.
  - **D8:** whether Phase 6/6b moves up (lookback under about 60 days).
- [ ] **Step 7: Commit the spec only.** `docs(spec): Record the UW futures REST probe results`

### Task 2: Temporary websocket frame capture in the futures handler

**Files:**
- Modify: `uw-stream/src/handlers/futures_trades.py` (`enqueue`, `:203-221`; new constants and helper)
- Test: `uw-stream/tests/test_futures_trades_handler.py` (new `class TestFrameCapture`)

**Interfaces:**
- Produces:
  - `_CAPTURE_PRODUCTS: frozenset[str] = frozenset({"ES", "NQ"})`
  - `_CAPTURE_MODULO: int = 500`
  - `_maybe_capture(payload: dict, arrival_ms: int) -> None`: logs one `futures_capture` line, at info level, through the module's standard logger. Its `extra` is `{"arrival_ms": …, "payload": <the raw dict>}`, and it fires when `product in _CAPTURE_PRODUCTS` and `_to_int(trade_id) % _CAPTURE_MODULO == 0`.
  - Sampling is deterministic on `trade_id`, so **every copy** of a sampled print gets logged. P2 needs that.
  - It never raises: it is wrapped in `try/except Exception` that swallows, which is deliberate for a temporary diagnostic, with a comment saying so.
- Called from `enqueue` after the product filter, before `super().enqueue(payload)`.

- [ ] **Step 1: Write the failing tests** in `TestFrameCapture`:
  - `test_every_copy_of_a_sampled_trade_is_logged`: three identical payloads with `trade_id=1000` give three `futures_capture` records, each with `arrival_ms` and the full payload.
  - `test_unsampled_trade_not_logged`: `trade_id=1001` gives zero records.
  - `test_non_capture_product_not_logged`: `product="CL"`, `trade_id=1000` gives zero records.
  - `test_bad_trade_id_neither_logs_nor_raises`: `trade_id="x"` or a missing key gives zero records and no exception.
  - `test_capture_does_not_change_enqueue`: a sampled ES payload still reaches the queue (assert queue depth +1).
- [ ] **Step 2: Run** `pytest tests/test_futures_trades_handler.py -k FrameCapture -v`. Expected: FAIL (names undefined).
- [ ] **Step 3: Implement** the constants, `_maybe_capture`, and the call in `enqueue`. Take `arrival_ms` from `time.time()` at enqueue. Mark it with a `TEMPORARY (spec Phase 0b): remove after one RTH session` comment.
- [ ] **Step 4: Run** the handler test file, then `ruff check` and `ruff format --check`. Expected: all PASS.
- [ ] **Step 5: Commit, then push after 15:00 CT.** Once pushed, confirm `futures_capture` lines appear in the Railway `uw-stream` logs within about 5 minutes (Railway MCP `get-logs`, filter `futures_capture`). `feat(uw-stream): Capture sampled raw futures frames for one session`

### Task 3: Analyze the capture (P1, P2), then remove it

**Files:**
- Create: `docs/tmp/uw-futures-probe/analyze_capture.py` (scratch)
- Modify: `uw-stream/src/handlers/futures_trades.py`, `uw-stream/tests/test_futures_trades_handler.py` (remove Task 2's code and tests)
- Modify: the spec (`## Probe results (0b)`)

- [ ] **Step 1:** After one full RTH session plus its evening, pull the `futures_capture` lines from Railway logs into `docs/tmp/uw-futures-probe/capture.jsonl`.
- [ ] **Step 2: P1.** Census the payload keys across all frames, and record the presence % of `side`, `is_spread`, `crossed`, `event_ts_ns`, `event_size` and `event_levels`, and the `null` %.
- [ ] **Step 3: P2.** Per `(sym, trade_id)`:
  - the copy count
  - which keys differ between copies, with the first and last arrival gap
  - whether the event fields go from null to filled on a later copy
  - whether `side` ever differs
- [ ] **Step 4:** Write `## Probe results (0b)` with D1 (event fields present?) and D2 (do copies differ, and how?). **D1 decides whether Phase 3 gets a plan.**
- [ ] **Step 5:** Remove `_maybe_capture`, its constants, its call and `TestFrameCapture`. Run the handler tests and ruff.
- [ ] **Step 6:** Commit both (spec, then removal) and push after 15:00 CT. `chore(uw-stream): Remove the temporary futures frame capture`

### Task 4: Migration — order-flow columns on `futures_bars`

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append after the last entry; #191 is at `:5296`)
- Test: `api/__tests__/db.test.ts`

**Interfaces:**
- Produces: `futures_bars.buy_volume BIGINT`, `sell_volume BIGINT`, `buy_prints INTEGER` and `sell_prints INTEGER`, all nullable with no default.

- [ ] **Step 1: Update `db.test.ts` first, to the failing state.** The exact sites below are as of #191; they move with the latest migration.
  - Add `{ id: N }` to the applied-migrations mock (after `:625`).
  - Append `'#N: <description>'` to the expected list (after `:834`).
  - Add `+ 3 (#N: SET LOCAL lock_timeout+ALTER+INSERT)` to the arithmetic comment at `:839`, and raise `toHaveBeenCalledTimes` by 3.
  - Raise the `mockSql.transaction` count by 1.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/db.test.ts`. Expected: FAIL (count mismatch).
- [ ] **Step 3: Add the migration** with description `'Add aggressor order-flow columns to futures_bars (buy/sell volume and print counts). Nullable, no default: NULL = unknown (websocket outage, OHLC repair, rows before this migration).'`. Statements, mirroring #191's lock guard:
  - `sql\`SET LOCAL lock_timeout = '5s'\``
  - one `ALTER TABLE futures_bars ADD COLUMN IF NOT EXISTS buy_volume BIGINT, ADD COLUMN IF NOT EXISTS sell_volume BIGINT, ADD COLUMN IF NOT EXISTS buy_prints INTEGER, ADD COLUMN IF NOT EXISTS sell_prints INTEGER`
- [ ] **Step 4:** Run the db test (PASS), then the full `npm run review` (green per the log).
- [ ] **Step 5:** Commit and push. `feat(db): Add order-flow columns to futures_bars`
- [ ] **Step 6: Apply and verify.**
  - Once Vercel shows the deploy READY, the owner runs `POST /api/journal/migrate` while logged in.
  - Then a read-only query: `SELECT column_name FROM information_schema.columns WHERE table_name='futures_bars' AND column_name IN ('buy_volume','sell_volume','buy_prints','sell_prints')`. It must return 4 rows.
  - **Task 5 must not deploy until this returns 4 rows.**

### Task 5: Handler — aggressor side, spreads and blocks

**Files:**
- Modify: `uw-stream/src/handlers/futures_trades.py` (`_COLUMNS` `:98`, `_Print` `:126-141`, `_Bar` `:144-172`, `_transform` `:226-291`, `_ingest` `:317-376`, `_collect_completed` `:419-429`)
- Test: `uw-stream/tests/test_futures_trades_handler.py` (`_print()` gains `side`, `is_spread` and `is_block` kwargs; new `class TestOrderFlow`)

**Interfaces:**
- Consumes: Task 4's columns, which must already exist in prod.
- Produces:
  - `_COLUMNS = ["symbol","ts","open","high","low","close","volume","buy_volume","sell_volume","buy_prints","sell_prints"]`
  - `_parse_side(raw: object) -> str | None` returns `"buy"`, `"sell"` or `"none"` for those exact strings (UW docs: case-sensitive) and `None` for anything else, including an absent key.
  - `_Print` gains `side: str | None`.
  - `_Bar` gains `buy_volume: int = 0`, `sell_volume: int = 0`, `buy_prints: int = 0`, `sell_prints: int = 0`, `side_seen: bool = False`.
  - `_Bar.add(price, size, executed_at, side)`.
  - The emitted row's flow fields are `None` when `side_seen` is False; otherwise the four counts.

- [ ] **Step 1: Write the failing tests** in `TestOrderFlow`. Each uses `_flush_capture` and indexes rows with `_C`.
  - `test_buy_sell_split`: in one minute, buy size 2, sell size 3 and none size 1, then one next-minute print gives `volume=6, buy_volume=2, sell_volume=3, buy_prints=1, sell_prints=1`.
  - `test_bar_without_any_side_key_writes_null_flow`: prints with no `side` key give all four flow columns `None`, with OHLCV unchanged.
  - `test_all_none_side_writes_zero_flow`: every print with `side="none"` gives 0/0/0/0.
  - `test_duplicate_copy_counts_side_once`: the same `trade_id` twice, the second copy with the opposite side, counts only the first.
  - `test_spread_print_never_wins_front_month`: a spread sym `ESZ6-ESH7` with size 1000 and `is_spread=True`, plus `ESZ6` size 5, writes the bar from `ESZ6` with `volume=5`.
  - `test_block_print_skipped_without_warning`: `is_block=True` with no `size` returns `None` from `_transform`, and `rate_limited_log.warning` is not called (patch it, as the existing tests do around `:917-926`).
  - `test_row_arity_matches_columns` (existing, `:164`) keeps passing with 11 columns.
- [ ] **Step 2:** Run `pytest -k "OrderFlow or row_arity" -v`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **`_transform`:** return `None` quietly when `payload.get("is_spread") is True` or `payload.get("is_block") is True`, before the price/size validation. Parse `side` via `_parse_side`.
  - **`_Bar.add`:** set `side_seen` when `side is not None`, and count buy/sell.
  - **`_ingest`:** pass `side`; dedup stays first, so the first copy wins.
  - **`_collect_completed`:** append the four values, or `None × 4`.
  - **Comments:** update the module docstring's sample payload and filtering list (`:8-40`) to describe spread/block skipping and the flow columns.
- [ ] **Step 4:** Run the full handler test file, `ruff check` and `ruff format --check`. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(uw-stream): Write aggressor buy/sell volume on futures bars`. **Push after 15:00 CT, and only after Task 4 Step 6 returned 4 rows.**
- [ ] **Step 6: Verify** after the next completed minute with a read-only query: `SELECT ts, volume, buy_volume, sell_volume FROM futures_bars WHERE symbol='ES' ORDER BY ts DESC LIMIT 5`. New rows have non-NULL flow (or NULL if P1 showed no `side` on websocket frames), and `buy_volume + sell_volume <= volume`.

### Task 6: Handler — drop prints for already-emitted minutes; flush-failure test

**Files:**
- Modify: `uw-stream/src/handlers/futures_trades.py` (`__init__` `:180-198`, `_ingest`, `_collect_completed`)
- Test: `uw-stream/tests/test_futures_trades_handler.py` (new `class TestLatePrints`, `class TestFlushFailure`)

**Interfaces:**
- Produces: `self._emitted_through: dict[str, datetime]`, the newest minute emitted per product. `_ingest` returns early, **before the dedup and the tally**, when `print_.minute_ts <= self._emitted_through.get(product)`.

**Why:** today such a print, usually a late re-delivered copy whose `_seen` set was already evicted, bypasses dedup. It inflates the session tally, builds a one-print bar that `DO NOTHING` discards, and can log a false `front_sym_absent`.

- [ ] **Step 1: Write the failing tests.**
  - `test_print_for_emitted_minute_is_dropped`: emit minute 05:56, then flush a copy of a 05:56 print. No row is written for 05:56, the session tally is unchanged (assert `handler._session_volume`), and no `front_sym_absent` warning appears.
  - `test_late_drop_is_logged_at_info_rate_limited`: the drop goes through `rate_limited_log.info` with kind `late_print_dropped`, carrying a running count, and never through `warning`.
  - `test_db_reject_is_surfaced`: `bulk_insert_ignore_conflict` raises inside `Handler._safe_flush`. `capture_exception` is called with `tags["channel"] == "futures_trades"`, `write_count` is unchanged, and the drain loop survives. This pins the existing base behaviour (`handlers/base.py:330-339`); no re-queue, by the spec's YAGNI call.
- [ ] **Step 2:** Run `pytest -k "LatePrints or FlushFailure" -v`. Expected: the first two FAIL. The third may already pass; if so, keep it as a regression pin.
- [ ] **Step 3: Implement** `_emitted_through` (set in `_collect_completed` for each emitted or skipped minute) and the early return in `_ingest`. If `rate_limited_log` has no `info`, use the logger the module already uses for info lines, rate-limited the same way.
- [ ] **Step 4:** Run the full handler file and ruff. Expected: PASS.
- [ ] **Step 5: Commit**, then push together with Task 5 after 15:00 CT. `fix(uw-stream): Drop futures prints for minutes already written`

---

**Execution order:**
1. **Task 1 now.** Its D3 result gates Task 5.
2. **Task 2:** code now, deploy after the next 15:00 CT.
3. **Task 4:** any time, then apply and verify.
4. **Tasks 5 and 6:** code, then deploy after 15:00 CT once Task 4 is verified.
5. **Task 3:** after one captured session; its D1 decides whether Phase 3 gets a plan.

Tasks 2, 5 and 6 can share one after-close deploy.
