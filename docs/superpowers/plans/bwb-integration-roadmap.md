# Broken Wing Butterfly Integration Roadmap

**Date:** 2026-03-30
**Scope:** Add BWB as a structure recommendation alongside IC / CCS / PCS / SIT OUT in the Claude analysis engine, strike calculator, and supporting P&L/PoP calculations.

---

## Background

A Broken Wing Butterfly (BWB) is a 3-leg options structure with asymmetric wings. One wing is wider than the other, which can produce a net credit on entry while creating a "sweet spot" profit zone around the short strikes. Unlike credit spreads, which profit anywhere beyond the short strike, BWBs profit maximally when price settles at a specific level.

BWBs are the right structure when the data says "price will move to X and stop there" rather than "price will move in X direction." All four of the following must be present:

1. **Positive aggregate GEX** — walls are reliable for the session. This is the foundational prerequisite. Without it, the gamma wall that defines the sweet spot may fail under pressure.
2. **Directional flow consensus** (Market Tide + ETF Tide + Net Flow agree on direction) — price has a reason to move toward the wall. Without directional flow, price stays put and an IC is the correct symmetric structure.
3. **Dominant positive gamma wall in the flow direction** (Rule 6 — 10x+ concentration, 20-40 pts from current price) — the specific landing zone. This wall acts as a price magnet where the BWB sweet spot is placed.
4. **Positive charm at that wall** (strengthening with time) — the wall gets harder as the day progresses, ensuring it holds into the afternoon for settlement.

Supporting signals (not required, but increase confidence):
- Opening range has consumed >50% of the straddle cone (compressed remaining range reduces overshoot probability)
- Dark pool buyer/seller clusters align with the gamma wall (institutional capital at the same level)

**When to use each structure:**

| Signal Combination | Structure |
|---|---|
| Positive GEX + directional flow + dominant wall + positive charm | **BWB** (precision) |
| Positive GEX + neutral flow + symmetric gamma | **IC** (range) |
| Negative GEX or no dominant wall + directional flow | **CCS/PCS** (momentum) |
| Conflicting signals or VIX > 25 | **SIT OUT** |

---

## Phase 1: Calculation Engine

**Goal:** Price BWB legs, compute P&L profile, PoP, and Greeks using the existing Black-Scholes engine.

### 1.1 New utility module: `src/utils/bwb.ts`

The BWB has 3 legs:
- **Long far wing** (further OTM, defines max loss side)
- **2x Short strikes** (the sweet spot)
- **Long near wing** (closer to money, defines the credit side)

Functions needed:

```
buildPutBWB(spot, shortStrike, narrowWidth, wideWidth, sigma, T, skew)
buildCallBWB(spot, shortStrike, narrowWidth, wideWidth, sigma, T, skew)
```

Each returns:
- **Legs:** 3 strikes with premiums from existing `blackScholesPrice()`
- **Net credit/debit:** (2 x short premium) - long near - long far
- **Max profit:** net credit + narrow wing width (at short strike)
- **Max loss:** wide wing width - narrow wing width - net credit (on wide side)
- **Breakeven:** short strike - (narrow width - credit) for put BWB; short strike + (narrow width - credit) for call BWB
- **Sweet spot:** the short strike level
- **PoP:** P(expires in profit zone) using existing `normalCDF()` with skew-adjusted sigma
- **Greeks:** aggregate delta, gamma, theta, vega across 3 legs from existing `calcBSDelta()`, `calcBSGamma()`, etc.

**Dependencies:** `black-scholes.ts` (all functions already exported), `strikes.ts` (snap to $5 increments)

**No new math required.** Every calculation is a composition of existing Black-Scholes functions applied to 3 legs instead of 2 or 4.

### 1.2 Wing width configuration

The existing Advanced Section has a wing width selector (5, 10, 15, 20, 25, 30, 50 pts) used for IC spreads. BWBs need two widths:

- **Narrow wing:** distance from short strike to the near long (the credit side)
- **Wide wing:** distance from short strike to the far long (the risk side)

Design options:
- **Option A:** Single "narrow width" selector + a multiplier for the wide wing (e.g., narrow = 20, wide = 2x = 40). Simpler UI.
- **Option B:** Two independent width selectors. More flexible but more cognitive load.
- **Recommended:** Option A. Default multiplier of 2x (wide = 2 x narrow). The trader can adjust the multiplier to control credit vs max loss tradeoff. This mirrors how the existing wing width selector works for ICs.

