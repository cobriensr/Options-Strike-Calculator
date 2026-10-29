# Nightly pipeline automation: design

Date: 2026-10-28. Status: approved by the owner 2026-10-28; next is the build plan. Revised after a builder check the same night. Memory: `nightly-automation-goal`, `enrichment-gaps-2026-10-28`.

## Intent

The owner never runs the evening routine by hand again. Until 2026-06-16 that routine was `make nightly update` on the retired Mac, started by a hand-downloaded `bot-eod-report-YYYY-MM-DD.csv`. It has not run since, about 95 trading days. One unattended nightly job replaces all of it:
- Its options input is only the Unusual Whales Full Tape REST endpoint (`GET /api/option-trades/full-tape/{date}`).

The owner asked for the whole process: downloading the file, saving it, uploading to Cloudflare, the enrichment scripts, and everything else the routine did.

## Facts this design rests on (verified 2026-10-28)

**Full Tape against bot-eod:**
- **The Full Tape is a row-level superset of bot-eod.**
  - On 06-15, Blob `flow/year=2026/month=06/day=15/data.parquet` (bot-eod rows) and R2 `fulltape/2026-06-15-fulltape.parquet` each hold exactly 11,581,348 rows before 16:00 ET.
  - Matched as a multiset on (executed_at, option_chain_id, price, size), 0 rows are missing in either direction.
  - All 23 shared value columns are identical.
  - The tape adds 62,431 prints from 16:00:00 to 16:59:59 ET.
  - Bot-eod's `side` equals the tape's side tag on 100% of rows. `equity_type` ETF and Index map from tags; ADR, Common Stock, Other and Unit can't be told apart.
  - `sector` is not in the tape, and no nightly step reads it.
  - The 05-06 raw check also found 0 bot-eod rows missing (`docs/tmp/fulltape-bot-eod-join-sanity-2026-05-07.md`).
- **Bot-eod is a hand export, not an API product.**
- **How the tape endpoint behaves:**
  - It answers with a 302 to a signed Google Cloud Storage zip, 1.1–2.1 GB.
  - Recent days post about 17:02 ET. Some older days were last written about 01:00 ET the next day.
  - Dates back to 2025-12-10 are still served.
  - Response headers show a 100,000,000 request cap.
- **What's already stored:**
  - R2 bucket `theta-options-fulltape`: 112 objects `fulltape/YYYY-MM-DD-fulltape.parquet`, 2026-01-02 → 2026-06-15 (05-29 missing), 138.7 GB, 42 columns (40 source columns plus `date` and `ingested_at`).
  - Blob `flow/`: 46 days, 04-13 → 06-16, 28 GB.
  - Local per-day chain files for 04-13 → 06-16 (44 files) exist in this checkout's `scripts/eod-flow-analysis/output/by-day/`. Only 04-13 → 05-15 are tracked in git.

**Enrichment and the live crons:**
- **Gaps in Neon:**
  - Lottery: 26,400 fires from 06-17 to 06-25 are marked enriched but have NULL outcomes, and 252,208 fires from 06-25 to 10-21 were never enriched.
  - Silent boom: all 8,989 alerts from 06-12 to 10-22 are done but empty.
  - Root cause: a bigint-as-string lookup in the enrichment cron, fixed and pushed 10-22.
- **The live crons enrich new fires** at about 16:40 and 16:45 CT, from 10-22 and 10-23 on. They read `ws_option_trades`, which keeps only 2 days.
- **`enrich_lottery_outcomes.py` makes three passes:**
  - Pass 1 writes the outcomes.
  - Pass 2 writes `realized_flow_inversion_pct` from the tape's NBBO mids. The live cron uses UW's synthetic mid; parity between the two is unverified.
  - Pass 3 (with `WRITE_DB=1`) rewrites the live `lottery_ticker_stats` quintiles that drive Q1/Q2 suppression. `api/cron/refit-lottery-ticker-stats.ts` deliberately holds that table in shadow (`PROMOTE_TO_LIVE = false`, `:58`).

