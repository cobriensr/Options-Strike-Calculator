# Lottery Finder Pipeline — append a new trading day

When the user drops a new daily parquet (`2026-MM-DD-trades.parquet`)
into `/Users/charlesobrien/Desktop/Bot-Eod-parquet/`, this is the
sequence to extend the analysis and load the new fires into Postgres.

**Source of truth:** `docs/superpowers/specs/lottery-finder-2026-05-02.md`
**Validation log:** `PIPELINE_STATE.md` (this directory) — append after every run.

---

## Prerequisites

- Repo at `/Users/charlesobrien/Documents/Workspace/strike-calculator`
- Python venv at `ml/.venv` — use `ml/.venv/bin/python` explicitly, never system `python3`
- New parquet file dropped into `/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-MM-DD-trades.parquet`
- Local Postgres connection: `DATABASE_URL` exported (e.g. via `vercel env pull .env.local`)

---

## Pipeline (sequential — each step depends on prior)

### Step 1: Re-run v4 trigger detection

```bash
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p14_event_trigger.py
```

- Auto-discovers all `*-trades.parquet` files (no list to update).
- Output: `outputs/p14_event_triggers.csv` (overwrites).
- Expected runtime: ~10 min for 15 days, +1 min per added day.

### Step 2: Fix UTC→CT timezone (one-time per p14 re-run)

```bash
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p16_fix_tz.py
```

- Modifies `outputs/p14_event_triggers.csv` in place.
- Idempotent — safe to re-run.

### Step 3: Re-run canonical realized exits

```bash
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p26_canonical_realized.py
```

- Output: `outputs/p26_per_trade_realized.csv`, plus per-ticker and per-setup summary files.
- Adds `mode`, `flow_quad`, `tod`, `reload` discriminators + the realized exit policies.

### Step 4: Re-run policy grid (only if exit policy is being re-evaluated)

```bash
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p27_exit_policy_grid.py
```

- Output: `outputs/p27_policy_grid.csv`, `outputs/p27_policy_summary.csv`.
- Required if the production rule's exit policy is being changed; otherwise optional but cheap.

### Step 5: Re-run lottery discriminator + stress test

```bash
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p28_lottery_discriminator.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p29_stress_test.py
```

- p28: validates cheap-call-PM still has ≥1.5× lottery lift.
- p29: validates the rule isn't entirely driven by 1-2 outlier days (LOO + bootstrap).

### Step 5b: Re-run macro feature validation (informational)

```bash
npx tsx docs/tmp/options-flow-analysis/scripts/dump_macro_tables.ts
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p30_macro_features.py
ml/.venv/bin/python -u docs/tmp/options-flow-analysis/scripts/p31_put_regime_rule.py
```

- `dump_macro_tables`: pulls latest `flow_data`, `spot_exposures`, `strike_exposures` from Neon to local CSV.
- p30: re-validates the macro-vs-rule discriminator analysis.
- p31: re-validates the put regime-switching rule.

**Pass criteria (informational):** if EITHER macro AND-rule beats the
cheap-call-PM-only baseline by ≥10% on top-3/day total $ realized,
**open a new spec** to upgrade the selector. **Do NOT change the rule
silently.** At v0.1: both macro AND-rules underperformed; we re-test
as data grows.

### Step 6: Verify selection rule still holds (PASS / FAIL)

**Pass criteria — ALL must hold:**

- p28 cheap-call-PM lottery rate ≥ 1.5× baseline (Q5 lift in univariate sweep)
- p29 LOO: at least 40% of days profitable under `act30_trail10`
- p29 bootstrap: at least 80% of resampled windows profitable under `act30_trail10`

**If FAIL on any:** regime change detected. Open a new spec at
`docs/superpowers/specs/lottery-finder-rule-rederivation-YYYY-MM-DD.md`
to investigate. **Do NOT silently update the production rule.**

### Step 7: Append the new day's fires to Postgres

```bash
DATABASE_URL=... node scripts/backfill-lottery-fires.mjs
```

- Reads `outputs/p14_event_triggers.csv`, `outputs/p26_per_trade_realized.csv`,
  and (optional) `outputs/p27_policy_grid.csv`.
- INSERTs into `lottery_finder_fires` with
  `ON CONFLICT (option_chain_id, trigger_time_ct) DO NOTHING` —
  idempotent across re-runs; only the new day's rows actually land.
- Macro snapshot columns are NULL on backfill (the macro tables don't
  have data for the historical window — see spec Appendix A for why
  this is fine: macro is display-only, not a selection signal).

Run with `DRY_RUN=1` first to see counts:

```bash
DRY_RUN=1 node scripts/backfill-lottery-fires.mjs
```

### Step 8: Update production rule (only if Step 6 PASS)

The production rule lives in `api/_lib/lottery-finder.ts` as constants:

```ts
LOTTERY_SPEC_V4 = {
  volToOiWindowMin: 0.05,
  volToOiCumMin: 0.1,
  ivMin: 0.35,
  absDeltaMin: 0.13,
  askPctMin: 0.52,
  dteMax: 7,
  cntWindowMin: 5,
  cooldownMin: 5,
};
// + isCheapCallPm() entry < $1, type = 'C', tod = 'PM'
// + isReload() burst ≥ 2× AND entry dropped ≥ 30%
```

If p28's univariate sweep suggests a tighter or looser threshold:
update with explicit comment + commit message citing the analysis date
and supporting metric. Re-run the unit tests in
`api/__tests__/lottery-finder.test.ts` afterwards.

### Step 9: Update validation log

Append an entry to `PIPELINE_STATE.md` (this directory) with the date
added, the p28/p29 numbers, the verdict, and any notes. The schema is
documented at the top of that file.

---

## Troubleshooting

**`p14_event_trigger.py` says "0 fires" on the new day.**
Most common cause: the new parquet has zero ticks in the regular
session window (08:30-15:00 CT). Verify with:

```bash
ml/.venv/bin/python -c "
import pyarrow.parquet as pq
import pandas as pd
df = pq.read_table('/Users/charlesobrien/Desktop/Bot-Eod-parquet/2026-MM-DD-trades.parquet').to_pandas()
df['ts_ct'] = df['executed_at'].dt.tz_convert('America/Chicago')
df['hm'] = df['ts_ct'].dt.hour * 60 + df['ts_ct'].dt.minute
print((df['hm'] >= 510).sum(), 'in-session ticks')
print(df['ts_ct'].min(), '→', df['ts_ct'].max())
"
```

**`backfill-lottery-fires.mjs` errors `relation \"lottery_finder_fires\" does not exist`.**
The Vercel migrate-db hasn't been deployed yet (or you're pointing at a
fresh DB). Run the local migration first:

```bash
DATABASE_URL=... npx tsx scripts/migrate-db.ts
```

**`backfill-lottery-fires.mjs` reports `dropped (bad ts)` larger than expected (>5% of rows).**
Usually means `p14` ran before `p16_fix_tz` — the timestamps are
naively-localized strings that don't have a TZ offset. Re-run Step 2
and try again.

**p29 stress test reports < 80% bootstrap win rate.**
Either (a) the new day was a true regime shift, or (b) the universe is
now too small to bootstrap reliably. Don't change the production rule
unless the failure persists across two consecutive new-day appends.
