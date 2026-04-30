# Whale Anomalies — Feature Spec

**Date:** 2026-04-29
**Status:** Plan — pending approval before Phase 1
**Replaces:** Strike IV Anomalies component (entire pipeline)

## Goal

Replace the under-performing Strike IV Anomalies component with a Whale
Anomalies component that surfaces ONLY the option-flow prints matching the
hand-derived whale-detection checklist (`docs/whale-detection-checklist.md`),
live during market hours and back-scrubbable with the existing date/time
scrubber UX.

## Why

The IV Anomalies detector flags ~10–30 prints/day, most of which are noise.
The whale checklist — calibrated against 11 days of EOD options-flow data —
surfaces 2–3 high-conviction prints/day that historically marked
floors/ceilings the day they fired. The user wants the component to reflect
that signal, not a generic z-score outlier.

## Existing infrastructure (re-used)

| Component                                | Status                       |
| ---------------------------------------- | ---------------------------- |
| `flow_alerts` table                      | Live, all rule types, 1-min cron, **SPXW-only** |
| `whale_alerts` table                     | Live, ≥$500K, 0-7 DTE, 5-min cron, **SPXW-only** |
| `api/_lib/flow-alert-derive.ts`          | Pure derivations (moneyness, ask/bid ratio, DTE, etc.) |
| `api/_lib/api-helpers.ts` (`uwFetch`)    | UW client with retry/timeout |
| EOD parquet archive (`scripts/eod-flow-analysis/output/by-day/`) | 11 days backfilled, growing nightly |
| Whale checklist module                   | `docs/whale-detection-checklist.md` |

The biggest unblock: **the live data pipeline is half-built.** We're not
starting from scratch — we're adding the whale-detection layer on top of an
existing flow-ingestion stack and expanding ticker coverage.

## Tickers

SPX, SPXW, NDX, NDXP, QQQ, SPY, IWM (7 total — same as the checklist).

## Phases

Each phase is independently shippable. After each phase: lint, test, commit,
then user review before next phase.

### Phase 1 — Multi-ticker whale-flow ingestion (~3 files, ~2 hours)

**Goal:** Expand the existing `fetch-whale-alerts` cron from SPXW-only to all
7 tickers. Each ticker becomes a row in `whale_alerts` with
`ticker_symbol` parameterized.

**Files:**
- modify `api/cron/fetch-whale-alerts.ts` — loop over WHALE_TICKERS array,
  fetch per-ticker, dedupe per-ticker pagination
- modify `api/__tests__/cron/fetch-whale-alerts.test.ts` — add multi-ticker
  mock sequence
- review `api/_lib/db-migrations.ts` — confirm `whale_alerts.ticker` column
  is text (not enum) — should already be flexible

**Schedule:** keep at `*/5 13-21 * * 1-5`. No change.

**Rate limit budget:** 7 tickers × 1 fetch/5min × ~1 page = ~7 calls per
cron run. Well under UW limits.

**Verification:**
- After deploy, query `SELECT ticker, COUNT(*) FROM whale_alerts WHERE
  created_at > NOW() - INTERVAL '1 hour' GROUP BY ticker;` — expect rows
  for at least 4 of 7 tickers during active hours.

### Phase 2 — `whale_anomalies` table + detection lib (~5 files, ~3 hours)

**Goal:** New DB table + pure logic that takes a `whale_alerts` row and
classifies it as a Type 1–4 whale move (or rejects it).

**New table:**

