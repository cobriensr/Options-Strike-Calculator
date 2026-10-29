# UW futures order flow, block trades and session stats — design

**Date:** 2026-10-28 · **Status:** design, not built · **Scope approved by owner:** 2026-10-28 (conversation)

## Goal

Stop throwing away the CME futures data Unusual Whales already sends us. That means:

- per-minute aggressor buy/sell volume (and sweeps) on the futures we already bar
- CME block trades
- daily settlement and open interest
- gap repair for the new columns

Together these let the owner test whether futures order flow helps 0DTE SPX decisions, with no new vendor.

## Why

- **Owner rule (2026-10-28):** fill futures gaps from UW. Never Databento, because of its price creep and package splitting. See memory `no-databento-uw-first-futures`.
- **We already receive the data and drop it.** `uw-stream/src/handlers/futures_trades.py` gets `side` (UW docs: "aggressor side") and `nbbo_bid`/`nbbo_ask` on every print, and drops them in `_transform` (`:226-291`). The `_Print` tuple (`:126-141`) has no slot for them.
- **The old NQ OFI needs nothing more than `side`.** The analyze prompt carried an NQ order-flow-imbalance signal until 2026-09-30. It was plain signed aggressor volume: `buy_vol`/`sell_vol` from trade side (`ml/src/features/microstructure.py:346-347`), and OFI = (buy − sell) / (buy + sell) over 5/15/60-min windows (`:427-432`). No quote sizes are involved, so UW's `side` can rebuild it.
- **That signal was never shown to predict anything.** Its ρ = 0.31 compared full-UTC-day OFI with the same day's open→close return (`ml/src/microstructure_eda.py:217,311,729,742`). That measures what happened during the day, not what comes next. Phase 1 tests prediction properly, on data we already hold.
- **UW prints carry more than the old feed.** Live REST prints from `/api/futures/flow` (probed 2026-10-28) also carry:
  - `is_spread`
  - `crossed`
  - the match-event fields `event_ts_ns`, `event_size` and `event_levels`. These group the separate fills of one aggressive order. Example: one MNQ buyer took 5 contracts across 3 price levels in a single match.

## Goals

1. Add per-minute buy volume, sell volume, and buy/sell print counts to every `futures_bars` row the websocket writes, for all six roots (ES, NQ, RTY, CL, GC, ZN). Calendar spreads are excluded.
2. Add per-minute sweep counts and sweep volume by side, but only if the websocket frames carry the match-event fields (decision D1).
3. Store CME block trades as they arrive, applying UW's updates and deletes.
4. Store daily settlement, open interest and session volume for each active contract.
5. Repair gaps in the new order-flow columns from UW REST, alongside the existing OHLC repair.
6. Run a point-in-time test of OFI as a predictor on the ES/NQ ticks already in Neon.

## Non-goals

- **No UI and no analyze-prompt wiring.** These guard tests stay as they are: `api/__tests__/analyze-prompts.test.ts:42-47` (`not.toMatch(/\bOFI\b/)`), `analyze-context.test.ts:756-804` and `analyze-calibration.test.ts:56`. Wiring is a follow-up spec, gated on Phase 1.
- **No per-print storage.** Prints run to millions of rows a day, so only per-minute aggregates are stored.
- **No order-book depth, DX, VX or ES options.** UW carries none of them. VX was also shown redundant on 2026-10-28 (memory `vx-curve-redundant`).
- **No new data vendor.**

## Anti-goals (failure even if it technically works)

- **Order-flow columns reading `0` when the truth is "unknown".** This covers minutes inserted by the OHLC repair, websocket outages and older rows. Unknown must be `NULL`.
- **Double-counted volume.** UW re-delivers every print 2–11× (`futures_trades.py:37-40`), and a failed batch gets retried. Neither may inflate the counts.
- **A uw-stream crash loop from deploy order.** Every channel would go dark.
- **Showing the trader an OFI number before it passes a point-in-time test.**
- **Unguarded readers.** Any reader built later on these tables serves UW data, so it must be at least `owner-or-guest` (CLAUDE.md data-licensing rule).

## Constraints the code imposes

