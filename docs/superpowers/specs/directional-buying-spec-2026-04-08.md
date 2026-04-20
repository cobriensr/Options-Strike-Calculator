# Directional Buying Spec — 2026-04-08

Enhancements for adding **directional long option trades** (buying delta) to a system built around theta selling. Captures the mental model difference, the current state of partial directional support, and 11 specific proposals for making long directional trades actually profitable.

Companion to [analyze-prompt-enhancements-2026-04-08.md](analyze-prompt-enhancements-2026-04-08.md) and [principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md).

---

## How to use this document

- Each recommendation has a stable ID (e.g. `ENH-BUY-001`). Reference these in commits and PRs.
- The "current state" section of each finding is verified against live code (file:line citations). The "proposed" sections are design sketches — verify the exact types and schemas when implementing.
- Recommendations are **ordered by logical grouping**, not by priority. The implementation sequence in Part 6 gives the recommended build order.
- This document is deliberately self-contained so it can be revisited as a standalone reference. The existing-state inventory in Part 1 exists so future sessions don't rebuild what's already there.

---

## Why directional buying deserves its own mental model

Theta selling and directional buying are not two flavors of the same strategy — they are opposite disciplines with opposite guardrails.

| Property | Theta selling (current system) | Directional buying (new) |
|---|---|---|
| Probability of profit | ~65-75% | ~35-45% |
| Average win size | Small (limited to credit) | 2-4× average loss |
| Primary edge source | Volume of correct trades + PoP | Tail winners + loss containment |
| Time is | Your friend (theta works for you) | Your enemy (theta works against you) |
| Vol is | Your friend (high IV = more credit) | Your enemy when high, friend when low |
| Gamma is | Your enemy (short gamma) | Your friend (long gamma) |
| Exit trigger | Price (hit short strike = stop) | Time (trade stale = stop) |
| Typical stop | Price-based, binary | Time-based, continuous |
| Scaling | Usually all-out at 50% profit | Scale-out ladder on winners |
| Catalyst behavior | Exit BEFORE (close before FOMC) | Enter BEFORE (buy the move) |
| Martingale behavior | Sometimes OK (defined risk, improving PoP) | Always destructive (time decay accelerates) |

**The consequence:** almost every guardrail built for theta selling is either wrong or inverted when applied to directional buying. The current system's rules are not broadly applicable; they are specifically calibrated for a short-gamma premium seller. Adding `LONG CALL` and `LONG PUT` to the output enum without adding buyer-specific rules would let Claude recommend directional buys without the discipline that makes them viable. That is the single biggest risk in adding this feature.

---

## Part 1 — Current state (what's already there)

Verified via direct reads on 2026-04-08.

### What already works