```sql
CREATE TABLE whale_anomalies (
  id                BIGSERIAL PRIMARY KEY,

  -- Source linkage
  source_alert_id   BIGINT REFERENCES whale_alerts(id) ON DELETE CASCADE,
  source            TEXT NOT NULL,    -- 'live' | 'eod_backfill'

  -- Identity
  ticker            TEXT NOT NULL,
  option_chain      TEXT NOT NULL,
  strike            NUMERIC NOT NULL,
  option_type       TEXT NOT NULL,    -- 'call' | 'put'
  expiry            DATE NOT NULL,

  -- Timing
  first_ts          TIMESTAMPTZ NOT NULL,
  last_ts           TIMESTAMPTZ NOT NULL,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Whale features (mirrored from the checklist)
  side              TEXT NOT NULL,    -- 'ASK' | 'BID'
  ask_pct           NUMERIC(4,3),
  total_premium     NUMERIC NOT NULL,
  trade_count       INTEGER NOT NULL,
  vol_oi_ratio      NUMERIC,
  underlying_price  NUMERIC,
  moneyness         NUMERIC(6,4),
  dte               INTEGER NOT NULL,

  -- Classification
  whale_type        SMALLINT NOT NULL,  -- 1, 2, 3, or 4
  direction         TEXT NOT NULL,      -- 'bullish' | 'bearish'
  pairing_status    TEXT,               -- 'alone' | 'sequential' | 'simultaneous_filtered'

  -- Outcome (filled by resolution cron after EOD)
  resolved_at       TIMESTAMPTZ,
  hit_target        BOOLEAN,
  pct_to_target     NUMERIC,

  CONSTRAINT uniq_whale UNIQUE (option_chain, first_ts)
);

CREATE INDEX idx_whale_anomalies_ticker_ts ON whale_anomalies (ticker, first_ts DESC);
CREATE INDEX idx_whale_anomalies_unresolved ON whale_anomalies (first_ts) WHERE resolved_at IS NULL;
CREATE INDEX idx_whale_anomalies_type ON whale_anomalies (whale_type);
```

**Files:**
- modify `api/_lib/db-migrations.ts` — add migration #70 (whale_anomalies)
- new `api/_lib/whale-detector.ts` — exports:
  - `WHALE_TICKERS` array
  - `WHALE_THRESHOLDS` object (per-ticker p95)
  - `classifyWhale(row): WhaleResult | null`
  - `detectPairing(row, sameStrikeRows): 'alone' | 'sequential' | 'simultaneous_filtered'`
- new `api/__tests__/whale-detector.test.ts` — unit tests for classifier
  using fixtures from the 28 historical actionable whales
- modify `api/__tests__/db.test.ts` — bump migration count + add
  whale_anomalies expectation

**Thresholds (Phase 2 baseline, hardcoded, source of truth):**

```ts
export const WHALE_THRESHOLDS = {
  SPX:  80_772_337,
  SPXW:  6_844_350,
  NDX:  26_039_632,
  NDXP:  2_615_032,
  QQQ:   5_661_186,
  SPY:   6_272_830,
  IWm:   9_328_335,
};
```

These are p95 of premium per ticker from the 11-day EOD archive (2026-04-13
through 2026-04-29). **Recompute and update every ~30 trading days.**

### Phase 3 — Historical backfill (~2 files, ~1 hour)

**Goal:** Populate `whale_anomalies` with the 28 actionable historical
whales from the EOD parquet archive so the new component has data to
display from day 1.

**Files:**
- new `scripts/backfill-whale-anomalies.py` — reads
  `scripts/eod-flow-analysis/output/by-day/*-chains.parquet`, applies
  checklist via the same logic as `whale-detector.ts` (mirrored), inserts
  into `whale_anomalies` with `source = 'eod_backfill'`. Uses psycopg2
  (matches the sidecar pattern; ml/.venv already has it via DB tooling).
- new `Makefile` target `backfill-whales` (one-shot)

**Verification:**
- `SELECT COUNT(*) FROM whale_anomalies WHERE source = 'eod_backfill';`
  → expect 28 (matching the manual analysis count)
- `SELECT trade_date, ticker, COUNT(*) FROM whale_anomalies GROUP BY 1, 2;`
  → SPXW: 18, NDXP: 9, SPY: 4, others: 0 (matches per-ticker breakdown)

### Phase 4 — Live whale-detector cron (~3 files, ~2 hours)

**Goal:** Cron that runs every 1 minute during market hours, reads new
`whale_alerts` rows since last invocation, classifies them, and inserts
qualifying ones into `whale_anomalies`.

**Files:**
- new `api/cron/detect-whales.ts` — handler:
  1. Read `MAX(detected_at)` from `whale_anomalies` WHERE source='live'
  2. Read all `whale_alerts` rows since that timestamp
  3. For each, fetch any same-strike same-expiry opposite-side row from
     `flow_alerts` (broader source) for pairing detection
  4. Run through `classifyWhale()` and `detectPairing()`
  5. Insert qualifying ones with `source='live'`
