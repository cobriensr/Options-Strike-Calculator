# Never-Vanish — Code-Review Round 2 Fixes

**Date:** 2026-06-07
**Source:** high-effort `/code-review` of the server-side resilience commits (`9d877590`, `78641ba6`, `0ec00285`) — 10 findings.
**Branch:** `fix/never-vanish-round2` off `origin/main`.
**Execution:** subagent-driven, per-phase implement → spec-review → code-quality-review → commit.

## Goal

Close the residual never-vanish gap the round-2 review found: the monotonic Q1/Q2
kept-set was sourced from the **page-0 rendered slice**, so a ticker that flipped
Q1/Q2 while sitting past row 50 still vanished from feed + counts. Replace the
page-scoped Redis kept-set with a **DB-backed, page-independent, durable
"ever-shown" record**, collapse the 6 copy-pasted suppression predicates to one
shared helper, and clear the cleanup findings.

## Decisions (from review)

- **#1 page-independence + #2 skew + #4 durability** → unified: a Postgres table
  `lottery_kept_tickers(trade_date, underlying_symbol)`. Written **page-independently**
  every poll from the full `ranked` set (no LIMIT/OFFSET), read by BOTH the feed and
  ticker-counts endpoints. One authoritative, durable source. Survives Redis eviction.
- **#5 cron-stabilized quintile** → **NOT done.** Superseded by the DB record, which
  achieves the never-vanish guarantee at the display layer WITHOUT mutating the
  analytical `inversion_quintile` that the ML feature pipeline + scoring train on.
  This is the better altitude: never-vanish is a UI/display concern and must not
  corrupt the underlying analytical quintile.
- **#3** → one shared suppression-predicate helper, alias-parameterized.
- **#6** → kept-set read becomes a DB read folded into the existing `Promise.all`
  (no extra serial round-trip).
- **#7** → `degradeOnTimeout` cache params become an options object; `2/20_000`
  retry budget becomes shared named constants.
- **#8** → move the `redis` singleton out of the auth module `schwab.ts` into a
  neutral `api/_lib/redis.ts`; add a `safeRedis` swallow+metric wrapper for the
  remaining Redis caller (`last-good-cache.ts`). (kept-tickers no longer uses Redis.)
- **#9 (sadd/expire non-atomic) + #10 (smembers array guard)** → dissolved: the
  kept-set leaves Redis entirely. last-good-cache keeps its `?? null` guard.

## Phases (each ≤5 files, independently shippable)

### Phase 1 — DB-backed kept-tickers + migration
- `api/_lib/db-migrations.ts`: new numbered migration — `CREATE TABLE IF NOT EXISTS
  lottery_kept_tickers (trade_date date NOT NULL, underlying_symbol text NOT NULL,
  PRIMARY KEY (trade_date, underlying_symbol))`. Index implied by PK.
- `api/__tests__/db.test.ts`: add `{ id: N }` to applied-migrations mock, add to
  expected-output list, bump SQL call count (per CLAUDE.md migration discipline).
- `api/_lib/kept-tickers.ts`: rewrite Redis → DB. `readKeptTickers(date): string[]`
  = `SELECT underlying_symbol FROM lottery_kept_tickers WHERE trade_date = $1`.
  `addKeptTickers(date, tickers)` = batched `INSERT ... ON CONFLICT DO NOTHING`
  (single multi-row INSERT, not per-row — see `feedback_batched_inserts`). Both
  swallow + `metrics.increment` on error (DB-down degrades to today's behavior: `[]`).
  Guard empty tickers (skip INSERT). Tests rewritten for DB mock.

### Phase 2 — shared suppression-predicate helper
- New `api/_lib/lottery-suppression.ts` (or fold into `db-strike-helpers.ts`):
  `keptSuppressionSql(db, alias, showAll, keptTickers)` returns the composed SQL
  fragment `(${showAll} OR <alias>.inversion_quintile IS NULL OR
  <alias>.inversion_quintile > 2 OR <alias>.underlying_symbol = ANY(${keptTickers}::text[]))`.
  Alias is a whitelisted identifier (`s`/`f`/`ranked`/`cd`), NOT a bind param;
  `showAll` + `keptTickers` ARE binds. Verify @neondatabase/serverless fragment
  composition (nested `db` fragments / `sql` helper) works with the tagged-template
  callers. Unit tests for the fragment shape + alias whitelist + empty-array bind.

### Phase 3 — rewire `api/lottery-finder.ts`
- Page-independent accumulation: derive ever-shown from the **full `ranked` set**
  (the CTE already scans every chain) — `SELECT DISTINCT underlying_symbol FROM
  ranked WHERE inversion_quintile > 2` (no LIMIT) — and `addKeptTickers` THAT, not
  the page slice. (#1)
- Replace all suppression-predicate copies with `keptSuppressionSql(...)`. (#3)
- Fold `readKeptTickers` into the `Promise.all` (no serial pre-await). (#6)
- `degradeOnTimeout` → options object `{ cacheKey, cacheTtlSec, retries, timeout }`;
  introduce `DB_RETRY_ATTEMPTS=2`, `DB_RETRY_TIMEOUT_MS=20_000` shared constants. (#7)
- Update `api/__tests__/lottery-finder-endpoint.test.ts` mocks.

### Phase 4 — rewire `api/lottery-finder-ticker-counts.ts`
- Use `keptSuppressionSql(...)` + DB `readKeptTickers` (now reads the same
  authoritative table the feed writes → #2 fully resolved). Fold read into query
  setup. Update test.

### Phase 5 — neutral redis module + cleanup
- New `api/_lib/redis.ts`: move `createRedis()` + `redis` export here; `schwab.ts`
  re-imports (behavior identical — pure move). Grep ALL importers (`No Semantic
  Search` rule) and update. (#8)
- `api/_lib/last-good-cache.ts`: import `redis` from `redis.ts`; add `safeRedis(op)`
  wrapper centralizing swallow + `metrics.increment('redis.error')`. (#8)
- Confirm the `2/20_000` export-path literals in `lottery-export.ts` /
  `silent-boom-export.ts` reference the shared constants. (#7)

### Phase 6 — verify + ship
- Full `npm run review` (note the 3 unrelated concurrent `lottery-score-weights-v2`
  failures — not ours). Final `code-reviewer` subagent over the whole diff.
- Commit per-phase already; open PR to main, merge.

## Data dependencies
- New table `lottery_kept_tickers` (migration). No new env vars. No cron change.
- `POST /api/journal/init` runs the migration in prod (OWNER_SECRET empty in prod →
  migration via the init endpoint / direct psql per `feedback_owner_secret_empty_in_prod`).

## Thresholds / constants
- `DB_RETRY_ATTEMPTS = 2`, `DB_RETRY_TIMEOUT_MS = 20_000`.
- Suppression keep rule unchanged: `quintile IS NULL OR quintile > 2 OR ever-shown`.

## Open questions
- Fragment composition mechanics in @neondatabase/serverless — implementer verifies
  against the installed package (`Verify Against Source` rule), not assumption.
- Whether to fold the predicate helper into `db-strike-helpers.ts` vs a new file —
  implementer's call based on existing structure.
