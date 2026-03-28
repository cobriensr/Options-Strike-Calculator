# Analyze Prompt Audit & Implementation Plan

**Date**: 2026-03-28
**Reviewed by**: Claude (senior 0DTE SPX derivatives trader perspective)
**File under review**: `api/_lib/analyze-prompts.ts`
**Supporting files**: `api/_lib/analyze-context.ts`, `api/_lib/db-positions.ts`, `api/_lib/lessons.ts`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Section I: Data Pipeline Gaps](#2-section-i-data-pipeline-gaps)
3. [Section II: Rule Fixes & Contradictions](#3-section-ii-rule-fixes--contradictions)
4. [Section III: Missing Market Microstructure Concepts](#4-section-iii-missing-market-microstructure-concepts)
5. [Section IV: New Data Points to Add](#5-section-iv-new-data-points-to-add)
6. [Section V: Prompt Structure Improvements](#6-section-v-prompt-structure-improvements)
7. [Implementation Priority Matrix](#7-implementation-priority-matrix)
8. [File Change Index](#8-file-change-index)

---

## 1. Executive Summary

The analyze prompt is one of the most sophisticated retail 0DTE systems in production. The flow hierarchy (Rule 8), Periscope Charm Override for naive all-negative, direction-aware stops (Rule 5), and the Phase 1/Phase 2 Chart Reading Protocol are institutional-grade. The 7-14 DTE hedge guidance is correct and rarely articulated. Rule 14 (NPP surge during rally = mechanical) captures genuine dealer behavior.

This audit identifies **20 items** across five categories:

| Category | Count | High Priority | Medium | Low |
|---|---|---|---|---|
| Data Pipeline Gaps | 4 | 1 | 3 | 0 |
| Rule Fixes & Contradictions | 3 | 2 | 0 | 1 |
| Missing Microstructure Concepts | 4 | 2 | 2 | 0 |
| New Data Points | 4 | 0 | 0 | 4 |
| Prompt Structure Improvements | 5 | 2 | 1 | 2 |

**Estimated scope**: 8 high-priority items (prompt text changes + 1 new formatter), 6 medium (prompt text + 2 new formatters), 6 low (future consideration).

---

## 2. Section I: Data Pipeline Gaps

These are data sources your system already collects or calculates but does not expose to Claude in the analyze context.

### I-1. Vanna Exposure (HIGH PRIORITY)

**Problem**: The database stores per-strike vanna (OI + volume) and aggregate vanna exposure (`vanna_oi`, `vanna_vol`, `vanna_dir` in the spot exposures table), but no formatter in `analyze-context.ts` assembles this data into prompt text. Claude has zero visibility into vanna dynamics.

**Why it matters for 0DTE**: Vanna measures dDelta/dIV -- how delta changes when implied volatility moves. This is critical because:

- **Vol crush rally pattern** (occurs 3-4x/week): When IV drops intraday (post-CPI settle, post-FOMC clarity, afternoon vol compression), positive aggregate vanna creates synthetic long delta. Dealers who are long vanna must buy futures as IV drops, mechanically pushing SPX higher. If you hold a CCS, this tailwind pushes price toward your short call with no warning in the current prompt.
- **Vol spike acceleration**: When IV spikes, negative vanna accelerates selloffs by making dealers shorter delta as vol rises. PCS holders face compounding risk -- price drops AND delta exposure increases.
- **Afternoon compression**: IV typically compresses between 1:00-3:00 PM ET on non-event days. Positive vanna during this window creates a systematic upward drift that the prompt currently attributes to "flow" or "gamma" when it's actually vanna-driven.

**Current state in code**:
- `spot_exposures` table has `vanna_oi`, `vanna_vol`, `vanna_dir` columns (populated by cron)
- `getSpotExposures()` in `analyze-context.ts` queries these columns
- `formatSpotExposuresForClaude()` scales gamma/charm by 1M but **does not format vanna** into the context string
- Per-strike vanna exists in `strike_exposures` table (`call_vanna_oi`, `put_vanna_oi`, etc.)

**Implementation**:

1. **New formatter** -- add `formatVannaForClaude()` in `analyze-context.ts`:

```typescript
function formatVannaForClaude(spotData: SpotExposure[]): string {
  // Extract latest vanna_oi, vanna_vol, vanna_dir from spot data
  // Scale by /1,000,000 to match GEX panel units
  // Compute direction: positive = long vanna (vol drop → SPX up)
  //                    negative = short vanna (vol drop → SPX down)
  // Include intraday trend (is vanna growing or shrinking?)
  // Return formatted string block
}
```

2. **New prompt section** -- add `<vanna>` inside `<chart_types>`:

```
<vanna>
Aggregate Vanna Exposure shows how dealer delta exposure changes when implied
volatility moves. This is provided as structured API data.

Key concepts:
- POSITIVE aggregate vanna: When IV drops, dealers gain long delta (must buy
  futures to hedge). This creates upward price pressure. When IV rises, dealers
  lose delta (must sell futures). This creates downward pressure.
- NEGATIVE aggregate vanna: The reverse -- IV drops create selling pressure,
  IV rises create buying pressure.

How to interpret for structure selection:
- Positive vanna + VIX declining intraday = structural SPX upward drift.
  CCS holders: tighten upside stops by 5-10 pts. PCS holders: this is
  additional structural support beyond gamma walls.
- Positive vanna + VIX rising intraday = double headwind for longs.
  Dealers are selling delta while price is already falling. Accelerates
  selloffs beyond what gamma alone predicts.
- Negative vanna (rare, typically on extreme skew days): the vol-price
  relationship inverts. Use with caution -- confirm with gamma direction.

How to use for management:
- Between 1:00-3:00 PM ET on non-event days, IV typically compresses.
  If aggregate vanna is positive and VIX has dropped 1+ pts from the
  session high, expect 5-15 pts of mechanical upward drift. Do not
  close PCS positions during this window. Tighten CCS stops.
- After FOMC/CPI, IV drops rapidly (vol crush). Large positive vanna
  amplifies the post-announcement rally. If holding CCS through a data
  release (against Rule 12 guidance), vanna acceleration is the primary
  risk -- not just the data itself.
- Vanna exposure is most relevant when VIX moves >1 pt intraday.
  On low-VIX days where VIX barely moves, vanna is a secondary signal.
</vanna>
```

3. **New rule** -- add Rule 17 to `<structure_selection_rules>`:

```
RULE 17: Vanna-Adjusted Management Timing
When aggregate vanna is positive (from API) AND VIX has declined 1+ pts
from the session high:
- CCS positions: tighten the Rule 16 time-based exit by 30 minutes.
  The vanna-driven upward drift adds risk beyond what gamma alone captures.
- PCS positions: may extend the hold window by 30 minutes -- vanna
  tailwind provides additional structural support.
- IC positions: no change -- vanna helps one side and hurts the other,
  netting out for the combined structure.
When aggregate vanna is negative AND VIX is rising:
- PCS positions: tighten exits. The vanna headwind compounds the
  gamma acceleration on selloffs.
```

**Files to modify**:
- `api/_lib/analyze-context.ts` -- add `formatVannaForClaude()`, include in context assembly
- `api/_lib/analyze-prompts.ts` -- add `<vanna>` section and Rule 17

---

### I-2. Skew Data (MEDIUM PRIORITY)

**Problem**: The Black-Scholes module (`src/utils/black-scholes.ts`) computes put/call skew curves using a power function (exponent 1.35 for puts, linear with dampening for calls), but these values are used only internally for strike pricing. Claude never sees skew steepness or intraday skew changes.

**Why it matters for 0DTE**: Skew tells you how institutions are pricing tail risk relative to ATM:

- **Steep put skew** = institutions aggressively bidding for downside protection. PCS collects more premium, but the market is pricing larger left-tail risk. This is an independent signal from NCP/NPP -- you can have neutral flow with steep skew (institutions are hedging quietly via limit orders, not aggressive ask-side buying).
- **Flattening put skew intraday** = institutions unwinding hedges. Often precedes a rally. This is a flow confirmation signal that arrives before NCP/NPP show it -- hedge unwinds happen via spread trades that barely register in net premium flow.
- **Call skew steepening** = someone buying upside aggressively. Possible short squeeze setup or institutional accumulation. Rare on 0DTE but meaningful when present.
- **Skew term structure** (0DTE skew vs 7DTE skew): When 0DTE put skew is steeper than 7DTE, the market is pricing an intraday-specific risk (event, gamma acceleration). When 0DTE skew is flatter than 7DTE, the market expects today to be calmer than the multi-day outlook -- supports premium selling.

**Current state in code**:
- `src/utils/black-scholes.ts` contains `putSkew()` and `callSkew()` functions
- Skew is applied during strike pricing in the calculator UI
- The IV term structure formatter (`formatIvTermStructureForClaude()`) fetches interpolated IV but not skew specifically
- The UW API endpoint `/api/stock/SPX/interpolated-iv` may include skew data (needs verification)

**Implementation**:

1. **Derive skew metrics from option chain data** already available in the IV term structure API response. Compute:
   - 25-delta put IV minus ATM IV (the "25Δ put skew")
   - 10-delta put IV minus ATM IV (the "10Δ put skew" -- tail risk premium)
   - 25-delta call IV minus ATM IV (the "25Δ call skew")
   - Skew ratio: (25Δ put skew) / (25Δ call skew) -- >1.5 means puts are significantly more expensive than calls

2. **Add to IV term structure formatter** in `analyze-context.ts`:

```typescript
// Inside formatIvTermStructureForClaude():
// After existing IV term structure output, append:
const putSkew25 = ivData.put25Delta - ivData.atm;
const callSkew25 = ivData.call25Delta - ivData.atm;
const skewRatio = Math.abs(putSkew25 / callSkew25);
// Format: "Put Skew (25Δ): +8.2 vol pts | Call Skew (25Δ): +3.1 vol pts | Ratio: 2.6x"
```

3. **Add to prompt** `<iv_term_structure>` section:

```
Skew metrics (when available):
- 25Δ put skew > 8 vol pts: institutions pricing significant downside
  risk. PCS premium is rich but tail risk is elevated. Confirm with
  NPP -- if NPP is also surging, the skew is reflecting real demand.
  If NPP is flat, the skew is from limit-order hedging (quieter signal).
- 25Δ put skew < 4 vol pts: unusually flat. Institutions are NOT
  hedging aggressively. Supports IC and PCS with higher confidence.
- Skew ratio > 2.0: strong put-over-call risk premium. The market
  expects any large move to be to the downside.
- Skew ratio < 1.2: unusually symmetric. The market sees equal
  up/down risk -- supports IRON CONDOR.
- Intraday skew flattening (put skew dropping 2+ vol pts from open):
  hedge unwind in progress. Bullish for SPX. Increases PCS confidence
  by one level if confirmed by declining NPP.
```

**Files to modify**:
- `api/_lib/analyze-context.ts` -- extend `formatIvTermStructureForClaude()` with skew metrics
- `api/_lib/analyze-prompts.ts` -- extend `<iv_term_structure>` section

**Dependencies**: Verify that the UW interpolated-IV endpoint returns per-delta IV data. If not, skew must be computed from the raw option chain (which may require a new API call to `/api/stock/SPX/option-chain`).

---

### I-3. Pin Risk / OI Concentration (MEDIUM PRIORITY)

**Problem**: The codebase includes a `pin-risk.ts` module that identifies high-OI strikes (gravitational magnets near expiry), but this data is never formatted into the prompt context. Claude cannot warn about placing short strikes at max-OI levels.

**Why it matters for 0DTE**: As expiration approaches, high-OI strikes create gravitational pull through dealer delta-hedging. If your short strike IS the highest-OI level, you're at maximum pin risk -- SPX will oscillate around your strike in the final 30-60 minutes as dealers continuously adjust delta. Each oscillation can push the spread ITM and back OTM, creating whipsaw P&L. With 5-wide spreads, even a brief 2-point ITM excursion can cost $200/contract.

**Current state in code**:
- `pin-risk.ts` exists and computes OI concentration
- Per-strike OI data is available in the `strike_exposures` table
- The all-expiry per-strike formatter includes gamma but not OI specifically

**Implementation**:

1. **New formatter** -- add `formatPinRiskForClaude()` in `analyze-context.ts`:

```typescript
function formatPinRiskForClaude(strikeData: StrikeExposure[]): string {
  // Filter to 0DTE strikes only
  // Sort by total OI (call OI + put OI) descending
  // Return top 5 strikes with OI values
  // Flag if any are within 20 pts of current SPX price
  // Format: "0DTE OI Concentration: 5850 (42K OI), 5875 (38K OI), ..."
}
```

2. **Add to prompt** -- new `<pin_risk>` section inside `<chart_types>`:

```
<pin_risk>
0DTE Open Interest Concentration shows which strikes have the most
outstanding contracts. This is provided as structured API data.

Key concepts:
- The top-OI strike acts as a gravitational magnet in the final
  60-90 minutes. Dealer delta-hedging at high-OI levels creates
  oscillating price action around that strike.
- Pin risk is highest when the top-OI strike is within 10 pts of
  current SPX price AND more than 50% of total 0DTE OI is
  concentrated at 3 or fewer strikes.
- Pin risk is negligible when OI is evenly distributed across
  20+ strikes (no single magnet).

How to use for strike placement:
- NEVER place a short strike at the #1 or #2 OI concentration
  level. If SPX pins there, your short option oscillates between
  ITM and OTM in the final 30 minutes -- whipsaw losses.
- IDEAL placement: short strike 15-25 pts BEYOND a high-OI
  level. The OI concentration acts as a buffer -- price is
  gravitationally pulled TOWARD the high-OI strike and AWAY
  from your short strike.
- If the highest-OI strike aligns with a positive gamma wall
  (from Periscope), that level has TRIPLE protection: gamma
  suppression + OI gravity + dealer hedging. Place short
  strikes beyond this level with highest confidence.

How to use for management:
- After 2:30 PM ET, if SPX is within 10 pts of a 30K+ OI
  strike, expect price to pin there. Do not fight the pin
  with directional stops -- it is mechanical, not directional.
- If your short strike IS a high-OI level and you're still
  holding after 2:30 PM: close immediately. The pin oscillation
  will create stop-outs regardless of your stop placement.
- Max pain and the highest-OI strike often coincide. When they
  don't, the highest-OI strike is a stronger pin magnet than
  max pain in the final 60 minutes (OI-based hedging flow
  overwhelms the theoretical max-pain gravity).
</pin_risk>
```

**Files to modify**:
- `api/_lib/analyze-context.ts` -- add `formatPinRiskForClaude()`, include in context assembly
- `api/_lib/analyze-prompts.ts` -- add `<pin_risk>` section

---

### I-4. Position-Level Greeks for Midday Mode (MEDIUM PRIORITY)

**Problem**: The midday analysis receives the trader's open positions (strikes, quantities, sides) but not the position's aggregate greeks. Claude can say "your 5850 short put has 30 pts of cushion" but cannot say "your portfolio is currently net -14 delta and that exposure grows to -22 delta if SPX drops 10 pts."

**Why it matters**: Without position greeks, Claude's midday recommendations are structurally incomplete. The trader might have 3 CCS positions at different strikes that together create -40 delta -- far more directional exposure than any single position suggests. Adding a 4th CCS would stack risk, but Claude can't see the aggregate.

**Current state in code**:
- `db-positions.ts` fetches positions from Schwab via the database
- BSM calculation exists in `src/utils/black-scholes.ts` (frontend)
- No server-side BSM computation for position greeks
- The prompt receives position text: "3x 5850/5855 CCS" but no delta/gamma/theta/vega

**Implementation**:

1. **Add server-side greek calculation** to the position data before formatting:

```typescript
// In analyze-context.ts or a new file api/_lib/position-greeks.ts:
function computePositionGreeks(
  positions: Position[],
  spxPrice: number,
  ivAtm: number,
  hoursToExpiry: number
): PositionGreekSummary {
  // For each leg: compute BSM delta, gamma, theta, vega
  // Aggregate across all positions
  // Return: { netDelta, netGamma, netTheta, netVega,
  //           deltaAt10PtDrop, deltaAt10PtRise }
}
```

2. **Include in midday context** after the position listing:

```
Position Greek Summary:
- Net Delta: -14.2 (bearish exposure — each 1-pt SPX drop gains $14.20)
- Net Gamma: -0.8 (delta becomes more negative as SPX drops)
- Net Theta: +$42.50/hour (collecting $42.50/hr in time decay)
- Net Vega: -$3.20/vol-pt (benefits from IV declining)
- Delta at SPX -10 pts: -22.1 (exposure grows 55% on a 10-pt drop)
- Delta at SPX +10 pts: -8.3 (exposure shrinks on a rally)
```

3. **Add to prompt** `<position_and_continuity>` section:

```
When Position Greek Summary is present, use it to:
1. Assess whether adding a new entry would create excessive
   directional risk. If net delta exceeds ±30, additional
   same-direction entries are NOT recommended regardless of
   flow signals.
2. Identify delta acceleration risk. If "delta at SPX -10 pts"
   shows exposure growing 50%+, the position has dangerous
   convexity — recommend tighter stops or partial close.
3. Contextualize theta vs gamma. If net theta is +$40/hr but
   net gamma is -2.0, the position earns $40/hr in calm markets
   but loses $200 per 10-pt adverse move. Quote this ratio
   when recommending hold vs close.
4. Flag vega risk around events. If net vega is -$5/vol-pt and
   FOMC is at 2:00 PM, a 3-pt VIX spike costs $15/contract
   in mark-to-market before any price move occurs.
```

**Files to modify**:
- `api/_lib/position-greeks.ts` (new file) or extend `analyze-context.ts`
- `api/_lib/analyze-context.ts` -- include position greeks in midday context
- `api/_lib/analyze-prompts.ts` -- extend `<position_and_continuity>`

**Dependencies**: Requires BSM functions available server-side. May need to extract the core BSM math from `src/utils/black-scholes.ts` into a shared module or duplicate the essential functions.

---

## 3. Section II: Rule Fixes & Contradictions

These are issues with existing rules that could cause Claude to produce incorrect or contradictory recommendations.

### II-1. Rule 3 vs Rule 4 Conflict (HIGH PRIORITY)

**Problem**: Rule 3 states: "On Fridays, close ALL iron condor positions by 2:00 PM ET regardless of profit level if VIX is above 19."

Rule 4 contains an inline annotation (the "VIX1D EXTREME INVERSION STOP ZONE OVERRIDE") that states: "When VIX is in the stop zone (above 25) but VIX1D is 20%+ below VIX, the stop zone restriction on IC structures is overridden for premium selling."

These rules directly conflict. On a Friday with VIX 27 and VIX1D 21 (23% below):
- Rule 3 says: EXIT at 2:00 PM, no exceptions
- Rule 4's override says: the stop zone restriction is overridden, ICs are allowed

The March 24 validation cited in Rule 4 (VIX 26.95, VIX1D 20.73, both CCS and PCS expired worthless) is a case where Rule 3 would have forced an unnecessary 2:00 PM exit, losing the final 2 hours of theta collection on positions that ultimately expired worthless.

**Location in code**: `analyze-prompts.ts` lines 269-273 (Rule 3), lines 272-273 (Rule 4 VIX1D override, buried inside the Rule 4 paragraph).

**Proposed fix**: Replace Rules 3 and 4 with a single unified Friday management rule:

```
RULE 3: Friday Management
The combination of 0DTE gamma acceleration and weekend hedging demand
creates elevated risk on Friday afternoons. Apply these tiers:

A) VIX ≤ 19: Standard Friday — no forced early exit. Normal
   Rule 16 GEX-based management applies.

B) VIX 19-25 AND VIX1D extreme inversion is NOT present:
   Hard exit all IC positions by 2:00 PM ET regardless of
   profit level. Directional spreads may be held if the thesis
   is intact and the short strike has 20+ pts of cushion.

C) VIX 19-25 AND VIX1D extreme inversion IS present
   (VIX1D 20%+ below VIX):
   Override the 2:00 PM hard exit. The VIX1D extreme inversion
   indicates today's realized vol is contained despite elevated
   multi-day implied vol. Apply Rule 16 GEX-based deadlines
   instead. Reduce size by 10% as a safety margin.

D) VIX > 25 AND VIX1D extreme inversion IS present:
   Override the stop zone IC restriction. Apply Rule 16
   GEX-based deadlines. Reduce size by 15%. Validated March 24:
   VIX 26.95, VIX1D 20.73, actual range 65 pts (62% of expected
   move). Both CCS and PCS expired worthless.

E) VIX > 25 AND VIX1D extreme inversion is NOT present:
   SIT OUT. The stop zone is active and VIX1D confirms
   elevated intraday vol expectation. No premium selling.

RULE 4: VIX1D > VIX on Friday = Bearish Lean
(Retain the original Rule 4 directional guidance, but remove
the inline VIX1D extreme inversion override — it is now
handled by Rule 3 above.)
When VIX1D exceeds VIX (inverted intraday term structure) on a
Friday, the market is pricing elevated intraday volatility that
typically resolves to the downside from weekend hedging demand.
Bias structure selection toward CALL CREDIT SPREAD and away
from IRON CONDOR, even if morning flow appears neutral.
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- replace Rule 3 text, trim Rule 4

---

### II-2. Sizing Levels Are Undefined (HIGH PRIORITY)

**Problem**: The prompt uses phrases like "reduce by one level," "reduce by 10-15%," "cut contracts by specific percentage," and "reduce sizing" in Rules 4, 10, 15, 16, and the all-negative charm protocol. But "one level" is never defined. Claude picks arbitrary numbers, leading to inconsistent sizing recommendations across analyses.

Examples of vague sizing language currently in the prompt:
- Rule 4 VIX1D override: "still apply tighter management and reduced sizing as a safety margin"
- Rule 9: "size down accordingly"
- Rule 10: "reduce sizing by one level"
- Rule 16 deeply negative GEX: "Reduce position size by an additional 10%"
- All-negative charm: "Reduce position size by an additional 10-15%"

**Location in code**: Scattered across `analyze-prompts.ts` lines 270-375.

**Proposed fix**: Add a `<sizing_tiers>` section inside `<structure_selection_rules>`:

```
<sizing_tiers>
Position sizing uses a tiered system. All percentages refer to
Entry 1 allocation as a percentage of the daily risk budget.
Subsequent entries follow the same tier unless conditions change.

TIER DEFINITIONS:
- FULL (40%): High confidence, all primary signals aligned,
  no conflicting secondary signals. 3+ data sources confirm.
- STANDARD (30%): Moderate confidence. Primary signals agree
  but one secondary signal is conflicting or absent.
- REDUCED (20%): Low confidence. Primary signals agree but
  multiple secondary signals conflict, OR structural protection
  (gamma walls, charm) is unreliable.
- MINIMUM (15%): Marginal entry. One strong signal overrides
  multiple weak objections. The trade is structurally sound but
  the conviction is low.

"Reduce by one level" means drop one tier:
  FULL → STANDARD, STANDARD → REDUCED, REDUCED → MINIMUM.
"Reduce by an additional 10%" means subtract 10% from the
  current tier: STANDARD (30%) → 20%.

CUMULATIVE REDUCTIONS:
When multiple rules each call for size reduction, apply them
sequentially. Example:
- Base: STANDARD (30%) — moderate confidence
- Rule 16 deeply negative GEX: reduce by 10% → 20%
- All-negative charm: reduce by an additional 10% → 10%
- If the cumulative reduction drops Entry 1 below 10%, the
  trade is too compromised — recommend SIT OUT instead.

TOTAL POSITION LIMITS:
- Maximum total allocation across all entries: 100% of daily
  risk budget.
- Maximum for any single entry: 40% (FULL tier).
- If Entry 1 is at MINIMUM (15%), the maximum total across
  all entries is 50% — do not scale into a low-conviction trade.

These tiers apply to the entryPlan.sizePercent field in the
JSON response. Always use the tier name AND percentage.
Example: "sizePercent": 30 with note: "STANDARD — moderate
confidence due to QQQ divergence (Rule 2)."
</sizing_tiers>
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add `<sizing_tiers>` section, update all "reduce by one level" references to use tier names

---

### II-3. Rule 10 Two-Signal Gap (LOW PRIORITY)

**Problem**: Rule 10 says SPX Net Flow hedging divergence triggers when "3+ other signals" confirm the opposite direction. The VIX 25+ override drops this to "SPX alone is sufficient." But the prompt says nothing about the case with exactly 2 confirming signals at VIX < 25.

Two strong confirmations (e.g., Market Tide bearish + SPY bearish) against a bullish SPX NCP is a common intraday pattern. Currently, Claude must decide whether to apply Rule 10 or not -- the threshold says 3+ and only 2 are present.

**Location in code**: `analyze-prompts.ts` lines 316-321.

**Proposed fix**: Add a clause for the 2-signal case after the existing Rule 10 text:

```
TWO-SIGNAL PARTIAL DIVERGENCE (VIX < 25):
When exactly 2 other signals (not 3+) confirm the opposite
direction from SPX Net Flow:
- Reduce SPX Net Flow's effective weight from 50% to 35%.
  Redistribute: Market Tide 30%, SPY 20%, QQQ 15%.
- Do NOT fully override SPX Net Flow — the divergence is
  partial, not confirmed.
- Flag as CONFLICTED with MODERATE confidence.
- Note which 2 signals are confirming and which are not.
  If Market Tide + SPY confirm and QQQ does not, that is
  stronger than Market Tide + QQQ without SPY.
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- append to Rule 10

---

## 4. Section III: Missing Market Microstructure Concepts

These are concepts that a senior 0DTE trader would expect the prompt to address but are currently absent.

### III-1. Settlement Mechanics & MOC Risk (HIGH PRIORITY)

**Problem**: SPX 0DTE settles on the 4:00 PM ET closing print, determined by the closing auction. The prompt never mentions this. MOC (Market on Close) imbalances, published around 3:50 PM ET, routinely move SPX 10-20 points in the final 10 minutes. If a trader holds a 5-wide spread with 12 points of cushion at 3:45 PM, a $3B sell-on-close imbalance can wipe half that cushion before settlement.

The prompt's management rules assume smooth price action through 4:00 PM. They don't account for the discontinuous jump that MOC imbalances create.

**Proposed fix**: Add a `<settlement_mechanics>` section:

```
<settlement_mechanics>
SPX 0DTE Settlement Mechanics:
- SPX 0DTE options settle on the 4:00 PM ET closing print. This
  is determined by the closing auction, NOT continuous last trade.
  The settlement price can differ from the 3:59 PM price by 5-15
  pts on normal days and 15-30 pts on high-volume days.
- MOC (Market on Close) imbalances are published by NYSE around
  3:50 PM ET. These imbalances represent $1-5B+ of stock orders
  that execute at the close. A large sell imbalance mechanically
  pushes SPX down in the final 10 minutes; a buy imbalance pushes
  it up.
- MOC imbalance data is NOT available via API in this system.
  This is a known blind spot.

Management implications:
- If holding to settlement with less than 15 pts of cushion after
  3:45 PM ET: CLOSE MANUALLY rather than risk the auction. The
  MOC imbalance can erase 10+ pts of cushion in minutes, and you
  cannot react once the imbalance is published.
- If holding with 20+ pts of cushion: settlement risk is
  acceptable. The largest MOC-driven moves are typically 15-20 pts.
- On quad-witching / monthly expiration days, MOC imbalances are
  2-3x larger than normal. Add 10 pts to the "safe cushion"
  threshold on these days.
- The MOC risk is directionally random — it depends on
  institutional rebalancing needs. It is NOT a continuation of
  intraday flow direction. A bullish flow day can have a large
  sell-on-close imbalance from pension rebalancing.
</settlement_mechanics>
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add `<settlement_mechanics>` section

---

### III-2. Realized Volatility vs Implied Volatility (HIGH PRIORITY)

**Problem**: The calculator UI sends an RV/IV regime flag to the prompt context, but the prompt does not instruct Claude on how to use it. When realized volatility significantly exceeds implied, the straddle cone is too narrow -- the market is underpricing actual movement, and premium selling is risky. When RV is well below IV, the trader is collecting excess premium (edge).

**Current state in code**:
- The context object includes an `rvIvRatio` or similar field (classified as `RVIV_RICH` or `RVIV_CHEAP`)
- The prompt never references this field
- Claude ignores it completely in analysis

**Proposed fix**: Add to the `<data_handling>` section:

```
RV/IV Ratio (Realized vs Implied Volatility):
The calculator context may include an RV/IV ratio or regime flag.
This measures whether the market is over- or under-pricing actual
price movement relative to what options imply.

How to use for sizing:
- RV/IV > 1.15 (realized vol exceeding implied by 15%+):
  The straddle cone is TOO NARROW. The market is underpricing
  actual movement. SPX is moving more than options predict.
  Reduce position size by one tier. Widen strikes by 1-2Δ
  beyond the normal recommendation. Do not hold to settlement
  — take profit at 40% instead of 50%.
- RV/IV between 0.85 and 1.15: Neutral — IV is fairly pricing
  movement. Standard sizing and management.
- RV/IV < 0.85 (implied vol exceeding realized by 15%+):
  The straddle cone is TOO WIDE. The market is overpricing
  movement relative to what's actually happening. This is the
  premium seller's edge. Standard or FULL sizing is appropriate.
  The cone overstates risk — short strikes can be placed at
  the normal delta ceiling with confidence.

How to use with VIX1D:
- RV/IV < 0.85 AND VIX1D extreme inversion: DOUBLE confirmation
  of overpriced protection. Strongest premium selling setup.
- RV/IV > 1.15 AND VIX1D > VIX: DOUBLE warning. Both realized
  movement and intraday implied vol are elevated. Strongly
  consider SIT OUT.
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add to `<data_handling>` section

---

### III-3. Time-of-Day Patterns (MEDIUM PRIORITY)

**Problem**: The prompt references entry times (9:00 AM CT, 10:00 AM ET) and exit times (1:00 PM, 2:00 PM, 2:30 PM) but doesn't explain the well-documented intraday patterns that drive these timing decisions. Claude follows the rules mechanically without understanding the microstructure behind them.

**Proposed fix**: Add a `<time_of_day>` section:

```
<time_of_day>
Intraday Microstructure Patterns (approximate, subject to event-day
disruption):

9:30-10:00 AM ET (Opening Range):
- Highest volume and volatility of the session. Spreads are widest.
  Gamma is most active.
- The 30-minute opening range establishes the session's initial
  boundaries. A breakout from this range within the first hour
  often sets the session direction.
- Entry 1 timing (9:00 AM CT / 10:00 AM ET) captures the opening
  range completion. Wait for the full 30 minutes before committing
  to directional structures.

10:00-10:30 AM ET (Morning Reversal Window):
- The 10:00 AM reversal is one of the most reliable intraday
  patterns. The morning rally/selloff frequently stalls or
  reverses here as institutional programs settle and economic
  data releases at 10:00 AM (ISM, JOLTS, etc.) shift flow.
- Entry 2 decision should happen here. If the opening range
  direction holds through 10:15 AM, the trend has confirmation.
  If it reverses, wait for the new direction to establish.

10:30 AM - 12:00 PM ET (Institutional Flow):
- Sustained directional flow from institutional execution
  algorithms. This is when NCP/NPP trends are most reliable.
- Entry 3 timing (11:00 AM CT / 12:00 PM ET) captures the
  institutional flow confirmation.

12:00-1:30 PM ET (Lunch Lull):
- Volume drops 40-60% from the morning. Range compresses.
  Spreads widen. Fills are worse.
- This is the safest window for holding premium (low
  volatility) but the worst time to enter new positions
  (wide bid-ask spreads, poor fills, range may be
  temporary compression before an afternoon breakout).
- Do NOT enter new positions during this window unless a
  clear flow reversal signal triggers.

1:30-2:00 PM ET (Gamma/Theta Inversion):
- The theta/gamma ratio of 0DTE options inverts around this
  time. Before this point, theta decay exceeds gamma risk
  (time is your ally). After this point, gamma grows
  exponentially while most theta has been collected (time is
  your enemy).
- This is the mathematical basis for all time-based exit rules.
  If you have 60%+ profit by 1:30 PM, close. The remaining
  theta is not worth the gamma acceleration.

2:00-3:30 PM ET (Power Hour / Gamma Acceleration):
- Volume returns. Gamma is now concentrated near ATM as 0DTE
  options lose time value. Price moves accelerate. Positive
  gamma walls weaken. Negative gamma zones intensify.
- Rule 16 GEX-based time limits are calibrated to this window.
- After 2:30 PM, 0DTE gamma mechanics dominate all other
  signals. Flow, dark pool levels, and max pain become
  secondary to gamma-driven price acceleration.

3:30-4:00 PM ET (MOC / Settlement):
- MOC imbalances published ~3:50 PM can move SPX 10-20 pts.
- See <settlement_mechanics> for specific management guidance.
- If holding to settlement with adequate cushion (20+ pts),
  this window is the final theta collection period. If cushion
  is tight (<15 pts), close manually before 3:50 PM.
</time_of_day>
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add `<time_of_day>` section

---

### III-4. Theta/Gamma Ratio Context (MEDIUM PRIORITY)

**Problem**: The prompt's time-based exits (1:00 PM, 2:00 PM, 2:30 PM) are correct but are presented as arbitrary deadlines rather than consequences of the theta/gamma inversion that occurs on 0DTE options. This means Claude can't adapt when the inversion happens earlier or later than typical (e.g., on high-VIX days, gamma acceleration starts earlier).

**Proposed fix**: Add to `<structure_selection_rules>` as a management principle:

```
THETA/GAMMA INVERSION PRINCIPLE:
All time-based exit rules in this prompt are derived from the
0DTE theta/gamma inversion. Understanding this principle allows
you to adapt timing when conditions are non-standard.

The inversion:
- At market open, a 0DTE 10Δ short option has ~$2.50 of theta
  remaining and ~0.02 gamma. Theta dominates — time is your ally.
- By 1:30 PM ET, the same option has ~$0.80 of theta remaining
  but ~0.05 gamma. The crossover is approaching.
- By 2:30 PM ET, it has ~$0.30 of theta remaining but ~0.10
  gamma. Gamma now dominates — a 10-pt move creates $1.00 of
  adverse delta change, far exceeding the remaining theta income.

When the inversion shifts earlier:
- On VIX 25+ days: gamma acceleration begins by 12:00-1:00 PM ET
  (not 2:00 PM). This is why Rule 16 deeply negative GEX sets an
  11:30 AM exit — the gamma/theta crossover is 1-2 hours earlier
  than normal.
- On VIX 30+ days: the inversion may occur by 11:00 AM. Standard
  time rules are far too late.

When the inversion shifts later:
- On VIX < 14 days: gamma acceleration is muted even at 2:30 PM.
  The theta/gamma crossover may not occur until 3:00-3:15 PM.
  Time-based exits can be extended by 30 minutes.

Application:
- When recommending time-based exits, reference the theta/gamma
  crossover as the reason. "Close by 2:00 PM because remaining
  theta ($0.50) no longer justifies gamma risk (0.08 per point)."
- When VIX is elevated, shift ALL time-based exits earlier
  proportionally. Rule 16 already does this for GEX regimes —
  apply the same logic for VIX-driven gamma acceleration.
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add to `<structure_selection_rules>`

---

## 5. Section IV: New Data Points to Add

These require new data sources or API calls. Lower priority because they expand the data pipeline rather than fixing existing issues.

### IV-1. NYSE TICK Breadth Extremes (LOW PRIORITY)

**What it is**: The NYSE TICK measures the number of NYSE stocks ticking up minus ticking down at each moment. Extreme readings (+1000 or -1000) indicate capitulation-level breadth -- nearly every stock moving in one direction simultaneously.

**Why it matters**: TICK extremes reliably predict short-term reversals. A TICK reading of -1200 during a selloff means the selloff is exhausting itself. Combined with Rule 14 (NPP surge during rally = mechanical), TICK extremes would provide a second confirmation of mechanical vs directional moves.

**Implementation path**:
- Requires a new data provider (TICK is not available from UW API)
- Options: Schwab streaming data, Polygon.io, or manual entry
- Low priority because flow data (NCP/NPP) partially captures the same signal

**Prompt addition if implemented**:
```
<nyse_tick>
NYSE TICK measures instantaneous breadth (stocks ticking up minus down).
- TICK > +1000: capitulation-level buying. The rally is likely exhausting
  itself. Do not chase longs. CCS positions may get relief soon.
- TICK < -1000: capitulation-level selling. The selloff is likely
  exhausting itself. Do not chase shorts. PCS positions may get relief.
- TICK extremes are most reliable when combined with Rule 14 (NPP surge
  during rally). Both signaling mechanical exhaustion = highest confidence
  reversal setup.
- TICK is a 5-second signal. Do not use for structure selection — it
  confirms/contradicts the management thesis for existing positions.
</nyse_tick>
```

**Data source**: Schwab streaming or Polygon.io
**Priority**: Low -- flow data partially substitutes

---

### IV-2. 0DTE Put-Call Ratio (LOW PRIORITY)

**What it is**: A simple ratio of 0DTE put volume to 0DTE call volume. Derivable from the flow data already in the database.

**Why it matters**: When 0DTE P/C > 1.5, put volume is 50% higher than call volume -- extreme hedging demand that often marks intraday bottoms. When P/C < 0.7, call volume dominates -- often marks intraday tops.

**Implementation path**:
- Derive from existing 0DTE flow data in the database
- No new API call needed
- Add to the 0DTE Index Flow formatter

**Prompt addition if implemented**:
```
0DTE Put-Call Ratio:
- P/C > 1.5: extreme hedging demand → potential intraday bottom.
  Increases PCS confidence. Contradicts CCS thesis.
- P/C < 0.7: extreme call speculation → potential intraday top.
  Increases CCS confidence. Contradicts PCS thesis.
- P/C 0.8-1.2: balanced → no additional signal.
- Use as a tiebreaker when flow signals are ambiguous, not as a
  primary structure selection signal.
```

**Data source**: Derivable from existing 0DTE flow tables
**Priority**: Low -- easy to implement, moderate signal value

---

### IV-3. VIX Futures Term Structure (LOW PRIORITY)

**What it is**: The spread between VIX front-month and second-month futures. Currently the prompt tracks VIX, VIX1D, and VIX9D but not the futures term structure.

**Why it matters**: VIX futures contango (front < second month) = normal regime, vol expected to mean-revert. Backwardation (front > second month) = crisis regime, vol expected to persist or increase. This is a higher-level regime signal than VIX1D/VIX alone.

**Implementation path**:
- Requires VIX futures data (CBOE or Schwab API)
- Could use VIX9D as a proxy for front-month (already available)
- The VIX/VIX1D/VIX9D relationship partially captures this

**Prompt addition if implemented**:
```
VIX Futures Term Structure:
- Contango (front month < second month): Normal. Vol expected
  to mean-revert. Supports premium selling.
- Flat (spread < 0.5 pts): Neutral — no additional signal.
- Backwardation (front > second month by 1+ pts): Crisis
  regime. Vol persistence expected. Reduce sizing by one tier.
  Do not hold to settlement — take profit at 40%.
- Steep backwardation (spread > 3 pts): Extreme. Sit out or
  MINIMUM tier only.
```

**Data source**: CBOE VIX futures or Schwab
**Priority**: Low -- VIX1D/VIX relationship partially substitutes

---

### IV-4. Historical Same-Setup Win Rate (LOW PRIORITY)

**What it is**: A query against the lessons database to find: "In sessions with similar conditions (VIX range, GEX regime, DOW, structure), what was the historical win rate and average profit?"

**Why it matters**: Gives Claude a base rate to calibrate confidence. Instead of "MODERATE confidence," Claude could say "MODERATE confidence — similar setups (VIX 20-25, negative GEX, Wednesday, CCS) won 73% of the last 30 sessions with average profit of 42% of max credit."

**Implementation path**:
- Query existing lessons table with condition filters
- Compute win rate and average profit for matching conditions
- Include as supplementary context in the prompt

**Prompt addition if implemented**:
```
Historical Base Rate (when available):
If historical win rate data is provided for similar conditions,
reference it when setting confidence:
- Win rate > 75%: supports upgrading confidence by one level
  (LOW → MODERATE, MODERATE → HIGH).
- Win rate 50-75%: no confidence adjustment.
- Win rate < 50%: supports downgrading confidence by one level.
- Sample size < 10: note the small sample and do not adjust
  confidence. "Similar setups have a 67% win rate but only
  from 8 samples — insufficient for statistical confidence."
```

**Data source**: Existing lessons/analyses database
**Priority**: Low -- requires query development and sufficient historical data

---

## 6. Section V: Prompt Structure Improvements

These improve how Claude processes the prompt without changing the trading logic.

### V-1. Rule Priority Hierarchy (HIGH PRIORITY)

**Problem**: When rules conflict (Rule 3 vs Rule 4, Rule 6 vs Rule 9, Rule 10 standard vs VIX 25+ override), Claude must infer which wins. Some overrides are buried as inline annotations within other rules. There is no explicit priority ordering.

**Proposed fix**: Add a `<rule_priority>` section at the top of `<structure_selection_rules>`:

```
<rule_priority>
When rules conflict, apply the higher-priority rule. Do not attempt
to satisfy both — resolve the conflict explicitly and note it in
the observations field.

Priority (highest first):
1. Rule 12 (Event-Day Hard Exits) — FOMC/CPI exits override ALL
   other timing and management rules. No exceptions.
2. Rule 3 Friday Management tiers — Friday-specific overrides
   take precedence over standard time-based rules.
3. VIX1D Extreme Inversion Overrides — when present, override
   VIX stop zone restrictions and Friday hard exits per the
   Rule 3 tier system.
4. Periscope Charm Overrides — override naive charm signals
   and can extend Rule 16 deadlines per the Charm Ceiling
   Override specification.
5. Rule 5 (Direction-Aware Stops) — overrides any symmetric
   stop logic. Never close the winning side on a thesis-
   confirming move.
6. Rule 16 (GEX Regime) — adjusts ALL management timing.
   Lower-priority rules that specify time-based exits must
   be adjusted per the Rule 16 regime.
7. Rule 9 (8Δ Premium Floor) — overrides structure
   recommendations that produce untradeable premium.
8. All other rules in numerical order.

When noting a conflict in the observations field, use the format:
"Rule X overrides Rule Y because [specific condition]. Applied
Rule X: [action taken]."
</rule_priority>
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add `<rule_priority>` at the start of `<structure_selection_rules>`

---

### V-2. Rule Grouping by Decision Phase (HIGH PRIORITY)

**Problem**: Rules 1-16 mix structure selection, strike placement, management, and exit timing. Claude must hold all 16 rules simultaneously and mentally sort them by relevance at each decision phase. This increases the chance of missed rules.

**Proposed fix**: Reorganize rules into labeled groups. Do not change rule numbers (to preserve lesson references), but add group headers:

```
<structure_selection_rules>
<rule_priority>
[... priority hierarchy from V-1 ...]
</rule_priority>

<sizing_tiers>
[... sizing tiers from II-2 ...]
</sizing_tiers>

--- PHASE 1: STRUCTURE SELECTION ---
Apply these rules to determine WHAT to trade.
Rules: 1 (Gamma Asymmetry), 2 (QQQ Divergence), 4 (Friday VIX1D),
6 (Dominant Positive Gamma), 8 (SPX Flow Primary), 9 (8Δ Floor),
10 (Hedging Divergence), 11 (Charm Confirmation),
ETF Tide Divergence

--- PHASE 2: STRIKE PLACEMENT ---
Apply these rules to determine WHERE to place strikes.
Rules: 9 (8Δ Floor — also structure), Pin Risk (new),
Gamma Wall Alignment, Dark Pool Level Alignment

--- PHASE 3: SIZING ---
Apply these rules to determine HOW MUCH to trade.
Rules: Sizing Tiers, RV/IV Modifier, Rule 10 size reductions,
Rule 16 size reductions, All-Negative Charm size reductions

--- PHASE 4: ENTRY TIMING ---
Apply these rules to determine WHEN to enter.
Rules: 12 (Event Day), Time-of-Day Patterns (new),
Opening Range Signal

--- PHASE 5: POSITION MANAGEMENT ---
Apply these rules to determine how to manage after entry.
Rules: 3 (Friday Management), 5 (Direction-Aware Stops),
7 (Stop Placement), 12 (Event Day Exits), 13 (Asymmetric IC
via Charm), 14 (NPP Mechanical Move), 15 (Negative Gamma
Proximity), 16 (GEX Regime)
```

**Important**: This is a reorganization, not a rewrite. The rule text stays exactly the same. Only the grouping and phase headers are added.

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- add phase headers around existing rules

---

### V-3. Reduce Redundancy Between chart_types and Rules (MEDIUM PRIORITY)

**Problem**: The `<market_tide>` section (lines 33-53) includes "How to interpret for structure selection" that duplicates Rule 8's flow hierarchy. The `<net_charm>` section (lines 103-131) includes "How to use for structure selection" that duplicates Rule 11. Similar duplication exists for `<aggregate_gex>` and Rule 16.

This burns tokens without adding information. With the full prompt at ~18,700 tokens, reducing duplication could save ~1,500-2,000 tokens.

**Proposed fix**: Restructure `<chart_types>` sections to focus on "what this data IS and how to read it." Move all "how to USE it for structure selection" into the rules section. For each chart type that currently has a "How to interpret" block, replace it with a cross-reference:

```
<!-- Example for market_tide: -->
<market_tide>
[Keep: description of what Market Tide measures, how NCP/NPP
are calculated, what scale means]
[Remove: the "How to interpret for structure selection" block]
[Replace with:]
For structure selection interpretation, see Rule 8 (SPX Flow Primary)
and the Phase 1 rules.
</market_tide>
```

Apply the same pattern to:
- `<net_charm>` → Rule 11
- `<aggregate_gex>` → Rule 16
- `<spx_net_flow>` → Rule 8
- `<dark_pool>` → already mostly in the chart_types section (acceptable, leave as-is since there's no dedicated rule)

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- trim duplicated interpretation blocks in `<chart_types>`

---

### V-4. Rule 9 vs Rule 6 Explicit Interaction (LOW PRIORITY)

**Problem**: Rule 6 says "consider widening delta by 1-2Δ beyond the calculator ceiling" when a dominant positive gamma wall provides structural protection. Rule 9 says don't trade below 8Δ. When the ceiling is 7Δ, these rules collide without resolution.

**Proposed fix**: Add an interaction clause to Rule 6:

```
Rule 6 / Rule 9 interaction:
Rule 6's delta widening is capped at the lower of:
  (a) ceiling + 2Δ, or
  (b) the delta where the short strike exits the positive gamma
      wall's suppression zone (typically 20-30 pts beyond the
      wall center).
If the widened delta still falls below Rule 9's 8Δ minimum,
Rule 9 takes precedence — the trade is untradeable regardless
of gamma support. Note: "Rule 6 gamma support allows widening
to XΔ, but this remains below the 8Δ floor — SIT OUT."
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- append to Rule 6

---

### V-5. chartConfidence Missing Fields (LOW PRIORITY)

**Problem**: The `chartConfidence` object in the response format does not include fields for several data sources that the prompt now covers:

- `darkPool` -- dark pool institutional blocks
- `maxPain` -- max pain analysis
- `ivTermStructure` -- IV term structure
- `overnightGap` -- ES overnight gap analysis
- `spxCandles` -- SPX intraday price structure
- `vannaExposure` -- (if I-1 is implemented)
- `pinRisk` -- (if I-3 is implemented)

Currently these signals are discussed in `observations` but don't have structured confidence fields. This means the trader can't quickly scan which data sources drove the decision.

**Proposed fix**: Extend the `chartConfidence` object:

```json
"chartConfidence": {
  // ... existing fields ...
  "darkPool": {
    "signal": "CONFIRMS" | "CONTRADICTS" | "NEUTRAL" | "NOT PROVIDED",
    "confidence": "HIGH" | "MODERATE" | "LOW",
    "note": "Key dark pool levels and alignment with gamma profile"
  },
  "ivTermStructure": {
    "signal": "FAVORABLE" | "UNFAVORABLE" | "NEUTRAL" | "NOT PROVIDED",
    "confidence": "HIGH" | "MODERATE" | "LOW",
    "note": "Contango/inversion, 0DTE IV vs calculator σ"
  },
  "spxCandles": {
    "signal": "CONFIRMS" | "CONTRADICTS" | "NEUTRAL" | "NOT PROVIDED",
    "confidence": "HIGH" | "MODERATE" | "LOW",
    "note": "Price structure confirmation/contradiction of flow thesis"
  },
  "overnightGap": {
    "signal": "GAP_FILL_LIKELY" | "GAP_EXTENDS" | "NEUTRAL" | "NOT PROVIDED",
    "confidence": "HIGH" | "MODERATE" | "LOW",
    "note": "Gap direction, fill probability, cone consumption"
  }
}
```

**Files to modify**:
- `api/_lib/analyze-prompts.ts` -- extend `<response_format>` chartConfidence
- Frontend rendering code for the analysis response (if it maps these fields)

---

## 7. Implementation Priority Matrix

### Tier 1: High Priority (Do First)

These items fix real conflicts, prevent incorrect recommendations, or add data that's already collected but hidden.

| ID | Item | Type | Effort | Risk if Skipped |
|---|---|---|---|---|
| II-1 | Rule 3/4 Friday conflict merge | Prompt text | Small | Claude gives contradictory Friday exits |
| II-2 | Sizing tier definitions | Prompt text | Small | Sizing recommendations are arbitrary |
| V-1 | Rule priority hierarchy | Prompt text | Small | Claude can't resolve multi-rule conflicts |
| V-2 | Rule grouping by decision phase | Prompt text | Medium | Claude misses relevant rules per phase |
| I-1 | Vanna exposure formatting | New formatter + prompt | Medium | Blind to vol crush rallies |
| III-1 | Settlement/MOC mechanics | Prompt text | Small | Last-10-minute surprise losses |
| III-2 | RV/IV sizing guidance | Prompt text | Small | Selling cheap insurance unknowingly |
| III-4 | Theta/gamma ratio context | Prompt text | Small | Time exits are brittle to VIX shifts |

### Tier 2: Medium Priority (Do Second)

These add new data pipelines or expand existing formatters.

| ID | Item | Type | Effort | Risk if Skipped |
|---|---|---|---|---|
| I-2 | Skew data exposure | Extend formatter + prompt | Medium | Missing independent flow confirmation |
| I-3 | Pin risk / OI concentration | New formatter + prompt | Medium | Short strikes at max-pin levels |
| I-4 | Position-level greeks (midday) | New module + prompt | Large | Midday recs ignore aggregate exposure |
| III-3 | Time-of-day patterns | Prompt text | Small | Entry/exit timing lacks microstructure basis |
| V-3 | Redundancy reduction | Prompt text | Medium | Token waste, no functional risk |

### Tier 3: Low Priority (Future Consideration)

These require new data sources or are edge cases.

| ID | Item | Type | Effort | Risk if Skipped |
|---|---|---|---|---|
| II-3 | Rule 10 two-signal gap | Prompt text | Small | Ambiguity on 2-signal divergence |
| V-4 | Rule 9/6 interaction clause | Prompt text | Small | Rare edge case |
| V-5 | chartConfidence new fields | Prompt + frontend | Medium | Secondary signals not structured |
| IV-1 | NYSE TICK | New data source | Large | Flow data partially substitutes |
| IV-2 | 0DTE P/C ratio | Derive from existing | Small | Moderate signal value |
| IV-3 | VIX futures term structure | New data source | Medium | VIX1D/VIX partially substitutes |
| IV-4 | Historical win rate | New query | Medium | Nice-to-have calibration |

---

## 8. File Change Index

Summary of all files that need modification, grouped by file:

### `api/_lib/analyze-prompts.ts`

| Section | Change | Items |
|---|---|---|
| `<chart_types>` | Add `<vanna>` section | I-1 |
| `<chart_types>` | Add `<pin_risk>` section | I-3 |
| `<chart_types>` | Add `<settlement_mechanics>` section | III-1 |
| `<chart_types>` | Add `<time_of_day>` section | III-3 |
| `<chart_types>` | Trim redundant "How to interpret" blocks | V-3 |
| `<iv_term_structure>` | Extend with skew metrics | I-2 |
| `<data_handling>` | Add RV/IV ratio guidance | III-2 |
| `<structure_selection_rules>` | Add `<rule_priority>` section | V-1 |
| `<structure_selection_rules>` | Add `<sizing_tiers>` section | II-2 |
| `<structure_selection_rules>` | Add phase group headers | V-2 |
| `<structure_selection_rules>` | Add theta/gamma inversion principle | III-4 |
| `<structure_selection_rules>` | Add Rule 17 (Vanna) | I-1 |
| Rule 3 | Replace with unified Friday management tiers | II-1 |
| Rule 4 | Remove inline VIX1D override (moved to Rule 3) | II-1 |
| Rule 6 | Add Rule 6/9 interaction clause | V-4 |
| Rule 10 | Add two-signal partial divergence clause | II-3 |
| `<position_and_continuity>` | Add position greek summary guidance | I-4 |
| `<response_format>` | Extend chartConfidence with new fields | V-5 |

### `api/_lib/analyze-context.ts`

| Change | Items |
|---|---|
| Add `formatVannaForClaude()` function | I-1 |
| Include vanna in context assembly (`buildAnalysisContext`) | I-1 |
| Add `formatPinRiskForClaude()` function | I-3 |
| Include pin risk in context assembly | I-3 |
| Extend `formatIvTermStructureForClaude()` with skew metrics | I-2 |
| Include position greeks in midday context assembly | I-4 |

### `api/_lib/position-greeks.ts` (NEW FILE)

| Change | Items |
|---|---|
| Create `computePositionGreeks()` function | I-4 |
| BSM delta/gamma/theta/vega for each position leg | I-4 |
| Aggregate across all positions | I-4 |
| Stress test: delta at ±10 pt SPX move | I-4 |

### Frontend (if V-5 is implemented)

| Change | Items |
|---|---|
| Update analysis response type to include new chartConfidence fields | V-5 |
| Render new confidence fields in the analysis UI | V-5 |

---

## Appendix: Strengths to Preserve

These elements should NOT be changed -- they represent genuine edge:

1. **Rule 8 flow hierarchy** with explicit percentage weights (50/25/15/10)
2. **Periscope Charm Override** for naive all-negative (validated March 24)
3. **Rule 14** NPP surge during rally = mechanical (captures dealer behavior)
4. **Rule 5** direction-aware stops (prevents the #1 amateur IC mistake)
5. **7-14 DTE hedge guidance** (correct and rarely articulated)
6. **Phase 1/Phase 2 Chart Reading Protocol** (forces extraction before analysis)
7. **ETF Tide Divergence** detection (validated March 24)
8. **Rule 12** event-day management with tiered approach (afternoon/pre-market/mid-morning)
9. **Rule 16** GEX regime adjustment with graduated tiers
10. **Rule 13** asymmetric IC leg management via charm (manage legs independently)
