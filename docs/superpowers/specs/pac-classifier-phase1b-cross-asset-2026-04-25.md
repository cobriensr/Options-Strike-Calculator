# PAC Classifier — Phase 1b: Cross-Asset Enrichment

**Status:** Code path complete (2026-04-25). Data acquisition pending.
**Predecessor:** Phase 1a (`pac-event-classifier-2026-04-24.md`) — NQ-only pipeline shipped at commit `409417e`.

## Goal

Extend the per-event feature snapshot with state of correlated instruments (SPY, QQQ, VIX) at the event timestamp, so the classifier can learn regime-dependent edges that NQ-only features can't surface. Schema is forward-compatible: cross-asset columns emit NaN when no data is supplied, so the NQ-only training path still works unchanged.

## What shipped (code)

| File                                            | Change                                                                |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `ml/src/pac_classifier/cross_asset.py`          | NEW — `CrossAssetBars` holder + `align_to_events` (causal merge_asof) |
| `ml/src/pac_classifier/features.py`             | Added `cross_assets: CrossAssetBars \| None = None` parameter         |
| `ml/src/pac_classifier/dataset.py`              | Threads `cross_assets` through to `build_features`                    |
| `ml/tests/test_pac_classifier_cross_asset.py`   | NEW — 15 tests (loader, alignment causality, parquet round-trip)      |
| `ml/tests/test_pac_classifier_features.py`      | +3 tests (NaN default, populated path, no-future-leak)                |
| `ml/tests/test_pac_classifier_dataset.py`       | +2 tests (NaN default, end-to-end populated path)                     |

**Test count:** 63 passing across the `pac_classifier` package (was 43 at end of Phase 1a → +20 for Phase 1b).

### Causality contract

Every cross-asset feature uses `pandas.merge_asof(direction="backward")` — for an event at time `T`, only bars with `ts_event <= T` are eligible. There is no forward-fill or lookahead. The contract is verified by `test_align_no_peek_into_future` (cross_asset) and `test_cross_asset_alignment_is_causal` (features). A future bar with extreme value spliced into the asset frame **after** the event must NOT influence the snapshot, and the test confirms that.

### Schema additions

For each `symbol ∈ {SPY, QQQ, VIX}` and each lookback `nb ∈ {5, 30}` (in **asset bars**, not event bars):

```
{symbol}_close       float64  — most recent close at event time (NaN if no data)
{symbol}_ret_{nb}b   float64  — log return over trailing nb asset bars (NaN if pre-window)
```

That's `3 × (1 + 2) = 9` new columns per row, joining the existing ~25-col Phase 1a feature set.

## What's deferred (data acquisition)

The local Databento archive at `ml/data/archive/ohlcv_1m/` is **futures-only** (ES, NQ, + their options/spreads — verified 2026-04-25 by reading `symbol.value_counts()` of the 2024 partition). There are no SPY/QQQ/VIX 1m bars on disk.

To activate Phase 1b in training, one of the following data paths needs to be plumbed in:

### Option A — Extend Databento ingestion (recommended)

Databento distributes equity 1m aggregates from the major US venues (`XNAS.ITCH` for QQQ, `IEXG.TOPS` or composite for SPY) and CBOE indices (`OPRA` family or `XCBO`) for VIX index level. The sidecar already has a Databento client (`sidecar/src/databento_client.py`); a one-shot Python script in `ml/scripts/seed_cross_asset_archive.py` would:

1. Authenticate via `DATABENTO_API_KEY` (already in env).
2. Pull SPY/QQQ 1m OHLCV from `XNAS.BASIC` or composite for years 2022–2025.
3. Pull VIX index level (CBOE) — note this is an index, not a tradeable, so the close-only column is what we need.
4. Write per-year parquet to `ml/data/archive/ohlcv_1m/cross_asset/<SYMBOL>/year=<Y>/part.parquet`.
5. Loader call becomes: `CrossAssetBars.from_parquet_root(Path("ml/data/archive/ohlcv_1m/cross_asset"))`.

Cost is the unknown — Databento Equities is a separate subscription tier from Futures. Confirm before writing the script.

### Option B — Theta Data fallback

The sidecar has a Theta Data client (`sidecar/src/theta_client.py`) and Theta serves equity 1m OHLC under the existing subscription. A one-shot fetch script could pull SPY/QQQ 1m for the year window and persist to the same parquet layout. VIX is harder via Theta (options-focused). This unblocks SPY/QQQ today but punts VIX.

### Option C — Yahoo / Alpha Vantage / yfinance

Free tier, but quality + rate limits make it unsuitable for production training. Acceptable for an initial smoke test of whether cross-asset features add lift before paying for clean data.

## Activation checklist

Once cross-asset bars are on disk in the expected layout:

```python
from pathlib import Path
from pac_classifier.cross_asset import CrossAssetBars
from pac_classifier.dataset import build_dataset

cross = CrossAssetBars.from_parquet_root(
    Path("ml/data/archive/ohlcv_1m/cross_asset"),
    years=(2022, 2023, 2024),
)
dataset = build_dataset(enriched, cross_assets=cross)
```

The dataset gains 9 finite columns. Phase 2 (XGBoost) reads them as plain features — no model code changes needed.

## Open question

**Are 1m cross-asset bars the right granularity for 5m PAC events?** Today's wiring uses 1m asset bars regardless of event timeframe. For a 5m event, `merge_asof` snaps to the most recent 1m close (≤ 4 minutes older than the event close in the worst case). This is desirable — it gives the freshest read, no resampling artifacts. Lookbacks are in **asset bars**, so `SPY_ret_5b` on a 5m PAC event = trailing 5 minutes of SPY return. Whether the classifier benefits from longer trailing windows (30b = 30min) is for Phase 2 SHAP to determine.

## Next phase

Phase 2: XGBoost training. With Phase 1b code path live, we can train both NQ-only and cross-asset-enriched datasets in parallel and compare AUC + Expected R/trade — the cross-asset features either earn their column count or get pruned.
