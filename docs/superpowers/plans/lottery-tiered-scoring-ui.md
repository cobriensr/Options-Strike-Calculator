# Lottery Tiered Scoring UI

Goal: Add tiered scoring, visual badges, sort controls, CI indicators, and peak forecasts to the Lottery Finder UI to help focus on high-conviction slow-burn fires.

Context: Currently showing 84 fires/day after basic filtering. Need to surface the ~15 Tier 1 fires (35% high-peak rate) without hiding the rest.

Phase 0: Data Analysis & Scoring Model ✅ COMPLETE
Goal: Define the scoring formula and ticker confidence intervals from existing data.

Files to create:

 ml/src/lottery_scoring.py — Compute ticker stats, CI, and score weights
Work items:

Query lottery_otm_fires to compute per-ticker high-peak rates and confidence intervals
Define score formula with weights for: ticker, mode, price, tod, option_type
Output ticker stats JSON with: { ticker, n_fires, high_peak_rate, ci_width, tier }
Validate score distribution: ensure Tier 1 = ~15 fires/day, Tier 2 = ~40 fires/day
Verification:

 ml/src/lottery_scoring.py runs without errors ✅
Outputs  ml/data/lottery_ticker_stats.json with CI for all tickers ✅
Score distribution matches target (Tier 1: 10-20/day, Tier 2: 30-50/day) ✅
Dependencies: None

Estimated effort: 2 hours

Phase 1: Database Schema
Goal: Add score column to lottery_otm_fires and create lottery_ticker_stats table.

Files to modify:

 api/_lib/db-migrations.ts — Add migration #124
 api/__tests__/db.test.ts — Update migration test
Work items:

Add migration to create lottery_ticker_stats table with columns: ticker, n_fires, high_peak_rate, ci_width, tier (✓/⚠️)
Add score INTEGER column to lottery_finder_fires
Seed lottery_ticker_stats from Phase 0 JSON output
Update db.test.ts to expect migration #124
Verification:

npm run lint passes
 api/__tests__/db.test.ts passes
Local DB has lottery_ticker_stats table with data
lottery_finder_fires.score column exists
Dependencies: Phase 0

Estimated effort: 1 hour

Phase 2: Backend Scoring Logic
Goal: Compute score on fire insert and expose ticker stats via API.

Files to modify:

 api/cron/detect-lottery-fires.ts — Add scoring function, compute score on insert
 api/lottery-finder.ts — Join lottery_ticker_stats, return score + tier in response
Work items:

Add computeFireScore(ticker, mode, price, tod, option_type) function to detect-lottery-fires.ts
Compute score on each fire insert, store in score column
Modify GET /api/lottery-finder to LEFT JOIN lottery_ticker_stats on ticker
Return score, tier, ticker_ci_width, ticker_high_peak_rate in fire objects
Verification:

npm run lint passes
New fires have score populated
GET /api/lottery-finder returns score + ticker stats
Score values match Phase 0 formula
Dependencies: Phase 1

Estimated effort: 2 hours

Phase 3: Frontend Data Types
Goal: Update TypeScript types to include score and ticker stats.

Files to modify:

src/types/lottery.ts — Add score fields to LotteryFire type
Work items:

Add score: number to LotteryFire interface
Add optional ticker_stats?: { high_peak_rate: number; ci_width: number; tier: 'reliable' | 'uncertain' } to LotteryFire
Run npm run lint to catch any type errors
Verification:

npm run lint passes (no type errors)
src/types/lottery.ts exports updated LotteryFire type
Dependencies: Phase 2

Estimated effort: 15 minutes

Phase 4: UI — Peak Potential Badge
Goal: Show 🔥🔥🔥 / 🔥🔥 / 🔥 badge next to each fire based on score.

Files to modify:

src/components/LotteryFinder/LotteryFireCard.tsx — Add badge rendering
Work items:

Add getFireBadge(score: number) helper: score ≥18 → '🔥🔥🔥', 12-17 → '🔥🔥', <12 → '🔥'
Render badge next to ticker name in collapsed card
Add tooltip on hover: "Tier 1: High conviction (~35% peak rate)"
Verification:

npm run lint passes
Badges render correctly for different score ranges
Tooltip shows tier explanation
Dependencies: Phase 3

Estimated effort: 30 minutes

Phase 5: UI — Confidence Interval Indicator
Goal: Show ✓ or ⚠️ next to ticker name based on CI width.

Files to modify:

src/components/LotteryFinder/LotteryFireCard.tsx — Add CI indicator
Work items:

