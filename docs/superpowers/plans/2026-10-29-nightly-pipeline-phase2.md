# Nightly pipeline, phase 2: enrichment from the lake — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every lottery and silent-boom fire gets its realized outcomes from the UW Full Tape in R2: a one-time backfill of the 06-12 → 10-22 gap (and every older tape-fillable NULL), then a nightly backstop for whatever the live crons leave empty, with each outcome tagged by how it was made and a loud alert when a day comes back all NULL.

**Architecture:**
- The `nightly` Railway job gains a **post-tape step pipeline** (D2). Phase 2 registers two steps: `enrich-outcomes` (backstop + backfill) and `outcome-check` (the 100%-NULL alert). Phase 4 then appends `lottery-refit` and phase 3 appends its eleven steps, in the build order below.
- The Vercel lottery cron stops writing flow inversions (Task 7). The tape pass is their only writer, and it refills the rows reset on 2026-11-06 (Facts).
- The steps **reuse the existing enrichment scripts in place** (D1): the image is built from the repo root and copies exactly six shared files. The scripts get provenance-tagged, conditional writes and a done-but-empty selection.
- One shared **tape reader** (D3) fetches a day from R2 with one single-threaded boto3 client and hands consumers a local path.
- Writes go to production Neon through psycopg2 on a direct connection (D4): batched, conditional on the outcome still being NULL, counted from `RETURNING`.

