# Principal Engineer Audit — 2026-04-07

Comprehensive review of the strike-calculator stack (frontend, backend, sidecar, ML pipeline) through the lens of a principal quant engineer. Captured as a reference document for incremental fixing.

---

## How to use this document

- Each finding has a stable ID (e.g. `BE-CRON-001`). Reference these in commits and PRs so we can cross-link work back to the audit.
- Findings are grouped by component, then ordered roughly by severity within each section.
- Severity reflects production-trading impact, not code aesthetics.
- "Verification" tells you whether I read the file directly, or whether the finding came from a parallel sub-agent. Trust direct reads more.
- "Status: open" means nothing has been fixed yet. Update to `fixed (commit-sha)` as we work through them.
- The "What's working well" section exists so we don't regress good patterns when refactoring.

### Severity legend

| Severity | Meaning |
|---|---|
| **Critical** | Silent data corruption, broken alerts, or wrong P&L on real trades. Fix before next live use. |
| **High** | Wrong-but-not-silent behavior, edge-case failures that will bite under stress, or correctness gaps that will eventually cause Critical incidents. Fix this week. |
| **Medium** | Code smells, brittle patterns, or design debt that will cause real bugs in future refactors. Fix opportunistically. |
| **Low** | Style, documentation, or "would be nicer if". Fix when adjacent code is already being touched. |

### Verification legend

| Verification | Meaning |
|---|---|
| `direct-read` | I personally read the file with `Read` and verified the finding line-by-line. |
| `agent-verified` | A parallel sub-agent flagged this; I cross-checked the file or surrounding context and confirmed it. |
| `agent-only` | A sub-agent flagged it but I did not personally re-verify. Treat with mild skepticism — verify before fixing. |

---

## Methodology

1. **Four parallel deep-dive agents** dispatched for: ML pipeline, sidecar (Python), backend (api/), and frontend (src/).
2. **Direct file reads** by me on every quant-critical math file and on every claim that sounded like it might be a hallucination. Files I read directly:
   - `src/utils/black-scholes.ts`
   - `src/utils/strikes.ts`
   - `src/utils/iron-condor.ts`
   - `src/utils/bwb.ts`
   - `src/utils/hedge.ts`
   - `src/utils/pin-risk.ts`
   - `src/utils/settlement.ts`
   - `src/utils/gex-migration.ts`
   - `src/utils/time.ts`
   - `src/utils/csvParser.ts` (turned out to be VIX OHLC, not positions)
   - `src/hooks/useCalculation.ts`
   - `api/_lib/darkpool.ts`
   - `api/_lib/csv-parser.ts` (the actual TOS positions parser)
   - `api/cron/build-features.ts` (lines 250-260)
3. **Several agent claims were hallucinations** and have been removed from this report (e.g., one agent claimed iron-condor.ts had `adjustedPoP = basePutSigma + baseCallSigma - basePoP` — that line does not exist, the actual code is correct; another claimed the call BWB max profit was `netCredit` instead of `narrowWidth + netCredit` — also fabricated). Findings here have been filtered against direct reads.

---

# Part 1 — Frontend quant math (`src/utils/`)

## What I verified is correct (do not regress)

- **`black-scholes.ts:12-194`** — Abramowitz & Stegun 26.2.17 normal CDF (|err|<7.5e-8). All Greeks (delta, gamma, vega, theta) derived correctly under r=0, q=0. Edge guards on `T<=0 || sigma<=0 || strike<=0 || spot<=0`. Theta returns annual; per-hour conversion is `MARKET.ANNUAL_TRADING_HOURS = 1638`.
- **`strikes.ts:85-125`** — Includes the log-normal `(σ²/2)·T` drift correction in strike placement. Most retail tools omit this.
- **`strikes.ts:46-67`** — Convex put skew (`(z/z_ref)^1.35`) and dampened call skew. Empirically defensible curve shape for the SPX smile.
- **`iron-condor.ts:85-113`** — `calcPoP` uses `P(S>BE_low) + P(S<BE_high) − 1`, which is the correct inclusion-exclusion form. Many calculators incorrectly multiply per-side PoPs.
- **`iron-condor.ts:41-68`** — `adjustICPoPForKurtosis` inflates each tail independently using the appropriate side's kurtosis factor (crash for puts, rally for calls). This is materially better than a symmetric haircut.
- **`bwb.ts:70-73, 199-203, 275-288`** — BWB max profit `narrowWidth + netCredit` and max loss `wideWidth − narrowWidth − netCredit` are both derivation-correct for both put and call BWBs. The closed-form payoff in `bwbPnLAtExpiry()` checks out by hand.
- **`hedge.ts:46-145`** — Hedge scenario engine values legs at `tHedgeEod = (hedgeDte−1)/252` with stress-shifted IV via `stressedSigma()`. This correctly captures the residual extrinsic value of a 7-DTE hedge sold to close at EOD and is meaningfully better than intrinsic-only valuation.
- **`hedge.ts:317-334`** — Vega aggregation correctly converts BS vega-per-1.0σ to per-1-vol-point and scales by SPX multiplier × contracts.
- **`gex-migration.ts:126-130`** — `pctChange()` uses `|past|` in the denominator so a sign flip from negative to positive yields a positive percent change rather than a sign-flipped one. Subtle but correct.

## Findings

### FE-MATH-001 — Pin-risk strike ranking ignores proximity to spot

- **Severity:** Medium
- **Verification:** direct-read
- **File:** `src/utils/pin-risk.ts:16-53`
- **Issue:** `getTopOIStrikes()` sorts globally by `totalOI` and slices the top N. A 50-point-OTM strike with 10K OI displaces an ATM strike with 5K OI in the top list, even though the ATM strike is what actually pins.
- **Impact:** Pin risk is a function of `(OI, |strike - spot|, T)`. By ignoring proximity, the panel misranks strikes during the most critical phase of 0DTE. Both the `PinRiskAnalysis` UI banner and the Claude analyze context via `useAnalysisContext` were silently dropping near-spot pin candidates that ranked below the global top-N.
- **Status:** fixed 2026-04-07
- **Implementation:** Surgical union approach — `getTopOIStrikes()` now returns `(top N by OI) ∪ (strikes within pinProximityPct of spot)`, deduplicated and sorted by OI descending. Meaning of "top by OI" is preserved; the result can exceed `topN` when a near-spot strike ranks outside the global top-N. Shared constant `PIN_ZONE_PCT = 0.005` (0.5%) exported from `pin-risk.ts` and consumed by `PinRiskAnalysis.tsx` so the inclusion logic and UI styling always use the same threshold. Escape hatch: pass `pinProximityPct = 0` for strict top-N-by-OI behavior. New tests cover near-spot inclusion, dedup when already in top-N, custom threshold, escape hatch, spot-exactly-at-strike, and `spot = 0` guard.

### FE-MATH-002 — Pin-risk OI is overwritten, not summed

- **Severity:** Medium (latent bug; harmless today)
- **Verification:** direct-read
- **File:** `src/utils/pin-risk.ts:24-32`
- **Issue:**

  ```ts
  for (const p of puts) {
    const entry = oiMap.get(p.strike) ?? { putOI: 0, callOI: 0 };
    entry.putOI = p.oi;            // assignment, not +=
    oiMap.set(p.strike, entry);
  }
  ```

- **Impact:** Within a single SPX expiry there is exactly one put per strike, so this works today. The day this function ever sees multi-expiry data (or a duplicate row from a cron retry), only the last row's OI is kept and the rest are silently dropped.
- **Status:** fixed 2026-04-07
- **Implementation:** Changed `entry.putOI = p.oi` → `entry.putOI += p.oi` and the equivalent for the call loop. Three defensive tests added (puts-only, calls-only, and mixed same-strike accumulation) so any future regression is caught even though `ChainResponse`'s single-expiry contract means it cannot fire today. Fixed in the same commit as FE-MATH-001 since both live in `pin-risk.ts`.

### FE-MATH-003 — Settlement breach window has off-by-one ambiguity in `entryIndex`

- **Severity:** Medium
- **Verification:** direct-read
- **File:** `src/utils/settlement.ts:20-24`
- **Issue:**

  ```ts
  for (let i = entryIndex; i < allCandles.length; i++) {
    if (c.high > remainingHigh) remainingHigh = c.high;
    if (c.low < remainingLow) remainingLow = c.low;
  }
  ```

  The loop **includes** the entry candle's high/low. Whether this is correct depends on what `entryIndex` means semantically — and that's not documented. If the entry was at the close of the entry candle, the high/low of that candle were reachable *before* entry and should not count as breaches. If `entryIndex` is "first candle after entry", the loop is correct.