- **`futures_bars` is first-write-wins.** The write is `INSERT … ON CONFLICT (symbol, ts) DO NOTHING` (`uw-stream/src/db.py:179,316`), and `_with_db_retry` re-runs whole batches (`db.py:323-325`). The new columns must ride in the same INSERT row. Never use an accumulating `DO UPDATE SET buy = buy + EXCLUDED.buy`.
- **Completed-minute rule.** The handler writes a minute only once a newer minute arrives for that product, then evicts its state (`futures_trades.py:398-467`).
- **Late prints are discarded.** A print arriving after its minute was evicted is lost by design. That's acceptable; don't try to recover it.
- **Eviction happens before the insert is awaited** (`:306-315`). If the insert fails after retries, `Handler._safe_flush` reports it: `capture_exception` plus `log.error` (`handlers/base.py:330-339`). The drain loop survives, but the evicted bars are lost. No futures test pins this today; Phase 2 adds one.
- **The OHLC repair inserts OHLCV only.** That is `api/cron/backfill-futures-gaps.ts:308-320`, also first-write-wins. A `NULL` order-flow column is not a gap to that cron's LEAD query (`:154-178`).
- **`futures_bars` has no contract column.** The front month is the contract with the highest deduped session volume (argmax, `futures_trades.py:372`). The repair replays that same rule (`backfill-futures-gaps.ts:260-298`).
- **Spread contracts can win the front-month argmax today.** A spread sym is a separate symbol, and nothing guards against this.
- **Schema lives in API migrations** in `api/_lib/db-migrations.ts`, not `uw-stream/sql/`. The latest is #191 as of 2026-10-28, but parallel sessions take numbers, so check at build time. Each migration needs the `api/__tests__/db.test.ts` updates listed in CLAUDE.md.
- **Deploy order for a new channel:**
  1. API migration, pushed.
  2. uw-stream code with the handler, pushed after 15:00 CT (no Railway pushes 08:30–15:00 CT).
  3. Confirm the service is healthy.
  4. Only then add the channel to Railway `WS_CHANNELS`.

  Reversing steps 2 and 4 crashes the service at import: `Settings()` at `config.py:498` → `_validate_channels_known` (`:312-338`). That happens before Sentry init, so it is invisible, and it repeats until Railway's 10 restarts run out. A name in `EXACT_CHANNEL_NAMES` but missing from the `exact` dict also crashes (`main.py:89-97`).
- **The router forwards `{"error": …}` frames to handlers** and marks the channel alive (`router.py:102-138`). New handlers must reject them loudly.
- **Websocket over REST (CLAUDE.md, 2026-10-28).** Settlement stats have no channel, so REST is fine. Order-flow repair counts as gap repair, so REST is fine. Live flow comes only from the websocket.
- **Implementation process.** One implementer stream at a time, subagent-driven, `npm run review` and code-reviewer per phase, then commit and push straight to `main`.

## Phases

Each phase ships on its own. Order: 0 → 1 (research; can run alongside 2) → 2 → 3 (only if D1) → 4 → 5 → 6 → 6b. Per D8, Phases 6 and 6b move up to right after Phase 2 if UW's REST lookback turns out short.

### Phase 0: Probe the feed (no production code, ~1 session)

**Method.** Scratch scripts go under `docs/tmp/uw-futures-probe/` (gitignored). The probe has two parts.

- **0a: REST probes (P3, P4, P6, P7).** These can run now with the prod key, since REST is fine on a second host; only the websocket is restricted.
  - P3 and P4 use `/futures/flow` and `/futures/{c}/trades` prints. They carry the same `side` and `trade_id` as the websocket.
  - **Run P6 first.** UW's REST lookback decides how much of the one-time backfill (Phase 6b) is still reachable, and the oldest sessions age out every day.
- **0b: websocket probes (P1, P2, P5).** These need live frames from `futures_trades` and `futures_blocks`.
  - **The owner has one UW API key** (2026-10-28), so capture inside prod `uw-stream` on its existing connections. Never open a second websocket on that key: it drops prod's sockets (memory `uw-ws-token-single-machine`).
  - **P1 and P2:** a temporary sampled raw-frame capture in prod `uw-stream`, deployed after 15:00 CT and removed after one full session.
    - It must record every copy of a sampled `(sym, trade_id)` with its arrival time, so P2 can diff the re-deliveries.
    - One way is to extend the existing `ws_log_sample_rate` sampling in `uw-stream/src/router.py`.
    - It must not touch the bar path.
    - It ships through the normal loop: tests, review, and the Railway deploy after the close.
  - **P5** moves into Phase 4. Its first deploy runs the `futures_blocks` handler and records the census, following the normal deploy order.

| # | Question | How | Decides |
|---|---|---|---|
| P1 | Do websocket `futures_trades` frames carry `is_spread`, `event_ts_ns`, `event_size`, `event_levels`, `crossed`? The 2026-09-08 sample (`futures_trades.py:10-14`) had none of them. | Field census over captured frames | D1 |
| P2 | Do re-deliveries of the same `(sym, trade_id)` differ? Do the event fields fill in on a later copy? Does `side` ever change? | Diff successive copies per key; record the field and time gap | D2 |
| P3 | Is `side` the aggressor side? | On prints where price changed from the previous print in the same sym, measure agreement with the tick test. Measure the share of `side = none`. Do **not** reclassify with `nbbo`, which looks post-trade or stale: a sell printed at the ask in the 09-08 sample, and a buy above the ask in the 10-28 REST probe. | D3 |
| P4 | Does deduped probe volume match `futures_bars.volume` for the same minutes? | Compare per minute for ES/NQ | sanity |
| P5 | Block-trade rate per session, `action` mix, products, MLEG share | Census of `futures_blocks` frames | D4 |
| P6 | How far back REST `/futures/{c}/trades` reaches, and how many 500-row pages one ES RTH minute takes | Page back with `older_than` until `historic_data_access_missing` or an empty page | Phase 6 limits |
| P7 | When `/futures/{c}/stats` rolls `settlement_date`, and when `open_interest` changes | Call it at a few times around the close and the next morning | Phase 5 schedule |

