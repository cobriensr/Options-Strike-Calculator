# ES/NQ order-flow imbalance: point-in-time test (2026-10-28)

**Status:** null result. The D5 gate was not met. Research only; nothing is wired.
**Spec:** `docs/superpowers/specs/2026-10-28-uw-futures-orderflow-design.md`, Phase 1.
**Scripts and raw outputs:** `docs/tmp/ofi-pit-study/` (gitignored). The headline numbers were checked against `out/summary.json` and `out/results_old_replication.csv`.

## Bottom line

Aggressive buying and selling on ES and NQ describes what price is doing **right now**. It says nothing about what price does **next**.

- **Same window:** OFI and the return over that window move together strongly (Spearman ρ 0.55–0.71 intraday).
- **Afterwards:** the same OFI has no measurable relation to the next 15 minutes, the next hour, or the rest of the session. None of the 26 predictive configurations comes close to the gate. The largest |ρ| is 0.070, with a 95% CI of −0.057 to +0.192 and BH q = 0.98.
- **The old ρ = 0.31 replicates exactly** (NQ +0.313). It is a same-day description: a day with more buying is a day that went up.

### One example

On 2025-07-21, NQ's 08:30–10:00 CT OFI was **+0.040**, the strongest buying morning of the year: 52% of aggressive volume was buys. NQ rose 141 points (+0.60%) over those 90 minutes. From 10:00 to 15:00 it **fell** 52.5 points (−0.22%). The flow described the rally that had already happened, not the afternoon.

The same pattern across all 243 sessions, with NQ mornings sorted into fifths by 08:30–10:00 OFI:

| OFI fifth | Mean OFI | NQ 08:30→10:00 (same window) | NQ 10:00→15:00 (tradable) | Afternoons up |
|---|---|---|---|---|
| 1 (most selling) | −0.019 | −0.58% | −0.11% | 47% |
| 2 | −0.009 | −0.15% | +0.19% | 67% |
| 3 | −0.001 | +0.00% | −0.01% | 49% |
| 4 | +0.007 | +0.34% | +0.02% | 46% |
| 5 (most buying) | +0.019 | +0.48% | +0.05% | 61% |

The same-window column climbs steadily. The afternoon column wanders within ±0.2% with no order. ES looks the same (`out/example_quintiles.csv`).

## Data

