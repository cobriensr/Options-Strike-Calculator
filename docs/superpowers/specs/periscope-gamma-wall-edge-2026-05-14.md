# Periscope Gamma-Level Edge Experiment

**Date:** 2026-05-14
**Status:** draft
**Author/owner:** Charles
**Type:** Read-only ML experiment (no production code)

## Goal

Quantify whether the gamma levels Periscope reports (and that the user
trades on) have real predictive edge over price action, or whether the
"walls hold / magnets pull / charm-zero matters" folklore is
indistinguishable from random nearby strikes.

Three pre-registered claims, tested in one script against the
`periscope_analyses.key_levels` field — the MM-attributed levels that
were actually displayed on the Periscope chart at read time:

1. **Gamma walls** — `gamma_ceiling` (above spot) and `gamma_floor`
   (below spot) act as reversal points: when SPX touches a wall, it
   bounces back rather than continuing through.
2. **Magnet** — `magnet` strike predicts the SPX close better than
   the naive "close ≈ spot at read time" predictor.
3. **Charm-zero cross** — SPX crosses `charm_zero` between read time
   and close more often than random strikes at the same distance.

## Why now

- Periscope is the user's primary actionable surface for 0DTE SPX
  (see [[feedback_periscope_over_trace]]). Every read produces
  structured `key_levels` with `gamma_ceiling`, `gamma_floor`,
  `magnet`, `charm_zero`. The data has been accumulating across
  many sessions.
- The user trades stop placement, target placement, and bias decisions
  on these levels. If they don't measurably predict price, the entire
  workflow has a confidence problem worth knowing about. If they do,
  we want to quantify the effect size so we know what edge to expect.
- All required inputs are already in Neon (`periscope_analyses` +
  `spx_candles_1m`). No new ingestion needed. Read-only experiment.

## Why this design is honest

- **Real walls compared to sham walls at the same distance.**
  Without a same-distance baseline, "60% of walls hold" tells us
  nothing — a strike 2pt from spot gets touched every day. The sham
  is a strike at the same distance, opposite direction (no MM
  significance there). Paired test isolates the wall's contribution.
- **Distance-bucket stratification.** Walls within 0–3pt of spot get
  trivially touched. Walls 15+pt away rarely get touched at all.
  Both extremes contaminate the headline. Primary test pooled over
  the 3–15pt range only; per-bucket reported as descriptive.
- **Multiple-comparison control.** Three primary tests pre-registered
  → Bonferroni `α = 0.05/3 = 0.0167` per test. Subgroup breakdowns
  are descriptive, not primary.
- **Single pre-registered primary metric per claim.** No fishing
  across touch tolerances or reversal windows post-hoc. Knobs are
  fixed in this spec before the script runs.
- **No EOD lookback for in-the-moment fields.** All wall identities
  come from `key_levels` captured at `read_time`. Future price action
  is measured strictly after `read_time` — no peek-ahead.

## Pre-flight check (do this BEFORE writing the script)

Run via psql or a one-off query:

```sql
SELECT
  COUNT(*) FILTER (WHERE mode IN ('pre_trade','intraday'))                                AS reads_pretrade_intraday,
  COUNT(*) FILTER (WHERE mode IN ('pre_trade','intraday')
                   AND key_levels->>'gamma_ceiling' IS NOT NULL
                   AND key_levels->>'gamma_floor'   IS NOT NULL)                          AS reads_with_both_walls,
  COUNT(*) FILTER (WHERE key_levels->>'magnet'      IS NOT NULL)                          AS reads_with_magnet,
  COUNT(*) FILTER (WHERE key_levels->>'charm_zero'  IS NOT NULL)                          AS reads_with_charm_zero,
  COUNT(DISTINCT trading_date)                                                            AS distinct_days
FROM periscope_analyses;
```

**Power thresholds (informal, not formal power analysis):**
- If `reads_with_both_walls < 30` → flag underpowered, report
  descriptively only; do not draw conclusions.
