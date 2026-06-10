# Lottery Finder + Silent Boom Stabilization (2026-06-09)

**Goal:** Fix all clear bugs surfaced by the exhaustive frontend+backend audit, to strengthen and
stabilize the two flagship feeds. Product-decision items are surfaced for the owner as reached.

Source: 8-agent parallel audit (read endpoints, detect crons, enrich crons, shared scoring libs,
LotteryFinder UI, SilentBoom UI, shared feed/union hooks). Findings personally verified where marked.

## Phases (each ≤5 files, independently shippable, TDD where applicable, per-phase code-reviewer)

### Phase 1 — Enrich/outcome data corruption [CRITICAL]
- **#1 [VERIFIED]** `peak_ceiling_pct` / `minutes_to_peak` computed via lexicographic STRING compare.
  Neon returns `ws_option_trades.price` (NUMERIC) as a string; the enrich SELECTs have no cast, and
  `peakCeiling`/`minutesToPeak` (`lottery-exit-policies.ts`) use bare `px > max`. Fix: cast
  `price::float8` (and `entry_price::float8`) in `enrich-lottery-outcomes.ts:210` +
  `enrich-silent-boom-outcomes.ts`. Realized-return policies escape via subtraction-coercion.
- Zero-tick fires never get `enriched_at` → re-scanned forever; if ticks purge (2d) they are
  permanently un-enrichable. Fix: stamp a terminal marker on no-tick rows (periscope enrich is the
  reference).
- DATA NOTE: only the last ~2 days are re-enrichable (tick retention). Historical peaks for big
  winners are permanently understated — flag for ML/research consumers.
- Files: `api/cron/enrich-lottery-outcomes.ts`, `api/cron/enrich-silent-boom-outcomes.ts`, tests.

### Phase 2 — Lottery feed read-path
- **#4** `ever_qualifying` kept-set (`lottery-finder.ts:935`) is gated by the request's
  minFireCount/minTakeitProb filters → a qualifying ticker can go unrecorded and later vanish.
  Fix: compute over structural filters only.
- Ticker-count parity: add `entry_price >= MIN_ALERT_ENTRY_PRICE` (+ aggressivePremium if applicable)
  to `lottery-finder-ticker-counts.ts` so chips match the feed.
- PRODUCT DECISION: `minScore` filters raw `score` but tier badge uses qas. (Ask.)
- Files: `api/lottery-finder.ts`, `api/lottery-finder-ticker-counts.ts`, tests.

### Phase 3 — Silent Boom feed read-path
- Export ignores `minTakeitProb` (`silent-boom-export.ts`) → CSV ≠ screen. Fix.
- Ticker-count parity: add entry_price floor + aggressivePremium to `silent-boom-ticker-counts.ts`.
- PRODUCT DECISION: minScore-vs-tier; direction-gate tier exemption (feed forces tier3, detector
  stored a pre-gate tier for takeit≥0.70). (Ask.)
- Files: `api/silent-boom-export.ts`, `api/silent-boom-ticker-counts.ts`, tests.

### Phase 4 — Detect crons
- **#5** Lottery macro/direction-gate snapshot uses `firstTick.executedAt` not `rec.triggerTimeCt`
  → mis-timed gate for multi-fire chains. Fix.
- `date`/`dte` stamped from `ctx.today` (cron wall-clock) not the fire's bucket → wrong on
  late/retried runs. Fix: derive from the fire timestamp.
- Cluster-bonus order-dependence (`detect-lottery-fires.ts`) — bigger; surface/assess.
- Files: `api/cron/detect-lottery-fires.ts`, `api/cron/detect-silent-boom.ts`, tests.

### Phase 5 — Validation + scoring libs
- `z.coerce.boolean()` on `hideLatePm`/`aggressivePremium` → `=false` becomes true. Fix to
  `z.enum(['true','false']).transform(...)`.
- Train/serve quintile skew: `assignQuintile` left-closed (`<`) vs training right-closed. Fix `<=`.
- NaN guards: `flow-inversion.ts` Math.max(...cum), `lottery-inversion-bonus.ts` out-of-range quintile.
- PRODUCT DECISION: gamma double-count (V2 quintile + read-time V1 +1) + monitor-vs-feed divergence. (Ask.)
- Files: `api/_lib/validation.ts` (or validation/lottery.ts), `lottery-score-weights-v2.ts`,
  `flow-inversion.ts`, `lottery-inversion-bonus.ts`, tests.

### Phase 6 — Frontend Lottery UI
- **#2 [VERIFIED]** `unionEngaged` (index.tsx:683) missing `date===today` → union engages on
  historical replays, historical >50-fire days unpageable. Fix.
- Spot fallback `.toFixed` on rejected/null spot (LotteryRow). Fix to `'—'`.
- "still hot" badge uses `Date.now()` in render → stale. Use `nowMs`.
- `maxLength={2}` caps max-fires at 99. Raise to 4.
- Tier-count-vs-`total` denominator labeling (LotteryTierBanner).
- Files: `LotteryFinder/index.tsx`, `LotteryRow.tsx`, `LotteryTierBanner.tsx`, tests.

### Phase 7 — Frontend SilentBoom UI
- **#3** `areRowsEqual` omits `liveFlowSnapshot` → Flow-Inverted/EXIT badge goes stale. Fix.
- "showing N of M" denominator lies under client-only filters. Fix labeling/subtraction.
- realized exactly 0% painted green → neutral. Fix.
- "loudest" banner raw spike-ratio vs floored row badge. Use floored.
- Files: `SilentBoom/index.tsx`, `SilentBoomRow.tsx`, `SilentBoomDayBanner.tsx`, tests.

### Phase 8 — Shared feed/union hooks
- **#6** `MAX_UNION_ENTRIES=2000` evicts still-visible oldest-inserted rows on storm days. Fix
  eviction policy (LRU on last-seen / age+not-in-items) or raise cap.
- `useLotteryFinder` page-cache uses a global `lastSavedFetchedAt` → 1-frame wrong page on
  back-nav after a poll. Fix to per-url.
- `historical` flag in `useLotteryFinder.ts:163` missing `date!==today` (the hook half of #2). Fix.
- Files: `useStickyUnion.ts`, `useLotteryFinder.ts`, `useNeverVanishFeed.ts`, tests.

## Open questions (surface as reached)
1. minScore filter on raw vs displayed (qas) score — both panels.
2. gamma double-count under V2 + monitor alignment.
3. SB direction-gate tier3 force vs stored exemption.

## Notes
- Concurrent session is mid `withDbReader` refactor on unrelated api/ endpoints — stay off those files.
- Commit per phase, push, code-reviewer each phase.