**Output:** a "Probe results" section appended to this doc, with D1–D4 filled in.

### Phase 1: Point-in-time OFI test on stored ticks (read-only research, ~½ day)

**Data (my call).** There are two Databento-era sources, and they classify side differently.

1. **Discovery set: the 1-year TBBO archive**, 2025-04-20 → 2026-04-17, ES + NQ, about 210M trades, 312 sessions.
   - It uses the **exchange aggressor side** (`side = 'B'/'A'`, `ml/src/features/microstructure.py:346-347`). That is the same kind of field as UW's `side`, so a result here speaks to the UW data.
   - It is not on this machine (`ml/data/archive/` has no `tbbo/`). It is probably still in the private Vercel Blob store: `scripts/upload-archive-to-blob.mjs` ships `tbbo/`, and the purge follow-up in `databento-removal-2026-09-29.md` is still open.
   - Pull it once, about 3.9 GB, into gitignored `ml/data/`.
   - **Don't purge the Blob copy until Phase 1 is done.**
2. **Hold-out: `futures_trade_ticks` in Neon**, 2026-04-20 → 2026-06-15, ES + NQ, about 32M rows, about 40 sessions.
   - It starts right after the archive ends.
   - Its `aggressor_side` is a **different variable**: price vs the pre-trade bid/ask (`classify_aggressor` in the removed `sidecar/src/quote_processor.py`, at commit `185a1c35^`), not the exchange flag. Treat agreement there as supporting evidence only.
   - If the archive is gone, run on Neon alone and state the power limit. With about 40 days, a once-per-day test needs |ρ| ≈ 0.31 before its CI excludes 0. With 312 days the bar is about 0.11.

Other settings:
- Restrict to RTH, 08:30–15:00 CT.
- Outcomes come from the archive's own trades (discovery) and from ES/NQ `futures_bars` (hold-out).

**Tests.** Use the `statistical-analysis` skill: Spearman, a day-block bootstrap, and BH across the full test set.
1. **Rolling.** OFI over [t − W, t] for W ∈ {5, 15, 60} min, with t on a 5-min grid from 09:00 to 14:30 CT. Outcomes are the return over t → t+15, t → t+60 and t → 15:00.
2. **Cumulative.** OFI from 08:30 to t, for t ∈ {09:00, 10:00, 11:00, 12:00}, against the return from t to 15:00.
3. **Control.** The same-window (contemporaneous) correlation, to show how much of the old 0.31 was the day describing itself.
4. **Stability.** Each test separately on the first and second half of the sessions.

**Gate (D5, my call; owner may change).** Recommend a follow-up "wire OFI" spec only if three things hold for at least one predictive configuration, on ES or NQ, in the discovery set:
- |ρ| ≥ 0.10 with a 95% CI excluding 0
- BH q < 0.10
- the same sign in both halves

Definitions:
- **Predictive** means the OFI window ends where the outcome window starts: the OFI is over [t − W, t] or [08:30, t], and the outcome over [t, …]. Overlap between consecutive grid points is allowed; the day-block bootstrap absorbs it.
- **One ρ per configuration**, pooled across grid times. A configuration is window × horizon × symbol × test type. The BH family is all those configurations, not one per time of day.
- **The once-per-day test** (test 2) gives one observation per day per t.

Otherwise record a null, keep collecting UW flow, and re-test after 60 UW sessions.

**Output:**
- Scripts and findings in `docs/tmp/ofi-pit-study/`, plus a findings doc under `ml/docs/`.
- Correct the overstatement in `ml/docs/MICROSTRUCTURE-OFI-FINDING.md:49` ("predicts same-day return"). It was a same-day correlation.
- Correct the claim in `docs/superpowers/specs/futures-uw-migration-2026-09-08.md` that ρ came from `futures_top_of_book`. It came from TBBO trade side.
- Update memory `microstructure-signal-finding`.

### Phase 2: Order-flow columns on `futures_bars` (~1 day)

**Migration:**
```sql
ALTER TABLE futures_bars
  ADD COLUMN IF NOT EXISTS buy_volume  BIGINT,
  ADD COLUMN IF NOT EXISTS sell_volume BIGINT,
  ADD COLUMN IF NOT EXISTS buy_prints  INTEGER,
  ADD COLUMN IF NOT EXISTS sell_prints INTEGER;
```
- The columns are nullable with no default. `NULL` means unknown; `0` means known to be none.
- Existing rows stay `NULL`.
- All readers select named columns, so nothing breaks. The readers were audited 2026-10-28; none uses `SELECT *`, positional mapping or a strict Zod schema.

