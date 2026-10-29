# Trading Workflow

The 5-phase intraday workflow this app is designed around, plus the 18 structure-selection and management rules, sizing tiers and rule priorities encoded in the Claude analyze prompt (`api/_lib/analyze-prompts.ts`). For the features that support each phase, see [FEATURES.md](FEATURES.md).

## Daily Flow

```text
8:30 AM ET   Check term structure (VIX1D/VIX9D auto-filled)
             Check event day warning (Rule 12 — FOMC? CPI? NFP?)
             Check volatility clustering signal
             Check pre-trade signals (RV/IV, overnight gap, move breadth)
               and the 0DTE Gamma Regime

9:00 AM CT   FIRST ENTRY (wait for 30-min opening range)
             Check Delta Guide ceiling + DOW + clustering badges
             Check dark pool levels for support/resistance
             Upload 2 charts: Periscope (Gamma) and Periscope Charm (SPX)
               (Market Tide, Net Flow, ETF Tide and the other flow data
               are pulled automatically)
             Run Pre-Trade analysis → get structure, delta, entry plan
             Execute Entry 1 per the plan
             Set $0.50 debit limit close order

10:00 AM ET  OPENING RANGE CHECK
             GREEN → proceed with Entry 2
             RED → skip or reduce size

10:00 AM CT  SECOND ENTRY (if conditions met)
             Upload fresh Periscope (Gamma) and Periscope Charm (SPX)
               screenshots
             Run Mid-Day analysis → check if Entry 2 conditions met
             Execute if recommended

11:00 AM CT  OPTIONAL THIRD ENTRY
             Same flow as Entry 2

1:45 PM ET   EVENT DAY EXIT (if FOMC/Fed speech at 2:00 PM)
             Close ALL positions — Rule 12 hard exit

2:00 PM ET   MANAGEMENT (non-event days)
             Follow management rules from analysis
             Take 50% profit if available (Rules 13 and 16 change the
               target by charm and GEX regime)

4:15 PM ET   REVIEW
             Upload end-of-day Periscope (Gamma) and Charm screenshots
             Run Review analysis → lessons learned
             (Weekly cron auto-curates lessons into compendium)

4:45 PM ET   FEATURES
             build-features cron assembles 100+ features

9:45 PM ET   NIGHTLY ML PIPELINE (GitHub Actions; paused since 2026-04-17)
             Runs the ML pipeline, uploads plots to Blob, Claude writes
             plot explanations, results appear in ML Insights
```

## Structure Selection (Market Tide read)

| Market Tide Signal        | Structure          | Why                             |
| ------------------------- | ------------------ | ------------------------------- |
| NCP ≈ NPP (parallel)      | Iron Condor        | Ranging day, collect both sides |
| NCP >> NPP (diverging up) | Put Credit Spread  | Bullish, no call exposure       |
| NPP >> NCP (diverging up) | Call Credit Spread | Bearish, no put exposure        |
| Both declining sharply    | Sit out            | High uncertainty                |

Market Tide is one input; see Rule 8 for the full weighting.

## Structure Selection Rules (Empirical)

These rules are derived from backtesting and live trading. They are coded into the Claude system prompt and override default flow-based structure selection when applicable. Each rule traces to specific sessions where the rule would have prevented a loss or captured a missed opportunity.

The prompt groups them into three phases: structure selection (Rules 1, 2, 4, 6, 8, 9, 10, 11), entry timing (Rule 12) and position management (Rules 3, 5, 7, 13, 14, 15, 16). Rule 17 sits in the prompt's vanna section and Rule 18 follows Rule 16. They are listed here in numerical order.

### Chart Input Lineup

Up to 2 images (Zod `max(2)`):

| Slot | Chart                 | Question It Answers                                |
| ---- | --------------------- | -------------------------------------------------- |
| 1    | Periscope (Gamma)     | Gamma walls, acceleration zones, straddle cone     |
| 2    | Periscope Charm (SPX) | Which gamma walls hold vs decay into the afternoon |

Flow sources (Market Tide, SPX/SPY/QQQ Net Flow, ETF Tide, 0DTE Index Flow, Delta Flow) and GEX arrive as structured data. Their weighting is in Rule 8.

