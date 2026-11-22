# Lottery tracker: rebuild the whole series every night

Status: approved by the owner 2026-11-22. The decisions:
- A is (c): `partial`, publishing the snapshot and the state.
- B is yes: the changed-rows line.
- Open questions 1–4 take their defaults.

Phases run in order, one at a time. It follows the 2026-11-21/22 gap fill
(commits cb34c5631..99a8c7794) and the one-time rebuild of the R2 tracking state: 192 rows,
2026-01-02 .. 2026-11-20, put 2026-11-22 ~05:1x UTC. Adversarial review done 2026-11-22; what it
changed is at the end.

## Goal

The nightly `lottery-tracking` step writes the whole tracking series every night, each row as of
its own date on that night's data and active weights. A revision of past data then never leaves
an artificial jump between old and new rows. Such revisions include re-enriched outcomes, a
weights promotion that moves the T1/T2 cutoffs, and fires added or corrected later.

## Why

- A row today is computed once and never again (`scripts/daily_tracker.py`; the nightly step
  `_track` in `nightly/src/research_db_steps.py` runs it on the stored CSV). When past data is
  revised, rows written before the revision no longer compare with rows written after it.
- Measured 2026-11-22 (read-only Neon, scratch copy): of the 27 rows written May–June 2026,
  recomputed on today's data, 1 date kept its day counts and tiers. Examples:
  - 06-16's window mean flow inversion went from 73.3 % to 8.5 %, and its Sharpe from 0.047 to
    0.079;
  - 05-05's fires went from 4,913 to 11,478;
  - the early-May windows went from 63k–98k fires to 564k–617k.

  The owner chose to rebuild the series once; this plan makes that the nightly behaviour.
- The next revision is already scheduled. Promotion (phase 4 Task 23, waiting on the owner)
  rewrites live scores and moves the active cutoffs, so every tier column would jump on that
  night.

## What a row means after this

Today a row means "what the tracker saw on the night after that date". After this change it means
"that date's fires and window, measured on tonight's data and tonight's active cutoffs".

What each night actually saw is still kept:
- **From tonight on:** the step already stores each night's file at
  `research/lottery-tracking/{session}/lottery-tracking.csv`, before the state. Each dated
  snapshot is that night's view.
- **Rows written before 2026-11-22:** `git show f9f220fa9:docs/tmp/lottery-tracking.csv`. The
  working copy of that file changes on the next local `make update` (open question 1).
- **Whether the snapshots last:** that depends on the bucket having no expiry rule.
  - The bucket's setup spec skipped lifecycle rules (`r2-archive-2026-05-10.md`, "Lifecycle
    policies: … Skip").
  - Objects from January are still there.
  - The R2 token can't read the lifecycle config (`AccessDenied`, 2026-11-22), so only the
    Cloudflare dashboard can confirm it (R2 → bucket → Settings → Object lifecycle rules).

## Cost

| | |
|---|---|
| Measured, real data, workstation, 2026-11-22 | The full rebuild (192 dates, 1,159,255 enriched fires) took 22.7 s end to end, including the Neon read. |
| Linear today | `build_rows` already keeps running totals for the tier counts, the window sizes and the ticker table. |
| Not linear | The three `stats()` calls per date (all fires, T2+, Mode B). Each re-reads its whole window prefix, so the loop grows with dates × fires. |

`build_rows` on synthetic frames, measured by the plan review (`bench_scale.py` in the review's
scratch dir):

| Frame | Loop time | Of which `stats()` |
|---|---|---|
| 1.2M fires, 192 dates | 7.6 s | 6.2 s |
| 3.7M fires, 444 dates (about a year out at ~10k fires a session) | 49.4 s | 43.8 s |

With the Neon read added:
- **One year out:** about 95–100 s.
- **Two years out:** about 200–210 s.

300 s is the step's reserve (`REPORT_BUDGET_SECONDS`), not its timeout. The tracker runs with
`ctx.seconds_left()` (`research_db_steps.py`), and that includes whatever the faster report steps
before it left unused. So "past 300 s" is the worst case, not the night the step starts failing.
Phase 3 makes the stats linear, so the loop stays around a second and the read is what's left.

## Phases

Each phase ships on its own: gate, review, commit, push outside the nightly window.
`scripts/daily_tracker.py` and `nightly/src/*` are watch paths, so push after 15:00 CT and outside
07:15–12:30 UTC.

### Phase 1 — the tracker writes the whole series on every run