- new `api/__tests__/cron/detect-whales.test.ts`
- modify `vercel.json` — add `* 13-21 * * 1-5` schedule

**Schedule:** every minute during market hours. The detector itself is
cheap (DB-only, no external API calls), so 1-min cadence is fine.

### Phase 5 — API endpoint (~2 files, ~1 hour)

**Goal:** `GET /api/whale-anomalies` — query whales for a given date with
optional time-window scoping for the scrubber.

**Files:**
- new `api/whale-anomalies.ts`:
  - Query params: `date` (YYYY-MM-DD, required), `at` (ISO timestamp, optional — return only whales with `first_ts <= at`)
  - Returns: `{ whales: WhaleAnomaly[], asOf: string }`
  - Owner-or-guest gated (matches IV-anomalies access policy)
- new `api/__tests__/whale-anomalies.test.ts`

### Phase 6 — Frontend rebuild (~10 files, ~4 hours)

**Goal:** Replace `IVAnomalies` component tree with `WhaleAnomalies`.

**New files:**
- `src/components/WhaleAnomalies/WhaleAnomaliesSection.tsx` — main section
  (date picker + scrubber + ticker tabs + row list)
- `src/components/WhaleAnomalies/WhaleRow.tsx` — single whale row
  (mirrors AnomalyRow visual but with whale-specific fields:
   premium, side, type 1-4 badge, pairing status, target distance)
- `src/components/WhaleAnomalies/WhaleBanner.tsx` — alert banner for new
  live whales (preserves existing AnomalyBanner UX)
- `src/components/WhaleAnomalies/banner-store.ts` — banner state, mirror
  of existing pattern
- `src/hooks/useWhaleAnomalies.ts` — fetch hook with date + time scrubbing
- tests: `src/__tests__/components/WhaleAnomalies/{WhaleRow,WhaleBanner,banner-store}.test.{tsx,ts}`,
  `src/__tests__/hooks/useWhaleAnomalies.test.ts`

**Modified files:**
- `src/App.tsx` — swap `IVAnomaliesSection` import for `WhaleAnomaliesSection`
- `src/main.tsx` — add `/api/whale-anomalies` to botid `protect` array

**UI shape (preserved from existing):**
- Same layout: date picker on left, ticker tabs across the top, row list below
- Each row shows: ticker + strike, vol/OI, side (ASK/BID), exp, type badge
  (Floor/Ceiling/Floor break/Ceiling break), tape (active/early/etc.),
  premium, time, last fire ago, firings count
- Live "scrubber play" button preserved (steps through whales by `first_ts`)

### Phase 7 — Cleanup (~6 files deleted + 1 migration, ~1 hour)

**Goal:** Remove the deprecated IV anomaly stack now that whales replace it.

**Delete:**
- `src/components/IVAnomalies/` (entire directory)
- `src/hooks/useIVAnomalies.ts`, `src/hooks/useAnomalyCrossAsset.ts`
- `src/__tests__/components/IVAnomalies/` (entire directory)
- `src/__tests__/hooks/useIVAnomalies.test.ts`,
  `src/__tests__/hooks/useAnomalyCrossAsset.test.ts`
- `src/__tests__/StrikeIVChart.test.tsx`,
  `src/__tests__/IVAnomaliesSection.test.tsx`
- `api/iv-anomalies.ts`, `api/iv-anomalies-cross-asset.ts`
- `api/_lib/iv-anomaly.ts`, `api/_lib/anomaly-catalyst.ts`
- `api/cron/resolve-iv-anomalies.ts`, `api/cron/monitor-iv.ts`,
  `api/cron/fetch-strike-iv.ts`
- `api/__tests__/iv-anomalies*.test.ts`

**Migration:** add #71 — `DROP TABLE iv_anomalies; DROP TABLE strike_iv_snapshots;`

**Modify:**
- `vercel.json` — remove the 3 IV-anomaly cron entries
- `src/main.tsx` — remove `/api/iv-anomalies*` from botid protect array
- Anywhere else that imports from removed files (let `npm run lint` find them)

