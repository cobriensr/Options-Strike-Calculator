---
status: Likely Shipped
date: 2026-05-08
---

# Silent-Boom: Section-level exit chip + avg-hold-minutes hint

**Date:** 2026-05-08
**Author:** charlesobrien (with Claude Code)
**Status:** DRAFT — pending owner approval before Phase A

## Goal

Mirror the LotteryFinder section-level exit-policy chip pattern on
the SilentBoom dashboard, add a per-alert "avg hold minutes" cohort
hint chip, and flip the flame count so 3 🔥 = strongest signal.

## Why

The silent-boom table already stores `realized_30m_pct`, `realized_60m_pct`,
`realized_120m_pct`, `realized_eod_pct`, `peak_ceiling_pct`, and
`minutes_to_peak`. Today only 60m + EOD show up on each row, with no
way to switch which one is "primary." LotteryFinder solved the same
problem with a section-level chip selector that swaps which realized
exit each row highlights — copying that pattern is far simpler than
inventing per-row exit-style classification.

The cohort `avg_hold_minutes` chip closes the loop on the user's
question "when do I exit?" by surfacing the historical median
minutes-to-peak for the alert's (tier, ticker) cohort.

## Decisions (data-grounded)

### Exit-policy chip toggle (mirror of lottery)

Section header gets a row of chips. Whichever is active becomes the
primary % column on every row. All five columns are already in the DB.

| chip label | column              | tooltip blurb                               |
| ---------- | ------------------- | ------------------------------------------- |
| `30m`      | `realized_30m_pct`  | Fixed-horizon return at +30 min from spike  |
| `60m`      | `realized_60m_pct`  | Fixed-horizon return at +60 min             |
| `120m`     | `realized_120m_pct` | Fixed-horizon return at +120 min            |
| `eod`      | `realized_eod_pct`  | Realized return at last tick of the day     |
| `peak`     | `peak_ceiling_pct`  | Look-ahead reference: max post-spike return |

Default chip on first load: `60m` (matches the column the row
currently emphasizes — least disruptive switch).

### Per-alert avg-hold-minutes chip

Single integer rendered as `~89min` chip, sourced from a TS lookup
keyed by `(score_tier, underlying_symbol)`. Lookup priority:

1. **Per-ticker override** — only if both:
   - n ≥ 30 historical winners (peak ≥ 50%) for the (ticker, tier) pair, AND
   - `|ticker_p75 − tier_p75| / tier_p75 ≥ 0.25`

   Today this gives exactly 2 overrides:

   | ticker | tier  | avg_hold_minutes |
   | ------ | ----- | ---------------- |
   | QQQ    | tier1 | 89               |
   | SPXW   | tier3 | 296              |

2. **Tier default** — for every other (ticker, tier):

   | tier  | avg_hold_minutes (P75 of winners) |
   | ----- | --------------------------------- |
   | tier1 | 144                               |
   | tier2 | 197                               |
   | tier3 | 224                               |

No DB column. Computed at the API endpoint from the in-process
constant table; serialized into the response next to the existing
`outcomes` block. Mirrors the way lottery's `forecastHighPeakPct` is
derived from a tier lookup at endpoint time.

### Flame remap (cosmetic)

| score_tier (DB, unchanged) | flame_count (UI) |
| -------------------------- | ---------------- |
| `tier1`                    | 🔥🔥🔥           |
| `tier2`                    | 🔥🔥             |
| `tier3`                    | 🔥               |

Pure render-layer flip in `SilentBoomRow.tsx`. No DB change, no API
change.

## Phases

### Phase A — Backend (4 files)

Add the lookup helper, return `avgHoldMinutes` in the silent-boom-feed
response, ship tests.

- `api/_lib/silent-boom-hold.ts` (new) — exports
  `avgHoldMinutesFor({ tier, ticker })` returning a positive integer.
  Holds the `TIER_DEFAULTS` constant + `TICKER_OVERRIDES` map
  (2 entries today). ~40 lines incl. doc comment with recompute date.
- `api/__tests__/silent-boom-hold.test.ts` (new) — covers tier defaults,
  the 2 ticker overrides, unknown-ticker fallthrough.
- `api/silent-boom-feed.ts` — call the helper for each row, include
  `avgHoldMinutes` in the JSON response on the same level as `outcomes`.
- `api/__tests__/silent-boom-feed.test.ts` — extend an existing
  fixture-based test to assert `avgHoldMinutes` is populated.

**Verification:** `npm run review` passes. Curl the endpoint locally,
confirm `avgHoldMinutes` is in the response.

### Phase B — Frontend (4 files)

Wire the section chip + row primary swap + row chip + flame remap.

- `src/components/SilentBoom/types.ts` — add `SilentBoomExitPolicy`
  type + `EXIT_POLICY_LABELS` + `EXIT_POLICY_TOOLTIPS` mirroring
  the lottery shape; extend `SilentBoomAlert` with `avgHoldMinutes`.
- `src/components/SilentBoom/SilentBoomSection.tsx` — add
  `useState<SilentBoomExitPolicy>('realized60mPct')`, render the chip
  row at the top of the section, pass `exitPolicy` to every row.
- `src/components/SilentBoom/SilentBoomRow.tsx` — accept
  `exitPolicy` prop, render selected outcome as primary, render the
  `~{avgHoldMinutes}min` chip near the score chip, swap the flame
  count to 1/2/3 based on `score_tier`.
- `src/__tests__/SilentBoomRow.test.tsx` (or wherever existing tests
  live) — extend to cover all 5 exit policies + flame-count remap +
  avg-hold chip rendering.

**Verification:** `npm run review` passes. `npm run dev:full`,
visit `/silent-boom`, confirm the chip toggle swaps the primary
column, the avg-hold chip renders, 3 🔥 = strongest tier.

### Phase C — Monthly recompute script (1 file)

- `scripts/recompute_silent_boom_hold_minutes.py` (new) — re-derives
  the (tier, ticker) → avg_hold_minutes table from the latest enriched
  sample and prints a TS-formatted constant block. Manual one-shot:
  `ml/.venv/bin/python scripts/recompute_silent_boom_hold_minutes.py`.

**Verification:** Run once; output matches current constants in
`silent-boom-hold.ts` to within ±5min on 2026-05-08 (no drift yet).

## Open questions

None remaining — silent-boom dashboard is confirmed at
`src/components/SilentBoom/`, response shape is in
`api/silent-boom-feed.ts`.

## What this spec does NOT change

- The score formula or weights (`api/_lib/silent-boom-score.ts`)
- The `score_tier` column or its values in the DB
- The detect-silent-boom cron behavior
- Any database schema (no migration)

## Constants (canonical)

```
TIER_DEFAULTS  = { tier1: 144, tier2: 197, tier3: 224 }  // P75 minutes-to-peak among winners
TICKER_OVERRIDES = {
  ('QQQ',  'tier1'): 89,
  ('SPXW', 'tier3'): 296,
}
TICKER_OVERRIDE_MIN_N         = 30   // historical winners threshold
TICKER_OVERRIDE_MIN_DELTA_PCT = 25   // |ticker_p75 - tier_p75| / tier_p75
```

Recompute monthly via Phase C script.

## Followup (not in this spec)

User flagged interest in adding the same `avgHoldMinutes` chip to
the LotteryFinder UI. That's a separate, smaller effort once this
ships — would mirror Phase A + Phase B against `lottery_finder_fires`
and the LotteryRow component.
