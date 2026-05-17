# Trading Workflow

The 5-phase intraday workflow this app is designed around, plus the 12 structure-selection rules encoded in the Claude analyze prompt. For the features that support each phase, see [FEATURES.md](FEATURES.md).

## Daily Flow

```text
8:30 AM ET   Check term structure (VIX1D/VIX9D auto-filled)
             Check event day warning (Rule 12 — FOMC? CPI? NFP?)
             Check volatility clustering signal
             Check pre-trade signals (RV/IV, overnight gap, GEX regime)

9:00 AM CT   FIRST ENTRY (wait for 30-min opening range)
             Check Delta Guide ceiling + DOW + clustering badges
             Check dark pool levels for support/resistance
             Upload 6-7 charts: Market Tide, SPX Flow, SPY Flow, QQQ Flow,
               Periscope (Delta Flow + Gamma), Net Charm (SPX)
             Run Pre-Trade analysis → get structure, delta, entry plan
             Execute Entry 1 per the plan
             Set $0.50 debit limit close order

10:00 AM ET  OPENING RANGE CHECK
             GREEN → proceed with Entry 2
             RED → skip or reduce size

10:00 AM CT  SECOND ENTRY (if conditions met)
             Swap Periscope gamma screenshot + fresh Net Charm
             Run Mid-Day analysis → check if Entry 2 conditions met
             Execute if recommended

11:00 AM CT  OPTIONAL THIRD ENTRY
             Same flow as Entry 2

1:45 PM ET   EVENT DAY EXIT (if FOMC/Fed speech at 2:00 PM)
             Close ALL positions — Rule 12 hard exit

2:00 PM ET   MANAGEMENT (non-event days)
             Follow management rules from analysis
             Take 50% profit if available

4:15 PM ET   REVIEW
             Upload full-day charts
             Run Review analysis → lessons learned
             (Weekly cron auto-curates lessons into compendium)

9:45 PM ET   NIGHTLY PIPELINE
             build-features cron assembles 100+ features
             GitHub Actions runs full ML pipeline
             Plots uploaded to Blob, Claude analyzes them
             Results visible in ML Insights next morning
```

## Structure Selection (from Chart Analysis)

| Market Tide Signal        | Structure          | Why                             |
| ------------------------- | ------------------ | ------------------------------- |
| NCP ≈ NPP (parallel)      | Iron Condor        | Ranging day, collect both sides |
| NCP >> NPP (diverging up) | Put Credit Spread  | Bullish, no call exposure       |
| NPP >> NCP (diverging up) | Call Credit Spread | Bearish, no put exposure        |
| Both declining sharply    | Sit out            | High uncertainty                |

## Structure Selection Rules (Empirical)

These rules are derived from backtesting and live trading. They are coded into the Claude system prompt and override default flow-based structure selection when applicable. Each rule traces to specific sessions where the rule would have prevented a loss or captured a missed opportunity.

### Chart Input Lineup

Up to 4 images per the Zod schema — pick the most relevant for the session:

| Slot | Chart                          | Question It Answers                                |
| ---- | ------------------------------ | -------------------------------------------------- |
| 1    | Market Tide                    | Broad market sentiment (25% weight)                |
| 2    | SPX Net Flow                   | Flow in the trader's exact instrument (50% weight) |
| 3    | SPY Net Flow                   | Confirmation/contradiction (15% weight)            |
| 4    | QQQ Net Flow                   | Tech sector divergence (10% weight)                |
| 5    | Periscope (Delta Flow + Gamma) | Gamma walls, acceleration zones, straddle cone     |
| 6    | Net Charm (SPX)                | Which gamma walls hold vs decay into the afternoon |
| 7    | _(optional)_                   | Second Periscope timeframe for midday comparison   |

### Rule 1: Gamma Asymmetry Overrides Neutral Flow

When flow is neutral but Periscope shows massive negative gamma within 30–40 pts on ONE side and clean air on the other, do not recommend IC — the short strike near the negative gamma cliff has asymmetric acceleration risk. Recommend a directional credit spread AWAY from the danger zone.