## Data dependencies

| Dependency        | Source             | Phase introduced |
| ----------------- | ------------------ | ---------------- |
| `whale_alerts`    | UW `/option-trades/flow-alerts` | Pre-existing (Phase 1 expands) |
| `flow_alerts`     | UW (1-min cron)   | Pre-existing |
| EOD parquets      | bot CSV → parquet | Pre-existing |
| `whale_anomalies` | new table          | Phase 2 |
| `WHALE_THRESHOLDS` | hardcoded constants | Phase 2; recompute every 30 trading days |

## Decisions (locked 2026-04-29)

1. **Cross-asset tab:** **DROPPED.** One unified dashboard. All 7 tickers
   visible by tabs in a single component. Each row has a clickable
   contract link (deep-link to UW) and surfaces all applicable whale info.
2. **Banner notifications for live whales:** **KEPT.** New live whales
   trigger a banner toast.
3. **Old `iv_anomalies` data:** **DROPPED.** Phase 7 includes
   `DROP TABLE iv_anomalies; DROP TABLE strike_iv_snapshots;`. No archive.
4. **Resolution outcomes:** **IN SCOPE for v1.** New Phase 4.5 added —
   `api/cron/resolve-whales.ts` runs after market close, fills
   `resolved_at`, `hit_target`, `pct_to_target` for unresolved rows by
   comparing the day's intraday range vs the strike.

## Thresholds and constants (codified)

| Constant            | Value                                       | Source                          |
| ------------------- | ------------------------------------------- | ------------------------------- |
| `WHALE_THRESHOLDS.SPX`  | $80,772,337                             | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.SPXW` | $6,844,350                              | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.NDX`  | $26,039,632                             | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.NDXP` | $2,615,032                              | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.QQQ`  | $5,661,186                              | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.SPY`  | $6,272,830                              | p95 of 11-day archive           |
| `WHALE_THRESHOLDS.IWM`  | $9,328,335                              | p95 of 11-day archive           |
| `MIN_TRADE_COUNT`       | 5                                       | checklist                       |
| `MAX_DTE`               | 14                                      | checklist                       |
| `MAX_MONEYNESS`         | 0.05 (i.e. ±5%)                         | checklist                       |
| `MIN_ONE_SIDED`         | 0.85                                    | checklist                       |
| `PAIRING_OVERLAP_SEC`   | 60 (window > 60s = simultaneous)        | from prior synthetic detector   |
| Cron `detect-whales`    | `* 13-21 * * 1-5` (every minute, market hours) | matches flow-alerts cadence |

## Success criteria

After all 7 phases:

- [ ] `whale_anomalies` table contains ≥ 28 historical rows (from backfill)
- [ ] During next market open, new whales appear within 1–2 minutes of UW
      detection (live cron working)
- [ ] Component renders ≤ 5 whales per active ticker on a typical day
- [ ] Date scrubber lets user step backward through prior days
- [ ] Time scrubber within a day lets user replay alerts in order
- [ ] Lint + tests + e2e all pass
- [ ] Old IV anomaly stack fully removed; lint surfaces zero references

## Rollout / risk mitigation

- **No feature flag.** This is a single-owner app — no need to gate.
- **Phase 1 is independent of all UI changes.** If Phase 1 ships and the
  multi-ticker fetch breaks, no user-facing impact.
- **Phase 2 + 3 deliver historical backfill before live cron.** Even if
  Phase 4 (live cron) takes longer or has bugs, the user has 28 historical
  whales to look at via Phase 5's API.
- **Phase 7 (cleanup) only runs after Phase 6 (UI rebuild) is verified.**
  Until then, the old IVAnomalies code keeps working in parallel.
- **Migration #71 is destructive (DROP TABLE).** Run a `pg_dump` of the
  two doomed tables to Vercel Blob first if there's any chance the data
  matters. Default: drop, no archive.

## Estimated total scope

- **~25 files touched** across the 7 phases
- **~14 hours of focused work** spread across multiple sessions
- Best executed via **subagent-driven-development** per phase per
  user memory

## Next step

User confirms plan or requests revisions.
On confirmation, dispatch Phase 1 via subagent.