### Rule 1: Gamma Asymmetry Overrides Neutral Flow

When flow is neutral (NCP and NPP within $50M of each other) but Periscope shows massive negative gamma within 30–40 pts on ONE side and clean air on the other, do not recommend IC — the short strike near the negative gamma cliff has asymmetric acceleration risk. Recommend a directional credit spread AWAY from the danger zone.

### Rule 2: QQQ Divergence Weighting

When SPX + Market Tide + SPY agree but QQQ diverges: weight the agreeing signals at 90%, QQQ at 10%. If QQQ price is also moving with SPX/SPY despite bullish QQQ flow, the flow is hedging — discount further. QQQ divergence reduces confidence (HIGH → MODERATE), not structure.

### Rule 3: Friday Management

Friday afternoon gamma acceleration plus weekend hedging demand creates elevated risk. Tiers, applied in order:

| Tier | Condition                                                     | Action                                                                                                      |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A    | VIX ≤ 19                                                      | No forced early exit; normal Rule 16 management                                                             |
| B    | VIX 19–25, no VIX1D extreme inversion                         | Hard exit all ICs by 2:00 PM ET; directional spreads may be held with the thesis intact and 20+ pts cushion |
| C    | VIX 19–25 with VIX1D extreme inversion (VIX1D 20%+ below VIX) | Skip the 2:00 PM hard exit; use Rule 16 deadlines; size down one tier                                       |
| D    | VIX > 25 with VIX1D extreme inversion                         | Override the stop-zone IC restriction; use Rule 16 deadlines; size down two tiers                           |
| E    | VIX > 25, no VIX1D extreme inversion                          | SIT OUT                                                                                                     |
| F    | Mondays (all VIX regimes)                                     | Widen short strikes 5–10 pts, reduce IC confidence one level, no sizing up (Monday HIGH sizes as MODERATE)  |

### Rule 4: VIX1D > VIX on Friday = Bearish Lean

Inverted intraday term structure on Fridays typically resolves bearishly from weekend hedging demand. Bias toward CCS, away from IC.

### Rule 5: Direction-Aware Stop Conditions

