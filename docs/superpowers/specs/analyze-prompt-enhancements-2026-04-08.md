# Analyze Prompt Enhancements — 2026-04-08

Recommendations for high-EV additions to the `/api/analyze` context and the `analyze-prompts.ts` system prompt, ranked by expected impact on **returns** (not accuracy). Captures the full investigation trail so this document can be used as a starting point without re-running the research.

Companion to [principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md) — the audit covers fixing what's broken; this spec covers adding what's missing.

---

## How to use this document

- Each recommendation has a stable ID (e.g. `ENH-EDGE-001`). Reference these in commits/PRs.
- Recommendations are grouped into three tiers by **expected impact on realized returns**. Tier 1 directly changes P&L; Tier 2 adds high-signal features cheaply; Tier 3 is build-when-ready.
- Each finding lists: rationale, current state (with file:line citations where verified), proposed implementation, dependencies, verification, and risks.
- "Verification" column of citations follows the audit convention: `direct-read` (I personally read the file), `grep-verified` (found via grep and confirmed), `agent-verified` (via Explore sub-agent, cross-checked), `agent-only` (uncorroborated).
- The "What you already have" section exists so future work does not duplicate existing functionality. Read it before building anything.

### Tier meanings

| Tier       | Meaning                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------- |
| **Tier 1** | Directly and measurably changes P&L on real trades. Build these first.                    |
| **Tier 2** | High-signal features that are cheap to build from existing data. Build after Tier 1.      |
| **Tier 3** | Genuine value but gated on other work (ML sample size, new endpoints, or infrastructure). |

---

## Methodology

1. **Initial question:** Is Unusual Whales' "Delta Flow" panel (non-MM net delta with opening/all toggle and per-expiry splits) worth sending to Claude as part of the market analysis prompt?
2. **Expanded question:** What else is missing from the analyze prompt that would have a real impact on accuracy and returns?
3. **Investigation approach:**
   - Read the principal engineer audit document end to end to understand known gaps.
   - Dispatched an `Explore` sub-agent to map every data source currently assembled in `api/_lib/analyze-context.ts` and formatted by `api/_lib/db-flow.ts`.
   - Grepped `analyze-prompts.ts` and `analyze-context.ts` directly for existing references to realized vol, VX term structure, gamma flip level, expected move tracking, economic calendar, and cohort-based historical outcomes.
   - Read `api/_lib/futures-context.ts` directly to confirm cross-asset coverage.
   - Verified path existence for every file cited in this document.
4. **Bias check:** Recommendations are pegged to returns impact, not accuracy or "more data is better." Where a commonly-suggested enhancement has bad ROI for the user's trading style (0DTE SPX, flat by close), it's in the "explicitly not recommended" section with reasoning.

---

## Part 1 — What you already have (do not rebuild)

This is a curated list of signals already present in the prompt or context assembly. Confirmed via direct read or grep against `api/_lib/analyze-prompts.ts` and `api/_lib/analyze-context.ts`.

