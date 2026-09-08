# Futures: migrate ingestion from Databento to the UW websocket

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> Load `unusual-whales-websocket` before touching `uw-stream/`.

**Goal:** Re-source the 1-minute futures bars from the UnusualWhales `futures_trades`
websocket channel, then delete the Databento ingestion from the Railway `sidecar`
service — while keeping `/takeit/explain` (SHAP) and `/archive/*` alive on that same
service.

**Status:** scoped 2026-09-08. Databento subscription is CANCELLED.

---

## Background — what is actually live (measured, not assumed)

Evidence gathered 2026-09-08 by direct DB query and a live websocket probe.

### `futures_bars` — the only path still working at cancellation

| symbol | rows | last bar |
|---|---|---|
| ES, NQ, RTY, CL, GC | ~470–490K each | **2026-09-03** |
| ZN | 373,378 | 2026-09-03 |
| **DX** | 102,226 | **2026-03-05 — dead 6 months** |
| **VX1 / VX2** | **no rows; symbol never present** | never ingested |

### Everything else died 2026-06-15, ~3 months before cancellation

| table | rows | last |
|---|---|---|
| `futures_options_daily` | 118,887 | 2026-06-15 |
| `futures_top_of_book` | 33,684,019 | 2026-06-15 |
| `futures_trade_ticks` | 33,685,285 | 2026-06-15 |

Consequences:

- `api/_lib/microstructure-signals.ts` (NQ OFI, ρ=0.31) reads `futures_top_of_book` and has
  been returning `null` since 2026-06-15. Reviving OFI is **new work**, not preservation.
- `src/components/FuturesCalculator/VixTermStructure.tsx` renders `vxTermSpread` /
  `vxTermStructure` derived from VX1/VX2, which have **never** existed. It is dead UI.
- `api/cron/backfill-futures-gaps.ts` calls `hist.databento.com` directly and will 500
  daily now that the subscription is gone.

### UW websocket probe (live, 2026-09-08 ~05:35 UTC)

Joined `futures_trades` (global) and `futures:ESU6`. **Both acked `status: ok`** — the
existing Advanced-tier key is entitled; no `futures` add-on needed.

- Throughput: ~72–80 frames/s overnight, all CME-group products.
- Exchanges observed: `XCME`, `XCEC`, `XCBT`, `XNYM`. **No Cboe (CFE), no ICE.**
- 90-second coverage: `ES` ✅ `NQ` ✅ `RTY` ✅ `CL` ✅ `GC` ✅ `ZN` ✅ — `DX` ❌ `VX` ❌

`DX` is ICE and `VX` is Cboe CFE, so both are **structurally unavailable** on this feed.
Neither has live data today, so coverage of what actually works is **100%**.

Payload shape (one trade print):

```json
{"sym":"ESU6","product":"ES","exchange":"XCME","executed_at":...,
 "price":"6612.25","size":1,"side":"sell",
 "nbbo_bid":"6612.00","nbbo_ask":"6612.50","trade_id":3173065,"is_block":false}
```

`price`, `nbbo_bid`, `nbbo_ask` are **strings** — parse, never compare raw.
`product` is an exact root (`"ES"`), distinct from micros (`"MES"`), so filtering is an
equality test, not a prefix match.

---

## Phases

Each phase is independently shippable and independently revertible.

| Phase | Scope | Risk |
|---|---|---|
| 1 | UW futures handler in `uw-stream/` → `futures_bars` | Low — additive, nothing removed |
| 2 | Strip Databento from `sidecar/`, keep SHAP + archive | Medium — touches a live service |
| 3 | Remove dead futures surface (DX, VX UI, dead crons) | Low — deletes already-dead paths |
| 4 | *(deferred)* rebuild top-of-book proxy for NQ OFI | Deferred — needs validation first |

**Phase 1 must be soaked through one full session before Phase 2 starts.** Do not delete
the Databento ingestion until UW-sourced bars are confirmed landing correctly.

---

## Phase 1 — UW futures ingestion in `uw-stream/`

**Goal:** populate `futures_bars` from `futures_trades` with no schema change.

Subscribe to the **global** `futures_trades` channel, not `futures:<CONTRACT>`:

- One channel instead of 6+, against the empirically-confirmed 50-channel/connection cap
  (`PER_CONN_MAX = 45`).
- Contract roll (ESU6 → ESZ6) becomes a non-event — no calendar logic, no resubscribe.
- Cost: receive all CME products and discard ~85% client-side.

### Files

