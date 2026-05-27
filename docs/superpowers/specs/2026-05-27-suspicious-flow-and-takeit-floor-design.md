# Suspicious-Flow Badge + TAKE-IT Floor — Design

**Date:** 2026-05-27
**Status:** Draft (awaiting user review)
**Origin:** Discord debrief after META news 2026-05-27. Two gated Silent Boom 0DTE
calls (617.5C +2787%, 615C +996%) were hard-suppressed for printing counter to
flow/tide yet exploded. Both scored TAKE-IT **0.78**. The aligned, longer-dated
650C (TAKE-IT 0.17) only did +34%. The model was right; the gate overrode it.

## Goal

Surface high-conviction 0DTE alerts that the current gating hides, by (a) a
**descriptive** "suspicious flow" profile badge, (b) a **TAKE-IT floor filter
chip** as the primary conviction lever, and (c) a plain-language TAKE-IT tooltip
— while documenting a validated, deferred gate fix.

## Calibration findings (tune-before-ship)

Ran against `lottery_finder_fires` (660k rows) and `silent_boom_alerts` (65k),
Jan 2 → May 27 2026, scored on **realized trailing-stop return**
(`realized_trail30_10_pct`), not peak. Scripts: `docs/tmp/sf-*.mjs`.

1. **The suspicious-flow signature has no realized edge.** On 0DTE fires, adding
   `entry ≤ $0.50` → `premium ≥ $100k` → `ask ≥ 70%` does **not** beat the base
   rate; the premium/ask filters slightly *lower* win rate and moonshot rate.
   Moonshot rate (peak ≥ 100%) is roughly uniform across cheap/premium buckets —
   a uniform-lift (leakage) fingerprint, not concentrated edge.
2. **Spread-leg exclusion is unverifiable historically.** `is_isolated_leg` and
   `multi_leg_share` only exist from May 2026 (~6–9% coverage). The single-leg
   filter collapses the historical cohort to n≈1, so we cannot validate the
   biggest confound (76% of large prints are spread legs — prior whale finding).
3. **TAKE-IT already ranks the moonshots monotonically.** peak ≥ 100% rate by
   TAKE-IT bucket: <0.3 → 0%, 0.3–0.5 → 13%, 0.5–0.7 → 24%, 0.7+ → 45%.
4. **TAKE-IT floor knee = 0.70.** Realized trailing return crosses from negative
   to ~breakeven at ≥0.70 (lottery +0.3%, SB −2.9%) and clearly positive at
   ≥0.75 (lottery +4.8%, SB +1.6%). A rare elite tier exists at ≥0.80 (0.8–3.9%
   of fires, peak ≥ 100% of 50–91%) — treat as a small special tail, not a knob.
5. **The gate suppresses good high-TAKE-IT fires.** Among gated Silent Boom 0DTE
   fires: TAKE-IT <0.5 → mean trail −15.5% (gate correct); TAKE-IT ≥0.7 (n=448)
   → peak ≥ 100% 38%, mean trail **+0.4%**, statistically as good as *ungated*
   0.7+ fires (38%, −4.5%). The hard tier3 override is pure downside above 0.70.

**Consequence:** the build's center of gravity moves from the (unvalidated)
suspicious-flow score to the (validated) TAKE-IT floor. The suspicious-flow tag
ships as **descriptive instrumentation only**, no edge claim, no score weight.

## Components

### 1. Suspicious-flow descriptive badge (persisted, both feeds)

A boolean profile tag — NOT a conviction signal. Flags the cheap-OTM-0DTE-in-
size profile the user wants to eyeball, and seeds a future clean-data re-probe
once `is_isolated_leg` coverage matures.

**Predicate** `isSuspiciousFlow(row)` — all must hold:

| condition              | lottery source                          | silent-boom source                  |
| ---------------------- | --------------------------------------- | ----------------------------------- |
| 0DTE                   | `dte === 0`                             | `dte === 0`                         |
| cheap entry            | `entry_price <= 0.50`                   | `entry_price <= 0.50`               |
| size despite cheap     | `entry_price * trigger_window_size * 100 >= 100_000` | `entry_price * spike_volume * 100 >= 100_000` |
| OTM at fire¹           | spot = `spot_at_first`                  | spot = `underlying_price_at_spike`  |
| ask-side               | `trigger_ask_pct >= 0.70`               | `ask_pct >= 0.70`                   |
| not a known spread leg | `is_isolated_leg IS NOT FALSE`          | `is_isolated_leg IS NOT FALSE`      |

