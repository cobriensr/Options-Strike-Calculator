# Boundary Validation Spec — CROSS-005

**Audit finding:** `CROSS-005` from [principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md#L795-L801). Severity: High.

**Authored:** 2026-04-09 by Claude after clearing BE-CRON-010, CSV-001, FE-STATE-001, BE-CRON-001, and CROSS-002 in the same session. This document consolidates the parallel investigations of three Explore subagents (backend TS, sidecar Python, frontend + ML).

**Companion docs:**

- [analyze-prompt-enhancements-2026-04-08.md](analyze-prompt-enhancements-2026-04-08.md) — analyze prompt enhancements
- [directional-buying-spec-2026-04-08.md](directional-buying-spec-2026-04-08.md) — directional long-option discipline

---

## Purpose

CROSS-005 is the last remaining High-severity item in the audit after the 5-session audit cleanup run. Unlike the other items (which were focused fixes in 1-3 files), CROSS-005 is an **architectural pattern** that spans every system boundary: CSV → analyze, dark pool → context, sidecar → DB, Schwab → token, feature pipeline → ML. The fix is to validate every boundary with Zod (TS) or pydantic (Py), emit a Sentry breadcrumb on every validation failure, and make drops alertable rather than silent.

Because this is cross-cutting architectural work touching 40+ sites across TypeScript, Python sidecar, Python ML pipeline, and the frontend, **it cannot be done in a single session** like the other audit items. This document exists so that when you revisit CROSS-005, you have a complete inventory, a clear pattern, a phased rollout plan, and answers to the known design questions — without needing to re-run the investigation.

## How CROSS-005 relates to CROSS-002 (already done)

CROSS-002 added `metrics.increment()` calls at **catch sites** where errors were being silently swallowed. The scope was "errors that happen" — API fetch failures, DB write failures, per-row drops. CROSS-005 is the upstream pair: "data that shouldn't have been accepted in the first place." Where CROSS-002 asks _did this call fail?_, CROSS-005 asks _is the data we got actually the shape we expected?_

The two compose naturally. A Zod validation failure at a boundary should:

1. Log via `logger.warn({ err, data: summary }, 'Validation failed')`
2. Increment a metric: `metrics.increment('module.boundary.validation_failure')`
3. For high-stakes sites, also call `Sentry.captureException(...)`
4. Return a safe fallback (empty array, null, or filtered-out row) — NOT throw

This is the same pattern CROSS-002 established, just applied at validation boundaries instead of catch blocks. A future Sentry dashboard can show both `*.error` (CROSS-002 catches) and `*.validation_failure` (CROSS-005 boundaries) side by side to get the full picture of data quality.

---

## Current state — what's already validated

Before the inventory of gaps, here's what's **already correct**:

### HTTP request bodies (✅ covered)

Three Zod schemas in [api/\_lib/validation.ts](../../../api/_lib/validation.ts) cover the three POST endpoints that accept bodies from the frontend:

- `analyzeBodySchema` — `/api/analyze` request body (images, context, mode). `analyze.ts:78` calls `safeParse` and returns 400 on failure.
- `preMarketBodySchema` — `/api/pre-market` request body.
- `snapshotBodySchema` — `/api/snapshot` request body.

### Claude response (⚠️ partially covered with unsafe fallback)

`analysisResponseSchema` exists in the same file (280 lines of nested Zod) and `analyze.ts:224-236` calls `safeParse` on Claude's JSON output. **However**, the fallback at line 236 accepts raw parsed JSON if validation fails (`return parsed as AnalysisResponse`). This is an unsafe escape hatch — missing fields silently crash downstream code that reads `fullResponse.reasoning`, `fullResponse.managementRules`, etc.

### Sidecar config (✅ partially covered)

[sidecar/src/config.py](../../../sidecar/src/config.py) uses `pydantic-settings` for env var parsing (DATABASE_URL, DATABENTO_API_KEY, PORT, LOG_LEVEL). Type coercion is automatic but semantic bounds (URL scheme, port range 1-65535, log level enum) are not enforced.

### Sentry setup (✅ covered)

Both backend (`api/_lib/sentry.ts`) and sidecar (`sidecar/src/sentry_setup.py`) have Sentry initialization. The observability substrate exists — validation failures just need to wire into it.

### ML pipeline partial coverage (⚠️)

[ml/src/utils.py](../../../ml/src/utils.py) has `validate_dataframe()` that checks row counts, required columns, range checks, and null coverage. But it's opt-in (must be called explicitly by the pipeline) and doesn't enforce dtypes or the completeness of feature groups like `VOLATILITY_FEATURES` or `GEX_FEATURES_T1T2`.

---

## Part 1 — Backend TypeScript boundaries

Inventory of all backend TS sites where external or untrusted data enters the system. State legend: ✅ validated, ⚠️ type-asserted only, ❌ raw consumption, 🔁 partial.

### 1.1 Unusual Whales API ingress

These are **all unvalidated** currently. UW is semi-trusted (partner API, well-specified OpenAPI docs in `.claude/skills/unusual-whales-api/`), but the responses come as JSON strings that get `Number()`'d downstream, silently turning into `NaN` on any surprise.

| #   | Boundary                                           | File:line                                                                            | State                                 | Priority     | Blast radius                                                              |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| 1   | Dark pool trades (`uwFetch<DarkPoolTrade>`)        | [darkpool.ts:85-155](../../../api/_lib/darkpool.ts#L85-L155)                         | ❌                                    | **Critical** | Filter logic runs on unvalidated fields, bad rows contaminate aggregation |
| 2   | Market Tide (NCP/NPP as strings)                   | [fetch-flow.ts:52-60](../../../api/cron/fetch-flow.ts#L52-L60)                       | ❌                                    | **High**     | `Number(r.ncp)` → NaN silently propagates into ML features                |
| 3   | Strike exposure (16 numeric string fields)         | [fetch-strike-exposure.ts:75-88](../../../api/cron/fetch-strike-exposure.ts#L75-L88) | ❌                                    | **High**     | `Number.parseFloat()` × 16, any bad field corrupts that strike            |
| 4   | Greek exposure aggregate (8 numeric strings)       | [fetch-greek-exposure.ts:61-67](../../../api/cron/fetch-greek-exposure.ts#L61-L67)   | ❌                                    | **Critical** | Aggregate gamma feeds Rule 16 directly — NaN = wrong regime call          |
| 5   | Greek exposure by expiry                           | same file, different route                                                           | ❌                                    | **High**     | Per-expiry breakdown in Claude context                                    |
| 6   | Max pain                                           | [max-pain.ts:fetchMaxPain](../../../api/_lib/max-pain.ts)                            | ❌                                    | Medium       | Single scalar, low blast radius                                           |
| 7   | SPX 1m candles (OHLCV from UW)                     | [fetch-spx-candles-1m.ts:translateRows](../../../api/cron/fetch-spx-candles-1m.ts)   | ⚠️ (NaN filter exists from CROSS-002) | Medium       | Handled per-row by CROSS-002 counter; add full schema                     |
| 8   | Vol 0DTE per strike                                | [fetch-vol-0dte.ts](../../../api/cron/fetch-vol-0dte.ts)                             | ⚠️                                    | Medium       | parseOptionSymbol returns null, CROSS-002 counter                         |
| 9   | ETF Tide (SPY/QQQ)                                 | [fetch-etf-tide.ts](../../../api/cron/fetch-etf-tide.ts)                             | ⚠️                                    | Medium       | CROSS-002 counter at sampleTo5Min NaN coerce                              |
| 10  | Flow per strike                                    | various fetch-flow-\* files                                                          | ❌                                    | High         | Per-strike flow → ML features                                             |
| 11  | OI per strike                                      | [fetch-oi-per-strike.ts](../../../api/cron/fetch-oi-per-strike.ts)                   | ❌                                    | Medium       | OI change features                                                        |
| 12  | Net flow expiry                                    | [fetch-net-flow-expiry.ts](../../../api/cron/fetch-net-flow-expiry.ts)               | ❌                                    | Medium       | Direction context                                                         |
| 13  | Greek flow (delta/vega per tick)                   | [fetch-greek-flow.ts](../../../api/cron/fetch-greek-flow.ts)                         | ❌                                    | Medium       | 0DTE delta flow signal                                                    |
| 14  | IV monitor ticks                                   | [monitor-iv.ts](../../../api/cron/monitor-iv.ts)                                     | ❌                                    | Medium       | IV spike alerts                                                           |
| 15  | Flow ratio monitor                                 | [monitor-flow-ratio.ts](../../../api/cron/monitor-flow-ratio.ts)                     | ❌                                    | Medium       | Flow ratio regime                                                         |
| 16  | IV term structure (on-demand from analyze context) | [analyze-context.ts:IV term block](../../../api/_lib/analyze-context.ts)             | ❌                                    | Medium       | Straddle cone comparison                                                  |
| 17  | Spot exposures panel                               | [fetch-spot-gex.ts](../../../api/cron/fetch-spot-gex.ts)                             | ❌                                    | High         | Intraday GEX panel for Claude                                             |

**Suggested Zod primitive** (reused across all UW numeric fields):

```ts
const numericString = z
  .string()
  .refine(
    (s) => !Number.isNaN(Number(s)),
    'Must be a parseable numeric string',
  );
```

**Suggested pattern at UW ingress**:

```ts
const parsed = response.data
  .map((row) => SchemaName.safeParse(row))
  .filter((r) => {
    if (!r.success) {
      logger.warn({ errors: r.error.flatten() }, 'UW row validation failed');
      metrics.increment('uw.<source>.validation_failure');
      return false;
    }
    return true;
  })
  .map((r) => r.data);
```

### 1.2 Schwab API ingress

| #   | Boundary                                   | File:line                                                   | State | Priority |
| --- | ------------------------------------------ | ----------------------------------------------------------- | ----- | -------- |
| 18  | Account positions (`SchwabAccount`)        | [positions.ts:252-348](../../../api/positions.ts#L252-L348) | ⚠️    | Medium   |
| 19  | Schwab tokens in Redis (`getStoredTokens`) | [schwab.ts:104-112](../../../api/_lib/schwab.ts#L104-L112)  | ⚠️    | **High** |
| 20  | Price history (`pricehistory` endpoint)    | [schwab.ts or fetch-outcomes.ts]                            | ⚠️    | Medium   |
| 21  | Chain data (options chain)                 | [api/chain.ts or similar]                                   | ⚠️    | High     |

**Token storage** (#19) is particularly important — if a stored token shape is corrupted (missing field, wrong type for `expiresAt`), the whole auth path silently fails with a cryptic undefined navigation rather than a clear "token invalid" message.

### 1.3 Database read boundaries (type-asserted JSONB columns)

Postgres enforces column types at the DB level, but JSONB columns and string-to-number conversions are fully unchecked on the read path. These are the highest-impact gaps because a corrupted row in the DB can silently break every downstream consumer until the row is manually fixed.

| #   | Boundary                                                | File:line                                                              | State | Priority                   | Blast radius                                                              |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------- | ----- | -------------------------- | ------------------------------------------------------------------------- |
| 22  | `analyses.full_response` JSONB                          | [db-analyses.ts:160-164](../../../api/_lib/db-analyses.ts#L160-L164)   | ❌    | **Critical**               | `fullResponse.reasoning` etc. accessed unchecked — crash on missing field |
| 23  | `positions.legs` JSONB                                  | [db-positions.ts:129-131](../../../api/_lib/db-positions.ts#L129-L131) | ⚠️    | Medium                     | `PositionLeg[]` cast without validation                                   |
| 24  | `market_snapshots.strikes` JSONB                        | [db-snapshots.ts:240-254](../../../api/_lib/db-snapshots.ts#L240-L254) | ❌    | High                       | Used in VIX OHLC retrieval                                                |
| 25  | `flow_data` ncp/npp numeric conversion                  | [db-flow.ts:22-51](../../../api/_lib/db-flow.ts#L22-L51)               | ❌    | **High**                   | `Number(r.ncp)` → NaN → ML features                                       |
| 26  | `greek_exposure` numeric conversion                     | [db-flow.ts:163-196](../../../api/_lib/db-flow.ts#L163-L196)           | ❌    | **High**                   | `Number.parseFloat(r.call_gamma)` → NaN → wrong regime                    |
| 27  | `lesson_reports.report` JSONB                           | [lessons.ts](../../../api/_lib/lessons.ts)                             | ⚠️    | Low                        |
| 28  | `training_features` row read (back into build-features) | [build-features.ts](../../../api/cron/build-features.ts)               | ⚠️    | High — ML feature pipeline |

### 1.4 CSV ingestion

| #   | Boundary              | File:line                                                          | State | Priority |
| --- | --------------------- | ------------------------------------------------------------------ | ----- | -------- |
| 29  | `parseFullCSV` output | [csv-parser.ts:424-492](../../../api/_lib/csv-parser.ts#L424-L492) | ⚠️    | Medium   |

The CSV parser is permissive by design — it silently drops rows that don't look like SPX options or don't parse cleanly. There's no Zod schema over the `ParsedCSV` output, so downstream consumers (`buildFullSummary`, `buildOpenSpreadsFromTrades`) trust whatever the parser produces. CSV-001 added sub-second bucketing but didn't add validation.

### 1.5 LLM response

| #   | Boundary                | File:line                                               | State | Priority     |
| --- | ----------------------- | ------------------------------------------------------- | ----- | ------------ |
| 30  | Claude analyze response | [analyze.ts:224-236](../../../api/analyze.ts#L224-L236) | ⚠️    | **Critical** |

This is technically validated via `analysisResponseSchema.safeParse(parsed)` at line 225, but line 236 has an unsafe fallback that returns raw parsed JSON on validation failure. **The fallback must be tightened** — either reject with 500, or enforce a minimal-required-fields check before accepting the raw parse.

### 1.6 Redis reads beyond tokens

Most Redis reads are simple string values (OAuth state nonces, rate-limit counters) and don't need Zod validation. The one gap is token storage (#19 above).

---

## Part 2 — Sidecar Python boundaries

The sidecar is Python (not TypeScript as CLAUDE.md originally claimed) and uses Databento's Live Client for real-time futures + options data. Almost nothing is pydantic-validated currently, and `pydantic-settings` is the only pydantic dependency.

### 2.1 Databento ingress (WebSocket callbacks)

| #   | Boundary                                 | File:line                                                                         | State | Priority     |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------- | ----- | ------------ |
| 31  | OHLCV record ingestion (`_handle_ohlcv`) | [databento_client.py:380-410](../../../sidecar/src/databento_client.py#L380-L410) | ⚠️    | **High**     |
| 32  | Trade record ingestion (`_handle_trade`) | [databento_client.py:420-480](../../../sidecar/src/databento_client.py#L420-L480) | 🔁    | **Critical** |
| 33  | Stat ingestion (settlement/IV/delta/OI)  | [databento_client.py:490-530](../../../sidecar/src/databento_client.py#L490-L530) | ❌    | Medium       |
| 34  | Instrument definition caching            | [databento_client.py:540-570](../../../sidecar/src/databento_client.py#L540-L570) | ⚠️    | **High**     |
| 35  | Symbol mapping (prefix → internal)       | [databento_client.py:300-330](../../../sidecar/src/databento_client.py#L300-L330) | ⚠️    | Medium       |

**Notable**: trade ingestion (#32) has partial observability from SIDE-012 (definition-lag drop counter) but no input validation. A trade with a negative price or a timestamp from 1970 would be silently accepted, stored in the DB, and show up in the frontend chart as a spike.

**Suggested pydantic v2 pattern** for all 5 boundaries:

```python
from pydantic import BaseModel, Field, field_validator
from decimal import Decimal
from datetime import datetime, timezone

class OHLCVBoundary(BaseModel):
    symbol: str
    ts: datetime
    open_: Decimal = Field(..., ge=Decimal("0"), le=Decimal("100000"))
    high: Decimal = Field(..., ge=Decimal("0"), le=Decimal("100000"))
    low: Decimal = Field(..., ge=Decimal("0"), le=Decimal("100000"))
    close: Decimal = Field(..., ge=Decimal("0"), le=Decimal("100000"))
    volume: int = Field(..., ge=0)

    @field_validator("ts")
    @classmethod
    def ts_within_range(cls, v: datetime) -> datetime:
        now = datetime.now(timezone.utc)
        if v > now or (now - v).total_seconds() > 86_400:
            raise ValueError("Timestamp more than 24h old or in future")
        return v
```

### 2.2 Trade processor (in-memory buffer)

| #   | Boundary                               | File:line                                                                   | State | Priority     |
| --- | -------------------------------------- | --------------------------------------------------------------------------- | ----- | ------------ |
| 36  | `TradeRecord` dataclass transformation | [trade_processor.py:40-90](../../../sidecar/src/trade_processor.py#L40-L90) | ❌    | **Critical** |

This is the highest-impact Python boundary: every trade passes through it, and the `TradeRecord` dataclass has zero validation. Strike can be negative, price can be negative, expiry can be in the past, option_type can be any string. Convert to pydantic BaseModel before anything else.

### 2.3 DB writes

| #   | Boundary                           | File:line                                             | State               | Priority     |
| --- | ---------------------------------- | ----------------------------------------------------- | ------------------- | ------------ |
| 37  | `upsert_futures_bar`               | [db.py:167-191](../../../sidecar/src/db.py#L167-L191) | ⚠️ (DB schema only) | Medium       |
| 38  | `batch_insert_options_trades`      | [db.py:228-254](../../../sidecar/src/db.py#L228-L254) | ❌                  | **Critical** |
| 39  | `upsert_options_daily` (EOD stats) | [db.py:257-302](../../../sidecar/src/db.py#L257-L302) | ⚠️                  | Medium       |

### 2.4 Config / env

| #   | Boundary              | File:line                                                             | State                                               | Priority |
| --- | --------------------- | --------------------------------------------------------------------- | --------------------------------------------------- | -------- |
| 40  | `Settings` (env vars) | [config.py:1-40](../../../sidecar/src/config.py#L1-L40)               | 🔁 (pydantic-settings types but no semantic checks) | **High** |
| 41  | Sentry DSN            | [sentry_setup.py:25-72](../../../sidecar/src/sentry_setup.py#L25-L72) | ⚠️                                                  | Low      |

### 2.5 Symbol / date computation

| #   | Boundary                                         | File:line                                                                   | State | Priority |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------- | ----- | -------- |
| 42  | `compute_atm_strikes`, `build_es_option_symbols` | [symbol_manager.py:1-80](../../../sidecar/src/symbol_manager.py#L1-L80)     | ⚠️    | Medium   |
| 43  | `third_friday`, `get_nearest_es_expiry`          | [symbol_manager.py:90-110](../../../sidecar/src/symbol_manager.py#L90-L110) | ⚠️    | Low      |

### 2.6 Health endpoint

| #   | Boundary               | File:line                                               | State | Priority |
| --- | ---------------------- | ------------------------------------------------------- | ----- | -------- |
| 44  | `HealthHandler.do_GET` | [health.py:1-50](../../../sidecar/src/health.py#L1-L50) | ✅    | Low      |

Health endpoint is read-only and already has pattern checks. Low priority.

---

## Part 3 — Frontend and ML pipeline boundaries

### 3.1 Frontend → backend response validation

**All 9 frontend hooks use `await res.json() as Type` without any runtime validation.** The frontend trusts the backend implicitly — which is usually fine for same-origin calls, but means a backend regression (e.g., a schema drift after a DB migration) would propagate to the UI as `undefined.field` crashes instead of a clean error.

| #   | Hook                                                               | Endpoint               | State | Priority     |
| --- | ------------------------------------------------------------------ | ---------------------- | ----- | ------------ |
| 45  | `useMarketData.fetchers` (quotes/intraday/yesterday/events/movers) | 5 endpoints            | ⚠️    | High         |
| 46  | `useChainData`                                                     | `/api/chain`           | ⚠️    | **Critical** |
| 47  | `useDarkPoolLevels`                                                | `/api/darkpool-levels` | ⚠️    | High         |
| 48  | `useGexPerStrike`                                                  | `/api/gex-per-strike`  | ⚠️    | High         |
| 49  | `useMLInsights`                                                    | `/api/ml/plots`        | ⚠️    | Medium       |

### 3.2 CSV upload client-side

Entry point: [src/components/PositionMonitor/index.tsx](../../../src/components/PositionMonitor/index.tsx) handles file drag/paste. There is **no client-side validation** — no file size check, no MIME type check, no CSV header check, no try/catch around `parseStatementCSV`. A malformed CSV crashes the parser silently and the UI degrades without user feedback.

### 3.3 localStorage reads

| #   | Key                                     | File:line                                                           | State | Priority                                 |
| --- | --------------------------------------- | ------------------------------------------------------------------- | ----- | ---------------------------------------- |
| 50  | `VIX_DATA_STORAGE_KEY`                  | [vixStorage.ts:loadCachedVixData](../../../src/utils/vixStorage.ts) | ❌    | **High** (user can corrupt via DevTools) |
| 51  | App state (selected time, symbol, etc.) | [useAppState.ts](../../../src/context/useAppState.ts)               | ❌    | Medium                                   |

**`vixStorage` is a real crash risk**: a user opens DevTools, edits the localStorage VIX key to invalid JSON, reloads the page, `JSON.parse` throws an uncaught exception, app breaks. Zod-validate the loaded shape with a safe fallback to "no cache" when invalid.

### 3.4 ML pipeline

| #   | Boundary                                                                | File:line                                                                  | State                               | Priority |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------- | -------- |
| 52  | `load_data()` → DataFrame from SQL                                      | [phase2_early.py](../../../ml/src/phase2_early.py) via `pd.read_sql_query` | 🔁 (`validate_dataframe` is opt-in) | **High** |
| 53  | Feature group completeness (`VOLATILITY_FEATURES`, `GEX_FEATURES_T1T2`) | feature selection in phase2_early                                          | ❌                                  | **High** |
| 54  | Model I/O (sklearn/xgboost fit)                                         | training loop                                                              | ⚠️ (implicit via sklearn)           | Medium   |

**Notable gap:** `validate_dataframe()` in `ml/src/utils.py` checks row counts, required columns, ranges, and nulls, but **must be called explicitly** — training can run without it. The feature group assertion (that all columns in `VOLATILITY_FEATURES` actually exist in the DataFrame before `model.fit`) is missing entirely. A column rename in the feature pipeline would silently drop that column from the training set and the model would silently learn from the wrong features.

---

## Part 4 — Proposed implementation approach

### Design decisions (locked in, review before starting)

1. **Parse-then-filter, not parse-or-throw.** Zod/pydantic validation failures should log, increment a metric, and either filter out the bad row or fall back to a safe default. **Never** let a single bad row throw from a batch. This matches the CROSS-002 pattern where one failed DB insert in a loop just increments a counter and continues.

2. **Use the existing `metrics.increment` + `logger.warn` + optional `Sentry.captureException` pattern from CROSS-002.** All validation sites should emit a tag in the format `<module>.<boundary>_validation_failure` (e.g., `uw.darkpool_validation_failure`, `db.analyses_full_response_validation_failure`, `sidecar.trade_record_validation_failure`). Then add a Sentry alert rule that pages when any `.validation_failure` tag exceeds N events per hour.

3. **Zod v3 for TypeScript, pydantic v2 for Python.** Zod is already in use (`api/_lib/validation.ts`). Pydantic-settings (v2) is already installed in the sidecar. No new dependencies required.

4. **Shared schema exports.** Put all UW API schemas in `api/_lib/uw-schemas.ts` so they can be imported by fetchers, crons, and test fixtures. Don't let each file define its own Zod schema for the same shape — drift is inevitable.

5. **Sidecar: introduce a `sidecar/src/schemas.py` module.** Same principle — one place for all pydantic models, imported by databento_client.py, trade_processor.py, db.py. Keeps the boundary definitions decoupled from the consumers.

6. **Frontend: lighter touch.** Don't add Zod to all 9 hooks at once. Start with the two highest-impact boundaries (`useChainData` because chains are complex nested shapes, and `vixStorage` because users can corrupt it). The other hooks can wait until a schema actually drifts.

7. **The LLM response fallback at `analyze.ts:236` should be tightened to require the critical fields** (`structure`, `confidence`, `reasoning`) or reject with 500. Full schema mismatch is a legitimate Claude output issue and should page.

### Phased rollout (7 phases across 3 codebases)

Each phase is standalone, committable, and tests-pass-independently. Estimated file count per phase (aiming for ≤8 files per phase so each can be a focused code review):

**Phase 1 — TypeScript UW ingress (highest blast radius)** ~6 files

- Create `api/_lib/uw-schemas.ts` with `DarkPoolTradeSchema`, `MarketTideRowSchema`, `StrikeRowSchema`, `GreekExposureRowSchema` (aggregate + expiry), `numericString` helper.
- Apply at the 5 highest-priority UW fetchers: darkpool.ts, fetch-flow.ts, fetch-strike-exposure.ts, fetch-greek-exposure.ts, fetch-spot-gex.ts.
- Test fixtures that validate schemas against real UW response fixtures (capture a real response once with `curl`, save as JSON fixture, `.parse()` in a test).

**Phase 2 — TypeScript DB read boundaries** ~5 files

- `db-analyses.ts` `full_response` JSONB validation (highest priority — Claude output shape).
- `db-snapshots.ts` strikes column.
- `db-positions.ts` legs column.
- `db-flow.ts` numeric field conversions (flow_data + greek_exposure).
- Add `metrics.increment('db.<table>_<col>_validation_failure')` on each.

**Phase 3 — TypeScript LLM response + Schwab token hardening** ~4 files

- Tighten the `analyze.ts:236` fallback (remove or restrict to missing-non-critical-fields).
- Add `SchwabTokensSchema` in `schwab.ts` and validate on `getStoredTokens` read.
- Add schema for Schwab positions response (`SchwabAccountSchema`) in `positions.ts`.
- Add schema for Schwab price history response.

**Phase 4 — Remaining TypeScript UW cron boundaries** ~8 files

- Apply UW schemas to the remaining ~10 cron fetchers from Part 1.1 items #7-17. These are lower-blast-radius but still worth closing.
- CSV parser output Zod schema.

**Phase 5 — Sidecar Python (critical path)** ~4 files

- Create `sidecar/src/schemas.py` with pydantic models for `OHLCVBoundary`, `TradeRecordBoundary`, `StatMessageBoundary`, `OptionDefinition`.
- Convert `TradeRecord` dataclass to pydantic BaseModel (highest priority — #36).
- Apply validation at the 3 Databento callbacks (#31, #32, #33) and #34 (definition caching).
- Wire `sentry_sdk.capture_exception` + a counter into each validation failure.

**Phase 6 — Sidecar DB writes + config hardening** ~3 files

- `batch_insert_options_trades` (#38) — validate each row before `execute_values`.
- `upsert_options_daily` (#39) — validate optional numeric bounds (IV 0-10, delta -1 to 1, OI ≥ 0).
- `config.py` (#40) — add `field_validator` for `database_url` (postgresql:// scheme), port range, log level enum.

**Phase 7 — Frontend + ML pipeline (lowest impact)** ~5 files

- `useChainData` Zod response validation (highest frontend priority).
- `vixStorage.ts` Zod validation on `loadCachedVixData` with safe fallback.
- Enforce `validate_dataframe()` call in `phase2_early.py`'s `load_data` path (make it mandatory rather than opt-in).
- Add feature group completeness assertion before `model.fit` in the training loop.

**Total**: ~35 files, 7 commits, ~25-40 Zod/pydantic schemas, ~45 validation sites.

### How to parallelize this with subagents

Same approach as CROSS-002 — dispatch Phases 1-7 as parallel subagents in isolated worktrees, each committing to its own branch, then review + cherry-pick. The pattern worked well for CROSS-002 (all 5 phases passed review on the first try after one minor test-fixture fixup). Phases 1-4 have no cross-dependencies, Phase 5 depends on nothing, Phase 6 depends on Phase 5 (only because both touch sidecar files), Phase 7 is independent. **Phases 1, 2, 3, 4, 5, 7 can run in parallel; Phase 6 waits for Phase 5**.

---

## Part 5 — Open questions to answer before starting

1. **How strict should the Claude response schema be?** The current fallback at `analyze.ts:236` is lax precisely because Claude's output occasionally drifts (missing optional fields, extra nested objects). The options are:
   - (a) Strict: reject with 500 on any validation failure. Forces prompt updates when Claude drifts, but paging for each drift is noisy.
   - (b) Require critical fields only: `structure`, `confidence`, `reasoning`. Everything else optional.
   - (c) Keep the fallback but increment a metric + captureException so drift is visible without paging.

   **Recommended**: (c) for stability, (b) for correctness. Pick before Phase 3.

2. **Should UW schemas be exhaustive or permissive?** UW occasionally adds new fields to their responses. Options:
   - (a) `z.object({...}).strict()` — fail on unknown fields, catches drift immediately.
   - (b) `z.object({...})` (default, non-strict) — ignore unknown fields, tolerates drift.

   **Recommended**: (b) for production. (a) makes sense during development to catch missing specs, but (b) is the right production default because UW shouldn't be able to page us by adding a field.

3. **What's the acceptable per-row drop rate?** If Phase 1 starts dropping 5% of dark pool rows due to validation failures, is that "the schema is too strict" or "the data has a real quality problem we were ignoring"?

   **Recommended**: before Phase 1, run the schema against 30 days of historical UW responses (via a one-shot script) and count the drops. If >1% of rows fail, the schema needs loosening (likely by making fields optional). If <0.1%, the schema is right and the drops are genuine anomalies.

4. **Do we need a schema registry or migration story?** If schemas are versioned and the DB has historical rows written under an old schema, do we need to track which schema version wrote each row?

   **Recommended**: no. Version schemas inline via Zod — a single "current" shape is enough. If a historical row fails validation, drop it and log; it's not worth the complexity of multi-version support for a single-owner project.

5. **Should the sidecar pydantic models share types with the TypeScript side?** There's no shared type registry between TS and Python — they each define their own shapes. A corrupted trade flowing from sidecar → DB → TS analyze context would be caught on both sides independently, but the schemas can drift over time.

   **Recommended**: don't try to share. The cost of cross-language type generation (e.g., JSON Schema → both TS and Python) is high, and the benefit is small given both sides have their own tests.

6. **Does the frontend need Zod on every response, or just the complex ones?** Adding Zod to all 9 hooks is ~9 new schemas and ~200 lines of boilerplate. Options:
   - (a) All 9 hooks, all shapes validated.
   - (b) Only the high-complexity ones (`useChainData`, `useGexPerStrike`, `useDarkPoolLevels`) + the localStorage ones (`vixStorage`).
   - (c) Only the ones where a shape drift would crash the app (all of them, really).

   **Recommended**: (b) for Phase 7. Add the simpler ones opportunistically when the hook is already being touched for other reasons.

7. **What happens when an in-flight cron is killed mid-validation?** Vercel functions have a 300s timeout. If validation adds meaningful latency to a large batch (e.g., 10k UW rows), some crons could start timing out.

   **Recommended**: Zod is fast (~microseconds per row even for complex schemas). Not a concern for any real-world batch size. Verify with a benchmark in Phase 1 on the largest UW response (probably `spot-exposures/strike?limit=500`).

---

## Part 6 — Files verified during investigation

Files that were read directly (trust the citations in Parts 1-3 completely):

- [api/\_lib/validation.ts](../../../api/_lib/validation.ts) — existing Zod schemas
- [api/\_lib/sentry.ts](../../../api/_lib/sentry.ts) — metrics + Sentry surface
- [api/\_lib/schwab.ts](../../../api/_lib/schwab.ts) — token storage
- [api/\_lib/darkpool.ts](../../../api/_lib/darkpool.ts) — dark pool ingestion
- [api/\_lib/db-flow.ts](../../../api/_lib/db-flow.ts) — flow DB reads
- [api/\_lib/db-analyses.ts](../../../api/_lib/db-analyses.ts) — analyses JSONB
- [api/\_lib/db-positions.ts](../../../api/_lib/db-positions.ts) — positions JSONB
- [api/\_lib/db-snapshots.ts](../../../api/_lib/db-snapshots.ts) — snapshots JSONB
- [api/\_lib/csv-parser.ts](../../../api/_lib/csv-parser.ts) — CSV ingest
- [api/\_lib/max-pain.ts](../../../api/_lib/max-pain.ts) — max pain fetch
- [api/\_lib/embeddings.ts](../../../api/_lib/embeddings.ts) — OpenAI embeddings
- [api/\_lib/futures-context.ts](../../../api/_lib/futures-context.ts) — futures context
- [api/\_lib/analyze-context.ts](../../../api/_lib/analyze-context.ts) — analyze context
- Multiple files in `api/cron/` — per Part 1.1 inventory
- [sidecar/src/databento_client.py](../../../sidecar/src/databento_client.py) — Databento callbacks
- [sidecar/src/trade_processor.py](../../../sidecar/src/trade_processor.py) — trade aggregation
- [sidecar/src/db.py](../../../sidecar/src/db.py) — sidecar DB writes
- [sidecar/src/config.py](../../../sidecar/src/config.py) — env config
- [sidecar/src/symbol_manager.py](../../../sidecar/src/symbol_manager.py) — symbol computation
- [sidecar/src/sentry_setup.py](../../../sidecar/src/sentry_setup.py) — Sentry init
- [sidecar/src/health.py](../../../sidecar/src/health.py) — health endpoint
- [ml/src/phase2_early.py](../../../ml/src/phase2_early.py) — training pipeline
- [ml/src/utils.py](../../../ml/src/utils.py) — `validate_dataframe`
- Multiple files in `src/hooks/` — per Part 3.1 inventory
- [src/utils/vixStorage.ts](../../../src/utils/vixStorage.ts) — localStorage VIX cache

---

## Part 7 — Integration with prior audit work

This spec builds on top of several already-shipped items. Revisiting CROSS-005 should take them into account:

- **CROSS-002 (silent failure counters)**: already shipped. Every validation failure in CROSS-005 should emit a `.validation_failure` tag alongside the existing `.error` tags from CROSS-002. Sentry dashboard can show both in one view.
- **BE-CRON-010 (migration #3 atomic)**: already shipped. Schema migrations are now atomic, so if CROSS-005 requires any DB-level constraint additions (which it probably doesn't — schemas are in code), the migration infrastructure is ready.
- **BE-CRON-001 (Schwab token lock)**: already shipped. The lock logic would be a natural place to validate token shape post-Redis-read (#19 in Part 1.2) — add the schema check inside the existing `getStoredTokens` path rather than a separate call site.
- **CSV-001 (sub-second bucketing)**: already shipped. The `buildOpenSpreadsFromTrades` path now groups correctly; the next logical step is validating the ParsedCSV shape (#29 in Part 1.4).
- **FE-STATE-001 (stale quotes badge)**: already shipped. The `useMarketData` hook now has staleness flags; frontend Zod validation (#45 in Part 3.1) would be a natural extension of the same hook.

---

## Part 8 — Suggested one-session completion scope

If you want to ship a focused subset of CROSS-005 in a single session without committing to the full 7-phase rollout, the best ratio of impact-to-effort is:

**Single-session scope (3-4 files):**

1. `api/_lib/db-analyses.ts` — validate `full_response` JSONB with `analysisResponseSchema` (the schema already exists in `validation.ts`, just import and apply on read). **Highest-impact single change** — prevents the "fullResponse.reasoning is undefined" class of crashes that have been the most common analyze-context failure mode.
2. `api/_lib/schwab.ts` — add `SchwabTokensSchema` and validate on `getStoredTokens` read. Prevents silent auth cascade on corrupted Redis state.
3. `api/analyze.ts:236` — tighten the LLM response fallback (reject with 500 OR require critical fields). Stops the "Claude drifted, app crashed, no signal" failure mode.
4. `src/utils/vixStorage.ts` — Zod-validate `loadCachedVixData` with a safe fallback. Stops the "user edited localStorage, app crashed" failure mode.

These 4 sites cover the single highest-impact boundary in each of the 4 architectural layers (backend DB, backend Redis, backend LLM, frontend local storage). A focused 3-4 file commit with ~8 tests would close the most painful gaps in about 1-2 hours of work, even without the full multi-phase rollout.

The rest of CROSS-005 (UW schemas, sidecar pydantic, full frontend coverage, ML pipeline) is strictly optional after that — it's defense-in-depth rather than closing specific observed failures.

---

_End of spec._
