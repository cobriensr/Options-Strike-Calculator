---
status: Likely Shipped
date: 2026-05-07
---

# UW Full Tape Parquet Archive (parallel to bot-eod-report)

**Date:** 2026-05-07
**Author:** charlesobrien (drafted with Claude)

## Goal

Capture UW's `/option-trades/full-tape/{date}` daily zip into a typed parquet archive on local disk, parallel to the existing `bot-eod-report` pipeline. Builds an accumulating corpus of raw transaction-level data for future joined analysis (per-side vol breakdowns, multi-leg detection via `multi_vol` / `stock_multi_vol`, UW's own `tags` and `aggregated_trade_id` labeling).

## Why now

UW retains only the last 3 trading days at the Full Tape endpoint. Once a date scrolls off, it's gone forever. Capture-as-insurance is cheap (~1.5–2 GB parquet/day on local disk after compression) and the unique fields (per-side vols, `aggregated_trade_id`, `tags`) plausibly improve flow-quality scoring once we have enough days to test. See "open question 1" below for the validation experiment.

## Non-goals

- **Not** replacing the bot-eod-report pipeline. The bot-eod feed has `equity_type` + `sector` enrichments that the Full Tape doesn't provide; the existing pipeline stays untouched.
- **Not** uploading Full Tape parquet to Vercel Blob. Local archive only. If joined analysis proves valuable, we revisit Blob in a follow-up.
- **Not** filtering the Full Tape data at ingest. Raw archive only — cash-session filtering, ETH drops, etc. happen at query time. Goal is a complete row-faithful capture.

## Phases

### Phase 1 — Schema discovery (DONE 2026-05-07)

Verified by downloading + scanning the full 2026-05-06 tape (11,071,025 rows, 4.0 GB CSV). Findings:

**Frozen `FULLTAPE_SCHEMA` (40 cols, in CSV order):**

```python
FULLTAPE_SCHEMA: dict[str, pl.DataType] = {
    "id": pl.Utf8,                          # UUID
    "underlying_symbol": pl.Utf8,
    "executed_at": pl.Datetime("us", "UTC"),
    "nbbo_bid": pl.Float64,
    "nbbo_ask": pl.Float64,
    "size": pl.Int32,
    "price": pl.Float64,
    "option_chain_id": pl.Utf8,
    "alert_score": pl.Utf8,                 # 0/11M populated — placeholder
    "created_at": pl.Datetime("us", "UTC"),
    "report_flags": pl.Utf8,                # Postgres array literal: '{}', '{intermarket_sweep}', '{extended_hours}', etc.
    "tags": pl.Utf8,                        # Postgres array literal: '{ask_side,bullish,etf,earnings_this_week}'
    "expiry": pl.Date,
    "option_type": pl.Utf8,                 # 'call' | 'put'
    "open_interest": pl.Int32,
    "strike": pl.Float64,
    "premium": pl.Float64,
    "aggregated_trade_id": pl.Utf8,         # 0/11M populated — placeholder
    "volume": pl.Int32,
    "underlying_price": pl.Float64,
    "ewma_nbbo_ask": pl.Float64,
    "ewma_nbbo_bid": pl.Float64,
    "implied_volatility": pl.Float64,
    "delta": pl.Float64,
    "theta": pl.Float64,
    "gamma": pl.Float64,
    "vega": pl.Float64,
    "rho": pl.Float64,
    "theo": pl.Float64,
    "upstream_condition_detail": pl.Utf8,   # 4-char codes: 'auto', 'slan', 'mlet', 'mlat', 'isoi', etc.
    "market_center_locate": pl.Int32,       # small ints, 1-16 in samples
    "canceled": pl.Utf8,                    # 'f' | 't' literals — cast to bool in transform
    "trade_id": pl.Int64,                   # 11M/11M = 0 — placeholder
    "exchange": pl.Utf8,                    # 4-char codes: 'XCBO', 'ARCO', 'XPHO', etc.
    "ask_vol": pl.Int32,
    "bid_vol": pl.Int32,
    "no_side_vol": pl.Int32,
    "mid_vol": pl.Int32,
    "multi_vol": pl.Int32,
    "stock_multi_vol": pl.Int32,
}
```

