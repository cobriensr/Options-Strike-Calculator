# Never-Vanish — Code-Review Round 4 (altitude hardening)

**Date:** 2026-06-07
**Source:** high-effort `/code-review` of the round-3 merge (PR #176). THIRD consecutive clean correctness pass — all findings are altitude/maintainability.
**Branch:** `fix/never-vanish-round4` off `origin/main` (f868e3fc).
**Execution:** subagent-driven, per-phase implement → review → commit.

## Findings → phases (several merge)

### Phase 1 — bind the never-vanish ↔ retention coupling in code (#1, #5, #6, #3, #8)
The diff-skip in `lottery-finder.ts` (insert only `everQualifying \ keptTickers`) is correct ONLY because the prune never deletes today's rows. Today that invariant is prose-only across two files. Bind it:
- **#5/#6:** add `export const KEPT_RETENTION_DAYS = 7;` to `api/_lib/constants.ts` with a one-line rationale (`>= 1 trading day; 7 = margin for weekend/holiday gaps + late enrichment`). Rewrite the prune in `api/cron/enrich-lottery-outcomes.ts` to the cast-free integer-day form using the constant: `DELETE FROM lottery_kept_tickers WHERE trade_date < (now() AT TIME ZONE 'America/New_York')::date - ${KEPT_RETENTION_DAYS}`. (date − integer stays a date; no double-cast.)
- **#1:** in `lottery-finder.ts`, update the diff-skip comment to reference `KEPT_RETENTION_DAYS` by name (not a hand-copied "7d"). Add a **test** that binds the coupling: assert `KEPT_RETENTION_DAYS >= 1` AND that the prune SQL uses strict `< … - KEPT_RETENTION_DAYS` (so tightening to `<=`/today, or to 0, fails the test). Given the cron test mocks `getDb` (no real Postgres), assert the generated SQL shape references the constant + strict `<` — the realistic binding under the mock harness; note the limitation in the test comment.
- **#3:** emit a distinct heartbeat metric on prune execution — `metrics.increment('lottery.kept_prune')` inside `pruneKeptTickers` (after the DELETE, still inside `safeDbVoid`) — so a missing prune (cron disabled/renamed) is observable. Assert it in the test.
- **#8:** while in `lottery-finder.ts`, change the set-difference to `const kept = new Set(keptTickers); everQualifying.filter((t) => !kept.has(t))` — reads as set-difference, O(n). (Negligible perf, clarity only.)
- Files: `constants.ts`, `enrich-lottery-outcomes.ts`, `lottery-finder.ts`, `enrich-lottery-outcomes.test.ts` (+ `lottery-finder-endpoint.test.ts` if the Set change needs a touch).

### Phase 2 — db.ts hardening (#2, #4)
- **#2:** add a runtime guard in `migrateDb()` (`api/_lib/db.ts`): BEFORE the apply loop, assert `MIGRATIONS` ids are unique and strictly monotonic; `throw` with a clear message naming the offending id/pair on violation. This is defense-in-depth vs the unit test — a dup-id deploy fails fast at boot at the single chokepoint, instead of silently skipping a migration's SQL. Add a `db.test.ts` case: a duplicate/non-monotonic MIGRATIONS-like input makes the guard throw (extract the guard to a tiny pure helper if needed for testability).
- **#4:** sharpen `safeDb`'s contract — add a `⚠️ Best-effort ONLY` doc comment: swallows failures + emits `db.error`; use ONLY for idempotent or fire-and-forget ops; NEVER for a write whose failure must surface (use `withDbRetry` for those). Keep the name (rename across call sites is disproportionate for a not-yet-misused helper); the contract comment makes misuse read as obviously wrong.
- Files: `db.ts`, `db.test.ts`.

### Not changed (defensible as-is — noted, not "fixed")
- **#7** (dup-id test subsumed by monotonic test): KEEP both — the dup test is order-independent and gives a distinct diagnostic; removing a working guard is a downgrade.
- **#9** (`safeRedisVoid` single call site): KEEP for symmetry with `safeDbVoid`.

### Phase 3 — verify + ship
Full `npm run review` (note the unrelated `takeit-score.parity` missing-ML-artifact failure). Final `code-reviewer` over the whole diff. PR → main → merge.

## Constraints
- No new migration, no behavior change except the heartbeat metric + the (correctness-equivalent) cast-free prune form.
- Never throw from `pruneKeptTickers`/kept-tickers (best-effort). The migrateDb guard SHOULD throw (fail-fast is the point) — but only on a genuinely malformed MIGRATIONS array (a developer/merge error, never runtime data).