Add getCIIndicator(ci_width: number) helper: <10% → '✓', >15% → '⚠️', else ''
Render indicator next to ticker name with tooltip: "TSLA ✓ (n=4849, 9.2% ±1.7%)"
Style: ✓ in green, ⚠️ in yellow
Verification:

npm run lint passes
Indicators render for tickers with stats
Tooltip shows full ticker stats
Dependencies: Phase 3

Estimated effort: 30 minutes

Phase 6: UI — Sort Controls
Goal: Add sort toggle: chronological / by score / by peak %.

Files to modify:

src/components/LotteryFinder/LotteryFinder.tsx — Add sort state and controls
src/hooks/useLotteryFires.ts — Add sort parameter to API call
Work items:

Add sortMode state: 'chronological' | 'score' | 'peak'
Add sort toggle buttons in filter bar
Pass sort param to GET /api/lottery-finder?sort=score
Backend: Add ORDER BY clause based on sort param
Persist sort preference in localStorage
Verification:

npm run lint passes
Sort toggle changes fire order
Sort preference persists across page reloads
Backend returns fires in correct order
Dependencies: Phase 3

Estimated effort: 1 hour

Phase 7: UI — High Conviction Filter
Goal: Add "High Conviction Only 🔥🔥🔥" toggle to show only score ≥18 fires.

Files to modify:

src/components/LotteryFinder/LotteryFinder.tsx — Add filter toggle
src/hooks/useLotteryFires.ts — Add filter parameter
Work items:

Add highConvictionOnly boolean state
Add toggle button next to existing filters
Pass min_score=18 to API when toggled
Backend: Add WHERE clause score >= :min_score
Update fire count display: "15 fires at 11:24 CT (high conviction only)"
Verification:

npm run lint passes
Toggle filters fires correctly
Fire count updates
Filter state persists in localStorage
Dependencies: Phase 3

Estimated effort: 45 minutes

Phase 8: UI — Peak Forecast in Collapsed View
Goal: Show predicted peak range in collapsed card.

Files to modify:

src/components/LotteryFinder/LotteryFireCard.tsx — Add peak forecast line
Work items:

Add getPeakForecast(score: number) helper: Tier 1 → "30-50%", Tier 2 → "15-30%", Tier 3 → "0-15%"
Render forecast below entry/spot/IV line: predicted peak: 15-40% (Tier 2)
Style: muted color, small font
Verification:

npm run lint passes
Forecast renders in collapsed view
Forecast matches score tier
Dependencies: Phase 4

Estimated effort: 30 minutes

Phase 9: Testing & Polish
Goal: Add tests, fix edge cases, polish UI.

Files to create/modify:

src/__tests__/lottery-scoring.test.ts — Unit tests for scoring logic
 api/__tests__/lottery-finder.test.ts — API tests for sort/filter
e2e/lottery-finder.spec.ts — E2E tests for UI interactions
Work items:

Test scoring edge cases (missing ticker stats, null values)
Test sort/filter combinations
Test UI interactions (toggle, sort, expand/collapse)
Add loading states for ticker stats
Handle missing data gracefully (no stats → no badge/indicator)
Verification:

npm run test passes
npm run test:e2e passes
npm run lint passes
No console errors in browser
Dependencies: Phases 4-8

Estimated effort: 2 hours

Execution Order
Phase 0 (data analysis) — MUST run first, produces scoring model ✅
Phase 1 (schema) — depends on Phase 0 output
Phase 2 (backend) — depends on Phase 1
Phase 3 (types) — depends on Phase 2
Phases 4-8 (UI features) — can run in parallel after Phase 3, but recommended order: 4 → 5 → 6 → 7 → 8
Phase 9 (testing) — runs last
Total estimated effort: ~11 hours

Open Questions
Score weights: Should we use equal weights or prioritize certain factors (e.g., ticker reliability > tod)?
Tier thresholds: Are score ≥18 (Tier 1) and 12-17 (Tier 2) the right cutoffs, or should we adjust based on Phase 0 distribution?
CI update frequency: Should ticker stats refresh daily, weekly, or on-demand?
Default sort: Should we default to chronological or score-ranked?
Defaults (can change after Phase 0):

Equal weights for all factors
Tier 1: score ≥18, Tier 2: 12-17, Tier 3: <12
Ticker stats refresh: weekly (Sunday night cron)
Default sort: chronological (preserves current UX)
Success Criteria
Tier 1 fires show 🔥🔥🔥 badge and "30-50%" forecast
High conviction filter reduces visible fires from ~84 to ~15
Sort by score puts highest-conviction fires at top
Ticker CI indicators help identify reliable vs uncertain signals
All features work without breaking existing lottery finder functionality
npm run review passes (lint + tests) EOF cat docs/superpowers/plans/lottery-tiered-scoring-ui.md
