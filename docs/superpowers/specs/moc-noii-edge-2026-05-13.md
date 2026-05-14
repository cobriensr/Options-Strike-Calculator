# MOC/MOO Order Imbalance Edge Study — 2026-05-13

## Goal

Test whether the closing-auction Net Order Imbalance Indicator (NOII) at 15:50–16:00 ET
predicts the SPX 15:50→16:00 ET return, using 1 year of Databento historical NOII
across NYSE (XNYS.PILLAR), NYSE Arca (ARCX.PILLAR), and NASDAQ (XNAS.ITCH).
Secondary: whether NASDAQ imbalance adds explanatory power beyond NYSE alone — the
answer determines whether a live data subscription should cover both venues
(Databento Plus $1,500/mo) or NYSE-only is enough (Polygon NOI $49/mo).

## Data

Four downloaded historical batches (2025-05-13 → 2026-05-12, 252 trading days each):

| Order ID                   | Dataset       | Symbols (effective)                                                                                        |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------- |
| `XNAS-20260514-7SQALEQH9G` | `XNAS.ITCH`   | QQQ, AAPL, MSFT, NVDA, META, AMZN, GOOGL, GOOG, TSLA, AVGO, COST, NFLX (NYSE-listed in req returned empty) |
| `ARCX-20260514-KBSGK7PRBJ` | `ARCX.PILLAR` | SPY, IWM, VOO, DIA                                                                                         |
| `XNYS-20260514-96KAQJKAE9` | `XNYS.PILLAR` | ABBV, BAC, BRK.B, JNJ, JPM, LLY, MA, UNH, V, WMT, XOM (`P`, `SPY` returned empty)                          |
| `XNYS-20260514-V8BL6ETJ8H` | `XNYS.PILLAR` | PG, HD                                                                                                     |

Format: DBN+zstd, daily file split, `instrument_id` symbology (resolve via per-folder
`symbology.json` / manifest), nanosecond Unix timestamps, raw (un-scaled) prices.
Imbalance schema fields: `ts_event`, `auction_time`, `auction_type` (`M`/`C`/`H`),
`ref_price`, `cont_book_clr_price`, `side` (B/A/N), `paired_qty`,
`total_imbalance_qty`, `market_imbalance_qty`.

SPX truth source: `index_candles_1m WHERE symbol='SPX'` (Neon Postgres).

## Phases

Each phase is independently shippable. Run code-reviewer subagent at the end of
each phase per `feedback_per_phase_loop` rule. Commit + push between phases.

### Phase 1 — Decoder: DBN → Parquet

- Create `ml/src/imbalance/decoder.py` that takes one of the 4 download folders
  and writes a consolidated Parquet file under `ml/data/imbalance/{venue}.parquet`.
- One row per NOII message. Columns: `ts_event_ns`, `ts_event_et`, `symbol`,
  `dataset`, `auction_type`, `auction_time`, `ref_price`, `cont_book_clr_price`,
  `side` (B/A/N), `paired_qty`, `total_imbalance_qty`, `market_imbalance_qty`,
  `signed_imbalance` (computed: signed by `side` — ‘B’=+, ‘A’=−, ‘N’=0).
- CLI: `python -m src.imbalance.decoder <download-folder> <output-parquet>`.
- Test: `ml/tests/test_imbalance_decoder.py` — decode 1 sample day, assert row
  count > 0 for at least one expected symbol, assert sign convention.
- **Verify:** `python -m src.imbalance.decoder ~/Downloads/XNAS-20260514-7SQALEQH9G
ml/data/imbalance/xnas.parquet` produces a Parquet with > 100k rows and 12
  unique symbols.

### Phase 2 — Snapshot Aggregation

- `ml/src/imbalance/snapshots.py`: for each (date, symbol, auction_type)
  pull the **first NOII update at or after window-start** and the **last
  update before window-end**, and emit **a single wide row** with
  `*_first`, `*_last`, and trend columns (`abs_imbalance_trend`,
  `signed_imbalance_trend`, `paired_qty_growth`). Wide shape is friendlier
  for the Phase 3 join than the originally-spec'd two-row layout.
- Windows (ET): `C` 15:50–16:00, `M` 09:00–09:30, `O` 09:25–09:30.
- Output: `ml/data/imbalance/snapshots.parquet` (all auction types in one file).
- **Verify:** snapshots panel populated for all four venue Parquets. Manual
  spot-check on a known MOC-heavy day matches eyeballed Periscope reads.