| | Discovery | Hold-out |
|---|---|---|
| Source | Databento TBBO archive (`GLBX.MDP3`): private Blob `archive/v1/tbbo/year=2025,2026/part.parquet`, 4.16 GB, SHA-256 verified | Neon `futures_trade_ticks`, aggregated per minute in SQL (read-only) |
| Side | Exchange aggressor flag (`side` B/A). Unclassified volume is 0.0002% | `aggressor_side` classified from price vs the pre-trade BBO. **A different variable**: supporting evidence only |
| Contract | The front month per UTC day, by top total volume, outrights only | The bare root. Back-month prints (more than 20 ES points or 80 NQ points from the minute's median) are dropped; sessions where those exceed 2% of trades (the June roll) are excluded |
| Sessions | RTH 2025-04-21 → 2026-04-17: **243 per root** (excluding 10 holidays/half days and 4 Databento-degraded days) | ES **31** (04-20 → 06-05), NQ **33** (→ 06-10) |

The old doc's "312 days" counted UTC-day files, including Sunday evenings.

## Method

- **Window:** RTH 08:30–15:00 CT only. The OFI window ends exactly where the outcome window starts.
- **OFI** = (buy − sell) / (buy + sell). It is null below 20 contracts, which never binds in RTH.
- **Return:** the log of the last trade strictly before each bound.
- **Tests:**
  1. **Rolling.** OFI over [t−W, t), W ∈ {5, 15, 60} min, with t every 5 min from 09:00 to 14:30. Outcomes are t→t+15, t→t+60 and t→15:00. One ρ per configuration, pooled over grid times (about 13–16k observations).
  2. **Cumulative.** OFI 08:30 → t, t ∈ {09:00, 10:00, 11:00, 12:00}, against the return t→15:00. One observation per session.
  3. **Control.** OFI against the return over the same window.
  4. **Stability.** The first 121 sessions against the last 122.
- **Statistics:**
  - Spearman ρ.
  - 95% CI from a day-block bootstrap (2,000 draws).
  - p from a day-shuffle permutation (2,000 draws).
  - BH correction across the 26 predictive configurations. Controls are excluded from the family.

## Results: predictive (discovery, 243 sessions per root, all BH q = 0.98)

Each cell is ρ [95% CI].

| OFI window | Outcome | ES ρ [95% CI] | NQ ρ [95% CI] |
|---|---|---|---|
| 5 min | t→t+15 | +0.010 [−0.006, +0.027] | +0.003 [−0.012, +0.017] |
| 5 min | t→t+60 | +0.007 [−0.012, +0.026] | −0.001 [−0.019, +0.014] |
| 5 min | t→15:00 | +0.006 [−0.015, +0.026] | −0.002 [−0.019, +0.014] |
| 15 min | t→t+15 | +0.007 [−0.014, +0.028] | +0.005 [−0.016, +0.025] |
| 15 min | t→t+60 | −0.001 [−0.031, +0.026] | −0.004 [−0.031, +0.023] |
| 15 min | t→15:00 | +0.002 [−0.029, +0.031] | −0.004 [−0.032, +0.023] |
| 60 min | t→t+15 | +0.000 [−0.024, +0.024] | −0.006 [−0.034, +0.017] |
| 60 min | t→t+60 | +0.002 [−0.042, +0.043] | −0.003 [−0.046, +0.038] |
| 60 min | t→15:00 | −0.002 [−0.053, +0.049] | −0.018 [−0.075, +0.032] |
| Cumulative 08:30–09:00 | →15:00 | +0.070 [−0.057, +0.192] | +0.066 [−0.059, +0.185] |
| Cumulative 08:30–10:00 | →15:00 | −0.023 [−0.134, +0.096] | +0.051 [−0.074, +0.168] |
| Cumulative 08:30–11:00 | →15:00 | −0.011 [−0.128, +0.107] | +0.005 [−0.122, +0.134] |
| Cumulative 08:30–12:00 | →15:00 | −0.014 [−0.130, +0.100] | +0.016 [−0.111, +0.144] |

- **By time of day:** splitting into 09:00–10:55, 11:00–12:55 and 13:00–14:30 keeps every rolling ρ within ±0.06.
- **Halves:** only 7 of 26 configurations share a sign across the two halves, all with |ρ| < 0.07.
- **Mid vs last trade:** re-running on the BBO mid instead of the last trade moved no ρ by more than 0.001.

## Results: control (same window)

| Window | ES ρ | NQ ρ |
|---|---|---|
| Rolling 5 / 15 / 60 min | 0.655 / 0.631 / 0.549 | 0.704 / 0.679 / 0.642 |
| 08:30 → 09:00 / 10:00 / 11:00 / 12:00 | 0.588 / 0.571 / 0.518 / 0.456 | 0.707 / 0.650 / 0.613 / 0.633 |
| Whole RTH day | 0.307 | 0.568 |
| **Old construction** (mean trailing-60-min OFI over the full UTC day against that day's open→close, n = 306) | **0.130** [0.026, 0.229] | **0.313** [0.221, 0.396] |

The old construction reproduces the old doc to three decimals. The hold-out's BBO-classified side tracks same-window price just as well (0.54–0.88), so the hold-out null is not a broken variable.

## Hold-out (supporting evidence only)

- **Sign agreement:** the sign matches discovery on 15 of 26 configurations, a coin flip.
- **Rolling configurations:** ρ ranges from −0.06 to +0.07, and every CI includes 0.
- **Cumulative configurations:** CIs are about ±0.35 wide at n = 31–33. NQ's OFI to 11:00 gives −0.284 [−0.606, +0.055], the opposite sign from discovery.

## D5 verdict: not met

| D5 requirement | Best result |
|---|---|
| \|ρ\| ≥ 0.10 | Max \|ρ\| is 0.070 |
| 95% CI excludes 0 | No CI excludes 0 |
| BH q < 0.10 | Min q is 0.98 |
| Same sign in both halves | Only 7 of 26, all \|ρ\| < 0.07 |

**Consequences:**
- No "wire OFI" spec.
- The order-flow columns are still collected (owner: pull everything UW offers).
- Re-test after 60 UW sessions.

## What this rules out, and what it doesn't

- **Rules out (rolling, intraday):** any monotone link between 5–60-min OFI and the next 15 minutes to the close larger than about |ρ| 0.03–0.05. The top-decile minus bottom-decile OFI windows differ by under 1.6 bp of forward return in every configuration (about 1 ES point), with every CI including 0 (`out/explore_tails.csv`).
- **Doesn't fully rule out (cumulative, once per day):** with 243 sessions the CI half-width is about ±0.12, so a per-day ρ up to about 0.18 isn't excluded by power alone. But the point estimates sit within ±0.07, the halves flip sign, and the hold-out leans the other way.
- **The old "extreme" threshold never fires in RTH:** |OFI| > 0.3 occurs in 0.01% of 5-min windows. The 99th percentiles are 0.16 (5 min), 0.11 (15 min) and 0.06 (60 min).

## Caveats

- **One regime.** Discovery was one year of a mostly rising market.
- **The hold-out is weak.** It uses a different side classifier and is small.
- **One variant is untested:** overnight (Globex 17:00 → 08:30) OFI as a predictor of the RTH session. The old full-UTC-day number mixed in overnight flow, so this is the one variant that could still matter.
- **Monotone links only.** The Spearman ρ is pooled across times of day. Non-monotone shapes beyond the time-of-day and decile checks were not searched, on purpose.
- **Transfers to UW.** UW's `side` agrees with the tick test on 99.1% of price-changing prints and behaves like the exchange aggressor flag (spec, "Probe results (0a)"), so this null applies to UW flow too.

## Reproduce

From `docs/tmp/ofi-pit-study/`, with `ml/.venv/Scripts/python.exe -I`:

1. `node download_tbbo.mjs`: a resumable, SHA-verified Blob pull. It reads the token from `.env.local` and never prints it.
2. `python -I build_archive_minutes.py`
3. `python -I build_neon_minutes.py`
4. `python -I analyze.py`, about 25 min.
5. `python -I example_quintiles.py` and `python -I explore_tails.py`
