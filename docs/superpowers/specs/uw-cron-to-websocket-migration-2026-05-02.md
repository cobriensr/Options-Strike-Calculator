# UW Cron → WebSocket Migration

**Date:** 2026-05-02
**Status:** Spec — pending user approval before implementation
**Related:** [uw-websocket-daemon-2026-05-02.md](./uw-websocket-daemon-2026-05-02.md)

---

## Goal

Retire Vercel crons that poll UnusualWhales REST endpoints in favor of streaming the equivalent UW websocket channels via the new Railway-hosted UW daemon (`uw-stream/`). Migrate in phased tiers with soak periods so any data-shape divergence is caught before crons are turned off.

## Why

- **Latency:** crons run on minute boundaries; WS pushes events as they happen (sub-second for alerts, dark pool, 0DTE GEX).
- **Burst tolerance:** 1-min cron windows miss bursts of dark-pool prints or flow alerts entirely.
- **Cost:** ~10 Vercel cron invocations/min go away once Tier 1 + 2 retire.
- **Cleaner pipeline:** events arrive ordered as published, no pagination races on `newer_than` cursors.

## Non-goals

- No replacement for crons polling pre-aggregated 5-min UW endpoints (Tier 3 — no fidelity gain).
- No replacement for EoD-only or OHLC-bar endpoints (Tier 4 — no WS coverage exists).
- No analyze-context changes — daemon writes into the same tables crons currently write.

---

## Tier classification (from cron audit 2026-05-02)

### Tier 1 — HIGH value, migrate first

| Cron                 | Schedule            | WS channel                                | Target table                                |
| -------------------- | ------------------- | ----------------------------------------- | ------------------------------------------- |
| `fetch-flow-alerts`  | `* 13-21 * * 1-5`   | `flow-alerts`                             | `flow_alerts` (existing)                    |
| `fetch-whale-alerts` | `*/5 13-21 * * 1-5` | `flow-alerts` (filter ticker/issue_type)  | `flow_alerts` (existing, unified)           |
| `fetch-darkpool`     | `* 13-21 * * 1-5`   | `off_lit_trades` (filter to SPY+QQQ)      | **`dark_pool_prints` (new)** — see sub-plan |
| `fetch-gex-0dte`     | `* 13-21 * * 1-5`   | `gex_strike_expiry:SPX` filtered to today | `gex_zero_dte` (existing)                   |

Two cron entries collapse into one channel subscription (`flow-alerts` covers both alert paths). Dark pool is the only Tier 1 cron whose cutover requires a new table + reader migration — see the **Dark pool sub-migration** section below.

### Tier 2 — MEDIUM value, bundle after Tier 1 stabilizes

| Cron                    | Schedule                 | WS channel                               |
| ----------------------- | ------------------------ | ---------------------------------------- |
| `fetch-spot-gex`        | `* 13-21 * * 1-5`        | `gex:SPX`                                |
| `fetch-strike-all`      | `3,8,…,58 13-21 * * 1-5` | `gex_strike:SPX`                         |
| `fetch-strike-exposure` | `3,8,…,58 13-21 * * 1-5` | `gex_strike_expiry:<TICKER>`             |
| `fetch-spxw-blocks`     | `45 13,15,18,20 * * 1-5` | `option_trades:SPXW` w/ size filter      |
| `fetch-vol-0dte`        | `* 13-21 * * 1-5`        | `contract_screener` filtered to SPX 0DTE |

### Tier 3 — DO NOT migrate (no fidelity gain)

UW serves these as 5-min pre-aggregated buckets at the source. WS gives push-vs-pull but identical payload granularity. Migration cost exceeds benefit even with Railway available — adding handlers, soak time, and risk for no actual signal improvement.

- `fetch-flow` (market-tide)
- `fetch-net-flow`
- `fetch-etf-tide`
- `fetch-zero-dte-flow`
- `monitor-flow-ratio`
- `fetch-greek-flow`, `fetch-greek-flow-etf`
- `fetch-nope` (server-side calculation; reproducing client-side is heavy and error-prone)

