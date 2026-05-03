# Lottery Finder — Extending the Historical Window (bulk multi-month load)

When the parquet archive grows by a multi-month chunk (e.g. Jan-Feb-Mar 2026
plus the rest of April), this is the procedure. Different from
[PIPELINE.md](./PIPELINE.md) — that one is for appending a single new
trading day; this one is for bulk re-derivation against a much larger
universe where the production rule itself needs to be re-validated.

**Read this top-to-bottom before running anything.** The 15-day seed
window in [PIPELINE_STATE.md](./PIPELINE_STATE.md) had 88% of its
realized P&L concentrated in one day — bigger samples can flip the
verdict, and you don't want to discover that mid-pipeline.

---

## When to use this doc vs PIPELINE.md

| Situation | Doc |
|---|---|
| One new trading day dropped, last night | PIPELINE.md |
| Multiple weeks added to the archive at once | This doc |
| Re-running because the rule started losing money | This doc + `lottery-finder-rule-rederivation-YYYY-MM-DD.md` spec |

---

## Step 0: Inventory the new parquet files

Confirm the new files actually landed and the date coverage has no gaps.

```bash
ls -la /Users/charlesobrien/Desktop/Bot-Eod-parquet/*.parquet \
  | awk '{print $NF}' | xargs -n1 basename | sort
```

**Expected file count for Jan-Apr 2026 (assuming you got every trading day):**