Today `--rebuild` is the only path that writes every date. Make that the tracker's one behaviour:
every run writes one row per enriched fire date, ascending, each as of its date, all sharing one
`run_at`.

**What the run reads from the file already there.** Only its rows whose `date` is a strict
`YYYY-MM-DD` (the `_csv_date` rule), and only to report. The two print lines `--rebuild` has
today stay: `rebuilt … replacing …` and `… earlier dates have no enriched fires now and were
dropped`. The new line under open question B joins them. A row with a blank or malformed date is
dropped and takes no part in either count.

**Removed, with their tests:**
- the fill path in `dates_to_write` (`last_date`, the `[latest]` fallback);
- the "CSV's last row … is newer than the newest enriched fire date" line;
- the `--rebuild` flag.

**Kept as they are:**
- the weights-first order;
- the "no enriched fires" exit before the file is touched;
- `COLUMNS`;
- the golden tests recorded from e37dfbd88 (the row values don't change).

**Docs, in this phase, so nothing names a flag that's gone:**
- `nightly/README.md`, wherever the flag or the fill is described:
  - the step list (~51–53, "extends one growing CSV with a row for every enriched fire date
    after the file's last row");
  - ~1033 ("extends the stored tracking CSV");
  - the "Rebuilding the tracking CSV" paragraph (~1043–1053). It becomes: the nightly rebuilds
    every night, each dated snapshot keeps that night's view, and there is nothing to run by
    hand.

  The alert table waits for Phase 2.
- `docs/lottery-pipeline-runbook.md`:
  - 37, 41 and 67 (the fill and the flag);
  - 82 ("appended");
  - the drift signals at 90–94 and the "Day-over-day Sharpe jumps > 0.05 → … enrichment glitch"
    line at 105. A whole-series rewrite moves past rows too, so day-over-day reads compare the
    newest row of two dated snapshots, and a revision of history shows up as the open question B
    line.

Files (5):
- `scripts/daily_tracker.py`
- `scripts/test_report_cli.py`
- `scripts/test_report_weights.py` (the `--rebuild` weights-failure test becomes the plain-run one)
- `docs/lottery-pipeline-runbook.md`
- `nightly/README.md`

### Phase 2 — the step needs no stored state to compute

`_track` in `nightly/src/research_db_steps.py`, its status contract in the module docstring
(lines 7–20), and its tests in `nightly/tests/test_research_db_steps.py`.

**No stored state.** A missing state, or a zero-byte one, no longer fails the step. Today those
fail with `tracking state missing` and `tracking state header changed`. Instead:
- `rows_before` is 0;
- there is no header to extend and no dates to compare;
- the tracker writes a new file and the step publishes it.

`_STATE_MISSING_DETAIL` and its test go.

**Header guard.** Unchanged when a state exists: the new header must be the old one with columns
only appended.

**Lost-dates check.** It replaces the row-count shrink check, because row counts can't catch a
night where one date drops and a new one is added.
- The step reads the downloaded state's dates before it runs the script, as it reads the header
  today. The script rewrites that file in place (`--csv` is the downloaded path).
- It counts only strict `YYYY-MM-DD` dates (the same pattern as the tracker's `_csv_date`, kept
  in the step module), so a blank or malformed row never counts as lost.
- A lost date is a date the old state had that has no row in the new file: its fires were
  deleted or lost their outcomes.
- What happens then is open question A. The default is option (c), `partial`.

**Docs, `nightly/README.md`:**
- The research-outputs table (~1016, "the appended tracking CSV").
- The alert table:
  - drop the `tracking state missing` row;
  - replace the `tracking state shrank` row with the lost-dates row that question A picks;
  - reword `tracking state header changed`, which no longer covers a zero-byte state.
- The seed text at ~1135–1136 ("whatever it puts at the tracking state key first stays there").
  Once the nightly rewrites the state every night, that's no longer true. It goes together with
  question 2's sentence.

Files (3): `nightly/src/research_db_steps.py`, `nightly/tests/test_research_db_steps.py`,
`nightly/README.md`.

### Phase 3 — linear window stats

Replace the per-date `stats(pd.Series(flows[: ends[k]]))` with running aggregates, built once per
cohort (all, T2+, Mode B):
- **Per date:** the count, mean and M2 (the sum of squared deviations from the date's own mean)
  of the cohort's non-NaN `flow_inv`.
- **Merged in date order:** Chan et al.'s pairwise update, a loop over dates, not fires:
  `n = na + nb`, `delta = mean_b − mean_a`, `mean = mean_a + delta·nb/n`,
  `M2 = M2a + M2b + delta²·na·nb/n`.
  - A date with `nb = 0` leaves the totals as they were.
  - While the running `n` is 0, the first non-empty date's values are taken as they are (no 0/0).
- **Output:**
  - `std = sqrt(M2 / (n − 1))`;
  - `sharpe = mean / std`, and `0.0` when `std` is 0;
  - `n < 30` gives NaN mean and Sharpe, which print as blanks;
  - the same rounding as today (mean to 3 places, Sharpe to 4).

The sum-of-squares shortcut (`Σx² − (Σx)²/n`) is not acceptable: it loses digits to cancellation
when the mean is large next to the spread. The review's prototype of the Chan merge (`chan_check.py`
in its scratch dir) matched pandas prefix stats to a 3.2e-15 relative difference over 1.19M
heavy-tailed values and 300 dates, with 0 rounding flips.

**Tests** (in `scripts/test_report_cli.py`):
1. The golden tests pass unchanged on their recorded values.
2. A large-offset cohort (1e8 plus N(0, 1), a few hundred fires over several dates): mean and
   Sharpe match `pd.Series.mean` / `pd.Series.std(ddof=1)` on each prefix after rounding. The
   sum-of-squares shortcut fails this.
3. Empty cohorts:
   - a date on which a cohort has no non-NaN `flow_inv`, which leaves the cohort's window as it
     was;
   - a cohort that is empty until a later date (Mode B with no fires on the first dates), which
     stays blank until it reaches 30;
   - a cohort that is all NaN.

**Acceptance:**
1. **Real data.** Read the frame from Neon once, read-only, and feed the same frame to the Phase 1
   `build_rows` (a scratch copy) and the new one. Every field except `run_at` must be equal.
   Running both against Neon one after the other would let an enrichment land in between. Any
   difference is listed for the owner; the expected count is 0, with at most a last-decimal flip
   at a rounding boundary.
2. **Speed.** A one-off synthetic measurement, recorded in the implementer's report, not a
   committed timed test: 700 dates over 6.2M fires, loop under 10 s on the workstation.

Files (2): `scripts/daily_tracker.py`, `scripts/test_report_cli.py`.

## Data dependencies

None:
- no migration and no env var;
- no new R2 key: the state and the dated snapshots keep their keys, and the state is rewritten
  whole every night, as it already is;
- the Neon read is unchanged (one SELECT over `lottery_finder_fires`).

## Open questions (defaults in bold)

**A. A date the stored state had has no row tonight (owner). Decided 2026-11-22: (c).** The
options:
- **(a) Fail and write nothing but the log.**
  - The run exits 1, so the `nightly-tape` cron monitor goes ERROR (`nightly/src/main.py`:
    `_STEP_SUCCESS` is `{ok, partial}`).
  - It stays red every night until someone deletes the state by hand, and that hides a new
    failure such as a tape that didn't land. A repeat event on an open Sentry issue emails
    nobody.
  - No dated snapshot is written for those nights.
- **(b) Publish tonight's snapshot, keep the old state, and fail.** Same red monitor every night,
  but each night's view is kept.
- **(c) `partial` with a fixed phrase, publishing the snapshot and the state.**
  - It reports to Sentry once and keeps the run's exit code green.
  - The next night compares against the new state, so it doesn't repeat.
  - The lost date's row stays in the previous night's snapshot.
  - A transient loss, such as an enrichment that leaves one day's outcomes empty and fills them
    the next night, alerts once and heals on its own.
- **(d) Log it and report `ok`.**

**Default: (c).** It needs one new fixed phrase. `tracking dates dropped` replaces the
`tracking state shrank` failure; a new phrase is a new Sentry issue group.

**B. Log how many earlier rows changed since last night (owner). Decided 2026-11-22: yes.** One
tracker line,
`[track] {r} of {m} earlier rows changed`, counting the dates in both files whose fields other
than `run_at` differ. Without it, a revision of history is visible only by diffing two snapshots
by hand. It goes to the step's log in R2, not to Sentry. **Default: yes.** It costs one line in
Phase 1 and its test.

1. **Local `make update`.** `Makefile:277` runs the tracker on the git-tracked
   `docs/tmp/lottery-tracking.csv`. After Phase 1 each local run rewrites that file whole, so
   git shows a full-file diff instead of one appended line. **Default: accept it.** The R2 state
   is the live series, and the pre-11-22 rows stay at f9f220fa9. The alternative is a git-ignored
   output path, a Makefile change outside this plan.
2. **The seed's tracking rule** (`SEED_RULES` in `nightly/src/seed_research.py`; also the
   example key in several `nightly/tests/test_seed_research.py` tests). After Phase 2 a new
   bucket needs no seeded tracking state. **Default: leave the rule.** The seed is a one-time
   tool that already ran, it never overwrites, and removing the rule means reworking those tests
   for no behaviour change. The README's seed text gets one sentence saying the tracking row is
   no longer needed (Phase 2).
3. **Record the weights version on each row** (a new column at the end, which the header
   contract allows). **Default: no.** Every row of a night's file uses the same version, and the
   log names it.
4. **When to do Phase 3.** **Default: right after Phase 2.** It is one function and the code is
   fresh. Without it, the budget holds for about two years, and longer given the time the
   earlier steps leave.

## Out of scope

- The promotion itself (phase 4 Task 23).
- The other research steps.
- The seed, beyond the README sentences in Phase 2.
- Charting the series.

## As built (2026-11-22)

All three phases were built on `feat/nightly-phase3` and pushed together.

| Commits | Scope |
|---|---|
| b21c7cf6f | This plan |
| db8cbe2fe, 86177994d | Phase 1 |
| c0c21a5e9, 9f8b11bab, bf1b3db35 | Phase 2 |
| aa59bac3f, fa4396188 | Phase 3 |
| 98789f8f2, dba5673b8 | The final whole-branch review's fixes |

Each phase was reviewed and re-reviewed, and then the branch as a whole was.

**Departures from the text above:**
1. **The dropped line names the lost dates.** They are listed ascending, at most 10, then
   `(+k more)`, in the tracker's R2 log only. The step's report and Sentry still carry the count
   and the fixed phrase.
2. **Top-3 ties sort stably (ticker ascending).** The nightly rebuild then doesn't depend on the
   host's numpy sort path, which could flip tied tickers in old rows and count them as changed.
   The edges golden test's tie order moved (HHH before III); no other golden value changed. On the
   real 192-row state there were 0 ties between adjacent top-3 slots.
3. **An old file that can't be read as CSV is reported and replaced, not fatal.** The tracker
   prints `the earlier file could not be read as CSV: nothing to compare`, and the step treats such
   a state as having no header and no dates. A state with no data rows also has no header to keep.
4. **Phase 3's merge shifts each cohort's values by its first non-null flow first.** The plain
   Chan merge lost about nine digits on the 1e8-offset test. The mean is the running sum over the
   running count. There are two known differences from the old prefix `stats()`:
   - a mean that ties exactly at the last printed place can round the other way when the sum is
     inexact;
   - a constant flow gives a Sharpe of 0.0, where pandas' inexact sum gave about 1e15 for 33.3
     a hundred times.

**Measured:**
- **Phase 3 acceptance 1** (one read-only Neon read of 1,159,255 fires, fed to both versions): 0
  of 4,800 fields differ, and `build_rows` went from 4.1 s to 0.4 s.
- **Synthetic, 700 dates over 6.2M fires:** 1.8 s, was 91.8 s.
- **The final review's end-to-end run** (the real tracker through `run_tracking`, moto for R2):
  - a clean night is `ok` with `0 of 192 earlier rows changed`;
  - a lost date is `partial`, sends one Sentry warning and exits 0;
  - the night after is `ok`.

## What the adversarial review changed (2026-11-22)

1. **README timing.** The README edits that name the flag or the fill moved into Phase 1, so the
   docs never describe a flag that's gone.
2. **Lost-dates check:**
   - only strict `YYYY-MM-DD` dates count, so a blank row never fails a night;
   - the old dates are read before the script rewrites the file;
   - the outcome became owner question A, with the monitor and snapshot costs spelled out.
3. **Phase 3 tests.** It gained a large-offset test that the sum-of-squares shortcut fails, and
   the empty-cohort cases.
4. **Phase 3 acceptance:**
   - the real-data check reads Neon once and feeds both versions;
   - the speed check is a one-off measurement, not a timed test.
5. **Runbook.** The drift and troubleshooting lines (82, 90–94, 105) are added to Phase 1. The
   revised-rows count became owner question B.
6. **Cost.** It uses the review's measured scaling, and says 300 s is the reserve, not the
   timeout.
7. **Pointers:**
   - the pre-11-22 rows now point at commit f9f220fa9;
   - the stale README seed line and the step's docstring contract are named in Phase 2.