**Tech Stack:** Python 3.12 (nightly image), pandas 3.0 + pyarrow (the scripts' read path), polars (the tape landing), psycopg2-binary, boto3; TypeScript for the migration and the two live crons; pytest, moto, Vitest, PGlite; ruff.

**Spec:** `docs/superpowers/specs/2026-10-28-nightly-pipeline-automation-design.md` (phase 2, plus "Decided" → Enrichment and the Constraints). Phase 1 plan: `docs/superpowers/plans/2026-10-28-nightly-pipeline-phase1.md`.

**Build order (owner, 2026-11-06):** phase 2 (all tasks) → phase 4 Tasks 1–22 (through the first shadow runs) → phase 3 (all tasks, built during phase 4's 10-session shadow) → phase 4 Task 23 (promotion). At runtime `pipeline.STEPS` runs the tape, then this phase's steps, then phase 4's `lottery-refit`, then phase 3's `research-derive` and report steps. D2's budget table holds every phase's reserve.

---

## Decisions that bind phases 3–4

### D1 — the image reuses the scripts in place (root build context)

- **Railway service `nightly`:**
  - root directory `/` (was `/nightly`);
  - Dockerfile path `/nightly/Dockerfile` (unchanged);
  - watch paths, exactly: `/nightly/Dockerfile`, `/nightly/requirements.txt`, `/nightly/src/**`, `/.dockerignore`, `/scripts/_tape_reader.py`, `/scripts/_cli_paths.py`, `/scripts/_pipeline_retry.py`, `/scripts/enrich_lottery_outcomes.py`, `/scripts/enrich_silent_boom_outcomes.py`, `/ml/src/lottery_exit_policies.py`.
- **Image layout:**
  - `/app/src` holds nightly's own modules;
  - `/app/scripts/` holds the five shared scripts files;
  - `/app/ml/src/lottery_exit_policies.py`;
  - `PYTHONPATH=/app/src:/app/scripts`.
- **The root `.dockerignore` excludes `scripts/`.** It re-admits the five files with the three-step pattern it already uses for `src/data/marketHours.ts` (`.dockerignore:24-26`), not with bare `!scripts/<file>` lines: right after the `scripts/` line, `!scripts/` re-admits the directory, `scripts/*` excludes its contents, then one `!scripts/<file>` line per file. A `COPY` of an ignored path fails the build, so a wrong order shows as a failed build, not a missing file. Task 9 pins the order and Task 15 Step 3 is the real build.
- **Checked against the code (2026-10-29):**
  - **Import graph (closed):**
    - `enrich_lottery_outcomes` → `_cli_paths`, `_pipeline_retry`, numpy, pandas, `psycopg2.extras`;
    - `enrich_silent_boom_outcomes` → the same, plus `lottery_exit_policies` through its own `sys.path.insert(ROOT / 'ml' / 'src')`. With `ROOT` = `/app`, that resolves to the copied file, which is stdlib-only;
    - `_tape_reader` (new) → boto3, botocore, urllib3 (no polars: it has no scan methods, see D3);
    - no module name in `nightly/src` exists in `scripts/` or `ml/src`.
  - **Dependencies:**
    - nightly gains `pandas>=3.0.2,<3.1`, `numpy>=2.4.4,<2.5`, `pyarrow>=23.0.1,<24` (pandas' parquet engine) and `psycopg2-binary>=2.9.11,<2.10`. Each floor is the `ml/requirements.txt` pin the scripts are tested on;
    - all four ship cp312 manylinux wheels;
    - `polars>=2.1,<3` and boto3 are unchanged. The reader no longer imports polars, so the ml venv's polars 1.44.2 plays no part in it.
  - **DB driver:** psycopg2 (sync), through `_pipeline_retry.connect_with_retry`.
  - **Hard-coded paths:**
    - `_cli_paths` has none;
    - both scripts `sys.exit` when `.env.local` is missing. Task 2b adds `_cli_paths.load_env_file`, which treats the file as optional, and Tasks 3–4 switch their `load_env` to it. Phase 3's scripts reuse it, so phase 3 touches no watch path for this;
    - pass 3's `docs/tmp/...csv` is relative, and the nightly never runs pass 3;
    - the Mac-only Makefile `PYTHON` was already fixed on 10-29 (`VENV_BIN`).
- **Why not vendor or port:**
  - the exit policies already exist three times (TS, the scripts' port, `ml/src`);
  - the scripts stay in local use (Makefile) with their own tests;
  - a port would be a fourth copy that drifts.
- **Rule for phases 3–4.** Every reused `scripts/` or `ml/src` file goes into six places in one task:
  - an explicit `COPY` in `nightly/Dockerfile`;
  - a watch path;
  - a `.dockerignore` exception (if under `scripts/`);
  - `IMAGE_FILES` in `nightly/tests/test_image_layout.py`;
  - the CI `nightly` path filter;
  - the watch-path list in `nightly/README.md`. Task 14's `test_readme_lists_every_watch_path` builds its expected list from `IMAGE_FILES`, so an image task that skips the README line fails its own run.

  If the five-file cap forces a split, the CI filter edit moves to its own task. The other five stay together.

  Heavy dependencies (DuckDB, matplotlib) are added to `nightly/requirements.txt` by the phase that first imports them. scikit-learn, scipy and SQLAlchemy stay out of the image: a step that imports one is changed to drop it (phase 3 does this for the drift monitor), not given the dependency.
- **Redeploy hazard grows:** a push touching any watch path (now including the five shared scripts files and `/.dockerignore`) redeploys the service, and a deploy during 07:15–12:30 UTC kills a run. Railway pushes also wait for the end of market hours (spec). So every push to a watch path, in every phase, goes **after 15:00 CT and outside 07:15–12:30 UTC**.

### D2 — the step runner

```python
# nightly/src/steps.py
StepStatus = Literal["ok", "partial", "failed"]
OutcomeStatus = Literal["ok", "partial", "failed", "skipped_deadline"]

@dataclass(frozen=True)
class StepContext:
    settings: Settings
    now_utc: datetime                 # the run's start, aware UTC
    last_session: date                # calendar_nyse.last_completed_session(now_utc)
    deadline: float                   # time.monotonic() value THIS step must stop by
    tape: tuple[DayOutcome, ...]      # tonight's tape outcomes; () if run_tape raised
    def seconds_left(self) -> float: ...

@dataclass(frozen=True)
class StepResult:
    status: StepStatus
    counts: Mapping[str, int]         # snake_case name -> int >= 0; never row data
    detail: str = ""                  # a fixed phrase; log- and Sentry-safe

@dataclass(frozen=True)
class Step:
    name: str                         # ^[a-z][a-z0-9-]{1,40}$, unique in STEPS
    run: Callable[[StepContext], StepResult]
    min_seconds: int                  # worst case of one unit of work; reserved by everything before it

@dataclass(frozen=True)
class StepOutcome:
    name: str
    status: OutcomeStatus
    counts: Mapping[str, int]
    detail: str
    seconds: float
    error: str | None = None          # exception class name when the step raised

def reserve_seconds(steps: Sequence[Step]) -> int            # sum of min_seconds
def run_steps(steps: Sequence[Step], *, settings: Settings, now_utc: datetime,
              last_session: date, run_deadline: float, tape: Sequence[DayOutcome],
              on_outcome: Callable[[StepOutcome], None] | None = None) -> list[StepOutcome]

# nightly/src/pipeline.py — the ordered registry phases 3–4 append to
STEPS: tuple[Step, ...]
```

- **Order and deadlines:**
  - Steps run in `STEPS` order after `run_tape`, every night, including when tape days failed or `run_tape` raised.
  - `run_tape` gets `deadline = run_deadline - reserve_seconds(STEPS)`. Step *i* gets `deadline = run_deadline - reserve_seconds(STEPS[i+1:])`. So the tape catch-up and every earlier step leave each later step its minimum.
  - A step with `seconds_left() < min_seconds` is `skipped_deadline`, and later steps still run.
  - `run_deadline` is `started + RUN_DEADLINE_SECONDS`, so the phase 1 watchdog (`+ WATCHDOG_GRACE_SECONDS`) still bounds everything.
- **Isolation:**
  - an `Exception` from `step.run` becomes `failed` with `error` = the class name, one scrubbed `capture_exception` tagged `step`, and a log line naming the class only;
  - `BaseException` (SIGTERM's `SystemExit`) propagates;
  - an invalid `StepResult` (unknown status, negative or non-int count) becomes `failed`, detail `invalid step result`;
  - a raising `on_outcome` is logged by class name and ignored.
- **Exit code:** `main` returns 1 if the tape rule says 1 or any step is `failed` or `skipped_deadline`. `partial` (work left for the next night) is exit 0 plus a Sentry warning.
- **Import isolation:**
  - `pipeline.py` never imports a step module at load. Each entry is `lazy_step(name, module, min_seconds)`, whose `run` calls `importlib.import_module(module).run(ctx)`.
  - A missing dependency or a bad shared file then raises `ImportError` inside the step. `run_steps` marks that step `failed` (`error` = the class name) and the tape and the other steps are unaffected. A top-level import in `pipeline.py` would crash `main` before the tape ran, and no Sentry check-in would go out.
  - A module that calls `sys.exit` while importing raises `SystemExit`, which passes through `run_steps` (above). `ml/src/takeit_drift_monitor.py` has such a fallback (`except ImportError: sys.exit(1)`); phase 3 removes it when it registers that step.
  - Phases 3 and 4 register their steps with `lazy_step`, or with phase 3's `lazy_group_step` (its Task 10), which keeps the same import isolation.

**The budget table (one place for all phases).** Every step's `min_seconds` is a named constant in `nightly/src/constants.py`. Phases 4 and 3 restate the rows they add in their own text and change nothing else here. Reserve logic is unchanged.

| Constant | Value (s) | Step(s) | Phase | Reserved (s) | Tape day fetched inside it |
|---|---|---|---|---|---|
| `ENRICH_DAY_BUDGET_SECONDS` | 900, or 3 × the slowest local day (Task 6) if larger, **never above 1,800** | `enrich-outcomes` | 2 | 900–1,800 | once per work day, up to `FETCH_DEADLINE_SECONDS` (600) |
| `OUTCOME_CHECK_BUDGET_SECONDS` | 300 | `outcome-check` | 2 | 300 | none |
| `REFIT_BUDGET_SECONDS` | 1,800 | `lottery-refit` | 4 | 1,800 | none |
| `RESEARCH_DAY_BUDGET_SECONDS` | 900 | `research-derive` | 3 | 900 | once per stale day, up to 600 of the 900 |
| `REPORT_BUDGET_SECONDS` | 300 | eight report-family steps | 3 | 2,400 | none |
| `LARGE_REPORT_BUDGET_SECONDS` | 600 | two large reports | 3 | 1,200 | none |

- **Reserve:** 7,500 s once all three phases ship, with enrich at its 900 floor; 8,400 s with enrich at the cap.
- **Two downloads per day (owner, 2026-11-06).** `enrich-outcomes` fetches each work day and `research-derive` fetches each stale day again, with its own reader. The worst case is 600 s each, 20 minutes in all. R2 egress is free, so the owner accepted it over folding the two steps together.
- **The tape's share.** `run_tape` stops at `RUN_DEADLINE_SECONDS − reserve`, and starts a day only with `DAY_BUDGET_SECONDS` (3,600) of that left. So a day may start only in the first `RUN_DEADLINE_SECONDS − reserve − DAY_BUDGET_SECONDS` seconds of the run:

  | Stage | Reserve (s) | Tape deadline (s) | Window to start a day (s) |
  |---|---|---|---|
  | Phase 1 today | 0 | 18,000 | 14,400 |
  | After phase 2 | 1,200–2,100 | 15,900–16,800 | 12,300–13,200 |
  | After phase 4 | 3,000–3,900 | 14,100–15,000 | 10,500–11,400 |
  | After phase 3 | 7,500–8,400 | 9,600–10,500 | 6,000–6,900 |

  The tape still plans up to 30 days (`CATCHUP_MAX_DAYS`). How many start in one night is the window divided by the seconds one day takes, and a long backlog now takes more nights than before. Task 14 puts the window in the README and `CLAUDE.md`, and Task 15 Step 4 adds the measured seconds per day.
- **Tests assert on the constants, never on a hard-coded sum.** Task 11's `test_deadline_constants_bound_the_run` reads the real `STEPS`: `reserve_seconds(STEPS) + 2 * DAY_BUDGET_SECONDS <= RUN_DEADLINE_SECONDS`, so at least two tape days still fit a night. It covers every phase's steps with no edit (at the cap, 8,400 + 7,200 = 15,600 ≤ 18,000). Task 13 pins `ENRICH_DAY_BUDGET_SECONDS <= 1_800`. Phases 4 and 3 assert each step's `min_seconds` is its named constant.

### D3 — the shared tape reader: `scripts/_tape_reader.py`

```python
class TapeReadError(Exception): ...                  # messages: key, byte counts, a fixed phrase

class TapeReader:                                    # single-threaded: one per thread, never shared
    def __init__(self, *, endpoint_url: str, access_key_id: str, secret_access_key: str,
                 bucket: str, cache_dir: Path) -> None
    @classmethod
    def from_env(cls, cache_dir: Path) -> "TapeReader"   # R2_ENDPOINT_URL, R2_ACCESS_KEY_ID,
                                                         # R2_SECRET_ACCESS_KEY, R2_BUCKET_FULLTAPE
    cache_dir: Path                                      # read-only property
    def landed_days(self) -> set[date]                   # keys matching ^fulltape/(\d{4}-\d{2}-\d{2})-fulltape\.parquet$
    def path(self, day: date) -> Path                    # cache_dir / f"{day}-fulltape.parquet"
    def fetch_day(self, day: date, deadline: float | None = None) -> Path | None   # None = no object
    def release(self, day: date) -> None                 # delete the cached file, missing_ok
    def close(self) -> None                              # delete every file this reader cached
    def __enter__(self) -> "TapeReader"; def __exit__(self, *exc) -> None   # close()
```

- **Location.** It lives in `scripts/`, not `ml/src/utils/r2.py`:
  - every consumer (enrichment now; `analyze.py`, `whale_plots.py` and the research scripts in phase 3) runs from `scripts/` or `ml/src`, locally and in the image;
  - `scripts/` already shares flat `_`-prefixed helpers;
  - importing `utils.r2` runs `ml/src/utils/__init__.py`, which pulls scipy and sqlalchemy;
  - `ml/src/utils/r2.py` has no callers.
- **Fetching:**
  - one boto3 client (`verify=True`, s3v4, standard retries `max_attempts=5`, connect 10 s, read 60 s);
  - streamed with `get_object` (never `download_file`/`upload_file`) to `<path>.part`;
  - the byte count is checked against `ContentLength`, then the file is renamed;
  - `.part` is removed on any error;
  - the whole GET is retried up to `FETCH_ATTEMPTS` on body/stream/transport errors.
  - The reader also sets `warnings.filterwarnings("error", category=urllib3.exceptions.InsecureRequestWarning)` (memory `boto3-shared-client-unverified-tls`).
- **Reading:**
  - callers read the returned path themselves: pandas and pyarrow in the enrichment scripts (which handle the 42- and 52-column layouts), DuckDB in phase 3;
  - they `release` each day when done and `close` the reader at the end;
  - there are no `scan_day`/`scan_days` methods. Nothing in phases 2–4 calls them, and without them the reader imports no polars.

### D4 — DB access

- **Railway:** `DATABASE_URL = ${{uw-stream.DATABASE_URL}}`. That URL is Neon's pooled form: `.env.local`'s `DATABASE_URL` host carries `-pooler`, checked without printing it.
- **Why a direct connection:** Neon's pooler rejects startup `options` (`sidecar/src/db.py:50`), and the job needs a statement timeout. So `resources.direct_dsn` strips `-pooler` from the first host label (Neon's documented naming; same credentials), and `connect_db` connects directly with:
  - `connect_timeout=DB_CONNECT_TIMEOUT_SECONDS`;
  - `application_name="nightly"`;
  - `options="-c statement_timeout=<DB_STATEMENT_TIMEOUT_MS>"`;
  - TCP keepalives 30/10/5;
  - `autocommit=True`;
  - `error_detail=False` on the retry helper (Task 2b), so its `[retry]` line names the exception class only. A psycopg2 message can carry the Neon host, and the service's log rule (`main.py` docstring) allows class names only.
- **Child processes (phase 3):** build `PGOPTIONS` and `PGCONNECT_TIMEOUT` from `DB_STATEMENT_TIMEOUT_MS` and `DB_CONNECT_TIMEOUT_SECONDS` (Task 8), not from literals.
- **Writes:**
  - batched at most 500 rows per statement (`execute_values(..., page_size=500, fetch=True)`, `ANY(%s::bigint[])` chunks of 500) (R5);
  - each is conditional on the target still NULL and untagged, with counts taken from `RETURNING` (R6).
- **Env vars (R7):** `DATABASE_URL` is the only new one. It goes into `config.py`, `nightly/README.md` and `CLAUDE.md`. `env.ts` and `.env.example` already carry it.

---

## Facts measured for this plan (read-only, 2026-10-29 evening)

- **`lottery_finder_fires` (1,019,038 rows, 2.47 GB):**
  - pending (`enriched_at IS NULL`): 252,212 — 06-25 → 10-21, plus 2 on 10-22 and 2 on 10-27;
  - done-but-empty: 26,836 — 05-05 → 06-25, of which 131 fall before 06-12, on 16 days;
  - outcome work from 06-12 on: 278,917 rows;
  - NULL `realized_flow_inversion_pct`: 274,366 rows on 65 days from 06-12 on, and 188,289 rows on 111 days before 06-12 (counted 10-29, before the 11-06 reset below);
  - the six outcome columns are always NULL or set together (0 mismatches);
  - every row enriched since 10-22 (30,173) was a fire at most 3 days old, so the crons wrote them and no script has.
- **`silent_boom_alerts` (76,814 rows):**
  - 8,989 done-but-empty, 06-12 → 10-22;
  - 0 pending;
  - 0 rows with `peak_ceiling_pct` set and `realized_trail30_10_pct` NULL.
- **Work days:** the union from 06-12 on is 65 days. With the pre-06-12 inversion days it is about 176.
- **R2:**
  - 161 days landed, 01-02 → 10-28;
  - missing: 05-29, 06-16 → 06-18, 06-22 → 07-02, 07-06 → 08-19 (landing on the 10-30 and 10-31 runs), and 10-29;
  - median object since 06-12 is 1.09 GB, the largest 1.74 GB;
  - the R2 listing raised 0 `InsecureRequestWarning`s.
- **Net flow:** 100% of fire ticker-days, June–October, have `net_flow_per_ticker_history` rows.
- **The 100%-NULL rule on history (tune-before-ship):**
  - **Lottery:** 176 days with fires. 56 had 0 outcomes, and all 56 fall inside 06-17 → 10-21. On the other days the lowest share was 99.26% (05-20), p05 99.82%.
  - **Silent boom:** 60 days with 0 outcomes, all inside 06-12 → 10-22. Every other day had 100%.
  - **So** the rule flags exactly the known bug days and no good day.
  - **Inversion share:** p50 79.5% (about 20% is legitimately undefined), so the job raises no inversion alert.

**Added 2026-11-06 (cross-phase review and the inversion reset):**

- **The cron's flow inversions were corrupt, from a ×100 error.**
  - `deriveMid` in `api/_lib/option-intraday.ts` dropped UW's ×100 multiplier on its first branch (bug since `a6ecb235`, 05-05).
  - The fix shipped 2026-11-05 (`c36ccac6`, `f387c743`).
  - The cron's REST path wrote bad values in May and June, and again from 10-23 (its 4-day lookback reaches back to 10-20).
- **The bad rows are found by provenance, not by value.**
  - A fire is in the set when its (`option_chain_id`, `date`) has an `ok` row in `option_intraday_nbbo_fetches`: 111,645 rows (May 20,898; June 11,962; October 45,478; November 33,307).
  - All of them have a cache, so all can be recomputed without UW.
  - A value test misses them: a true −95% exit reads about +400% under the ×100 error, and 10-20/10-21 have no `peak_ceiling_pct` to compare with.
- **Nothing live scores, tiers or alerts from `realized_flow_inversion_pct`.** Its readers are the Lottery Finder flow-inversion chip and the shadow `refit-lottery-ticker-stats` cron (`PROMOTE_TO_LIVE=false`).
- **The reset is done, outside every plan (2026-11-06).**
  - `realized_flow_inversion_pct` is NULL on those 111,645 rows.
  - A copy is in R2 at `backups/lottery-flow-inversion/2026-11-06-x100-reset.parquet` (columns `id`, `date`, `option_chain_id`, old value as text).
  - The reset touched no tag column: they don't exist until Task 1.
  - The tape pass (Task 3) fills every row with `realized_flow_inversion_pct IS NULL`, so its backfill refills the reset rows. No task here resets anything.
  - While a row is NULL, the Lottery Finder chip shows `realized_eod_pct` and `lottery_finder_fires_with_outcome.outcome_pct` coalesces to it.
- **Cron-written values still in the table** are the fixed cron's (the last four sessions, written after the reset) and have a NULL `inversion_source`. Task 6 Step 5 checks them against the tape before Task 7 deletes the cron's inversion pass.
- **R2 on 11-05:** 212 tape objects, 01-02 → 11-04, equal to the NYSE trading days in that range. 05-29 landed on 10-31, so the "missing" list above is out of date.
- **The anchor-leg flag is backfilled:** `anchor_leg_kind` is set on 1,064,394 of 1,064,396 fires (11-05).

## Global Constraints

- Phase 1's Global Constraints still hold. In particular: no market data in logs or Sentry, Python 3.12, nightly ruff `>=0.17,<0.18` at line length 100, and constants rather than env vars (R7).
- **At most 5 files per task** (owner rule).
- **Commit gate:** `.githooks/pre-commit` blocks every Claude commit, Python-only ones included, unless `npm run review` passed on the staged tree. Every task ends with its Python suite and ruff, then `npm run review`, then the commit.
- **Python environments:**
  - **nightly and the reader tests:** `uv venv nightly/.venv --python 3.12` and `uv pip install --python nightly/.venv -r nightly/requirements-dev.txt`. The pandas/psycopg2 stack joins that file in Task 9.
  - **The two enrichment scripts' tests:** `ml/.venv/Scripts/python -m pytest …`, as their docstrings say. After Task 9, CI also runs them in the nightly env.
  - **Ruff on `scripts/` files:** `python -m ruff check --isolated --select E4,E7,E9,F <files>`. Never `ruff format` them: they use single quotes.
- **Provenance vocabulary:**

  | Column | Allowed values | Written by |
  |---|---|---|
  | `outcome_source` | `fulltape`, `bot_eod`, `ws_cron` | scripts from R2 or a local fulltape dir; scripts from a local Bot-EOD dir; the two Vercel enrich crons |
  | `inversion_source` (lottery only) | `fulltape`, `bot_eod` | the same scripts. There is no `uw_intraday` value: Task 7 deletes the lottery cron's inversion pass instead of tagging it |
  | `outcome_version`, `inversion_version` | SMALLINT > 0, NOT NULL exactly when the source is | `1` everywhere in this phase |

  - A NULL source means the row was written before this migration. For `realized_flow_inversion_pct` that is a legacy value: parquet-built (January to June) or the fixed cron's last four sessions. It tells those apart from tape-written values.
  - A tape writer also tags the rows it tried but could not price, leaving their outcomes NULL, so "outcome NULL with a source" means tried, not pending. When such a row already holds another writer's outcome, the full tape keeps it and sets only `outcome_tape_version` (owner, 2026-11-06: "keep the feed's values for now"); `ws_cron` with that marker means feed values the tape could not confirm.
- **The work predicates** (written once, in the scripts):
  - **outcome work (`--select all`, the nightly's):** for `fulltape`, `outcome_tape_version IS NULL OR outcome_tape_version < OUTCOME_VERSION` (migration #202, Task 1b): the full tape has the final say (owner, 2026-11-06) and re-derives cron-written and untagged outcomes, history included, never one it examined at the current `OUTCOME_VERSION`. For `bot_eod`, `peak_ceiling_pct IS NULL AND outcome_source IS NULL` (fill only). The crons write only `enriched_at IS NULL`, so they never replace the tape;
  - **inversion work (lottery):** `realized_flow_inversion_pct IS NULL AND inversion_source IS NULL`, and matched-side net flow exists for the ticker's UTC day;
  - **bounds:** `date BETWEEN TAPE_START AND last_session`, processed newest first.
- **Every print in the day's tape counts** (owner, 10-28: no post-close cutoff). The scripts' reads keep their current filters: canceled prints and prices ≤ 0 are dropped, and nothing else.
- **Pass 3 never writes `lottery_ticker_stats`.** The nightly never calls it.
- **Push and deploy order:**
  - **P0:** Push window for every push that touches a Railway watch path: **after 15:00 CT and outside 07:15–12:30 UTC** (D1). Before Task 15 sets the watch paths, a `scripts/` push redeploys nothing.
  - **P1:** Task 1 is pushed as soon as it passes; it has no runtime effect. Phase 4's migration waits for it to be on origin/main (Task 1).
  - **P2:** Tasks 2–5, including 2b (`scripts/`, Makefile) are pushed as each passes. Vercel ignores `scripts/`, and nightly doesn't watch them yet.
  - **P3:** Tasks 7 and 7b (live crons, and the module the cron stops importing) are pushed only after Task 6 Step 2 has verified the columns on prod and Task 6 Step 5 (the cron inversion check) has passed.
  - **P4:** Tasks 8–14 (`nightly/`, `.dockerignore`, `ci.yml`, docs) stay local until Task 15. They are pushed after the Railway settings and variable are in place, in the P0 window.
  - **P5:** No tape-enrichment write reaches prod before Task 6's dry-run gate passes.

## Review Focus

1. **Legacy (42-column) and new (52-column) tape days must enrich identically.** Legacy days may carry decimal128 numerics, a bool `canceled` and no new columns.
   Pinned by:
   - `test_lottery_legacy_and_new_layouts_agree` (Task 3);
   - `test_sb_legacy_and_new_layouts_agree` (Task 4).
2. **The live cron and the job writing the same fire.** If the cron writes a fire between the job's SELECT and its UPDATE, the job still replaces it when the tape prices it (the tape has the final say), and keeps it when the tape can't (the stamp decides from the row, not the fetch). If the job writes first, the cron's `enriched_at IS NULL` guard makes its UPDATE a no-op. A second tape run on the same fire changes nothing. Every count comes from what the database returned.
   Pinned by:
   - `test_written_count_comes_from_returning` (Tasks 3, 4);
   - `test_tape_replaces_a_cron_outcome` and `test_unpriced_fire_with_an_outcome_keeps_it` (Task 3c);
   - the conditional-predicate assertions (Tasks 3, 4, 7).
3. **The work set must shrink to zero.** Otherwise one day is re-downloaded every night forever. A fire the tape cannot price (no chain, no print at or after entry) is tagged once. A fire whose net flow is missing is left for later and not selected until the flow exists.
   Pinned by:
   - `test_unpriced_fires_are_tagged_once`;
   - `test_flow_missing_is_left_and_not_selected` (Task 3);
   - `test_sb_unpriced_alerts_are_tagged_once` (Task 4).
4. **The tape job raises before its first day, or uses the whole night.** Steps still run in their reserved time and the outcome check still alerts.
   Pinned by:
   - `test_steps_run_when_run_tape_raises`;
   - `test_tape_deadline_reserves_step_minimums` (Task 11).
5. **A day with fires whose tape isn't in R2** (not landed yet, or marked unavailable) is counted as waiting. It is never tagged, and it is alerted only through the last-sessions check.
   Pinned by:
   - `test_day_not_landed_waits_and_is_untouched` (Task 13);
   - `test_r2_day_missing_is_a_skip` (Task 5).

---

### Task 1: Provenance migration

**Skills:** `postgres-pro`, `test-master`. Follow `.claude/agents/db-migration-specialist.md` for the `db.test.ts` sequence.

**Files:**
- Modify: `api/_lib/db-migrations.ts` (append), `api/__tests__/db.test.ts`
- Create: `api/__tests__/outcome-provenance-pglite.test.ts`

**Interfaces:**
- Produces: migration `#N`, where N is max id + 1 on origin/main. That is 201 (the top id is 200 at `06cad43f`, 2026-11-06).
  - **Ordering with phase 4:** this phase owns 201 and 202 (Task 1b). Phase 4's migration (its Task 3) is 203 and is pushed only after this task is on origin/main. Ids are only a convention, so re-read the top id just before the push. If another session took 201, use the next free id and tell the main session, so phase 4's number follows.
  - `lottery_finder_fires` gains `outcome_source TEXT`, `outcome_version SMALLINT`, `inversion_source TEXT` and `inversion_version SMALLINT`, plus checks `lottery_finder_fires_outcome_source_chk` and `lottery_finder_fires_inversion_source_chk`.
  - `silent_boom_alerts` gains `outcome_source TEXT` and `outcome_version SMALLINT`, plus check `silent_boom_alerts_outcome_source_chk`.
  - Each check is `(src IN (<vocabulary>) AND ver > 0) OR (src IS NULL AND ver IS NULL)`, added `NOT VALID` (no scan of existing rows).

**SQL shape:**
- `statements: (sql) => [...]`, with `` sql`SET LOCAL lock_timeout = '5s'` `` first.
- Then one `ALTER TABLE` per table:
  - `ADD COLUMN IF NOT EXISTS` for each column;
  - `DROP CONSTRAINT IF EXISTS <chk>, ADD CONSTRAINT <chk> CHECK (...) NOT VALID`, so a re-run is a no-op.
- No index, no default, no data backfill.
- The description says:
  - what each value means (Global Constraints);
  - that NULL means written before this migration;
  - that a tape writer tags rows it tried but could not price;
  - that the checks are NOT VALID on purpose;
  - and it cites the spec.

- [ ] **Step 1: Write the failing PGlite test** `outcome-provenance-pglite.test.ts`. It applies the real migrations that create the two tables (`applyMigration`; find the ids by `CREATE TABLE IF NOT EXISTS lottery_finder_fires` and `silent_boom_alerts`) and inserts one row in each. Tests:
  - `adds nullable provenance columns with no default`: `information_schema` shows text/smallint, `YES`, NULL default; four on lottery, two on silent boom.
  - `accepts every writer's tag`:
    - UPDATE succeeds for `('fulltape',1)`, `('bot_eod',1)` and `('ws_cron',1)` on `outcome_*` of both tables;
    - and for `('fulltape',1)` and `('bot_eod',1)` on `inversion_*`.
  - `rejects an unknown tag, a lone version and a zero version`: `('tape',1)`, `(NULL,1)`, `('fulltape',NULL)` and `('fulltape',0)` each throw a check violation. On `inversion_*`, `('ws_cron',1)` and `('uw_intraday',1)` throw too: no writer uses them.
  - `keeps existing rows NULL and re-runs as a no-op`: apply twice; both columns are still NULL on the seeded rows.
  - `adds the checks NOT VALID`: `pg_constraint.convalidated = false` for all three names.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/outcome-provenance-pglite.test.ts`. Expected: FAIL (no migration N).
- [ ] **Step 3:** Append migration N to `MIGRATIONS`. Update `db.test.ts`:
  - applied-ids mock `{ id: N }`;
  - expected list `'#N: <description>'`;
  - `mockSql` count +4 (SET, 2 ALTERs, INSERT);
  - `mockSql.transaction` count +1;
  - extend the breakdown comments above both totals (CLAUDE.md "DB Migrations": the one above the `mockSql.transaction` total names the top migration id).
- [ ] **Step 4:** Run `npx vitest run api/__tests__/outcome-provenance-pglite.test.ts api/__tests__/db.test.ts`. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`. Expected: green.
- [ ] **Step 6:** Commit `feat(db): Record how each fire's outcomes were made`, then push (P1). Check the top id on origin/main first (see Interfaces).

### Task 1b: Migration #202, the Full Tape examination marker (added 2026-11-06, owner decision)

`lottery_finder_fires` and `silent_boom_alerts` gain `outcome_tape_version SMALLINT` (nullable; CHECK `IS NULL OR > 0`, NOT VALID; no default, index or backfill): the version of the Full Tape outcome pass that examined the row. The fulltape writer sets it on every row it examines; bot_eod and the crons never do. It lets the tape keep a feed value it can't price without re-reading that day every night. Tested on PGlite in `outcome-provenance-pglite.test.ts`; `db.test.ts` counts updated. Phase 4's migration moves to #203. Pushed as soon as it passes (P1).

### Task 2: Shared tape reader

**Skills:** `r2-storage`.

**Files:**
- Create: `scripts/_tape_reader.py`, `scripts/test_tape_reader.py`

**Interfaces:**
- Produces: D3's API, verbatim.
- Module constants:

  | Name | Value | Why |
  |---|---|---|
  | `FETCH_CHUNK_BYTES` | `8 * 2**20` | |
  | `FETCH_ATTEMPTS` | `3` | |
  | `FETCH_DEADLINE_SECONDS` | `600` | The 1.74 GB max needs ≥ 2.9 MB/s |
  | `FETCH_DISK_HEADROOM_BYTES` | `2 * 2**30` | Refuse a fetch unless free disk ≥ object size + headroom |

- [ ] **Step 1: Write the failing tests** in `scripts/test_tape_reader.py`. Start with `pytest.importorskip("moto")`, so the ml venv skips it. Use `mock_aws` and one bucket.
  - `test_landed_days_reads_only_tape_keys`: a legacy object, `gexbot-eod/SPX/2026-10-28.zip`, `fulltape/_unavailable/2026-05-29.json`, `fulltape/_superseded/2026-10-20-x.parquet` and `fulltape/notes.txt` → only the tape day.
  - `test_fetch_day_writes_atomically_and_checks_size`: the file equals the object; no `.part` remains.
  - `test_fetch_missing_day_returns_none`.
  - `test_short_body_retries_then_raises_and_leaves_nothing`:
    - the body is patched to drop the last chunk;
    - `get_object` is called exactly `FETCH_ATTEMPTS` times;
    - it raises `TapeReadError`;
    - no file and no `.part` remain;
    - `str(err)` has no credential.
  - `test_fetch_deadline_raises`: `_tape_reader.time.monotonic` jumps past the deadline after one chunk.
  - `test_low_disk_refuses_before_reading`: `_tape_reader.disk_usage` is patched below size + headroom.
  - `test_release_and_close_remove_cached_files`.
  - `test_from_env_names_the_missing_var`: the message contains `R2_BUCKET_FULLTAPE` and no other env value.
  - `test_one_client_and_no_transfer_threads`: `boto3.client` is called once per reader; `download_file` is never called (patched to raise).
- [ ] **Step 2:** Run `nightly/.venv/Scripts/python -m pytest -q scripts/test_tape_reader.py`. Expected: FAIL (no module).
- [ ] **Step 3:** Implement `scripts/_tape_reader.py`.
  - The module docstring states the single-thread rule and that it never logs keys' contents or credentials.
  - Logging goes through `logging.getLogger(__name__)`: key, bytes, seconds.
- [ ] **Step 4:** Run the tests, plus `python -m ruff check --isolated --select E4,E7,E9,F scripts/_tape_reader.py scripts/test_tape_reader.py`. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(scripts): Add one tape reader for the R2 Full Tape lake` and push (P2).

### Task 2b: Two small shared helpers — an optional env file and a quiet retry log

**Skills:** `test-master`, `secrets-management`.

**Files:**
- Modify: `scripts/_cli_paths.py`, `scripts/test_cli_paths.py`, `scripts/_pipeline_retry.py`, `scripts/test_pipeline_retry.py`

**Interfaces:**
- Produces, in `_cli_paths`: `load_env_file(path: Path) -> None`.
  - For each line that matches `^([A-Z_][A-Z0-9_]*)=(.*)$` after `strip()`, it calls `os.environ.setdefault(KEY, value.strip('"').strip("'"))`. That is the rule both enrichment scripts use today.
  - A missing file is a no-op, not a `SystemExit`. It reads UTF-8.
  - Tasks 3–4 switch the two scripts' `load_env` to it. Phase 3's scripts call it too, so phase 3 touches no watch path for this.
- Produces, in `_pipeline_retry`: `retry_call(..., error_detail: bool = True)` and `connect_with_retry(..., error_detail: bool = True, **connect_kwargs)`.
  - With `error_detail=False` the `[retry]` line on stderr carries `type(exc).__name__` and no message. The default keeps today's text, so local runs print what they printed.
  - The last exception still propagates unchanged. `connect_db` (Task 8) passes `False`: a psycopg2 message can carry the Neon host, and the service logs class names only.

- [ ] **Step 1: Write the failing tests.**
  - In `scripts/test_cli_paths.py`:
    - `test_load_env_file_sets_missing_vars_and_never_overrides`;
    - `test_load_env_file_strips_quotes_and_skips_non_assignments`;
    - `test_load_env_file_missing_path_is_a_noop`.
  - In `scripts/test_pipeline_retry.py`:
    - `test_retry_log_keeps_the_message_by_default`;
    - `test_retry_log_names_only_the_class_without_error_detail`: the exception message holds a marker host string; the captured stderr has the class name and not the marker;
    - `test_connect_with_retry_hides_the_error_text_when_asked`: a patched `psycopg2.connect` raises `OperationalError` with a marker host; the retry line has no marker.
- [ ] **Step 2:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_cli_paths.py scripts/test_pipeline_retry.py`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command, plus `python -m ruff check --isolated --select E4,E7,E9,F scripts/_cli_paths.py scripts/_pipeline_retry.py scripts/test_cli_paths.py scripts/test_pipeline_retry.py`. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(scripts): Make the env file optional and let retry logs hide error text` and push (P2).

### Task 3: Lottery enrichment — selection, provenance, conditional writes, shadow pass 3

**Skills:** `postgres-pro`, `pandas-pro`.

**Files:**
- Modify: `scripts/enrich_lottery_outcomes.py`, `scripts/test_enrich_missing_archive.py` (fakes only, if the write path's shape changes), `Makefile` (drop `WRITE_DB=1` and its comment lines at the `enrich` target)
- Create: `scripts/test_enrich_provenance.py`

**Interfaces:**
- Produces, in `enrich_lottery_outcomes` (existing public names keep their signatures unless listed; `feature_audit.py`, `flow_inversion_timing.py` and `recompute_peak_from_parquet.py` import from it):

  ```python
  Select = Literal['pending', 'empty', 'all']
  ARCHIVE_SOURCES = {'trades': 'bot_eod', 'fulltape': 'fulltape'}
  OUTCOME_VERSION = 1
  INVERSION_VERSION = 1
  def configure_archive(parquet_dir: Path, parquet_format: str) -> None   # sets PARQUET_DIR, PARQUET_FILE_PATTERN, the source tag
  def load_env() -> None                                                   # _cli_paths.load_env_file(ENV_FILE) (Task 2b): .env.local optional
  def fetch_unenriched(conn, target_date: str, select: Select = 'pending') -> list[Fire]
  def fetch_flow_unfilled(conn, target_date: str) -> list[FlowFire]        # + AND inversion_source IS NULL
  def list_work_dates(conn, select: Select, since: str | None = None, through: str | None = None) -> list[str]
  def update_fires(conn, updates: list[tuple], source: str) -> int         # rows written (RETURNING)
  def stamp_no_outcome(conn, fire_ids: list[int], source: str) -> int      # replaces mark_no_post_ticks
  def update_flow_inversion(conn, updates: list[tuple[int, float]], source: str) -> int
  def stamp_inversion_undefined(conn, fire_ids: list[int], source: str) -> int
  @dataclass class FlowPassResult: written: int; stamped_undefined: int; input_missing: int
  def run_flow_inversion_pass(conn, target_date: str, fires: list[FlowFire], source: str, dry_run: bool = False) -> FlowPassResult
  @dataclass class DayResult:  # existing three fields kept
      archive_missing: bool = False; fires_written: int = 0; flow_written: int = 0
      fires_selected: int = 0; outcomes_written: int = 0; stamped_no_outcome: int = 0
      flow_selected: int = 0; flow_stamped_undefined: int = 0; flow_input_missing: int = 0
  def enrich_one_date(conn, target_date: str, select: Select = 'pending', dry_run: bool = False) -> DayResult
  def refit_ticker_inversion_stats(conn, sim_csv_path: Path | None = None) -> None   # write_db removed
  ```

**Rules:**
- **Superseded for fulltape by Task 3c** (owner, 2026-11-06): the fulltape work set and guards use `outcome_tape_version`; the stamp decides per row and keeps another writer's value; counts come from RETURNING. The rules below still hold for bot_eod.
- **Selects:**
  - `pending`: `enriched_at IS NULL` (today's behaviour);
  - `empty`: `enriched_at IS NOT NULL AND peak_ceiling_pct IS NULL AND outcome_source IS NULL`;
  - `all`: `peak_ceiling_pct IS NULL AND outcome_source IS NULL`.
- **`list_work_dates`:**
  - for `pending`/`empty`/`all`, it returns the outcome-work dates of that select in `[since, through]` (both optional), ascending;
  - for `all` it also unions the inversion-work dates. That SQL takes `SELECT DISTINCT date, underlying_symbol, option_type` of the inversion-work rows, then requires `EXISTS` of a `net_flow_per_ticker_history` row:
    - for that ticker;
    - on the same UTC day as `load_matched_flow` reads (`ts >= date::timestamp AT TIME ZONE 'UTC'`, `< (date + 1)…`);
    - with `CASE WHEN option_type = 'C' THEN net_call_prem ELSE net_put_prem END IS NOT NULL`.
- **Every write is conditional and tagged:**
  - **`update_fires`:** `… WHERE f.id = v.id AND f.peak_ceiling_pct IS NULL AND f.outcome_source IS NULL RETURNING f.id`. The tag and version ride as VALUES columns `(%s::bigint, …, %s::text, %s::smallint)`, because `execute_values` allows a single `%s`. `page_size=500, fetch=True`.
  - **`stamp_no_outcome`:** `SET enriched_at = NOW(), outcome_source = %s, outcome_version = %s WHERE id = ANY(%s::bigint[]) AND peak_ceiling_pct IS NULL AND outcome_source IS NULL`, in id chunks of 500, counted by `rowcount`. A count below the ids is normal: the cron got there first. It drops the old stderr WARN.
  - **Inversion:** `update_flow_inversion` and `stamp_inversion_undefined` mirror those two on `realized_flow_inversion_pct` / `inversion_source` / `inversion_version`.
- **Main pass:** a fire with no chain in the day's tape, or no print at or after entry, is tagged through `stamp_no_outcome`. The no-chain case is new (it used to stay pending forever).
- **Flow pass:**
  - **left untagged, counted `input_missing`:** a fire whose `(ticker, side)` flow list is empty. It stays NULL until the flow row exists. If none ever arrives it stays NULL for good, and the chip and `lottery_finder_fires_with_outcome` use `realized_eod_pct` for it;
  - **tagged undefined:** every other `None` or non-finite exit (`no_chain`, `no_post_trigger_prices`, `insufficient_flow_data`, `flat_flow_no_peak`, `no_flow_peak_detected`);
  - **written:** finite exits.
- **`dry_run=True`:** no UPDATE runs, and the counts are what would be written.
- **Pass 3:**
  - `refit_ticker_inversion_stats` keeps its computation, its `[ticker-quality]` count lines and the optional CSV;
  - its `UPDATE lottery_ticker_stats` branch is deleted;
  - `main` stops reading `WRITE_DB`.

- [ ] **Step 1: Write the failing tests** in `scripts/test_enrich_provenance.py`.
  - Use the `FakeCursor`/`execute_values` boundary pattern of `test_enrich_missing_archive.py`.
  - Add a fixture writer for two parquet layouts of the same prints:
    - **legacy:** `price`/`nbbo_*` as `decimal128(18,4)`, `canceled` bool, core columns only;
    - **new:** Float64, Boolean `canceled`, plus `trading_hours`, `exchange_id` Utf8.
  - Tests:
    - `test_select_predicates`: the SQL text per select contains exactly the predicates above.
    - `test_outcome_update_is_conditional_and_tagged`:
      - the SQL contains `f.peak_ceiling_pct IS NULL`, `f.outcome_source IS NULL` and `RETURNING f.id`;
      - the rows end with `('fulltape', 1)` after `configure_archive(dir, 'fulltape')`, and with `('bot_eod', 1)` after `'trades'`.
    - `test_written_count_comes_from_returning`: the fake returns 2 of 3 ids, so `outcomes_written == 2` and nothing raises.
    - `test_unpriced_fires_are_tagged_once`: one fire whose chain is absent and one whose only print is before entry → one `stamp_no_outcome` with both ids; `stamped_no_outcome == 2`.
    - `test_flow_missing_is_left_and_not_selected`: a fire with no matched-side flow is in no UPDATE (`flow_input_missing == 1`), and the `list_work_dates('all')` SQL carries the side-aware `EXISTS`.
    - `test_flow_undefined_is_tagged` (flat flow) and `test_flow_value_written_with_tag`.
    - `test_lottery_legacy_and_new_layouts_agree`: both layouts give identical outcome tuples and `DayResult` counts.
    - `test_dry_run_writes_nothing`: no `execute_values` and no UPDATE; the counts equal a write run's.
    - `test_load_env_without_file_uses_the_process_env`: `ENV_FILE` points at a missing path; no `SystemExit`.
    - `test_pass3_never_writes_live_stats`: with `WRITE_DB=1` set, `refit_ticker_inversion_stats(fake_conn)` issues no statement containing `lottery_ticker_stats` other than its SELECTs.
- [ ] **Step 2:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_provenance.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Grep every caller of `mark_no_post_ticks`, `update_fires`, `update_flow_inversion`, `run_flow_inversion_pass`, `refit_ticker_inversion_stats` and `fetch_unenriched` across `scripts/`, `ml/` and the Makefile, and update each one.
- [ ] **Step 4:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_provenance.py scripts/test_enrich_missing_archive.py scripts/test_enrich_lottery_outcomes.py` and `cd ml && ../ml/.venv/Scripts/python -m pytest -q tests/test_lottery_ticker_quality.py`, plus the isolated ruff on the touched `.py` files. Expected: PASS, clean.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(enrich): Tag lottery outcomes by source and never overwrite one` and push (P2).

### Task 4: Silent-boom enrichment — the same rules

**Skills:** `postgres-pro`, `pandas-pro`.

**Files:**
- Modify: `scripts/enrich_silent_boom_outcomes.py`, `scripts/enrich_silent_boom_outcomes_fulltape.py` (passes `source='fulltape'`), `scripts/test_enrich_provenance.py`, `scripts/test_enrich_missing_archive.py` (fakes only, if needed)

**Interfaces:**
- Consumes: Task 3's `Select` vocabulary, defined again here (the two scripts don't import each other).
- Produces, in `enrich_silent_boom_outcomes`:

  ```python
  Select = Literal['pending', 'empty', 'all']
  ARCHIVE_SOURCES = {'trades': 'bot_eod', 'fulltape': 'fulltape'}
  OUTCOME_VERSION = 1
  def configure_archive(parquet_dir: Path, parquet_format: str) -> None   # replaces the hard-coded '-trades.parquet'
  def day_archive_path(target_date: str) -> Path
  def load_env() -> None                                                   # _cli_paths.load_env_file(ENV_FILE), as Task 3
  def fetch_unenriched(conn, target_date: str, backfill_mode: bool = False, select: Select = 'pending') -> list[dict]
  def list_work_dates(conn, select: Select, since: str | None = None, through: str | None = None) -> list[str]
  def update_outcomes(conn, updates: list[tuple], source: str) -> int     # conditional, RETURNING
  def stamp_no_outcome(conn, alert_ids: list[int], source: str) -> int
  @dataclass class DayResult: archive_missing: bool = False; alerts_selected: int = 0; outcomes_written: int = 0; stamped_no_outcome: int = 0
  def enrich_one_date(conn, target_date: str, select: Select = 'pending', dry_run: bool = False, backfill_mode: bool = False) -> DayResult
  ```

**Rules:**
- **Predicates:** Task 3's, on `silent_boom_alerts`. `update_outcomes` adds `AND a.peak_ceiling_pct IS NULL AND a.outcome_source IS NULL`. `--backfill-mode` keeps its `realized_trail30_10_pct IS NULL` select; with 0 rows having peak set and trail NULL (measured), that changes nothing on prod.
- **Tagged with NULL outcomes:** an alert whose chain is absent from the tape, or for which `compute_outcomes` returns `None`.
- **`main`:** its per-day loop moves into `enrich_one_date`.
- **The sister script:** `enrich_silent_boom_outcomes_fulltape.py` keeps its own loop and passes `source='fulltape'`. Its pre-existing unused `numpy` import is not touched; mention it in the report.

- [ ] **Step 1: Add failing tests** to `scripts/test_enrich_provenance.py`:
  - `test_sb_select_predicates`;
  - `test_sb_update_is_conditional_and_tagged`;
  - `test_sb_written_count_comes_from_returning`;
  - `test_sb_unpriced_alerts_are_tagged_once`: absent chain, and entry price 0;
  - `test_sb_legacy_and_new_layouts_agree`;
  - `test_sb_dry_run_writes_nothing`;
  - `test_sb_load_env_without_file`;
  - `test_sb_fulltape_sister_tags_fulltape`.
- [ ] **Step 2:** Run them in the ml venv. Expected: FAIL.
- [ ] **Step 3:** Implement. Grep the callers of `fetch_unenriched`, `update_outcomes`, `compute_outcomes` and `load_chain_tape` across `scripts/`.
- [ ] **Step 4:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_provenance.py scripts/test_enrich_missing_archive.py scripts/test_fulltape_parquet_dir.py`, plus isolated ruff on the touched files. The only pre-existing findings allowed: the sister script's F401/E402. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(enrich): Tag silent-boom outcomes by source and never overwrite one` and push (P2).

### Task 5: Read the lake from the CLI (`--r2`, `--select`, `--dry-run`)

**Skills:** `r2-storage`.

**Files:**
- Modify: `scripts/enrich_lottery_outcomes.py`, `scripts/enrich_silent_boom_outcomes.py`, `scripts/test_enrich_missing_archive.py` (the required-flag message)
- Create: `scripts/test_enrich_r2_cli.py`

**Interfaces:**
- Consumes: `_tape_reader.TapeReader` (Task 2), `configure_archive` and `enrich_one_date` (Tasks 3–4).
- Produces: in both scripts, a required, mutually exclusive source group `--parquet-dir DIR | --r2`, plus `--select {pending,empty,all}` (default `pending`) and `--dry-run`. In the silent-boom script, `--select` other than `pending` and `--backfill-mode` are mutually exclusive.

**Behavior of `--r2`:**
- **Setup:**
  - `TapeReader.from_env(tempfile.mkdtemp(prefix='enrich-'))`, imported inside `main` only, so importers of these modules never load polars or boto3;
  - `configure_archive(reader.cache_dir, 'fulltape')`.
- **Dates:**
  - `--date`, or `--all-unenriched` → `list_work_dates(conn, select)` restricted to `reader.landed_days()`;
  - with neither, the newest landed day;
  - silent boom's `--from/--to` filter `landed_days()`.
- **Per day:** `fetch_day` → `enrich_one_date` → `release`. A `None` fetch is the existing missing-archive skip.
- **On exit:** `reader.close()`.

- [ ] **Step 1: Write the failing tests** in `scripts/test_enrich_r2_cli.py`. `TapeReader` is patched at the module boundary with a fake whose `fetch_day` writes a fixture parquet.
  - `test_source_is_required_and_exclusive`: neither flag → exit 2 naming both; both → exit 2.
  - `test_r2_mode_fetches_each_day_and_releases_it`.
  - `test_r2_day_missing_is_a_skip`: `fetch_day` returns `None` → counted missing, exit 0, no UPDATE.
  - `test_r2_latest_date_comes_from_the_lake`.
  - `test_select_and_dry_run_reach_enrich_one_date`.
  - `test_sb_backfill_mode_and_select_are_exclusive`.
  - `test_importing_the_scripts_does_not_load_the_reader`: a subprocess imports both modules, then asserts `'_tape_reader' not in sys.modules` and `'boto3' not in sys.modules`.
- [ ] **Step 2:** Run them in the ml venv. Expected: FAIL.
- [ ] **Step 3:** Implement. Update `test_parquet_dir_is_required` to assert that the argparse group message names `--parquet-dir`.
- [ ] **Step 4:** Run `ml/.venv/Scripts/python -m pytest -q scripts/test_enrich_r2_cli.py scripts/test_enrich_missing_archive.py scripts/test_enrich_provenance.py`, plus isolated ruff. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(enrich): Read the R2 tape lake from the enrich scripts` and push (P2).

### Task 6: Prod migration, probe the tape path on real data, check the cron's inversions (controller; no code)

**Skills:** `postgres-pro`, `r2-storage`. Owner answer 1 (2026-11-06) governs Step 1.

- [ ] **Step 1:** Read `SELECT max(id) FROM schema_migrations` (read-only), and list the ids on main that prod lacks. `scripts/migrate-db.ts` applies every pending id, so run Step 2 only when the pending ids are ours alone (Task 1's). If another session's migration is pending, wait for that session to apply it; don't apply it. Tell the owner the pending ids either way. Expected: #201 and #202, both this phase's.
- [ ] **Step 2:** In the 16:05–16:35 CT window (the enrich crons start 16:40 CT), from a worktree at the origin/main commit that contains Task 1, run `node --env-file=<repo>/.env.local --import tsx scripts/migrate-db.ts`. Verify:
  - `schema_migrations` has N;
  - the six columns exist;
  - `convalidated = false` on the three checks.
- [ ] **Step 3: Dry-run probes** (writes nothing; reads prod and R2) on a legacy day and a new-layout day:
  - `ml/.venv/Scripts/python scripts/enrich_lottery_outcomes.py --r2 --select all --dry-run --date 2026-06-12`, then `--date 2026-10-20`;
  - the same two runs with `scripts/enrich_silent_boom_outcomes.py`.

  Pass, for each table and day: priced share `outcomes_written / fires_selected` (or `alerts_selected`) ≥ 0.98. The history floor is 0.9926. Also:
  - record `outcomes_replaced` and `outcomes_kept` for each table and day, and report `kept` to the owner (feed values the tape could not price, kept "for now", owner 2026-11-06). No gate;
  - record the inversion counts (no gate);
  - record seconds per day (fetch, then each table);
  - `grep -c InsecureRequestWarning` on the run log = 0.

  A miss stops the plan here, for investigation (chain-id format, dtypes).
- [ ] **Step 4: Write probe on 2026-10-20.**
  - **Before** (counts only, both tables):

    ```sql
    SELECT count(*) FILTER (WHERE enriched_at IS NULL) AS pending,
           count(*) FILTER (WHERE enriched_at IS NOT NULL AND peak_ceiling_pct IS NULL) AS done_empty,
           count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL) AS with_outcome,
           count(*) FILTER (WHERE outcome_source = 'fulltape') AS tape_tagged,
           count(*) FILTER (WHERE outcome_tape_version IS NOT NULL) AS tape_examined
    FROM lottery_finder_fires WHERE date = '2026-10-20';
    ```

    Run the same on `silent_boom_alerts`, and record `SELECT max(updated_at) FROM lottery_ticker_stats`.
  - **Then** run both scripts with `--r2 --select all --date 2026-10-20`, without `--dry-run`.
  - **After:** expect every row of the day to have `outcome_tape_version` set on both tables (the tape has the final say over every row it has not examined), and `with_outcome` ≥ 0.98 × the row count. Record `outcomes_replaced` and `outcomes_kept`. `lottery_ticker_stats.max(updated_at)` must be unchanged.
  - **Re-run the dry-run** on 10-20: 0 outcome rows selected (idempotent).
- [ ] **Step 5: Cron inversion check** (moved here from phase 4's Task 10 Step 1; read-only; a scratch script under `docs/tmp/`). The tape inversion pass now exists (Task 3) and the cron's pass is still in place. The ×100 fix shipped on 11-05 and the 111,645 provenance rows were reset on 11-06 (Facts), so the only cron-written values left are the fixed cron's, on the last four sessions (`realized_flow_inversion_pct IS NOT NULL AND inversion_source IS NULL`). Check them against the tape before Task 7 deletes the pass:
  - pick the newest landed session, among the last four, that has such fires (older values are parquet-built, not the cron's). If none does (the cron's slots come after the close and the tape lands the next morning), wait for the next landing and repeat;
  - `TapeReader.fetch_day` that session. Compute each such fire's tape inversion with `simulate_flow_inversion` and `load_matched_flow` in `scripts/enrich_lottery_outcomes.py` (the inputs `run_flow_inversion_pass` uses). Write nothing;
  - compare exit prices, not percentages: a ratio of two returns is unstable near 0% and flips sign. Each value's exit relative to entry is `1 + pct / 100` (the entry price cancels). On the fires where both values are finite and both exits are above 0.01 (a return above −99%), record the median, p10 and p90 of tape exit ÷ stored exit. Record also the share of the stored values above `peak_ceiling_pct × 1.05`, and the same share for the tape values;
  - delete the tape afterwards.

  **Pass:** the median exit ratio is between 0.9 and 1.1, and the stored over-peak share is at most 2% (parquet-built months read 0.05–1.8%; the broken cron read 25–45%, and its ×100 error puts the exit ratio near 0.01). Report p10/p90 alongside; they don't gate. If it fails, report the cause to the owner before Task 7 is pushed.
- [ ] **Step 6:** Write the probe numbers (shares, seconds per day, counts) and Step 5's two ratios to `docs/tmp/nightly-phase2-probe.md` (local only). Set `ENRICH_DAY_BUDGET_SECONDS` in Task 13 to max(900, 3 × the slowest local day), never above 1,800 (D2's budget table). Local downloads are slower than Railway's, so this is conservative.

### Task 7: Live crons tag their outcome writes; the lottery cron stops writing inversions

**Skills:** `backend-development`, `test-master`, `postgres-pro`.

**Files:**
- Modify: `api/cron/enrich-lottery-outcomes.ts`, `api/cron/enrich-silent-boom-outcomes.ts`, `api/__tests__/enrich-lottery-outcomes.test.ts`, `api/__tests__/enrich-silent-boom-outcomes.test.ts`, `api/_lib/cron-schedules.ts` (its comment only: the slots no longer drain "UW inversion")

**Interfaces:**
- Produces:
  - the lottery tape lock UPDATE (`lockTapeOutcomes`) and the silent-boom lock UPDATE set `outcome_source = 'ws_cron', outcome_version = 1`;
  - the WHERE clauses are unchanged. These are inline literals with a one-line comment: bump the version when the computation changes; the vocabulary is pinned by migration N's checks;
  - **the lottery cron runs the tape pass only (owner, 2026-11-06).** No `uw_intraday` source exists anywhere. Deleted from `enrich-lottery-outcomes.ts`:
    - `runInversionPass`, `selectInversionCandidates` and `writeInversionBatch`;
    - what only they used: `loadMatchedFlow`, `readEmptyIntradayKeys`, `groupKey`, the `Inversion*` and `FlowRow` types, `INVERSION_LOOKBACK_DAYS`, `INVERSION_CONCURRENCY` and `RUN_BUDGET_MS`;
    - the `inversion` metadata key and `inversion.chainErrors` in the status test;
    - the `fetchAndCacheOptionIntraday`, `simulateFlowInversion`/`FlowMinute` and `mapWithConcurrency` imports, each one only if nothing else in the file uses it;
    - the pass-2 text in the header docblock and the `UW_API_KEY` mentions (the cron no longer calls UW).
  - `realized_flow_inversion_pct` is written only by the nightly tape pass (tagged `fulltape`). The `vercel.json` schedule and `maxDuration` are unchanged: the three post-close slots still retry tape gaps.
  - Until the nightly step first runs (Task 15), fires since the reset show `realized_eod_pct` in the chip (Facts).

- [ ] **Step 1: Add failing tests:**
  - the lottery `lockText` contains `outcome_source = 'ws_cron'` and `outcome_version = 1`;
  - the silent-boom `lockText` contains `outcome_source = 'ws_cron'` and `outcome_version = 1`;
  - lottery cron: with fires that have a NULL inversion, no statement mentions `realized_flow_inversion_pct`, and the result metadata has no `inversion` key;
  - lottery cron: the tape pass still writes its outcomes and reports `success`.
- [ ] **Step 2:** Run `npx vitest run api/__tests__/enrich-lottery-outcomes.test.ts api/__tests__/enrich-silent-boom-outcomes.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Add the SET clauses and delete the inversion pass. Delete the flow-inversion `describe` block and the other inversion-only tests in `enrich-lottery-outcomes.test.ts` (the inversion-candidate SELECT reject, the UW outage as a chain error, the rejected flow load, the empty-chain skip, the 500-row batches), and the `option-intraday` and `flow-inversion` module mocks if nothing else in the file needs them. Keep every tape-pass failure test. Update the header docblocks (provenance line; inversions now come from the nightly) and the `cron-schedules.ts` comment.
- [ ] **Step 4:** Run the two tests. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(enrich): Tag the crons' outcome writes and leave flow inversions to the tape pass`. Push only once Task 6 Step 2 is verified and Task 6 Step 5 has passed (P3).

### Task 7b: Remove the UW intraday module the cron no longer imports

**Skills:** `backend-development`.

**Files:**
- Delete: `api/_lib/option-intraday.ts`, `api/__tests__/option-intraday.test.ts`
- Modify: `api/cron/refit-lottery-ticker-stats.ts` (its doc block, line 17: it names `option-intraday.ts deriveMid`; say the inversions now come from the tape, a night later)

- [ ] **Step 1:** Grep `api/`, `src/` and `scripts/` for importers of `option-intraday` (direct, type-level, `vi.mock` strings, dynamic imports). After Task 7 the lottery cron was the only one; `fetch-net-flow-history.ts` and `refit-lottery-ticker-stats.ts` name it in comments only. If any importer remains, stop: keep the module and report who uses it.
- [ ] **Step 2:** Delete the two files and fix the doc block. The `option_intraday_nbbo` and `option_intraday_nbbo_fetches` tables stay (the reset set was found through the second).
- [ ] **Step 3:** Run `npx vitest run api/__tests__/refit-lottery-ticker-stats.test.ts`, then `npm run review`, and commit `refactor(lottery): Remove the UW intraday module the enrich cron no longer uses`. Push with Task 7 (P3).

### Task 8: Nightly DB access

**Skills:** `python-packaging`, `secrets-management`.

**Files:**
- Modify: `nightly/src/config.py`, `nightly/src/constants.py`, `nightly/conftest.py`, `nightly/tests/test_config.py`
- Create: `nightly/src/resources.py` (tests go in `nightly/tests/test_config.py` under a `resources` section, to stay within five files)

**Interfaces:**
- Produces:
  - `Settings.database_url: SecretStr` (required). Its validator requires scheme `postgres://` or `postgresql://`, with a fixed message that never echoes the value.
  - constants `DB_CONNECT_TIMEOUT_SECONDS = 15` and `DB_STATEMENT_TIMEOUT_MS = 300_000`. The largest query, `list_work_dates`' scan of the 2.47 GB `lottery_finder_fires`, runs in seconds; past 300 s it is a hang.
  - `resources.direct_dsn(url: str) -> str`: strips a `-pooler` suffix from the first host label only, keeping user, password, port, path and query.
  - `resources.connect_db(settings: Settings) -> ContextManager[psycopg2.extensions.connection]`:
    - `_pipeline_retry.connect_with_retry(direct_dsn(...), error_detail=False, connect_timeout=DB_CONNECT_TIMEOUT_SECONDS, application_name="nightly", options=f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}", keepalives=1, keepalives_idle=30, keepalives_interval=10, keepalives_count=5)`. No literal for either timeout: phase 3's child processes build `PGOPTIONS` and `PGCONNECT_TIMEOUT` from the same two constants;
    - `error_detail=False` keeps the exception text out of the `[retry]` log line (Task 2b);
    - `autocommit = True`;
    - closes on exit, exceptions included.
  - `resources.open_reader(settings: Settings, cache_dir: Path) -> TapeReader`: empties `cache_dir` first, then builds the reader from the `R2_*` settings.
- `conftest.py`:
  - force-sets `DATABASE_URL=postgresql://test:test@localhost/test`;
  - appends the repo's `scripts/` to `sys.path` after `src/`.

- [ ] **Step 1: Write the failing tests:**
  - `test_missing_database_url_names_field`;
  - `test_database_url_scheme_checked_without_echo`;
  - `test_database_url_not_in_repr`;
  - `test_direct_dsn_strips_pooler_label`, a table:
    - `postgresql://u:p@ep-a-1-pooler.us-east-2.aws.neon.tech:5432/db?sslmode=require&channel_binding=require` → the same with host `ep-a-1.us-east-2.aws.neon.tech`;
    - an already-direct host → unchanged;
    - `-pooler` elsewhere in the host → unchanged;
  - `test_connect_db_sets_timeouts_and_autocommit_and_closes` (`resources.connect_with_retry` patched): the call carries `error_detail=False`, the connect timeout equals `DB_CONNECT_TIMEOUT_SECONDS`, and `options` equals `f"-c statement_timeout={DB_STATEMENT_TIMEOUT_MS}"`;
  - `test_open_reader_clears_the_cache_dir`.
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_config.py`. Expected: FAIL.
- [ ] **Step 3:** Implement. Leave `requirements.txt` as it is (Task 9). For these tests, install `psycopg2-binary==2.9.11` into `nightly/.venv` by hand.
- [ ] **Step 4:** Run the full nightly suite, `ruff check` and `ruff format --check`. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Connect to Neon directly with a statement timeout`. Hold (P4).

### Task 9: Build the image from the repo root

**Skills:** `python-packaging`, `gha-security-review`.

**Files:**
- Modify: `nightly/Dockerfile`, `nightly/requirements.txt`, `.dockerignore`, `.github/workflows/ci.yml`
- Create: `nightly/tests/test_image_layout.py`

**Interfaces:**
- Produces:
  - `IMAGE_FILES: tuple[str, ...]` in the test: `scripts/_tape_reader.py`, `scripts/_cli_paths.py`, `scripts/_pipeline_retry.py`, `scripts/enrich_lottery_outcomes.py`, `scripts/enrich_silent_boom_outcomes.py`, `ml/src/lottery_exit_policies.py`.
  - The image layout of D1.

**Changes:**
- **Dockerfile:**
  - the builder copies `nightly/requirements.txt`;
  - the final stage copies `nightly/src/` → `./src/`, the five scripts files → `./scripts/` and `ml/src/lottery_exit_policies.py` → `./ml/src/`, all `--chown=nightly:nightly`;
  - `PYTHONPATH=/app/src:/app/scripts`;
  - a comment names the build context (repo root) and the six places that must change together (D1).
- **requirements.txt:** the four D1 dependencies.
- **`.dockerignore`:** right after the `scripts/` line, `!scripts/`, `scripts/*`, then the five `!scripts/<file>` lines (the `src/data` pattern at `.dockerignore:24-26`), with a comment.
- **ci.yml:**
  - the `nightly` filter gains `IMAGE_FILES`, `scripts/test_tape_reader.py`, `scripts/test_cli_paths.py`, `scripts/test_pipeline_retry.py`, `scripts/test_enrich_*.py` and `.dockerignore`;
  - the nightly job gains two steps with `working-directory: .` after the existing ones:
    - `python -m ruff check --isolated --select E4,E7,E9,F <IMAGE_FILES>`;
    - `python -m pytest -q -p no:cacheprovider scripts/test_tape_reader.py scripts/test_cli_paths.py scripts/test_pipeline_retry.py scripts/test_enrich_lottery_outcomes.py scripts/test_enrich_missing_archive.py scripts/test_enrich_provenance.py scripts/test_enrich_r2_cli.py`.

- [ ] **Step 1: Write the failing tests:**
  - `test_dockerfile_copies_exactly_the_image_files`: parse the non-`--from` `COPY` lines; the shared sources equal `IMAGE_FILES` and each one exists.
  - `test_dockerignore_readmits_image_files`: the order is `scripts/`, then `!scripts/`, then `scripts/*`, then a `!<path>` line for each `scripts/` entry of `IMAGE_FILES`.
  - `test_scripts_import_in_the_image_layout`:
    - copy `nightly/src` and `IMAGE_FILES` into `tmp` at their image paths;
    - run `[sys.executable, "-P", "-c", "import enrich_lottery_outcomes, enrich_silent_boom_outcomes, _tape_reader"]` with `cwd=tmp` and `PYTHONPATH=tmp/src<os.pathsep>tmp/scripts`;
    - exit 0.
- [ ] **Step 2:** Run `cd nightly && .venv/Scripts/python -m pytest -q tests/test_image_layout.py`. Expected: FAIL.
- [ ] **Step 3:** Make the changes. Run `uv pip install --python nightly/.venv -r nightly/requirements-dev.txt`.
- [ ] **Step 4:** Run:
  - the nightly suite, ruff and format;
  - from the repo root, the two new CI commands, with `nightly/.venv/Scripts/python`;
  - `docker build -f nightly/Dockerfile .` if Docker is available locally. It is the only real check of the `.dockerignore` order (a `COPY` of an ignored file fails the build). Otherwise note that Task 15 Step 3 verifies the Railway build.

  Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `build(nightly): Build the image from the repo root with the shared enrich scripts`. Hold (P4).

### Task 10: Step runner and its Sentry reporting

**Skills:** `monitoring-expert`.

**Files:**
- Create: `nightly/src/steps.py`, `nightly/tests/test_steps.py`
- Modify: `nightly/src/monitoring.py`, `nightly/tests/test_monitoring.py`

**Interfaces:**
- Produces:
  - D2's `steps.py`, verbatim;
  - `monitoring.report_step(outcome: StepOutcome) -> None`:

    | Outcome | Sentry |
    |---|---|
    | `ok` | nothing |
    | `partial` | warning `nightly step partial` |
    | `failed` with `error is None` | error `nightly step failed` |
    | `failed` with `error` set | nothing (the exception event was already sent) |
    | `skipped_deadline` | error `nightly step skipped_deadline` |

    Tags `step` and `status`; extras `counts` and `detail`; fingerprint `["nightly-step", name, status, detail]`. Sentry rule 6262727 mails on new issues only, so a step that repeats the same title and detail night after night raises one email until someone resolves the issue. The owner accepted that on 2026-11-06 (one email per new reason).
  - `scrub_event` replaces the value of any exception whose module root is `polars`/`_polars*`, `pandas`, `pyarrow`, `numpy` or `psycopg2` with `"<redacted data-library message>"`. psycopg2's `DETAIL: Failing row contains (…)` quotes a fire row. Rename `POLARS_REDACTED` and update its phase-1 tests.

- [ ] **Step 1: Write the failing tests:**
  - `test_runs_steps_in_order_with_their_own_deadlines`: three steps with `min_seconds` 100, 50, 10 → contexts get `run_deadline-60`, `run_deadline-10` and `run_deadline`.
  - `test_exception_becomes_failed_and_later_steps_run`: `error == "KeyError"`; one `capture_exception`; the log has no exception text.
  - `test_step_skipped_when_under_min_seconds_left`: a later 0-second step still runs.
  - `test_invalid_result_is_failed`: unknown status, negative count, non-int count.
  - `test_base_exception_propagates`.
  - `test_on_outcome_failure_does_not_stop_the_run`.
  - `test_reserve_seconds_sums_min_seconds`.
  - `test_report_step_by_status`: the table above.
  - `test_scrub_redacts_data_library_messages`: one test per module root.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Run ordered post-tape steps with isolation and deadlines`. Hold (P4).

### Task 11: Wire the steps into the run

**Files:**
- Create: `nightly/src/pipeline.py` (`STEPS: tuple[Step, ...] = ()` for now)
- Modify: `nightly/src/main.py`, `nightly/src/tape_job.py`, `nightly/tests/test_main.py`, `nightly/tests/test_tape_job.py`

**Interfaces:**
- Consumes: `run_steps`, `reserve_seconds` and `report_step` (Task 10).
- Produces:
  - `run_tape(settings, now_utc, on_outcome=None, deadline: float | None = None)`. `None` keeps `monotonic() + RUN_DEADLINE_SECONDS`.
  - In `main._run`:
    - `run_deadline = started + RUN_DEADLINE_SECONDS`;
    - `last_session` is computed in the same `try` as `run_tape`;
    - tape `deadline = run_deadline - reserve_seconds(STEPS)`;
    - `run_steps(STEPS, …, tape=tuple(outcomes) or (), on_outcome=report_step)`, run whenever `last_session` is known;
    - returns `max(tape_code, step_code)`.

- [ ] **Step 1: Write the failing tests:**
  - `test_steps_run_after_tape_and_a_failed_step_exits_1`.
  - `test_partial_step_exits_0`.
  - `test_steps_run_when_run_tape_raises`: exit 1; steps called with `tape=()`.
  - `test_tape_deadline_reserves_step_minimums`: `STEPS` patched to two steps of 100 and 50 → `run_tape` gets `deadline == started + RUN_DEADLINE_SECONDS - 150`.
  - `test_no_steps_when_the_session_cannot_be_resolved`: `CalendarExhausted` → exit 1, no step call.
  - `test_run_tape_honours_a_given_deadline` (in `test_tape_job.py`): a past deadline → every planned day `skipped_deadline`.
  - Extend `test_deadline_constants_bound_the_run` with the budget table's one assertion (D2): `reserve_seconds(STEPS) + 2 * DAY_BUDGET_SECONDS <= RUN_DEADLINE_SECONDS`, read from the real `STEPS` and the constants. It holds with `STEPS` empty and keeps covering every step later phases register.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS. All phase-1 `main` and `tape_job` tests stay green.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Run the step pipeline after the tape, inside the run deadline`. Hold (P4).

### Task 12: The outcome check (100%-NULL alert)

**Skills:** `postgres-pro`, `monitoring-expert`.

**Files:**
- Create: `nightly/src/outcome_check.py`, `nightly/tests/test_outcome_check.py`, `nightly/tests/test_pipeline.py`
- Modify: `nightly/src/pipeline.py`, `nightly/src/constants.py`

**Interfaces:**
- Consumes: `connect_db` (Task 8); `Step` and `StepContext` (Task 10); `calendar_nyse.previous_trading_day`.
- Produces:
  - constants `OUTCOME_CHECK_SESSIONS = 3` (two missed nights still get checked), `OUTCOME_CHECK_BUDGET_SECONDS = 300` (one statement timeout) and `LOW_OUTCOME_SHARE = 0.95` (owner answer 2);
  - `OUTCOME_TABLES = ("lottery_finder_fires", "silent_boom_alerts")`;
  - `@dataclass(frozen=True) class DayShare: table: str; day: date; rows: int; with_outcome: int`;
  - `def outcome_shares(conn, days: Sequence[date]) -> list[DayShare]`: for each table, `SELECT date, count(*), count(*) FILTER (WHERE peak_ceiling_pct IS NOT NULL) FROM <table> WHERE date = ANY(%s::date[]) GROUP BY date`. Only days with rows are returned. The table names come only from `OUTCOME_TABLES`;
  - `def classify_share(share: DayShare) -> Literal["null", "low", "ok"]`, pure and silent: `with_outcome == 0` is `null`; a share `< LOW_OUTCOME_SHARE` is `low`. Task 13 uses it too;
  - `def report_shares(shares: Sequence[DayShare]) -> tuple[int, int]`, the only code that sends share alerts, returning `(null_days, low_days)`:
    - each `null` pair sends an error `nightly outcomes all null`: tags `table` and `day`, extras `rows` and `with_outcome`, fingerprint `["nightly-outcomes", "null", table, day]`. The run checks `OUTCOME_CHECK_SESSIONS` days of `OUTCOME_TABLES`, so it sends at most 6;
    - all `low` pairs together send **one** warning per run, `nightly outcomes mostly null` (owner answer 2): extras `count` and `days` (sorted `table:day` strings), fingerprint `["nightly-outcomes", "low", *days]`;
  - `def recent_sessions(last_session: date, n: int) -> list[date]`, ascending;
  - `def run(ctx: StepContext) -> StepResult`: `report_shares(outcome_shares(conn, recent_sessions(ctx.last_session, OUTCOME_CHECK_SESSIONS)))`; `failed` if `null_days`, else `ok`; counts `days_checked`, `null_days`, `low_days`;
  - `pipeline.lazy_step(name: str, module: str, min_seconds: int) -> Step`: `run` is a function that calls `importlib.import_module(module).run(ctx)` (D2, import isolation). `pipeline.py` imports no step module at load;
  - `pipeline.STEPS = (lazy_step("outcome-check", "outcome_check", OUTCOME_CHECK_BUDGET_SECONDS),)`.

- [ ] **Step 1: Write the failing tests:**
  - `test_null_day_is_an_error_and_fails_the_step`.
  - `test_low_share_classifies_at_the_threshold`: 0.94 is `low`; 0.95 and 0.9926 are `ok`.
  - `test_low_days_send_one_summary_per_run`: five low pairs → one `capture_message`, level warning, fingerprint carries the sorted pairs; the null pairs still send their own errors.
  - `test_null_alerts_are_bounded_by_tables_times_sessions`.
  - `test_day_without_rows_is_not_alerted`.
  - `test_recent_sessions_across_dst_and_holidays`:
    - `2026-11-03` → `[10-30, 11-02, 11-03]`;
    - `2026-11-27` → `[11-24, 11-25, 11-27]`.
  - `test_outcome_shares_queries_both_tables_by_date_any`: fake cursor; parameters are dates, not strings.
  - `test_null_fingerprint_is_per_table_and_day`.
  - In `test_pipeline.py`:
    - `test_pipeline_step_names_unique_and_valid`;
    - `test_pipeline_imports_no_step_module_at_load`: a subprocess imports `pipeline`, then asserts `outcome_check` is not in `sys.modules`;
    - `test_import_error_in_a_step_module_fails_only_that_step`: `run_steps` over `lazy_step("broken", "no_such_step_module", 0)` and a passing step → the first is `failed` with `error == "ModuleNotFoundError"`, the second ran.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the nightly suite, ruff and format. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Alert when a session's fires come back with no outcomes`. Hold (P4).

### Task 13: The enrichment step (backstop + backfill)

**Skills:** `postgres-pro`, `r2-storage`.

**Files:**
- Create: `nightly/src/enrich_step.py`, `nightly/tests/test_enrich_step.py`
- Modify: `nightly/src/pipeline.py`, `nightly/src/constants.py`, `nightly/tests/test_image_layout.py` (the layout import also imports `pipeline`, `outcome_check` and `enrich_step`: `lazy_step` defers them, so a missing file would otherwise go unseen)

**Interfaces:**
- Consumes:
  - `connect_db` and `open_reader` (Task 8);
  - `enrich_lottery_outcomes` and `enrich_silent_boom_outcomes`: `configure_archive`, `list_work_dates`, `enrich_one_date` (Tasks 3–4);
  - `outcome_shares` and `classify_share` (Task 12).
- Produces:
  - constants:

    | Name | Value |
    |---|---|
    | `ENRICH_CACHE_DIR` | `WORK_DIR / "enrich"` |
    | `ENRICH_DAY_BUDGET_SECONDS` | `900`, or `3 ×` the slowest local day from Task 6 if larger, **never above 1,800** (D2's budget table) |
    | `ENRICH_MAX_DAY_FAILURES` | `3` (bounds Sentry noise and wasted downloads in an outage; a failed day and an all-NULL day each count) |

  - `def work_days(conn, through: date) -> list[date]`: the union of both scripts' `list_work_dates(conn, "all", TAPE_START.isoformat(), through.isoformat())`, newest first;
  - `def run(ctx: StepContext) -> StepResult`;
  - `pipeline.STEPS = (lazy_step("enrich-outcomes", "enrich_step", ENRICH_DAY_BUDGET_SECONDS), lazy_step("outcome-check", …))`.

**Behavior of `run`:**
- **Setup:**
  - list the work days on one connection;
  - `open_reader(ctx.settings, ENRICH_CACHE_DIR)`;
  - one `landed_days()`;
  - `configure_archive(ENRICH_CACHE_DIR, "fulltape")` on both modules.
- **For each day, newest first:**
  - stop when `ctx.seconds_left() < ENRICH_DAY_BUDGET_SECONDS`; the rest are `days_left`;
  - not landed → `days_waiting_tape`;
  - otherwise: `fetch_day(day, deadline=ctx.deadline)` once; a fresh `connect_db`; lottery `enrich_one_date(conn, iso, select="all")`, then silent boom's; then `outcome_shares(conn, [day])` → `classify_share` for each table, counting `null_days` and `low_days`. **It sends no share alert.** The outcome check reports the last three sessions, so the latest session is never reported twice, and a long backfill can't send a day's worth of emails;
  - `release(day)` in `finally`.
- **Per-day failures:** an `Exception` in a day is counted in `days_failed` and sent as one `capture_exception` tagged `step` and `day`, and the loop goes on. The loop stops when `days_failed + null_days` reaches `ENRICH_MAX_DAY_FAILURES`: with a broken layout or chain format every day would come back all-NULL, and each one would cost a download. A run's Sentry volume from this step is at most that many exceptions plus the one step report.
- **Never called:** pass 3.
- **Status:** `failed` if `days_failed` or `null_days`; else `partial` if `days_left`; else `ok`. `low_days` is a count only.
- **Counts:** `days_processed`, `days_waiting_tape`, `days_left`, `days_failed`, `null_days`, `low_days`, `lottery_outcomes_written`, `lottery_stamped_no_outcome`, `lottery_inversion_written`, `lottery_inversion_stamped`, `lottery_inversion_input_missing`, `silent_boom_outcomes_written`, `silent_boom_stamped_no_outcome`.
- **Logs:** one line per day (date, counts, seconds).

- [ ] **Step 1: Write the failing tests.** Patch the script functions, `open_reader`, `connect_db` and `outcome_shares` at the `enrich_step` module boundary.
  - `test_days_run_newest_first_with_one_fetch_each`: both tables are called with `select="all"`, and `release` runs even when an enrich raises.
  - `test_day_not_landed_waits_and_is_untouched`.
  - `test_deadline_leaves_days_for_the_next_night_as_partial`.
  - `test_null_day_after_enrichment_fails_the_step`.
  - `test_the_step_sends_no_share_alerts`: `capture_message` is never called, with null and low days in the run.
  - `test_day_failures_are_isolated_and_capped_at_three`.
  - `test_null_days_count_toward_the_stop`: three all-NULL days after enrichment end the loop; the rest are `days_left`.
  - `test_never_runs_pass_3`: `refit_ticker_inversion_stats` patched to raise.
  - `test_work_is_bounded_by_tape_start_and_last_session`.
  - `test_cache_dir_is_the_enrich_dir`.
  - `test_enrich_budget_is_within_the_cap`: `900 <= ENRICH_DAY_BUDGET_SECONDS <= 1_800` (the cap is a literal here on purpose: it is D2's table, not a constant).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement, and extend the layout import test to `import pipeline, outcome_check, enrich_step`.
- [ ] **Step 4:** Run the nightly suite, ruff, format and the shared-script tests. Expected: PASS.
- [ ] **Step 5:** Run `npm run review`, then commit `feat(nightly): Enrich fires from the tape lake after each landing`. Hold (P4).

### Task 14: Docs

**Skills:** `agents-md`.

**Files:**
- Modify: `nightly/README.md`, `CLAUDE.md`, `nightly/tests/test_image_layout.py`

**Content:**
- **README:**
  - "What it does" gains the steps;
  - its first item changes from "up to 30 days of catch-up" to the real rule from D2's budget table. The tape still plans up to 30 days (`CATCHUP_MAX_DAYS`), but a day starts only in the first `RUN_DEADLINE_SECONDS − reserve − DAY_BUDGET_SECONDS` seconds of the run, and the steps' reserve shrinks that window. State the window for this phase's reserve, worked from the constants (12,300–13,200 s, depending on `ENRICH_DAY_BUDGET_SECONDS`), that a night lands the window divided by the seconds one day takes, and that phases 4 and 3 shrink it (D2's stage table). Task 15 Step 4 adds the measured seconds per day;
  - the Railway settings become root `/`, Dockerfile path and the D1 watch-path list, with the push hazard naming the shared scripts and the push window (after 15:00 CT and outside 07:15–12:30 UTC);
  - the env table gains a `DATABASE_URL` row (a reference to uw-stream's, so it rotates with it);
  - a new "Enrichment" section covers the predicates, the provenance values, what "tagged with NULL outcomes" means and the re-try SQL: `UPDATE … SET outcome_source = NULL, outcome_version = NULL WHERE outcome_source = 'fulltape' AND outcome_version = 1 AND peak_ceiling_pct IS NULL AND date = '<day>'` (by hand only). It also gives the local dry-run command from Task 6;
  - the alert table gains the four step titles and the two outcome titles;
  - the exit codes gain "a step failed or was skipped".
- **CLAUDE.md:**
  - the `nightly/` block (steps; writes outcome and provenance columns to Neon; `DATABASE_URL`). Its "up to 30 days of catch-up" becomes the same rule in one line: the tape plans up to 30 days and starts a day only inside the window the steps' reserve leaves (see `nightly/README.md`);
  - the Deployment line "Nightly env" plus the watch-path hazard and the push window.

- [ ] **Step 1:** Add the failing test `test_readme_lists_every_watch_path` to `test_image_layout.py`. It builds the expected list as the three nightly paths (`/nightly/Dockerfile`, `/nightly/requirements.txt`, `/nightly/src/**`), `/.dockerignore`, and `"/" + f` for each `f` in `IMAGE_FILES`, and asserts each appears in `nightly/README.md`. Phases 3 and 4 add to `IMAGE_FILES`, so their image tasks fail this test until they add the README line (D1's sixth place).
- [ ] **Step 2:** Edit the docs. Run the nightly suite, then `npm run review`.
- [ ] **Step 3:** Commit `docs(nightly): Document the enrichment steps, provenance and new alerts`. Hold (P4).

### Task 15: Deploy, first run, backfill watch (controller)

**Skills:** `railway:use-railway`, `postgres-pro`, `r2-storage`, `vercel-deployment`.

- [ ] **Step 1:** Set `DATABASE_URL=${{uw-stream.DATABASE_URL}}` on `nightly` (Railway MCP `set-variables`, reference syntax). List the variable names (not values) to confirm. The running code ignores it (`extra="ignore"`).
- [ ] **Step 2:** In the push window (after 15:00 CT and outside 07:15–12:30 UTC):
  - in the worktree, `git fetch && git rebase origin/main`;
  - rerun the nightly suite, the shared-script tests and `npm run review`.
- [ ] **Step 3:** Apply the Railway settings: root `/`, Dockerfile `/nightly/Dockerfile` and the exact D1 watch-path list. Then run `git push origin HEAD:main`. Verify:
  - the deployment builds `SUCCESS`;
  - the build log shows the six shared `COPY`s.

  A failed build leaves the old deployment serving, so fix forward in the same window.
- [ ] **Step 4:** Trigger `railway cron run --service nightly`, or wait for 07:15 UTC. Watch the logs:
  - the tape summary;
  - `step enrich-outcomes …` day lines (newest first);
  - `step outcome-check ok`;
  - `InsecureRequestWarning` count 0;
  - Sentry `nightly-tape` check-in `ok` (or `error` naming steps);
  - the tape days landed and the seconds each took. Work out how many days a night lands (the window in D2's table ÷ seconds per day) and add that figure to the README's first item (a docs-only commit; the README is not a watch path).
- [ ] **Step 5:** Each night until the backfill is finished (about 176 work days; at the probe's per-day time that is 2–3 nights), relay `days_processed`, `days_waiting_tape` and the written counts. **Backfill finished** means one run reports `days_left = 0`, `days_failed = 0` and `days_waiting_tape = 0`, and a read-only `work_days` listing through the last session is empty. Tell the main session when it is: phase 4's Task 1 and phase 3's Task 16 Step 1 do not start before then.
- [ ] **Step 6:** Final check (read-only):
  - per-month pending / done-but-empty / with-outcome / `outcome_source` counts for both tables against the "Facts" section;
  - every day with ≥1 fire and 0 outcomes is listed, and each must be a day with no tape in R2;
  - `lottery_ticker_stats.max(updated_at)` is unchanged;
  - the share of `inversion_source = 'fulltape'` rows with `realized_flow_inversion_pct > peak_ceiling_pct * 1.05`, by month (expected at most 2%; parquet-built months read 0.05–1.8%). This confirms the refilled inversions carry no trace of the ×100 error. (Phase 4 measured the by-structure split itself.)
- [ ] **Step 7:** Update memory:
  - `project_nightly_automation_goal`: phase 2 live; D1–D4; the new watch paths and push hazard;
  - `project_enrichment_gaps_2026_10_28`: backfill result;
  - a note that nightly's `DATABASE_URL` follows uw-stream's.

  Then report to the owner.

---

## Reconciliation with other sessions' work

- **Already shipped (summer-gap phase 1, 10-29, `a2418be6`…`246631cc`):**
  - the missing-day skip in both scripts (owner rule; the spec's `:446`);
  - `--parquet-dir`;
  - the Makefile's `VENV_BIN` Python path (the spec's "Mac-only Python path").

  Phase 2 keeps all three and adds the R2 source.
- **Lottery-timeouts phase E and summer-gap phases 5–6** will insert recovered fires (10-16 → 10-28, and 07-22 → 09-04) with `enriched_at` NULL:
  - The nightly step picks them up with no extra work once their tape day is in R2.
  - Their "outcomes through the parquet path" and the tape inversion pass happen there. The "~25K UW requests" flow-inversion pass in summer-gap phase 6 is unnecessary for them: the tape pass uses the NBBO mids plus `net_flow_per_ticker_history`, which summer-gap phase 3 refilled.
  - Their `recovered_at` migration and migration N must not share an id; whoever lands second renumbers (Task 1 says how, and phase 4's migration follows).
  - Phase B/E plan item E2 ("R2 → local download step, no script exists") should use `TapeReader.fetch_day`.
- **The live crons:** the starvation-fix design leaves `tapeGap`/`noPrints`/`unreadable` fires unstamped and names the parquet script as recovery. The nightly step is now that recovery, automatically. The same cron's second pass (flow inversions from UW intraday, in that design) is deleted in Task 7. The design doc is left as written; Task 7 updates the cron's own header.
- **Classifier deletion (10-29):**
  - Enrichment reads none of the classifier or anchor columns, so nothing changes here.
  - The anchor-leg backfill is done: `anchor_leg_kind` was backfilled from the tape and is set on 1,064,394 of 1,064,396 fires (11-05), so phase 4 only verifies it.
- **Other writers that don't tag provenance**, left as they are: `scripts/recompute_peak_from_parquet.py` (`WRITE_DB=1` rewrites peak and minutes-to-peak) and `ml/experiments/lottery-net-flow-eda/exit_simulation.py`.

## Spec deltas

1. **The reader is `scripts/_tape_reader.py`, not `ml/src/utils/r2.py`** (D3 gives the reasons). `ml/src/utils/r2.py` is left untouched. It has no callers, a Mac default path, and an R2 path that needs s3fs, which isn't installed. Recommend deleting it in phase 3.
2. **The reader downloads whole day objects to local disk** with one single-threaded `get_object` client, rather than range-reading from R2. That gives verified TLS, moto-testable code and plain local files for pandas, pyarrow and DuckDB. The reader has no scan methods, because no phase calls them. Peak extra disk is 1.74 GB.
3. **The backfill runs newest first from the last session back to `TAPE_START`, not only 06-12 → 10-22.**
   - It also fills 188,289 NULL inversions on 111 older days (counted 10-29), refills the 111,645 inversions reset on 11-06, and retries 131 old done-but-empty fires (memory `always-backfill`).
   - The recent gap lands first.
4. **Provenance is four columns on lottery (outcome and inversion are filled separately, by different methods) and two on silent boom.**
   - Tape writers also tag rows they tried but couldn't price, so the work set is finite.
   - So "done-but-empty" now has two meanings, told apart by the source being NULL or set.
5. **The two live crons tag their outcome writes** (`ws_cron`), and the lottery cron stops writing flow inversions (owner, 2026-11-06). That is a TypeScript change in this phase (Tasks 7, 7b).
6. **The tape pass is the only writer of flow inversions.** The cron's UW-intraday pass is deleted, so the two methods no longer mix. Legacy values (parquet-built, and the fixed cron's last four sessions) keep a NULL `inversion_source`. Task 6 Step 5 compares the cron's values with the tape's before the deletion; parity with the parquet NBBO mids stays unverified, as the spec says.
7. **`DATABASE_URL` is uw-stream's pooled URL,** and the job derives the direct host (D4).
8. **Exit codes:** a step's `partial` (work left for the next night) exits 0 with a warning; `failed` and `skipped_deadline` exit 1.
9. **The new "mostly null" warning** (share below 0.95) extends the spec's 100%-NULL alert. Owner answer 2: yes, capped to one summary per run.
10. **Pass 3's live write path is deleted from the script** (not only skipped), and the Makefile's `WRITE_DB=1` goes. The quality-sim CSV stays local until phase 3 moves research outputs to R2.
11. **Railway settings live on the service** (no `railway.toml`), as phase 1 found.

## Owner answers (2026-11-06)

1. **Prod migration run.** Yes, `scripts/migrate-db.ts` runs on prod in the 16:05–16:35 CT window, but only when the pending ids are ours alone. It applies every pending migration in order, other sessions' included (for example #200, which drops `es_overnight_summaries` and `es_bars`, if prod lacks it). If another session's migration is pending, wait for that session to apply it; don't apply it. (Task 6 Step 1.)
2. **"Mostly null" warning.** Yes: a processed or recent day whose outcome share is below 95% raises a Sentry *warning* alongside the spec's all-null *error*, capped to one summary per run. On history, good days never fell below 99.26% (lottery) or 100% (silent boom). (Task 12.)