**Handler** (`futures_trades.py`):
- `_Print` gains `side` and `is_spread`, and the event fields too if D1 says they're present.
- **Spread prints (`is_spread = true`) are excluded** from bars, from order flow and from the front-month argmax. This closes the existing hole.
- **`side` buy or sell** adds to the matching buy/sell volume and print count. **`none` or missing** counts only toward `volume`, as today. So buy + sell ≤ volume, and the remainder is unclassified.
- Accumulate after the `(sym, trade_id)` dedup, for the front contract only. Write under the same completed-minute rule, in the same INSERT row (extend `_COLUMNS` at `:98`), with the same `DO NOTHING`.
- If D2 shows re-delivered copies disagree on `side`, keep the first copy and count disagreements in a metric (my call).
- **Restart and reconnect boundary minutes keep their partial flow (my call).** Today these minutes are already written with partial OHLCV: a deploy starts mid-minute, and handler state survives socket reconnects. Memory `uw-stream-disconnects-2026-10-28` counts 50–260 drops a day.
  - **Why accept it:** OFI is a ratio, so a partial minute adds noise, not bias. Window sums undercount slightly.
  - **Why not the alternatives:**
    - Writing NULL flow for Phase 6 to refill breaks buy + sell ≤ volume, because REST would cover the full minute while `volume` is partial.
    - Skipping the bar changes existing OHLCV behaviour.
    - Both would also need a reconnect signal passed from the connector to the handler, which doesn't exist.

**Adjacent fixes in the same phase** (fix-now rule):
- **Pin flush-failure surfacing with a test (R4).** The base handler already reports it to Sentry. There's no re-queue (my call, YAGNI): the loss is visible, and the OHLC repair refills those minutes.
- **Drop prints for minutes already emitted, before the dedup and the tally.** Today a late re-delivered copy, whose dedup set was already evicted, bypasses dedup. It inflates the front-month session tally, builds a one-print bar that `DO NOTHING` discards, and can log a false `front_sym_absent`.
- **Skip `is_block` frames on `futures_trades` quietly.** They carry `qty` but no `size`/`side`, so today they log `invalid_price_or_size`. Phase 4 stores blocks properly.

**Tests:**
- uw-stream pytest using the existing `_print()` builder (`uw-stream/tests/test_futures_trades_handler.py:69-91`, which already includes `side`/`nbbo`/`is_block`) and the `_flush_capture` capture (`:99-112`).
- Cover: buy/sell split, the `none` side, spreads excluded from bars and argmax, dedup across re-deliveries, retried batch not double-counted, DB reject surfaced.
- `db.test.ts` updates for the migration.

**Deploy:** migration first (Vercel push), then uw-stream after 15:00 CT.

### Phase 3: Sweeps (only if D1 = yes, ~½ day)

**Columns:**
- `buy_sweeps INTEGER`
- `sell_sweeps INTEGER`
- `buy_sweep_volume BIGINT`
- `sell_sweep_volume BIGINT`
- `max_event_size INTEGER`: the largest single aggressive order in the minute

**Rules:**
- **Definition:** a sweep is one CME match event, keyed `(sym, side, event_ts_ns)`, with `event_levels ≥ 2`. That is UW's own definition (the `sweeps_only` filter on `/futures/flow`). No tuning.
- **Count each event once**, not once per fill.
- **Event fields arrive "once the event is complete"** (UW docs). If D2 shows they arrive on a later re-delivered copy, the dedup must merge the later copy's event fields into the stored print instead of discarding the copy. This must still never re-add size.
- **If D1 = no,** drop this phase from the websocket path. Deriving sweeps from REST is out of scope.

### Phase 4: `futures_blocks` channel (~1 day)

**Table** (migration):
- Keys and contract: `trade_id`, `exchange`, `trade_date DATE`, `sym`, `product`, `sec_type` (`FUT` or `MLEG`).
- Message state: `action` (`new`, `update` or `delete`).
- Trade: `price NUMERIC(12,4)` (null for MLEG), `qty NUMERIC`.
- Times: `executed_at`, `reported_at TIMESTAMPTZ`.
- Strategy: `strategy_link_id`, `legs JSONB`.
- Quote: `quote_bid`, `quote_ask`, `quote_ts`.
- Bookkeeping: `updated_at TIMESTAMPTZ`.
- Constraint: `UNIQUE (trade_id, exchange, trade_date)`.

**Writes are upserts.** UW's newest message replaces earlier ones (`futures-block-trades.md`). This is the one table where `DO NOTHING` is wrong.
- Use `ON CONFLICT … DO UPDATE … WHERE EXCLUDED.reported_at >= futures_blocks.reported_at`.
- **`delete` is stored as a row state.** Never hard-delete.
- This needs a new upsert helper in `uw-stream/src/db.py`; the existing helper only ignores conflicts.

**Handler** (`uw-stream/src/handlers/futures_blocks.py`):
- Reject `{"error": …}` frames loudly: one Sentry event per connection. Joining without access returns one.
- Store every product UW sends, unless P5 shows high volume. In that case filter to the six roots plus MLEGs with a leg in them (D4).
- **Register the channel in both places** in `channel_registry.py`: `EXACT_CHANNEL_NAMES` (`:38-50`) and the import plus `exact` dict (`:114-140`). The docstring's "one-line entry" claim is wrong; fix it.

