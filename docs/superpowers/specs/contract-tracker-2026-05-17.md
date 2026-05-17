# Contract Tracker (Long-Term Position Tracking)

**Date:** 2026-05-17
**Status:** Approved, in build

## Goal

Track manually entered options contracts to expiry (or until closed) with
periodic price refresh and threshold-based in-app alerts. Use case: follow
a whale's print after a drawdown, enter cheaper than the original, ride the
recovery.

This is for a guest user (Wonce). Tracker rows are shared across all valid
owner/guest cookies — single-tenant for v1.

## Locked-in scope

| Decision | Value |
|---|---|
| Ticker universe | Any optionable underlying |
| Pricing source | UW `option-contract/{symbol}` per row, `stock-state/{ticker}` for spot |
| Refresh cadence | Every 5 min during market hours (`*/5 13-20 * * 1-5` UTC) |
| Alert delivery | In-app Sonner toast (fires only while app is open) |
| UI placement | New top-level section in `App.tsx`, three internal tabs |
| Schwab integration | Fully independent — no read or write of Schwab CSV positions |
| Thresholds | Defaults `+50/+100/+200%` up, `-30/-50%` down. Per-contract override. |
| Underlying-level alerts | Included in v1 (e.g. "SPY >= 595") |
| Close policy | Manual close + auto-archive at expiry |
| Delete in UI | Hidden. Backend endpoint exists, frontend never calls it. |
| Auth | `guardOwnerOrGuestEndpoint` on every endpoint. Single shared tracker. |

## Architecture

```text
                  ┌─────────────────────────────────────────┐
                  │  api/cron/refresh-tracker-contracts.ts  │
                  │  every 5 min during market hours        │
                  └────────────┬────────────────────────────┘
                               │
                ┌──────────────▼──────────────┐
                │  Neon Postgres              │
                │  tracker_contracts          │
                │  tracker_contract_ticks     │
                │  tracker_alerts             │
                └──────────────┬──────────────┘
                               │
        ┌──────────────────────┴───────────────────────┐
┌───────▼──────────────┐                     ┌─────────▼────────┐
│  api/tracker/*.ts    │                     │  alerts/unread   │
│  CRUD endpoints      │                     │  polled every 30s│
└───────┬──────────────┘                     └─────────┬────────┘
        │                                              │
        └──────────────┬───────────────────────────────┘
                       │
              ┌────────▼──────────────────────────┐
              │  src/components/Tracker/          │
              │  3 tabs: Active / Watchlist /     │
              │  Archive                          │
              └───────────────────────────────────┘
```

## DB schema

Added as migrations #160-162 in `api/_lib/db-migrations.ts`.

```sql
-- #160
CREATE TABLE tracker_contracts (
  id              SERIAL PRIMARY KEY,
  occ_symbol      TEXT NOT NULL UNIQUE,
  ticker          TEXT NOT NULL,
  expiry          DATE NOT NULL,
  strike          NUMERIC(10,2) NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('C','P')),
  direction       TEXT NOT NULL CHECK (direction IN ('long','short')),
  entry_price     NUMERIC(10,4) NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  notes           TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','closed','expired')),
  closed_at       TIMESTAMPTZ,
  closed_price    NUMERIC(10,4),
  up_thresholds   NUMERIC[],          -- NULL => use defaults [50, 100, 200]
  down_thresholds NUMERIC[],          -- NULL => use defaults [-30, -50]
  spot_alerts     JSONB,              -- [{op:'>=',level:595}, ...]
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX tracker_contracts_status_idx ON tracker_contracts(status);
CREATE INDEX tracker_contracts_ticker_idx ON tracker_contracts(ticker);

-- #161
CREATE TABLE tracker_contract_ticks (
  id           BIGSERIAL PRIMARY KEY,
  contract_id  INTEGER NOT NULL REFERENCES tracker_contracts(id) ON DELETE CASCADE,
  fetched_at   TIMESTAMPTZ NOT NULL,
  last         NUMERIC(10,4),
  bid          NUMERIC(10,4),
  ask          NUMERIC(10,4),
  volume       INTEGER,
  open_int     INTEGER,
  underlying   NUMERIC(10,4),
  source       TEXT NOT NULL DEFAULT 'uw'
);
CREATE INDEX tracker_ticks_contract_time_idx
  ON tracker_contract_ticks(contract_id, fetched_at DESC);

-- #162
CREATE TABLE tracker_alerts (
  id                 BIGSERIAL PRIMARY KEY,
  contract_id        INTEGER NOT NULL REFERENCES tracker_contracts(id) ON DELETE CASCADE,
  fired_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  alert_type         TEXT NOT NULL,           -- 'up_pct'|'down_pct'|'spot_level'|'dte_7'
  threshold          NUMERIC NOT NULL,        -- pct, spot level, or 7 for dte_7
  price_at_fire      NUMERIC(10,4),
  underlying_at_fire NUMERIC(10,4),
  acknowledged       BOOLEAN DEFAULT FALSE
);
CREATE UNIQUE INDEX tracker_alerts_dedup_idx
  ON tracker_alerts(contract_id, alert_type, threshold);
```

`threshold NOT NULL` is intentional: it lets a single unique index dedup
every alert type, including DTE-7 (stored as `threshold=7`).

## API surface

All endpoints gated by `guardOwnerOrGuestEndpoint`. Zod-validated input.

```
GET    /api/tracker/contracts?status=active|closed|expired
POST   /api/tracker/contracts        body: ContractCreate
PATCH  /api/tracker/contracts/:id    body: ContractUpdate
DELETE /api/tracker/contracts/:id    backend-only (not exposed in UI)
GET    /api/tracker/alerts/unread
POST   /api/tracker/alerts/:id/ack
```

