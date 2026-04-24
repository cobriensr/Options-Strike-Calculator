# EOD Option-Flow Multi-Day Analyzer

A daily-use tool for tracking outsized option flow patterns over time.
Reads UW-bot daily EOD CSVs from `~/Downloads/EOD-OptionFlow/`, generates
small per-day parquet aggregates, and rolls up multi-day insights for the
detector watchlist plus cross-asset outliers.

## Quick start

```bash
# From repo root, run the analyzer (uses ml/.venv for duckdb)
ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py
```

First run processes every CSV in the folder (~60-90s per day, so ~10-15
min for 10 days). Subsequent runs only process days that don't already
have a parquet output, then refresh the cumulative rollup. So the daily
cadence is:

1. Drop new CSV into `~/Downloads/EOD-OptionFlow/`
2. Run the analyzer
3. Review `output/cumulative-headlines.txt` for new patterns

## Outputs

```
scripts/eod-flow-analysis/output/
├── by-day/
│   ├── 2026-04-13-chains.parquet    ← per-day chain aggregates (small, ~50KB each)
│   ├── 2026-04-14-chains.parquet
│   └── ...
├── cumulative-rollup.json           ← machine-readable rollup
└── cumulative-headlines.txt         ← human-readable summary (read this!)
```

The per-day parquet files are kept committed-friendly (filtered to chains
with vol/OI ≥ 5× AND premium ≥ $100K). Adding a new day = one more parquet,
no re-processing of prior days.

## What the rollup tells you

`cumulative-headlines.txt` includes:

- **Per-day summary** — chains, total premium, bullish-call $ vs bearish-put $
- **Top tickers** (across all days) — ranked by cumulative outsized premium
  with ASK-side win/loss base rates
- **Repeat strikes** — same `(ticker, strike, side, expiry)` showing up on
  ≥2 days = persistent positioning. Single most informative output.
- **Out-of-watchlist single-name candidates** — tickers we DON'T track that
  show consistent outsized flow. Candidates for adding to the detector.
- **Watchlist directional WINNERS / LOSERS** — for each ASK-side directional
  bet (≥65% ask, vol/OI ≥ 5×), did the option gain or lose ≥30%?
- **Open-auction clustering** — what % of directional flow fired in the
  first 30 min after open (8:30-9:00 CT / 13:30-14:00 UTC)?

## CLI flags

```bash
# Process a single date (rest of pipeline unchanged)
ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py --day 2026-04-25

# Refresh rollup without re-processing any days
ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py --rollup-only

# Process days but skip rollup (useful for batch backfill)
ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py --no-rollup

# Force-reprocess a day (overwrite existing parquet)
ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py --day 2026-04-23 --force
```

## Filters / thresholds

Edit constants at the top of `analyze.py`:

```python
WATCHLIST = ["SPXW", "NDXP", "SPY", "QQQ", "IWM", "NVDA", "SNDK"]
MIN_VOL_OI_RATIO = 5.0
MIN_PREMIUM = 100_000
```

If you tighten these, re-run with `--force` on every day to regenerate the
parquets at the new floor.

## Implementation notes

- **DuckDB** is used for the heavy CSV scan (10M+ rows × 30 columns) —
  ~3GB CSV → ~50KB parquet per day.
- Per-day aggregates are at the `option_chain_id` level (one row per
  unique strike/expiry/side combination).
- `ticker` is normalized: SPXW-rooted contracts get ticker='SPXW',
  NDXP-rooted get 'NDXP', everything else uses `underlying_symbol`.
- The cumulative rollup re-runs against ALL parquets on each invocation —
  fast (~5s) because aggregated data is small.

## Daily routine (suggested)

1. **End of trading day**: download new CSV from UW bot to `~/Downloads/EOD-OptionFlow/`
2. **Evening review**: `ml/.venv/bin/python scripts/eod-flow-analysis/analyze.py`
3. **Read `cumulative-headlines.txt`** — focus on:
   - Repeat strikes that just hit a 2nd day → real positioning
   - New out-of-watchlist candidates → potential ticker additions
   - Watchlist winners → did the detector fire on these?
   - Watchlist losers → wrong-way bets to study
4. **Commit the new parquet** if you want to track over time:
   ```bash
   git add scripts/eod-flow-analysis/output/by-day/<new-date>-chains.parquet
   git commit -m "data(eod-flow): 2026-04-XX EOD aggregates"
   ```

The parquets are deliberately small (under 100KB per day) so committing
them gives you a permanent record without bloating the repo.