Stops must account for the structure: a downside cone break CONFIRMS a CCS thesis (don't close), while an upside approach threatens it (close). Always frame stops relative to the short strike side.

### Rule 6: Dominant Positive Gamma Confirms IC

A single positive gamma concentration 10x+ larger than surrounding negative gamma is a strong IC signal. Price mean-reverts to the wall repeatedly. Consider widening delta 1–2Δ beyond the ceiling, capped at the lower of ceiling + 2Δ or the delta where the short strike leaves the wall's suppression zone. Widening needs a shelf, not a pin (Rule 18), and Rule 9's 10Δ floor still applies. Place stops at the straddle cone boundary, not at intermediate negative gamma.

### Rule 7: Stop Placement Must Avoid Negative Gamma Zones

Never place stops AT negative gamma bars — MM delta hedging creates brief spikes that trigger stops before the dominant structure reasserts. Place stops at straddle cone boundaries, positive gamma walls, or flow-based thresholds. On high-volatility mornings (first-hour range > 60 pts), widen stops to the cone or use flow-based stops only.

### Rule 8: Flow Signal Weighting (Data-Informed)

The prompt cites backtested directional accuracy across 36 labeled trading days (as of April 2026): QQQ Net Flow 61%, Market Tide 61%, SPY and QQQ ETF Tide 59%, 0DTE Index 50%, SPY Net Flow 47%, SPX Net Flow 31% (an anti-signal at VIX < 25).

Weights: Market Tide 30%, QQQ Net Flow 25%, SPY/QQQ ETF Tide 20%, SPY Net Flow 15%, SPX Net Flow 10%. Market Tide and QQQ agreeing = HIGH confidence; when they contradict, MODERATE confidence with ETF Tide and SPY as tiebreakers. When SPX Net Flow is the only signal pointing one way, trust the consensus. Above VIX 25, SPX rises to 35% and Market Tide drops to 25% (see Rule 10).

### Rule 9: Delta Ceiling Targeting & Minimum Premium Threshold (10Δ Floor)

The calculator's delta ceilings (IC, put spread, call spread; typically 12–18Δ) are the target, not a maximum to stay far below.

- **Target:** the ceiling for the recommended structure. On most days the ceiling is the recommendation.
- **Adjusted:** ceiling minus 2–3Δ, only when a −2000+ gamma zone sits at the ceiling strike. Minor negative gamma (−500 to −1000) does not justify dropping 5+Δ. Adjusted never goes below the floor.
- **Floor:** 10Δ is the trader's minimum tradeable delta; below it, the credit doesn't justify the risk. If the structurally correct trade can't reach 10Δ, SIT OUT.

A suggested delta more than 3Δ below the ceiling must be justified. When gamma walls push the short strike further OTM than the ceiling (e.g., gamma favors CCS but premium above the wall is 3–5Δ), evaluate the opposite structure, flag its gamma risk and reduce confidence one level. If neither side can reach the higher of its ceiling − 3Δ or 10Δ with structural protection, SIT OUT. Don't recommend untradeable structures just because gamma favors them. Strikes come from the Chain Delta Rungs table, never below the floor on either side.

### Rule 10: SPX Net Flow Hedging Divergence

Below VIX 25, SPX Net Flow is an anti-signal: when it disagrees with Market Tide, QQQ and ETF Tide, follow them (MODERATE confidence if only two agree; Market Tide + QQQ is the strongest pair). Positive SPX NCP during a sell-off is institutional call-buying as a hedge, not bullish conviction; the reverse holds when SPX NCP is deeply negative while Market Tide and QQQ are bullish. At VIX 25+, institutional hedging distorts Market Tide and SPY, so trust SPX Net Flow alone for structure selection when it diverges from them.

Close-on-reversal trigger for directional spreads: SPX NCP crossing zero below VIX 25. At VIX 25+, SPX NCP beyond ±$100M sustained for 30+ minutes, and never on SPX NCP alone while Market Tide NCP still confirms the thesis.

### Rule 11: Net Charm Confirms Directional Spread

When charm shows massive positive values below price (downside walls strengthening) and negative values above (upside walls decaying), this confirms CCS. Mirror pattern confirms PCS. Aligned charm upgrades confidence one level. Positive charm wall = reliable all day. Neutral charm = checkpoint after 1:00 PM ET. Negative charm = morning-only ally.

### Rule 12: High-Impact Event Day Management

**Afternoon events (FOMC, Fed speeches after 1:00 PM ET):** HARD EXIT all positions 15 minutes before the announcement. No exceptions. Overrides all other time-based rules. No re-entry if press conference follows.

**Pre-market events (CPI, NFP, PCE at 8:30 AM ET):** By the 9:00 AM CT entry, the reaction is absorbed. Often favorable for premium selling as VIX deflates. Widen delta 1–2Δ.

**Mid-morning events (ISM, JOLTS at 10:00 AM ET):** If already in position, set a tight stop 15 pts above the short call strike before the release. Wait 15 minutes after release if not yet in. No Entry 2 within 30 minutes of release.

**AM-settlement expiration days (monthly/quarterly):** Delay Entry 1 to 9:15 AM CT, weight the opening range lower, and take Periscope screenshots after 10:00 AM ET.

### Rule 13: Asymmetric IC Leg Management via Charm

Manage each IC leg by its charm. The negative-charm leg (walls decaying) targets 50% profit and closes by 1:00 PM ET. The positive-charm leg (walls strengthening) can be held to settlement or 70–90% profit. Closing one leg turns the IC into a directional spread, and the remaining leg follows Rule 5.

### Rule 14: NPP Surge During Rally = Mechanical Move

SPX NPP at new session highs during a rally means the rally is mechanical and likely to reverse. Don't close CCS on it unless a positive gamma wall has broken (price sustained above it for 10+ minutes). Most reliable when NPP beats its prior session high by 20%+ and NCP isn't rising with it.

### Rule 15: Negative Gamma Proximity — Afternoon CCS Exit

After 2:00 PM ET, a −1000+ negative gamma cluster within 30 pts of the CCS short call means close now, regardless of profit. At 30–50 pts, close by 2:30 PM ET. At 50+ pts, normal time rules apply.

### Rule 16: Aggregate GEX Regime Adjustment

OI Net Gamma Exposure from the API sets management aggressiveness:

| OI GEX                                    | Management                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positive (above +50,000)                  | Normal: walls reliable, standard targets and time exits                                                                                            |
| Mildly negative (−50,000 to 0)            | Tighten CCS time exits by 30 minutes                                                                                                               |
| Moderately negative (−50,000 to −150,000) | Close CCS by 12:00 PM ET, target 40% instead of 50%, Rule 15's proximity threshold widens to 40 pts                                                |
| Deeply negative (below −150,000)          | Close CCS by 11:30 AM ET or at 40%, whichever comes first; reduce size a further 10%; PCS with positive-charm walls may be held with tighter stops |

Strongly positive Volume GEX can make the session calmer than the OI number suggests, but doesn't extend the OI-based time limits.

- **Periscope Charm ceiling override:** +100M or more Periscope Charm at a positive gamma wall within 20 pts above the CCS short call extends the CCS deadline by 1–2 hours.
- **VIX1D extreme inversion extension:** the CCS/PCS deadline may extend to 2:00 PM ET when VIX1D is 20%+ below VIX, all positions are defined-risk spreads, cushion to the nearest short strike exceeds 60 pts, and Periscope Charm shows +50M at 3+ strikes protecting the short side. If any condition fails, the standard deadline applies.

### Rule 17: Vanna-Adjusted Management Timing

With positive aggregate vanna and VIX down 1+ pt from the session high: CCS exits move 30 minutes earlier, PCS may hold 30 minutes longer, ICs are unchanged. With negative vanna and rising VIX: tighten PCS exits. The adjustment applies to the final Rule 16 deadline, after any Charm override.

### Rule 18: GEX Wall Strike Placement Discipline

A positive GEX wall can anchor a short strike only if it passes all five checks:

- **30-pt minimum distance** from the 8:30 AM CT spot, not from the intraday entry spot.
- **Shelf, not spike:** 3–4 adjacent strikes of contiguous positive gamma. A lone spike is a pin, not a wall.
- **No new wall-based entries after 1:00 PM ET**, unless the wall is a shelf with enough coverage to survive a 50% gamma haircut.
- **Exit on wall touch**, not on short-strike touch.
- **Never short into a negative-gamma pocket** above a positive-gamma spike: place the short at the wall with a hard exit on touch, or far past it at the next genuine positive concentration.

Rule 18 overrides Rule 6's widening into a pin, and extends Rule 7's stop discipline to short-strike placement.

### Rule Priority

When rules conflict, the higher-priority rule wins and Claude notes the conflict:

1. Rule 12 (event-day hard exits)
2. Rule 3 Friday management tiers
3. VIX1D extreme inversion overrides
4. Periscope Charm overrides
5. Rule 5 (direction-aware stops)
6. Rule 16 (GEX regime)
7. Rule 9 (10Δ premium floor)
8. All other rules in numerical order

### Sizing Tiers

Entry 1 size as a percentage of the daily risk budget; later entries follow the same tier unless conditions change:

| Tier     | Entry 1 | When                                                                                                          |
| -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| FULL     | 40%     | High confidence, all primary signals aligned, 3+ sources confirm                                              |
| STANDARD | 30%     | Moderate confidence; one secondary signal conflicting or absent                                               |
| REDUCED  | 20%     | Low confidence (several secondary signals conflict), or structural protection (gamma walls, charm) unreliable |
| MINIMUM  | 15%     | Marginal entry: one strong signal overrides several weak objections                                           |

- Reductions from different rules stack, one tier at a time.
- A reduction below MINIMUM means SIT OUT, and so does MINIMUM at LOW confidence.
- Total across all entries is capped at 100% of the daily budget, and any single entry at 40%. If Entry 1 is MINIMUM, the total is capped at 50%.

---

## Position Sizing Guide

Conservative: 5% of account per day (survives 10+ max losses). Moderate: 10%. Aggressive: 15%.

In the app, the AI analysis sizes Entry 1 as 15–40% of this daily budget (see [Sizing Tiers](#sizing-tiers)), the Risk Calculator shows 1–10% per-trade tiers, and the Position Monitor warns when total effective max loss reaches 12% of account value.

Multiple positions on the same underlying and expiration are NOT diversified — always sum total buying power.