| File | Change |
|---|---|
| `uw-stream/src/handlers/futures_trades.py` | **Create** — filter, aggregate, flush |
| `uw-stream/src/channel_registry.py` | Modify — register `futures_trades` |
| `uw-stream/src/config.py` | Modify — allow `futures_trades` in `WS_CHANNELS` |
| `uw-stream/tests/test_futures_trades_handler.py` | **Create** — bar-aggregation tests |
| `uw-stream/README.md` | Modify — document the channel |

### Aggregation

Trade prints → 1-minute OHLCV, keyed `(product, minute)`:

- `open` = first print in the minute by `executed_at`; `close` = last
- `high` / `low` = max / min `price`
- `volume` = Σ `size`
- `ts` = `executed_at` floored to the minute, **UTC**

**Front-month collapse.** `futures_bars.symbol` is a root (`'ES'`), but the feed carries
every contract month. Within each `(product, minute)`, keep only prints from the
**front-month contract**, selected as the `sym` with the greatest cumulative session
volume for that product. Rationale: volume-based selection rolls itself at the actual
liquidity crossover, which is what a continuous series should track, and needs no expiry
calendar.

**Handler shape (decided 2026-09-08).** Bar aggregation is stateful and does not fit the
base class's 1:1 `_transform(payload) -> row` contract. Resolution:

- `_transform` returns `None` for non-target products, else a normalized per-trade tuple
  `(product, sym, minute_ts, price, size)` with `minute_ts` UTC-floored to the minute.
- `_flush` folds the batch into an in-handler accumulator keyed `(product, minute_ts)` and
  emits **only minutes strictly older than the newest observed minute** for that product.

Flushing only *completed* minutes is what keeps `ON CONFLICT DO NOTHING` correct against
`UNIQUE(symbol, ts)`: a partial bar must never be written, because `DO NOTHING` would then
permanently lock in the partial value. Do not introduce an `ON CONFLICT DO UPDATE` path
without revisiting this decision.

### Steps

- [ ] **Step 1: Write failing tests** — bar aggregation from a synthetic print sequence;
      micro exclusion (`MES` must not contribute to `ES`); string-price parsing;
      front-month selection when two contracts are present; minute-boundary flooring.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement the handler** subclassing `handlers/base.py` — `_transform`
      returns `None` for non-target products; `_flush` does a batched multi-row
      `INSERT ... ON CONFLICT DO NOTHING` via `bulk_insert_ignore_conflict`.
- [ ] **Step 4: Register** in `channel_registry.py`; accept the token in `config.py`.
- [ ] **Step 5: Run `uw-stream` pytest suite.**
- [ ] **Step 6: Deploy to Railway; add `futures_trades` to `WS_CHANNELS`.**
- [ ] **Step 7: SOAK one full session.** Verify a minute-count per symbol comparable to the
      Databento-era baseline (~390 bars/symbol/RTH day), and that OHLC values track a
      reference quote source. **Do not proceed to Phase 2 until this passes.**

---

## Phase 2 — Strip Databento from `sidecar/`

**Goal:** the sidecar boots and serves `/takeit/explain` + `/archive/*` with **no**
`DATABENTO_API_KEY`.

**Critical:** `sidecar/src/main.py:106` lists `DATABENTO_API_KEY` in `required`, and
`main()` `sys.exit(1)`s **before the health server starts**. That is why simply unsetting
the key would take SHAP down. Removing it from `required` is the load-bearing edit.

### Files

**Delete** — Databento-only:
`databento_client.py`, `quote_processor.py`, `trade_processor.py`, `options_router.py`,
`bar_writer.py`, `symbol_manager.py`, `front_month.py`, `session_calendar.py`,
`stat_writer.py`

**Delete** — Theta is confirmed dead (`THETA_EMAIL`/`THETA_PASSWORD` unset on Railway,
`/health` reports `theta: {running: false, last_ready_at: null}`, nothing on the volume):
`theta_client.py`, `theta_fetcher.py`, `theta_launcher.py`

**Keep untouched** — verified to have no Databento dependency:
`health.py` (the HTTP server), `takeit_server.py` (stdlib only), `archive_query.py`
(duckdb only), `archive_seeder.py`, `db.py`, `config.py`, `logger_setup.py`,
`sentry_setup.py`, `multileg_routes.py`

**Modify:** `main.py` — drop the Databento/Theta imports, drop `DATABENTO_API_KEY` from
`required`, delete `connect_with_retry()`, keep the health server + archive seeder boot.
`sidecar/README.md`, `sidecar/requirements.txt` (drop the `databento` dep).