**The lottery refit:**
- **Its training query returns 196 rows** because it keeps only `inferred_structure IS NULL`.
  - The filter was a workaround: "35% enrichment bug in structure rows" (`ml/src/lottery_scoring.py:15,128`).
  - The classifier now labels almost every fire, including 63,669 single-leg fires as `isolated_leg` in the last 90 days.
  - Retiring the classifier in favour of UW's multi-leg trade flag is a pending owner decision (memory `classifier-assessment-2026-10-28`).
- **The live weights date from 06-17** and have an in-sample Spearman of −0.064. The 06-10 refit flipped the C/P and DTE0 signs, and its checks were made advisory the same night.
- **It ships by rewriting `api/_lib/lottery-score-weights-v2.ts`,** which means a commit and a deploy.
- **`online_ticker_update.py` shifts ticker weights by up to ±1 each night with no gate.** It is a no-op today because `CURRENT_DATE` is in UTC.
- **Take-It already reads a score it wasn't trained on.** The live bundle `v2026-05-16` uses the lottery `score` as an input (`api/_lib/takeit-features.ts:671`), and the lottery weights have changed many times since 05-16. Only the lottery feed is affected; `:791` is Silent Boom's own score.

**Licensing:**
- **UW-derived row-level data is tracked in this public repo today.** That covers 23 per-contract `by-day/*-chains.parquet` files, plus `cumulative-headlines.txt` and `cumulative-rollup.json`, which list contracts by ticker, strike, premium and ask%.

**GexBot:**
- **GexBot's daily EOD report is a separate job,** by owner decision: "that nightly pipeline spec was for the UW end of day full tape, this is for gexbot, so I would prefer it to be separate". It is designed in `2026-10-28-gexbot-eod-capture-design.md` (all 60 tickers, a Vercel cron, the same R2 bucket under `gexbot-eod/`). This pipeline doesn't touch GexBot, and its R2 listings must read only the `fulltape/` prefix.

**Where the job could run:**
- The repo is public, so GitHub Actions logs are readable by anyone signed in.
- Vercel Functions top out at 4 GB of RAM and 800 s.
- Railway Pro gives 24 GB of RAM and 100 GB of ephemeral disk per service, and its cron runs have no maximum duration.

## Goals

1. **Every trading day's tape lands in R2 unattended,** by about 03:30 CT the next morning.
2. **Missing tape days fix themselves.** Each run lands every trading day missing since the last one landed. The first runs clear 06-16 → today, plus 05-29 if UW still serves it.
3. **Every lottery and silent-boom fire has outcomes.**
   - The 06-12 → 10-22 gap is backfilled from the tape.
   - Each night, a backstop re-enriches any fire the live cron left empty.
4. **Every research output `make nightly update` produced keeps updating from the tape:**
   - the per-day chains parquet, the cumulative rollup and headlines, the whale plots, the lottery tracking and ticker-weight-history CSVs;
   - the Take-It drift monitor (`takeit_health_daily`);
   - the dated research reports: `exit_policy_search`, `feature_audit`, `flow_inversion_timing`, `mine_outcome_patterns`, `score_lineage_audit` and the lottery quality sim.
5. **The lottery score refit, and the nightly ticker-weight update, run safely.** New weights go live only when they pass gates; otherwise the current ones stay.
6. **Failures are loud.** A Sentry alert fires on any of these:
   - a day that fails to land;
   - any step that fails;
   - a trading day with fires whose enrichment comes back 100% NULL;
   - a rejected refit.
   - A promoted refit sends the owner a notice too, because it changes scores and tier cutoffs he trades from.

## Non-goals

- **Re-running the detectors for 07-23 → 09-07.** No fires exist for those dates, after a UW billing / API-key problem that is now fixed. That's a separate project.
- **Periscope lottery enrichment** (4,917 open fires). It has no parquet reader; separate project.
- **Take-It retraining and the disabled ML GitHub workflow.** Owner decisions Q23 and O7 stand.
- **Promoting `lottery_ticker_stats` to live.** It stays on its existing shadow hold.
- **Choosing a post-close filter** (owner, 10-28): "take what's there and we can decide what we want to filter out later".
- **Silver 1-minute bars.** The skill can add them later.
- **GexBot's EOD report.** It's a separate job (see Facts).