1. **Directional opportunity detection is live.** `analyze-prompts.ts` includes a Step 10 "Directional Opportunity Check" that runs after 12:00 PM ET (or when hours remaining < 4). It evaluates 4 criteria and populates a `directionalOpportunity` field in the output.
   - Citation: [analyze-prompts.ts:80-88](../../../api/_lib/analyze-prompts.ts#L80-L88).
   - Criteria: (1) hours remaining < 4, (2) Market Tide + at least 2 of (QQQ Net Flow, SPY ETF Tide, QQQ ETF Tide) agree on direction, (3) negative gamma acceleration zone in the flow direction within 30-40 pts, (4) no high-impact event within 60 minutes.

2. **`directionalOpportunity` response schema exists.** [validation.ts:227-243](../../../api/_lib/validation.ts#L227-L243):
   ```ts
   directionalOpportunity: z.object({
     direction: z.enum(['LONG CALL', 'LONG PUT']),
     confidence: z.enum(['HIGH', 'MODERATE', 'LOW']),
     reasoning: z.string(),
     entryTiming: z.string(),
     stopLoss: z.string(),
     profitTarget: z.string(),
     keyLevels: z.object({
       support, resistance, vwap
     }),
     signals: z.array(z.string()),
   }).nullable().optional()
   ```

3. **Backtested flow accuracy rankings are in the prompt.** Over 36 labeled days, the prompt has calibrated accuracy rankings for each flow source. From [analyze-prompts.ts:513-531](../../../api/_lib/analyze-prompts.ts#L513-L531):
   - QQQ Net Flow: 61% accurate
   - Market Tide: 61% accurate
   - SPY ETF Tide: 59% accurate
   - QQQ ETF Tide: 59% accurate
   - 0DTE Index: 50% (coin flip)
   - SPY Net Flow: 47% (coin flip)
   - **SPX Net Flow: 31% (anti-signal)** — systematically wrong on direction at VIX < 25 because institutional hedging dominates
   - VIX 25+ regime override: SPX Net Flow becomes more reliable when VIX exceeds 25

4. **ML signal hierarchy is live.** [analyze-prompts.ts:99-114](../../../api/_lib/analyze-prompts.ts#L99-L114) establishes Tier 1 (universal predictors: gamma asymmetry, GEX volume, prev-day range, VIX change, flow agreement) and Tier 2 (conditional predictors: dark pool, max pain, PCR).

5. **ML calibration is live.** [analyze-prompts.ts:116-122](../../../api/_lib/analyze-prompts.ts#L116-L122):
   - Baseline: "repeat yesterday's structure" achieves 75% accuracy
   - HIGH confidence calls: 96% accurate (22/23)
   - MODERATE confidence calls: 83% accurate (10/12)
   - Confidence-based 2x sizing adds $2,600 P&L vs equal sizing across 36 trades

### What's NOT yet there

| Capability | Status |
|---|---|
| `LONG CALL` / `LONG PUT` in the main `structure` enum | ❌ Not added. Main structure enum is still `IRON CONDOR / PUT CREDIT SPREAD / CALL CREDIT SPREAD / SIT OUT` ([validation.ts:168-173](../../../api/_lib/validation.ts#L168-L173)). Directional opportunity is a secondary field, not a primary structure. |
| Strike selection for directional buys (specific strike + DTE) | ❌ The `directionalOpportunity` field has no `strike` or `dte` field; it only has direction, confidence, reasoning, entryTiming, stop, profit target, and key levels. |
| IV rank as a BUY filter (cheap vol = good to buy) | ❌ The RV/IV rule exists but is framed entirely around selling. No "IV rank > 60 = too expensive to buy" rule. |
| Catalyst-aware rule for LONG positions | ❌ The existing FOMC rule exits all positions 15 min before; there's no exception for directional longs that were entered specifically to capture the catalyst. |
| $/delta strike cost efficiency metric | ❌ Not computed anywhere in `src/utils/`. |
| Breakeven move computation (points needed to profit) | ❌ Not present. |
| Gamma payoff map (what does this trade look like if I'm right?) | ❌ Not present. |
| Debit vertical vs naked long decision helper | ❌ No decision logic, no debit vertical calculator. |
| Time stops (as distinct from price stops) | ❌ The `stopLoss` field is a single string; no structured time-stop concept. |
| Scale-out ladder for winners | ❌ Management rules are single-target (`profitTarget` string), not ladder-based. |
| Delta-based regime-change exit | ❌ No rule for "when delta reaches 60+, close half." |
| Thesis invalidation exit (as distinct from price stop) | ❌ No structured concept of "entry thesis" that can be invalidated independently. |
| Martingale guard for losing long positions | ❌ No rule. |
| "Right direction, wrong vol" detection | ❌ No awareness of expected move consumption as a buy-timing filter. |

**Summary of current state:** Claude can *detect* a directional opportunity and describe it qualitatively via the optional `directionalOpportunity` field. Claude cannot yet recommend a specific directional trade with quantitatively-calibrated strike selection, time-stop discipline, scale-out management, or catalyst awareness. The detection layer is live; the execution layer is missing.

---

## Part 2 — Flipped interpretations of existing signals

Signals you already feed into the prompt, but with the interpretation inverted for buying.

### ENH-BUY-001 — IV rank / RV-IV as a BUY filter

- **Rationale:** The existing RV/IV rule ([analyze-prompts.ts:738-746](../../../api/_lib/analyze-prompts.ts#L738-L746)) is framed entirely for theta selling: "RV/IV > 1.15 → too narrow, reduce size; RV/IV < 0.85 → seller's edge, full size." For directional buying, the math inverts — when IV is rich relative to realized, long options are statistically overpriced; when IV is cheap, long options are the premium buyer's edge.
- **Current state:** No BUY-side interpretation of RV/IV or IV rank exists in the prompt. The `iv_rank` column is fetched into context ([analyze-context.ts:415-464](../../../api/_lib/analyze-context.ts#L415-L464)) but consumed only by the seller-framed rule.
- **Proposed rule (to add to `analyze-prompts.ts`):**
  ```
  ## Rule: IV Rank as Buy Filter (applies only to LONG directional trades)
  When evaluating a directional long position:
  - IV rank > 60th percentile AND RV/IV < 0.85:
    Long options are statistically expensive. The fear is already priced in.
    Avoid naked long options; prefer debit verticals to halve cost. If a
    naked long is the only viable structure, reduce size by one tier.
  - IV rank < 30th percentile AND RV/IV > 1.0:
    Long options are cheap AND realized is catching up to implied. This
    is the premium buyer's edge — the asymmetric payoff is at its cheapest.
    Naked longs preferred; directional gamma is discounted.
  - IV rank 30-60:
    Neutral regime. Structure choice driven by other factors (catalyst
    proximity, skew shape, target distance vs expected move).

  Apply this rule ONLY when evaluating a directional long position. The
  existing RV/IV seller rule at analyze-prompts.ts:738-746 still applies
  for IC/CCS/PCS evaluation.
  ```
- **Dependencies:** The `iv_rank`, `iv_rv_spread`, and `iv_overpricing_pct` fields must already be in the prompt context. Verified present ([analyze-context.ts:418-446](../../../api/_lib/analyze-context.ts#L418-L446)).
- **Scope:** Small. New prompt rule, no code changes, no new data. One block of prose.

### ENH-BUY-002 — Catalyst proximity as an ENTRY filter for longs (not an exit filter)

- **Rationale:** The existing FOMC rule ([analyze-prompts.ts:567-573](../../../api/_lib/analyze-prompts.ts#L567-L573)) hard-exits all positions 15 minutes before any high-impact event. This is correct for theta sellers (a binary event destroys gamma-short positions) but wrong for directional buyers whose entire thesis may be "buy the move the catalyst produces." You want to be LONG into the catalyst, not flat.
- **Current state:** The FOMC hard-exit rule makes no exception for directional longs. The existing directional opportunity check ([analyze-prompts.ts:85](../../../api/_lib/analyze-prompts.ts#L85)) requires "no high-impact event within 60 minutes," which is also the wrong direction for a catalyst-thesis trade.
- **Proposed rule:**
  ```
  ## Rule: Catalyst Proximity for Long Directional Trades
  For LONG directional positions entered with an explicit catalyst thesis
  (a specific identified event in the next 24-48 hours that the position
  is intended to capture):

  - The FOMC/catalyst hard-exit rule does NOT apply. The position is
    expected to be held through the event; that is the entire thesis.
  - The trade output must tag `catalystTrade: true` and identify the
    specific event being targeted.
  - An IV-crush haircut is applied to expected P&L:
      0DTE long options before FOMC/CPI: 15-25% of premium will evaporate
        on the announcement regardless of direction. Avoid naked 0DTE longs
        before major events; prefer debit verticals (vol-crush-resistant).
      1-7 DTE long options before FOMC/CPI: 8-15% IV crush. Naked longs
        are risky; debit verticals preferred.
      14+ DTE long options before FOMC/CPI: 3-8% IV crush. Naked longs
        acceptable.

  A LONG directional trade entered WITHOUT a catalyst thesis still follows
  the standard "no high-impact event within 60 minutes" entry gate from
  Step 10. The catalyst exception applies only when the trade is
  explicitly designed to capture the catalyst's move.
  ```
- **Dependencies:** Econ calendar must be in the context (verified — see [fetch-economic-calendar.ts](../../../api/cron/fetch-economic-calendar.ts)). The prompt must be taught to distinguish catalyst-thesis entries from opportunistic entries.
- **Scope:** Small. New rule block + addition of `catalystTrade: boolean` and `targetedEvent: string | null` to the directionalOpportunity schema in validation.ts.

---

## Part 3 — Missing quant primitives

Math that a directional buyer needs but a theta seller doesn't.

### ENH-BUY-003 — $/delta strike selection + breakeven move

- **Rationale:** For a long option, the two most important single numbers are:
  1. **$/delta** — the cost per unit of directional exposure. Lower is better. Tells you which strike is the cheapest directional bet.
  2. **Breakeven move in points** — how far SPX must move for the trade to be profitable. Compared to today's expected move (straddle cone), this tells you if the trade is realistic.

  A 10Δ call costing $30 needs `$30 / 0.10 = 300 pts` of move to break even at expiry (ignoring time decay). That's clearly unrealistic for 0DTE. A 30Δ call costing $200 needs `$200 / 0.30 ≈ 667 pts` of move at expiry — also unrealistic. But a 10Δ call at $30 with 7 DTE and a 1-day target only needs ~15 pts of SPX move to profit at mark-to-market (because remaining theta value survives). Without this math, Claude cannot distinguish a realistic trade from a lottery ticket.

- **Current state:** Not computed. No `$/delta`, `breakevenMove`, or `breakevenVsCone` anywhere in `src/utils/`.

- **Proposed implementation:**

  **Step 1 — Create `src/utils/long-option-metrics.ts`:**
  ```ts
  export type LongOptionCandidate = {
    strike: number;
    side: 'call' | 'put';
    dte: number;
    premium: number;        // debit paid
    delta: number;          // 0..1 absolute
    gamma: number;
    theta: number;          // per-day
    breakevenMovePoints: number;     // premium / delta (point equivalent)
    breakevenVsCone: number;          // breakevenMovePoints / straddleConeHalfWidth
    dollarPerDelta: number;           // premium / delta
    thetaPerDay: number;              // dollars of decay per day
    gammaPayoff20pt: number;          // projected delta after 20-pt favorable move
    gammaPayoff40pt: number;          // projected delta after 40-pt favorable move
    expectedPnlAt20pt: number;        // projected P&L from intrinsic + residual extrinsic
    expectedPnlAt40pt: number;
    expectedPnlAtTimeStop: number;    // projected P&L if no move by time stop (theta burn)
  };

  export function buildLongOptionCandidates(
    chain: ChainResponse,
    spot: number,
    iv: number,
    dte: number,
    side: 'call' | 'put',
    deltaRange: [number, number],   // e.g. [0.08, 0.45]
    straddleConeHalfWidth: number
  ): LongOptionCandidate[] {
    // 1. Filter chain to strikes whose delta falls in the range
    // 2. For each candidate, compute:
    //    - breakeven move = premium / delta
    //    - $/delta = premium / delta
    //    - gamma payoff at +20, +40 via Black-Scholes reprice with stressed spot
    //    - expected P&L at time stop assumes spot unchanged, apply theta burn
    // 3. Return sorted by $/delta ascending (cheapest directional exposure first)
  }
  ```

  **Step 2 — Wire into `analyze-context.ts`:**
  When the directional opportunity check fires, build candidates for LONG CALL (if direction is bullish) or LONG PUT (if direction is bearish). Include top 3 candidates in the structured context. Also add midpoint DTE variants (0DTE + 7DTE + 14DTE) so Claude can compare across expirations.

  **Step 3 — Update `directionalOpportunity` schema in `validation.ts`:**
  ```ts
  directionalOpportunity: z.object({
    direction: z.enum(['LONG CALL', 'LONG PUT']),
    // ... existing fields ...
    selectedStrike: z.object({
      strike: z.number(),
      dte: z.number(),
      delta: z.number(),
      premium: z.number(),
      breakevenMove: z.number(),
      dollarPerDelta: z.number(),
      reasoning: z.string(),  // why this strike over others
    }).nullable(),
    alternatives: z.array(z.object({
      strike: z.number(),
      dte: z.number(),
      delta: z.number(),
      premium: z.number(),
      tradeoff: z.string(),  // "higher $/delta but tighter breakeven" etc
    })).max(3),
  }).nullable().optional()
  ```

  **Step 4 — Prompt rule for strike selection:**
  ```
  ## Rule: Directional Strike Selection
  When recommending a long directional position, select the strike that
  minimizes $/delta WHILE keeping breakevenVsCone < 0.7. The trade must
  be realistic within today's expected move.

  - Conviction HIGH and time remaining > 3 hours: prefer cheap $/delta
    (10-15Δ OTM). The gamma kicker on a favorable move compounds the win.
  - Conviction MODERATE and time remaining < 2 hours: prefer ATM (40-50Δ)
    for immediate delta response. Cheap OTM calls don't have time to grow.
  - Conviction HIGH on a multi-day target (7-14 DTE): 20-30Δ is the sweet
    spot. Captures meaningful delta without paying ATM prices.

  Always output the top 3 alternatives with their trade-offs so the
  trader can pick their own risk profile. Do not collapse to a single
  recommendation without showing the alternatives considered.
  ```

- **Dependencies:** Black-Scholes reprice for gamma payoff projections (already exists in [black-scholes.ts](../../../src/utils/black-scholes.ts)). Chain data with per-strike delta/gamma/theta (already fetched for existing prompt).

- **Verification:**
  - Unit test: for a hand-calculated example, verify `buildLongOptionCandidates` returns the expected $/delta ordering.
  - Sanity test: cheap OTM options should have lower $/delta but higher breakevenVsCone than ATM. If that relationship inverts, the calculation is wrong.
  - Integration test: run on a historical trading day's chain snapshot and verify candidate list matches hand-computed values.

- **Scope:** Moderate. New utility module with Black-Scholes reprice logic + schema extension + context integration + prompt rule + tests.

### ENH-BUY-004 — Gamma payoff map ("what does this trade look like if I'm right?")

- **Rationale:** Long options are valuable specifically because delta rises as the trade wins. A 10Δ call that becomes a 25Δ call after +20 pts and a 42Δ call after +40 pts has an asymmetric payoff that compounds. Most tools hide this by showing a static delta at entry. Exposing the projected delta and P&L at several favorable-move waypoints makes the asymmetry tangible — both for Claude's reasoning and for the trader's intuition.
- **Current state:** Not computed. The closest existing thing is `hedge.ts:317-334` (vega aggregation for IC hedge scenarios) but there's no analogous "payoff projection map" for long directional positions.
- **Proposed implementation:**

  **Step 1 — Extend `long-option-metrics.ts` with a payoff map function:**
  ```ts
  export type PayoffWaypoint = {
    spotMovePoints: number;        // e.g. +20, +40, +60
    projectedDelta: number;        // delta after this move (via BS reprice)
    projectedPnl: number;          // dollars P&L at this waypoint
    projectedPnlPct: number;       // % of premium paid
  };

  export function computePayoffMap(
    candidate: LongOptionCandidate,
    spot: number,
    iv: number,
    waypoints: number[] = [10, 20, 30, 40, 60]
  ): { favorable: PayoffWaypoint[]; unfavorable: PayoffWaypoint[]; timeStop: PayoffWaypoint };
  ```
  - `favorable` waypoints use `spot + waypoints[i]` for calls, `spot - waypoints[i]` for puts.
  - `unfavorable` uses the opposite direction (this helps size the downside).
  - `timeStop` holds spot constant but advances time by the intended hold window; computes theta burn P&L at zero directional move.

  **Step 2 — Include in the analyze context:**
  When a directional opportunity is active, include the payoff map for the selected strike in the structured context block:
  ```
  ## Long Option Payoff Map (selected strike: 6580 Call, 7 DTE, 10Δ, $50 premium)
  Favorable move:
    +10 pts: delta → 17Δ, P&L → +$28 (+56%)
    +20 pts: delta → 25Δ, P&L → +$85 (+170%)
    +30 pts: delta → 34Δ, P&L → +$165 (+330%)
    +40 pts: delta → 42Δ, P&L → +$260 (+520%)
    +60 pts: delta → 58Δ, P&L → +$470 (+940%)

  Unfavorable move:
    -10 pts: delta → 6Δ, P&L → -$20 (-40%)
    -20 pts: delta → 3Δ, P&L → -$32 (-64%)
    -40 pts: delta → 1Δ, P&L → -$45 (-90%)

  Time stop (spot unchanged, +4 hours elapsed):
    delta → 9Δ, P&L → -$11 (-22%)
  ```

  **Step 3 — Prompt rule for reasoning about the payoff map:**
  ```
  ## Rule: Payoff Map Reasoning
  When a payoff map is provided, your directional opportunity reasoning
  must explicitly reference the asymmetry:
  - What is the projected P&L at the favorable target move?
  - What is the projected P&L at the time stop (no move, just theta burn)?
  - Is the ratio of favorable-target-P&L to time-stop-loss greater than 3:1?
    If less than 3:1, the trade's asymmetry is insufficient — prefer a
    different strike or wider DTE.
  ```

- **Dependencies:** Black-Scholes reprice (already exists). No new data.
- **Scope:** Small. Add one function to `long-option-metrics.ts` + context formatter + prompt rule. Builds directly on ENH-BUY-003.

### ENH-BUY-005 — Debit vertical vs naked long decision helper

- **Rationale:** For most directional buys, the real choice is not "which strike" but "naked long or debit vertical?" A debit vertical (long ATM + short OTM at the target) captures most of the move for ~half the cost — at the price of capping upside exactly where you want to be uncapped. The right choice depends on target distance, IV regime, and time horizon. Experienced directional buyers have internalized this decision; the current prompt has no framework for it.
- **Current state:** No debit vertical calculator or decision helper anywhere in `src/utils/`.
- **Proposed implementation:**

  **Step 1 — Decision rules (to encode as a prompt rule):**
  ```
  ## Rule: Debit Vertical vs Naked Long Decision
  When recommending a long directional trade, choose between a naked long
  and a debit vertical using these rules:

  Target within 1× ATR of spot:
    → Debit vertical. The short wing caps an area you don't expect to
      reach anyway, and the cost savings improve $/delta efficiency in
      the useful range.

  Target beyond 1.5× ATR of spot:
    → Naked long. A vertical caps exactly where you want to be uncapped.
      The capped upside destroys the asymmetry that justifies a
      directional long in the first place.

  IV rank > 60:
    → Bias toward debit vertical regardless of target distance. You're
      long vega on the naked call; the vertical nets you much closer to
      vega-neutral. In a high-IV regime, vega risk is the biggest
      single threat to a long option.

  IV rank < 40:
    → Bias toward naked long. Vega is in your favor; do not cap it.

  Time remaining < 2 hours:
    → Naked long only. Verticals don't have time to resolve; the short
      wing becomes worthless faster than the long wing, leaving you
      with residual naked exposure.

  On ties between rules, prefer the structure whose $/delta efficiency is
  better when measured against the target waypoint (not the ATM delta).
  Use ENH-BUY-003's candidate builder to compute $/delta for both and
  pick the winner.
  ```

  **Step 2 — Extend `directionalOpportunity` schema:**
  ```ts
  selectedStructure: z.enum(['NAKED LONG CALL', 'NAKED LONG PUT', 'CALL DEBIT SPREAD', 'PUT DEBIT SPREAD']),
  structureRationale: z.string(),  // why this structure over the alternative
  ```

  **Step 3 — Extend `long-option-metrics.ts` with vertical construction:**
  ```ts
  export function buildDebitVerticalCandidates(
    chain: ChainResponse,
    spot: number,
    iv: number,
    dte: number,
    side: 'call' | 'put',
    longDeltaRange: [number, number],
    shortDeltaRange: [number, number],
    targetStrike: number   // where you expect price to go
  ): DebitVerticalCandidate[];
  ```
  Returns vertical candidates with the same metrics as long options: `breakevenMove`, `dollarPerDelta`, `maxProfit`, `maxLoss`, `payoffAtTarget`.

- **Dependencies:** Chain data + Black-Scholes (both already available).
- **Scope:** Moderate. New function in long-option-metrics + schema extension + prompt rule block.

---

## Part 4 — Exit and management (where long-option traders bleed)

The most expensive mistakes in directional buying are exit mistakes. Each of these rules is non-obvious from a theta seller's instincts.

### ENH-BUY-006 — Time stops (the single most important long-option rule)

- **Rationale:** Long options die by theta, not by directionally-wrong moves. A directionally-wrong long option just fails to gain value; a theta-bled long option is already dead by the time you notice. The single habit that separates profitable directional buyers from unprofitable ones is **time-based exit discipline, not price-based**.

  The core insight: a long call at +0% profit after 60% of its expected window is not "flat" — it's already a losing trade. The expected P&L at that waypoint (given theta burn and the absence of the anticipated move) is negative. Holding it to see what happens adds theta decay to an already-failed thesis.

- **Current state:** The `directionalOpportunity` schema has a single `stopLoss` string field ([validation.ts:233](../../../api/_lib/validation.ts#L233)). There is no structured time-stop concept and no rule that forces a time-based exit.

- **Proposed implementation:**

  **Step 1 — Extend schema with structured time stop:**
  ```ts
  timeStop: z.object({
    expectedWindow: z.string(),           // "2 hours from entry"
    halfWindowCheck: z.string(),          // "at 1h, close half if P&L < +15%"
    threeQuarterCheck: z.string(),        // "at 1.5h, close all if P&L < +25%"
    hardExit: z.string(),                 // "at 2h, close regardless of P&L"
    thesisWindow: z.number(),             // minutes
  }).nullable(),
  ```

  **Step 2 — Prompt rule:**
  ```
  ## Rule: Directional Long Time-Stop (MANDATORY)
  Every LONG directional position must have a time stop. Compute it as follows:

  1. The trade thesis specifies a time window — "this move should happen in
     X hours." Extract this from the entry rationale. If you cannot specify
     a window, the directional thesis is not concrete enough; prefer SIT OUT.

  2. At 50% of the window elapsed: if P&L < +15%, reduce position by half.
  3. At 75% of the window elapsed: if P&L < +25%, close the remaining position.
  4. At 100% of the window: close all regardless of P&L.

  The time stop ALWAYS precedes the price stop for long options. A trade
  that is "flat" at 75% of its window is a losing trade — the expected P&L
  at that point is negative even if the mark is neutral.

  The time stop is enforced in parallel with the price stop — any one
  triggers the exit. If both fire, honor whichever is more conservative.
  ```

  **Step 3 — Update output text in analyze-prompts.ts:**
  The output section for directional opportunities must include a rendered time-stop plan, not just a `stopLoss` string. Reject outputs where the time stop is missing or incoherent.

- **Dependencies:** Prompt must have session time context (already present). Schema extension to validation.ts.
- **Verification:** Unit-test the schema validation accepts valid time stops and rejects empty ones. Integration test: invoke analyze with a directional opportunity and verify the time stop is populated.
- **Scope:** Small. Schema extension + prompt rule + output section update.

### ENH-BUY-007 — Scale-out ladder for winners

- **Rationale:** For credit spreads you typically exit all at 50% profit because the defined-risk structure makes residual holding unattractive (gamma risk grows as the position moves to max profit). For long options the opposite is true: the asymmetric tail payoff is where the strategy's edge lives, and scaling out rather than fully exiting converts a single binary outcome into a more stable cash-flow stream while preserving the tail.

  Concretely: close half at +50% to lock in gains and free up capital. Close another quarter at +100% to have a 25% free runner in pure profit. Let the final quarter ride to either the target, the time stop, or delta regime change. This is not a guess — it's a mathematical consequence of the long-option P&L distribution.

- **Current state:** The existing `managementRules.profitTarget` field ([validation.ts:212](../../../api/_lib/validation.ts#L212)) is a single string. There is no laddered exit concept. For directional buys specifically, the `directionalOpportunity.profitTarget` field ([validation.ts:234](../../../api/_lib/validation.ts#L234)) is also a single string.

- **Proposed implementation:**

  **Step 1 — Extend the directionalOpportunity schema:**
  ```ts
  scaleOutPlan: z.object({
    first: z.object({
      triggerPct: z.number(),        // e.g. 0.5 for +50%
      sizeFraction: z.number(),      // e.g. 0.5 for close half
      action: z.string(),            // "close half to lock in gains"
    }),
    second: z.object({
      triggerPct: z.number(),        // e.g. 1.0 for +100%
      sizeFraction: z.number(),      // e.g. 0.25 for close another quarter
      action: z.string(),
    }),
    runner: z.object({
      sizeFraction: z.number(),      // e.g. 0.25 remaining
      exitCondition: z.string(),     // "ride to target OR delta >= 60 OR time stop"
    }),
  }).nullable(),
  ```

  **Step 2 — Prompt rule:**
  ```
  ## Rule: Directional Long Scale-Out Ladder
  For every LONG directional position, generate a scale-out plan with
  three waypoints:

  1. First: at +50% profit, close half the position. You now hold a
     free runner — the remaining half has no remaining risk of capital.
  2. Second: at +100% profit (on the original premium), close another
     quarter. You now hold a 25% position in pure profit.
  3. Runner: let the final quarter run until ANY of the following triggers:
     (a) the original target price is reached
     (b) delta on the runner reaches 60+ (regime change — see ENH-BUY-008)
     (c) the time stop fires (see ENH-BUY-006)
     (d) the entry thesis invalidates (see ENH-BUY-009)

  Do NOT collapse to a single exit. The ladder converts a directional
  trade's skewed P&L distribution into a more stable cash-flow stream
  while preserving the tail.

  Exception: if total premium paid is less than 2× minimum commission
  (e.g., fewer than 2 contracts), the ladder becomes impractical — in
  that case, use a single exit at +75% profit.
  ```

- **Dependencies:** Schema extension.
- **Scope:** Small. Schema + prompt rule.

### ENH-BUY-008 — Delta-based regime-change exit

- **Rationale:** When a long option wins, delta rises toward 1.0. At ~60+ delta, the position has **become a different trade**: it's a near-equivalent-to-stock position with heavy theta, maxed gamma, and no remaining asymmetry. The thing you originally bought (a cheap directional option with gamma acceleration potential) no longer exists — you now hold a delta-1 equivalent with theta-bleed risk.

  The correct action at regime change is to close at least half and reassess. This is a stop based on position character, not P&L.

- **Current state:** Not present. No rule references delta thresholds for long options.

- **Proposed implementation:**
  Add to the prompt rules block:
  ```
  ## Rule: Delta Regime-Change Exit for Long Positions
  When a long directional position's delta reaches 60+:
  - Close at least half the position immediately.
  - Reassess the remaining position. You are no longer holding the trade
    you entered. The asymmetric gamma acceleration that justified the
    entry has been captured; what remains is a delta-1 equivalent with
    theta bleed risk.
  - If the directional thesis is still intact AND the remaining time
    window is short (under 1 hour), the runner may be held to target.
    Otherwise, close the remaining position.
  - This rule applies independently of the scale-out ladder — if the
    scale-out ladder has already closed some of the position, the
    regime-change rule applies to whatever remains.
  ```

  Tracking the live delta requires polling the option's current delta in the UI or during subsequent analyze invocations (midday mode). Claude cannot enforce this in real-time; the rule must be codified so the trader can apply it manually, or the UI must surface it as a warning.

- **Dependencies:** None for the prompt-side rule. Full automation would require real-time position monitoring that doesn't currently exist.
- **Scope:** Trivial for the prompt rule. Larger if real-time enforcement is desired.

### ENH-BUY-009 — Thesis invalidation exit (not price stop)

- **Rationale:** Theta-seller stops are price-based ("close if SPX hits the short strike"). For long options, thesis-based stops dominate because the entry rationale was not "SPX will be at X price" but "flow direction Y will hold for Z hours." If the flow signal that justified the entry reverses, the thesis is dead — regardless of where price is.

  Concrete example: you buy calls at 12:30 PM because Market Tide is strongly bullish with GEX flip above spot. At 1:15 PM, Market Tide flattens and NCP reverses. Even if SPX is still at the entry level or slightly green, the thesis is invalidated. Holding the position at this point is paying theta for a thesis that no longer exists.

- **Current state:** Not present. The existing `stopLoss` field is price-based; no structured "thesis" or invalidation rule exists.

- **Proposed implementation:**

  **Step 1 — Extend schema:**
  ```ts
  thesisExit: z.object({
    entrySignal: z.string(),       // "Market Tide bullish + gamma flip above spot"
    invalidationSignal: z.string(), // "Market Tide flattens OR NCP reverses sign"
    invalidationCheck: z.string(),  // "check every 10 min via next analyze call"
  }).nullable(),
  ```

  **Step 2 — Prompt rule:**
  ```
  ## Rule: Thesis Invalidation Exit for Long Positions
  Every LONG directional entry must declare its entry thesis in terms of a
  specific, re-checkable signal (e.g., "entering long calls because morning
  NCP is sustained bullish AND gamma flip is above spot AND flow agreement
  count >= 5"). This is the entry signal.

  The corresponding invalidation signal is the negation of the entry signal:
  "exit when NCP reverses OR gamma flip moves below spot OR flow agreement
  count drops below 3."

  The invalidation rule is independent of the time stop and price stop.
  Any of the three triggers an exit:
  - Time stop fires (see ENH-BUY-006)
  - Price stop fires (the key level the trader used to size risk)
  - Thesis invalidates (the entry signal reverses)

  Do NOT hold a losing long position because "price is still holding."
  The thesis that justified the entry was the flow, not the price level.
  Price stability during a flow reversal is a warning, not a reassurance.

  In midday mode (mid-trade reassessment), explicitly check whether the
  original entry thesis still holds. If it does not, the recommendation
  must be to exit regardless of current P&L.
  ```

- **Dependencies:** Schema extension. Requires Claude to reference the original entry signal when doing midday reassessment (which already happens via the "previous recommendation" context).
- **Scope:** Small. Schema + prompt rule.

---

## Part 5 — Pitfalls specific to buyers

### ENH-BUY-010 — Martingale guard for losing long positions

- **Rationale:** Adding to a losing long option position is uniquely destructive because time is the enemy. Unlike averaging into a credit spread (which has defined risk, and the PoP improves as spot moves back toward the middle of the cone), averaging into a long option compounds theta exposure and almost never works. Every hour you hold the added position, the original position AND the new position both bleed. The math doesn't recover.
- **Current state:** No rule against adding to losing long positions. The current prompt is silent on position stacking for directional longs.
- **Proposed rule:**
  ```
  ## Rule: No Martingale on Losing Long Positions
  Do not recommend adding to a LOSING long directional position under any
  circumstance. If a position is at -25% or worse:
  - The only allowed recommendation is HOLD (to respect time stop) or CLOSE.
  - Adding contracts at a lower price ("averaging down") is explicitly
    prohibited.
  - If the original thesis is still intact AND a NEW independent entry
    setup appears (different signal, different strike, different DTE),
    a new position may be opened — but it must be tracked as a separate
    trade with its own time stop, not as an average-down.

  The reason: time decay compounds across both positions. A -25% position
  held through a -50% position will likely end at -80%. Adding size at
  -25% converts a recoverable loss into a catastrophic one.
  ```
- **Scope:** Trivial. One prompt rule block.

### ENH-BUY-011 — "Right direction, wrong vol" detection

- **Rationale:** The classic losing long-option trade: you call the direction correctly, but IV crush after an event erases the gains. This is most brutal on 0DTE longs bought before the last 90 minutes, and on longs bought after the expected move has already been largely realized. The buyer's edge lives in "IV + direction, not direction alone."

  The simplest filter: if the expected move has already been consumed before you enter, the vol premium you're paying has already been worked off. You're buying insurance against a move that's already happened.

- **Current state:** The prompt tracks straddle cone consumption ([analyze-prompts.ts:266-272](../../../api/_lib/analyze-prompts.ts#L266-L272)) but uses it only for seller-side reasoning ("cone consumed → remaining move compressed → good for premium selling"). The same data is not used as a buy-side warning.

- **Proposed rule:**
  ```
  ## Rule: Expected Move Consumption as Long-Option Entry Filter
  When evaluating a LONG directional entry, check the straddle cone
  consumption:

  - Cone consumption < 40%: normal entry conditions. Vol premium is
    intact; the gamma kicker is available.
  - Cone consumption 40-70%: moderate warning. The expected move has
    partially been realized. Reduce size by one tier and prefer
    debit verticals over naked longs (the capped vertical better
    matches the remaining expected range).
  - Cone consumption > 80%: strong warning. Most of today's implied
    move has been realized; vol premium on the remaining move is
    severely compressed. Naked long options face brutal IV crush even
    if directionally correct. Strongly prefer directional credit
    spreads (which benefit from the same vol compression) or defer
    to tomorrow.

  Output the cone consumption pct explicitly in the directional
  opportunity reasoning so the trader can see the filter was applied.
  ```

- **Dependencies:** Cone consumption is already computed and in the context.
- **Scope:** Trivial. One prompt rule block.

---

## Part 6 — Implementation sequence

The highest-EV items are the rules (ENH-BUY-006 through ENH-BUY-011), not the schema extensions. Ship the rules first so that the existing `directionalOpportunity` field (which is already live) gets instantly smarter. Then add the quant primitives (ENH-BUY-003, ENH-BUY-004, ENH-BUY-005) which require code work. Then add the structural extensions (schema changes to make these fields structured rather than free-text).

### Phase 1 — Rule-only additions (no code changes, prompt-only)

These ship as pure prompt additions. They make the existing directional opportunity field produce better output immediately, without touching schemas or writing new utilities.

1. **ENH-BUY-001** — IV rank flipped for buy side
2. **ENH-BUY-002** — Catalyst proximity as ENTRY filter
3. **ENH-BUY-006** — Time stops (mandatory for longs) — codified as a prompt rule Claude must apply
4. **ENH-BUY-007** — Scale-out ladder rule
5. **ENH-BUY-008** — Delta regime-change exit
6. **ENH-BUY-009** — Thesis invalidation exit
7. **ENH-BUY-010** — No martingale on losers
8. **ENH-BUY-011** — Expected move consumption filter

All eight can ship as one prompt update. This is the biggest single win and has no code dependencies.

### Phase 2 — Schema extensions to capture the structured data

Once Phase 1 is live and the rules are producing the right output, formalize the output by extending the `directionalOpportunity` schema to capture time stops, scale-out ladders, thesis exits, catalyst flags, and structure selection as structured fields instead of free text. This allows the UI to display them as widgets and future automation to enforce them.

Items: schema additions for `timeStop`, `scaleOutPlan`, `thesisExit`, `catalystTrade`, `targetedEvent`, `selectedStructure`.

### Phase 3 — Quant primitives

Build the code layer that makes strike selection and payoff projection quantitative.

1. **ENH-BUY-003** — `long-option-metrics.ts` + $/delta candidate builder + breakeven move + context integration
2. **ENH-BUY-004** — Gamma payoff map
3. **ENH-BUY-005** — Debit vertical construction + decision helper

### Phase 4 — Add LONG to the main structure enum

Only after Phase 1-3 are live. Add `LONG CALL`, `LONG PUT`, `CALL DEBIT SPREAD`, `PUT DEBIT SPREAD` to the main `structure` enum in validation.ts ([validation.ts:168-173](../../../api/_lib/validation.ts#L168-L173)). At this point, directional buys become primary structure recommendations rather than secondary opportunity flags. All the supporting rules and primitives exist to make this safe.

### Phase 5 — UI + automation

- UI widget for time stop with a live countdown
- UI widget for scale-out ladder with current waypoint indicator
- Alert when delta on an open long position crosses 60
- Optional: automated time-stop enforcement via a cron that checks open positions against the declared time windows

---

## Part 7 — Dependencies on the companion spec

Several items in this spec benefit from or depend on the enhancements in [analyze-prompt-enhancements-2026-04-08.md](analyze-prompt-enhancements-2026-04-08.md):

| This spec | Depends on companion spec item | Why |
|---|---|---|
| ENH-BUY-003 (strike selection) | ENH-EDGE-002 (slippage-adjusted credit) | The $/delta metric should use realistic fill prices, not mid. Otherwise the calculator underestimates true cost. |
| ENH-BUY-003 (strike selection) | ENH-SIGNAL-001 (zero-gamma distance) | Negative-gamma-side trades are specifically the ones directional buys should target. Knowing the flip distance directly informs which strike to buy. |
| ENH-BUY-006 (time stops) | ENH-RISK-001 (daily loss gate) | Both are enforcement rules; they interact. Daily loss gate overrides everything; time stop is trade-specific. |
| ENH-BUY-001 (IV rank flip) | Already uses existing vol_realized table | No dependency — this can ship today. |
| Personal cohort edge (ENH-EDGE-001 in companion) | **This spec benefits from it** | Historical win rate on directional trades specifically (not lumped with IC trades) would meaningfully improve ENH-BUY confidence calibration. Consider adding a `tradeType: 'theta' \| 'directional'` filter to the cohort query. |

**Suggested interleaving with the companion spec's phase plan:**
- Companion Phase 1 (ENH-FIX-001, ENH-RISK-001, ENH-EDGE-002): ship alongside this spec's Phase 1 (rules-only). They're prompt-only changes and don't conflict.
- Companion Phase 2 (ENH-EDGE-001 cohort engine): consider adding a directional-trade filter while building so directional cohort lookups are available when Phase 3 of this spec ships.
- This spec's Phase 3 (quant primitives): ship alongside companion Phase 3 (ENH-SIGNAL-001 zero-gamma), since both need similar strike-level infrastructure and can share the Black-Scholes reprice code.

---

## Appendix A — Files verified during this investigation

Direct reads (trust citations completely):
- [api/_lib/analyze-prompts.ts](../../../api/_lib/analyze-prompts.ts) — Step 10 directional opportunity check (lines 80-88), flow accuracy rankings (lines 513-531), ML signal hierarchy (lines 99-114), ML calibration (lines 116-122), RV/IV seller rule (lines 738-746), FOMC exit rule (lines 567-573), cone consumption (lines 266-272)
- [api/_lib/validation.ts](../../../api/_lib/validation.ts) — main structure enum (lines 168-173), `directionalOpportunity` schema (lines 227-243), `managementRules` schema (lines 210-217)

Grep-verified:
- No matches for `time.?stop`, `scale.?out`, `dollar.?per.?delta`, `breakeven.?move`, `thesis.?invalid`, `martingale` in `src/utils/` or `api/_lib/`. Confirms these concepts are not yet codified.

Cross-referenced against:
- [principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md) — this spec's time-stop and thesis-invalidation rules do not conflict with any open audit findings.
- [analyze-prompt-enhancements-2026-04-08.md](analyze-prompt-enhancements-2026-04-08.md) — this spec is a companion, not an overlap. Dependencies are tracked in Part 7.

---

## Appendix B — Open questions to resolve before implementing

1. **How does the trader define "entry thesis"?** The thesis invalidation rule (ENH-BUY-009) requires Claude to output a structured entry signal + invalidation signal. Is the thesis always one of the 4 Step 10 criteria, or can it be looser (e.g., a specific combination of signals)? Decide before implementing.
2. **What is the expected catalyst trade sizing?** For catalyst-trade entries (ENH-BUY-002), is the size the same as a non-catalyst directional entry, or reduced? This interacts with the sizing tier system.
3. **Does the scale-out ladder have commission sensitivity?** At fewer than 2 contracts, the ladder becomes impractical (you can't close half a single contract). The spec proposes falling back to a single exit at +75% in that case — confirm this matches the trader's preference.
4. **What delta threshold triggers the regime-change exit — 60 exact, or a range?** The 60Δ threshold in ENH-BUY-008 is a starting heuristic. After 10-20 real trades, recalibrate.
5. **Should the catalyst IV-crush haircut be calibrated from historical data?** The 15-25% / 8-15% / 3-8% ranges in ENH-BUY-002 are industry conventional wisdom. Your own journal could calibrate these empirically if you have enough past event-day trades.
6. **Debit vertical short-wing strike selection.** ENH-BUY-005 describes "sell an OTM wing at the target" — should the short wing be at the target price, 1 ATR beyond, or at a specific delta? This needs a concrete rule before implementation.
7. **Time stop when no time window was specified.** ENH-BUY-006 requires every directional entry to declare a time window. What happens if the rationale genuinely cannot specify one? The proposed rule says "prefer SIT OUT" — is that acceptable, or should there be a default fallback window (e.g., "close by 3:30 PM CT")?
8. **How does the midday reassessment interact with the scale-out ladder?** If the first waypoint (close half at +50%) has already fired by the midday analyze call, does Claude reason about the remaining runner as a new position or as the continuation of the original? Decide the state convention.

---

*End of spec.*