- **Impact:** On knife-edge breaches near the entry bar, this can flip `survived` true→false or false→true. The bias is roughly ~5% on the entry bar alone. Verified during fix: `useHistoryData.getStateAtTime` sets `spot = candle.close` and `computeRunningOHLC` iterates `0..=endIdx` (entry candle in pre-entry OHLC). The old settlement loop double-counted the entry candle as both pre- and post-entry.
- **Status:** fixed 2026-04-07
- **Implementation:** Interpretation A (exclude entry candle from breach scan). Loop changed to `i = entryIndex + 1`. Thorough JSDoc added explaining the entry convention (spot = close of entryIndex candle → entry candle's high/low are pre-entry) and the `useHistoryData` consistency argument. The same fix applied to the parallel loop in `scripts/entry-time-analysis.ts:193` with a comment referencing this finding. Tests: renamed the existing "from entryIndex onward" test to "strictly after entryIndex" with updated data, added two new FE-MATH-003 tests (one wild-wick false-breach case, one sanity check), and updated three fixture-dependent tests in `SettlementCheck.test.tsx` (`remainingLow` 5805→5808, `ranged 25 pts`→`22 pts`, `Put breached by 15 pts`→`12 pts`, 15Δ putCushion display −45→−48) with inline comments explaining the origin. Consolidated the duplicate `src/__tests__/settlement.test.ts` into the keeper at `src/__tests__/utils/settlement.test.ts` (all unique tests ported including `makeCandleSeries` helper; minor coverage gap on strike-passthrough assertion filled with a new dedicated test).

### FE-MATH-004 — BWB does not validate `wideWidth > narrowWidth`

- **Severity:** Low (not reachable from production UI — `BWB_WIDE_MULTIPLIERS = [1.5, 2, 2.5, 3]` in `src/constants/index.ts` constrains `wideWidth >= 1.5 * narrowWidth`; this is defensive API hardening for direct callers)
- **Verification:** direct-read
- **File:** `src/utils/bwb.ts:33-72, 162-203`
- **Issue:** Both `buildPutBWB` and `buildCallBWB` computed `maxLoss = wideWidth − narrowWidth − netCredit`. For a symmetric butterfly (`wide = narrow`) or inverted structure (`wide < narrow`) with positive `netCredit`, that formula returns a negative value. The field flows into `BWBPnLProfileTable.tsx:183` which displays it directly in a red "Max Loss" cell, so a bad call would render as `-$X` — visually nonsense. The `returnOnRisk` calculation at `bwb.ts:74` was already guarded with `maxLoss > 0 ? ... : 0`, so no cascading failure, but the `maxLoss` field itself was dishonest.
- **Status:** fixed 2026-04-07
- **Implementation:** Clamp, not hard validation. Changed `maxLoss = wideWidth - narrowWidth - netCredit` to `maxLoss = Math.max(0, wideWidth - narrowWidth - netCredit)` in both functions. The audit's original "throw error if wide <= narrow" approach was rejected because existing tests at `bwb.test.ts:499` deliberately exercise the symmetric butterfly case and expect a valid return. The clamp is semantically correct (for symmetric/inverted + credit structures the deep-wing payoff is `narrow - wide + netCredit ≥ 0`, so the trade literally cannot lose — `maxLoss = 0` is the honest answer), mirrors the existing `returnOnRisk > 0` guard pattern, and doesn't break any existing tests. Added 4 new pinning tests (symmetric put, symmetric call, inverted, standard sanity check) and cleaned up 2 pre-existing tests whose stale comments described the old math. The second BWB implementation at `src/components/BWBCalculator/bwb-math.ts` uses a different field (`riskPnl`, a signed directional P&L rather than a scalar max-loss) and is correctly unaffected.

### FE-MATH-005 — Iron condor max loss has no negative-width guard

- **Severity:** Low (not reachable from production UI — `WING_OPTIONS = [5, 10, 15, 20, 25, 30, 50]` in `src/constants/index.ts` constrains all wing widths to strictly positive integers; this is defensive API hardening for direct callers)
- **Verification:** direct-read
- **File:** `src/utils/iron-condor.ts:200, 218, 231` (combined + per-side max losses)
- **Issue:** Three fields computed as `wingWidthSpx - <credit>` without clamping. A negative `wingWidthSpx` would invert the spread structure (longPut > shortPut, longCall < shortCall) and produce negative max-loss values, which `BWBPnLProfileTable`-style display paths would render as "-$X" in the red Max Loss cells. The code already had `maxLoss > 0 ? ... : 0` guards on the three `returnOnRisk` computations at lines 204, 221, 234 — so the existing code anticipated the `maxLoss <= 0` case for RoR but didn't clamp the raw `maxLoss` fields themselves.
- **Status:** fixed 2026-04-07
- **Implementation:** Same clamp pattern as FE-MATH-004, mirrored across three fields: `maxLoss`, `putSpreadMaxLoss`, and `callSpreadMaxLoss` all wrapped in `Math.max(0, ...)`. The first comment carries the full explanation (WING_OPTIONS constraint, the `wingWidth === 0` existing test, the negative-wingWidth hypothetical, and the display-cell honesty concern); the two per-side clamps have terse pointer comments to avoid DRY violation. Added 3 tests: extended the existing `handles zero-width spreads gracefully` test with `>= 0` assertions on all three fields, added a negative-wingWidth pinning test that would have failed under the old code, and added a standard-wingWidth sanity test that asserts the clamp is inert for normal inputs via strict-formula equality on all three fields (filling a pre-existing coverage gap where per-side maxLoss fields had no strict-formula assertion).

### FE-MATH-006 — `calcThetaCurve` is anchored to a fixed 6.5h day

- **Severity:** Low
- **Verification:** direct-read
- **File:** `src/utils/iron-condor.ts:308-351` plus `src/components/ThetaDecayChart.tsx`
- **Issue:** The function uses `[6.5, 6, 5.5, ..., 0.5]` as the hours-remaining grid and `calcTimeToExpiry(6.5)` as the reference open premium. Investigation also revealed that the consuming `ThetaDecayChart` component had hardcoded 6.5/16 references in its `xScale`, `interpolatePremium`, `formatETRange`, and `showNow` logic, so a half-day-aware curve would have been rendered against a normal-day chart scale anyway. The fix needed to plumb `marketHours` end-to-end.
- **Status:** fixed 2026-04-07
- **Implementation:** Added optional `marketHours: number = 6.5` parameter to `calcThetaCurve`. Grid is now built dynamically via `for (let h = marketHours; h >= 0.5; h -= 0.5)` — produces 13 entries for a normal day, 7 for a half-day. Reference open premium uses `calcTimeToExpiry(marketHours)`. `useCalculation` now exposes `marketHours = closeHourET - 9.5` (NYSE always opens at 9:30 ET) on the `CalculationResults` type, derived from the existing `earlyCloseHourET` parameter that App.tsx already passes (see FE-STATE-005 below). `ThetaDecayChart` accepts a `marketHours?: number` prop (default 6.5), passes it to `calcThetaCurve`, and uses it in `xScale`, `interpolatePremium`, the new `OPEN_HOUR_ET = 9.5` constant in `formatETRange`, and the `showNow` upper bound. `AdvancedSection` reads `results.marketHours` and passes it down. New tests: 5 in `iron-condor.test.ts` (default 6.5 grid, half-day 3.5 grid, half-day still 100% at open, half-day covers strictly shorter range, empty for `marketHours <= 0.5`) and 4 in `ThetaDecayChart.test.tsx` (default scale, half-day clamps now-marker, half-day shows now-marker in range, half-day entry-window label uses 1 PM close). Bonus: while implementing the new `isHalfDay` helper for CROSS-003, discovered and fixed a stale data entry — `2026-07-03` was listed in both `EARLY_CLOSE_DATES` and `MARKET_CLOSED_DATES`. July 4, 2026 is a Saturday, so July 3 is the observed Independence Day full closure, not a half-day. Removed the bad entry, made `isHalfDay` defensively short-circuit on holidays, and added a regression test.

### FE-MATH-006-bonus — CROSS-003 calendar helpers

- **Severity:** Low
- **Status:** fully done 2026-04-07 (two commits)
- **Implementation (commit 1):** Added `isHoliday(date)`, `isHalfDay(date)`, and `isTradingDay(date)` named convenience helpers to `src/data/marketHours.ts`. The data already existed (2025-2026 calendar) and was already being consumed by both frontend (`App.tsx:181`, `useHistoryData.ts`, etc.) and backend (`api/_lib/api-helpers.ts:27` cross-imports the same module). The new helpers are 1-2 line wrappers around the existing `MARKET_CLOSED_DATES` and `EARLY_CLOSE_DATES` data structures, plus a UTC-noon weekday check for `isTradingDay`. 10 new tests added to `marketHours.test.ts`.
- **Implementation (commit 2):** Added the fourth helper: `currentSessionStage(now?: Date): SessionStage` classifies any instant into one of 10 stages (`pre-market`, `opening-range`, `credit-spreads`, `directional`, `bwb`, `late-bwb`, `flat`, `post-close`, `half-day`, `closed`) matching the user's 5-phase intraday workflow from `user_trading_schedule.md`. Refactored the existing `src/components/TradingScheduleSection` component to consume the helper, dropping three local helpers that carried latent bugs: (a) a local `isTradingDay()` that only checked Mon-Fri (showed the Active badge on MLK Day at the right CT time), (b) a local `getCTMinutes()` that used the `new Date(toLocaleString(...))` anti-pattern, and (c) no half-day awareness. The refactor preserves all 15 existing behavior tests and adds 2 new tests asserting no Active badge on MLK Day + Black Friday (latent bug exposure). Also added `ACTIVE_SESSION_STAGES` readonly set with a runtime assertion test to keep the 5 active stages in sync with the component's `PHASES` array. 25 new tests in `marketHours.test.ts`.
- **Location decision:** The audit asked for `api/_lib/market-calendar.ts`. I put everything in `src/data/marketHours.ts` instead because `api/_lib/api-helpers.ts:27` already cross-imports from that file — adding a separate backend file would duplicate the data. This is a pragmatic single-source-of-truth choice.

### FE-MATH-007 — `DELTA_Z_SCORES` is a discrete map with no interpolation

- **Severity:** Low
- **Verification:** direct-read
- **File:** `src/utils/strikes.ts:93-96` and `src/constants/index.ts` (DELTA_Z_SCORES definition)
- **Issue:** `calcStrikes` errors out if the requested delta is not in `{5, 8, 10, 12, 15, 20}`. Today the UI only exposes those exact deltas, so it never fires; but it's a fragile API surface for any future "custom delta" feature.
- **Status:** resolved 2026-04-07 (scope-reduced)
- **Implementation:** The audit's literal prescription was "add linear interpolation", but verification revealed the bug is TypeScript-unreachable by design: `DeltaTarget` is a literal union (`5 | 8 | 10 | 12 | 15 | 20`), `calcStrikes` requires `delta: DeltaTarget`, and the only runtime iterator is `DELTA_OPTIONS: readonly DeltaTarget[]`. The only test hitting the error path uses `@ts-expect-error` to deliberately bypass the compiler. Widening `DeltaTarget` to `number` would touch ~15 consumer files to support a speculative "custom delta" feature that doesn't exist — violating CLAUDE.md's "don't design for hypothetical future requirements" rule. **Scope-reduced** to 3 invariant tests in `strikes.test.ts` that pin the real drift concern: (1) every `DELTA_OPTIONS` entry has a finite positive z-score, (2) every `DELTA_Z_SCORES` key appears in `DELTA_OPTIONS`, and (3) z-scores are monotonically decreasing with delta (non-trivial — the monotonicity invariant is NOT captured by any type and directly protects the `calcScaledSkew` math). If a future "custom delta" feature is ever added, that feature's PR can widen the type and add interpolation as part of its own scope. **No production code changed in this commit.**

### FE-MATH-008 — Hedge time-decay mixes trading-day T with calendar-time decay

- **Severity:** Low
- **Verification:** direct-read
- **File:** `src/utils/hedge.ts:231, 249`
- **Issue:** `tHedgeEntry = hedgeDte / TRADING_DAYS_PER_YEAR` counts trading days only. But the hedge is held overnight (calendar days) and sold at next-day EOD. The arithmetic is mixing trading-day T with calendar-day holding.
- **Impact:** ~10% understatement of theta on a 7-day hedge. Accumulates across the scenario table.
- **Fix:** Either (a) use calendar days consistently, or (b) document explicitly that trading-day annualization is intentional and accept the bias. The first is more defensible.
- **Status:** open

### FE-MATH-009 — Hedge `BREAKEVEN_TARGET = 1.5×` is a fixed coverage ratio

- **Severity:** Low (design)
- **Verification:** direct-read
- **File:** `src/utils/hedge.ts:261-262`
- **Issue:** The 1.5× target is reasonable as a heuristic but has no link to the IC's actual max loss vs hedge cost. For a 5-wide IC at $2 credit (max loss $300/contract) the 1.5× target is conservative; for a 20-wide IC at $4 credit (max loss $1600/contract) it's aggressive.
- **Fix:** Auto-tune the target so scenario crash P&L crosses zero at exactly `(distance to short strike + 1×ATR)`. Or expose as a UI input.
- **Status:** open

---

# Part 2 — Frontend state and data flow (`src/hooks/`)

## What's working well (do not regress)

- **`src/utils/timezone.ts`** uses `Intl.DateTimeFormat.formatToParts()` — the correct way to do TZ math in JS.
- **`useGexPerStrike` scrub feature** — navigates server-cached snapshots without re-fetching. Right pattern.
- **`useMarketData` parallel fetches** with independent error handling — one failure does not block the others.
- **GEX migration `pctChange`** uses `|past|` in the denominator (avoids sign-flip on negative→positive transitions).

## Findings

### FE-STATE-001 — No "data staleness" badge anywhere in the UI

- **Severity:** High
- **Verification:** direct-read
- **File:** `src/hooks/useMarketData.ts`
- **Issue:** The hook tracks `lastUpdated` but never exposes a derived `isStale` flag. If Schwab returns 200 with cached or stale ticks (or if the network hiccups silently), the calculator keeps pricing against the old quote with no warning.
- **Impact:** For a 0DTE live-trading tool this is a real footgun. Pricing a hedge against 4-minute-old data during a vol spike can flip the verdict.
- **Fix:** Compute `isStale = (Date.now() - lastUpdated) > 90_000` during market hours. Surface in the header with a yellow/red pill. Optionally pause polling-dependent calculations.
- **Status:** open

### FE-STATE-002 — `marketOpen` is binary; pre-market and after-hours data are blocked

- **Severity:** Medium
- **Verification:** direct-read
- **File:** `src/hooks/useMarketData.ts:122-163` (approximate; gating logic)
- **Issue:** Polling stops entirely when `marketOpen=false`. Pre-market quotes (which Schwab serves) are blocked. For your 8:30 CT prep workflow, you can't see the tape without manually seeding.
- **Fix:** Tri-state session: `pre-market | regular | after-hours | closed`. Continue polling the underlier in pre-market and after-hours, but mark the data with a session tag.
- **Status:** open

### FE-STATE-003 — `useCalculation` recomputes `h24` and `totalMinutes` twice

- **Severity:** Low (DRY violation; latent regression risk)
- **Verification:** direct-read
- **File:** `src/hooks/useCalculation.ts:50-70` and `:106-112`
- **Issue:** The validation block and the computation block duplicate the same time math. If you ever change one, you have to remember to change the other.
- **Fix:** Extract into a single helper that returns `{ valid, hoursRemaining, error }`.
- **Status:** open

### FE-STATE-004 — CT→ET conversion is naïve `+1` (works by accident)

- **Severity:** Low
- **Verification:** direct-read
- **File:** `src/utils/time.ts:131-135`, `src/hooks/useCalculation.ts:55-57`
- **Issue:** `if (timezone === 'CT') h24 += 1`. Both ET and CT observe the same DST rule, so the offset is always exactly 1 hour. The code is correct *by accident*. The day someone adds MT/PT, or there's a quote at the moment of a DST transition, it breaks.
- **Fix:** Use a TZ-aware formatter (which already exists in `src/utils/timezone.ts`) instead of arithmetic on hours.
- **Status:** open

### FE-STATE-005 — Half-day handling is silent on input mismatch

- **Severity:** ~~Medium~~ — finding was based on incomplete read; verified already-implemented
- **Verification:** direct-read
- **File:** `src/hooks/useCalculation.ts:62-70, 110-116`
- **Issue:** On half-days the user passes `earlyCloseHourET=13`. If they forget and enter time as 2:00 PM ET, the calculator computes `hoursRemaining=2` against a 4 PM close — producing plausible-looking but wrong Greeks. There's nothing in the codebase that knows today is a half-day.
- **Status:** already implemented (verified 2026-04-07)
- **Verification details:** `useCalculation` accepts `earlyCloseHourET` as a parameter (line 29) and uses it for both validation (`closeMinutes` at line 110) and the post-validation error message ("After market close; use before 1:00 PM ET" at line 65-68). The auto-derivation happens one layer up at `src/App.tsx:181`, which calls `getEarlyCloseHourET(vix.selectedDate)` and passes the result. The import is at `App.tsx:29`. The 2025-2026 holiday calendar already exists in `src/data/marketHours.ts` with both `EARLY_CLOSE_DATES` and `MARKET_CLOSED_DATES`. So the entire chain (date → calendar lookup → close hour → hoursRemaining → validation error message) is already in place. The audit's claim that "the user has to manually flag half-days" was wrong — based on a partial read of `useCalculation.ts` that only saw the parameter declaration, not the call site at App.tsx:181. The audit's prescribed fix ("MARKET_HOLIDAYS_2026 constant + auto-detection") was already done before the audit was written. Lesson: this is exactly why the verify-first discipline matters — a fresh read of every consumer would have caught this.

### FE-STATE-006 — Polling crons are gated on `marketOpen` but no portfolio-level risk gate exists

- **Severity:** Medium (operational risk, not code bug)
- **Verification:** direct-read (architectural)
- **File:** N/A — gap
- **Issue:** Nothing in the frontend tracks aggregate open-position risk. You can stack multiple ICs and BWBs whose combined max-loss exceeds your account drawdown tolerance. The risk-tier UI shows per-position percentages but never sums them.
- **Fix:** Add a derived `aggregatePortfolioRisk` in `useAppState` that sums max losses across all open positions (from the parsed CSV) and shows a warning if the total exceeds a configurable threshold (say 10-15%).
- **Status:** open

---

# Part 3 — Schwab/TOS positions parser (server side)

This is the file your `project_positions_context_gap.md` memory was about.

## What's working well

- **`api/_lib/csv-parser.ts:616-747`** — `buildOpenSpreadsFromTrades()` builds open spreads from the trade history (grouped by `execTime`) rather than from the flattened Options section. This is the right answer to the "shared long strike" problem.
- **`csv-parser.ts:651-685`** — Explicitly handles 3-leg butterflies and BWBs from the trade history, including labeling them as `BFLY` vs `BWB` based on wing symmetry.
- **`csv-parser.ts:583-590`** — Max risk computation correctly notes "only one side of an IC can be max loss — calls and puts cannot both be ITM simultaneously."

## Findings

### CSV-001 — Trade-grouping uses exact `execTime` string equality

- **Severity:** High
- **Verification:** direct-read
- **File:** `api/_lib/csv-parser.ts:637-642`
- **Issue:**

  ```ts
  for (const t of allTrades) {
    const existing = tradesByTime.get(t.execTime) ?? [];
    existing.push(t);
    tradesByTime.set(t.execTime, existing);
  }
  ```

  If TOS ever logs two legs of one vertical at sub-second offsets (e.g., `09:31:42.110` vs `09:31:42.140`), they fall into separate single-leg buckets and get reported as naked. This is the most likely path back to the "Claude misreads positions as naked" bug.
- **Fix:** Group by ±1-second window, not exact string equality. Sort all trades by execTime, then walk and bucket any trades within 1 second of the previous one.
- **Status:** open

### CSV-002 — 50-point spread cap is hardcoded in three places

- **Severity:** Medium
- **Verification:** direct-read
- **File:** `api/_lib/csv-parser.ts:311, 777, 837`
- **Issue:** All three sites use `if (width > 0 && width <= 50)`. Wider hedges (e.g., 100-pt put spreads as crash protection) get silently dropped from "spread" recognition and re-classified as naked legs.
- **Fix:** Lift the cap to 200 points, or make it a constant in `api/_lib/constants.ts` and reference it in all three places.
- **Status:** open

### CSV-003 — Closed-spread matching uses `findIndex` first match

- **Severity:** Medium
- **Verification:** direct-read
- **File:** `api/_lib/csv-parser.ts:328-342`
- **Issue:** If you opened two identical PCS at different times and only closed one, the matcher may mark the wrong one closed. Identical legs are not distinguishable by attributes alone.
- **Fix:** Match by `(strike, putCall, openTime)` ordering, preferring the earliest open that hasn't been matched yet.
- **Status:** open

### CSV-004 — `parseStartingBalance` and `parsePnLSection` use `startsWith` checks against TOS-specific labels

- **Severity:** Low (TOS schema brittleness)
- **Verification:** direct-read
- **File:** `api/_lib/csv-parser.ts:381-420`
- **Issue:** Hardcoded matches against `'SPX,'` (line 382), `'Net Liquidating Value,'` (line 399), and `'Cash balance at the start of business day'` (line 410). If TOS ever changes their export format, these silently return null.
- **Fix:** Add a unit test that loads a sample CSV fixture and asserts these fields parse correctly. Re-run the test against any new TOS export format.
- **Status:** open

---

# Part 4 — Backend API and crons (`api/`)

## What's working well

- **Idempotent UPSERTs** consistently across crons (`ON CONFLICT DO NOTHING / DO UPDATE`).
- **Streaming keepalive** in `api/analyze.ts` — sending `{"ping":true}\n` every 30s during long Opus calls is the right defense against proxy idle disconnects.
- **Opus → Sonnet fallback** with the cheaper-model `max_tokens` reduced to 64k.
- **Stream-corruption 502** to trigger client retry rather than rendering broken JSON.
- **Owner gating** uses `timingSafeEqual` — no timing attack surface on the secret.
- **Parallel context fetching** in `analyze-context.ts` — 15+ data sources via `Promise.all`.
- **Exponential backoff** consistent across `withRetry()`, Schwab token refresh, Anthropic calls.
- **Anthropic prompt caching** with split system prompt + `cache_control: ephemeral`.
- **Per-cron data quality counters** (`checkDataQuality()` in `fetch-flow.ts`, `fetch-gex-0dte.ts`).

## Findings

### BE-DARKPOOL-001 — Dark pool ingestion does not filter `contingent_trade` prints

- **Severity:** Critical
- **Verification:** direct-read
- **File:** `api/_lib/darkpool.ts:96-104, 182-191`
- **Issue:** Your `feedback_contingent_trade_filter.md` memory says contingent_trade prints (pre-arranged swap resets) distort the volume profile and should be dropped. The current filter chain is:

  ```ts
  !t.canceled &&
  !t.ext_hour_sold_codes &&                          // ✓ kills extended-hours
  (t.trade_settlement === 'regular' || ...) &&      // ✓ kills delayed settlement
  t.sale_cond_codes !== 'average_price_trade' &&    // ✓
  t.trade_code !== 'derivative_priced'               // ✓
  ```

  No `contingent_trade` exclusion.
- **Impact:** Contingent prints leak into `clusterDarkPoolTrades` and `aggregateDarkPoolLevels`, biasing the institutional levels you ship to Claude.
- **Fix:** Add `t.sale_cond_codes !== 'contingent_trade'` (and any other related codes — verify against the UW API field reference) to both filter chains in `darkpool.ts`.
- **Status:** open

### BE-DARKPOOL-002 — Dark pool ingestion does not apply 08:30–15:00 CT intraday window

- **Severity:** Critical
- **Verification:** direct-read
- **File:** `api/_lib/darkpool.ts` (entire file — no time-of-day check anywhere)
- **Issue:** Your `feedback_extended_hours.md` memory says intraday analysis must be restricted to 08:30–15:00 CT. The `ext_hour_sold_codes` filter catches the *flagged* extended-hours trades, but not regular-session trades that fall outside 08:30–15:00 CT (e.g., 06:15 CT pre-open block prints with `ext_hour_sold_codes=null`).
- **Impact:** Pre-market and post-close institutional blocks contaminate the levels Claude sees and the volume profile your clustering uses.
- **Fix:** Add a helper:

  ```ts
  function isIntradayCT(executedAt: string): boolean {
    const ctParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', hour12: false,
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(executedAt));
    const h = +ctParts.find(p => p.type === 'hour')!.value;
    const m = +ctParts.find(p => p.type === 'minute')!.value;
    return (h * 60 + m) >= 510 && (h * 60 + m) < 900;
  }
  ```

  Apply in both `fetchDarkPoolBlocks` and `fetchAllDarkPoolTrades` filter chains.
- **Status:** open

### BE-CRON-001 — Schwab token refresh has only an in-memory in-flight lock

- **Severity:** High
- **Verification:** direct-read
- **File:** `api/_lib/schwab.ts`
- **Original framing:** The `refreshInFlight` Promise serializes within one Vercel function instance. Across instances (which is what happens during a market-open burst when 4-6 crons fire simultaneously), every instance does its own refresh and races to write the new token to Redis. Last writer wins and others may hold stale tokens.
- **Investigation (2026-04-09):** The audit's original claim was outdated. Direct read of `api/_lib/schwab.ts` showed the Redis SET-NX lock (`acquireLock`/`releaseLock`/`waitForLockRelease` helpers + integration into `refreshAccessTokenOnce`) had already been implemented in a prior session — the audit doc was simply not updated. However, while tracing the existing lock code, a separate and real residual bug was found: **the loser path fell through to an unlocked refresh when post-wait stored tokens were still stale**. Scenario: winner A acquires lock, Schwab hangs longer than the 30s lock TTL, lock auto-expires, losing instances B/C/D all see an empty lock AND stale tokens in Redis, all fall through to call `refreshAccessToken()` in parallel. That re-created the thundering-herd scenario the lock was meant to prevent, just pushed into a narrower window.
- **Fix:** 2026-04-09 — Restructured `refreshAccessTokenOnce` into a bounded retry loop (`LOCK_MAX_ATTEMPTS = 3`). On lock win: refresh/store/release as before. On lock loss: wait, check stored tokens, and if still stale LOOP to re-acquire the lock. Only a lock holder ever issues a Schwab refresh request. If all 3 attempts fail to acquire or read fresh tokens, throws a clear exhaustion error which `getAccessToken` wraps as a `token_error` so the caller gets a loud failure rather than silent thundering herd. Added 2 regression tests: one that asserts Schwab's OAuth endpoint is called **exactly once** in the retry-on-stale case (fallthrough regression guard), and one that asserts `fetch` is **never called** in the all-attempts-fail case (ensures the loop cannot silently fall through).
- **Known deferred item:** The `releaseLock()` function uses `redis.del(LOCK_KEY)` without an ownership check, creating a classic "late releaser deletes new owner's lock" race. Window is `max(0, refresh_duration - 30s)` which is near-zero in practice (typical Schwab refresh: 1-2s, lock TTL: 30s). Fix requires EVAL Lua script through `@upstash/redis`; deferred as a separate session item. Also deferred: `acquireLock` returns `true` on exhausted Redis errors (line 176), which causes the "winner" branch to run without actually holding the lock during a Redis outage — pre-existing behavior, accepts the trade-off that a Redis outage shouldn't cascade into auth failures.
- **Status:** fixed 2026-04-09 — fallthrough thundering-herd path closed; lock ownership race and Redis-outage proceed-without-lock behavior both acknowledged as narrower follow-up items.

### BE-CRON-002 — Multiple crons run `* 13-21 * * 1-5` (every minute) with no rate-limit headroom

- **Severity:** ~~High~~ — **downgraded to Low / won't fix** after direct call counting
- **Verification:** agent-verified (Wave 2), then direct-read call counting (2026-04-08)
- **File:** `vercel.json`
- **Audit claim:** 4-6 crons fire every minute and collectively risk UW's 120/min rate limit. Only kept safe by some crons short-circuiting early.
- **Reality on direct verification:** Per-cron UW call counts were never actually measured in the audit. After counting `uwFetch(` call sites in every cron and reading the bodies:
  - **Steady-state UW calls per minute:** 6 calls from the per-minute crons (`fetch-gex-0dte`, `fetch-spx-candles-1m`, `fetch-vol-0dte`, `monitor-iv`, `monitor-flow-ratio`, `fetch-darkpool` — all 1 call each).
  - **Worst-case minute** (top of a :05 tick): 6 per-minute + lane 0 (`fetch-flow` = 2 calls, `fetch-greek-exposure` = 2 calls) = **10 calls / 120 allowed = 8.3% of budget**.
  - **Only edge case**: `fetch-darkpool`'s first run of the trading day paginates the full SPY dark pool tape. `api/_lib/darkpool.ts:120-195` caps this at `maxPages = 100` with an internal 600ms sleep between pages, self-rate-limiting to ~1.67 calls/sec ≈ ~100 calls spread across 60 seconds. Combined with the other 5 per-minute crons = ~105 calls in that one minute, still under 120. Comment at `darkpool.ts:193` explicitly calls out the 120/60s limit — pagination was designed with the budget in mind.
- **User constraint (2026-04-08):** User confirmed `monitor-iv`, `monitor-flow-ratio`, and `fetch-darkpool` all need per-minute cadence — `fetch-darkpool` specifically because the frontend polls every 60s. Frequency reduction is off the table.
- **Cron scheduling cannot fix this even if there were a burst risk:** Vercel cron is minute-granular. Every cron scheduled as `* 13-21 * * 1-5` fires at minute :00 of every minute. You cannot offset within a minute — the only scheduling lever is frequency.
- **Status:** **won't fix 2026-04-08** — the premise (risk of breach) was speculation that turned out to be wrong. Actual utilization is ~8% of budget. Headroom is ~110 calls/min for future features.
- **Observability follow-up landed:** Added `metrics.uwRateLimit(endpoint, retryAfter)` helper in `api/_lib/sentry.ts` and wired `uwFetch` to call it on any 429 response. Emits both a time-series metric counter (`uw.rate_limited` tagged by endpoint) and a scoped warning `captureMessage` so the first 429 in production pages immediately instead of waiting for data to silently thin. Tests pin the emission path: `api/__tests__/api-helpers.test.ts` covers 429-with-retry-after, 429-without-retry-after, and the non-429 negative path. Not fixing a real problem — just guaranteeing visibility if the problem ever materializes.

### BE-CRON-003 — Hardcoded `-05:00` in `build-features.ts` (downgraded from agent's "critical")

- **Severity:** Low (code smell, not currently a bug)
- **Verification:** direct-read
- **File:** `api/cron/build-features.ts:252-253`
- **Issue:**

  ```ts
  const d = new Date(`${dateStr}T12:00:00-05:00`);
  const dow = ... d.getDay();
  ```

  An agent flagged this as Critical. I verified directly: noon ET → 17:00 UTC during EST or 16:00 UTC during EDT, both fall on the same calendar day, so `getDay()` returns the correct weekday on Vercel-UTC servers. The hardcoded `-05:00` is misleading but currently harmless.
- **Impact:** None today. Will silently break the day a future maintainer changes the literal time-of-day or runs the build under a non-UTC TZ.
- **Fix:** Replace with the existing TZ-aware day-of-week helper in `src/utils/timezone.ts` (or add an equivalent in `api/_lib/`).
- **Status:** open

### BE-CRON-004 — `monitor-iv.ts` SPX-price fallback returns null unconditionally

- **Severity:** High
- **Verification:** agent-verified
- **File:** `api/cron/monitor-iv.ts:78-101` (approximate)
- **Issue:** The fallback path queries `flow_data` for `ncp` (net call premium) and then unconditionally `return null`. SPX price is never populated from the fallback.
- **Impact:** IV spike alerts ship with `priceMove='N/A'`, which loses the second condition of the "informed positioning" rule (IV spike + small price move).
- **Fix:** Query the actual price column. If `flow_data` doesn't have one, fall back to `market_snapshots.spx_price`.
- **Status:** open (verify file exists at this path before fixing)

### BE-CRON-005 — N+1 inserts in `fetch-gex-0dte.ts`

- **Severity:** Medium (performance, not correctness)
- **Verification:** agent-verified
- **File:** `api/cron/fetch-gex-0dte.ts:100-135` (approximate)
- **Issue:** `sql.transaction()` wraps `filtered.map(row => sql\`INSERT ...\`)`, issuing one statement per row. For ~150 strikes, that's 150 round-trips inside one transaction.
- **Impact:** ~5-7 seconds per cron invocation that could be ~200ms. Wastes Neon connection pool capacity.
- **Fix:** Switch to a single multi-row VALUES insert via `sql\`INSERT ... VALUES ${sql(rows)}\``.
- **Status:** open

### BE-CRON-006 — Backfill jobs silently drop out-of-bounds prices

- **Severity:** Medium
- **Verification:** agent-verified
- **File:** `api/cron/backfill-futures-gaps.ts` (approximate; price-bound check)
- **Issue:** Per-symbol price bounds (`{ ES: [1000, 20000], ... }`) reject rows with `continue` and no log. If Databento ever shifts a tick scale or has an outage, you get a quiet hole.
- **Impact:** Gaps in futures bars cascade into `fetch-futures-snapshot` (stale "day open") and into the build-features ML pipeline.
- **Fix:** (a) Log every dropped row with `logger.warn`. (b) Emit a `checkDataQuality` summary at the end of each backfill with fill rate.
- **Status:** open

### BE-CRON-007 — `fetch-flow.ts` partial-failure response is opaque

- **Severity:** Medium
- **Verification:** agent-verified
- **File:** `api/cron/fetch-flow.ts:50-80` (approximate)
- **Issue:** `Promise.allSettled` correctly tolerates one source failing, but the response doesn't indicate which one failed. Monitoring can't distinguish "1/2 sources succeeded" from "both succeeded, happened to get 1 row each."
- **Fix:** Return per-source status in the response object: `{ stored, sources: { allIn: { succeeded, count, reason }, otm: {...} } }`.
- **Status:** open

### BE-CRON-008 — `analyze.ts` does not validate image count or size

- **Severity:** Medium (cost / DoS)
- **Verification:** agent-verified
- **File:** `api/analyze.ts:79-82` (zod schema accepts unbounded image array)
- **Issue:** The schema parses images but does not enforce constraints. A malformed client could send 100 images and run up an Anthropic bill.
- **Fix:** Add `MAX_IMAGE_COUNT = 10`, `MAX_IMAGE_SIZE_BYTES = 2 * 1024 * 1024`, and a total-size cap. Validate before constructing the prompt.
- **Status:** open (lower priority for single-owner, but cheap to add)

### BE-CRON-009 — `fetch-outcomes.ts` lacks holiday gating in normal mode

- **Severity:** Medium
- **Verification:** agent-verified
- **File:** `api/cron/fetch-outcomes.ts` (approximate)
- **Issue:** Backfill mode has weekend-skip logic, but the normal-mode path will happily call Schwab `pricehistory` on a holiday and silently insert nothing.
- **Fix:** Add an `isTradingDay(today)` check before the main path. Build a `market-calendar.ts` helper that knows holidays.
- **Status:** open

### BE-CRON-010 — Migration #3 `ALTER COLUMN embedding TYPE vector(2000)` is destructive

- **Severity:** High (if not yet run on prod) / N/A (if already run successfully)
- **Verification:** direct-read
- **File:** `api/_lib/db-migrations.ts` (migration #3)
- **Issue:** Changing pgvector dimensionality is destructive — existing 3072-dim embeddings cannot be coerced to 2000-dim. If a deploy ran this migration while the app still generated 3072-dim embeddings, INSERTs would fail or silently truncate.
- **Investigation (2026-04-09):** Verified code is fully consistent at 2000 dims:
  - `api/_lib/embeddings.ts:53-55` generates 2000-dim vectors via OpenAI `text-embedding-3-large` with `dimensions: 2000` (matryoshka truncation).
  - `api/_lib/db-migrations.ts:80` now creates the `lessons.embedding` column as `vector(2000) NOT NULL` directly (migration #2). Fresh installs never go through the 3072 → 2000 resize path.
  - Migration #3 is therefore a no-op in Postgres on a fresh DB (ALTER to same type), and a legitimate resize only on legacy DBs that historically had the `vector(3072)` variant of migration #2.
  - The "silent INSERT truncation" scenario in the audit's original framing is inaccurate — pgvector raises a hard error when shrinking a column with incompatible data; it does NOT silently truncate. Such a failure would block deploy loudly, not corrupt data. The real residual concern was that migration #3 used the legacy non-atomic `run:` pattern, so a hypothetical ALTER failure would leave the lessons table without its HNSW index (DROP INDEX had already run).
- **Fix:** 2026-04-09 — Converted migration #3 from the legacy `run:` pattern to the atomic `statements:` pattern so all three operations (DROP INDEX / ALTER / CREATE INDEX) plus the `schema_migrations` insert run inside a single `sql.transaction()`. A future ALTER failure now rolls back the DROP INDEX, so the table never ends up indexless. Added a clarifying comment block explaining the current dim consistency and why the ALTER is a no-op in practice. Updated `api/__tests__/db.test.ts` transaction-count assertion (38 → 39).
- **Status:** fixed 2026-04-09 — non-atomic risk eliminated; code is consistent at 2000 dims; hard-destructive scenario is moot in current state.

---

# Part 5 — Sidecar (Python on Railway)

**Note:** `CLAUDE.md` describes the sidecar as TypeScript using `pg`. The actual code is now Python (`databento_client.py`, `trade_processor.py`, etc.). Update CLAUDE.md as part of this audit cycle.

## What's working well

- **Module separation** — alert / trade / db / symbol / databento are isolated with thin interfaces.
- **Decimal precision** for prices throughout (no float drift).
- **`alert_engine` tests** are actually thorough (cooldowns, global cap, warmup, multiple symbols).
- **Databento parent symbology** — using `stype_in='parent'` is the right way to ride contract rolls.
- **Graceful shutdown handler** intent is in the right place (signal handlers + drain_pool), even though the implementation has gaps (see SIDE-006).

## Findings

### SIDE-001 — `_avg_volume` baseline is never populated; ES options unusual-volume alerts are dead code

- **Severity:** Critical → ~~re-scoped to the entire sidecar alert machinery~~
- **Verification:** agent-verified, then direct-read
- **File:** `sidecar/src/trade_processor.py:78` and `:185-205`
- **Issue:** `_avg_volume` starts empty and is never written to, so `get_unusual_volume_strikes()` always returns `[]` and `check_es_options_volume` never fires. The audit's original prescription was "populate the baseline on startup."
- **Status:** resolved 2026-04-07 (via removal, not fix)
- **Verification that reframed the finding:** Three additional bugs surfaced during verification that made the audit's 5-line fix the wrong answer:
  1. **No window reset.** `trade_processor._volume` grows monotonically for the entire sidecar process lifetime. `reset_volume_window()` exists but has zero callers. "Unusual volume in the last 15 minutes" was really "unusual volume since process start (potentially days ago)" — which would have guaranteed false positives the moment the baseline was populated.
  2. **No DB log sink.** The alert engine only writes to stdout logs and Twilio. There's no `fired_alerts` table, no dashboard query, no historical review. Fixing the alert only has value via SMS.
  3. **Twilio had been disabled in production.** The user removed the Twilio env vars from Railway because the alerts were "costing a fortune." The intent was to keep futures data flowing for ML, overnight calculations, and the frontend panel, but not to re-enable SMS.
- **Implementation:** Ripped out the entire alert machinery wholesale while preserving every byte of the data pipeline. Deleted `sidecar/src/alert_engine.py` (458 lines) and `sidecar/tests/test_alert_engine.py` (450 lines, 34 tests). Rewrote `sidecar/src/trade_processor.py` to remove `StrikeVolume`, `_volume`, `_avg_volume`, `_volume_window_start`, `get_volume_snapshot`, `get_strike_volume`, `reset_volume_window`, `get_unusual_volume_strikes`, and `FLUSH_INTERVAL_S` — keeping only `TradeRecord`, `process_trade`, `_flush_buffer`, `flush`, and `BATCH_SIZE`. Surgically removed the `alert_engine` constructor parameter and 4 call sites from `sidecar/src/databento_client.py`. Updated `sidecar/src/main.py` to drop the `AlertEngine` import and instantiation. Stripped Twilio settings and `alert_config_refresh_s` from `sidecar/src/config.py`. Trimmed `sidecar/tests/test_trade_processor.py` to drop the 14 tests that exercised removed methods, adding 3 new targeted tests for strike precision, side-char round-trip, and post-flush buffer clearing. Preserved per user instructions: `load_alert_config()` in `sidecar/src/db.py`, the `twilio>=9.0.0` line in `requirements.txt`, the `.env.example` Twilio comment, and the `alert_config` DB migration (now an orphaned future-use asset). Total: ~600 lines removed, ~120 lines of new/rewritten code. Post-change pytest: 53 passing (from 101 baseline; the -48 delta exactly matches 34 alert_engine + 14 volume-tracking trade_processor tests).
- **Consequences for SIDE-002 through SIDE-012:** Several of the other SIDE findings targeted code that no longer exists. Their status is tracked below — most are now "resolved via removal" rather than fixed in place. If the alert engine is ever rebuilt, the new implementation should be designed with the known pitfalls (window reset, DB log sink, rate-limited cost model, rolling baseline) in mind. The `user_trading_schedule.md` memory also now gives any future rebuild a cleaner set of gates to hang per-phase alerts off of.

### SIDE-002 — `_volume` dict is updated and read without holding the lock

- **Severity:** Critical → resolved-by-removal
- **Verification:** agent-only (cross-checked structurally)
- **File:** `sidecar/src/trade_processor.py:124-138` (volume update) and `sidecar/src/alert_engine.py:401-422` (read)
- **Issue:** Databento's callback dispatch is cross-thread. `process_trade` updates `_volume` outside the lock, while `check_es_options_volume` reads it concurrently. Race produces wrong volumes.
- **Status:** resolved 2026-04-07 via removal (see SIDE-001). Both `_volume` and `check_es_options_volume` no longer exist. If a future alert rebuild reintroduces shared state between Databento callbacks and an alert evaluator, use an `asyncio.Queue` or an explicit lock around the shared dict.

### SIDE-003 — No idempotency key on Databento trade inserts

- **Severity:** Critical
- **Verification:** agent-only (cross-checked structurally)
- **File:** `sidecar/src/db.py:145-163` (batch insert) and `sidecar/src/trade_processor.py:80-138`
- **Issue:** Trades flow through `_handle_trade → process_trade → batch_insert_options_trades` with no `(instrument_id, ts_event)` uniqueness check. Plain `INSERT`. Databento occasionally re-sends; duplicates accumulate.
- **Impact:** Volume aggregations and unusual-volume alerts inflate by 2-10x over weeks. Backtests and live P&L diverge.
- **Fix:** (a) Add `UNIQUE (instrument_id, ts_event)` constraint via migration. (b) Switch to `INSERT ... ON CONFLICT DO NOTHING`. (c) Backfill: query for existing duplicates and merge before applying the constraint.
- **Status:** open

### SIDE-004 — VX1/VX2 mapping is "first instrument id seen wins"

- **Severity:** Critical → Medium → **deferred pending upstream**
- **Verification:** agent-only, then re-scoped by SIDE-001 removal, then deferred per user context
- **File:** `sidecar/src/databento_client.py:394-455`
- **Issue:**

  ```python
  if iid not in self._vxm_resolved:
      if len(self._vxm_ids_seen) >= 2:
          return
      self._vxm_ids_seen.append(iid)
      symbol = "VX1" if len(self._vxm_ids_seen) == 1 else "VX2"
  ```

  Databento doesn't guarantee which instrument arrives first. After a sidecar restart, the labels can flip.
- **Status:** **deferred 2026-04-08** pending VX availability from Databento
- **Deferral reason:** As of 2026-04-08 Databento does not yet offer VX (VIX futures) on the `XCBF.PITCH` dataset — Databento is working on it but no launch date. The sidecar's `_start_vxm_client` either fails cleanly with a caught exception (setting `_vxm_client = None`) or succeeds but emits zero records. **No bad data is reaching `futures_bars` from the VX path in production right now**, so the mapping bug has no current blast radius. Fixing it now is premature optimization on code that can't be tested against a real stream. The contract-month-based fix needs to be verified against actual `expiration` values in Databento's VX Definition messages — which we won't see until the dataset is live — so the shape of the fix may need to differ from the audit's original assumptions.
- **Docstring marker:** Added to `_handle_vxm_ohlcv` in commit `1d48406` (SIDE-005/006 batch) so any developer enabling VX after the fact sees the warning about the current order-dependent mapping and the requirement to rewrite it using Definition `expiration` before pushing to production.
- **Fix when VX goes live:** Resolve VX1/VX2 from the contract month in the Definition message (Databento provides `expiration` on definition records). Pick the nearest expiry as VX1, second-nearest as VX2.

### SIDE-005 — DB connection pool `maxconn=5` with no `getconn()` timeout

- **Severity:** High
- **Verification:** agent-only, then direct-read (audit framing was slightly off)
- **File:** `sidecar/src/db.py:32-39`
- **Issue:** With Databento callbacks borrowing connections under load, `pool.getconn()` had no timeout. The audit claimed "3 Databento clients compete for 5 connections" — but clients don't hold connections continuously, they dispatch callbacks that borrow and release per-upsert. The real risk is Neon latency spikes causing callback threads to stack up on `getconn`, stalling Databento's internal thread pool.
- **Status:** resolved 2026-04-08 in commit `1d48406`
- **Implementation:** New `PoolTimeoutError` exception type. New `_getconn_with_timeout(pool, timeout_s)` helper that polls `pool.getconn` with exponential backoff (5ms → 200ms cap) until either a connection becomes available or the deadline expires. `get_conn()` now accepts an optional `timeout_s` parameter defaulting to `DEFAULT_GETCONN_TIMEOUT_S = 10.0` seconds. On a successful borrow that took longer than `SLOW_GETCONN_WARNING_MS = 1000ms`, a warning is logged AND forwarded to Sentry via `capture_message` — the early-warning signal for pool pressure building. Did NOT raise `maxconn` above 5 because the audit's concern (clients holding connections) was wrong; revisit only if operational data shows real saturation.

### SIDE-006 — Async task cleanup on shutdown is incomplete

- **Severity:** High
- **Verification:** agent-only, then direct-read (audit framing was wrong — flush was already in place)
- **File:** `sidecar/src/databento_client.py` `stop()` method
- **Issue (audit claim):** "`shutdown()` calls `_client.stop()`, sleeps 1s, then `drain_pool()`. No explicit flush. 0-10 seconds of trades lost on restart."
- **Reality on direct read:** The explicit flush IS already there — `client.stop()` was already calling `self._trade_processor.flush()` at the end before this commit. The audit missed it. BUT there's a real related issue: after stop() + the 1s sleep in main.shutdown(), Databento callback threads that were already INSIDE a `with get_conn():` block may still be running their upsert when drain_pool() fires. They'd then try to `putconn()` to a closed pool, which raises and gets swallowed.
- **Status:** resolved 2026-04-08 in commit `1d48406`
- **Implementation:** Added `_shutting_down: bool` flag to `DatabentoClient`, initialized False. `stop()` sets it True as the very first action, then sleeps 200ms before calling `client.stop()` on each Databento Live client. 200ms is short enough not to stall Railway's 10s SIGTERM grace period, long enough to cover typical Neon query latencies on a warm connection (~5-50ms). Added `if self._shutting_down: return` guards at the top of all five handlers that borrow DB connections: `_handle_ohlcv`, `_handle_ohlcv_from_client`, `_handle_vxm_ohlcv`, `_handle_trade`, `_handle_stat`. Any Databento callback that fires between `stop()` and the SDK's actual shutdown will early-return before touching the DB, so no new `with get_conn():` blocks can start once shutdown is in flight. Tests added in commit `b356df4` (SIDE-010) cover the early-return behavior in all 5 handlers.

### SIDE-007 — Health check timezone logic over-aggressive on 4 PM CT skip

- **Severity:** Medium → **won't fix (audit was wrong)**
- **Verification:** agent-only, then direct-read revealed the audit's claim about CME maintenance duration was incorrect
- **File:** `sidecar/src/health.py:82-98`
- **Audit claim:** "The `ct.hour == 16` check overshoots — CME maintenance is ~15 minutes, not a full hour. Tighten to `16:00 ≤ now < 16:15 CT`."
- **Reality:** CME Globex equity futures (ES, NQ, RTY) daily maintenance is actually a **full hour**, 4:00–5:00 PM CT. The audit's "~15 minutes" claim is wrong. Applying the audit's prescribed fix would generate **false "data_fresh" responses** during 4:15–4:59 PM CT when Globex is actually shut, which would hide real outages during the one time of day when the sidecar should legitimately be quiet. The current code is correct. Additional notes on the surrounding checks: Sunday-reopen check `ct.hour < 17` is correct (Globex reopens at exactly 5 PM CT Sunday). Friday-close check `ct.hour >= 16` is slightly conservative (Globex closes 4:00 PM CT Friday, not 5 PM) but erring on the side of "don't page me after hours" is the right default for a single-owner system.
- **Status:** **won't fix 2026-04-08** — audit was based on incorrect CME maintenance duration. No code change.
- **User-workflow context:** User trades 9:00–3:00 PM CT. The 4:00–5:00 PM CT maintenance window is entirely after the trading session ends, so false 503s during that window would not affect live trading decisions anyway.

### SIDE-008 — Twilio SMS failures are logged but never retried

- **Severity:** Medium → resolved-by-removal
- **Verification:** agent-only
- **File:** `sidecar/src/alert_engine.py:226-255` (file deleted 2026-04-07)
- **Issue:** If Twilio is down for 5 minutes, all alerts during that window are lost. State is still marked as fired, blocking re-alerts until cooldown expires.
- **Status:** resolved 2026-04-07 via removal (see SIDE-001). File no longer exists.

### SIDE-009 — Alerts fire 24/7; no session-stage gating

- **Severity:** Medium → resolved-by-removal
- **Verification:** agent-only
- **File:** `sidecar/src/alert_engine.py:28-60` (file deleted 2026-04-07)
- **Issue:** Alert thresholds are tuned for daytime hours (e.g., `es_momentum: 30 pts in 10 min at 2x volume`) but the engine has no session check. Sundays at 2 AM and Fridays at 10 AM use the same thresholds.
- **Status:** resolved 2026-04-07 via removal (see SIDE-001). If alerts are ever rebuilt, the existing `currentSessionStage()` helper from `src/data/marketHours.ts` (shipped as part of CROSS-003) would provide the right session-gating primitive — it classifies CT instants into `pre-market | opening-range | credit-spreads | directional | bwb | late-bwb | flat | post-close | half-day | closed`, which maps directly onto the user's 5-phase trading schedule.

### SIDE-010 — No tests for the Databento client (the largest, most critical module)

- **Severity:** Medium (test gap)
- **Verification:** agent-only
- **File:** `sidecar/tests/` — no `test_databento_client.py`
- **Issue:** Trade processor, alert engine, symbol manager are all tested. The Databento client itself (connection handling, definition resolution, reconnect, message parsing) has zero tests.
- **Status:** resolved 2026-04-08 in commit `b356df4` (**minimal scope** per user decision)
- **Implementation:** New `sidecar/tests/test_databento_client.py` with 20 tests covering only the paths touched by the SIDE-005/006/011/012 commits: shutdown barrier early-return in all 5 DB-borrowing handlers, definition-lag drop counter + throttle, reconnect gap duration + Sentry capture, and first-bar-after-reconnect price-jump sanity check. Uses `monkeypatch.setattr` to replace `sentry_setup.capture_message` / `capture_exception` and `db.upsert_futures_bar` / `upsert_options_daily` per-test, so no cross-file test pollution. The commit also improved test isolation across the whole sidecar test suite by moving external-package mocks (`databento`, `psycopg2`, `sentry_sdk`) to `conftest.py` and refactoring `test_sentry_setup.py` off of `sys.modules["logger_setup"]` clobbering onto `monkeypatch.setattr(sentry_setup, "log", mock_log)`. Full sidecar pytest: 88 passing (was 69 before this commit).
- **Remaining gap:** Full Databento client coverage (connection handling, definition resolution happy path, message parsing edge cases, VX path once it goes live) remains open as a future pass. Opening a tracking item here rather than keeping the original finding open — the current tests cover every line I touched in this batch, and the untouched parts are better tested with a real integration harness than with more mock juggling.

### SIDE-011 — Databento reconnect gap is logged but not recovered

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `sidecar/src/databento_client.py:452-511`
- **Issue:**

  ```python
  def _on_reconnect(self, last_ts, new_start_ts):
      log.info("Databento reconnected: gap from %s to %s", last_ts, new_start_ts)
      self._connected = True
  ```

  No backfill request, no alert on gap duration, no validation against expected pricing on the first bar after reconnect.
- **Status:** resolved 2026-04-08 in commit `0beeea9` (full scope per user decision, with one substitution)
- **Implementation:** User approved "full scope" for this finding which required Sentry integration. Added sidecar Sentry prereq in commit `8198413` (`sentry_setup.py` + `sentry-sdk>=2.0.0` dep + `init_sentry()` call in `main.py`) before touching SIDE-011 itself. Then:
  - `_on_reconnect` now computes gap duration in seconds from the two nanosecond timestamps and calls `capture_message(level="warning", context={...})` if the gap exceeds `RECONNECT_GAP_WARNING_S = 60.0`. Structured context includes `last_ts_ns`, `new_start_ts_ns`, and `gap_s` so Sentry can alert on long gaps.
  - On reconnect, every symbol with a tracked `_last_close_before_disconnect` is armed for a first-bar sanity check via `_reconnect_sanity_check_pending`.
  - `_handle_ohlcv` runs the sanity check on the first post-reconnect bar for each armed symbol: compares new close to prev close, fires a Sentry warning if abs pct move exceeds `RECONNECT_FIRST_BAR_SANITY_PCT = 2.0`. **Substitution vs audit's prescription**: audit said "1 ATR" but the sidecar has no ATR values, so a 2% price-move proxy is used. The sanity check is one-shot per reconnect — once it fires or passes, the symbol is removed from the pending set so subsequent bars don't re-trigger.
  - `_handle_ohlcv` updates `_last_close_before_disconnect[symbol]` on every successful bar write so the sanity check always has fresh data.
- **Deferred subscope:** The "request backfill via Databento historical API" part of the audit's prescription is NOT included. The gap is fully logged with structured context so a manual backfill query can be issued if needed, but an automated backfill would require (a) calling Databento's historical endpoint from inside the sidecar, (b) deduplicating against bars we already have in `futures_bars`, and (c) keeping track of which reconnect generated which backfill request. That's a meaningful feature build that's better scoped separately once there's operational data showing which gaps actually matter.
- **Tests:** 8 tests in commit `b356df4` (`TestReconnectGap` + `TestFirstBarAfterReconnectSanity`) cover the gap calculation, Sentry threshold, sanity check arming/disarming, and the 2% threshold.

### SIDE-012 — Definition lag drops trades silently

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `sidecar/src/databento_client.py:548-583`
- **Issue:** If a Trade arrives before its corresponding Definition, `_get_option_info(iid)` returns `None` and the trade is silently discarded. No counter, no log.
- **Status:** resolved 2026-04-08 in commit `0beeea9`
- **Implementation:** Added `_definition_lag_drops: int = 0` counter and `_last_lag_summary_ts: float = 0.0` to `DatabentoClient.__init__`. In `_handle_trade`, the previously-silent `return` when `instrument_info is None` now increments the counter and calls `_maybe_log_definition_lag_summary()`. The summary method emits a structured warning (and forwards to Sentry via `capture_message`) at most once per `DEFINITION_LAG_SUMMARY_INTERVAL_S = 60.0` seconds when drops have occurred, then resets the counter. This converts a previously-silent failure mode into a visible one without spamming logs on every drop. Not implementing the "buffer dropped trades for 5s and re-process" part of the audit's fix because (a) the Definition records typically arrive within milliseconds of the Trade records, so the lag window is already small, and (b) buffering requires additional state management with its own race conditions. If operational data shows the drop rate is high enough to matter, revisit.
- **Tests:** 4 tests in commit `b356df4` (`TestDefinitionLagDrops`) cover the counter initialization, drop+forward behavior, no-drop behavior when definition exists, and the 60-second throttle.

---

# Part 6 — ML pipeline (`ml/`)

## What's working well

- **Walk-forward expanding-window CV** in `phase2_early.py` — the right baseline for time series.
- **Five diverse models compared** (LR, RF, NB, DT, XGBoost) — reduces single-model selection risk.
- **Three baselines** (majority class, prev day, rule-based) — anchors "is the model actually skilled."
- **Health monitoring** (`ml/src/health.py`) — completeness, label coverage, z-score-based stationarity checks. Sophisticated for the project's stage.
- **`save_section_findings()` JSON consolidation** — gives an audit trail across runs.
- **`milestone_check.py`** tracks labeled day counts and estimates milestones — shows self-awareness about sample size.
- **Roadmap is honest** about needing 45+ labeled days before model selection becomes meaningful.

## Findings

### ML-001 — XGBoost ignores class imbalance while LR and RF use `class_weight='balanced'`

- **Severity:** Critical
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py:434-437` (XGBoost instantiation)
- **Issue:** XGB uses defaults: no `scale_pos_weight`, no sample weights. With CCS at ~56% and IC at ~12%, this biases toward the majority class. Per-class F1 scores look high only because minority predictions are sparse.
- **Fix:** (a) Add `scale_pos_weight` for binary or sample weights for multiclass. (b) Use macro-F1 (not accuracy) as the model selection metric. (c) Stratify k-fold to ensure class representation in each fold.
- **Status:** open

### ML-002 — Model selection on n=5 walk-forward predictions is statistical noise

- **Severity:** Critical
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py:254-284` (walk-forward) and `:863-866` (selection)
- **Issue:** With 25 labeled days and `min_train=20`, you get exactly 5 test points. `results.sort(key=lambda x: x['accuracy'])[0]` is picking noise. The roadmap explicitly says to wait for ~45 labeled days; the code does not enforce this.
- **Fix:** (a) Hard-stop the selection if `n_test_predictions < 25` (your roadmap's threshold). Or (b) ensemble all five models (mean of probabilities) until n is sufficient.
- **Status:** open

### ML-003 — No assertion that features at split_idx are causally valid

- **Severity:** Critical
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py:254-284` plus the upstream feature pipeline in `api/_lib/build-features-*.ts`
- **Issue:** There is no automated check that rolling-volatility / GEX features in each row were computed using only data available at the row's decision timestamp. The features come from a TypeScript backend pipeline outside the Python repo's view. A refactor in `build-features-gex.ts` could quietly introduce look-ahead and your walk-forward would still look great.
- **Fix:** Add a runtime assertion: for each row at decision time T1, every feature must come from a snapshot stamped strictly before T1. Document the temporal contract in `PHASE-0-DATA-INFRASTRUCTURE.md`.
- **Status:** open

### ML-004 — Backtest assumes binary fill at credit / max-loss with zero slippage

- **Severity:** High
- **Verification:** agent-only
- **File:** `ml/src/backtest.py:69-71, 101-160`
- **Issue:** Hardcoded `SPREAD_WIDTH=20, CREDIT_PER_CONTRACT=$200, MAX_LOSS_PER_CONTRACT=$1800`. Outcomes are binary (`+1 if structure_correct else -1`). No slippage, no partial fills, no early exits, no adjustment cost.
- **Impact:** Backtest P&L is significantly overstated. Real execution involves slippage and adjustments.
- **Fix:** (a) Apply a 25-50% credit haircut for slippage. (b) Add sensitivity analysis: vary spread width, credit, max loss. (c) Document assumptions in a backtest README.
- **Status:** open

### ML-005 — Survivorship / labeling bias not characterized

- **Severity:** High
- **Verification:** agent-only
- **File:** `ml/docs/PHASE-0-DATA-INFRASTRUCTURE.md` (label extraction definition)
- **Issue:** Labels come from the `analyses` table where `mode='review'`. It's unclear whether all trading days get reviews or only a subset. If reviews are selective (e.g., only days you actually traded), the model is trained on a non-random sample.
- **Fix:** Document the labeling pipeline explicitly. If reviews are selective, either stratify training or model the selection mechanism.
- **Status:** open

### ML-006 — No global numpy / random seed at module entry

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py` (and all other ML scripts)
- **Issue:** Individual model `random_state=42` doesn't cover stochastic feature ops, sklearn imputers, etc.
- **Fix:** Add at the top of every entry-point script:

  ```python
  import numpy as np, random
  random.seed(42)
  np.random.seed(42)
  ```

- **Status:** open

### ML-007 — SHAP analysis runs after model selection, not before

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py:887-927`
- **Issue:** SHAP plots are generated after `best_model = max(...)`. They never inform selection. A model that learned data-leakage artifacts wouldn't be flagged.
- **Fix:** Generate SHAP for all candidates, not just the best. Add a sanity check: top features should be economically sensible (volatility, Greeks, GEX), not artifacts like timestamps or row IDs.
- **Status:** open

### ML-008 — Walk-forward expanding window averages over regime changes

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `ml/src/phase2_early.py:260` (`training_df = df.iloc[:split_idx]`)
- **Issue:** Expanding window includes all historical data, even when market regime has shifted. With 25 days, this is essentially "average over all 25 days' worth of regime variation."
- **Fix:** (a) Add regime stratification — label each day's regime and stratify. Or (b) use a rolling window of 20 days instead of expanding.
- **Status:** open

### ML-009 — Charm pattern thresholds are hand-tuned, not validated

- **Severity:** Medium
- **Verification:** agent-only
- **File:** `ml/docs/PHASE-0-DATA-INFRASTRUCTURE.md` (charm pattern definitions)
- **Issue:** Rules like "negative_dominance: >80% of strikes have negative net charm" are hardcoded thresholds with no validation against actual outcomes. If labels are noisy, models trained on them are noisy.
- **Fix:** Add a validation analysis showing correlation between charm pattern rules and trade outcomes. Recalibrate if correlation is weak.
- **Status:** open

### ML-010 — `feature_completeness` metric undefined

- **Severity:** Low
- **Verification:** agent-only
- **File:** `ml/src/health.py:153-154`
- **Issue:** The metric exists but its exact definition is unclear (fraction of which columns?). Legitimate sparse features (e.g., `iv_crush_rate` only in certain regimes) penalize the score.
- **Fix:** Define explicitly: `feature_completeness = count(KEY_FEATURES non-null) / len(KEY_FEATURES)`. Separate KEY (required) from ANCILLARY (optional).
- **Status:** open

---

# Part 7 — Cross-cutting concerns

### CROSS-001 — Documentation drift: CLAUDE.md describes the sidecar as TypeScript

- **Severity:** Medium
- **File:** `CLAUDE.md`
- **Issue:** CLAUDE.md says the sidecar is TypeScript with `pg`. The actual code is Python. CLAUDE.md also says "14 cron jobs"; there are 26.
- **Fix:** Update the relevant CLAUDE.md sections.
- **Status:** open

### CROSS-002 — Silent failures need counters

- **Severity:** High (operational)
- **File:** Many — `darkpool.ts:105-108`, sidecar definition lag, `monitor-iv` price fallback, etc.
- **Issue:** Several `try/catch` blocks return `[]` or `null` on error with no counter. None of these will page you when they break; they'll slowly bias your decisions.
- **Fix:** At every silent-failure site, add a Sentry breadcrumb with a categorized tag. Then add a Sentry alert rule that fires if any tag exceeds N events/hour.
- **Status:** open

### CROSS-003 — No "gates and clocks" helper

- **Severity:** Medium
- **File:** N/A — gap
- **Issue:** Every cron and alerter should be gated by (a) trading-day check (holiday-aware), (b) session-window check (with explicit DST handling), (c) session-stage tag (your 5-phase schedule from `user_trading_schedule.md`). These checks are scattered and inconsistent.
- **Fix:** Build `api/_lib/market-calendar.ts` with `isTradingDay`, `isHoliday`, `isHalfDay`, `currentSessionStage`. Use as a hard precondition in every cron.
- **Status:** open

### CROSS-004 — No data-freshness dashboard

- **Severity:** Medium
- **File:** N/A — gap
- **Issue:** With 26 crons writing 17+ tables, there's no central view of "is each data source fresh." A stale OI table will silently bias the analyze prompt.
- **Fix:** Add a `/api/system-status` panel that shows `(table, latest_row_timestamp, expected_refresh_interval, status)` for each cron output. Surface in the frontend header.
- **Status:** open (note: `api/system-status.ts` already exists — verify what it covers)

### CROSS-005 — Boundary validation should be explicit at every system edge

- **Severity:** High
- **File:** N/A — pattern
- **Issue:** The most expensive failures will be at boundaries: CSV → analyze, dark pool → context, sidecar → DB, Schwab → token, feature pipeline → ML. A general fix that pays back across all of these: validate with Zod (TS) or pydantic (Py) at every boundary, and emit a Sentry breadcrumb on every drop instead of silent `continue`.
- **Fix:** Audit each boundary; ensure schema validation exists; ensure failed validation logs to Sentry with structured tags.
- **Status:** open

---

# Part 8 — Prioritized fix list

This is the order I'd attack if we had a focused day, grouped by independent vs dependent.

## Group A — Critical fixes that re-enable broken functionality (do first)

These can be done in parallel; each is independent.

1. ~~**SIDE-001** — Sidecar volume baseline (5-line fix).~~ **resolved 2026-04-07 via removal** — the audit's premise was wrong. Verification revealed 3 additional bugs on top of the `_avg_volume` issue, Twilio had been disabled in production for cost reasons, and there was no DB log sink. User confirmed intent to keep futures data flowing but drop the alerts entirely. Ripped out `alert_engine.py`, `test_alert_engine.py`, and the volume-tracking fields on `TradeProcessor`. ~600 lines removed, data pipeline fully preserved. See finding for full details.
2. ~~**SIDE-004** — VX1/VX2 by contract month.~~ **downgraded, still open** — the alert impact is moot (no alerts), but the data-mapping impact remains for `futures_bars` consumers. Re-prioritized to Group C.
3. **SIDE-003** — Sidecar trade idempotency. Adds `UNIQUE` constraint + `ON CONFLICT DO NOTHING`. Prevents weeks of accumulating duplicates.
4. **BE-DARKPOOL-001** + **BE-DARKPOOL-002** — Add `contingent_trade` and intraday-window filters to dark pool ingestion. Directly improves what Claude sees.

## Group B — High-severity correctness fixes

1. **BE-CRON-001** — Schwab refresh cross-instance lock via Redis. Stops silent token races.
2. **CSV-001** — Trade-grouping by ±1s window instead of exact `execTime` match. Closes the most likely path back to "naked legs misread."
3. **FE-STATE-001** — Add `isStale` flag to `useMarketData` and a UI badge.
4. ~~**SIDE-002** — Fix the `_volume` lock asymmetry.~~ **resolved 2026-04-07 via removal of the alert engine** (see SIDE-001).

## Group C — Improvements with high signal-to-noise

1. ~~**FE-MATH-001** — Pin-risk proximity weighting.~~ **done 2026-04-07** (surgical union with `PIN_ZONE_PCT` constant; see finding for details)
2. ~~**CROSS-003** — Build `market-calendar.ts` with holiday + half-day detection.~~ **fully done 2026-04-07** (`isHoliday`/`isHalfDay`/`isTradingDay`/`currentSessionStage` all in `src/data/marketHours.ts` since the existing cross-import at `api/_lib/api-helpers.ts:27` makes a separate backend file redundant. `currentSessionStage` also refactored `TradingScheduleSection` to drop its buggy local phase logic.). **Unlocked**: FE-STATE-005 was already done, FE-MATH-006 now done.
3. **ML-002** — Gate model selection on `n_test ≥ 25`. Stops you from acting on noise.
4. **CSV-002** — Lift the 50-pt cap to 200pt or expose as constant.

## Group D — Cleanup and hardening (do alongside other work)

1. **CROSS-001** — Refresh CLAUDE.md.
2. **CROSS-002** — Add counters at silent-failure sites.
3. **BE-CRON-002** — Stagger every-minute crons.
4. **BE-CRON-005** — Multi-row INSERT in `fetch-gex-0dte`.
5. ~~**FE-MATH-002** — Pin-risk `+=` instead of `=`.~~ **done 2026-04-07** (fixed alongside FE-MATH-001)
6. ~~**FE-MATH-003** — Document `entryIndex` semantics + add a unit test.~~ **done 2026-04-07** (chose Interpretation A: entry candle excluded from breach scan; fix applied to settlement.ts + scripts/entry-time-analysis.ts parallel impl)
7. ~~**FE-MATH-004** — BWB `wideWidth > narrowWidth` validation.~~ **done 2026-04-07** (clamp `maxLoss = Math.max(0, ...)` in both buildPutBWB/buildCallBWB rather than hard validation, to preserve the existing symmetric-butterfly test path)
8. ~~**FE-MATH-005** — IC negative-width guard.~~ **done 2026-04-07** (same clamp pattern applied to all three maxLoss fields in buildIronCondor — combined, put-side, and call-side)
9. ~~**FE-MATH-006** — `calcThetaCurve` fixed 6.5h day.~~ **done 2026-04-07** (parameterized `marketHours` end-to-end through `calcThetaCurve` → `useCalculation.results.marketHours` → `ThetaDecayChart`. Plus a stale `2026-07-03` entry was removed from `EARLY_CLOSE_DATES` since July 4, 2026 is a Saturday and July 3 is the observed Independence Day full closure.)
10. ~~**FE-STATE-005** — Half-day handling.~~ **already done before the audit was written** (verified 2026-04-07; `App.tsx:181` calls `getEarlyCloseHourET(vix.selectedDate)`. Audit was based on incomplete read of `useCalculation.ts`.)
11. ~~**FE-MATH-007** — `DELTA_Z_SCORES` interpolation.~~ **resolved 2026-04-07 (scope-reduced)** — verification showed the "bug" is TypeScript-unreachable; the audit's prescribed linear interpolation would require widening `DeltaTarget` from a literal union to `number` across ~15 files for a speculative "custom delta" feature that doesn't exist. Instead, added 3 invariant tests that pin the real drift concern (DELTA_OPTIONS/DELTA_Z_SCORES lockstep + z-score monotonicity). No production code changed.
12. ~~**SIDE-001** — Sidecar volume baseline.~~ **resolved 2026-04-07 via removal** (see finding — audit premise wrong, alert machinery ripped out, data pipeline preserved)
13. ~~**SIDE-002** — `_volume` lock asymmetry.~~ **resolved 2026-04-07 via removal** (alongside SIDE-001)
14. ~~**SIDE-008** — Twilio SMS retry queue.~~ **resolved 2026-04-07 via removal** (alongside SIDE-001)
15. ~~**SIDE-009** — 24/7 alert session gating.~~ **resolved 2026-04-07 via removal** (alongside SIDE-001)
16. ~~**Sentry SDK prereq for sidecar.**~~ **done 2026-04-08** (commit `8198413`) — added `sentry-sdk>=2.0.0` + `sentry_setup.py` with `init_sentry`, `capture_exception`, `capture_message` helpers. **ACTION REQUIRED**: add `SENTRY_DSN` to Railway env for sidecar reporting to actually reach Sentry.
17. ~~**SIDE-003** — Trade idempotency.~~ **done 2026-04-08** (commit `6344856`) — migration #50 adds UNIQUE index with pre-dedup step; `batch_insert_options_trades` uses `ON CONFLICT DO NOTHING`
18. ~~**SIDE-005** — Pool timeout.~~ **done 2026-04-08** (commit `1d48406`) — `PoolTimeoutError`, `_getconn_with_timeout` polling helper, slow-borrow warnings to Sentry
19. ~~**SIDE-006** — Shutdown barrier.~~ **done 2026-04-08** (commit `1d48406`) — `_shutting_down` flag + early-return in all 5 DB-borrowing handlers
20. ~~**SIDE-011** — Reconnect gap observability.~~ **done 2026-04-08** (commit `0beeea9`) — gap-duration warning to Sentry at 60s threshold, first-bar-after-reconnect 2% price-jump sanity check
21. ~~**SIDE-012** — Definition lag drops.~~ **done 2026-04-08** (commit `0beeea9`) — counter + 60-second throttled Sentry summary
22. ~~**SIDE-010** — Databento client tests.~~ **done 2026-04-08 minimal scope** (commit `b356df4`) — 20 tests covering the paths touched by SIDE-005/006/011/012; test-isolation refactor of conftest.py and test_sentry_setup.py as a side benefit
23. ~~**SIDE-004** — VX1/VX2 mapping.~~ **deferred 2026-04-08** pending Databento VX availability (VX is not yet on `XCBF.PITCH`; docstring marker added to `_handle_vxm_ohlcv` so whoever enables VX after launch sees the warning)
24. ~~**SIDE-007** — Health check TZ window.~~ **won't fix 2026-04-08** — audit claimed CME maintenance is "~15 minutes" but it's actually a full hour (4:00-5:00 PM CT). Current code is correct. No change.

### Bonus work done alongside FE-MATH-001/002

- **Duplicate pin-risk test files consolidated.** `src/__tests__/pin-risk.test.ts` (which overlapped heavily with `src/__tests__/utils/pin-risk.test.ts`) was deleted after a line-by-line cross-check confirmed the keeper had strictly stronger coverage (boundary-case tests + new behavior tests). Adding this as an observation here so future audits know the duplicate is gone by design, not by accident.
- **`PinRiskAnalysis.test.tsx` updated** — the old `limits to top 8 strikes` test was checking the strict cap behavior. Split into two tests: one asserting the cap still applies when no strikes are near spot, and a new test asserting near-spot candidates below the top-N are correctly included.

## Group E — Lower priority

Everything else in the findings list, in roughly the order it appears.

---

# Part 9 — Open questions / verify before fixing

A few items in the report came from agents I did not personally re-verify. Verify these against the actual file before applying any fix:

1. **BE-CRON-004** — Does `monitor-iv.ts` actually have the broken fallback at the cited lines? Read the file before fixing.
2. **BE-CRON-005** — Confirm the N+1 INSERT pattern in `fetch-gex-0dte.ts`. May already use multi-row in current version.
3. **BE-CRON-010** — Check `schema_migrations` table to see if migration #3 has already been applied. If so, this finding is moot.
4. **SIDE-002** — Verify the lock acquisition pattern in `trade_processor.py:124-138` and `alert_engine.py:401-422` against the actual current code.
5. **All ML findings** — I did not personally read `phase2_early.py` or `backtest.py`. The structure of the findings matches typical ML pipeline issues at this stage, but verify each citation before applying a fix.

---

# Appendix A — Files I personally read (trust these citations completely)

- `src/utils/black-scholes.ts` (full)
- `src/utils/strikes.ts` (full)
- `src/utils/iron-condor.ts` (full)
- `src/utils/bwb.ts` (full)
- `src/utils/hedge.ts` (full)
- `src/utils/pin-risk.ts` (full)
- `src/utils/settlement.ts` (full)
- `src/utils/csvParser.ts` (full — turned out to be VIX OHLC, not positions)
- `src/utils/time.ts` (full)
- `src/utils/gex-migration.ts:100-250`
- `src/hooks/useCalculation.ts` (full)
- `api/_lib/darkpool.ts` (full)
- `api/_lib/csv-parser.ts` (full — the actual TOS positions parser)
- `api/cron/build-features.ts:250-260`

# Appendix B — Files I delegated to agents

Trust the structural findings but verify file:line citations before fixing:

- All of `ml/src/`
- All of `sidecar/src/`
- All of `api/cron/` except `build-features.ts`
- Most of `api/_lib/` except `darkpool.ts` and `csv-parser.ts`
- Most of `src/hooks/` except `useCalculation.ts`

# Appendix C — Hallucinated agent claims that have been removed from this report

Listing these so we don't accidentally chase them in a future session:

1. **"`adjustedPoP = basePutSigma + baseCallSigma - basePoP` in iron-condor.ts"** — does not exist. The actual `adjustICPoPForKurtosis` is correct.
2. **"Call BWB max profit is just `netCredit`"** — false. `bwb.ts:200` correctly uses `narrowWidth + netCredit`.
3. **"`csvParser.ts` does not match Schwab multi-leg orders"** — false; that file is a VIX OHLC parser. The actual TOS positions parser is `api/_lib/csv-parser.ts` and it does the right thing (with the caveats in CSV-001..004).
4. **"build-features.ts hardcoded `-05:00` produces wrong day-of-week 8 months/year"** — overstated. The day-of-week is correct under all UTC server conditions; the hardcode is a code smell, not a bug. Downgraded to Low (BE-CRON-003).
5. **"Iron condor PoP is double-adjusted for kurtosis"** — false. The `adjustICPoPForKurtosis` and `adjustPoPForKurtosis` functions are applied to different objects (combined IC vs per-side spreads), not to the same value twice.

---

*End of audit.*