## Anti-goals (failures even if everything technically runs)

- **UW data shows up anywhere public:** logs, a public Blob, a public endpoint, or the repo. Status lines with counts and dates are fine; rows of market data are not. This also means the job never commits the row-level outputs.
- **A bad refit or ticker-weight update quietly changes live scores,** the way the 06-10 sign flip did.
- **A step reports success after writing nothing** (rule R4).
- **Historical data is overwritten with no copy kept.** This applies to scores and outcomes alike.
- **The owner has to log in somewhere each morning** just to learn whether last night worked. Silence means success; failures and promotions reach him.

## Constraints

- **Data licensing** (CLAUDE.md): UW data needs owner or guest auth. R2 and Blob stay private.
- **Host: a new Railway service with a cron schedule.**
  - The service must exit when done, and Railway skips a run that would overlap a running one.
  - Schedules are in UTC.
  - The disk is wiped every run, so all state between runs lives in private storage, never on local disk.
  - No Railway pushes during market hours (memory `no-railway-push-market-hours`).
- **The websocket-over-REST rule** (CLAUDE.md) allows both pulls. Neither has a websocket equivalent for full-day history, and both run after the close.
- **DST ends 2026-11-01.**
  - Compute every session window in `America/New_York`.
  - The old 13:30–20:00 UTC window (`scripts/ingest-flow.py:70-72`) and `analyze.py`'s minute window assume CDT.
- **Repo rules:**
  - Writes are idempotent (R6). Backstop updates are conditional (`… WHERE outcome IS NULL`), so the job and the live cron never fight.
  - Batch the DB writes (R5).
  - Every new env var goes into code, its Python settings, the CLAUDE.md table and `.env.example`, in the same commit (R7).
  - Tests ship in the same commit; the new service gets a pytest suite, like `uw-stream/`.
- **Keys:** UW_API_KEY will live in three places (Vercel, Railway uw-stream, the new service). Update the key-rotation memory.

## Decided

**By the owner:**
- Automate the whole routine.
- The Full Tape endpoint is the only options input.
- No post-close cutoff for now.
- GexBot's EOD report is a separate job (owner, in its own design session the same night; see Facts).

**My calls** (flagged so the owner can overrule):
- **Lake and storage:**
  - **The lake is R2,** in the existing bucket and key pattern, so one place covers January → today. Reasons: free egress, about $9/month at 600 GB against about $19 on Blob.
  - **New tape files keep every column the day carries,** 40 to 50 as UW's layout grew, plus `date` and `ingested_at`.
  - **The tape ingest core is UW's own `uw_options_data_lake.py`,** vendored into the new service. That covers download, the historic-window probe, convert, the validation gate and the NYSE calendar.
    - Owner, 10-28: "review their code, make whatever changes you deem necessary and use that code, I'm really not worried about it". He accepts that the file carries no stated license.
    - Keep a provenance header: source URL, fetch date 2026-10-28, sha256 `a99ecce6…f8bb` of the published skill file.
    - Strip the parts this job doesn't use.
    - Changes come from a full code review (running 10-28) and are listed in the build plan.
    - It replaces `scripts/download-fulltape.sh` and `scripts/ingest-fulltape.py`. The latter drops the newer columns today (`:105-117`).
  - **Readers must accept the growing schema:** `union_by_name` / `diagonal_relaxed`. `ml/src/utils/r2.py` doesn't today.
