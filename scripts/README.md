# scripts/

One-off and recurring scripts that live outside the Vercel function lifecycle: backfills, ad-hoc analyses, ops utilities. ~125 files in `.ts`, `.mjs`, `.py`, and `.sh`.

These are **not deployed**. They run from the developer's machine against the production Neon instance (read `.env.local` for credentials). Most assume you've already pulled env vars with `vercel env pull .env.local`.

## Categories

### Backfill (`backfill-*`)

Re-run a historical version of a cron job to populate new tables/columns. Idempotent, scoped by date range or batch size, safe to re-run.

```bash
# .ts (run via tsx)
npx tsx scripts/backfill-detect.ts

# .mjs (Node ESM)
node scripts/backfill-darkpool.mjs

# .py (use ml venv)
ml/.venv/bin/python scripts/backfill-institutional-blocks.py
```

Common env vars (each script documents its own at the top): `BACKFILL_DAYS`, `BACKFILL_START`, `BACKFILL_END`, `BATCH_SIZE`, `CONCURRENCY`, `DRY_RUN`, `WITHIN_DAY_DELAY_MS`.

Frequently re-run (active):

- `backfill-detect.ts` — multi-leg detection on historical fires
- `backfill-lottery-fires.mjs` / `backfill-lottery-score.ts` — Lottery Finder scoring
- `backfill-flow-phase.ts` — time-of-day buckets on flow alerts
- `backfill-greek-exposure.mjs`, `backfill-spot-gex.mjs` — daily GEX history
- `backfill-darkpool.mjs`, `backfill-dark-pool-prints.mjs` — dark pool prints
- `backfill-flow-alerts.mjs`, `backfill-netflow.mjs` — UW flow tables
- `backfill-snapshots.ts` — point-in-time snapshots
- `backfill-strike-exposure*.mjs` — per-strike Greek exposure
- `backfill-ws-option-trades-*.py` — `uw-stream` retro-fill

### Analysis (`analyze_*`)

Python EDA / statistical analyses. Outputs land in `docs/tmp/` or are summarized into specs. Usually one-off — once a finding is captured in a spec, the script can be considered done unless underlying data changes.

- `analyze_silent_boom_multileg.py` — multi-leg signal correlation
- `analyze_cross_symbol_confluence.py` — SPY/QQQ/IWM joint signals
- `analyze_interval_ba_cuts.py` — bid/ask interval thresholds
- `analyze_confluence_vs_solo.py` — single vs. confluent signals

### Audit / verify (`audit-*`, `check-*`, `verify-*`, `grade-*`)

Sanity checks against production data. Usually read-only.

- `audit-periscope-scraper.py` — verify scraped reads match Periscope ground truth
- `audit-periscope-confidence-gating.mjs` — confidence threshold drift checks
- `grade-periscope-day.mjs` — replay a Periscope day against actuals

### Enrichment (`enrich_*`)

Compute additional features on existing rows. Typically used after a feature-engineering change.

### Backfill helpers (`backfill_*.py` Python)

Python-side backfills for ML-feature engineering (`backfill_takeit.py`, etc.). Use `ml/.venv/bin/python`.

### Ops (`ops/`)

Operational scripts — DB maintenance, backup verification.

### EOD flow analysis (`eod-flow-analysis/`)

Self-contained pipeline for end-of-day flow stratification. Has its own `output/backfill-buckets/` directory (gitignored).

### Capture studies (`charm-pressure-capture/`, `delta-pressure-capture/`, `gamma-capture/`)

Periodic Playwright captures of UW Periscope screens for ML labeling. CSV outputs and screenshots are gitignored — `git add -f` when worth committing.

## When in doubt

If you're not sure whether a script is stale:

1. Check the file mtime: `ls -lt scripts/<script>`. Older than ~3 months is suspect.
2. Check `git log -- scripts/<script>` for the last commit. Messages like "one-off" or "ad-hoc" mean it's done.
3. Read the head of the file — most have a top-of-file comment describing intent and inputs.

## Adding a new script

1. Name by pattern: `backfill-*`, `analyze_*`, `audit-*`, `enrich_*`.
2. Top-of-file docstring explaining what it does and how to invoke (env vars, args).
3. Read `.env.local` via `dotenv`; **never hardcode** Neon/UW credentials.
4. Make it idempotent. Always.
5. Default to `DRY_RUN=true` for any script that writes; require explicit `DRY_RUN=false` to commit changes.
6. Log row counts before/after writes so the operator can spot-check.