### Tier 4 — Cannot migrate (no WS channel exists)

EoD aggregates and OHLC bars have no WS counterpart in the 14 documented channels.

- `fetch-greek-exposure`, `fetch-greek-exposure-strike` — daily aggregate Greeks
- `fetch-oi-change`, `fetch-oi-per-strike` — OI snapshots
- `fetch-vol-surface` — IV term structure + realized vol + IV rank
- `fetch-spx-candles-1m`, `fetch-etf-candles-1m` — `price:<TICKER>` is last-trade only, not OHLCV
- `fetch-economic-calendar` — reference data

---

## Dark pool sub-migration

The `fetch-darkpool` cutover is materially different from the other Tier 1 crons because the daemon writes to a **new** schema (`dark_pool_prints`) instead of an existing table, and 7+ consumers across `api/` currently read from the legacy `dark_pool_levels`. Multi-step plan, run in parallel with the daemon-side phases:

### DP-Phase 0 — NDX 1m candle ingestion (prerequisite)

Required for accurate QQQ→NDX read-time mapping. Without it, the NDX selector view degrades to a static prior-day ratio.

**Decided:** extend the existing `fetch-spx-candles-1m.ts` cron to fetch both `$SPX` and `$NDX` (no new cron — user wants to reduce, not add, scheduled jobs). Storage migrates from a SPX-only `spx_candles_1m` table to a multi-symbol `index_candles_1m` table.

- [ ] Migration: rename `spx_candles_1m` → `index_candles_1m` and add a `symbol TEXT NOT NULL DEFAULT 'SPX'` column (existing rows backfill via the DEFAULT). Replace the old `(date, timestamp)` unique constraint with `(symbol, date, timestamp)`. Add a partial unique index `spx_candles_1m_compat_uniq ON (date, timestamp) WHERE symbol = 'SPX'` so the existing cron's `ON CONFLICT (date, timestamp)` keeps resolving — Postgres rejects ON CONFLICT against a partial column subset of a multi-column unique constraint, so a partial-index target is required. Create a compat view `spx_candles_1m AS SELECT … FROM index_candles_1m WHERE symbol = 'SPX'` so unmigrated readers continue working unchanged. **Decided: rename + compat view + partial unique index — see migration #112.**
- [ ] Update `api/cron/fetch-spx-candles-1m.ts` to fetch `$SPX` and `$NDX` in the same invocation, write rows tagged with their symbol. Consider renaming the file to `fetch-index-candles-1m.ts` with corresponding `vercel.json` and `protect`-array updates.
- [ ] Update every reader of `spx_candles_1m` to query the new table with `WHERE symbol = 'SPX'` (or via a thin helper). Audit: `grep -r "spx_candles_1m" api/ src/`.
- [ ] Update `api/__tests__/db.test.ts` mock sequence
- [ ] Backfill ≥30 trading days of NDX history via Schwab so historical date ranges resolve for the dark pool read endpoint
- **Verify:** `SELECT COUNT(*) FROM index_candles_1m WHERE symbol='NDX' AND date = CURRENT_DATE` returns ≥390 rows after first market session post-deploy; `npm run review` passes; existing SPX-consuming code paths still work unchanged

### DP-Phase 1 — Migration to add `dark_pool_prints`

- [ ] Add migration in `api/_lib/db-migrations.ts` creating `dark_pool_prints` per the schema in the daemon spec sub-design
- [ ] Add unique index `(symbol, executed_at, price, size)` for replay idempotency
- [ ] Add lookup index `(symbol, date, executed_at DESC)` for the read endpoint
- [ ] Update `api/__tests__/db.test.ts` mock sequence per CLAUDE.md migration pattern
- **Verify:** `npm run review` passes; migration runs cleanly against a fresh DB

### DP-Phase 2 — Daemon `off_lit_trades` handler

Mirrors daemon spec dark-pool sub-design.