Input parsing — accept either:
- free-text format (`NVDA 225P 05/22/26 @ 4.30 x 5 long`)
- structured form (ticker, expiry, strike, side, direction, entry_price, quantity)

Both paths funnel through `api/_lib/occ.ts` (`toOccSymbol(...) → "NVDA  260522P00225000"`).

## Cron — `api/cron/refresh-tracker-contracts.ts`

Registered in `vercel.json` at `*/5 13-20 * * 1-5` (matches existing 5-min pattern).

```ts
1. cronGuard(req);                       // CRON_SECRET check
2. if (!isMarketHours()) return;
3. const active = await sql`SELECT * FROM tracker_contracts WHERE status='active'`;
4. // Auto-expire any row past its expiry
5. // Group by ticker; fetch spot once per ticker, contract price per row
6. const ticks = await Promise.allSettled(live.map(uwOptionContract));
7. // Batched INSERT (500/query) into tracker_contract_ticks
8. // Evaluate alerts inline; ON CONFLICT DO NOTHING dedups
9. // Sentry capture per failed UW fetch (not silenced)
```

Alert evaluation per fresh tick:

- `pct = (last - entry_price) / entry_price * 100`
- For each `up_thresholds[i]` (default `[50,100,200]`): if `pct >= threshold` → fire `up_pct/threshold`
- For each `down_thresholds[i]` (default `[-30,-50]`): if `pct <= threshold` → fire `down_pct/threshold`
- For each `spot_alerts[]`: if op matches underlying → fire `spot_level/level`
- First time DTE hits 7 → fire `dte_7/7` (one-shot via dedup index)

Every `INSERT INTO tracker_alerts ... ON CONFLICT DO NOTHING` — each threshold
fires at most once per contract over its lifetime.

## Frontend

```text
src/components/Tracker/
├── TrackerSection.tsx          // top-level, mounts in App.tsx
├── TrackerTabs.tsx             // Active | Watchlist | Archive
├── AddContractForm.tsx         // structured form + free-text mode
├── ContractRow.tsx             // expandable row w/ thresholds editor
├── ContractTable.tsx           // group by Ticker OR Expiry toggle
├── ThresholdsEditor.tsx        // per-contract override UI (chips)
├── SpotAlertsEditor.tsx        // "SPY >= 595" rows
├── ArchiveStats.tsx            // win/loss ratio, avg hold, total PnL
└── __tests__/

src/hooks/
├── useTrackerContracts.ts      // fetch+CRUD pattern matching existing hooks
└── useTrackerAlerts.ts         // 30s poll of unread alerts; fires toasts
```

Tab semantics:

- **Active** — `status='active'`. Default group by Expiration; toggle to Ticker.
- **Watchlist** — derived from Active: `(DTE <= 7) OR has_unack_alert`. Client-side filter.
- **Archive** — `status IN ('closed','expired')`. Sortable. Stats card on top.

Row columns (Active/Watchlist):
`Ticker | Contract | Entry | Current | Δ$ | Δ% | DTE | Size | Notes | [Close]`

Toast copy:

- `up_pct/50` → 🟢 "NVDA 225P 05/22 hit +50% — now $6.45 (entry $4.30)"
- `down_pct/-30` → 🔴 "AMD 397.5P hit -30% — now $4.00 (entry $5.72)"
- `spot_level/595` → ⚪ "SPY crossed 595 — your NVDA 225P is at $4.30"
- `dte_7` → 🟡 "NVDA 225P 05/22 has 7 days to expiry"

Click toast → scroll to row, ack alert (server PATCH).

`src/main.tsx` botid `protect` array gets `/api/tracker/*` added.

## Error handling

- `Promise.allSettled` on per-ticker spot and per-contract option fetches.
  One UW failure does not abort the batch.
- Every settled-rejected entry → `Sentry.captureException` with tags
  `{ contract_id, occ_symbol, ticker }`. No silent `.catch(() => null)`.
- If UW returns 5xx for a contract, skip the tick write this cycle; next cron retries.
- Sentry breadcrumb at cron start with `{ active_count, unique_tickers }`.

## Phase plan

| Phase | Scope | Files |
|---|---|---|
| 1 | DB migrations + OCC helper + shared types | ~5 |
| 2 | Backend endpoints + cron + vercel.json + botid | ~8 |
| 3 | Frontend section + hooks + tests + e2e | ~12 |

Each phase: implement → code-reviewer subagent → fix findings → commit + push → next.

## Testing

| Test file | Covers |
|---|---|
| `api/__tests__/occ.test.ts` | OCC roundtrip (parse free-text, build OCC, parse OCC back) |
| `api/__tests__/tracker-contracts.test.ts` | CRUD endpoints with mocked DB |
| `api/__tests__/refresh-tracker-contracts.test.ts` | Full cron — happy path, partial UW failure, auto-expiry, alert dedup |
| `api/__tests__/tracker-alerts.test.ts` | Threshold evaluation pure logic |
| `api/__tests__/db.test.ts` | Migrations #160/161/162 added to mock sequence |
| `src/__tests__/Tracker/AddContractForm.test.tsx` | Free-text parser + form validation |
| `src/__tests__/Tracker/ContractRow.test.tsx` | Render + close action |
| `src/__tests__/hooks/useTrackerAlerts.test.ts` | Polling, toast firing, ack |
| `e2e/tracker.spec.ts` | Add → mock cron tick → toast → close → archive |

## Open items deferred to v2

- Discovery panel ("Stuck Whale Candidates") — surface large-premium prints
  from `flow_alerts` that have drawn down ≥30% without an offsetting exit print,
  filtered by `multileg-classify-batch.ts` to exclude spread legs. v2.
- Browser push notifications via service worker — fires when app is closed. v2.
- Per-guest scoping if a second guest key is ever issued. v2.
