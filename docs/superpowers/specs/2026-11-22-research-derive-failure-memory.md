# research-derive: remember days that keep failing

Status: approved by the owner 2026-11-22. Question A (a failed retry stays green and backs off)
and question B (a day that kills the run is counted) both take their defaults. It follows the
phase 3 owner item "the failure cap has no memory". Two adversarial reviews were done on
2026-11-22; what they changed is at the end.

## Goal

A day that fails to derive session after session stops being retried every night, so it no
longer takes one of the step's three failure slots each night, blocks older stale days, kills
the run every night, or turns the run red every night. It alerts once when it is set aside and
is retried automatically later, less and less often while it keeps failing.

## Today

`nightly/src/research_derive.py`, `_derive_days` / `_must_stop`:
- It works through the stale days newest first.
- It stops after `RESEARCH_MAX_DAY_FAILURES` (3, `nightly/src/constants.py`; the comment says
  the cap bounds downloads and Sentry exceptions) failed days in one night, and the rest become
  `days_left`.
- Nothing carries over between nights.
- The step is `failed` (detail `a day failed to derive`) on any night with a failed day.

So:
1. **One day that always fails** makes the step `failed` every night. The `nightly-tape` cron
   monitor stays red (`main.py`: a failed step exits 1), which hides a new failure. Repeat
   events on an open Sentry issue email nobody.
