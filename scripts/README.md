# scripts/

One-off and recurring scripts that live outside the Vercel function lifecycle: backfills, ad-hoc analyses, ops utilities. About 255 top-level files as of 2026-10-29 (113 `.py`, 70 `.mjs`, 63 `.ts`, plus a few `.sh`, `.mts` and `.sql`), and the `_lib/`, `ops/`, `eod-flow-analysis/` and `ws-canary/` folders.

Nothing here is a Vercel Function. A few are build and CI tooling (`write-build-info.mjs` in `npm run build`; `check-build-output.mjs` and `check-coverage-floor.mjs` in `npm run review`; `upload_takeit_bundles.mjs` in the ML workflow), and `ws-canary/` is a temporary Railway service. The rest run from the developer's machine against the production Neon instance (read `.env.local` for credentials). Most assume you've already pulled env vars with `vercel env pull .env.local`, whose `DATABASE_URL` is the production database.

## Categories

### Backfill (`backfill-*`)

Re-run a historical version of a cron job to populate new tables/columns. Most are idempotent and scoped by date range or batch size; check the script's header before re-running one.

```bash
# .ts (run via tsx)
DATABASE_URL=... npx tsx scripts/backfill-zero-gamma.ts

# .mjs (Node ESM)
UW_API_KEY=... DATABASE_URL=... node scripts/backfill-dark-pool-prints.mjs

# .py (use the ml venv; on Windows: ml/.venv/Scripts/python)
ml/.venv/bin/python scripts/backfill_net_flow_history.py --date 2026-05-05
```

Each script documents its inputs in its header. Most take CLI flags (`--date YYYY-MM-DD`, `--dry-run`, or an opt-in `--write`/`--apply`). A few older ones read env vars such as `BACKFILL_START`/`BACKFILL_END`, `BATCH_SIZE` or `DRY_RUN=1`.

Recurring:

- **Nightly, via the root `Makefile`** (`make nightly` / `make update`): `eod-flow-analysis/analyze.py`, `ingest-flow.py`, `backfill_net_flow_history.py`, `enrich_lottery_outcomes.py`, `enrich_silent_boom_outcomes.py`, `sync_lottery_score_weights_v2.py` + `backfill_lottery_scores.py` (refit), `online_ticker_update.py`, and the research refresh (`exit_policy_search.py`, `feature_audit.py`, `flow_inversion_timing.py`, `daily_tracker.py`, `mine_outcome_patterns.py`, `score_lineage_audit.py`). Weekly: `tune_flow_inversion.py` (`make tune`). `make help` lists the targets.
- **UW REST history backfills**: `backfill-greek-exposure.mjs`, `backfill-spot-gex.mjs`, `backfill-strike-exposure.mjs` / `backfill-strike-exposure-lottery.mjs`, `backfill-dark-pool-prints.mjs`, `backfill-flow-alerts.mjs`, `backfill-netflow.mjs`, `backfill-range-pos.mjs` (`range_pos_at_trigger` on lottery fires, from UW 1-minute candles).
- **Derived-table backfills** (type-checked through `tsconfig.scripts.json`): `backfill-zero-gamma.ts`, `backfill-gamma-setup-fires.ts`, `backfill-gex-target-features.ts`, `backfill-opening-flow-signal.ts`, `backfill-periscope-lottery-fires.ts`, `backfill-periscope-lottery-outcomes.ts`, `backfill-regime-0dte.ts`.
- **Gap repair for `ws_option_trades`**: `reload-ws-option-trades-from-fulltape.py --date YYYY-MM-DD [--apply]`. The dated `backfill-ws-option-trades-2026-*.py` files are one-shots for specific uw-stream outages.

### Analysis (`analyze_*`, `analyze-*`)

EDA and statistical analyses (Python `analyze_*`, TypeScript `analyze-*`). Outputs land in `docs/tmp/` or are summarized into specs. Usually one-off: once a finding is captured in a spec, the script can be considered done unless underlying data changes.

- `analyze_silent_boom_multileg.py`: multi-leg signal correlation
- `analyze_cross_symbol_confluence.py`: SPY/QQQ/IWM joint signals
- `analyze_interval_ba_cuts.py`: bid/ask interval thresholds
- `analyze_confluence_vs_solo.py`: single vs. confluent signals

### Audit / verify (`audit-*`, `check-*`, `verify-*`, `grade-*`)

Sanity checks against production data. Usually read-only.

- `verify-lottery-no-vanish.ts`: replays the lottery feed through the day to guard the "alerts never disappear intraday" invariant
- `verify-gexbot-tables.mts`: confirms the `gexbot_*` tables have the expected columns and indexes
- `verify-periscope-snapshot.mjs`: cross-checks one GEX Landscape snapshot against `periscope_snapshots`
- `grade-periscope-day.mjs`: replay a Periscope day against actuals

### Enrichment (`enrich_*`)

Compute additional features on existing rows. Typically used after a feature-engineering change.

- `enrich_lottery_outcomes.py`: realized exit-policy columns on `lottery_finder_fires` from the EOD parquet tape (`make enrich`)
- `enrich_silent_boom_outcomes.py`: peak and realized exits on `silent_boom_alerts` from parquet
- `enrich_silent_boom_outcomes_fulltape.py`: the same from the Full Tape parquet archive
- `enrich_interval_ba_outcomes.py`: forward SPX paths for `interval_ba_alerts`

