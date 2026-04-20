# Phase 2a — Sidecar L1 Ingest (MBP-1 + TBBO) — 2026-04-18

Part of the max-leverage roadmap
(`max-leverage-databento-uw-2026-04-18.md`). Phase 2a wires the L1
data streams already covered by the $179/mo Databento Standard tier
into the sidecar and Neon Postgres. Phase 2b (compute layer +
analyze-context integration) will be a separate spec after this
lands.

## Goal

Ingest live top-of-book quotes (MBP-1) and trade-with-book-before
events (TBBO) for ES into new Neon Postgres tables. Set up the data
pipeline end-to-end so that by market open Monday, quotes and
aggressor-classified trades are flowing continuously into the DB and
ready for compute-layer consumption in Phase 2b.

## Scope

### New DB tables

**Migration 71 — `futures_top_of_book`** (MBP-1 quote events):

```sql
CREATE TABLE IF NOT EXISTS futures_top_of_book (
  id        BIGSERIAL PRIMARY KEY,
  symbol    TEXT NOT NULL,
  ts        TIMESTAMPTZ NOT NULL,
  bid       NUMERIC(12,4) NOT NULL,
  bid_size  INTEGER NOT NULL,
  ask       NUMERIC(12,4) NOT NULL,
  ask_size  INTEGER NOT NULL
);
CREATE INDEX idx_ftob_symbol_ts ON futures_top_of_book (symbol, ts DESC);
```

No UNIQUE constraint — MBP-1 is a high-volume stream and dedup
isn't meaningful at this layer.

**Migration 72 — `futures_trade_ticks`** (TBBO):

```sql
CREATE TABLE IF NOT EXISTS futures_trade_ticks (
  id             BIGSERIAL PRIMARY KEY,
  symbol         TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  price          NUMERIC(12,4) NOT NULL,
  size           INTEGER NOT NULL,
  aggressor_side CHAR(1) NOT NULL CHECK (aggressor_side IN ('B','S','N'))
);
CREATE INDEX idx_ftt_symbol_ts ON futures_trade_ticks (symbol, ts DESC);
```

`aggressor_side`:
- `'B'` = buyer-initiated (trade price at/above best ask before event)
- `'S'` = seller-initiated (trade price at/below best bid before event)
- `'N'` = unclassifiable (trade in-between; rare but possible)

### Sidecar changes

**`sidecar/src/main.py`** — add two new Live subscriptions on the
existing GLBX.MDP3 client (or a new one if cleaner):

- `mbp-1` schema, ES parent symbology (matches existing OHLCV-1m
  pattern)
- `tbbo` schema, ES parent symbology

Do NOT add NQ / ZN / RTY / CL / GC to these schemas yet — Phase 2a
is ES-only to limit ingest volume and DB bloat while we validate the
pipeline. Other symbols come in a later mini-phase if the signal proves
valuable for ES.

**`sidecar/src/db.py`** — add two new writers:

```python
def insert_top_of_book(symbol, ts, bid, bid_size, ask, ask_size) -> None: ...
def insert_trade_tick(symbol, ts, price, size, aggressor_side) -> None: ...
```

Use batch inserts (mirror the existing `batch_insert_options_trades`
pattern) — MBP-1 will produce thousands of rows per minute during
active trading.

**`sidecar/src/trade_processor.py` (or new `quote_processor.py`)** —
parse incoming MBP-1 + TBBO records:

- MBP-1: direct pass-through to `insert_top_of_book`.
- TBBO: compute `aggressor_side` from the trade's `side` field if
  Databento provides it directly; otherwise derive by comparing
  trade price to pre-trade BBO midpoint. Document the classification
  rule in comments.

Batch buffer size: same 500-row pattern as existing trade processor.
Flush on size threshold.

### Python tests

- `sidecar/tests/test_quote_processor.py` (or extend
  `test_trade_processor.py`) — unit tests for parsing MBP-1 and
  TBBO records into the new writer calls. Mock the DB; assert calls
  and batching behavior.
- `sidecar/tests/test_db.py` — test the two new writers: happy path,
  batch flush at threshold, duplicate-ts handling (no UNIQUE, so
  both rows should insert fine).

### Vercel/Node tests

- `api/__tests__/db.test.ts` — add `{ id: 71 }` and `{ id: 72 }` to
  the applied-migrations mock. Append both to the expected
  descriptions list. Bump SQL call count and transaction count per
  the project's migration-test pattern.
- Migration 71 has 2 statements (CREATE TABLE + CREATE INDEX) →
  adds 3 SQL calls (2 DDL + 1 `INSERT INTO schema_migrations`).
- Migration 72 has 2 statements → adds 3 SQL calls.
- Total delta: +6 SQL calls, +2 transactions.
- Current baseline (per commit `4bb571d`): 237 SQL calls / 57 txns.
- New baseline after Phase 2a: 243 SQL calls / 59 txns.

### Railway deploy

- Redeploy the sidecar image after merge.
- Monitor logs for the first 30 min of Sunday evening CME open (5
  PM CT Sunday = GLOBEX restart). Verify row counts grow in
  `futures_top_of_book` and `futures_trade_ticks`.

## Constraints

- **ES only for now.** Adding all 7 futures symbols to MBP-1 could
  produce ~100k rows/min peak, risky for the Neon instance. Validate
  ES first.
- **No compute layer in this phase.** No cron, no analyze-context
  wiring, no new endpoints. Just the data plumbing.
- **No UI changes.**
- **No new external API calls.** Databento-only, same license tier.
- **Respect 1-month L2/L3 rule.** MBP-10 and MBO are NOT in scope —
  only L1 (MBP-1 + TBBO).

## Done when

- Migrations 71 and 72 pass on `POST /api/journal/init` locally and
  the schema is correct.
- `npm run review` passes (tsc + eslint + prettier + vitest
  --coverage).
- Sidecar's `pytest` suite passes. New writer + processor tests
  cover happy path + null-safety + batch-flush.
- Sidecar redeployed to Railway; within 15 minutes of CME open
  Sunday 5 PM CT, `SELECT COUNT(*) FROM futures_top_of_book WHERE
  symbol = 'ES' AND ts > NOW() - INTERVAL '15 minutes'` returns
  > 1,000 rows.
- `futures_trade_ticks` similarly populates during the same window
  with at least a few hundred rows.

## Out of scope for this phase

- OFI / spread widening / book pressure computation — Phase 2b.
- Analyze-context wiring — Phase 2b.
- NQ / ZN / RTY / CL / GC MBP-1/TBBO ingest.
- MBP-10 / MBO (not in Standard tier's live access).
- Historical backfill of L1 — Phase 3.
- Any UI surface or endpoint changes.

## Open questions

- **Databento TBBO record shape** — does the event include an
  `aggressor_side` field directly, or do we derive it from trade
  price vs book midpoint? Verify via `databento-python` Live client
  schema reference before coding. If derivation is needed, include
  that logic in the processor with a unit test.
- **Sidecar memory footprint** — adding two high-volume streams may
  increase RSS. Not a blocker for shipping, but worth watching on
  the first deploy.

## Thresholds / constants

- Batch flush size: 500 rows (matches existing pattern).
- Trade processor flush interval: N/A (batch on size only, same as
  existing options processor).
- Migration IDs: 71 (top_of_book), 72 (trade_ticks). Baseline after
  `4bb571d` is migration 70.
