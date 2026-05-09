# LotteryFinder: per-row avg-hold-minutes hint chip

**Date:** 2026-05-08
**Author:** charlesobrien (with Claude Code)
**Status:** DRAFT — pending owner approval before Phase A

## Goal

Mirror the silent-boom `~Nmin` cohort hint chip onto every LotteryRow.
Single number per row sourced from a TS lookup keyed by the fire's
(score_tier, ticker) pair. Tells the user "if this fire is going to
work, expect it to peak around this many minutes from entry."

## Why

- Silent-boom shipped this in commits `759b7b85` / `8c790868` /
  `dbc89092` and the pattern is now well-defined.
- Lottery has 89,319 enriched fires (10× silent-boom) so the
  per-ticker dispersion is genuinely meaningful and worth surfacing.
- Same data plumbing already exists: `lottery_finder_fires` has
  `peak_ceiling_pct` and `minutes_to_peak`; the API already serves
  enriched outcomes via `/api/lottery-finder`. Just need the helper
  - a new response field + a row chip.

## Decisions (data-grounded, 2026-04-13 → 2026-05-08, n=27,615 winners)

### Tier defaults (P75 minutes-to-peak among winners)

| tier  | n      | P75 minutes |
| ----- | ------ | ----------- |
| tier1 | 5,480  | **219**     |
| tier2 | 4,961  | **160**     |
| tier3 | 17,174 | **230**     |

**Notable**: tier2 (160) < tier1 (219) — a non-monotonic ordering
(silent-boom went strictly tier1<tier2<tier3). The lottery score
formula's tier1 bucket appears to over-index on tail-blasters
(SNDK, RKLB) that hold for hours, while tier2 catches the AM-open
scalp cohort. The chip tooltip should explain this so a user looking
at a tier1 row with a 219min hint doesn't think it's a typo. Not
something the spec changes — the score formula is out of scope here.

### Ticker overrides

Stricter bar than silent-boom (n≥50, |Δ|≥40%) because lottery's data
density is 10× higher. Twenty entries clear the bar today:

| ticker | tier  | minutes | n   | Δ% vs tier default |
| ------ | ----- | ------- | --- | ------------------ |
| RKLB   | tier1 | 343     | 387 | +57%               |
| SNDK   | tier1 | 340     | 711 | +56%               |
| SLV    | tier1 | 102     | 789 | -54%               |
| WMT    | tier2 | 296     | 57  | +86%               |
| GOOG   | tier2 | 287     | 158 | +80%               |
| QQQ    | tier2 | 42      | 124 | -74%               |
| RIVN   | tier2 | 277     | 54  | +73%               |
| SNOW   | tier2 | 265     | 65  | +66%               |
| NVDA   | tier2 | 258     | 662 | +62%               |
| SOFI   | tier2 | 243     | 52  | +53%               |
| SPY    | tier2 | 78      | 54  | -51%               |
| APLD   | tier2 | 241     | 68  | +51%               |
| SOXS   | tier2 | 90      | 60  | -43%               |
| SPXW   | tier3 | 50      | 139 | -78%               |
| WDC    | tier3 | 54      | 88  | -76%               |
| SMH    | tier3 | 77      | 77  | -66%               |
| RUTW   | tier3 | 88      | 174 | -62%               |
| QQQ    | tier3 | 104     | 790 | -55%               |
| SPY    | tier3 | 114     | 505 | -50%               |
| CRWV   | tier3 | 129     | 200 | -44%               |

### Thresholds (canonical — different from silent-boom)

```
HIGH_PEAK_THRESHOLD          = 50
TICKER_OVERRIDE_MIN_N        = 50    // silent-boom uses 30
TICKER_OVERRIDE_MIN_DELTA_PCT = 0.40  // silent-boom uses 0.25
```

## Phases

### Phase A — Backend (3 files)

- `api/_lib/lottery-hold.ts` (NEW, ~80 lines) — `avgHoldMinutesFor({ tier, ticker })`.
  Mirror of `api/_lib/silent-boom-hold.ts` with lottery tier defaults
  and the 20-entry override map.
- `api/__tests__/lottery-hold.test.ts` (NEW) — covers tier defaults,
  4-5 representative overrides (one per direction per tier),
  null-tier fallback, case insensitivity, unknown ticker.
- `api/lottery-finder.ts` (MODIFIED) — add `avgHoldMinutes` to the
  `LotteryFire` response interface, populate it on each row in the
  mapper. Also extend the existing `lottery-finder.test.ts` to assert
  the new field is in the response.

**Verification:** `npm run review` passes. Curl the endpoint locally
with a known tier1+RKLB fire, confirm `avgHoldMinutes: 343`.

### Phase B — Frontend (2 files)

- `src/components/LotteryFinder/types.ts` — add `avgHoldMinutes:
number` to `LotteryFire`.
- `src/components/LotteryFinder/LotteryRow.tsx` — render
  `~{avgHoldMinutes}min` chip near the existing tier badge.
  Tooltip explains:
  - "Cohort avg hold ~Nmin — historical P75 minutes-to-peak among
    winners for {scoreTier} on {ticker}."
  - Plus the tier1<tier2 inversion note for tier1 fires:
    "Tier 1 winners often run on slow tail moves, so the typical
    hold is longer than tier 2."
- Existing `src/__tests__/LotteryRow.test.tsx` — extend with one or
  two cases (chip renders, fixture's avgHoldMinutes value is in DOM,
  null/zero-tier fallback).

**Verification:** `npm run review` passes. `npm run dev:full`,
visit the LotteryFinder section, confirm the chip renders on each row.

### Phase C — Monthly recompute script (1 file)

- `scripts/recompute_lottery_hold_minutes.py` (NEW) — clone of
  `scripts/recompute_silent_boom_hold_minutes.py` with lottery's
  table name + the stricter thresholds + computed-tier `CASE`
  expression (since lottery doesn't store score_tier).

**Verification:** Run once; output should match the constants in
`api/_lib/lottery-hold.ts` to within ±5min on 2026-05-08.

## Data dependencies

- **No DB migration.** Existing `peak_ceiling_pct`, `minutes_to_peak`,
  `score`, `underlying_symbol` columns on `lottery_finder_fires` are
  enough.
- **No new env vars.**
- **No new external API calls.**

## What this spec does NOT change

- The lottery score formula or tier thresholds (in
  `api/_lib/lottery-score-weights.ts`)
- The realized exit chip toggle on the LotteryFinder section
  (already exists, separate concern)
- Any DB schema

## Open questions

None — silent-boom precedent set all the patterns, the data is
gathered, the tier-inversion is documented above with an explicit
tooltip plan.

## Recomputation cadence

Same as silent-boom: monthly, manual run of the Phase C script,
paste-into-helper, commit. Lottery data accumulates ~5,000 fires/day
so monthly the override list may grow or shift. Quarterly review of
the tier defaults; for now, reuse the silent-boom 2026-08-01 review
date.

## Followup (not in this spec)

If the tier1/tier2 inversion turns out to be a real artifact of the
score formula (rather than just data composition), it would be worth
revisiting the lottery score weights to either fold mtp into the
score directly or split tier1 into "tail-blaster" vs "scalp" cohorts.
That's a separate research effort, not blocked by this spec.