- [ ] Implement `uw-stream/src/handlers/off_lit_trades.py`
- [ ] Wire into `router.py` (subscribe to global `off_lit_trades`, dispatch to handler)
- [ ] Tests in `uw-stream/tests/` with captured payload fixtures (SPY hit, QQQ hit, off-symbol drop, ext-hours drop, contingent-trade drop)
- [ ] Deploy; verify `/metrics` shows `off_lit_trades.write_count` increasing during market hours
- [ ] Spot-check: `SELECT symbol, COUNT(*), SUM(premium) FROM dark_pool_prints WHERE date = CURRENT_DATE GROUP BY symbol` returns non-zero for SPY and QQQ only

### DP-Phase 3 — Reader migration to `dark_pool_prints`

Each consumer migrates to read from `dark_pool_prints` via a shared query helper before the legacy table can be dropped.

- [ ] Create `api/_lib/dark-pool-query.ts` with helpers:
  - `getDarkPoolLevels({ date, symbol })` — replaces direct SELECTs on `dark_pool_levels`; computes the candle-ratio mapping inline for `SPX`/`NDX` selectors, native bucketing for `SPY`/`QQQ`
  - `getDarkPoolDailyTotals({ date, symbol })` — totals for status endpoints
  - `getDarkPoolFeatures({ date, symbol })` — for the ML features pipeline
- [ ] Migrate consumers (one file per checklist item; verify each):
  - [ ] `api/darkpool-levels.ts` — read endpoint, becomes `?symbol={SPX|NDX|SPY|QQQ}` aware (default `SPX`)
  - [ ] `api/system-status.ts`
  - [ ] `api/journal/status.ts`
  - [ ] `api/_lib/build-features-phase2.ts`
  - [ ] `api/_lib/analyze-context.ts`
  - [ ] `api/_lib/anomaly-context.ts`
  - [ ] `api/_lib/uw-deltas.ts`
  - [ ] `api/_lib/constants.ts` (if it references the table directly)
  - [ ] Test files mirroring the above
- **Verify:** every consumer's tests pass; `grep -r 'dark_pool_levels' api/ src/` returns only the legacy migration row, the legacy cron file (still present at this stage), and the migration that drops the table (added in DP-Phase 5)

### DP-Phase 4 — Frontend symbol selector

- [ ] Add `{SPX, NDX, SPY, QQQ}` selector to the dark pool panel; default `SPX`
- [ ] Wire to `api/darkpool-levels.ts?symbol=...`; refetch on change
- [ ] Verify each selector renders distinct level distributions (visual check in dev)

### DP-Phase 5 — Cutover

After daemon has run alongside the legacy cron for ≥3 trading days and parity is verified:

- [ ] Remove `fetch-darkpool` from `vercel.json` crons array
- [ ] Delete `api/cron/fetch-darkpool.ts` + `api/__tests__/fetch-darkpool.test.ts`
- [ ] Remove path from `protect` array in `src/main.tsx` `initBotId()`
- [ ] Audit and remove orphans in `api/_lib/darkpool.ts` and `api/_lib/dark-pool-filter.ts` (most or all should be unreachable after consumer migration; remove if so, keep helper functions still referenced elsewhere)
- [ ] Drop `dark_pool_levels` table in a follow-up migration (separate commit so rollback can revive the cron without resurrecting the table from scratch)
- **Verify:** `npm run review` passes; production logs show daemon writing prints; UI panel renders correctly across all 4 symbols

---

## Phase 1 — Build daemon, scaffold + first channel

Reference: `uw-websocket-daemon-2026-05-02.md` Phase 1.

- [ ] Build `uw-stream/` per daemon spec, scaffold with `flow-alerts` only
- [ ] Deploy to Railway
- [ ] Verify daemon writes to `flow_alerts` table alongside the existing cron
- [ ] Confirm `/healthz` returns 200, `/metrics` shows steady writes
- **Verify:** `daemon_row_count >= cron_row_count` over 1 trading day; explore any gap before proceeding

## Phase 2 — Add remaining Tier 1 channels (`gex_strike_expiry:SPX`)