**Sharding:**
- `futures_blocks` is global, so it folds into the first shard with room (`config.py:469-476`, `PER_CONN_MAX = 45` at `:155`).
- Before enabling it, check prod `WS_CHANNELS`. The planned `news` and `trading_halts` channels compete for the same slots (D6), and each extra shard costs one of roughly 10 connections.
- The builder check on 2026-10-28 counted 3 global channels today. With 86-ticker families, the second shard has 41 channels and 4 free slots. So `futures_blocks` fits, and so do `news` and `trading_halts`, if prod `WS_CHANNELS` matches the repo.
- Block rows carry `qty` and no `size`/`side`, so they add nothing to buy/sell volume. `futures_trades` frames with `is_block = true` stay excluded from order flow.

**Deploy:** follow the order in Constraints exactly.

### Phase 5: Daily session stats (~½ day)

- **REST only;** there is no websocket channel.
- **New cron** `api/cron/fetch-futures-session-stats.ts`, using `withCronInstrumentation(…, { marketHours: false })`.
- **Calls:**
  1. `/futures/contracts?days=5` once.
  2. Per root, take the top 2 non-spread contracts by volume. Use the same selection as `backfill-futures-gaps.ts:205-218`, extracted into a shared helper, not copied.
  3. `/futures/{contract}/stats` for each (12 calls).

**Table `futures_session_stats`:**
- Identity: `contract`, `product`, `settlement_date DATE`.
- Values: `settlement NUMERIC(12,4)`, `open_interest BIGINT`, `session_volume BIGINT`, `session_high`/`session_low NUMERIC(12,4)`.
- Bookkeeping: `fetched_at TIMESTAMPTZ`.
- Constraint: `UNIQUE (contract, settlement_date)`.
- Upsert with `DO UPDATE`, because open interest can finalize after settlement.

**Schedule:**
- **Default:** once at 12:30 UTC, Tue–Sat. That captures the prior session's settlement and its CME open interest.
- The endpoint has no date parameter and returns only the latest session, so history builds only by recording daily.
- Adjust after P7.

**Registration:**
- `vercel.json` crons and `SCHEDULE_MAP` in `api/_lib/cron-schedules.ts` (cross-checked by `cron-schedules.test.ts`).
- Axiom metadata uses existing top-level keys only; everything else goes in `meta`.
- No `src/main.tsx` protect-list entry is needed, because crons don't call `checkBot`.
- A failed write must not report `success` (R4).

### Phase 6: Order-flow gap repair (~1 day)

**Detect:** `futures_bars` rows in the same 3-UTC-day window as the OHLC repair where `buy_volume IS NULL` and the minute is Globex-open (`isFuturesMarketOpen`). Group them into contiguous ranges.
- This catches minutes the OHLC repair just inserted.
- It also catches websocket-written minutes from before the Phase 2 deploy, if inside the window.

**Fetch:**
- Page back over each range with `/futures/{contract}/trades?skip_blocks=true&limit=500&older_than=…`.
- Pick the contract with the shared roll replay (`backfill-futures-gaps.ts:260-298`).
- Dedup on `trade_id`, drop `is_spread`, and split by `side` per minute.

**Write** (batched with `unnest`, R5):
```sql
UPDATE futures_bars AS b SET buy_volume = t.buy, sell_volume = t.sell, buy_prints = t.bp, sell_prints = t.sp
FROM unnest(…) AS t(ts, buy, sell, bp, sp)
WHERE b.symbol = $sym AND b.ts = t.ts AND b.buy_volume IS NULL
```
This is a conditional update: idempotent, and it never overwrites websocket data.

**Bounds:**
- At most 600 pages per run, oldest range first.
- Re-runs resume naturally, because detection is the NULL check.
- Ranges older than UW's lookback (P6) are counted as unrepairable in a metric, not retried forever.

**Placement:** a second pass in `backfill-futures-gaps.ts`, after the OHLC pass, so new OHLC rows get flow in the same run (default). The builder may split it into its own cron if the file grows unwieldy.

**Limits, accepted:**
- Sweep columns stay `NULL` on repaired minutes, because REST `/trades` has no event fields.
- Minutes with partial websocket flow (late prints lost) can't be detected.

### Phase 6b: One-time history backfill of order flow (my call, from the owner's "pull everything we can")

- **What:** fill `buy_volume`/`sell_volume`/`buy_prints`/`sell_prints` on the websocket-written `futures_bars` rows from 2026-09-29 (the start of UW futures) to the Phase 2 deploy. That is about 22+ sessions; without this they stay `NULL` forever. It brings the "re-test after 60 UW sessions" date about a month closer.
- **How:**
  - A script, `scripts/backfill-futures-flow.mjs YYYY-MM-DD [YYYY-MM-DD …]`, following the repo's `scripts/backfill-*.mjs` pattern.
  - Same aggregation, roll replay and conditional `UPDATE … WHERE buy_volume IS NULL` as Phase 6, through a shared module, not a copy.
  - Oldest-at-risk dates first. A page budget per run, with progress logs, resumable through the NULL check.
- **Limits:**
  - It goes only as far back as UW's REST lookback (P6).
  - Its cost is pages per session (P6 measures it; ES alone is probably thousands of 500-row pages a session).