¹ OTM = strike beyond spot in the option's direction at fire time: calls
`(strike − spot) / spot > 0`, puts `(spot − strike) / spot > 0`.
`is_isolated_leg IS NOT FALSE` means `true` or `null` (null = leg status not yet
classified; don't suppress, but the future re-probe ignores nulls).

Pure helper in `api/_lib/suspicious-flow.ts` with the constants above; unit
tested with an input/output table. Computed at detect time and stored in a new
`suspicious_flow BOOLEAN DEFAULT FALSE` column on each table.

**Badge UI:** neutral styling (not a "hot" color), inline-span factory matching
existing badges. Tooltip text:
> "Suspicious-flow profile: cheap, OTM, 0DTE, bought in size, ask-side, single
> leg. Descriptive only — NOT a conviction signal. Use TAKE-IT for conviction."

### 2. TAKE-IT floor filter chip (both feeds)

Primary conviction lever. Matches the existing filter-chip pattern (burst color,
tier floor, vol/OI floor).

- Presets: **Off / 0.60 / 0.70 / 0.75 / 0.80**, default **0.70**.
- Behavior: show alert iff `takeitProb >= floor`. When a floor is active, hide
  null-score alerts and render a small note: `N hidden (no score)`.
- Persist the chosen floor in panel prefs / localStorage, matching the existing
  prefs system (cf. commit 5d5774f3 panel-prefs seed handling).
- Client-side filter (data already in feed payload).

### 3. TAKE-IT tooltip rewrite (`src/components/TakeItScore/TakeItScore.tsx`)

- Scored: > "How confident the model is this trade reaches at least +20% above
  entry. 0–1, higher is better; ~0.70+ is where the historical edge concentrates."
- Null: > "No score — the model bundle was unavailable when this alert fired."

### 4. Gate — documentation only (no code change this build)

Validated follow-up: make the Silent Boom hard tier3 override **TAKE-IT
conditioned** — exempt `takeit_prob >= 0.70` from the override, keep the gate
below 0.70 (where it correctly suppresses losers). Until then, the badge + chip
let the user eyeball gated-but-high-TAKE-IT fires. Tracked as a separate spec.

## Phases

**Phase 1 — Backend detector + persistence**
`api/_lib/suspicious-flow.ts` (+ `.test.ts`); 2 migrations adding
`suspicious_flow` to `lottery_finder_fires` + `silent_boom_alerts` in
`api/_lib/db-migrations.ts`; update `api/__tests__/db.test.ts` (mock ids,
expected output, SQL count); wire compute+insert into
`api/cron/detect-lottery-fires.ts` and `api/cron/detect-silent-boom.ts`.

**Phase 2 — Feed endpoints + types**
Surface `suspiciousFlow` (and confirm `takeitProb`) in both feed responses;
add fields to `src/components/LotteryFinder/types.ts` +
`src/components/SilentBoom/types.ts`.

**Phase 3 — Frontend (split into 3a badge / 3b chip / 3c tooltip if >5 files)**
Badge in `LotteryRow.tsx` + `SilentBoomRow.tsx`; TAKE-IT chip in both
`index.tsx` filter bars + prefs persistence; tooltip rewrite in
`TakeItScore.tsx`; component tests.

**Phase 4 — Optional historical backfill**
One-off script to populate `suspicious_flow` on existing rows where spot is
available, so the future re-probe has history.

## Data dependencies

- 2 migrations: `suspicious_flow BOOLEAN DEFAULT FALSE` on both fires tables.
- No new env vars, no external APIs.
- Reads existing columns only (`entry_price`, `trigger_window_size`/
  `spike_volume`, `spot_at_first`/`underlying_price_at_spike`,
  `trigger_ask_pct`/`ask_pct`, `is_isolated_leg`, `dte`, `strike`,
  `option_type`, `takeit_prob`).

## Thresholds / constants

- Suspicious-flow: `dte==0`, `entry_price<=0.50`, `premium_usd>=100_000`,
  `otm_pct>0`, `ask>=0.70`, `is_isolated_leg IS NOT FALSE`. Contract
  multiplier = 100.
- TAKE-IT chip presets `[off, 0.60, 0.70, 0.75, 0.80]`, default `0.70`.
- Gate follow-up exemption: `takeit_prob >= 0.70`.

## Open questions (with default picks)

1. Contract multiplier for premium — **default 100** (standard equity option).
2. Backfill historical `suspicious_flow`? — **default yes**, optional Phase 4,
   only for rows with spot populated.
3. Chip default-on (0.70) changes the feed on first load — surface the
   "N hidden (no score)" + active-chip state so it's obviously filtering.
   **Default: yes, make active state visible.**

## Non-goals

- No suspicious-flow scoring weight or tier contribution.
- No gate code change in this build (Phase 4 of a separate follow-up spec).
- No new detector cron — tag is computed inside existing detect crons.
