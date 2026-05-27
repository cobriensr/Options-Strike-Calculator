# Suspicious-Flow Cluster Badge + TAKE-IT Floor — Design

**Date:** 2026-05-27
**Status:** Draft v2 (awaiting user review)
**Origin:** Discord debrief after META news 2026-05-27. Two gated Silent Boom 0DTE
calls (617.5C +2787%, 615C +996%) were hard-suppressed for printing counter to
flow/tide yet exploded. Both scored TAKE-IT **0.78**. The aligned, longer-dated
650C (TAKE-IT 0.17) only did +34%. The model was right; the gate overrode it.

## Goal

Surface high-conviction 0DTE alerts the current gating hides, via (a) a
**descriptive cluster badge** flagging tickers where multiple cheap-OTM 0DTE
strikes co-fire (the actual "smart money lottery sweep" signature), and (b) a
**TAKE-IT floor filter chip** as the primary conviction lever, plus (c) a
plain-language TAKE-IT tooltip. The validated gate fix is a separate spec.

## Calibration findings (tune-before-ship)

Ran against `lottery_finder_fires` (660k rows) and `silent_boom_alerts` (65k),
Jan 2 → May 27 2026. Scripts: `docs/tmp/sf-*.mjs`. Scored on realized
trailing-stop return AND hold-to-EOD, not peak.

1. **No realized edge under any exit.** Cheap-OTM-0DTE-ask cohort is negative
   expectancy under both a trailing stop (mean −4.7%) and hold-to-EOD (mean
   −24%, median −67%, ~26% near-total-loss). Today's META 617.5C (+5056% EOD)
   was a genuine news-catalyst tail, not the cohort's normal behavior.
   → The badge is a **descriptive attention-flag, not a +EV signal.**
2. **Single-contract "suspicious flow" is not separable.** The loosened
   per-row predicate (entry ≤$1.50, OTM≥0, ask≥0.70, prem≥$100k OR ≥1k
   contracts) flags **78% of 0DTE Silent Boom fires (~61/day)** — useless as a
   badge. Today's winners look like an ordinary cheap-0DTE fire on these axes.
3. **`is_isolated_leg` excludes the real signature.** All five META winners are
   `is_isolated_leg = false` (classified spread legs) — they ARE the clustered
   cheap-call sweep across adjacent strikes. A single-leg requirement would
   exclude every winner. Dropped.
4. **The cluster IS the signature.** Counting distinct cheap-OTM-ask 0DTE
   strikes co-firing per ticker+side per day: ≥3 strikes = 584 events / 99 days
   (~5.9/day, avg best peak 555%); strike-count and best-peak rise monotonically.
   META 5/27 = 3 clustered call strikes (+2788%); also surfaces e.g. SPY 5/21
   (3 strikes, +2567%). Rare enough to mean something, matches what was observed.
5. **TAKE-IT ranks the moonshots monotonically** (peak ≥100% rate: 0% → 13% →
   24% → 45% across buckets) and is independent of the gate. **Floor knee =
   0.70** — realized return stops being negative at ≥0.70; clearly positive at
   ≥0.75; a rare elite tail at ≥0.80 (0.8–3.9% of fires). All five META winners
   scored 0.72–0.78, so a 0.70 floor surfaces them despite the gate.

## Components

### 1. Suspicious-flow cluster badge (feed-computed, both feeds)

A **descriptive** ticker-group flag — NOT a conviction signal. Flags the
cheap-OTM-0DTE multi-strike sweep that started this thread.

**Cluster definition** — per `(date, underlying_symbol, option_type)`, count
distinct strikes among that day's fires meeting all member conditions; if the
count `≥ 3`, the ticker+side is a suspicious cluster.

**Member conditions:**

| condition   | lottery source            | silent-boom source             |
| ----------- | ------------------------- | ------------------------------ |
| 0DTE        | `dte === 0`               | `dte === 0`                    |
| cheap entry | `entry_price <= 1.50`     | `entry_price <= 1.50`          |
| OTM at fire¹| spot = `spot_at_first`    | spot = `underlying_price_at_spike` |
| ask-side    | `trigger_ask_pct >= 0.70` | `ask_pct >= 0.70`              |