- If `reads_with_both_walls ≥ 60` → run primary tests as specified.
- If between 30 and 60 → run, but flag wide CIs.

## Data pipeline

### Source 1 — `periscope_analyses`

For every row where:

```sql
mode IN ('pre_trade','intraday')           -- exclude debrief
AND read_time < ((trading_date + INTERVAL '15 hours') AT TIME ZONE 'America/Chicago')
                                            -- read strictly before 15:00 CT same day (DST-safe)
AND key_levels IS NOT NULL
```

Extract per row:

| Field | Source |
|---|---|
| `read_id` | `id` |
| `trading_date` | `trading_date` |
| `read_time_utc` | `read_time` |
| `spot_at_read` | `spot_at_read_time` |
| `mode` | `mode` |
| `calibration_quality` | `calibration_quality` |
| `wall_ceiling` | `key_levels->>'gamma_ceiling'::numeric` |
| `wall_floor` | `key_levels->>'gamma_floor'::numeric` |
| `magnet` | `key_levels->>'magnet'::numeric` |
| `charm_zero` | `key_levels->>'charm_zero'::numeric` |

### Source 2 — `spx_candles_1m` (compat view; underlying table `index_candles_1m`)

For each `(trading_date, read_time_utc)`, pull all bars where:

```sql
date = trading_date
AND timestamp >= read_time_utc
AND timestamp <= ((trading_date + INTERVAL '15 hours') AT TIME ZONE 'America/Chicago')
                                                       -- DST-safe 15:00 CT cutoff
AND market_time = 'r'                                  -- regular hours only
```

Columns used: `timestamp`, `close`. (`high`/`low` available for
touch-tolerance sensitivity if needed but not part of primary test.)

`spx_close` = last bar's `close` for that day.

## Per-event measurement (Claim 1: walls)

Each read produces **two wall events**: one for `wall_ceiling`, one for `wall_floor`.
For each event:

```python
def measure_wall(read, bars, wall_strike, wall_type):
    distance_initial = abs(wall_strike - read.spot_at_read)
    bucket = (
        "0-3"  if distance_initial < 3 else
        "3-7"  if distance_initial < 7 else
        "7-15" if distance_initial < 15 else
        "15+"
    )
    # Touch: any 1-min bar where close is within ±1.0 of wall
    touch_mask = (bars.close - wall_strike).abs() <= 1.0
    if not touch_mask.any():
        return Event(touched=False, ...)
    t_touch = bars.loc[touch_mask].timestamp.min()
    # Look 15 min ahead
    t_post = t_touch + timedelta(minutes=15)
    bars_post = bars[bars.timestamp <= t_post]
    if bars_post.empty:
        return Event(touched=True, classification="censored", ...)
    post_price = bars_post.close.iloc[-1]
    # Reversal sign: positive = moved away from wall toward spot
    if wall_type == "ceiling":
        reversal_signed = read.spot_at_read - post_price  # neg = continued up past wall
    else:  # floor
        reversal_signed = post_price - read.spot_at_read  # neg = continued down past wall
    if reversal_signed >= 2.0:
        classification = "held"
    elif reversal_signed <= -2.0:
        classification = "broken"
    else:
        classification = "stalled"
    breached_eod = (
        bars.close.iloc[-1] > wall_strike if wall_type == "ceiling"
        else bars.close.iloc[-1] < wall_strike
    )
    return Event(
        touched=True, distance_initial=distance_initial,
        bucket=bucket, classification=classification,
        reversal_signed=reversal_signed,
        breached_eod=breached_eod, ...
    )
```

### Pre-registered knobs (FIXED, do not tune post-hoc)

| Knob | Value | Rationale |
|---|---|---|
| Touch tolerance | ±1.0 SPX point | Tighter than 5pt strike grid; loose enough not to miss intra-bar touches |
| Reversal threshold | ±2.0 SPX points | Roughly 1× typical 1-min SPX bar range; meaningful but not noise |
| Reversal window | 15 minutes post-touch | Long enough for one full hedge cycle; short enough to attribute to the wall |
| Distance buckets | `[0,3), [3,7), [7,15), [15,∞)` | Reflect "trivially close" / "near" / "tactically meaningful" / "out of reach" |
| Primary distance pool | `[3, 15)` | Excludes trivial touches and thin-N far walls |