### 1.3 Tests

Add to `src/__tests__/`:
- P&L at expiry for put BWB at 10+ price points (verify sweet spot, breakeven, max loss, credit zone)
- P&L at expiry for call BWB (mirror)
- Greeks aggregate correctly across 3 legs
- PoP calculation matches expected range
- Edge cases: ATM short strike, very wide wings, near-zero time to expiry
- Snap-to-$5 on all 3 strikes

---

## Phase 2: Results Display

**Goal:** Show BWB P&L profile in the UI when the structure is relevant.

### 2.1 BWB results section

Add a new section (or tab within the existing Iron Condor section) that shows:

- **Legs table:** 3 strikes (long far, 2x short, long near) with SPX and SPY equivalents, premiums per leg
- **P&L summary:** net credit/debit, max profit (at sweet spot), max loss, breakeven, sweet spot level
- **PoP:** probability of expiring in profit zone (log-normal + kurtosis-adjusted, same as IC)
- **Dollar P&L:** contracts x $100 multiplier
- **Risk tier color-coding:** same as IC (green/yellow/orange/red based on RoR)

### 2.2 P&L profile table

Show P&L at 5-point SPX intervals across the full range, similar to the IC section but with the BWB's asymmetric profile:

| SPX at Expiry | P&L | Zone |
|---|---|---|
| ... | +$200 | Credit kept |
| 5390 | +$1,200 | Approaching sweet spot |
| **5380** | **+$2,200** | **Max profit** |
| 5370 | +$1,200 | Overshooting |
| 5358 | $0 | Breakeven |
| ... | -$1,800 | Max loss (capped) |

### 2.3 Sweet spot overlay

The BWB's value proposition is the sweet spot. The UI should highlight where the sweet spot sits relative to:
- Current SPX price (distance in points and %)
- The straddle cone boundaries
- The dominant gamma wall (if chain data is loaded)
- Max pain level

This cross-reference is what makes the BWB decision actionable: "Your sweet spot at 5,380 aligns with the +10,000 gamma wall. Price is 20 pts above. Cone lower boundary is at 5,365."

---

## Phase 3: Claude Analysis Integration

**Goal:** Add BWB as a structure recommendation in the analyze endpoint.

### 3.1 Validation schema update

In `api/_lib/validation.ts`, add BWB variants to the structure enum:

Current: `IRON CONDOR | CALL CREDIT SPREAD | PUT CREDIT SPREAD | SIT OUT`

Updated: `IRON CONDOR | CALL CREDIT SPREAD | PUT CREDIT SPREAD | PUT BWB | CALL BWB | SIT OUT`

Update `analysisResponseSchema` to accept the new structure values.

### 3.2 System prompt additions

In `api/_lib/analyze-prompts.ts`, add BWB guidance to the thinking steps and structure selection rules.

#### Step 7 update (Structure Decision)

Add BWB as a candidate structure. The decision tree becomes:

```
1. Aggregate GEX regime (Rule 16) determines WALL RELIABILITY:
   a. POSITIVE → walls reliable, BWB eligible
   b. MILDLY NEGATIVE or worse → walls compromised, BWB ineligible (IC or credit spread)
2. Flow consensus (Rule 8) determines DIRECTION:
   a. Directional (bullish or bearish) → directional structure (CCS/PCS or BWB)
   b. Neutral → IC (symmetric, no directional lean needed)
3. If GEX positive AND flow directional, gamma profile determines PRECISION:
   a. Dominant positive gamma wall in flow direction (Rule 6) → BWB candidate
   b. No dominant wall → credit spread (no precision target)
4. If BWB candidate, confirm with:
   a. Charm at the wall is positive (strengthening with time) → BWB confirmed
   b. If charm is negative or mixed → fall back to credit spread (wall may not hold)
```

#### New rule: BWB Structure Selection

