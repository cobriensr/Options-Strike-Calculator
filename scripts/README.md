# scripts/

One-off and recurring scripts that live outside the Vercel function lifecycle: backfills, ad-hoc analyses, ops utilities. About 256 top-level files as of 2026-10-29 (113 `.py`, 71 `.mjs`, 63 `.ts`, plus a few `.sh`, `.mts` and `.sql`), and the `_lib/`, `ops/`, `eod-flow-analysis/` and `ws-canary/` folders.

Nothing here is a Vercel Function. A few are build and CI tooling (`write-build-info.mjs` in `npm run build`; `check-build-output.mjs` and `check-coverage-floor.mjs` in `npm run review`; `upload_takeit_bundles.mjs` in the ML workflow), and `ws-canary/` is a temporary Railway service. The rest run from the developer's machine against the production Neon instance (read `.env.local` for credentials). Most assume you've already pulled env vars with `vercel env pull .env.local`, whose `DATABASE_URL` is the production database.

## Categories

### Backfill (`backfill-*`)

Re-run a historical version of a cron job to populate new tables/columns. Most are idempotent and scoped by date range or batch size; check the script's header before re-running one.

```bash
# .ts (run via tsx)
DATABASE_URL=... npx tsx scripts/backfill-zero-gamma.ts

# .mjs (Node ESM)
UW_API_KEY=... DATABASE_URL=... node scripts/backfill-dark-pool-prints.mjs

# .py (use the ml venv; on Linux/macOS: ml/.venv/bin/python)
ml/.venv/Scripts/python scripts/backfill_net_flow_history.py --date 2026-05-05
```

Each script documents its inputs in its header. Most take CLI flags (`--date YYYY-MM-DD`, `--dry-run`, or an opt-in `--write`/`--apply`). A few older ones read env vars such as `BACKFILL_START`/`BACKFILL_END`, `BATCH_SIZE` or `DRY_RUN=1`.

Recurring:

- **Nightly, via the root `Makefile`** (`make nightly` / `make update`): `eod-flow-analysis/analyze.py` (reads the day's Full Tape from R2 with `--r2`), `ingest-flow.py` (writes the Bot-EOD archive parquet; nothing is uploaded), `enrich_lottery_outcomes.py`, `enrich_silent_boom_outcomes.py`, `ml/src/lottery_scoring.py --through` + `backfill_lottery_scores.py` (`make refit`: dry runs, the refit runs in the nightly service), and the research refresh (`exit_policy_search.py`, `feature_audit.py`, `flow_inversion_timing.py`, `daily_tracker.py`, `mine_outcome_patterns.py`, `score_lineage_audit.py`). Weekly: `tune_flow_inversion.py` (`make tune`). `make help` lists the targets. `backfill_net_flow_history.py` is manual-only now (no Makefile target runs it): the `fetch-net-flow-history` cron (`api/cron/fetch-net-flow-history.ts`) fills `net_flow_per_ticker_history`, and the script repairs a day that cron missed.
- **UW REST history backfills**: `backfill-greek-exposure.mjs`, `backfill-spot-gex.mjs`, `backfill-strike-exposure.mjs` / `backfill-strike-exposure-lottery.mjs`, `backfill-dark-pool-prints.mjs`, `backfill-flow-alerts.mjs`, `backfill-range-pos.mjs` (`range_pos_at_trigger` on lottery fires, from UW 1-minute candles; UW adjusts its candles for later splits but the stored spot isn't, so it leaves a fire NULL when the spot sits more than `SPLIT_GUARD_RATIO` (1.2) outside the pre-trigger candle range and lists those ticker-days in its report) and `repair-range-pos-splits.mjs` (one-shot repair of the CRWD and SOXS `range_pos_at_trigger` rows the 10-29 run pinned at 0 or 1 across stock splits: each row is recomputed from the rescaled spot or blanked; dry run by default, `--apply` writes a backup under `docs/tmp/range-pos-split-repair/` first and then ≤500-row guarded UPDATEs, `--undo <backup> [--apply]` restores a backup; applied 2026-11-19, 1,183 rows; spec: `docs/superpowers/specs/2026-11-19-range-pos-split-repair-and-badge-text.md`). The `flow_data` ones: `backfill-local.mjs` (`market_tide`, `market_tide_otm`), `backfill-etf-tide.mjs` (`spy_etf_tide`, `qqq_etf_tide`) and `backfill-netflow.mjs` (`spx_flow`, `spy_flow`, `qqq_flow`). Each takes a required `--from/--to` (finished ET trading days; `--dry-run`, `--limit N`, `--allow-market-hours`; the old positional day count and ticker list are gone), writes `ON CONFLICT DO NOTHING`, and exits 1 if any day failed (UW error, bad JSON, or a database error). Run it as `node --env-file=.env.local scripts/backfill-local.mjs --from 2026-07-22 --to 2026-09-04`. The 1-minute candle tables: `backfill-etf-candles-1m.mjs` (`etf_candles_1m`, SPY and QQQ) and `backfill-spx-candles-1m.mjs` (`index_candles_1m`, SPX and NDX: the ETF bars times a per-day Schwab close ratio; also needs the Schwab token in Upstash, so it refuses 13:00–22:59 UTC on weekdays). Both take a required `--from/--to`; run the ETF one first.
- **Derived-table backfills** (type-checked through `tsconfig.scripts.json`): `backfill-zero-gamma.ts`, `backfill-gamma-setup-fires.ts`, `backfill-economic-event-labels.ts` (one-shot repair of the FOMC/FED event labels and the `training_features`, `market_snapshots` and `ws_gamma_setup_fires` flags built on them; dry run by default, `--apply` writes in one transaction; read its header for the run order), `backfill-snapshot-event-flags.ts` (one-shot repair of `market_snapshots.is_event_day` / `event_names` and `training_features.is_event_day` from the server's macro event sources only (FRED releases, FOMC, half days and closures; mega-cap earnings are not part of the stored flag, so stored earnings names are removed by design), one FRED lookup per month; needs `FRED_API_KEY` in the shell; dry run by default, `--apply` writes an undo file under `docs/tmp/snapshot-event-flags/` and then one transaction), `rescore-lottery-v2-after-flow-backfill.ts` (the second step after `backfill-ticker-flow-at-fire.ts`: gives `lottery_finder_fires` rows with a NULL V2 `score`, flow now set and dte 0 to 3 the score the detector would give them, with the same scorer and the weights of the version the `active` pointer names, and tags them with it in `score_version`; `--since` is required and not before 2026-09-08; dry run by default, `--apply` writes an undo file under `docs/tmp/lottery-v2-rescore/` and then `score` and `score_version` only, 500 rows a statement, only where the score is still NULL, the tag is what the dry run read and the pointer still names that version; a second `--apply` writes nothing; it stops if the weights store cannot be read; `backfill_lottery_scores.py` is the whole-table rescore, which cannot be scoped to these rows; spec: `docs/superpowers/specs/sentry-noise-fixes-2026-11-13.md`, Phase 5), `backfill-gex-target-features.ts`, `backfill-opening-flow-signal.ts`, `backfill-periscope-lottery-fires.ts`, `backfill-periscope-lottery-outcomes.ts`, `backfill-regime-0dte.ts`, `backfill-wave2-status.ts` (one-shot `wave2_status` labels for old lottery and silent boom rows; `--dry-run`, `--limit N`; shares its rule with `api/cron/wave2-confirmation.ts`).
- **Gap repair for `ws_option_trades`**: `reload-ws-option-trades-from-fulltape.py --date YYYY-MM-DD [--apply]`. The dated `backfill-ws-option-trades-2026-*.py` files are one-shots for specific uw-stream outages.

### Analysis (`analyze_*`, `analyze-*`)

EDA and statistical analyses (Python `analyze_*`, TypeScript `analyze-*`). Outputs land in `docs/tmp/` or are summarized into specs. Usually one-off: once a finding is captured in a spec, the script can be considered done unless underlying data changes.

- `analyze_silent_boom_multileg.py`: multi-leg signal correlation
- `analyze_cross_symbol_confluence.py`: SPY/QQQ/IWM joint signals
- `analyze_interval_ba_cuts.py`: the five cuts of the Interval B/A alerts (hit rate, magnitude, hour of day, ratio, sweep) over their forward paths. Reads the replay day files by default (`--source days`: `research/interval-ba/replay/<date>.parquet`, one per session, which the nightly `interval-ba-tape` step writes; the database is never opened) and the newest `interval-ba-outcomes-days-*.csv`. Only the days that CSV covers are checked and read, and a missing, stale or empty day file is repaired first (see "The Interval B/A readers" below). `--source export` reads the one-time snapshot (newest `research/interval-ba/replay-<date>.parquet` unless `--export-end YYYY-MM-DD`, which alone also means this source) and the newest `interval-ba-outcomes-export-*.csv`. `--source table` reads `interval_ba_alerts` and the newest `interval-ba-outcomes-*.csv`, which have the live feed's gaps. Also `--ticker`, `--csv` and `--dry-run`. The report opens with a banner naming the rebuild's methodology changes, which make it not comparable with reports from before 2026-11-26
- `analyze_confluence_vs_solo.py`: SPXW alerts with an SPY or QQQ partner in the `--window-sec` up to their own `fired_at` (backward only, inclusive, and a partner at the same instant counts; a methodology change of 2026-11-26, earlier reports counted partners up to the window after the alert and are not comparable) vs. alone, over the same forward paths. The same `--source days|export|table`, `--export-end` and `--dry-run` as the cuts script, and the same banner; the day files and the snapshot give the partners the live feed missed on its gap days

### Audit / verify (`audit-*`, `check-*`, `verify-*`, `grade-*`)

Sanity checks against production data. Usually read-only.

- `verify-lottery-no-vanish.ts`: replays the lottery feed through the day to guard the "alerts never disappear intraday" invariant
- `verify-gexbot-tables.mts`: confirms the `gexbot_*` tables have the expected columns and indexes
- `verify-periscope-snapshot.mjs`: cross-checks one GEX Landscape snapshot against `periscope_snapshots`
- `grade-periscope-day.mjs`: replay a Periscope day against actuals

### Enrichment (`enrich_*`)

Compute additional features on existing rows. Typically used after a feature-engineering change.

- `enrich_lottery_outcomes.py`: realized exit-policy columns on `lottery_finder_fires` from the EOD parquet tape (`make enrich`) or the R2 Full Tape with `--r2` (also `--select` and `--dry-run`)
- `enrich_silent_boom_outcomes.py`: peak and realized exits on `silent_boom_alerts` from parquet or the R2 Full Tape with `--r2` (also `--select` and `--dry-run`)
- `enrich_silent_boom_outcomes_fulltape.py`: the same from the Full Tape parquet archive
- `enrich_interval_ba_outcomes.py`: forward spot paths for Interval B/A alerts, read from the Full Tape in R2. `--source days` (the default) takes the alerts from the replay day files, `research/interval-ba/replay/<date>.parquet`, for the NYSE trading days of `--from-date` to `--to-date` (default: 2026-01-02 through the newest landed tape). `--source export` takes them from the one-time snapshot `research/interval-ba/replay-<end>.parquet`: `--export-end YYYY-MM-DD` names one (given alone it means this source), else the newest in R2 is listed and used (its key is printed). `--source table` takes them from `interval_ba_alerts` (`--export-end` with it, or with `days`, is a usage error). A half day's path ends at its early close (12:00 CT), from the early-close days in `uw-stream/src/market_calendar.py`. Also `--ticker`, `--limit-alerts` and `--dry-run`. It writes the CSVs the two analysis scripts read: `interval-ba-outcomes-days-*.csv` for the day files, `interval-ba-outcomes-export-*.csv` for the snapshot and `interval-ba-outcomes-*.csv` for the table (a ticker other than SPXW adds `-spy-`/`-qqq-` after the kind), so an analysis never joins the paths of another source. What the three readers share (the `--source` flags, those names, the day-file check and repair) is in `_interval_ba_days.py`; the snapshot reader is here

#### The Interval B/A readers: the day files, the repair and `--dry-run`

The three scripts above read the day files by default. Before it reads, each run lists the day-file prefix and the tape prefix in R2 once and checks the days it needs: enrich's `--from-date` to `--to-date`, and for the two analysis scripts the days of their outcomes CSV (its first to its last `fired_at`). A needed day with a landed tape is:

- **missing** when it has no file, and **stale** when its file is older than its tape (a re-landed tape on a night the nightly step does not run keeps its marker, so the step never rewrites the file);
- **empty** when its file's footer says it holds no alerts. No session fires fewer than 19, so a zero-row file is a replay or tape-read fault, and the nightly never rewrites a marked day: the file is no good day, and a study would go ahead without that day's alerts;
- **not a gap** when UW marked it unavailable (`fulltape/_unavailable/<date>.json`): it is printed, named in the report's header and skipped.

A missing, stale or empty day is **repaired first**: the tool's per-day writer (`write_replay_days` in `interval_ba_tape.py`, imported only then, the same code as `export --per-day`) replays it from the tape and writes its file, and the run goes on over the files it lists again. It writes research files only, never Neon, and each repaired day is printed with "the nightly should have written it; check the interval-ba-tape step" and named in the report's header. The repair is **refused**, with a message and no study, when:

- a missing day has no tape (wait for the nightly run, or use `--source table`);
- the run is inside 07:15-12:30 UTC, the nightly window (the message gives the time to retry);
- more than 10 days need it, which points to a broken nightly write (the message prints the one `export --per-day` command that fills them; with no day file at all in the prefix it says so and names the backfill instead);
- the replay module here is not `origin/main`'s (the writer refuses unless the checkout is at `origin/main`; a dry run asks the same guard), or its rule is not the one the files hold;
- a file it wrote holds no alerts (no session fires fewer than 19). The file stays in R2, so the next run meets it as an empty day and replays it again: it either heals, or hits this refusal on every run, until the cause is fixed.

The run also refuses when the day files it would read are on more than one rule (`REPLAY_VERSION` and the constants; an empty file's footer counts), naming the days on each, or when a footer is missing, unreadable or names another day; the fix is `export --per-day` over the days of the old rule. An analysis script that repaired a day names it in its report ("rewritten after the outcomes CSV was priced": re-run `enrich_interval_ba_outcomes.py` for those days). An R2 or DuckDB error shows its class only: its text can name the account host.

`--dry-run` is a check, not a run. With the day files it never writes, lists the days a repair would write and what would refuse it (the deployed-code guard included), and exits non-zero when there is any; otherwise it says the day files are present and current, exits 0 and stops, with no tape, alert or CSV read. With `--source export` or `table` it runs and skips the CSV and report files. With no flags each script reads the day files:

```bash
ml/.venv/Scripts/python scripts/enrich_interval_ba_outcomes.py            # 2026-01-02 to the newest tape
ml/.venv/Scripts/python scripts/analyze_interval_ba_cuts.py               # the newest -days- CSV's days
ml/.venv/Scripts/python scripts/analyze_confluence_vs_solo.py
ml/.venv/Scripts/python scripts/enrich_interval_ba_outcomes.py --dry-run  # lists what a repair would write
```

### Python backfills (`backfill_*.py`, plus some `backfill-*.py`)

Python-side backfills for ML feature columns, e.g. `backfill_takeit.py` (Take-It scores), `backfill_silent_boom_from_fulltape.py`, `backfill_round_trip_score.py`. Run with the ml venv.

### Ops (`ops/`)

Neon maintenance: connection diagnostics, killing hung backends, autovacuum tuning, vacuuming hot tables.

### EOD flow analysis (`eod-flow-analysis/`)

Self-contained pipeline for end-of-day flow stratification. Writes to its own `output/` directory. See [eod-flow-analysis/README.md](eod-flow-analysis/README.md).

### Websocket canary (`ws-canary/`)

A temporary Railway service that holds test websockets to find which network hop resets uw-stream's connections. See [ws-canary/README.md](ws-canary/README.md); it is deleted once the verdict is in.

### Tooling and operations

- **Build and review**: `write-build-info.mjs` (commit SHA into `api/_lib/build-info.ts` for `/api/version`), `check-build-output.mjs` (build-output gate), `check-coverage-floor.mjs` (per-file coverage gate), `review-gate.mjs` (commit gate: `npm run review` is its `run` subcommand, which takes the machine-wide gate lock, so one gate runs at a time, and runs the `review:steps` chain, which seals the tree it passed; `.githooks/pre-commit` blocks a Claude commit of anything else), `prune-merged-worktrees.mjs` (`npm run worktrees:prune`; copies a finished worktree's `.superpowers/` ledger out first, to `docs/tmp/worktree-ledgers/<name>/`, or to `<name>-<UTC timestamp>` when a different copy is there). Shared logic lives in `_lib/` (coverage floors, build output, the commit gate, worktree pruning, the git runner those two share, trading days, backfill helpers, and the scratch-git fixtures for tests that run real git); its test files run under Vitest.
- **Review log and deploy watchers**: both print to stdout and report through the exit code, so a caller can read the result without grepping.
  - `review-summary.mjs [logfile]` reads `npm run review` output from a file or stdin (`npm run review 2>&1 | node scripts/review-summary.mjs`). It prints pass, fail or not reached for type-check, eslint, prettier, vite build, the build-output check, vitest, the coverage floor and the seal. A failed stage gets its first five error lines: tsc `error TS…`, eslint `file:line rule`, the vitest `FAIL` test names with the `Test Files`/`Tests` totals, the coverage-floor failure. The seal line comes last when the log has one. A `gate lock` line comes first when the log has any gate-lock output: `pass` with the holder it last waited for, or `fail` with why (still waiting when the log ends, or `run` failed before the chain: the 120 min wait cap, no `review:steps`, a git error). A line starting `review-gate: the chain hit the` (the 75 min hold-cap kill) fails the stage the log was in, and is shown first under it. The `{"level":…}` pino lines that tests print on error paths are skipped. A log that ends inside a stage counts as failed. A failed `review-gate clear` shows its message under the first stage, and the `npm :` prefix that Windows PowerShell 5.1 puts on the first stderr line of a coverage-floor, build-output or seal failure is read through. Exit 0 every stage passed, 1 otherwise, 2 bad usage (more than one argument, or an option such as `--help`), unreadable input or no review output in it.
  - `watch-deploy.mjs <sha> [--timeout <min>] [--repo owner/name]` polls the commit's statuses (Vercel and the Railway `Theta-Options - <service>` contexts) and check runs through `gh api` every 30 seconds, until no check run is queued or in progress, no status is pending and at least one check run exists. It then polls once more, 10 seconds later, and gives the verdict only if the same check runs are there and still nothing is pending: GitHub creates a job that `needs:` another only when that one completes, so the first all-clear can come before the dependent job (E2E Tests) exists. Each `gh api` call is cut off after 60 seconds and retried at the next poll. The `gh --version` check the CLI makes first gets the same 60 seconds, but is not retried: a `gh` that does not answer it in time is reported as not answering, not as missing. It prints a line for each status and check run (again whenever one changes) and ends with a `verdict:` line. Skipped and neutral check runs, "No deployment needed" statuses and a canceled Vercel deploy count as non-failures. Defaults: 30 minutes, and the repo of `origin`. Exit 0 everything passed, 1 a failure, cancellation or timed-out check, 2 the timeout, 3 bad arguments, or `gh` missing or not answering `gh --version` within 60 seconds (also an unknown commit or no `gh` login).
  - The logic is in `_lib/review-summary.mjs` and `_lib/watch-deploy.mjs`. Their tests run on trimmed real logs and payloads in `_lib/review-summary-fixtures/` and `_lib/watch-deploy-fixtures/`.
- **Session status**: `session-status.mjs [--no-ci] [--count <n>] [--fetch]` shows the state of the work at a glance, read-only. On this repo's 30 worktrees (13 of them merged) it takes about 3 s without CI and 5 to 15 s with it, depending on load (one `gh` call is about 0.7 s, and the default 5 commits are polled together). Each merged worktree adds about 0.1 s, for the prune checks below.
  - It prints the age of the `origin/main` ref (the `FETCH_HEAD` mtime, else the reflog); the main checkout (path, branch, ahead/behind `origin/main`, uncommitted files); every linked worktree (branch, ahead/behind, uncommitted files, age of the last commit, a tag); and the last 5 commits on `origin/main` with their CI verdict. Nothing is fetched unless you pass `--fetch`, so check the first line before trusting a "behind" count.
  - The tag is `merged`, or any of `dirty`, `ahead N`, `missing` (folder gone), `locked`, `unborn` (no commits) and `error` (a git call for it failed). `merged` is a fact: the tree is clean, the worktree is unlocked, and every commit ahead of `origin/main` is in it by patch (`git cherry`), so a rebased or cherry-picked branch counts, and a squash of a single commit too; a squash of several commits does not (its patch matches none of them, so the branch reads `ahead N`), nor does a branch with a merge commit of its own that `origin/main` lacks. `ahead N` counts the commits ahead by ancestry; when some are in `origin/main` under other ids it adds `(K not in main)`, the commits whose patch is missing there.
  - A plain `merged` is also a cleanup candidate: it passes the checks `npm run worktrees:prune` makes before it removes a worktree. They are `checkInUse` and `checkSettled` from `_lib/prune-worktrees.mjs`, not copies: idle for 24 hours (the newest of the admin `index`, `logs/HEAD` and any file in its gitignored `.superpowers/` ledger), no rebase, merge, cherry-pick, revert (a stopped multi-commit pick or revert included) or bisect stopped in it, no ignored files in `docs/tmp/`, no link or special file in `.superpowers/`, and the current directory not inside it. The worktree must also sit under `.worktrees/`, the only folder prune touches (`pruneName` in the same module). A merged worktree that fails one reads `merged (why)`: `merged (active 2h)`, `merged (rebase in progress)`, `merged (docs/tmp files)`, `merged (ledger link)`, `merged (current directory)`, `merged (outside .worktrees/)`. It is not counted as a candidate and does not sort last. Removal copies a worktree's `.superpowers/` files to `docs/tmp/worktree-ledgers/<name>/` in the main checkout first; this command does not predict that step. Candidates sort last; remove them with `npm run worktrees:prune`. One limit: prune compares with the local `main` and this command with `origin/main`, so fast-forward `main` first, or prune may keep a candidate.
  - CI is one poll of the commit's statuses and check runs through `_lib/watch-deploy.mjs` (`evaluateDeploy`, `fetchPayloads`): `success`, `failure` (any failed item, even while others run), `pending`, `canceled-superseded` (a newer commit replaced its Vercel deploy), `no-ci` (no check run on a commit over 10 minutes old: GitHub runs a push's workflows for its newest commit only; the tip of `origin/main` is never `no-ci`, since the age is the commit's own time and a commit made an hour ago may have been pushed a minute ago), or `unknown` with the reason when `gh` could not answer. Each `gh` call is cut off after 15 s, and 5 commits are polled at once, so `--count 50` takes up to 10 batches of 15 s, about 150 s, if `gh` stalls. `--no-ci` skips the section; `--count` (1 to 50) sizes it.
  - Exit 0 printed, 1 unexpected failure, 2 bad arguments, 3 git missing, not a repository, or no `origin/main`. Its git calls run without `GIT_DIR`, `GIT_INDEX_FILE` and the other variables that tie git to one repository (`gitEnv` from `_lib/prune-worktrees.mjs`), so it also works from a git hook. The logic is in `_lib/session-status.mjs`; its tests fake git and gh (`session-status.test.mjs`) and run the script against scratch repos with real git (`session-status.cli.test.mjs`).
- **Take-It**: `upload_takeit_bundles.mjs` (upload bundles and the `takeit/latest.json` manifest), `takeit-rollback.mjs` (`make takeit-rollback`; see [the rollback runbook](../docs/runbooks/takeit-rollback.md)), `backfill-takeit-scores.mjs` (`make takeit-backfill`).
- **Full Tape and EOD flow ingest**: `download-fulltape.sh`, `ingest-fulltape.py`, `upload-fulltape-to-r2.py`, `ingest-flow.py`.
- **DB**: `migrate-db.ts` runs `migrateDb()` against `DATABASE_URL`.
- **Infra**: `check-py-outdated.sh` (outdated Python packages, local or `--remote`).
- **Replays**: `replay-lottery-fires-*.ts`, `replay-silent-boom-*.ts`, `replay-spike-detection.mjs`: production-parity re-runs for specific corrupted or missed days.
- **Recompute**: `recompute_peak_from_parquet.py`, `recompute_lottery_hold_minutes.py`, `recompute_silent_boom_hold_minutes.py`.
- **Docs**: `add-spec-status-headers.mjs` (wrote the spec front-matter `status:`).
- **One-off probes**: 29 `_probe-*.ts` / `_dump-*.ts` files, read-only and throwaway by design.
- **Python tests**: the `test_*.py` files sit here. The `ml` CI job runs them (`python -m pytest scripts/test_*.py scripts/ws-canary/test_canary.py` from the repo root, so `scripts/conftest.py`'s no-database guard applies); run the same command with `ml/.venv` before a change here.

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