| Signal                                                                    | Status                      | Location (verified)                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| RV/IV ratio with rich/cheap framing + explicit rules                      | ✅ in prompt                | [analyze-prompts.ts:738-746](../../../api/_lib/analyze-prompts.ts#L738-L746)                                                                     |
| VIX futures term structure (VX1/VX2 contango/backwardation)               | ✅ in prompt                | [analyze-prompts.ts:650-656](../../../api/_lib/analyze-prompts.ts#L650-L656)                                                                     |
| IV term structure (0DTE vs 30D IV) with contango/inversion rules          | ✅ in prompt                | [analyze-prompts.ts:340-360](../../../api/_lib/analyze-prompts.ts#L340-L360)                                                                     |
| Straddle cone + "% of cone consumed" tracking                             | ✅ in prompt                | [analyze-prompts.ts:178-272](../../../api/_lib/analyze-prompts.ts#L178-L272)                                                                     |
| Overnight ES range as % of straddle cone                                  | ✅ in prompt                | [analyze-prompts.ts:366-373](../../../api/_lib/analyze-prompts.ts#L366-L373)                                                                     |
| Economic calendar + event-day warnings (FOMC 15-min hard exit)            | ✅ in prompt                | [analyze-prompts.ts:567-573](../../../api/_lib/analyze-prompts.ts#L567-L573), [EventDayWarning.tsx](../../../src/components/EventDayWarning.tsx) |
| Cross-asset futures narrative (ES/NQ/VX/ZN/CL/GC/DX)                      | ✅ in context               | [futures-context.ts:150-330](../../../api/_lib/futures-context.ts#L150-L330)                                                                     |
| Skew + skew ratio (>2.0 = strong put-over-call premium)                   | ✅ in prompt                | [analyze-prompts.ts:357](../../../api/_lib/analyze-prompts.ts#L357)                                                                              |
| VIX1D inversion rule + Friday weekend-hedge bias                          | ✅ in prompt                | [analyze-prompts.ts:479-484](../../../api/_lib/analyze-prompts.ts#L479-L484)                                                                     |
| Dark pool levels (contaminated — see BE-DARKPOOL-001/002 in audit)        | ✅ in context, ⚠️ needs fix | [darkpool.ts](../../../api/_lib/darkpool.ts)                                                                                                     |
| Market Tide (all + OTM), SPX/SPY/QQQ Net Flow, 0DTE Index Flow, ETF Tides | ✅ in context (9 sources)   | [analyze-context.ts:798-803](../../../api/_lib/analyze-context.ts#L798-L803)                                                                     |
| `zero_dte_greek_flow` — delta-weighted flow (not pure premium)            | ✅ in context               | Fetched via `api/cron/fetch-greek-flow.ts`                                                                                                       |
| Greek exposure per-expiry (MM positioning) — gamma/charm/vanna/delta      | ✅ in context               | [db-flow.ts:162-274](../../../api/_lib/db-flow.ts#L162-L274)                                                                                     |
| Strike-level GEX (`spot-exposures/strike`) with multi-expiry profile      | ✅ in context               | `api/cron/fetch-gex-0dte.ts` + strike variants                                                                                                   |
| Pin risk analysis (OI concentration, proximity-weighted post-FE-MATH-001) | ✅ in context               | [pin-risk.ts](../../../src/utils/pin-risk.ts)                                                                                                    |
| Lessons learned curation (narrative memory)                               | ✅ in prompt                | [lessons.ts](../../../api/_lib/lessons.ts)                                                                                                       |
| Max pain, overnight gap analysis, SPX intraday candles                    | ✅ in context               | [analyze-context.ts](../../../api/_lib/analyze-context.ts)                                                                                       |

**The prompt is already comprehensive on market state.** What it lacks is primarily **personal edge context** (your own historical win rate in similar regimes), **risk gating** (session P&L, regime novelty), and a few derived metrics that are computable from data you already have but haven't distilled.

---

## Part 2 — Initial investigation: is UW Delta Flow additive?

### Context

The Unusual Whales "Delta Flow" panel displays net delta from all non-market-maker participants (retail, pro customers, brokers, firms), with two toggles:

- **OPEN / ALL** — opening-only deltas vs. opening + closing deltas
- **Per-expiry split** — second chart clip shows positive/negative delta broken down by expiration

### What's uniquely additive vs. what you already have

1. **Non-MM identity filter.** Your `zero_dte_greek_flow` captures _total_ delta flow (all participants, including MM gamma hedging). MM hedging in a negative-gamma tape can move large delta notional with zero informational content — it's mechanical. A non-MM-only signal strips mechanical hedging out and leaves positioning.

2. **Opening-only toggle.** A rolled put (close -60Δ → open -25Δ) looks like +35Δ under "all" mode, but is a fresh -25Δ bearish open under "open" mode. For 0DTE specifically this matters less (rolls are rare), but for multi-DTE positioning (which Claude should be considering when your journal shows 7-14 DTE directional buys) it matters a lot.

3. **Per-expiration delta split.** This is the highest-value slice. Nothing else in your stack expresses the conditional "non-MM is adding delta at 30 DTE while unloading 0DTE." Your `greek_exposure/expiry` captures this for **OI-based MM positioning** but not for **flow-based non-MM positioning**.

### Verdict: conditional yes, sequenced

- **Do not add "all" mode** — it overlaps with `zero_dte_greek_flow` and adds redundancy to a prompt already carrying 12 flow signals.
- **Do add opening-only, per-expiry non-MM delta** — the one slice that's genuinely orthogonal to what you have.
- **Route through the ML pipeline first.** Land the data in `flow_data` with a new source tag, let it accumulate 25-30 sessions, validate via SHAP importance and partial dependence before wiring into the analyze prompt.
- **Fix the OTM greek-flow leak first** (see ENH-FIX-001 below). It's a ~10-line change that captures ~60% of the "non-MM conviction" signal at near-zero integration cost.

### ENH-FIX-001 — OTM delta flow fields fetched but discarded

- **Severity:** Low (free-signal leak, not a bug)
- **Verification:** `agent-verified` (found during Explore investigation)
- **File:** `api/cron/fetch-greek-flow.ts:44-92` (approximate)
- **Issue:** The UW `/stock/SPX/greek-flow/{date}` endpoint response includes `otm_total_delta_flow` and `otm_dir_delta_flow` alongside the non-OTM variants. The fetch code receives these but the INSERT statement only maps the non-OTM fields. You are paying for the API call and discarding ~half the signal.
- **Why it matters:** OTM delta flow is dominated by directional conviction (ATM is dominated by hedging, pinning, and gamma scalping). The OTM variant is closer to "what do informed participants think" — which is exactly what the UW Delta Flow panel's non-MM filter is approximating.
- **Proposed fix:**
  1. Verify the exact column names in the API response (read `api/cron/fetch-greek-flow.ts` directly before editing).
  2. Add columns `otm_total_delta_flow` and `otm_dir_delta_flow` to the `flow_data` table via a new migration.
  3. Update the INSERT in `fetch-greek-flow.ts` to populate them.
  4. Extend `formatGreekFlowForClaude` in `db-flow.ts` to present ATM-total vs OTM-only as a contrast pair.
  5. Add a rule to `analyze-prompts.ts`: "When OTM delta flow diverges from total delta flow, trust OTM for directional conviction — the total reading is diluted by ATM hedging."
- **Verification:** After deployment, cross-check that `otm_total_delta_flow` values in `flow_data` are non-null and track the pattern visible in the UW web UI for the same day.
- **Scope:** Small. Migration + INSERT change + formatter addition + prompt rule. No new API calls.

### ENH-FLOW-001 — UW Delta Flow: opening-only, non-MM, per-expiry slice

- **Tier:** 3 (do after ENH-FIX-001 and Tier 1 items)
- **Rationale:** Captures the orthogonal signal not present in any existing source: non-MM opening conviction with expiry bucketing.
- **Current state:** Not present in any form. No endpoint called, no table, no formatter.
- **Proposed implementation:**
  1. Identify the UW endpoint backing the Delta Flow panel (check UW docs for a `delta-flow` or `flow/delta` variant; may be gated behind a higher-tier plan).
  2. Add a new cron (`api/cron/fetch-delta-flow.ts`) running every 5 min during market hours with `CRON_SECRET` verification.
  3. Create table `delta_flow_per_expiry` with columns: `captured_at`, `expiry`, `opening_pos_delta`, `opening_neg_delta`, `total_pos_delta`, `total_neg_delta`. Migration in `db-migrations.ts`.
  4. Stage 1: land the data; do NOT wire into `analyze-context.ts` yet.
  5. Stage 2: add as a feature in `build-features-phase2.ts`. Run the walk-forward validation for 25+ sessions. Check SHAP importance.
  6. Stage 3: if the feature ranks in the top ~15 by SHAP importance AND the economic interpretation is sensible, add a formatter and wire into `analyze-context.ts`.
- **Dependencies:** UW plan must include the delta flow endpoint. ML pipeline must have Phase 2 validation loop running (per ML-002 in audit, needs ≥25 walk-forward test points before selection is meaningful).
- **Risks:** Prompt context redundancy — the analyze prompt already has 12 flow-shaped signals. Adding a 13th without rationalizing the existing stack makes Claude's signal weighting worse, not better. Gate on ML validation specifically to prevent "more is better" bias.
- **Scope:** Moderate (new cron, new table, new formatter, ML integration).

---

## Part 3 — Tier 1: directly change P&L

These are the highest-EV additions. Each directly improves realized returns, not just prompt quality or accuracy.

### ENH-EDGE-001 — Personal cohort edge engine

- **Tier:** 1
- **Rationale:** Every other column in your prompt tells Claude what the **market** is doing. This tells Claude what **you** do in situations like this. Historical win rate in similar regimes is infinitely more actionable than another flow divergence signal, because it already accounts for your execution discipline, exit habits, sizing patterns, and the noise in your own decision-making. This is the single highest-EV thing you could build.
- **Current state:** Not present. The lessons curation system (`api/_lib/lessons.ts`) provides **narrative** memory — it feeds Claude qualitative past-incident summaries — but there is no **quantitative base-rate lookup**. Grepping `api/_lib/analyze-context.ts` for `cohort`, `personal.?edge`, `similar.?sessions`, `historical.?outcomes`, `regime.?stratified` returns zero matches.
- **Investigation notes:** Verified via grep on 2026-04-08 (see grep results in conversation log). Confirmed that `analyses` table stores per-session Claude output and the `journal` endpoints store per-trade outcomes. Both are queryable; neither is currently joined or aggregated for context assembly.
- **Proposed implementation:**

  **Step 1 — Define the regime fingerprint.**
  A regime fingerprint is a bucketized tuple of discrete features that represents "what kind of day is this":

  ```ts
  type RegimeFingerprint = {
    vixBucket: 'calm' | 'normal' | 'elevated' | 'stress'; // <15 / 15-20 / 20-27 / >27
    vix1dInversion: 'none' | 'mild' | 'extreme'; // VIX1D vs VIX ratio buckets
    gexSign: 'positive' | 'negative'; // aggregate GEX sign
    morningFlow: 'bullish' | 'neutral' | 'bearish'; // first 30 min NCP direction
    skewRegime: 'flat' | 'normal' | 'steep'; // 25Δ put skew buckets
    overnightGap: 'small' | 'medium' | 'large'; // gap as % of ATR
    dayOfWeek: 'mon' | 'tue' | 'wed' | 'thu' | 'fri';
  };
  ```

  Exact bucket thresholds should match the thresholds already used in `build-features-phase2.ts` so cohorts are consistent with ML training data.

  **Step 2 — Build the cohort query.**
  New module: `api/_lib/cohort-edge.ts`.

  ```ts
  async function getCohortEdge(
    current: RegimeFingerprint,
    lookbackDays = 60,
  ): Promise<CohortEdgeResult | null> {
    // 1. Query the analyses table for sessions in the last N days with
    //    matching fingerprint (exact match on all 7 bucket fields).
    // 2. Join to journal entries for actual trade outcomes.
    // 3. Aggregate: win_rate, avg_r_multiple, sample_size, best_structure.
    // 4. Return null if sample size < 5 (too noisy to be useful).
  }
  ```

  Returns a structured result:

  ```ts
  type CohortEdgeResult = {
    nSimilar: number; // sample size
    winRate: number; // 0..1
    avgRMultiple: number; // average P&L in R units
    medianHoldTime: number; // minutes
    bestStructureByWinRate: 'IC' | 'CCS' | 'PCS' | 'BWB';
    bestStructureByExpectancy: 'IC' | 'CCS' | 'PCS' | 'BWB';
    fingerprint: RegimeFingerprint;
    confidence: 'low' | 'medium' | 'high'; // derived from nSimilar
  };
  ```

  **Step 3 — Wire into `analyze-context.ts`.**
  In the main context assembly function, after computing the current regime features, call `getCohortEdge(currentFingerprint)` and inject the result as a new context block:

  ```ts
  ${cohortContext ? `\n## Your Historical Edge in Similar Regimes (from your journal)
  Sessions with similar fingerprint in the last 60 days: ${cohort.nSimilar}
  Your win rate: ${(cohort.winRate * 100).toFixed(0)}%
  Your avg R-multiple: ${cohort.avgRMultiple.toFixed(2)}R
  Best structure by win rate: ${cohort.bestStructureByWinRate}
  Best structure by expectancy: ${cohort.bestStructureByExpectancy}
  Confidence: ${cohort.confidence} (${cohort.nSimilar < 10 ? 'small sample' : 'adequate sample'})
  ` : ''}
  ```

  **Step 4 — Add a prompt rule.**
  In `analyze-prompts.ts`:

  ```
  ## Personal Edge Rule
  The "Your Historical Edge" block reflects YOUR actual trading record in similar
  regimes, not a market signal. It already accounts for your execution quality
  and sizing discipline. Use it as follows:
  - winRate < 0.45 and confidence >= medium: bias toward SIT OUT or REDUCED SIZE
  - winRate 0.45-0.55: standard sizing, follow signal consensus
  - winRate > 0.55 and avgRMultiple > 0.5: can consider FULL TIER sizing
  - nSimilar < 5: ignore this block, insufficient sample
  When the personal edge conflicts with the signal consensus, note the conflict
  explicitly and reason about which to trust given sample size.
  ```

- **Dependencies:**
  - Need ≥45 labeled sessions in `analyses` + `journal` tables before the cohort lookups become statistically meaningful. Per the audit (ML-002), this threshold was already identified for the ML pipeline; it applies here too.
  - `journal` table must include structured fields for: structure type, credit received, max loss, actual P&L, close reason. Verify these exist or add a migration.
- **Verification:**
  - Unit-test the fingerprint function against a held-out fixture of 10 historical days; verify bucketization is stable across minor feature noise.
  - Integration-test the cohort query against the actual `analyses` table; confirm results are non-empty for recent sessions.
  - Manual validation: pick 5 sessions where you know the outcome, run the cohort lookup, verify the returned cohort makes intuitive sense.
- **Risks:**
  - Small sample size in early days → over-fit to recent noise. The `nSimilar < 5` cutoff and explicit confidence tags mitigate but don't eliminate.
  - Regime drift — an edge that existed 60 days ago may not exist today. Consider a decay weight favoring recent sessions.
  - Fingerprint collision — two genuinely different regimes may share the same discrete bucket. This is why the buckets matter: they should match the ML feature discretization exactly.
- **Scope:** Moderate. Fingerprint helper + DB query module + analyze-context integration + prompt rules + unit tests.

---

### ENH-EDGE-002 — Slippage-adjusted credit in all expectancy math

- **Tier:** 1
- **Rationale:** Your IC/CCS/PCS credit calculations use mid-price pricing. Real fills on 0DTE SPX are typically 5-15% below mid on entry, plus additional slippage on exit. A trade with $2.00 mid credit and $1.85 realistic fill has a 7.5% lower expectancy than your calculator shows. Compounded over 200+ trades/year, this is a meaningful drag that Claude never sees. Fixing it changes every downstream recommendation.
- **Current state:** Verified via direct reads during the principal engineer audit. `iron-condor.ts:85-113` uses raw credit for PoP calculations; `bwb.ts:70-73, 199-203` uses raw credit for max-profit calculations. No slippage haircut anywhere.
- **Investigation notes:**
  - [iron-condor.ts:85-113](../../../src/utils/iron-condor.ts#L85-L113) — `calcPoP` uses `P(S>BE_low) + P(S<BE_high) − 1` with credit-derived breakevens. Credit enters directly without adjustment.
  - [bwb.ts:70-73](../../../src/utils/bwb.ts#L70-L73) — Put BWB max profit is `narrowWidth + netCredit` (correct formula, but `netCredit` is mid-priced).
  - No `slippage`, `fillQuality`, or `realisticCredit` field exists anywhere in `src/utils/` or the calculator types.
- **Proposed implementation:**

  **Step 1 — Calibrate slippage from your own fill history.**
  You have the data to calibrate this empirically. Query `journal` entries for the gap between `calculator_credit` and `actual_fill_credit`. Compute mean + stdev of the slippage percentage. If your journal doesn't capture calculator-suggested credit, add it going forward.

  Starting default: 8% slippage on entry, 5% on exit (a conservative baseline for 0DTE SPX verticals).

  **Step 2 — Add slippage fields to calculator types.**
  In `src/types/`:

  ```ts
  type CreditPair = {
    mid: number; // theoretical mid-based credit
    realistic: number; // mid × (1 - slippagePct)
    slippagePct: number; // the haircut used
  };
  ```

  **Step 3 — Thread through the calculation utilities.**
  - `iron-condor.ts:buildIronCondor` — return both `creditMid` and `creditRealistic`. Compute PoP, max loss, and expectancy using `creditRealistic`.
  - `bwb.ts:buildPutBWB` + `buildCallBWB` — same pattern.
  - `strikes.ts` — pass slippage through from caller.
  - Display both values in the UI so you can see the difference. The UI is an important teaching tool for internalizing the true edge.

  **Step 4 — Send both to Claude.**
  In `analyze-context.ts`, include both the mid credit and realistic credit in the structured context. Add a prompt rule:

  ```
  ## Slippage Rule
  The calculator provides both "mid credit" (theoretical) and "realistic credit"
  (mid minus empirical slippage haircut). Use the realistic credit for all
  expectancy, PoP, and sizing reasoning. Reference the mid credit only to
  flag when the slippage gap is unusually wide (>15%), which indicates a
  wide bid-ask and potentially poor liquidity at those strikes.
  ```

  **Step 5 — Ongoing calibration.**
  After each trade, log the gap between the displayed realistic credit and the actual fill. Recalibrate the slippage default monthly from the running average.

- **Dependencies:** Journal schema must capture actual fill prices. Verify this exists before starting.
- **Verification:**
  - Unit-test that passing `slippagePct=0` yields identical results to the current mid-only calculation (backward compatibility).
  - Verify that PoP decreases monotonically as slippage increases.
  - Run on 10 historical trades where you have both the suggested credit and actual fill; confirm the realistic credit matches actual fills ±2%.
- **Risks:**
  - Over-haircutting during high-liquidity regimes will cause Claude to skip trades that would have been profitable. Calibration matters — start conservative but don't make it static.
  - The haircut should be strike-dependent (wings have wider spreads than ATM) but a single scalar is the right starting point.
- **Scope:** Moderate. Type changes + three util modules + UI display + calibration script. Most of the work is threading the new field through existing math, which is straightforward.

---

### ENH-RISK-001 — Hard daily loss gate with Claude enforcement

- **Tier:** 1
- **Rationale:** The single biggest returns driver for a trader with a working edge is **not losing on tilt days**. A disciplined trader with a 55% edge who stops after -2R beats the same trader without the stop over any meaningful horizon. Claude currently does not know your session P&L and cannot apply this constraint. This turns a known good habit into a rule that Claude helps enforce.
- **Current state:** Verified via grep of `analyze-prompts.ts` — no references to `session_pnl`, `daily_pnl`, `loss_gate`, `max_daily_loss`, or `tilt`. Verified via grep of `analyze-context.ts` — no injection of current session P&L into context.
- **Proposed implementation:**

  **Step 1 — Define the R unit.**
  Your R is the dollar risk per trade at your standard sizing tier. If your standard IC risks $500, then R = $500 and -2R = -$1000. Store this as a user-configurable constant in `src/constants/index.ts` or a new `src/config/risk-config.ts`.

  **Step 2 — Compute session P&L at analyze time.**
  In `analyze-context.ts`, before the main prompt assembly:

  ```ts
  const sessionPnL = await computeSessionPnL(today); // sum of closed trades + mark-to-market on open
  const rUnit = getRUnit();
  const pnlInR = sessionPnL / rUnit;
  const gatesActive = {
    maxLoss: pnlInR <= -2,
    softWarn: pnlInR <= -1,
  };
  ```

  Source the closed trades from the journal table, and mark-to-market on open positions from the most recent Schwab price quotes.

  **Step 3 — Inject into the prompt.**
  Add a new context block:

  ```
  ## Session Risk State
  Today's realized P&L: ${sessionPnL.toFixed(0)} (${pnlInR.toFixed(1)}R)
  Loss gate status: ${gatesActive.maxLoss ? 'TRIPPED — no new entries' : gatesActive.softWarn ? 'WARNING — reduce size' : 'clear'}
  ```

  **Step 4 — Add a hard prompt rule.**
  In `analyze-prompts.ts`, as a high-priority rule (priority tier similar to the FOMC hard exit rule):

  ```
  ## Rule: Session Loss Gate
  If `gatesActive.maxLoss` is true in the Session Risk State block, you MUST
  recommend SIT OUT regardless of what other signals say. This rule overrides
  all structure-selection rules. Note in observations: "Rule Loss Gate applied:
  session P&L at ${pnlInR.toFixed(1)}R has tripped the 2R daily loss gate."

  If `gatesActive.softWarn` is true (between -1R and -2R), reduce the recommended
  size by one tier and explicitly acknowledge the warning in observations.
  ```

- **Dependencies:**
  - Journal table must track closed P&L per trade with a timestamp, so `computeSessionPnL` can sum correctly.
  - Mark-to-market on open positions requires knowing current option prices. If Schwab quote freshness is a concern, the fallback should be "last known credit − 50% mid as a conservative estimate."
- **Verification:**
  - Unit-test `computeSessionPnL` with a fixture of closed trades.
  - Integration-test with a simulated -2R day; verify Claude's output is SIT OUT and references the rule by name.
  - Monitor for false positives during low-activity days.
- **Risks:**
  - False trip if journal P&L is stale or mis-parsed. Fail-safe: if session P&L cannot be computed, log a warning and **do not** trip the gate — fall back to signal-only reasoning. Better to miss an enforcement than to block a valid entry.
  - The 2R threshold is a hyperparameter. Start at 2R, observe for 30 days, consider tightening to 1.5R if tilt days are frequent.
- **Scope:** Small-to-moderate. Session P&L helper + context injection + prompt rule + unit tests. No schema changes if the journal already stores closed P&L and timestamps.

---

## Part 4 — Tier 2: missing signals, cheap to build

### ENH-SIGNAL-001 — Zero-gamma level + distance-to-flip

- **Tier:** 2
- **Rationale:** The strike at which aggregate dealer gamma flips from positive to negative (the "zero-gamma line") is one of the most predictive 0DTE regime signals in existence. Above it, dealers hedge mean-reverting (sell rallies, buy dips → pinning, good for premium selling). Below it, dealers hedge momentum (buy rallies, sell dips → acceleration, bad for premium selling). You have all the raw data to compute this, but you're sending Claude per-strike gamma values instead of the derived "where is the flip and how far are we from it" metric.
- **Current state:** Verified via grep of `analyze-prompts.ts` — the string `gamma flip` appears only in the context of "orange bars = gamma flipped since last 10-min slice" (a different concept — charm sign change per time slice, not the dealer zero-gamma strike). No computation of the actual zero-gamma strike exists. `src/utils/gex-migration.ts` has derived metrics like `pctChange` but no `zeroGammaStrike` helper.
- **Investigation notes:**
  - [analyze-prompts.ts:174](../../../api/_lib/analyze-prompts.ts#L174) — "Orange bars = gamma flipped since last 10-min slice" is the only reference; this is about time-series charm changes, not the static zero-gamma strike level.
  - No grep match for `zero.?gamma`, `flip.?level`, or `gamma.?zero` in `api/_lib/` or `src/utils/`.
- **Proposed implementation:**

  **Step 1 — Add a computation helper.**
  New file: `src/utils/zero-gamma.ts`.

  ```ts
  export function computeZeroGammaStrike(
    strikes: Array<{ strike: number; netGamma: number }>,
    spot: number,
  ): number | null {
    // Sort by strike ascending
    const sorted = [...strikes].sort((a, b) => a.strike - b.strike);
    // Compute running cumulative gamma from the lowest strike upward
    let cumulative = 0;
    const withCumulative = sorted.map((s) => {
      cumulative += s.netGamma;
      return { strike: s.strike, cumulative };
    });
    // Find the strike where cumulative crosses zero
    for (let i = 1; i < withCumulative.length; i++) {
      const prev = withCumulative[i - 1]!;
      const curr = withCumulative[i]!;
      if (
        (prev.cumulative <= 0 && curr.cumulative > 0) ||
        (prev.cumulative >= 0 && curr.cumulative < 0)
      ) {
        // Linearly interpolate the zero-crossing for sub-strike precision
        const t = -prev.cumulative / (curr.cumulative - prev.cumulative);
        return prev.strike + t * (curr.strike - prev.strike);
      }
    }
    return null; // no crossing found (all positive or all negative)
  }

  export function distanceToFlip(
    spot: number,
    zeroGammaStrike: number,
    dailyATR: number,
  ): { points: number; atr: number; side: 'positive' | 'negative' } {
    const points = spot - zeroGammaStrike;
    return {
      points,
      atr: Math.abs(points) / dailyATR,
      side: points > 0 ? 'positive' : 'negative',
    };
  }
  ```

  **Step 2 — Feed into analyze context.**
  In `analyze-context.ts`, when assembling the GEX section, also compute and include:

  ```ts
  const zeroGammaStrike = computeZeroGammaStrike(strikeGex, spot);
  const flipDistance = zeroGammaStrike
    ? distanceToFlip(spot, zeroGammaStrike, dailyATR)
    : null;
  ```

  Inject into prompt:

  ```
  ## Zero-Gamma Level
  Zero-gamma strike: ${zeroGammaStrike.toFixed(0)} (aggregate dealer gamma flips here)
  Distance from spot: ${flipDistance.points.toFixed(0)} pts (${flipDistance.atr.toFixed(2)} ATR)
  Current regime: ${flipDistance.side === 'positive' ? 'POSITIVE GAMMA (mean-reverting dealer hedging, pinning regime)' : 'NEGATIVE GAMMA (momentum dealer hedging, acceleration regime)'}
  ```

  **Step 3 — Add a prompt rule.**

  ```
  ## Zero-Gamma Rule
  The distance-to-flip metric determines hedging regime:
  - Positive side, >1 ATR from flip: strong pinning regime. Favors IC with
    narrow wings. Safe to place shorts near calculator delta ceiling.
  - Positive side, <1 ATR from flip: transitional. Bias toward smaller size
    and tighter deltas — a single impulse move flips the regime.
  - Negative side, any distance: acceleration regime. Avoid IC unless cone
    is very tight and conviction is high. Prefer directional credit spreads
    aligned with the flow direction, with hedge considered mandatory.
  - Zero-gamma unknown (all strikes positive or all negative): log the
    unusual condition but do not auto-restrict structure selection.
  ```

- **Dependencies:** None. Uses existing strike GEX data from `fetch-gex-0dte.ts` + spot price + existing ATR calculation.
- **Verification:**
  - Unit-test `computeZeroGammaStrike` against fixtures with: (a) obvious single crossing, (b) no crossing, (c) multiple crossings (take the one closest to spot), (d) exact-zero at a strike.
  - Validate against UW's own "gamma flip" display for 5-10 sessions to confirm parity with their computation.
- **Risks:**
  - "Aggregate net gamma" depends on which gamma data you cumulate. Decision: use dealer-side gamma (not customer-side), and confirm via the UW docs which convention they use for their published gamma flip level.
  - Multiple zero crossings are possible in distorted markets. Take the one closest to spot as canonical.
- **Scope:** Small. One utility module + one formatter addition + one prompt rule + unit tests.

---

### ENH-SIGNAL-002 — ML ensemble probabilities piped back into the prompt

- **Tier:** 2 (gated on ML sample size)
- **Rationale:** Your Phase 2 ML pipeline produces XGBoost, Random Forest, and Logistic Regression predictions for trade outcomes, but these don't feed back into the analyze context. Claude is reasoning about the market without being told "the ensemble says 0.62 probability of IC profitable today." Claude + ML ensemble is strictly better than either alone — Claude handles qualitative regime narrative (news, cross-asset, unusual structure) that ML can't see; ML handles precise probability calibration from feature dimensions Claude can't weight consistently.
- **Current state:** Verified via file existence — `ml/src/phase2_early.py` has the walk-forward pipeline and produces predictions. Grepped `api/_lib/analyze-context.ts` for `ml.?prediction`, `model.?output`, `xgb.?prob`, `rf.?prob` — no matches. The predictions are generated, saved as experiment JSONs in `ml/experiments/`, and never fed back into the production prompt.
- **Investigation notes:**
  - Per audit ML-002, the walk-forward is producing only ~5 test points on 25 labeled days. Model selection on this sample is statistical noise.
  - The audit explicitly recommends waiting for ≥25 walk-forward test predictions before acting on model output. That gate applies here too.
  - The right design captures model output now (so the data exists when the pipeline matures) but defers wire-in until after validation.
- **Proposed implementation:**

  **Step 1 — New prediction storage table.**
  Migration in `db-migrations.ts`:

  ```sql
  CREATE TABLE IF NOT EXISTS ml_predictions (
    id SERIAL PRIMARY KEY,
    prediction_date DATE NOT NULL,
    feature_fingerprint TEXT NOT NULL,  -- hash of feature vector for traceability
    p_ic NUMERIC(5,4),        -- probability IC profitable
    p_ccs NUMERIC(5,4),       -- probability CCS profitable
    p_pcs NUMERIC(5,4),       -- probability PCS profitable
    p_sit_out NUMERIC(5,4),   -- probability best action is sit out
    ensemble_version TEXT,     -- git sha of ml/src at training time
    model_confidence TEXT,     -- low / medium / high based on n_test
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (prediction_date, ensemble_version)
  );
  ```

  **Step 2 — Extend the ML pipeline to write predictions.**
  In `ml/src/phase2_early.py`, after model training, for each day in the test set, write the ensemble prediction to `ml_predictions` via a new `api/ml/write-predictions` endpoint (secured by `CRON_SECRET`).

  **Step 3 — Lookup in analyze context.**
  In `api/_lib/analyze-context.ts`:

  ```ts
  async function getMlPredictionForToday(): Promise<MlPrediction | null> {
    const result = await sql`
      SELECT p_ic, p_ccs, p_pcs, p_sit_out, model_confidence, ensemble_version
      FROM ml_predictions
      WHERE prediction_date = CURRENT_DATE
      ORDER BY created_at DESC
      LIMIT 1
    `;
    return result[0] ?? null;
  }
  ```

  If present AND `model_confidence !== 'low'`, inject into the context:

  ```
  ## ML Ensemble Prediction
  Model probability (from walk-forward validated ensemble):
    IC profitable: ${p_ic}
    CCS profitable: ${p_ccs}
    PCS profitable: ${p_pcs}
    Sit out best: ${p_sit_out}
  Confidence: ${model_confidence}
  Ensemble version: ${ensemble_version}
  ```

  **Step 4 — Prompt rule.**

  ```
  ## ML Ensemble Rule
  The ML Ensemble block reflects a walk-forward validated probabilistic
  prediction trained on your historical outcomes. It sees statistical
  patterns in features you may not weight consistently.
  - If ML top pick agrees with your signal consensus: reinforces confidence,
    consider HIGH confidence in the output.
  - If ML top pick disagrees with signal consensus: you must explicitly
    resolve the conflict in observations. Neither is automatically correct.
    Weight ML heavier when signal consensus is soft (mixed flow, neutral GEX).
    Weight Claude reasoning heavier when signal consensus is strong and
    economically grounded (clear news catalyst, obvious cross-asset story).
  - If model_confidence is 'low' or block is missing: ignore this block.
  ```

- **Dependencies:**
  - ML-002 resolution (≥25 walk-forward test predictions). Can stage infrastructure earlier but must not wire into prompt until validation matures.
  - ML pipeline must emit ensemble probability, not just top-class prediction. Verify current `phase2_early.py` output format; adjust if needed.
- **Verification:**
  - After the pipeline runs, confirm `ml_predictions` row appears for today.
  - Cross-check that `p_ic + p_ccs + p_pcs + p_sit_out ≈ 1.0` (within rounding).
  - A/B: run analyze with and without the ML block for the same session; compare Claude's structured output to verify the block is changing reasoning.
- **Risks:**
  - Premature wire-in while ML is still noise → Claude defers to garbage. The `model_confidence` gate must be honored.
  - Model-spec drift between training and serving. The `ensemble_version` field is specifically to catch this — if the analyze context sees a stale version, degrade to `low` confidence automatically.
- **Scope:** Moderate. New table + migration + ML pipeline write path + analyze context lookup + formatter + prompt rule. Most complexity is in the ML pipeline side, not the TypeScript side.

---

## Part 5 — Tier 3: gated on other work

### ENH-GATE-001 — Regime novelty detector

- **Tier:** 3 (gated on ML pipeline maturity)
- **Rationale:** The 3-5 days per year that destroy annual P&L are the ones where all signals say "go" and then something unprecedented happens (2018-02-05, 2020-03-12, 2022-11-10). A novelty detector flags "today's feature vector is unlike anything in your training history" and forces SIT OUT regardless of other signals. It only fires a handful of times per year, but those are the days that matter most for terminal wealth.
- **Current state:** Not present. The ML pipeline does not compute or expose a novelty/distance metric.
- **Proposed implementation:**

  **Step 1 — Compute k-NN distance at feature time.**
  In `build-features-phase2.ts`, after computing today's feature vector, compute the distance to each historical feature vector in the training set. Return the distance to the k-th nearest neighbor (k=5 is a reasonable starting point).

  **Step 2 — Compute the novelty percentile.**
  Store the distribution of k-NN distances across all training days. Today's novelty score is the percentile of today's k-NN distance within that distribution.

  **Step 3 — Gate at the 95th percentile.**
  If today's novelty score is in the top 5% (more distant from nearest neighbors than 95% of training days have been), flag as "novel regime" and force SIT OUT.

  **Step 4 — Wire into analyze context.**

  ```
  ## Regime Novelty Check
  Today's feature novelty percentile: ${noveltyPct}
  Nearest historical sessions:
    1. ${date1} (distance ${d1.toFixed(2)})
    2. ${date2} (distance ${d2.toFixed(2)})
    3. ${date3} (distance ${d3.toFixed(2)})
  Status: ${novelty > 0.95 ? 'NOVEL REGIME DETECTED — force SIT OUT' : 'within historical norms'}
  ```

  **Step 5 — Prompt rule.**

  ```
  ## Regime Novelty Rule
  If the Regime Novelty Check reports "NOVEL REGIME DETECTED", you MUST
  recommend SIT OUT. This rule overrides all structure selection rules.
  The rationale: the market is in a configuration your training data has
  not seen, so neither signal-based nor ML-based predictions have
  reliable base rates. Capital preservation dominates in these conditions.
  Note in observations: "Rule Regime Novelty applied: today's feature
  vector is in the 95th+ percentile of k-NN distance, regime is unlike
  historical norms."
  ```

- **Dependencies:**
  - Minimum ~60 labeled days for the k-NN distance distribution to have meaningful percentiles. Fewer days → unstable novelty threshold.
  - Feature vector must be normalized (z-score or min-max) before computing Euclidean distance, else features with larger scales dominate.
- **Verification:**
  - Historical backtest: compute the novelty score for every past session; verify that known anomaly days rank in the top 5%. If they don't, the feature vector is missing important dimensions.
  - Sanity check: today's percentile should be stable intraday (feature vector doesn't change much between 10am and 3pm), else the feature normalization is broken.
- **Risks:**
  - Feature-engineering sensitivity: the choice of features determines what "novel" means. A regime that looks novel in one feature space may look normal in another.
  - False positives are acceptable (cost = one missed trade); false negatives are catastrophic (cost = full loss on a blow-up day). Tune the threshold to prefer sensitivity over specificity.
- **Scope:** Moderate. ML pipeline extension + analyze context lookup + prompt rule. Bulk of the work is in the Python side.

---

### ENH-SIGNAL-003 — Conditional intraday realized vol curves

- **Tier:** 3
- **Rationale:** You have RV/IV spread as an aggregate, but not conditional on time-of-day and regime. The well-known empirical fact: intraday realized vol clusters (morning is higher than afternoon in most regimes) but also mean-reverts (if morning hit an extreme, afternoon compresses back). A conditional RV curve says: "In the current VIX bucket, realized vol in the 8:30-10:00 CT window is historically 1.4x the afternoon. We've already hit 1.6x, so the afternoon is likely to compress." That's a regime-specific signal you're not currently exposing.
- **Current state:** Not present. Your aggregate RV/IV ratio ([analyze-prompts.ts:738-746](../../../api/_lib/analyze-prompts.ts#L738-L746)) is computed over a fixed window (presumably the full session or a rolling N-day lookback). No time-of-day decomposition exists.
- **Proposed implementation:**

  **Step 1 — Build a time-bucketed RV history table.**
  Compute, for each historical session, realized vol in 30-min buckets: `[8:30-9:00, 9:00-9:30, 9:30-10:00, ..., 14:30-15:00]`. Store as `intraday_rv_buckets(date, bucket, rv_annualized, vix_bucket, vix1d_inversion_flag)`.

  **Step 2 — Compute conditional distributions.**
  Offline: for each `(bucket, vix_bucket)` pair, compute the distribution of observed RV. Key statistics: median, 25th/75th percentile, 95th percentile.

  **Step 3 — Real-time consumption tracking.**
  At analyze time, compute realized vol for buckets already completed today. Compare to the conditional distribution:

  ```
  ## Intraday Vol Consumption
  8:30-9:00 RV: 18.2% annualized (68th percentile for VIX bucket "normal")
  9:00-9:30 RV: 22.1% annualized (82nd percentile)
  Cumulative session RV so far: 20.4% (74th percentile)
  Typical afternoon continuation: compressing (morning was above median)
  ```

  **Step 4 — Prompt rule.**

  ```
  ## Intraday Vol Consumption Rule
  - Morning buckets above 75th percentile AND afternoon not yet started:
    bias toward PREMIUM SELLING (variance budget is being spent early).
  - Morning buckets below 25th percentile: bias away from premium selling
    (conditional compression reduces the seller's edge; afternoon may
    break out to catch up).
  - Cumulative session RV > 90th percentile: unusual day in progress.
    Reduce size, consider hedge mandatory.
  ```

- **Dependencies:**
  - Need enough history to populate the conditional distributions. 60 trading days per VIX bucket is a minimum; 120+ is better. Can bootstrap from your existing SPX minute bar history.
- **Verification:**
  - Backtest: verify the "morning RV above 75th percentile → compression" rule empirically against historical afternoons.
  - Stability: the conditional distributions should be stable across 3-month rolling windows. If they drift, the VIX bucketization is wrong.
- **Risks:**
  - Small sample in stress regimes. The VIX "stress" bucket (>27) may have only a handful of historical examples, making conditional percentiles unreliable. Gate conditional output on `n_samples >= 20` per bucket.
- **Scope:** Moderate-to-large. New table + historical backfill script + distribution computation + real-time bucket tracker + formatter + prompt rule.

---

## Part 6 — Explicitly NOT recommended

These are commonly suggested enhancements that have poor ROI for this specific setup (0DTE SPX, disciplined premium selling, flat by close). Listing them here so future sessions don't re-propose them.

| Enhancement                                                      | Why not                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MBP-1 order book pressure (Databento)**                        | Real signal, but 5-15 minute half-life. For 0DTE premium selling with an intraday-to-EOD decision horizon, you can't exploit it. Good for scalpers. Integration cost is high.                         |
| **Twitter / Reddit / news sentiment scraping**                   | Noisy, expensive to build, negative expected value for disciplined trading. News is already surfaced via the econ calendar for scheduled events, which is what matters.                               |
| **Correlation decoupling / dispersion signals**                  | Theoretically interesting, too sparse for your sample size to learn from.                                                                                                                             |
| **More flow sources beyond the existing 9**                      | Bottleneck is redundancy management, not coverage. Adding a 13th flow column makes Claude's signal weighting worse, not better. See Part 2 (UW Delta Flow).                                           |
| **Full Kelly sizing**                                            | Full Kelly on estimated edge blows up accounts when edge is overestimated. Fractional Kelly (¼) via the cohort edge engine gives 80% of the benefit at 10% of the variance. Use ENH-EDGE-001 instead. |
| **Transformer-based regime models**                              | Walk-forward sample size does not support deep learning. Stick with gradient boosting + logistic regression per the ML pipeline design.                                                               |
| **Retail vs institutional flow decomposition (SPY vs SPX bias)** | Theoretically interesting, practically noisy. You already have both in the prompt; if divergence mattered, ML would pick it up via ENH-SIGNAL-002.                                                    |
| **Bid/ask spread widening as a tape-health signal**              | Real but redundant with VIX and VVIX, which already capture it.                                                                                                                                       |

---

## Part 7 — Implementation sequence

A realistic ordering that respects dependencies and front-loads high-EV work. Units are relative scope, not time estimates.

### Phase 1 — Foundation (highest EV per unit of work)

1. **ENH-FIX-001** — Wire the already-fetched OTM delta flow fields into storage and the prompt. Smallest scope, non-zero EV, unblocks ENH-FLOW-001.
2. **ENH-RISK-001** — Daily loss gate. Smallest infrastructural lift among Tier 1 items. Requires only journal-sourced session P&L + one prompt rule. Protects the edge you already have.
3. **ENH-EDGE-002** — Slippage-adjusted credit. Moderate scope but touches foundational math. Every downstream recommendation improves after this ships.

### Phase 2 — The big one

4. **ENH-EDGE-001** — Personal cohort edge engine. Highest expected lift of any item in this spec. Ship after Phase 1 because you want the slippage-adjusted credit to feed into the cohort's R-multiple computation (otherwise historical R values are inflated by mid-based credit).

### Phase 3 — Derived signals from existing data

5. **ENH-SIGNAL-001** — Zero-gamma level + distance-to-flip. Small scope, uses existing data. Ship alongside ENH-EDGE-001 if capacity allows.

### Phase 4 — ML integration (gated on sample size)

6. **ENH-SIGNAL-002** — ML ensemble probabilities piped into prompt. Infrastructure can be staged now; wire into prompt after ≥25 walk-forward test points.
7. **ENH-GATE-001** — Regime novelty detector. Same gate as above. Ship together as a coordinated ML-aware prompt upgrade.

### Phase 5 — Nice-to-have

8. **ENH-SIGNAL-003** — Conditional intraday RV curves. Moderate work, moderate payoff. Ship when Phase 1-4 are done and stable.
9. **ENH-FLOW-001** — UW Delta Flow opening-only per-expiry slice. Lowest priority of the "additive" items. Requires UW plan coverage + ML validation pass.

### Coordinate with the principal engineer audit

Several high-severity fixes from [principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md) directly improve what Claude sees and should be sequenced alongside Phase 1:

- **BE-DARKPOOL-001 + BE-DARKPOOL-002** (Critical) — contingent prints and intraday-window filters. Without these, the dark pool levels Claude sees are contaminated.
- **CSV-001** (High) — trade grouping by ±1s window. Without this, Claude still sometimes sees naked legs where there are actually spreads.
- **BE-CRON-001** (High) — Schwab token refresh cross-instance lock. Without this, the context assembly can fail silently during market-open bursts.
- **FE-STATE-001** (High) — `isStale` flag on market data. A hidden prerequisite for trusting any of the new signals: if the data is stale, the signal is lying.

A reasonable interleaving: ship ENH-RISK-001 first (smallest, highest floor), then tackle BE-DARKPOOL-001/002 and CSV-001 (cleaning the existing signal), then ENH-EDGE-002, then ENH-EDGE-001. Phase 3+ after that.

---

## Appendix A — Full data source inventory (as of 2026-04-08)

From the Explore sub-agent investigation on 2026-04-08. Use this as the authoritative snapshot of what `api/_lib/analyze-context.ts` assembles and sends to Claude today.

| #   | Source              | UW Endpoint                                                 | Fetch     | Fields in Prompt                                                          | Aggregation                             |
| --- | ------------------- | ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------- | --------------------------------------- |
| 1   | Market Tide (All)   | `/market/market-tide?interval_5m=true`                      | 5 min     | NCP, NPP, net_volume, direction, divergence                               | Cumulative 5-min candles                |
| 2   | Market Tide (OTM)   | `/market/market-tide?interval_5m=true&otm_only=true`        | 5 min     | NCP, NPP, net_volume, direction, divergence                               | Cumulative 5-min candles, OTM-only      |
| 3   | SPX Net Flow        | `/stock/SPX/net-prem-ticks`                                 | 5 min     | NCP, NPP, net_volume, direction                                           | Cumulative 1-min ticks sampled 5-min    |
| 4   | SPY Net Flow        | `/stock/SPY/net-prem-ticks`                                 | 5 min     | NCP, NPP, net_volume, direction                                           | Same                                    |
| 5   | QQQ Net Flow        | `/stock/QQQ/net-prem-ticks`                                 | 5 min     | NCP, NPP, net_volume, direction                                           | Same                                    |
| 6   | SPY ETF Tide        | `/net-flow/expiry` (ETF variant)                            | 5 min     | NCP, NPP, net_volume, direction                                           | Cumulative 5-min, holdings flow         |
| 7   | QQQ ETF Tide        | `/net-flow/expiry` (ETF variant)                            | 5 min     | NCP, NPP, net_volume, direction                                           | Cumulative 5-min, holdings flow         |
| 8   | 0DTE Index Flow     | `/net-flow/expiry?expiration=zero_dte&tide_type=index_only` | 5 min     | NCP, NPP, net_volume, direction                                           | Cumulative 5-min, SPX/NDX 0DTE          |
| 9   | 0DTE Greek Flow     | `/stock/SPX/greek-flow/{date}`                              | 5 min     | total_delta_flow, dir_delta_flow (OTM variants dropped — see ENH-FIX-001) | Per-minute delta accumulation           |
| 10  | Greek Exposure (OI) | `/stock/SPX/greek-exposure` + `/expiry`                     | EOD / 6h  | Gamma, charm, delta, vanna per expiry                                     | Per-expiry MM positioning               |
| 11  | Spot GEX Panel      | `/stock/SPX/spot-exposures`                                 | 5 min     | Gamma/charm/vanna OI + Vol + Dir, price                                   | Latest snapshot + 6 recent 5-min points |
| 12  | Strike GEX          | `/stock/SPX/spot-exposures/strike?limit=500`                | 6h        | Gamma/charm/vanna call/put/net per strike                                 | Per-strike all-expiry snapshot          |
| 13  | Expiry-Strike GEX   | `/stock/SPX/spot-exposures/expiry-strike`                   | 6h        | Gamma/charm per strike per expiry                                         | Per-strike per-expiry                   |
| 14  | Vol Realized        | Internal compute from SPX candles                           | Daily     | iv_30d, rv_30d, iv_rv_spread, iv_overpricing_pct, iv_rank                 | Daily aggregate                         |
| 15  | VIX / VIX1D         | Multiple (internal + snapshots)                             | 5 min     | Spot, 1D, 9D, term structure, inversion flag                              | Current + historical comparison         |
| 16  | IV Term Structure   | Derived from SPX chain                                      | 5 min     | 0DTE IV, 30D IV, contango vs inversion                                    | Shape classifier                        |
| 17  | Dark Pool           | UW dark pool endpoints                                      | 5 min     | Blocks, levels, clustering                                                | Price-clustered institutional levels    |
| 18  | Pin Risk            | Computed from chain OI                                      | Real-time | Top OI strikes + near-spot (post FE-MATH-001)                             | Proximity-weighted union                |
| 19  | Max Pain            | Computed from chain                                         | Real-time | Max pain strike + current distance                                        | Point-in-time                           |
| 20  | Overnight Gap       | ES futures from sidecar                                     | Real-time | Overnight range, % of straddle cone                                       | Session aggregate                       |
| 21  | SPX Candles         | Schwab or chain-derived                                     | Real-time | OHLCV intraday bars                                                       | 1-min resampled                         |
| 22  | Cross-Asset Futures | Databento sidecar                                           | 5 min     | /ES, /NQ, /VX, /ZN, /CL, /GC, /DX                                         | Per-symbol daily + narrative            |
| 23  | Skew                | Derived from chain                                          | Real-time | 25Δ put skew, skew ratio                                                  | Point-in-time                           |
| 24  | Positions (CSV)     | TOS export upload                                           | On upload | Parsed open spreads, risk summary                                         | Structured trade context                |
| 25  | Lessons Learned     | Lessons curation pipeline                                   | Daily     | Narrative past-incident memory                                            | Curated text block                      |

**Total: 25 distinct context sources.** The bottleneck is no longer coverage — it's signal rationalization (knowing which to trust when they disagree) and derived metrics that distill raw data into actionable numbers.

---

## Appendix B — Files read or verified during this investigation

Direct reads:

- [docs/superpowers/specs/principal-engineer-audit-2026-04-07.md](principal-engineer-audit-2026-04-07.md) (full document, 895 lines)
- [api/\_lib/futures-context.ts](../../../api/_lib/futures-context.ts) (lines 1-50 + 150-330)

Grep-verified citations (pattern found, file:line confirmed):

- [api/\_lib/analyze-prompts.ts](../../../api/_lib/analyze-prompts.ts) — RV/IV rule block, VX term structure rule, IV term structure rule, straddle cone rules, FOMC exit rule, VIX1D inversion rules, "gamma flip" (charm sign change, not zero-gamma)
- [api/\_lib/analyze-context.ts](../../../api/_lib/analyze-context.ts) — volRealizedContext assembly (lines 415-464), futures context integration, all formatter wiring
- Negative-grep verified (absent from codebase): `gamma.?flip` as zero-gamma level, `cohort`, `personal.?edge`, `similar.?sessions`, `historical.?outcomes`, `regime.?stratified`, `ml.?prediction`, `model.?output`, `xgb.?prob`, `rf.?prob`

Agent-verified (via Explore sub-agent, cross-checked against grep):

- Full inventory of 13 UW endpoints currently called (see Appendix A)
- `otm_total_delta_flow` and `otm_dir_delta_flow` fetched but discarded in `api/cron/fetch-greek-flow.ts`
- `db-flow.ts` formatter list (formatSpotExposuresForClaude, formatGreekFlowForClaude, etc.)

File existence confirmed via ls:

- `api/cron/fetch-greek-flow.ts`
- `api/_lib/analyze-prompts.ts` (1038 lines)
- `api/_lib/futures-context.ts`
- `api/_lib/lessons.ts`

---

## Appendix C — Open questions for a follow-up session

1. **What exactly is in the `journal` table schema?** Before implementing ENH-EDGE-001 and ENH-RISK-001, read `api/journal/` handlers and any related migrations to confirm the schema captures structure type, calculator-suggested credit, actual fill credit, P&L, close reason, and timestamp.
2. **What is the UW plan coverage for the Delta Flow endpoint?** Check the UW account tier before committing to ENH-FLOW-001.
3. **Is the Phase 2 ML ensemble currently emitting probabilities or only top-class predictions?** Read `ml/src/phase2_early.py` output format; may require model-output wrapper changes before ENH-SIGNAL-002 is wireable.
4. **What is the current realistic slippage baseline?** Pull the last 30 days of journal fills and compare against calculator-suggested credits to calibrate the ENH-EDGE-002 default haircut.
5. **What feature vector should the regime fingerprint in ENH-EDGE-001 use, exactly?** The fingerprint needs to match the feature buckets in `build-features-phase2.ts` for cohort-ML consistency. Read that file before finalizing the fingerprint schema.
6. **Does the audit's FE-STATE-001 (`isStale` flag) need to ship before any of these?** If stale market data can leak into the analyze context without warning, every signal in this spec is unreliable when data is stale. Consider sequencing FE-STATE-001 as a Phase 0 prerequisite.

---

_End of spec._