## Per-event measurement (Claim 2: magnet)

For each read where `magnet IS NOT NULL AND |magnet - spot_at_read| ≥ 3`:

```python
err_magnet = (spx_close - read.magnet) ** 2
err_naive  = (spx_close - read.spot_at_read) ** 2
delta      = err_magnet - err_naive   # negative = magnet beat naive
```

Subset to `|magnet - spot_at_read| ≥ 3` because if magnet sits on
top of spot, "magnet predicts close" is a trivial repeat of "spot
predicts close" and the test is uninformative.

## Per-event measurement (Claim 3: charm-zero cross)

For each read where `charm_zero IS NOT NULL`:

```python
crossed_real = ((bars.close - read.charm_zero).iloc[0] *
                (bars.close - read.charm_zero).iloc[-1]) < 0
# Sham: same-distance, opposite-side strike from spot_at_read
distance      = read.charm_zero - read.spot_at_read
sham_strike   = read.spot_at_read - distance   # mirror across spot
crossed_sham  = ((bars.close - sham_strike).iloc[0] *
                 (bars.close - sham_strike).iloc[-1]) < 0
```

Paired comparison: does the real charm-zero cross more or less
frequently than its mirror?

## Statistical plan

### Primary tests (pre-registered, Bonferroni-corrected)

**Walls primary metric definition (unambiguous):**

For each event, define `success = 1` if `touched=True AND classification='held'`, else `0`. A wall that was never touched contributes `success=0` (it did not deliver a usable reversal during the session). Sham gets the identical definition. This avoids conditioning on touch — which would bias the test since whether a sham gets touched is itself outcome-correlated.

Pair per `(read_id, wall_type)`: each read+wall_type produces one `(real_success, sham_success)` pair.

| Claim | Test | Required p | Effect size minimum |
|---|---|---|---|
| 1. Walls | Paired McNemar (exact, two-sided) on `success` for real vs sham, restricted to events with `bucket ∈ {3-7, 7-15}` | `< 0.0167` | `P(real_success=1) − P(sham_success=1)` ≥ 10 percentage points |
| 2. Magnet | Wilcoxon signed-rank on `delta = err_magnet − err_naive` over reads with `\|magnet − spot\| ≥ 3` | `< 0.0167` | Median `delta` < 0 with `\|median(delta)\|` ≥ 1 SPX point² |
| 3. Charm-zero | Paired McNemar (exact, two-sided) on `crossed_real` vs `crossed_sham` over reads with `\|charm_zero − spot\| ≥ 1` (degenerate-pair filter) | `< 0.0167` | `\|P(crossed_real) − P(crossed_sham)\|` ≥ 10 percentage points (direction not pre-specified — either sign counts) |

### Secondary (descriptive, NOT used for accept/reject)

- Per-distance-bucket reversal rate, real vs sham (walls)
- Per-`mode` (`pre_trade` vs `intraday`) breakdown for each claim
- Per-`calibration_quality` breakdown for each claim
- EOD breach rate for walls (Design B sanity check)
- Mean signed reversal magnitude (continuous metric, not just classification)

### Threats to validity (must be flagged in findings.json)

- **SPX cash ≠ tradeable.** Walls "holding" on the cash index doesn't
  automatically mean option premium reverts. A positive result is
  necessary but not sufficient for tradeable edge.
- **Multiple reads per day are not strictly independent.** Same-day
  dealer book is correlated. Sensitivity check: rerun primary tests
  using one read per `(trading_date, mode)` (first of day for each
  mode) and report whether conclusions change.
- **Selection effect on `key_levels` non-null.** Reads where Claude
  couldn't extract levels are excluded — those may be exactly the
  reads where MM positioning was unclear / unstable. Acknowledged
  caveat; cannot be fixed without re-reading source images.