### Rule 2: QQQ Divergence Weighting

When SPX + Market Tide + SPY agree but QQQ diverges: weight the agreeing signals at 90%, QQQ at 10%. If QQQ price is also moving with SPX/SPY despite bullish QQQ flow, the flow is hedging — discount further. QQQ divergence reduces confidence (HIGH → MODERATE), not structure.

### Rule 3: Friday Afternoon Hard Exit

Close ALL IC positions by 2:00 PM ET on Fridays if VIX > 19. Friday afternoon gamma acceleration + weekend hedging creates outsized risk not compensated by remaining theta.

### Rule 4: VIX1D > VIX on Friday = Bearish Lean

Inverted intraday term structure on Fridays typically resolves bearishly from weekend hedging demand. Bias toward CCS, away from IC.

### Rule 5: Direction-Aware Stop Conditions

Stops must account for the structure: a downside cone break CONFIRMS a CCS thesis (don't close), while an upside approach threatens it (close). Always frame stops relative to the short strike side.

### Rule 6: Dominant Positive Gamma Confirms IC

A single positive gamma concentration 10x+ larger than surrounding negative gamma is a strong IC signal. Price mean-reverts to the wall repeatedly. Consider widening delta 1–2Δ beyond the ceiling. Place stops at the straddle cone boundary, not at intermediate negative gamma.

### Rule 7: Stop Placement Must Avoid Negative Gamma Zones

Never place stops AT negative gamma bars — MM delta hedging creates brief spikes that trigger stops before the dominant structure reasserts. Place stops at straddle cone boundaries, positive gamma walls, or flow-based thresholds.

### Rule 8: SPX Net Flow Is the Primary Flow Signal

Weighting hierarchy: SPX Net Flow (50%) → Market Tide (25%) → SPY (15%) → QQQ (10%). When SPX and Market Tide agree: HIGH confidence. When they contradict: use SPX for structure, reduce confidence one level.

### Rule 9: Minimum Premium Threshold (8Δ Floor)

The trader's minimum tradeable delta is 8Δ. When the structurally correct structure can't achieve 8Δ+ (e.g., gamma favors CCS but premium above the wall is 3–5Δ), evaluate the opposite structure or SIT OUT. Don't recommend untradeable structures just because gamma favors them.

### Rule 10: SPX Net Flow Hedging Divergence

When SPX NCP diverges from price direction AND 3+ other signals confirm the opposite direction, treat SPX flow as CONFLICTED/LOW regardless of magnitude — the flow is institutional hedging. Reduce SPX weight from 50% to 25%, redistribute to Market Tide (37.5%) and SPY (22.5%). Validated across multiple sessions where positive SPX NCP persisted during 25–50 pt sell-offs.

### Rule 11: Net Charm Confirms Directional Spread

When charm shows massive positive values below price (downside walls strengthening) and negative values above (upside walls decaying), this confirms CCS. Mirror pattern confirms PCS. Aligned charm upgrades confidence one level. Positive charm wall = reliable all day. Neutral charm = checkpoint after 1:00 PM ET. Negative charm = morning-only ally.

### Rule 12: High-Impact Event Day Management

**Afternoon events (FOMC, Fed speeches):** HARD EXIT all positions 15 minutes before the announcement. No exceptions. Overrides all other time-based rules. No re-entry if press conference follows.

**Pre-market events (CPI, NFP, PCE at 8:30 AM ET):** By the 9:00 AM CT entry, the reaction is absorbed. Often favorable for premium selling as VIX deflates. Widen delta 1–2Δ.

**Mid-morning events (ISM, JOLTS at 10:00 AM ET):** Set tight stop before release if already in position. Wait 15 minutes after release if not yet in. No Entry 2 within 30 minutes of release.

---

## Position Sizing Guide

Conservative: 5% of account per day (survives 10+ max losses). Moderate: 10%. Aggressive: 15%.

Multiple positions on the same underlying and expiration are NOT diversified — always sum total buying power.
