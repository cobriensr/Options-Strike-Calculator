# Full Tape × bot-eod join sanity report

**Date:** 2026-05-07
**Data:** 2026-05-06 trading day (1 day captured so far)

## Summary

The two feeds cover essentially the same set of trades, and a join is workable. But two findings change the way these fields should be used downstream — both surfaced in the sanity check.

## Coverage

| Feed                                                          | Rows           | Notes                                                              |
| ------------------------------------------------------------- | -------------- | ------------------------------------------------------------------ |
| `~/Desktop/Bot-Eod-parquet/2026-05-06-trades.parquet`         | 11,013,038     | Unfiltered archive of bot-eod-report; 30 cols + canceled-as-string |
| `~/Desktop/Eod-Full-Tape-parquet/2026-05-06-fulltape.parquet` | 11,071,025     | Full Tape; 40 cols + date + ingested_at, canceled-as-bool          |
| Inner join (5-key)                                            | 11,759,196     | **More rows than either input** — see Finding #1                   |
| Bot-eod rows w/o match in Full Tape                           | 0              | Perfect coverage from bot-eod side                                 |
| Full Tape rows w/o match in bot-eod                           | 57,987 (0.52%) | All post-close (≥20:00 UTC ≈ ≥15:00 CT). Bot-eod filters these.    |

The 0% bot-eod miss rate is the headline: **everything in your existing pipeline is also in Full Tape**, so any joined-view analysis can use bot-eod as the driver and decorate with Full Tape fields.

## Finding #1 — the simple join key isn't unique

Inner join on `(executed_at, option_chain_id, exchange, price, size)` produced 11.76M rows from inputs of 11.01M and 11.07M. That's a many-to-many cartesian explosion of ~700K rows on each side.

**Cause:** multi-leg orders. A 4-leg condor at one strike that executes simultaneously produces 4 rows in each feed with identical 5-key tuples. The join then makes 4×4 = 16 rows.

**Fixes** (in order of effort):

- **Cheapest**: deduplicate within each side before joining (`group_by(JOIN_KEYS).first()`). Loses leg-level granularity but produces a 1:1 join.
- **Medium**: add a within-group row index as a 6th join key. Preserves leg granularity but assumes the row order matches between feeds (it might not — the two CSVs may sort multi-leg blocks differently).
- **Best**: include more disambiguating fields like `nbbo_bid` + `nbbo_ask` in the join key. Probably gets us to 1:1 since multiple legs of the same complex order can land at slightly different NBBO snapshots.

For real downstream analysis, the right approach is probably option 3.

## Finding #2 — per-side vol fields are cumulative strike-level rollups, not per-trade values

This is a major correction to my earlier read of the schema.

For one liquid chain `NVDA260506C00205000` (68,861 rows during the day):

| Time                     | size | ask_vol     | bid_vol     | multi_vol  |
| ------------------------ | ---- | ----------- | ----------- | ---------- |
| 13:30:00.347 (first row) | 221  | 0           | 221         | 0          |
| 13:30:00.375             | 272  | 0           | 493         | 0          |
| 13:30:00.375             | 15   | 15          | 493         | 0          |
| 13:30:00.634             | 32   | 15          | 525         | 0          |
| 13:30:00.635             | 2    | 17          | 525         | 2          |
| ... (last row) 19:59:57  | 3    | **232,316** | **228,503** | **20,132** |

The vol fields at the **last row** of the day are ~half a million each — a single trade can't be 232K contracts. These are cumulative running totals at the strike up through the row's timestamp.

**Correct interpretations:**

- `ask_vol[i]` = cumulative volume at this strike attributed to "lifting the ask" up through this trade (inclusive)
- `multi_vol[i]` = cumulative subset of that volume which was part of multi-leg orders
- `multi_vol[i] - multi_vol[i-1]` (within strike, sorted by time) = the multi-leg portion of THIS trade specifically

So **per-trade multi-leg detection is recoverable, but requires a delta computation** (sort by `option_chain_id` + `executed_at`, then diff consecutive rows). Not just `multi_vol > 0`.

The 88.15% "multi_vol > 0" rate I reported earlier is misleading: it just means most rows are at strikes where ANY multi-leg trade happened earlier in the day. Cumulative noise.