- **Timing (D8):** if P6 shows a lookback under about 60 days, the oldest sessions are aging out. In that case build Phase 6 and 6b right after Phase 2's migration ships, ahead of Phases 3–5. Otherwise keep the normal order.

## Files by phase

| Phase | Create | Modify |
|---|---|---|
| 0 | `docs/tmp/uw-futures-probe/*` (gitignored) | this doc (probe results); temporarily `uw-stream/src/router.py` + its test (0b capture, reverted after one session) |
| 1 | `docs/tmp/ofi-pit-study/*`, `ml/docs/OFI-POINT-IN-TIME-<date>.md` | `ml/docs/MICROSTRUCTURE-OFI-FINDING.md`, `docs/superpowers/specs/futures-uw-migration-2026-09-08.md` |
| 2 | — | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `uw-stream/src/handlers/futures_trades.py`, `uw-stream/tests/test_futures_trades_handler.py` |
| 3 | — | same four as Phase 2 |
| 4 | `uw-stream/src/handlers/futures_blocks.py`, `uw-stream/tests/test_futures_blocks_handler.py` | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `uw-stream/src/channel_registry.py`, `uw-stream/src/db.py` (≤ 5 per commit; split if needed) |
| 5 | `api/cron/fetch-futures-session-stats.ts`, `api/__tests__/fetch-futures-session-stats.test.ts`, shared contract-selection helper in `api/_lib/` | `api/_lib/db-migrations.ts`, `api/__tests__/db.test.ts`, `vercel.json`, `api/_lib/cron-schedules.ts`, `api/cron/backfill-futures-gaps.ts` (use the helper) |
| 6 | shared flow-aggregation module in `api/_lib/` | `api/cron/backfill-futures-gaps.ts`, `api/__tests__/backfill-futures-gaps.test.ts` |
| 6b | `scripts/backfill-futures-flow.ts`, `scripts/_lib/futures-flow-backfill.ts` (+ test) | `tsconfig.scripts.json` |
| 6c | `api/cron/repair-futures-blocks.ts` (+ tests) | `vercel.json`, `api/_lib/cron-schedules.ts` |

## Data dependencies

- **Migrations:**
  - ALTER `futures_bars` (Phase 2, and Phase 3 if D1)
  - CREATE `futures_blocks` (Phase 4)
  - CREATE `futures_session_stats` (Phase 5)
- **Env:**
  - Railway `WS_CHANNELS` gains `futures_blocks` (Phase 4, last step).
  - No new env vars.
  - The Phase 0 websocket probe runs inside prod `uw-stream` on its existing key. The REST probes use the same key from a local script; it's read from `.env.local` and never printed or committed.
- **UW access:** all endpoints used are on the Advanced tier, which the owner has.
  - Websocket: `futures_trades` (existing), `futures_blocks` (new)
  - REST: `/futures/contracts`, `/futures/{c}/stats`, `/futures/{c}/trades`
- **Existing data for Phase 1:**
  - The 1-year TBBO archive in the private Vercel Blob store (discovery set). It needs `BLOB_READ_WRITE_TOKEN`, which is already in the env table.
  - `futures_trade_ticks` in Neon (ES and NQ, 2026-04-20 to 06-15; hold-out). It was kept after the Databento removal, and nothing writes to it.

## Decisions

| # | Decision | Default | Settled by |
|---|---|---|---|
| D1 | Websocket frames carry the match-event fields? | Unknown; Phase 3 only if yes | P1 |
| D2 | Re-deliveries differ? | First copy wins; merge only event fields (Phase 3) | P2 |
| D3 | Is `side` trustworthy? | Stop Phase 2 and report if tick-test agreement on price-changing prints is < 75% (my call) | P3 |
| D4 | Block storage scope | All products UW sends; filter only if volume is high | P5 |
| D5 | OFI research gate | As in Phase 1 (my call) | owner may change |
| D6 | Shard room for `futures_blocks` plus the planned `news`/`trading_halts` | Check prod `WS_CHANNELS` before enabling | Phase 4 |
| D7 | Repair scope | All six roots (owner: "pull everything we can"), ES/NQ first | — |
| D8 | When Phase 6/6b run | Right after Phase 2's migration if UW's REST lookback is under about 60 days; otherwise the normal order | P6 |

## Owner answers

| # | Question | Answer (2026-10-28) |
|---|---|---|
| Q1 | Is there a second UW API token for the websocket probe (P1, P2, P5)? | No, there is one key. The websocket probe runs inside prod `uw-stream` (Phase 0b), and the block census moves into Phase 4's first deploy. |

## Thresholds and constants

