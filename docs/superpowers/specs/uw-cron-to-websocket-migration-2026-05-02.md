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

| Cron                 | Schedule                | WS channel                                |
| -------------------- | ----------------------- | ----------------------------------------- |
| `fetch-flow-alerts`  | `* 13-21 * * 1-5`       | `flow-alerts`                             |
| `fetch-whale-alerts` | `*/5 13-21 * * 1-5`     | `flow-alerts` (filter ticker/issue_type)  |
| `fetch-darkpool`     | `* 13-21 * * 1-5`       | `off_lit_trades`                          |
| `fetch-gex-0dte`     | `* 13-21 * * 1-5`       | `gex_strike_expiry:SPX` filtered to today |

Two cron entries collapse into one channel subscription (`flow-alerts` covers both alert paths).

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

## Phase 1 — Build daemon, scaffold + first channel

Reference: `uw-websocket-daemon-2026-05-02.md` Phase 1.

- [ ] Build `uw-stream/` per daemon spec, scaffold with `flow-alerts` only
- [ ] Deploy to Railway
- [ ] Verify daemon writes to `flow_alerts` table alongside the existing cron
- [ ] Confirm `/healthz` returns 200, `/metrics` shows steady writes
- **Verify:** `daemon_row_count >= cron_row_count` over 1 trading day; explore any gap before proceeding

## Phase 2 — Add Tier 1 channels (off_lit_trades, gex_strike_expiry:SPX)

- [ ] Add `handlers/off_lit_trades.py` — write to existing dark pool table
- [ ] Add `handlers/gex.py` with `gex_strike_expiry:SPX` filtered to today's expiry
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

Only proceed if Phase 3 parity report is clean.

- [ ] Remove from `vercel.json` crons array:
  - [ ] `/api/cron/fetch-flow-alerts`
  - [ ] `/api/cron/fetch-whale-alerts`
  - [ ] `/api/cron/fetch-darkpool`
  - [ ] `/api/cron/fetch-gex-0dte`
- [ ] Delete handler files:
  - [ ] `api/cron/fetch-flow-alerts.ts`
  - [ ] `api/cron/fetch-whale-alerts.ts`
  - [ ] `api/cron/fetch-darkpool.ts`
  - [ ] `api/cron/fetch-gex-0dte.ts`
- [ ] Delete corresponding test files
- [ ] Remove paths from `protect` array in `src/main.tsx` `initBotId()` call
- [ ] Remove any orphaned imports / helpers in `api/_lib/` (e.g. `darkpool.ts` may stay if used elsewhere — grep first)
- [ ] **Whale-alert reader migration:** update every reader of the old `whale_alerts` table (or whatever the `fetch-whale-alerts` cron wrote into) to query `flow_alerts` with the appropriate WHERE clause. Audit: `grep -r "whale_alerts\|fetchWhaleAlerts\|whaleAlertsQuery" api/ src/`. Likely touches `api/_lib/analyze-context.ts`, the whale-alerts API endpoint, and any frontend component that renders them.
- [ ] Drop the old whale-alerts table (separate migration, run after readers are updated)
- **Verify:** `npm run review` passes; Vercel deploy log shows the 4 crons removed

## Phase 5 — Tier 2 add

After Tier 1 cutover stable for ≥3 trading days.

- [ ] Add Tier 2 handlers to daemon (`gex:SPX`, `gex_strike:SPX`, `option_trades:SPXW`, `contract_screener`)
- [ ] Run alongside Tier 2 crons for 3 trading days
- [ ] Cutover Tier 2 crons (same pattern as Phase 4)
- **Verify:** Tier 2 retired crons removed from `vercel.json`; `npm run review` passes

## Rollback

**Daemon failure path:** stop the daemon container, re-add the corresponding cron(s) to `vercel.json`, redeploy. Tables are unchanged so the cron resumes populating without backfill — only ~30s–2min of data potentially missed during re-deploy. **Per-cron rollback is independent** because they all wrote to existing tables and we never deleted any cron handler before the soak completed.

## Decided

- **Whale-alert handling:** no daemon-side filter. Daemon writes every alert to a unified `flow_alerts` table; whale-alert UI / analyze code path is updated to query with `WHERE …` at read time. This collapses two crons (`fetch-flow-alerts` + `fetch-whale-alerts`) into one channel subscription AND eliminates the `whale_alerts` table conceptually.
  - **Side effect (must do before cutover):** find and update every reader of the old whale-alerts table — `api/`, `src/components/`, `analyze-context.ts`, anywhere a query references the whale-alerts source. Add this as an explicit task in Phase 4.

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