| Month | Trading days |
|---|---|
| January 2026 | 21 (1st = New Year, 19th = MLK) |
| February 2026 | 19 (16th = Presidents' Day) |
| March 2026 | 22 |
| April 2026 | ~22 (the 13th-30th are already there from the seed window — 14 days; April 1-10 + April 31 May 1 add ~10 more, total ~22) |
| **Total** | **~84 trading days** |

If the count is materially less than ~84, list the gaps explicitly
before continuing — a missing week has compounding consequences for
the LOO + bootstrap stress tests.

```bash
# Quick gap detector — prints any missing weekday in the range.
ml/.venv/bin/python -c "
import pandas as pd, glob, os
files = {os.path.basename(f).split('-trades.parquet')[0]
         for f in glob.glob('/Users/charlesobrien/Desktop/Bot-Eod-parquet/*.parquet')}
weekdays = pd.bdate_range('2026-01-02', '2026-05-01').strftime('%Y-%m-%d').tolist()
missing = sorted(set(weekdays) - files)
print(f'have {len(files)} files; weekdays in range = {len(weekdays)}')
print('missing:', missing if missing else '(none)')
"
```

US market holidays in this window (NOT data gaps):
`2026-01-01` (New Year), `2026-01-19` (MLK), `2026-02-16` (Presidents'),
`2026-04-03` (Good Friday).

---

## Step 1: Sanity-check one new file

Schema drift between the seed window (April) and the older months is
the single thing most likely to silently break the pipeline. Verify
one Jan file matches the April schema before running the heavy
analysis.

```bash
ml/.venv/bin/python -c "
import pyarrow.parquet as pq
old = pq.read_metadata('/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-04-15-trades.parquet')
new = pq.read_metadata('/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-01-15-trades.parquet')
print('OLD schema:', old.schema)
print()
print('NEW schema:', new.schema)
print()
print('OLD nrows:', old.num_rows, ' NEW nrows:', new.num_rows)
"
```

If columns differ, **STOP** and reconcile before running p14. The most
common drift is a column type change (string vs int for `option_chain_id`)
or a renamed column (`tape_time` ↔ `executed_at`).

---

## Step 2: Run the pipeline (same scripts, longer runtimes)

Same as PIPELINE.md Steps 1-5 but the runtimes scale linearly with day
count. Plan ~3-5 hours wall-clock end-to-end for ~80 days.

| Step | Script | 15-day runtime | 80-day estimate |
|---|---|---|---|
| 1 | `p14_event_trigger.py` | ~10 min | ~50-60 min |
| 2 | `p16_fix_tz.py` | <5 sec | <30 sec (in-place) |
| 3 | `p26_canonical_realized.py` | ~5 min | ~30 min |
| 4 | `p27_exit_policy_grid.py` | ~5 min | ~25 min |
| 5 | `p28_lottery_discriminator.py` | ~30 sec | ~2 min |
| 5 | `p29_stress_test.py` | ~1 min | ~5 min |

Run the full chain:

```bash
cd /Users/charlesobrien/Documents/Workspace/strike-calculator
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p16_fix_tz.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p26_canonical_realized.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p27_exit_policy_grid.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p28_lottery_discriminator.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p29_stress_test.py
```

Log everything — pipe stdout/stderr to a dated log file so the next
agent (or future-you) can audit what was actually run:

```bash
LOG=docs/tmp/options-flow-analysis/outputs/extend-history-$(date +%Y%m%d).log
{
  ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py
  # ... etc
} 2>&1 | tee "$LOG"
```

---

## Step 3: Re-validate the production rule (CRITICAL — read carefully)

The cheap-call-PM RE-LOAD rule was derived from a 15-day window with
known concentration on a single outlier day (2026-04-21). Bigger
samples can flip the verdict three ways:

### A. Rule still passes — extend and ship

**Pass criteria — ALL must hold against the bigger window:**

- p28 cheap-call-PM lottery rate ≥ 1.5× baseline (Q5 lift)
- p29 LOO `act30_trail10`: ≥ 40% of days profitable
- p29 bootstrap: ≥ 80% of resampled windows profitable
- **NEW:** No single day contributes > 50% of cumulative cherry-picked
  top-3/day P&L. The 15-day window had one day at 88%; that's the
  fragility we want to see corrected, not preserved.

If all four hold: proceed to Step 4 (backfill).

### B. Rule passes traditional criteria but day-concentration worsens

If criteria 1-3 pass but criterion 4 fails (still one or two outlier
days carrying everything):

- **Do NOT silently extend.** The rule's edge appears to come from
  rare regime days, not the discriminator itself.
- Open a spec at
  `docs/superpowers/specs/lottery-finder-rule-rederivation-YYYY-MM-DD.md`
  to investigate what those outlier days have in common (VIX level,
  macro tide direction, SPX gamma sign, day-of-week, etc.).
- Park the historical backfill at the seed-window state until the
  re-derivation is resolved.

### C. Rule fails outright

Lift ≤ 1.5× OR LOO < 40% OR bootstrap < 80%:

- Regime change confirmed. The rule that worked in mid-April doesn't
  generalize backwards (or the bigger sample exposes that it never
  had real edge in the first place).
- **STOP.** Open the re-derivation spec immediately. Do NOT load the
  new rows into `lottery_finder_fires` — the UI would silently start
  showing alerts derived from a discredited rule.
- Disable the live cron in `vercel.json` until a new rule is derived
  (just rename the schedule to a no-op like `"0 0 31 2 *"` so it
  literally never fires).

Whichever case applies, **always document the decision in
`PIPELINE_STATE.md`** with the exact numbers so future-you can see
the audit trail.

---

## Step 4: Backfill the new fires (only on Step 3 outcome A)

The same script handles bulk and single-day:

```bash
DRY_RUN=1 node scripts/backfill-lottery-fires.mjs
```

Expected dry-run counts (rough — scales with day count):

- p14 rows: ~1.0M (~12k/day × 80 days)
- p26 rows (mode-filtered): ~270k (~3.4k/day × 80 days)
- ready to insert: ~265k (assuming ~5% drop for malformed timestamps)
- RE-LOAD-tagged: ~3,500
- cheap-call-PM tagged: ~8,300

If the dry-run looks right, run for real:

```bash
DATABASE_URL=... node scripts/backfill-lottery-fires.mjs
```

`ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING` skips
already-loaded April fires; only the new Jan-Mar + early-April rows
land. Expected wall-clock at ~265k rows / 500-row batches: ~10-20 min
on a healthy Neon connection.

**Do NOT truncate the table first.** The UI is reading from
`lottery_finder_fires` continuously; a truncate would blank the feed
for the duration of the backfill.

---

## Step 5: Update PIPELINE_STATE.md

Append one entry summarizing the bigger window:

```markdown
## YYYY-MM-DD (bulk-extended to Jan-Apr 2026, ~80 trading days)

- Parquet window: 2026-01-02 → 2026-05-01 (~80 trading days)
- Total v4 fires (p14): X
- Mode A + Mode B fires (p26): X
- RE-LOAD-tagged: X
- cheap-call-PM-tagged: X
- p28 cheap-call-PM lottery rate: X.X% (vs Y.Y% baseline, Z.Zx lift)
- p29 LOO act30_trail10 profitable days: X / Y (Z%)
- p29 bootstrap % > $0 (act30_trail10): X.X%
- Day-concentration: top day = X.X% of cumulative top-3/day P&L
- Verdict: PASS / PARTIAL / FAIL (per Step 3)
- Notes: <regime observations, anomalies, missing days, decisions>
- Run by: <agent name or "user">
```

Also append rows to PIPELINE.md's "Step 9" reminder if you discovered
gotchas that future appends should know about (e.g. "January 2026 had
two FOMC days that generated 3× the daily fire rate — flag for the
analyst").

---

## Step 6: Visual + functional smoke test

After backfill completes:

```bash
DATABASE_URL=... npx tsx -e "
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);
const r = await sql\`SELECT MIN(date), MAX(date), COUNT(*) FROM lottery_finder_fires\`;
console.log(r);
"
```

Expected: `min` ≈ 2026-01-02, `max` ≈ today's bulk-load max,
`count` ≈ 50,819 (existing) + ~265k (new) = ~315k.

Then:

```bash
npm run dev:full
# open http://localhost:5173
# scroll to Lottery Finder section
# scrub the date picker to 2026-01-15 — should populate
# scrub to 2026-02-20 — should populate
# scrub to 2026-04-21 — should show the outlier day's heavy fire count
```

If any date in the new window shows the empty-state message ("No fires
for {date}. Either the detector hasn't fired yet…"), check
`PIPELINE_STATE.md` for known gaps and verify p14 actually emitted
rows for that day:

```bash
ml/.venv/bin/python -c "
import pandas as pd
df = pd.read_csv('docs/tmp/options-flow-analysis/outputs/p14_event_triggers.csv', parse_dates=['date'])
print(df.groupby(df['date'].dt.date).size().sort_index())
" | grep 2026-01-15  # adjust for the missing date
```

---

## Special considerations for the bigger window

### Macro snapshot remains NULL on backfill

The macro context tables (`flow_data`, `spot_exposures`, `strike_exposures`)
only have data from the live cron era forward (~April 2026). Backfilled
fires from Jan-Mar will have NULL macro columns, and the day-level
banner will fall back to the latest fire's snapshot — which on a
back-scrubbed historical day means there's no banner data at all.

**This is correct behavior.** The day banner shows "Regime context will
appear with the first fire of the day" on quiet days; on
pre-cron-era days that message is permanent. If you want to backfill
macro from somewhere else, that's a separate spec — don't try to
shoehorn it into this run.

### Universe drift

The Lottery Finder universe (V3 + EXTENDED ticker lists) was derived
from 2026-04 data. Some of those tickers (USAR, RKLB, RUTW, etc.) may
have had radically different liquidity profiles in Jan-Mar — they
might fire either much more or much less than April expectations.

After Step 4 backfill completes, eyeball:

```sql
SELECT underlying_symbol,
       COUNT(*) FILTER (WHERE date < '2026-04-01') AS pre_april,
       COUNT(*) FILTER (WHERE date >= '2026-04-01') AS apr_to_now
FROM lottery_finder_fires
GROUP BY underlying_symbol
ORDER BY pre_april DESC NULLS LAST;
```

If a ticker has ~0 pre-April fires but ~hundreds in April, it became
liquid in April — informational only, no action needed unless the
re-validation step said the rule failed.

### Fire-detection determinism

The TS port of the v4 detector (`api/_lib/lottery-finder.ts`) and the
Python p14 script have been verified to produce identical outputs at
the boundary semantics that matter (closed='right' rolling window,
cumulative vol/OI as context filter). When the live cron starts
producing fires from Monday onward, they should land in
`lottery_finder_fires` cleanly alongside the backfilled rows — no
duplicates because the dedupe key is `(option_chain_id, trigger_time_ct)`
and the live + backfill paths can't collide on the same trigger
millisecond.

If you DO see suspicious duplicates after a few days of live operation,
re-grep the daemon logs for `option_chain` matches and confirm the WS
daemon is actually subscribed to the right ticker channels (Railway
env: `WS_CHANNELS=flow-alerts,option_trades_lottery`).

---

## Rollback plan

If the bulk backfill goes sideways (wrong rule applied, schema bug,
duplicate rows from a re-run that didn't dedupe properly):

```sql
-- Wipe ONLY the bulk-loaded rows; preserve the live cron's writes.
-- The bulk-load script stamps `enriched_at = NOW()` whereas the live
-- cron leaves it NULL until the future enrich cron runs. So:
DELETE FROM lottery_finder_fires
WHERE date < '2026-04-13'        -- pre-seed window
   OR (date BETWEEN '2026-04-13' AND '2026-05-01'
       AND inserted_at < '2026-05-04 00:00:00+00');  -- adjust to
                                                      -- before today
```

Then re-run the backfill from a clean state. If you can't isolate the
bulk-load rows precisely, ask before doing a full TRUNCATE — that
would blank the live UI for any user with the page open.