`off_lit_trades` is owned by **DP-Phase 2** in the dark pool sub-migration above (separate work track). This phase covers the remaining Tier 1 channel.

- [ ] Add `handlers/gex.py` with `gex_strike_expiry:SPX` filtered to today's expiry — writes to existing `gex_zero_dte` table
- [ ] Deploy
- **Verify:** Sentry error rate stable; queue depths < 1k peak; drop counters = 0 across 1 trading day

## Phase 3 — Soak (3 trading days)

- [ ] Both crons and daemon write to the same tables for 3 trading days
- [ ] Daily check: row counts within 1% per channel (daemon should match or slightly exceed)
- [ ] Daily check: no Sentry alerts for queue overflow or reconnect storms (>5/hr)
- [ ] Sample 10 random alerts/prints/GEX rows per day, compare daemon-row vs cron-row field-by-field
- **Verify:** parity report saved to `docs/tmp/uw-stream-parity-<date>.md` covering the full 3-day window
- **Soak duration note:** 3 days is shorter than what'd be standard for high-stakes data. User accepts that a once-a-week regime event (e.g. Fed day, OPEX) may not appear in this window — risk is mitigated by the rollback path being trivial.

## Phase 4 — Tier 1 cutover

Only proceed if Phase 3 parity report is clean. **Dark pool is excluded from this phase** — its cutover (including cron removal, table drop, and consumer migration prerequisites) is owned by **DP-Phase 5** in the dark-pool sub-migration above. Do not delete `fetch-darkpool` from `vercel.json` here.

- [ ] Remove from `vercel.json` crons array:
  - [ ] `/api/cron/fetch-flow-alerts`
  - [ ] `/api/cron/fetch-whale-alerts`
  - [ ] `/api/cron/fetch-gex-0dte`
- [ ] Delete handler files:
  - [ ] `api/cron/fetch-flow-alerts.ts`
  - [ ] `api/cron/fetch-whale-alerts.ts`
  - [ ] `api/cron/fetch-gex-0dte.ts`
- [ ] Delete corresponding test files
- [ ] Remove paths from `protect` array in `src/main.tsx` `initBotId()` call (Tier 1 paths only — leave the dark pool path; DP-Phase 5 handles it)
- [ ] Remove any orphaned imports / helpers in `api/_lib/` for the 3 Tier 1 crons being removed here. **Do not** touch `darkpool.ts` or `dark-pool-filter.ts` in this phase — DP-Phase 5 owns those.
- [ ] **Whale-alert reader migration:** update every reader of the old `whale_alerts` table (or whatever the `fetch-whale-alerts` cron wrote into) to query `flow_alerts` with the appropriate WHERE clause. Audit: `grep -r "whale_alerts\|fetchWhaleAlerts\|whaleAlertsQuery" api/ src/`. Likely touches `api/_lib/analyze-context.ts`, the whale-alerts API endpoint, and any frontend component that renders them.
- [ ] Drop the old whale-alerts table (separate migration, run after readers are updated)
- **Verify:** `npm run review` passes; Vercel deploy log shows the 3 Tier 1 (non-dark-pool) crons removed

## Phase 5 — Tier 2 add

After Tier 1 cutover stable for ≥3 trading days.

- [ ] Add Tier 2 handlers to daemon (`gex:SPX`, `gex_strike:SPX`, `option_trades:SPXW`, `contract_screener`)
- [ ] Run alongside Tier 2 crons for 3 trading days
- [ ] Cutover Tier 2 crons (same pattern as Phase 4)
- **Verify:** Tier 2 retired crons removed from `vercel.json`; `npm run review` passes

## Rollback

**Daemon failure path (general):** stop the daemon container, re-add the corresponding cron(s) to `vercel.json`, redeploy. Tables are unchanged so the cron resumes populating without backfill — only ~30s–2min of data potentially missed during re-deploy. **Per-cron rollback is independent** because they all wrote to existing tables and we never deleted any cron handler before the soak completed.