```
RULE 18: Broken Wing Butterfly Selection
Evaluate BWB as an alternative to a credit spread when ALL four core criteria
are present. These are not independent checks — each one addresses a specific
risk that would make the BWB fail:

BWB CONFIRMED when ALL of the following are true:
1. Aggregate GEX is POSITIVE (Rule 16) — walls are reliable for the session.
   Without positive GEX, the gamma wall defining the sweet spot may fail under
   sustained pressure, and the BWB's precision bet becomes a liability.
2. Directional flow consensus (Rule 8 weighted flow is bullish or bearish at
   MODERATE+ confidence) — price has a reason to move toward the wall. Without
   directional flow, price stays put and an IC is the correct structure.
3. Dominant positive gamma wall in the flow direction (Rule 6 — 10x+
   concentration, 20-40 pts from current price) — the specific landing zone
   where the BWB sweet spot is placed.
4. Positive charm at the wall (strengthening with time — Rule 11 check) — the
   wall gets harder as the day progresses, ensuring it holds into the afternoon.

BWB REJECTED (use credit spread instead) when ANY of the following are true:
- Aggregate GEX is MILDLY NEGATIVE or worse (walls not fully reliable)
- Flow is neutral or LOW confidence (no directional push toward the wall)
- No dominant gamma wall in the flow direction (no precision target)
- Charm at the wall is negative or mixed (wall may decay before settlement)
- VIX > 25 (elevated vol increases overshoot risk beyond the sweet spot)
- High-impact event within 2 hours (binary outcome, not a precision trade)

Sweet spot placement:
- Place the BWB short strikes AT the dominant gamma wall
- The narrow wing faces the flow direction (the "safe" side — no risk if price
  moves this way past the sweet spot)
- The wide wing faces away from the flow direction (the risk side — max loss if
  price reverses through the wall)
- Example: bearish flow, gamma wall at 5,380 → Put BWB with short strikes at 5,380,
  narrow wing at 5,400 (upside = keep credit), wide wing at 5,340 (downside = risk)

Confidence for BWB:
- All 4 BWB criteria met + dark pool cluster aligns with wall → HIGH
- All 4 BWB criteria met, no dark pool data → MODERATE
- 3 of 4 criteria met → LOW (consider credit spread instead)
- Fewer than 3 → do not recommend BWB

Sizing:
- BWB uses the same tier system (FULL/STANDARD/REDUCED/MINIMUM) as credit spreads
- Apply the same cumulative reductions from other rules
- BWB max loss is typically larger than credit spread max loss for the same credit,
  so the effective risk per contract is higher — note this in the sizing guidance

Management rules for BWB differ from credit spreads:
- Do NOT use the standard "close at 50% profit" target — BWB profit peaks at the
  sweet spot and declines on either side. Target 60-80% of max profit if price is
  near the sweet spot.
- Time-based exits follow Rule 16 GEX regime, same as credit spreads.
- Stop condition: close if SPX breaks through the wide wing's long strike (the
  gamma wall has failed and the sweet spot is no longer reachable).
- Direction-aware stops (Rule 5) apply: if price moves AWAY from the sweet spot
  toward the narrow wing side, this is the thesis-confirming safe direction — the
  credit is kept. Do not close on moves away from the sweet spot on the narrow side.
```

#### Response format update

Add BWB-specific fields to the strikes section of the JSON response:

```json
{
  "structure": "PUT BWB",
  "strikes": {
    "shortStrike": 5380,
    "longNearStrike": 5400,
    "longFarStrike": 5340,
    "narrowWidth": 20,
    "wideWidth": 40,
    "sweetSpot": 5380,
    "creditReceived": 2.00,
    "maxProfit": 22.00,
    "maxLoss": 18.00,
    "breakeven": 5358
  }
}
```

### 3.3 Calibration example

Add a BWB calibration example to `api/_lib/analyze-calibration.ts` for the entry mode, showing Claude a correct BWB recommendation with the right format and reasoning chain.

### 3.4 Context assembly

No changes needed in `api/_lib/analyze-context.ts`. The BWB decision uses the same data sources already fetched: flow data, GEX profile, per-strike gamma/charm, straddle cone, dark pool, max pain. The prompt rules tell Claude how to synthesize them into a BWB vs credit spread decision.

---

## Phase 4: ML Pipeline

**Goal:** Track BWB recommendations and outcomes for model training.

### 4.1 Label expansion

In `api/cron/build-features.ts`, the `day_labels` extraction currently maps `recommended_structure` to CCS/PCS/IC/SIT OUT. Add PUT BWB and CALL BWB as valid structures.

### 4.2 Outcome evaluation