**Placeholder fields (UW exposes but doesn't populate):**

- `alert_score` — 0 of 11M rows populated. Reserved for future enrichment.
- `aggregated_trade_id` — 0 of 11M rows populated. Earlier value-prop claim of "free block detector" does NOT survive contact with the data.
- `trade_id` — all 11M = `0`. Placeholder.

These three are kept in the schema (future-proofing if UW starts populating) but provide zero current value.

**Other findings:**

- `report_flags` uses bare keys (`{intermarket_sweep}`, `{extended_hours}`) — note no `_trade` suffix unlike bot-eod-report's `extended_hours_trade`.
- `canceled` rate: 0.0045% (496 of 11M) — matches bot-eod cancel-noise floor.
- `tags` is the genuinely new enrichment: `{ask_side,bullish}`, `{bid_side,bearish,etf}`, `{ask_side,bullish,etf,earnings_this_week}`, etc.
- **Important** — `ask_vol` / `bid_vol` / `mid_vol` / `no_side_vol` / `multi_vol` / `stock_multi_vol` are **CUMULATIVE running totals at the strike level**, not per-trade values. By end-of-day they reach hundreds of thousands of contracts on liquid strikes (e.g., NVDA 205C had `ask_vol=232,316` on its last row). Per-trade attribution requires a delta computation: sort by `option_chain_id` + `executed_at`, then diff consecutive rows. See `docs/tmp/fulltape-bot-eod-join-sanity-2026-05-07.md` for the empirical verification.
- 11.07M raw rows vs ~10.6M filtered bot-eod — tiny difference, dominated by ETH and cancellations the Full Tape preserves.

### Phase 2 — Build `scripts/ingest-fulltape.py`

Mirrors the structure of `scripts/ingest-flow.py` but minus the Blob upload:

- argparse for date (positional) + `--keep-csv` flag (parity with bot-eod ingest)
- `validate_header()` — **soft-fail** on schema drift (per Open Question 2 decision below) — null-fills missing cols, drops extras, warns loudly
- `transform()` — minimal: add `date` partition column from filename, no row filters
- `sink_parquet()` to `~/Desktop/Eod-Full-Tape-parquet/{date}-fulltape.parquet` with zstd-3 (matches bot-eod compression profile)
- Delete source CSV after parquet write succeeds, unless `--keep-csv`
- No Blob upload, no Blob token, no upload failure recovery

### Phase 3 — Modify `scripts/download-fulltape.sh`

Currently writes to `~/Downloads/EOD-OptionFlow/bot-eod-report-{date}.csv` — collides with the bot-eod CSV name. Change to:

- Default output dir: `~/Downloads/EOD-FullTape/` (separate from `EOD-OptionFlow/`)
- Default output filename: `fulltape-{date}.csv`
- Keep `INPUT_DIR` env override for callers who want a custom path

### Phase 4 — Wire into Makefile

- New `INPUT_DIR_FULLTAPE` and `PARQUET_DIR_FULLTAPE` variables.
- New `ingest-fulltape` target: runs `download-fulltape.sh` then `ingest-fulltape.py`. Standalone — runnable as `make ingest-fulltape` for retry after a UW posting lag.
- Hook into `nightly` as the final step **with soft-fail semantics**: the recipe uses `-` prefix or `|| true` so a failure (UW lag, network blip) warns loudly but doesn't abort `nightly` or block `update`.
- Update help text to describe the new target + the dual-archive concept.

## Files to create / modify

| Path                                                    | Action                         | Phase |
| ------------------------------------------------------- | ------------------------------ | ----- |
| `docs/superpowers/specs/fulltape-archive-2026-05-07.md` | NEW (this doc)                 | 0     |
| `scripts/ingest-fulltape.py`                            | NEW                            | 2     |
| `scripts/download-fulltape.sh`                          | MODIFY (output paths)          | 3     |
| `Makefile`                                              | MODIFY (target + nightly hook) | 4     |

## Data dependencies

- **No new tables.** Local-only archive.
- **No new env vars.** Reuses existing `UW_API_KEY` from `.env.local`.
- **New directories** (auto-created by scripts): `~/Downloads/EOD-FullTape/`, `~/Desktop/Eod-Full-Tape-parquet/`.

## Open questions

### 1. Validation experiment (post-archive)

After ~5 trading days of accumulated Full Tape parquets, run a one-shot polars analysis:

> Of the trades the lottery_finder pipeline flagged as "naked directional whales," what fraction had `multi_vol > 0`?

If <10%, the additional fields don't materially improve signal quality and we leave the archive as-is (cheap insurance). If 25%+, we have evidence the bot-eod's collapsed `side` field is hiding spread-leg noise, and the case for a richer joined-view ingest writes itself.

This is a follow-up, not part of this spec. Captured here so future-us doesn't forget the why.

### 2. Schema-drift policy (DECIDED 2026-05-07: soft-fail with shape-stable view)

Frozen `FULLTAPE_SCHEMA` is the stable "view" of UW's data we maintain. UW can drift underneath us and we keep producing schema-uniform parquets:

- For each col in `FULLTAPE_SCHEMA`: if present in CSV → use it. If missing → fill with null + log warning.
- For each col in CSV not in `FULLTAPE_SCHEMA`: drop + log warning.

Diverges from `ingest-flow.py:validate_header`'s hard-fail. Trade-off: opportunistic archive prioritizes "keep accumulating" over schema strictness. Loud-but-non-fatal warnings give us a signal to update the schema list without losing days of capture.

### 3. Pruning policy (DECIDED 2026-05-07: never, revisit at 1-year mark)

No pruning until the archive has accumulated for ~1 year. ~600 GB/year at zstd-3 is fine on the user's Mac SSD. If SSD pressure emerges before then, the fallback is bumping zstd compression level rather than deleting history.

## Thresholds / constants

- Parquet output: zstd compression level 3 (matches bot-eod for consistency)
- Soft-fail behavior in `nightly`: `make ingest-fulltape || echo "⚠️ Full Tape ingest failed — re-run via 'make ingest-fulltape' after UW posts"`
- Sanity floor: ≥1M rows expected per day (Full Tape is broader than bot-eod's filtered 10.6M; floor is generous to handle partial-session days)

## Out of scope (explicitly)

- DuckDB / polars query helpers for joined views — comes after we have enough days
- Backfilling historical Full Tape — only last 3 days available, can't backfill past that
- Replacing whale_plots.py's `ask_pct` derivation with continuous per-side-vol features — needs validation experiment first