**Dark pool exception:** rollback semantics differ once DP-Phase 3 (consumer migration) lands, because all readers now query `dark_pool_prints`. Re-enabling `fetch-darkpool` to repopulate `dark_pool_levels` no longer helps any consumer. Two valid rollback paths if the daemon dies post-DP-Phase-3:

1. **Forward fix:** restart the daemon container; readers continue to work as soon as fresh prints arrive. Acceptable for short outages.
2. **Full revert:** revert the consumer-migration commits AND re-enable `fetch-darkpool`. Heavier, only if the daemon is broken for >1 trading day.

Until DP-Phase 3 is merged, the lightweight "re-enable cron" rollback works as for the other Tier 1 crons.

## Decided

- **Whale-alert handling:** no daemon-side filter. Daemon writes every alert to a unified `flow_alerts` table; whale-alert UI / analyze code path is updated to query with `WHERE …` at read time. This collapses two crons (`fetch-flow-alerts` + `fetch-whale-alerts`) into one channel subscription AND eliminates the `whale_alerts` table conceptually.
  - **Side effect (must do before cutover):** find and update every reader of the old whale-alerts table — `api/`, `src/components/`, `analyze-context.ts`, anywhere a query references the whale-alerts source. Add this as an explicit task in Phase 4.
- **Dark pool — single source of truth via raw prints:** new `dark_pool_prints` table is the only stored shape. Pre-aggregated `dark_pool_levels` is computed at read time via candle-ratio mapping (see daemon spec sub-design) and dropped after DP-Phase 3 consumer migration. Symbols scoped to SPY+QQQ at ingest; SPX/NDX synthesized at read.
- **Dark pool — full payload capture:** every field UW sends in `off_lit_trades` is stored, including slowly varying symbol metadata (sector, marketcap, avg30_volume, next_earnings_date, issue_type). Storage cost is modest; user prefers full-fidelity capture for ML feature surface.
- **NDX 1m candle ingestion** is a hard prerequisite (DP-Phase 0). **Extend** the existing `fetch-spx-candles-1m.ts` cron rather than adding a new one (user goal: reduce cron count). Storage migrates from `spx_candles_1m` → `index_candles_1m` with a `symbol` column.

## Still open

1. **Block-trade threshold** — what min size makes `option_trades:SPXW` a "block" for `spxw_blocks` table parity? Confirm against current `fetch-spxw-blocks.ts` during Phase 5.
2. **Soak duration** — 3 trading days (decided 2026-05-02). Shorter than would be standard; risk acknowledged.
3. **Schema gaps** — do existing tables have columns the WS payloads don't supply (e.g., `fetched_at`, `source`)? Per-handler audit during Phase 1; daemon writes `now()` for `fetched_at` where the column exists.

## Done when

- `vercel.json` has 9 fewer cron entries (4 Tier 1 + 5 Tier 2).
- Daemon has run for ≥30 trading days post-Tier-2-cutover with <1 Sentry incident.
- All cron handler files deleted, tests removed, no orphaned imports (`grep -r "fetch-flow-alerts\|fetch-whale-alerts\|fetch-darkpool\|fetch-gex-0dte\|fetch-spot-gex\|fetch-strike-all\|fetch-strike-exposure\|fetch-spxw-blocks\|fetch-vol-0dte" api/ src/` returns 0 lines).
- Frontend / analyze pipeline behaves identically (no UI bug reports tied to data freshness or gaps).

## Notes / risks

- **Single point of failure** — one daemon, one WS connection. Acceptable for personal trading tool but worth knowing.
- **`flow-alerts` channel uses a HYPHEN** (footgun documented in skill). Migration is a great time to typo this and silently lose all alerts.
- **All UW WS numerics arrive as JSON strings** — handlers must cast at boundary.
- **Server forgets joins on disconnect** — daemon must resubscribe on every reconnect.
- **Tier 3 temptation** — once the daemon exists, "while we're at it" temptation will arise to migrate Tier 3 too. Resist: those crons consume identical 5-min buckets either way.