### Python backfills (`backfill_*.py`, plus some `backfill-*.py`)

Python-side backfills for ML feature columns, e.g. `backfill_takeit.py` (Take-It scores), `backfill_silent_boom_from_fulltape.py`, `backfill_interval_ba_alerts.py`, `backfill_round_trip_score.py`. Run with the ml venv.

### Ops (`ops/`)

Neon maintenance: connection diagnostics, killing hung backends, autovacuum tuning, vacuuming hot tables.

### EOD flow analysis (`eod-flow-analysis/`)

Self-contained pipeline for end-of-day flow stratification. Has its own `output/backfill-buckets/` directory (gitignored). See [eod-flow-analysis/README.md](eod-flow-analysis/README.md).

### Websocket canary (`ws-canary/`)

A temporary Railway service that holds test websockets to find which network hop resets uw-stream's connections. See [ws-canary/README.md](ws-canary/README.md); it is deleted once the verdict is in.

### Tooling and operations

- **Build and review**: `write-build-info.mjs` (commit SHA into `api/_lib/build-info.ts` for `/api/version`), `check-build-output.mjs` (build-output gate), `check-coverage-floor.mjs` (per-file coverage gate), `prune-merged-worktrees.mjs` (`npm run worktrees:prune`). Shared logic lives in `_lib/` (coverage floors, build output, worktree pruning, trading days, backfill helpers); its 9 test files run under Vitest.
- **Take-It**: `upload_takeit_bundles.mjs` (upload bundles and the `takeit/latest.json` manifest), `takeit-rollback.mjs` (`make takeit-rollback`; see [the rollback runbook](../docs/runbooks/takeit-rollback.md)), `backfill-takeit-scores.mjs` (`make takeit-backfill`).
- **Full Tape and EOD flow ingest**: `download-fulltape.sh`, `ingest-fulltape.py`, `upload-fulltape-to-r2.py`, `ingest-flow.py`.
- **DB**: `migrate-db.ts` runs `migrateDb()` against `DATABASE_URL`. `run-migrations.ts` is a one-shot for migration 98.
- **Infra**: `set-classifier-memory-limit.mjs` (Railway classifier memory ceiling), `check-py-outdated.sh` (outdated Python packages, local or `--remote`).
- **Replays**: `replay-lottery-fires-*.ts`, `replay-silent-boom-*.ts`, `replay-spike-detection.mjs`: production-parity re-runs for specific corrupted or missed days.
- **Recompute**: `recompute_peak_from_parquet.py`, `recompute_lottery_hold_minutes.py`, `recompute_silent_boom_hold_minutes.py`.
- **Docs**: `add-spec-status-headers.mjs` (wrote the spec front-matter `status:`).
- **One-off probes**: 29 `_probe-*.ts` / `_dump-*.ts` files, read-only and throwaway by design.
- **Python tests**: five `test_*.py` files sit here, and no suite or CI job runs them.

### Retired or pending removal

These serve features that are gone: each writes a table a migration has dropped, imports a deleted module, replays a retired detector, or needs input that no longer exists. Don't use them; removal is pending an owner decision.

- `backfill-institutional-blocks-uw.py` (writes `institutional_blocks`, dropped)
- `backfill-iv-anomalies-from-csv.py` (replays the IV-anomaly detector, retired 2026-04-30, into local JSON)
- `backfill-precision-stack.py` (writes `gamma_squeeze_events`, dropped)
- `backfill-whale-anomalies.py` (writes `whale_anomalies`, dropped)
- `preview-flush-alerts.ts` (imports the deleted `api/_lib/iv-anomaly.ts` and `api/_lib/anomaly-context.ts`)
- `recompute-whale-thresholds.py` (prints thresholds for `api/_lib/whale-detector.ts`, which no longer exists)
- `backfill-snapshots.ts` (loads JSONL from a generator script that was deleted, so it works only on files already on disk)

## When in doubt

If you're not sure whether a script is stale:

1. Check the last commit: `git log -1 --format=%cs -- scripts/<script>`. File times on a clone or worktree are checkout times, so `ls -lt` doesn't tell you. Older than ~3 months is suspect.
2. Check `git log -- scripts/<script>` for the history. Messages like "one-off" or "ad-hoc" mean it's done.
3. Check `tsconfig.scripts.json`: operational TypeScript scripts are type-checked there, and one-off research scripts are left out.
4. Read the head of the file: most have a top-of-file comment describing intent and inputs.

## Adding a new script

1. Name by purpose: `backfill-`, `analyze-`, `audit-`, `enrich_`, `replay-`, `verify-`, `check-` (hyphens for `.ts`/`.mjs`, underscores for most `.py`). Prefix throwaway probes with `_probe-`.
2. Top-of-file docstring explaining what it does and how to invoke (env vars, args).
3. Read `.env.local` via `dotenv`; **never hardcode** Neon/UW credentials.
4. Make it idempotent. Always.
5. Give any script that writes a dry-run mode (most use `--dry-run`; some make writes opt-in with `--write`/`--apply`).
6. Log row counts before/after writes so the operator can spot-check.