¹ OTM = strike at/beyond spot in the option's direction at fire time: calls
`(strike − spot)/spot >= 0`, puts `(spot − strike)/spot >= 0`.

**Compute location:** in the **feed endpoints** (lottery + silent-boom), which
see the full day's fires for a ticker (the frontend paginates, so client-side
counting would undercount). Attach `suspiciousCluster: boolean` and
`clusterStrikeCount: number` to the response (per ticker+side; also stamped on
member rows for highlighting). **No migration, no detect-cron change** — the
cluster is recomputable from existing columns, so the future re-probe can derive
it historically without a persisted column.

**Badge UI:** a ticker-group-header chip (alongside existing `megaCluster` /
`adj_cofire` chips), e.g. `⚡ 3× cheap-OTM call cluster`. Tooltip:
> "N cheap, OTM, ask-side 0DTE strikes co-fired on this ticker today — the
> smart-money lottery-sweep profile. Descriptive context only, NOT a conviction
> signal (the cohort is net negative-expectancy). Use TAKE-IT for conviction."

### 2. TAKE-IT floor filter chip (both feeds)

Primary conviction lever. Matches the existing filter-chip pattern (burst color,
tier floor, vol/OI floor).

- Presets: **Off / 0.60 / 0.70 / 0.75 / 0.80**, default **0.70**.
- Behavior: show alert iff `takeitProb >= floor`. When a floor is active, hide
  null-score alerts and render a visible note: `N hidden (no score)`. Render the
  chip in an obvious active state at the 0.70 default so it never looks like data
  is silently missing.
- Persist the chosen floor in panel prefs / localStorage (cf. commit 5d5774f3).
- Client-side filter (data already in feed payload).

### 3. TAKE-IT tooltip rewrite (`src/components/TakeItScore/TakeItScore.tsx`)

- Scored: > "How confident the model is this trade reaches at least +20% above
  entry. 0–1, higher is better; ~0.70+ is where the historical edge concentrates."
- Null: > "No score — the model bundle was unavailable when this alert fired."

## Phases

**Phase 1 — Feed-endpoint cluster computation + types**
Locate the lottery + silent-boom feed endpoints; compute `suspiciousCluster` /
`clusterStrikeCount` per ticker+side; add fields to
`src/components/LotteryFinder/types.ts` + `src/components/SilentBoom/types.ts`.
Unit-test the cluster helper (pure function over a fires array).

**Phase 2 — Frontend (split 2a/2b/2c if >5 files)**
2a: cluster group-header chip in `LotteryFinderTickerGroup.tsx` +
`SilentBoom` group header. 2b: TAKE-IT chip in both `index.tsx` filter bars +
prefs persistence. 2c: tooltip rewrite in `TakeItScore.tsx`. Component tests.

## Data dependencies

- **None new.** No migrations, no env vars, no external APIs. Reads existing
  columns only (`dte`, `strike`, `option_type`, `entry_price`,
  `spot_at_first`/`underlying_price_at_spike`, `trigger_ask_pct`/`ask_pct`,
  `takeit_prob`).

## Thresholds / constants

- Cluster: `≥ 3` distinct strikes per `(date, ticker, side)`; members
  `dte==0`, `entry_price<=1.50`, `otm>=0`, `ask>=0.70`.
- TAKE-IT chip presets `[off, 0.60, 0.70, 0.75, 0.80]`, default `0.70`.

## Open questions (with default picks)

1. Cluster window — whole-day vs intraday window (e.g. 60 min). **Default
   whole-day** for v1; time-window is a future refinement to avoid merging an
   AM and an unrelated PM cluster.
2. Badge on group-header only, or also highlight member rows? **Default
   group-header chip + subtle member-row tint.**
3. TAKE-IT chip default-on (0.70) changes the feed on first load — surface the
   active-chip state + `N hidden` note loudly. **Default: yes.**

## Non-goals

- No suspicious-flow scoring weight or tier contribution (descriptive only).
- No gate code change here (separate spec: TAKE-IT-conditioned gate fix).
- No persisted cluster column / detector cron — feed-computed only.
- No intraday time-windowing of clusters in v1.