2. **Three such days** stop the step at the cap every night. No older stale day is ever reached.
3. **A day that kills the process** (out of memory, or the watchdog's `os._exit(3)`) is never
   counted. It is tried first every night, and the report steps after it never run.

## Design

### The memory object

It lives at `research/_state/derive-failures.json`, next to `MANIFEST_KEY`. The manifest stays
strict (`{"version", "families"}` only, `_checked_families`), so a rollback to today's code
still reads it. The shape:

```json
{"version": 1,
 "attempting": {"day": "YYYY-MM-DD", "session": "YYYY-MM-DD"} | null,
 "days": {"YYYY-MM-DD": {"nights": n, "target": "<key>", "last_session": "YYYY-MM-DD" | null,
                         "set_aside_on": "YYYY-MM-DD" | null, "retry_days": 7}}}
```

- `target`: the day's stale target, meaning its families and their target fingerprints joined in
  FAMILIES order. A tape re-landed under a new ETag, a `CHAINS_VERSION` or `DERIVE_VERSION`
  bump, or changed fires changes it.
- `nights`: failed **sessions**, keyed by `ctx.last_session`.
  - A re-run on the same session (`railway cron run`) never counts a second one.
  - Unlike the refit's `deferred_nights`, which is keyed by the run's UTC date, two runs that
    share a session after a mid-week holiday count once. That is harmless.
- `attempting`: the one day in flight (the loop is sequential) and the session it was tried on.
  `null` between days.

### Reading it

- **Missing object:** an empty memory.
- **Malformed body:** logged by class and treated as empty. The next save replaces it.
- **A read the store can't make** (an error that propagates from the store after its retries):
  logged by class. That night runs with **no conversion, no filter, no marker and no saves**, so
  a valid stored memory is never overwritten from an empty one. The step outcome is otherwise
  unchanged.

### Planning (before the loop, in this order)

1. **Count.** `days_planned` counts tonight's stale days.
2. **Prune.** Drop every entry whose day is not in tonight's stale set. Clear `attempting` if its
   day is not stale: a day that derived and saved its manifest before the kill is fresh, and
   must not count as a failure.
3. **New situation.** An entry whose `target` differs from the day's target tonight becomes a
   new day: `nights=0`, `last_session=null`, `set_aside_on=null`, `retry_days=7`.
4. **Convert a leftover marker** (`attempting` still set, its day stale): the run that tried it
   died. That counts as one failed session for that day, keyed by the marker's `session`, not
   tonight's.
   - If `last_session` already equals it, nothing more is counted.
   - If the day is a retry (`set_aside_on` set), it is a **failed retry** (below).
   - Otherwise `nights` +1, `last_session` = the marker's session, and if `nights >= 3` the day
     is **set aside** (below).
   - Then clear `attempting`.
5. **Filter.** A day with `set_aside_on` set is skipped while `ctx.last_session − set_aside_on`
   is less than `retry_days` calendar days, and is counted in `days_set_aside`. When the age is
   reached it stays in the loop as a **retry**.

The counts add up on every path: `days_derived + days_failed + days_retry_failed +
days_tape_missing + days_left + days_set_aside == days_planned`.

### In the loop

**Before a day:** check `_must_stop` first, as today. A day left for the budget or the cap is
never marked. Then set `attempting` = `{day, tonight's session}` and save.

**After the day,** one save that records the outcome and clears `attempting`:
- **Derived:** the entry is removed.
- **Tape missing:** no change to the entry. Only `attempting` is cleared.
- **Failed, not a retry:**
  - counted in `days_failed`, and `capture_exception` as today;
  - if `last_session` differs from tonight: `nights` +1 and `last_session` = tonight;
  - if `nights >= RESEARCH_SET_ASIDE_NIGHTS` (3), the day is **set aside**.
- **Failed retry:** counted in `days_retry_failed`, **not** in `days_failed`, so it never fails
  the step.
  - `capture_exception` still goes out, for the diagnosis. It joins the open issue for that
    exception, so it emails nobody.
  - The day is set aside again: `set_aside_on` = tonight (or the marker's session, for a
    conversion) and `retry_days` doubles, 7 → 14 → 28 (`RESEARCH_SET_ASIDE_RETRY_DAYS_MAX`).
  - No second set-aside warning.

**The cap.** `_must_stop` counts `days_failed + days_retry_failed` against
`RESEARCH_MAX_DAY_FAILURES`, so retries can't bypass the bound on downloads and exceptions. Only
`days_failed` decides the status.

**SIGTERM.** SIGTERM becomes `SystemExit(143)` and unwinds through `_derive_day`'s `finally`
(`main.py`). On `SystemExit`, clear `attempting` with a best-effort save, so a SIGTERM shutdown
(a redeploy) is never counted. A SIGKILL, an out-of-memory kill or the watchdog's `os._exit`
leaves the marker, and the next night counts it.

**Saves.** Each save writes the whole object. That is two PUTs per day tried, about 40 on a
20-day catch-up night; R2 PUTs are cheap and the manifest already writes one per day. If a save
fails, it is logged by class and the step outcome stays as it was. A later save carries the
change, because each save writes the whole object.

### Set aside, and the warning

A day is set aside with `set_aside_on` = the session it failed on and `retry_days` = 7. It then
sends one `sentry_sdk.capture_message("nightly research day set aside", level="warning")`
directly from `research_derive.py`, as `outcome_check.py` and `tape_job.py` do.
- Tags: `step` and `day`.
- Explicit fingerprint `["nightly research day set aside", day]`, so it is one issue per day.
- Extra: `cause`, which is the exception class of the failure that crossed the threshold, or the
  fixed phrase `run died` when a marker conversion did.
- No row data and no exception text.
- A day set aside again after a new situation re-uses its issue. Resolve the issue when the cause
  is fixed, or the repeat emails nobody.

### Status

Tonight's attempts decide it, as today:
- `failed` when `days_failed` > 0;
- a skipped set-aside day and a failed retry are not failures.

So the night a day crosses the threshold by raising is `failed`. A day set aside by a marker
conversion sends its warning, and that night's status comes from its own attempts. The dead run
before it was already a failed cron check-in.

### What else changes

- **The chains object.** A set-aside day is not tried, so its chains object is not rewritten.
  Today it is put every night before the fire family raises. With the target unchanged, that
  object is the same tape at the same version, so the rollup reads identical content. Accepted.
- **Overlapping runs.** A manual `railway cron run` that overlaps the scheduled run reads the
  other run's marker as a kill and counts one session. Both runs also overwrite each other's
  memory, as they already do the manifest. The README says not to overlap runs.

## Files

| File | Change |
|---|---|
| `nightly/src/research_derive.py` | Memory, planning order, marker, loop, warning, counts, docstring |
| `nightly/src/constants.py` | `RESEARCH_SET_ASIDE_NIGHTS = 3`, `RESEARCH_SET_ASIDE_RETRY_DAYS = 7`, `RESEARCH_SET_ASIDE_RETRY_DAYS_MAX = 28` |
| `nightly/tests/test_research_derive.py` | The tests below, plus the rework of the tests that assume the manifest is the only `put_json` (~779–787, an exact PUT list; ~1410–1436, where the first `put_json` fails, which is now the marker's) |
| `nightly/README.md` | The derive section, the alert table, the `_state/` layout row, the push-hazard sentence (~184–185), the "failure cap has no memory" paragraph (~1273–1281) and the overlap line |

One phase, 4 files. These are nightly watch paths: push after 15:00 CT and outside 07:15–12:30
UTC.

## Tests

**Set aside and retry:**
- A day failing on sessions 1, 2 and 3 is set aside on session 3, with one warning (`cause` =
  the class). On the next session it is skipped and the step is `ok`, given nothing else failed.
- A re-run on the same session doesn't count a second session.
- The day is retried at 7 calendar days.
  - A success removes the entry.
  - A failure is a failed retry: `days_retry_failed` 1, the step not failed, `retry_days` 14,
    no second warning. Then 28, and it stays 28.
- A failed retry counts toward the per-night cap.

**Killed runs:**
- A leftover marker counts one session for its day, keyed by the marker's session.
- Three killed sessions set a day aside, with the warning (`cause` = `run died`).
- A re-run on the same session after a kill counts once.
- A killed retry is a failed retry.
- A marker whose day is no longer stale is dropped, with no count and no warning.
- SystemExit (SIGTERM) clears the marker.
- A day left by `_must_stop` is never marked.

**Bookkeeping:**
- A tape-missing day clears its marker and keeps its entry.
- A changed target (ETag, fires or version) resets the day.
- Three always-failing days no longer block older stale days once they are set aside.
- A malformed or missing memory is treated as empty. A store error on the read means no
  conversion, filter, marker or save that night, and the stored object is untouched.
- A save failure is logged and the outcome is unchanged.
- Pruning drops entries for days that are no longer stale.
- The counts add up to `days_planned` on every path; extend
  `test_the_counts_add_up_to_the_days_planned`.
- Nothing logged or reported carries row data or exception text.

## Thresholds

| Constant | Value | Why |
|---|---|---|
| `RESEARCH_SET_ASIDE_NIGHTS` | 3 | Matches the per-night cap of 3 |
| `RESEARCH_SET_ASIDE_RETRY_DAYS` | 7 | A weekly first retry catches an outside cause clearing (an R2 or Neon issue) with no one stepping in |
| `RESEARCH_SET_ASIDE_RETRY_DAYS_MAX` | 28 | The back-off doubles to here and stays there; a day that never recovers costs one attempt a month |

## Decided

- **A (owner, 2026-11-22):** a failed retry doesn't fail the step. It is counted in
  `days_retry_failed`, set aside again, and `retry_days` doubles to 28 at most.
- **B (owner, 2026-11-22):** the `attempting` marker. A day that kills the run is counted
  through it.
- **`enrich-outcomes`** has the same per-night cap (`ENRICH_MAX_DAY_FAILURES = 3`) with no
  memory. It is out of this change: a day that fails enrichment leaves fires without outcomes,
  and setting it aside quietly would hide missing data. Its own `failed` status alerts every
  night it fails. `outcome-check` covers only the last 3 sessions. Revisit separately.
- **Clearing a set-aside day by hand:** no tool. A new situation or a retry clears it, and
  deleting the memory object clears all of them (the README says so).

## Out of scope

- The manifest's format.
- The other research steps.
- The enrich step.

## What the adversarial reviews changed (2026-11-22)

Review 1:
- A changed target is now a new day.
- Re-runs on the same session don't count twice.
- A store error on the read doesn't lead to an overwrite.
- Saves happen per change, not once after the loop.
- The warning is sent directly, with a per-day fingerprint.
- Smaller fixes: the retry age is in calendar days, the count sum is defined, stale entries are
  pruned, the push rule is complete, and the enrich reason is corrected.
- A failed retry and a killed day became owner questions A and B.

Review 2:
- A killed retry is a failed retry, and the threshold is `>=` (this was the blocker).
- The marker got a defined shape and its own session, and the planning order was fixed (prune
  before converting).
- The marker is set after `_must_stop`, a tape-missing day clears it, and SIGTERM clears it.
- The PUT count is stated honestly.
- Failed retries count toward the per-night cap but not toward the status.
- The set-aside warning's `cause` was defined, and so was the status on a conversion night.
- The tests for B were added.
- `nights` are named as sessions.
- The unchanged chains object and the overlapping-run case are documented.
- The stale README passages and the tests to rework are listed.