- **Sweep:** `event_levels ≥ 2` (UW's definition). Any large-sweep size threshold is follow-up research.
- **OFI research** (kept from the old study for comparability; research-only, not shipped):
  - windows of 5/15/60 min
  - a floor of 20 contracts per window
  - "extreme" means |OFI| > 0.3
- **Repair:** the same 3-UTC-day window as the OHLC repair, 500 rows per page (UW's max), at most 600 pages per run.
- **Session stats:** the top 2 contracts per root.

## Left to the builder

- Exact column and metric names.
- Helper extraction and file splits, within the 5-files-per-commit rule.
- Test layout.
- (Settled in the plan: no re-queue of failed `futures_bars` flushes. The failure is already reported to Sentry.)
- Whether Phase 6 lives inside `backfill-futures-gaps.ts` or in a sibling cron.

## Probe results (0a): REST, 2026-10-28 evening

All read-only, about 600 calls. Scripts and outputs are in `docs/tmp/uw-futures-probe/` (gitignored).

- **P6 lookback.** UW futures REST history starts **2026-06-30T18:06Z for ES** (ESU6) and 2026-07-21 for NQ and the other roots. The edge returns an empty page, not a 403; a 403 `historic_data_access_missing` appears only before the token's 2-year window (2023-11-29). The start differs by root, so it is a **fixed archive start, not a rolling window**. Re-probe 06-30 in a week to confirm it doesn't roll.
  - Early July has afternoon holes (07-08, 07-15, 07-22).
  - **Density:** ES 904 prints at 14:30 UTC (2 pages), 61 at 04:00 UTC (1 page). About **1,025 pages per ES session and 916 per NQ**, at about 84 ms per page.
  - **Cursor:** `older_than` is strict. Use a +1 µs cursor with `trade_id` dedup (0 of 27,674 prints lost).
- **P3 side: D3 = PASS.** Tick-test agreement is **99.14%** (n = 4,063 price-changing ESZ6 prints, 10-28 14:00–14:30 UTC; 99.81% by volume). `side = none` and missing `side` are both 0%. On zero-tick prints `side` follows the last move only 54% of the time, so it is the **exchange aggressor flag**, not a derived classification.
  - `nbbo_*` is mostly post-trade (~93% consistent with post-trade vs ~58% with pre-trade), so never classify on it.
  - `trade_id` isn't monotonic in time, and its ranges differ by product, so dedup stays on `(sym, trade_id)`.
- **P4 volume parity:** **30 of 30 minutes exact** (deduped non-spread print volume = `futures_bars.volume`). Whole-session volume matches at 99.9%.
- **P7 stats** (`/futures/{c}/stats` at 03:34 UTC):
  - `settlement`, `settlement_date` and `session_volume` refer to the **settled** session (10-28).
  - `session_high` and `session_low` refer to the **in-progress** session (10-29 overnight). **So Phase 5 drops high/low.**
  - `session_volume` runs about 4% above print volume.
  - Which date OI is as of is unresolved, so Phase 5 stores `fetched_at` and runs twice (see Phase 5 amendments).
- **Fields:**
  - REST `/trades` regular rows have no `sym` (implied by the path) and **no event fields**.
  - `/futures/flow` carries `sym`, `product`, `tick_size`, `event_ts_ns`, `event_size` and `event_levels`. The event fields are null only on the newest, still-open event.
  - `/trades?blocks_only=true` returned 0 rows. Blocks come through `/futures/flow?blocks_only=true`, with `quote_*` null in 20 of 20 and `executed_at` at second precision.
- **D8 → normal order.** The lookback is fixed, so nothing is aging out.

### Amendments from 0a

- **Phase 6b scope** widens from "since 2026-09-29" to **since UW's archive start** (ES 2026-06-30, others 2026-07-21), about 85 sessions.
  - Rows before 09-29 hold Databento-era OHLCV, so 6b writes flow onto a bar only when UW's deduped non-spread volume for that minute is within **2%** of the bar's `volume`. Otherwise it skips and counts the minute. That keeps `buy + sell ≤ volume` meaningful.
  - The roll replay is the same as Phase 6.
- **Phase 5 table** drops `session_high`/`session_low` and keeps `fetched_at`. It runs at **12:30 UTC Tue–Sat and 21:30 UTC Mon–Fri**, with `DO UPDATE` on `(contract, settlement_date)`. The stored `fetched_at` then shows which run carried the final OI.

## Build notes: Phases 6, 6b and 6c (2026-10-29)

- **Shared code.** The roll replay moved into `api/_lib/futures-contracts.ts` as `replayFrontMonth`, generic over `{ts, volume}` rows, so candles and trade-derived minutes use one rule. Paging, the 2% match, the conditional UPDATE and the NULL-flow scan live in `api/_lib/futures-flow-repair.ts`. `api/_lib/uw-time.ts` carries UW times as bigint microseconds, because a JS `Date` would round the +1 µs cursor.
- **Phase 6 stays in `backfill-futures-gaps.ts`** (not a sibling cron). It reuses the OHLC pass's candles, which load once per root, and the logic lives in the shared module.
- **Phase 6 ranges:** runs of consecutive NULL-flow bars, oldest first, with ties in `FUTURES_ROOTS` order (ES, NQ first; D7). Each is split by the replay's leader per minute into pieces of at most 60 min, oldest first, because UW pages newest-first within a fetch.
- **Phase 6 bounds:** 600 pages per run, plus no page after 600 s, so the run stays inside its 800 s `maxDuration`. The Sentry monitor allows 14 min.
- **Phase 6 counts in Axiom `meta`:** `flow_minutes_repaired`, `flow_minutes_skipped_tolerance`, `flow_ranges_unrepairable` (an empty page inside the range), `flow_ranges_deferred`, `flow_minutes_aged_out`, `flow_pages`.
- **Phase 6 status:** anything deferred or unrepairable raises one Sentry warning. Deferred bars on the window's oldest UTC day age out before the next run (`flow_minutes_aged_out`), which makes the run `partial`.
- **Run 6b after the Phase 2 deploy.** The cron can't clear the backlog of websocket rows written before the order-flow columns: about 1,000 ES pages a session against 600 pages a run, so that backlog ages out of the 3-day window still NULL.
- **Write rule.** A minute is written only when REST volume is within 2% of the bar's AND buy + sell ≤ the bar's volume.
- **Phase 6b is a `.ts` script** with its logic in `scripts/_lib`.
  - **Candidates.** `/futures/contracts` lists only contracts active in the last 30 sessions. So each day's candidates are the 3 listed months from that day's month on, by CME cycle: HMUZ for ES/NQ/RTY/ZN, every month for CL, even months for GC. Each candidate is paged from 00:00 UTC to the last NULL minute, because the tally needs the whole day.
  - **Re-runs.** A day whose minutes all failed the 2% rule is paged again on a re-run. `--from` skips ahead.
- **Phase 6c (new): `api/cron/repair-futures-blocks.ts`**, at `15 22 * * 1-5`.
  - **Fetch:** pages `/futures/flow?blocks_only=true` back over the last 3 UTC days, with Zod validation.
  - **Write:** collapses repeated keys to the newest message, then upserts only strictly newer ones: `WHERE EXCLUDED.reported_at > futures_blocks.reported_at OR (futures_blocks.reported_at IS NULL AND EXCLUDED.reported_at IS NOT NULL)`, with `quote_bid`/`quote_ask`/`quote_ts = COALESCE(EXCLUDED.x, futures_blocks.x)`.
  - **Why not uw-stream's `>=`:** REST sends the quote fields as null. On a `reported_at` tie (the same message) the websocket's row, quotes and `raw_payload` stay, and a re-run writes nothing.
  - **Status:** invalid rows or the page cap (100) / 240 s deadline → `partial`; no blocks at all in three days → `error`.

## Phase 1 result (2026-10-28): null, D5 not met

The full write-up is `ml/docs/OFI-POINT-IN-TIME-2026-10-28.md`.

- **Discovery set:** the TBBO archive, 243 RTH sessions per root (the old "312" counted UTC-day files).
- **Predictive:** max |ρ| = 0.070 across 26 configurations. No CI excludes 0, and BH q = 0.98.
- **Same window (control):** ρ = 0.55–0.71.
- **The old ρ = 0.31 replicates exactly** (NQ +0.313) as the full-day description it was.
- **Hold-out:** sign agreement is a coin flip (15 of 26).

Consequences:
- No "wire OFI" spec.
- Phases 2–6 still collect UW flow (owner: pull everything UW offers).
- Re-test after 60 UW sessions. Phase 6b's backfill to 2026-06-30 gets there sooner.
- One variant is untested: overnight OFI as a predictor of the RTH session.

## Probe results (0b): websocket capture, 2026-10-29 04:00–13:09Z (Globex overnight)

There are 1,044 frames from 389 sampled prints (ES 201, NQ 188; `trade_id % 500 == 0`). Scripts and outputs are in `docs/tmp/uw-futures-probe/capture/` (gitignored).

- **P1: every frame has the same 11 keys**, 100% present and never null: `sym, product, exchange, executed_at, price, size, side, nbbo_bid, nbbo_ask, trade_id, is_block`. There is no `is_spread`, `crossed`, `strategy`, `event_ts_ns`, `event_size` or `event_levels`.
  - Syms: only the front outrights (`ESZ6`, `NQZ6`).
  - Side: 212 buy, 177 sell, 0 none.
- **P2: repeated copies.** Every print arrives at least 2×, and the copy count follows size (a size-1 print gives exactly 2 copies; copies ≤ size + 1; r = 0.77). That is consistent with one frame per CME order filled. Only `nbbo_bid`/`nbbo_ask` ever differ between copies (13 of 389 prints); `side`, `price` and `size` never do. The gap from first to last copy has a median under 1 ms and a max of 36 ms.
  - Without the `(sym, trade_id)` dedup, ES volume would be 6.2× too high.
- **Integrity:** sampled ES trade ids are contiguous (201 of 201), so nothing was lost. NQ's sparsity matches REST: its id counter is shared.
- **D1 = NO.** The websocket carries no match-event fields, so **Phase 3 (sweeps) is not built from the websocket**. Sweeps would need REST `/futures/flow`, which is out of scope.
- **D2 = copies differ only in the post-trade NBBO**, so first-copy-wins is correct. No side-disagreement counter is needed.
- **Open:** this sample is overnight only, with no spread syms seen. Re-check non-outright syms on the RTH capture before removing the capture code.