- **Schedule:** 07:15 UTC, Tuesday through Saturday (02:15 CDT / 01:15 CST). That's after the late tape rewrites (04:57–05:59 UTC). One run a day is enough: UW keeps history, so a missed night lands on the next run.
- **Service:** a new Railway service directory laid out like `uw-stream/`.
- **Language:** the nightly job is Python (the owner asked; app code is TypeScript).
  - It reuses about a dozen existing Python scripts (ingest, enrichment, analyze, refit, plots, reports) instead of porting them.
  - polars and DuckDB stream the 7.5 GB CSVs.
  - It matches the other three Railway services.
  - Everything that touches the app stays TypeScript in `api/` with Vitest tests: the phase 4 weights loader, `detect-lottery-fires.ts`, the tier cutoffs and the migrations.
- **Enrichment:**
  - **Every outcome computation runs on the backfill,** pass 2 included, with every print counted.
  - **Before the backfill writes anything, each outcome row records how it was made,** for example `outcome_source` ∈ {`fulltape`, `ws_cron`} plus a version. A later filter or a training-set choice can then separate tape-built rows from cron-built ones without re-running.
  - **Pass 3 never writes live `lottery_ticker_stats`;** it honours the existing shadow hold.
- **Research outputs:**
  - **All of them run nightly** (the owner asked for the whole thing).
  - **Their state lives in private R2:** the by-day files, rollup inputs, appended CSVs and weights JSON. The 44 local by-day files are uploaded once; days that are lost can be rebuilt from the tape.
  - **Row-level files stop being tracked in git.** `git rm --cached` and `.gitignore` for the by-day parquets, the rollup, the headlines and `backfill-alerts/`. History isn't rewritten; that would need a force-push to main, which is the owner's call.
- **Retire the Blob `flow/` writes;** keep the existing 46 days. **Drop the local `backfill-flow` step;** the `fetch-net-flow-history` cron covers it.
- **Refit:**
  - **Weights and tier cutoffs load at runtime from a versioned store with an active pointer.** Precedents: `api/_lib/takeit-bundle-loader.ts` and the shadow/promote pattern in `api/cron/refit-lottery-ticker-stats.ts`.
  - **The nightly ticker-weight update goes through the same shadow and gates,** and does not run before phase 4.
  - **The training filter is defined in one place, as "not part of a multi-leg structure":**
    - Today that means counting `isolated_leg` as single-leg, which restores the filter's original intent.
    - Spread-leg labels stay excluded unless the backfill shows their outcomes are now clean. Measure the old bug's signature, `flow_inv > peak × 1.05`, on structure rows.
    - If the classifier is retired, this one definition switches to UW's multi-leg flag.
  - **A new refit runs in shadow first** until its gates are tuned on history (memory `tune-before-ship`).

## Phases (each ships on its own)

1. **The nightly tape landing job.** About 2 days.
   - New service.
   - Tape: find the trading days missing from R2 → download → validate → parquet with every column → upload → delete temporary files. One day at a time; peak disk about 12 GB. Cap each run at N days so the 95-day backlog clears over a few nights.
   - A Sentry cron check-in, plus one event per failed day.
2. **Enrichment from the lake.** About 2 days.
   - Add the `outcome_source` columns (migration).
   - Point `enrich_lottery_outcomes.py` and `enrich_silent_boom_outcomes.py` at the tape, through a shared reader.
   - Add a lottery mode that selects done-but-empty fires.
   - Skip a missing day instead of exiting (`:446`).
   - Read env vars from the process instead of requiring `.env.local`; fix the Mac-only Python path.
   - Run the 06-12 → 10-22 backfill once.
   - Run a nightly backstop after each landing.
   - Add the 100%-NULL alert.