- **Calibration-quality filter not applied to primary.** Including
  all reads regardless of `calibration_quality` to avoid p-hacking
  the high-quality subset post-hoc. Quality breakdown is descriptive
  only.

## Outputs

### Script

`ml/src/periscope_eda/05_gamma_wall_reversal.py` — single Python
script, runs via `ml/.venv/bin/python ml/src/periscope_eda/05_gamma_wall_reversal.py`.

Reads `DATABASE_URL` from `.env.local` via the existing
`ml/src/utils/` patterns. No writes to Neon. No new tables.

### Artifacts produced

1. **`ml/findings.json`** — append three entries (one per claim):
   ```json
   {
     "experiment": "periscope-gamma-wall-edge",
     "claim": "walls_hold",
     "run_date": "2026-05-14",
     "n_events": 187,
     "primary_metric": "real_hold_rate - sham_hold_rate",
     "value": 0.142,
     "p_value": 0.008,
     "passes_bonferroni": true,
     "effect_size_meets_threshold": true,
     "threats_to_validity": ["SPX cash != tradeable", "..."],
     "notes": "..."
   }
   ```
2. **`ml/plots/periscope_eda/gamma_wall_reversal.png`** — bar chart,
   hold rate by distance bucket, real vs sham, with bootstrap 95% CIs.
3. **`ml/plots/periscope_eda/gamma_wall_distribution.png`** —
   histogram of `distance_initial` so we can see where data lives.
4. **`ml/plots/periscope_eda/magnet_predictor_quality.png`** — scatter
   of `|magnet - spot|` (x) vs `|spx_close - magnet|` (y), with naive
   y = `|spx_close - spot|` overlaid; diagonal line where magnet beats
   naive.
5. **`ml/plots/periscope_eda/charm_zero_cross_rates.png`** — bar chart,
   cross rate real vs sham by distance bucket.
6. **`ml/exports/gamma_wall_events.csv`** — per-event data (one row
   per `(read_id, claim)`) for ad-hoc slicing in a notebook later.

### What we do NOT build in this experiment

- No production code (no api/, no cron, no frontend).
- No new DB tables (read-only).
- No retroactive backfill or new ingestion.
- No "trade simulation" — that's a separate experiment if claim 1 passes.

## Decision tree (post-experiment)

| Walls | Magnet | Charm-zero | Implication / next step |
|---|---|---|---|
| Pass | — | — | Worth a follow-up: does the wall edge survive translation to SPX option premium? (Separate experiment) |
| Fail | — | — | The "walls hold" claim is unsupported on user's actual read set. Reconsider stop-placement workflow. |
| — | Pass | — | Magnet can become a feature in the analyze prompt context (predicted EOD level) |
| — | Fail | — | Drop magnet language from periscope debrief framing — it's not adding information beyond spot |
| — | — | Pass | Charm-zero is a real intraday-direction signal — possible analyze-prompt feature |
| — | — | Fail | Charm-zero is decorative; deprecate from key_levels emphasis |

## Open questions (must answer before implementation)

- None. All knobs and design choices are pre-registered above.

## References

- Memory: [[project_periscope_naive_vs_mm_gex]] — why we test
  `key_levels` (MM-attributed) not `ws_gex_strike_expiry` (naive)
- Memory: [[feedback_periscope_no_cheat_reads]] — no peek-ahead;
  measurement window strictly post `read_time`
- Memory: [[feedback_no_silent_methodology_changes]] — pre-register
  knobs; flag deviations
- Code: `api/_lib/periscope-chat-runner.ts:186-189` — definition of
  `key_levels` fields
- Code: `api/_lib/db-migrations.ts:3340` — `ws_gex_strike_expiry`
  schema (not used here)
- Code: `api/_lib/db-migrations.ts:3880` — `periscope_analyses`
  schema (primary input)
- Existing companion scripts: `ml/src/periscope_eda/01-04` —
  established patterns for confidence calibration, regime bias, EV,
  embedding cluster