**Implication for the lottery / whale pipelines:** the "naked vs spread leg" filter idea is still possible but harder than I claimed. You'd need a preprocessing step that computes per-trade deltas across the whole day before the filter is meaningful.

## Finding #3 — `tags` field is genuinely per-trade and useful

Top tag tokens across 11.76M joined rows (counts roughly halved due to the cartesian dupe explosion above, so divide by ~1.06):

| Tag                  | Joined-row count |
| -------------------- | ---------------- |
| `bullish`            | 5,392,130        |
| `bid_side`           | 5,359,092        |
| `ask_side`           | 5,101,037        |
| `bearish`            | 5,067,999        |
| `etf`                | 3,038,276        |
| ...                  | ...              |
| `earnings_this_week` | (mid-tier)       |
| `china`              | 97,357           |
| `heavily_shorted`    | 7,307            |
| `dividend`           | 1,777            |
| `arbitrage`          | 160              |

**16 distinct tag tokens.** Some are redundant with bot-eod's `side` field (`ask_side`/`bid_side`/`no_side`) or `equity_type` (`etf`). But several are NEW signals you don't currently have in the bot-eod schema:

- `bullish` / `bearish` — UW's directional attribution per trade
- `earnings_this_week` — temporal context, useful for filtering noise around earnings
- `heavily_shorted` — short squeeze candidate flag
- `arbitrage` — pure-arb trades worth excluding from directional analysis
- `china` — sector/geo context
- `index` — index option flag
- `dividend` — dividend capture activity

These are real per-trade flags (not cumulative), and they cost zero to use — Full Tape gives them for free.

## Field interpretation cheat sheet (revised)

| Field                                             | Per-trade or cumulative?     | Useful for                                                              |
| ------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- |
| `id`                                              | Per-trade UUID               | Joining to other UW endpoints (none currently used)                     |
| `tags`                                            | Per-trade                    | Classification features (`earnings_this_week`, `heavily_shorted`, etc.) |
| `ask_vol` / `bid_vol` / `mid_vol` / `no_side_vol` | **Cumulative strike rollup** | Per-trade attribution via delta computation only                        |
| `multi_vol` / `stock_multi_vol`                   | **Cumulative strike rollup** | Per-trade spread-leg detection via delta only                           |
| `aggregated_trade_id`                             | Empty in this feed           | (UW reserved, not populated)                                            |
| `alert_score`                                     | Empty in this feed           | (UW reserved, not populated)                                            |
| `trade_id`                                        | Always 0                     | (UW reserved, not populated)                                            |
| `created_at`                                      | Per-trade timestamp          | Latency proxy (created_at − executed_at)                                |
| `market_center_locate`                            | Per-trade                    | Microstructure detail (1–16 codes)                                      |

## What to do with this

**No decisions needed yet** (only 1 day captured). Just useful diagnostics:

1. **Don't trust `multi_vol > 0` as a per-trade flag** — it's a strike-level rollup. The earlier "naked vs spread leg" analysis idea needs a delta-computation step.
2. **Tags are the cleanest new signal** — they're per-trade, well-distributed, and orthogonal to bot-eod's existing fields. Cheap to incorporate as features.
3. **Deduplicate before joining** — the simple 5-key join inflates rows due to multi-leg explosion. Add `nbbo_bid`/`nbbo_ask` to the key, or aggregate within-key first.
4. **Keep accumulating** — corpus needs to be 5–10 days before any per-trade-delta analysis (Finding #2's recoverable detection) is statistically meaningful.

## Reproduction

```bash
ml/.venv/bin/python <<'PY'
import polars as pl
from pathlib import Path
DATE = "2026-05-06"
bot = pl.scan_parquet(Path.home() / "Desktop" / "Bot-Eod-parquet" / f"{DATE}-trades.parquet")
ft = pl.scan_parquet(Path.home() / "Desktop" / "Eod-Full-Tape-parquet" / f"{DATE}-fulltape.parquet")
KEYS = ["executed_at", "option_chain_id", "exchange", "price", "size"]
joined = bot.select(KEYS + ["side"]).join(
    ft.select(KEYS + ["multi_vol", "tags"]), on=KEYS, how="inner"
).collect(engine="streaming")
print(joined.head(5))
PY
```