3. **Research outputs from the tape.** About 3 days.
   - `analyze.py` reads the tape, with a tag map for `side` and the ETF/Index `equity_type`, and ET-aware windows.
   - Then the rollup and headlines, `ml/src/whale_plots.py`, the tracking and weight-history CSVs, the drift monitor and the research reports.
   - State and every output move to private R2 under one prefix per output family (layout is the builder's call). The owner reads them in the Cloudflare dashboard.
   - Untrack the row-level files.
4. **Safe nightly refit.** About 3–4 days.
   - The filter definition above.
   - Weights and cutoffs in a versioned runtime store; `lottery-score-weights-v2.ts` becomes a pure function of a validated weights object.
   - Gates, tuned on history first:
     - a minimum number of training rows;
     - rank correlation on a later held-out window must be at least the current weights' on that same window;
     - tier counts in range;
     - no NaN.
   - Snapshot the scores before any rescore.
   - Fix `<` against `<=` on quintile boundaries.
   - Fix the UTC `CURRENT_DATE`.
   - Shadow for N nights, then promote, with a notice to the owner.
   - Take-It pins the 06-17 weights version (owner answer 2). `detect-lottery-fires.ts` computes the score twice: the feed score from the active version, and Take-It's input score from the pinned version.

## Files (by phase; the plan will refine this)

1. A new service dir (`src/`, `tests/`, `Dockerfile`, `railway.toml`, `requirements*.txt`, `README.md`); UW's `uw_options_data_lake.py` vendored and adapted (it replaces `scripts/download-fulltape.sh` and `scripts/ingest-fulltape.py`); the CLAUDE.md env table; `.env.example`; `vercel.json` `ignoreCommand` for the new dir.
2. A migration (`api/_lib/db-migrations.ts` plus `api/__tests__/db.test.ts`), `scripts/enrich_lottery_outcomes.py`, `scripts/enrich_silent_boom_outcomes.py`, `ml/src/utils/r2.py`, their tests, and the service's step list.
3. `scripts/eod-flow-analysis/analyze.py`, `ml/src/whale_plots.py`, the tracker, drift and research scripts, `scripts/ingest-flow.py` (retire its Blob write), the Makefile, `.gitignore`.
4. `ml/src/lottery_scoring.py`, `scripts/backfill_lottery_scores.py`, `scripts/online_ticker_update.py`, `api/_lib/lottery-score-weights-v2.ts`, a new loader, `api/cron/detect-lottery-fires.ts` and its tests, `api/_lib/lottery-tier.ts`, `src/components/LotteryFinder/index.tsx`, a migration if the weights live in Neon, and possibly `api/_lib/takeit-features.ts`.

## Data dependencies

- **Env vars on the new service:** `UW_API_KEY`, `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT_URL`, `R2_BUCKET_FULLTAPE`, `SENTRY_DSN`.
- **External:** the UW Full Tape endpoint; R2 over the S3 API (`boto3` is not in `ml/requirements.txt` today).
- **Migrations:** the outcome provenance columns (phase 2); a weights-versions table with an active pointer, or a Blob manifest (phase 4, builder's call).

## Thresholds and constants

- **Schedule:** 07:15 UTC, Tuesday–Saturday.
- **Per-run tape catch-up cap:** builder's call, sized so a run finishes in under about 4 hours.
- **Disk:** worst case about 12 GB transient per tape day.
- **100%-NULL alert:** a trading day with at least 1 fire and 0 non-null outcomes after enrichment.
- **Refit gates:** tuned on history before phase 4 goes live; no numbers agreed yet.

## Owner answers (2026-10-28)

1. **Where outputs live:** "I can view the files on my own and with your assistance via the cloudflare portal whenever I want so the files don't have to be in the repo."
   - Every nightly output goes to private R2, browsable in the Cloudflare dashboard: the headlines, rollup, plots, CSVs, research reports and the job's own state.
   - Nothing is committed to the repo; no morning summary or app page is built.
2. **Take-It input:** the owner asked for a recommendation. My call, with the reasons given in chat:
   - Take-It stays pinned to the 06-17 weights version while the lottery feed follows the active version.
   - Reasons: it honours Q23, keeps Take-It's behaviour exactly as it is today, and keeps changes in Take-It traceable while the one-hot bug is open.
   - The pin moves only when Take-It is retrained after its side-by-side.
   - Until the first promotion the two scores are identical.

## Left to the builder

The service name and internal layout; retry and backoff numbers; the R2 client; the per-run catch-up cap; the NYSE holiday calendar (a hand table, loud past its last year); log format, which must contain no market-data rows; the provenance column names.