BWB success/failure is different from credit spreads:
- **Credit spread success:** settlement is beyond the short strike (full credit kept)
- **BWB success:** settlement is within the profit zone (between breakeven and the narrow wing long strike)
- **BWB optimal:** settlement is at or near the sweet spot (within 5 pts)

The `structure_correct` label in `day_labels` needs to evaluate BWB outcomes against the profit zone, not just directional correctness.

### 4.3 Feature additions

Consider adding BWB-specific features to `training_features` in a future migration:
- `gamma_wall_dominant_dist` — distance from price to the largest positive gamma wall (already partially captured by `gamma_wall_above_dist` / `gamma_wall_below_dist`)
- `cone_consumption_pct` — already exists as `opening_range_pct_consumed`
- `charm_at_wall_sign` — whether charm is positive or negative at the nearest dominant wall

Most BWB-relevant features are already captured. The primary gap is the charm-at-wall interaction, which requires joining per-strike charm with the dominant wall location.

---

## Phase 5: Frontend Integration

**Goal:** Display BWB recommendations from Claude alongside existing structures.

### 5.1 Analysis response handling

In the chart analysis component, handle `structure: "PUT BWB"` and `structure: "CALL BWB"` responses:
- Display the 3-leg structure (long far, 2x short, long near) with premiums
- Show the sweet spot level and its proximity to gamma walls
- Show the P&L profile with the asymmetric shape
- Highlight the key difference from credit spreads: "Max profit at 5,380. Keep credit if SPX stays above 5,400. Risk if SPX drops below 5,340."

### 5.2 Position Monitor

When parsing Schwab CSV uploads or live positions, identify BWB structures:
- 3 legs at the same expiry
- 2x short at one strike, 1x long at each of two different strikes
- Unequal distances from the short strike to each long

### 5.3 Export

Add BWB to the Excel export module alongside IC and credit spread P&L comparisons.

---

## Implementation Sequence

| Order | Phase | Effort | Dependencies |
|---|---|---|---|
| 1 | Phase 1 — Calculation engine | Medium | None |
| 2 | Phase 2 — Results display | Medium | Phase 1 |
| 3 | Phase 3.1-3.2 — Prompt rules | Medium | None (can parallel with 1-2) |
| 4 | Phase 3.3 — Calibration example | Low | Phase 3.2 |
| 5 | Phase 5.1 — Analysis response | Low | Phase 3 |
| 6 | Phase 4 — ML pipeline | Low | Phase 3 (need BWB recommendations to label) |
| 7 | Phase 2.3 — Sweet spot overlay | Low | Phase 1 + chain data |
| 8 | Phase 5.2-5.3 — Position + export | Low | Phase 1 |

Phases 1-2 (calculation + display) and Phase 3.1-3.2 (prompt rules) can be built in parallel. The prompt rules don't depend on the frontend calculation — Claude recommends strikes based on the gamma profile, and the frontend calculates the P&L independently.

---

## Risks and Open Questions

**1. Calibration data.** Claude has no BWB calibration example to learn from. The first BWB recommendations will be based purely on the prompt rules with no validated example. The calibration example (Phase 3.3) should be added as soon as the first real BWB setup is observed and confirmed correct.

**2. Overshoot frequency.** The core risk of BWB is price overshooting the sweet spot. Without historical data on how often gamma walls hold at the 0DTE sweet spot level, the BWB confidence calibration is theoretical. The ML pipeline (Phase 4) will eventually provide this data, but early BWB recommendations should default to MODERATE confidence until validated.

**3. Liquidity on 3-leg orders.** SPX 0DTE has excellent liquidity, but 3-leg orders may experience wider fills than 2-leg spreads. The premium/credit estimates from Black-Scholes won't account for this slippage. Consider adding a slippage note to the BWB display.

**4. When to show BWB vs IC in the calculator.** The calculator currently always shows IC results when the toggle is on. Adding BWB results means either showing both simultaneously (cluttered) or letting the user toggle between them. The recommended approach: show BWB as a separate toggle below the IC toggle, with a note about when BWB is appropriate.

**5. Interaction with directional opportunity.** The existing `directionalOpportunity` field recommends 14 DTE ATM longs after 12 PM ET. BWBs are a 0DTE structure and would be recommended earlier in the day. These two features don't conflict — they operate in different time windows. But the prompt should clarify that BWB is a 0DTE structure, not a multi-day position.