**Also delete:** `sidecar/package.json` + `sidecar/package-lock.json` — vestigial
`es-relay-sidecar` Node manifests. The Dockerfile is `FROM python:3.12-slim` with zero npm
references, so they are never installed. Removes 14 stale Dependabot alerts.

### Steps

- [ ] Write a boot test asserting `main()` starts the health server with
      `DATABENTO_API_KEY` absent from the environment.
- [ ] Delete the modules above; strip `main.py`.
- [ ] Run the sidecar test suite.
- [ ] Deploy; confirm `/health` 200, `/takeit/health` reports
      `{"enabled":true,"bundles_loaded":["lottery","silentboom"]}`, `/archive/*` responds.
- [ ] Confirm `takeit-fill-shap` still populates tile flags over one cron cycle.
- [ ] Remove `DATABENTO_API_KEY` from the Railway service.

---

## Phase 3 — Remove the dead futures surface

- [ ] Delete `api/cron/backfill-futures-gaps.ts` + its `vercel.json` entry (calls
      `hist.databento.com`; will 500 daily).
- [ ] Delete `api/cron/fetch-es-options-eod.ts` + entry — `futures_options_daily` has been
      dead since 2026-06-15 and UW has **no futures-options channel**.
- [ ] Drop `DX` from `FUTURES_SYMBOLS` in `api/_lib/futures-derive.ts` (unavailable on UW,
      dead since 2026-03-05).
- [ ] Delete `src/components/FuturesCalculator/VixTermStructure.tsx` + its test, and the
      `vxTermSpread` / `vxTermStructure` fields from `useFuturesData` and
      `/api/futures/snapshot` — VX never had data.
- [ ] Fix `CLAUDE.md:224`, which cites `src/utils/futures-gamma/{...}.ts` as live examples;
      that directory was deleted in `2c92fa72`.
- [ ] Fix `sidecar/README.md`, which documents the health path as `/healthz`; the real
      route is `/health` (`/healthz` 404s).

**Tables are NOT dropped.** Per decision 2026-09-08: keep `futures_bars`,
`futures_options_daily`, `futures_top_of_book`, `futures_trade_ticks` and their historical
rows in Neon. Cheap, and reversible.

---

## Phase 4 — deferred: NQ OFI revival

`futures_trades` carries `nbbo_bid` / `nbbo_ask` / `side` / `size` per print, which
supports a **signed-volume OFI approximation** — but that is trade-level NBBO, not book
updates, so it is **not** a drop-in for the `futures_top_of_book` OFI that produced
ρ=0.31. Treat as a research task: rebuild, then re-validate the correlation before wiring
anything to analyze context. Do not assume equivalence.

---

## Data dependencies

- **No schema change.** `futures_bars` is `(id, symbol, ts, open, high, low, close, volume)`.
- **No new env vars.** `UW_API_KEY` already present on `uw-stream`; rotated 2026-09-08.
- **Gap 2026-09-03 → cutover is unrecoverable.** Databento is cancelled and UW's websocket
  is live-only. Accept the hole.

## Thresholds / constants

| Constant | Value | Rationale |
|---|---|---|
| Target products | `ES, NQ, RTY, CL, GC, ZN` | The 6 UW covers that had live data |
| Channel | `futures_trades` (global) | 1 slot vs 6+; roll-immune |
| Bar interval | 60 s, UTC-floored | Matches existing `futures_bars` |
| Front-month rule | max cumulative session volume per product | Rolls at liquidity crossover |
| Batch flush | size **or** time, mirroring existing handlers | Consistency with `uw-stream` |

## Open questions

1. **Backfill 09-03 → cutover?** Default: **no.** UW REST futures history has not been
   checked; if it exists it could close the gap. Not gating.
2. **Persist raw prints to `futures_trade_ticks`?** Default: **no** in Phase 1 — 33.7M rows
   accumulated previously. Revisit with Phase 4.
3. **Retire `multileg_routes.py` from the sidecar?** Vercel prod has `CLASSIFIER_URL` set
   and it takes precedence; the sidecar path is a documented "one deploy cycle" fallback
   that has long outlived its cycle. Default: **leave it** — out of scope, zero cost.

## Explicitly out of scope

- **Classifier OOM rework** (`classifier-oom-rework-2026-06-11.md`, Phases 3–4 unlanded).
  Decoupled by design: leaving SHAP on the sidecar means no rehoming, so the OOM work does
  not gate this migration.
- **TBBO archive backup.** Tracked separately — the 4.16 GB TBBO parquet exists only on the
  Railway volume and Vercel Blob (the laptop copy at `ml/data/archive/tbbo/` is 0 bytes).
  Pull it local before any volume teardown. **No volume teardown in this plan.**
