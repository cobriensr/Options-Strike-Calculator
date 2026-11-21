# EOD Option-Flow Multi-Day Analyzer

A tool for tracking outsized option flow patterns over time. It builds one small
per-day parquet of chain aggregates from each UW Full Tape day, then rolls the
by-day files up across the detector watchlist plus cross-asset outliers.

The nightly job does this every night, in R2 (see "Where the output lives"). This
folder's `analyze.py` is the local CLI over the same code, `scripts/_eod_flow.py`
(`build_chains`, `rollup`, `write_headlines`).

## Where the output lives

The nightly job's `research-derive` and `eod-flow-rollup` steps keep the output in the
R2 bucket (the one named by `R2_BUCKET_FULLTAPE`), under `research/eod-flow/`:

- `research/eod-flow/by-day/{day}-chains.parquet`: the per-day chain aggregates.
- `research/eod-flow/{session}/cumulative-rollup.json` and `cumulative-headlines.txt`:
  the rollup and its headlines, rewritten every night for that night's session.

Read `cumulative-headlines.txt` there for the daily review. The R2 layout, the
manifest that decides which days are rebuilt, and the alerts are in
[`nightly/README.md`](../../nightly/README.md) ("Research outputs").

## Local runs: nothing they write is committed

The files under `scripts/eod-flow-analysis/output/` that git tracks are frozen history
(owner, 2026-11-06): the 23 by-day files from 2026-04-13 to 2026-05-15, `cumulative-rollup.json`
and `cumulative-headlines.txt`. They are not updated any more. A new by-day parquet is
ignored by git (`**/*.parquet`), but a local run rewrites the tracked rollup and
headlines, and `--force` on one of the 23 days rewrites a tracked parquet. Do not commit
any of them. Pass `--out-dir` with a scratch folder to keep a run away from them.

## Quick start

```bash
# From repo root, with ml/.venv (it has duckdb). Day processing needs a tape source:
# a folder of landed days named {date}-fulltape.parquet ...
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --tape-dir DIR --out-dir SCRATCH

# ... or the R2 lake, one day at a time (needs R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY and R2_BUCKET_FULLTAPE in the environment)
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --r2 --out-dir SCRATCH
```

Either builds every tape day from 2026-04-13 on (`CHAINS_START` in `_eod_flow.py`) that
has no by-day file yet, then refreshes the rollup. `--tape-dir` and `--r2` exclude each
other, and `--rollup-only` needs neither.

## Outputs

```
SCRATCH/                             ← --out-dir (default: output/ beside analyze.py)
├── by-day/                          ← --by-day-dir (default: <out-dir>/by-day)
│   ├── 2026-04-13-chains.parquet    ← per-day chain aggregates (small)
│   ├── 2026-04-14-chains.parquet
│   └── ...
├── cumulative-rollup.json           ← machine-readable rollup
└── cumulative-headlines.txt         ← human-readable summary (read this!)
```

The per-day parquet files are filtered to chains with vol/OI ≥ 5× AND premium ≥
$100K. Adding a new day = one more parquet, no re-processing of prior days.

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
  open-auction window, 09:30–10:00 ET (8:30–9:00 CT)? The window is computed in
  Eastern time from each chain's first print, and both ends count: the whole
  10:00 minute is in. The headlines show times in CT.

## CLI flags

```bash
# Process a single date (rest of pipeline unchanged)
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --day 2026-11-04 --r2 --out-dir SCRATCH

# Refresh rollup without re-processing any days (no tape needed)
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --rollup-only --out-dir SCRATCH

# Process days but skip rollup (useful for batch backfill)
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --tape-dir DIR --out-dir SCRATCH --no-rollup

# Force-reprocess a day (overwrite existing parquet)
ml/.venv/Scripts/python scripts/eod-flow-analysis/analyze.py --day 2026-06-15 --tape-dir DIR --out-dir SCRATCH --force
```

`--by-day-dir` points the by-day parquets somewhere other than `<out-dir>/by-day`.
A day is skipped when its by-day file exists there, so a run with a fresh `--out-dir`
builds every tape day from `CHAINS_START` on.

## Filters / thresholds

Edit constants at the top of `scripts/_eod_flow.py`:

```python
WATCHLIST = ["SPXW", "NDXP", "SPY", "QQQ", "IWM", "NVDA", "SNDK"]
MIN_VOL_OI_RATIO = 5.0
MIN_PREMIUM = 100_000
```

If you tighten these, bump `CHAINS_VERSION` in the same file and re-run locally with
`--force` on every day to regenerate the parquets at the new floor. The nightly job
reads a bumped version as a stale fingerprint and rebuilds each chains day over the
following nights, except the days seeded from the retired CSV archive, which it never
rebuilds. `_eod_flow.py` is a nightly watch path, so a push that edits it follows the
push window in `nightly/README.md`.

## Implementation notes

- **DuckDB** scans the tape (millions of rows × many columns) and keeps only the
  per-chain aggregates, so a by-day parquet is small.
- Per-day aggregates are at the `option_chain_id` level (one row per
  unique strike/expiry/side combination).
- A print's side and equity type come from its `tags` (`ask_side`, `bid_side`,
  `mid_side`, `index`, `etf`). The output keeps the legacy 22 columns and types, so
  days built from the tape and the seeded days read as one set.
- `ticker` is normalized: SPXW-rooted contracts get ticker='SPXW',
  NDXP-rooted get 'NDXP', everything else uses `underlying_symbol`.
- The cumulative rollup re-runs against ALL parquets in the by-day folder on each
  invocation, and is fast because the aggregated data is small.
