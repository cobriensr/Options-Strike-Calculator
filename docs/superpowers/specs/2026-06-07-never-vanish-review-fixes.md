# Never-Vanish — Code-Review Fixes

**Date:** 2026-06-07
**Branch:** work on `fix/feed-never-vanish` (main working dir); cherry-pick fix commits onto `origin/fix/never-vanish` (PR #172, fast-forward) at the end.
**Source:** high-effort `/code-review` of the never-vanish feature (10 findings).

## Decision (filter vs never-vanish) — #1
A deliberate **server-filter change rescopes the union**. Never-vanish protects against *poll churn* within a given filter setting; an explicit filter narrowing must still drop now-excluded rows. Implementation: fold the active server-filter params into the union `storageKey`.

## Findings → fixes → phases

### Phase A — `useStickyUnion` hardening (`src/hooks/useStickyUnion.ts`)
- **#7 quota/reliability:** add a size cap (defensive max entries) AND, on mount, sweep+delete stale `feed-union:*` localStorage keys whose date≠today (prevents unbounded cross-day growth → silent QuotaExceeded degradation).
- **#8 perf:** replace the full-union `JSON.stringify`-to-compare on every poll with a per-item dirty check during the upsert loop (changed-content detection in O(incoming) not O(union)); **debounce** the localStorage persist (trailing write) so a single new row doesn't synchronously rewrite the whole growing blob.
- **#9 null-key guard:** skip ingesting any item whose `key(item)` is empty/null/contains `undefined`/`null` segments (don't produce a colliding key that clobbers a distinct row).
- **#6 retraction hook API:** add an optional `retract?: (item, key) => boolean` or an imperative `dismiss(key)` so a genuinely-retracted row can leave (server-driven tombstone or user dismiss). Minimal: support a `tombstones: Set<string>` / predicate input that excludes keys.
- Remove the provably-dead `loadedKeyRef` mid-ingest rehydrate branch (effect ordering makes it unreachable).
- Keep all existing `useStickyUnion` tests green; add tests for cap, stale-key sweep, dirty-skip, debounce, null-key skip, retract.

### Phase B — `useNeverVanishFeed` shared hook (`src/hooks/useNeverVanishFeed.ts`, new)
Consolidate the ~120 duplicated lines from both feeds (**#10**): union + `unionEngaged` gate + page>0 dedup + total floor + per-ticker count MAX-merge. Inputs: `{ fetched, engaged, page, pageSize, storageKey, key, serverTotal, serverTickerCounts, getSymbol }`. Returns `{ rows, pagedRows, total, totalPages, tickerCounts }`. Bake in:
- **#1 filter rescope:** caller passes a `storageKey` that already includes a filter signature (date + hashed server-filter params); the hook resets on storageKey change (already the behavior).
- **#3 pagination coherence:** make `total`/`totalPages` consistent with what's actually reachable. On the engaged (page-0) live view the whole union is rendered; `totalPages` must not advertise pages the server `hasMore` can't reach. Resolution: when engaged, paginate **over the union itself** (slice by page) OR clamp `totalPages` to reflect union+server reachable set so the pager never shows an unreachable page with a disabled Next. (Pick the cleaner; document it.)
- Reuse the storage plumbing from `usePersistedState`/`persist-encoding` where possible rather than duplicating (the `useStickyUnion` storage guards stay the canonical copy).
- Tests for the hook (dedup, total/pages coherence, count merge, engaged/disengaged).

### Phase C — wire both feeds to `useNeverVanishFeed`
- `src/components/LotteryFinder/index.tsx` + `src/components/SilentBoom/index.tsx`: replace the hand-rolled blocks with the shared hook.
- **#1:** build the `storageKey` filter signature from the active server-filter state (Lottery: minTakeitProb, minScore/conviction, minFireCount/burst, mode, optionType, tod, reload, cheapCallPm, minPremium, showAll; SB: minVolOi, askPctBand, minScore, minDte, minPremium, hideLatePm, burst, aggressivePremium, minTakeitProb, optionType, tod).
- **#2 reignited dedup (Lottery only):** dedup ticker groups against the **reignited-union keys** (a chain present in the reignited union must NOT also render in a ticker group), instead of the stale per-row `reignited` flag — so a chain that left the per-poll top-N doesn't render twice.
- **#4 ET-midnight roll:** derive `date`'s default from a live clock (or add a rollover effect) so a tab left open past ET-midnight advances the day and the union rescopes, rather than upserting the new day into the prior day's union.
- Keep all feed tests green; add tests for filter-rescope (tighten filter → excluded rows drop), reignited-dedup (no double render), pagination coherence.

### Phase D — server-side feed robustness (#5) — scoped + flagged risk
The UI never-vanish is client-only; exports (`api/lottery-export.ts`, `api/silent-boom-export.ts`) and other consumers still drop rows. Full feed-level never-vanish needs **server state** (Upstash Redis "last-good" cache keyed by query) since the functions are stateless.
- Tractable fix: in `api/lottery-finder.ts`, make the reignition/badge/cluster `degradeOnTimeout(..., [], ...)` cache the last successful result in Redis (short TTL) and return last-good on timeout instead of `[]` — so the server itself stops blanking. Guard behind existing KV availability.
- Q1/Q2 live-suppression: gate suppression on a monotonic/once-kept basis if feasible, else leave (documented).
- **This phase is higher-risk (production query path).** Implement behind the existing `withRetry`/KV patterns, full cron/endpoint test coverage. If the Redis-last-good proves too invasive for this pass, ship A–C (which already make the UI never-vanish absolute) and file D as a tracked follow-up with this spec section as the design.

### Phase E — verify + ship
- Full `npm run review` (note the 3 unrelated concurrent `lottery-score-weights-v2` failures).
- Cherry-pick the fix commits onto `origin/fix/never-vanish` (fast-forward) → PR #172 updates.

## Sequencing
A → B → C are dependent (C uses B uses A). D is independent (api/). Each phase: subagent implement → review → commit.