### Phase 3 — Join with SPX 1-min Candles

- `ml/src/imbalance/eod_join.py`: pull `index_candles_1m` for `symbol='SPX'`,
  same date range, via psycopg2.
- Compute target variables per trading day:
  - `spx_ret_1550_1600` (15:50→16:00 ET return in bps)
  - `spx_ret_1555_1600` (last 5 min)
  - `spx_overnight_gap` (close→next-day-open bps)
  - `spx_next_day_ret` (next-day open→close)
- Join snapshots ↔ SPX targets on date. Save `ml/data/imbalance/eod_panel.parquet`.
- **Verify:** panel has 252 rows; spot-check that 2025-08-05 (typical MOC day)
  has plausible SPX returns and non-null imbalance fields.

### Phase 4 — Headline Analysis

- `ml/src/imbalance/eod_analysis.py`: produce 5 plots under `ml/plots/imbalance/`:
  1. Scatter: NYSE aggregate signed_imbalance (15:50 snapshot) vs spx_ret_1550_1600
  2. Same for NASDAQ aggregate
  3. Same for SPY only
  4. Decile bucket bar chart: x = imbalance decile, y = mean SPX return + 95% CI
  5. Time series: rolling 20-day correlation
- Report: `docs/tmp/moc-noii-edge-findings-2026-05-13.md` with ρ, p, R², and
  decision (NYSE-only suffices vs both venues required).
- **Verify:** Plots render, findings report exists, contains either "EDGE FOUND"
  or "NO EDGE" header decision in first paragraph.

### Phase 5 — Cross-Venue Comparison

- Run identical analysis with three feature sets:
  - NYSE+ARCA only (Polygon $49 equivalent)
  - NASDAQ only (NASDAQ-listed mega-cap dominance)
  - All venues combined
- Compare R² and bucket-discrimination. Decision rule:
  - If R²(all) > 1.15 × R²(NYSE+ARCA): NASDAQ adds material info → recommend Databento Plus or proxy via QQQ dark pool
  - Else: Polygon $49 is sufficient
- **Verify:** Decision committed to findings report.

### Phase 6 — Trend / Convergence Feature

- Per Polygon GitHub example: track whether imbalance is _shrinking_ (contra
  liquidity arriving, indicative price will hold) or _growing_ (pressure
  building, indicative will move) over 15:50→15:58 window. Add as feature in
  Phase 4 regression.
- **Verify:** If trend feature improves R² by > 0.02, add to findings report.

### Phase 7 — Verification

- `cd ml && uv run pytest tests/test_imbalance_*` — all tests pass
- `cd ml && uv run ruff check src/imbalance/` — zero violations
- Reviewer subagent verdict: pass
- Commit + push

## Open Questions

- **Symbology mapping**: Databento delivers `instrument_id` not raw symbols when
  `map_symbols=false`. Use `databento.DBNStore.from_file()` which handles this
  natively via the embedded symbology.
- **Sign convention**: Per Polygon README, positive = buy-side, negative =
  sell-side. Databento uses the `side` enum: `B` = bid/buy, `A` = ask/sell,
  `N` = no imbalance. The decoder multiplies `total_imbalance_qty` by +1 (B),
  -1 (A), or 0 (N), preserving NaN where the source quantity was sentinel-null.
- **Aggregation**: Sum signed imbalance × `ref_price` across symbols for a
  $-weighted index proxy, or normalize each symbol by ADV first? Start with
  $-weighted sum; revisit if results are noisy.
- **OPEX/Fed day controls**: 1 year is too few samples for confident subgroup
  splits. Note in findings; do not over-claim regime dependence.

## Non-Goals

- No live data subscription. No Railway service. No frontend integration. Pure
  research notebook + decision report.
- No backtesting / pnl simulation. Just signal correlation.

## Done When

- `ml/data/imbalance/eod_panel.parquet` exists with full 252-day panel
- `docs/tmp/moc-noii-edge-findings-2026-05-13.md` contains explicit "EDGE FOUND"
  or "NO EDGE" verdict + decision on venue subscription choice
- All phase tests pass; ruff clean
- Plan committed and pushed; each phase committed separately

## Notes

- Sized at ~$22 in data costs total, four orders, ~67 MB compressed
- This is a research study, not a feature. Outputs are a decision and a notebook.
  Code lives under `ml/src/imbalance/` and stays there unless we productionize.
