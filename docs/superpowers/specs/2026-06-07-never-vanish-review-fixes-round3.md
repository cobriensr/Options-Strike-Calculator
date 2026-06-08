# Never-Vanish — Code-Review Round 3 (polish)

**Date:** 2026-06-07
**Source:** high-effort `/code-review` of the round-2 merge (PR #175). NO correctness bugs found — 10 efficiency/cleanup/process findings.
**Branch:** `fix/never-vanish-round3` off `origin/main` (54b8fa60).
**Execution:** subagent-driven, per-phase implement → review → commit.

## Findings → phases

### Phase 1 — write-amplification (#1, the only runtime-cost item)
`api/lottery-finder.ts` ~line 1292: `addKeptTickers(targetDate, everQualifying)` writes the full ~50-row set every poll (≈100% no-op ON CONFLICT in steady state). The request already read `keptTickers` (line 518). INSERT only the set difference: `everQualifying.filter((t) => !keptTickers.includes(t))` → steady state issues ZERO writes. Verified safe (no race/miss; rows are durable, no cleanup races *today* — but see Phase 4: with a 7-day prune, only rows older than 7d are removed, never today's, so the diff-skip stays correct). Add a comment tying the diff-skip to the "today's rows are never pruned" invariant. Update endpoint test.

### Phase 2 — kept-tickers.ts cleanup (#2, #5, #8)
`api/_lib/kept-tickers.ts`:
- **#2:** replace the hand-rolled `$N` placeholder batched INSERT with the UNNEST tagged-template form: `sql\`INSERT INTO lottery_kept_tickers (trade_date, underlying_symbol) SELECT ${date}::date, t FROM unnest(${tickers}::text[]) AS t ON CONFLICT DO NOTHING\``. Halves params (1 array vs 2/row), removes manual index math, no 65535-param ceiling. Verify the neon driver binds `${tickers}::text[]` as one array param (check existing UNNEST usage in repo, e.g. path-shape.ts / gexbot-store.ts).
- **#8:** drop the now-redundant `[...new Set(...)]` dedup — input is the set-difference of `ever_qualifying` (already `array_agg(DISTINCT …)`) and ON CONFLICT DO NOTHING makes any residual dupes harmless. Keep the empty-input no-op guard.
- **#5:** fix the stale doc comment: "migration #187" → "migration #188".
- Update `api/__tests__/kept-tickers.test.ts` for the UNNEST shape.

### Phase 3 — abstraction symmetry + small dedup (#6, #7, #9, #10)
- **#9:** add `safeDb<T>(op: () => Promise<T>, fallback: T): Promise<T>` mirroring `safeRedis` (swallow + `metrics.increment('db.error')` + return fallback). Place near `db.ts` (or a small helper). Route `readKeptTickers`/`addKeptTickers` through it (removes their hand-rolled try/catch).
- **#10:** `redis.ts` — add a `safeRedisVoid(op)` overload (or default the `fallback` param to `undefined`) so `writeLastGood` stops threading an explicit `undefined` sentinel. Cosmetic.
- **#6:** make `DB_RETRY_ATTEMPTS` the single source — change `withDbRetry`'s default param in `db.ts` from `retries = 2` to `retries = DB_RETRY_ATTEMPTS` (import from `constants.ts`; constants.ts is a leaf, no cycle). Same for the timeout default if it has one (`DB_RETRY_TIMEOUT_MS`).
- **#7:** `lottery-suppression.ts` — type the param `symbolAlias: SymbolAlias` where `type SymbolAlias = 'f' | 'ranked' | 'cd'`. KEEP the runtime whitelist/throw as defense-in-depth at the `db.unsafe()` splice (an un-vetted alias should still throw, not just fail tsc), but the literal-union makes a bad alias a compile error at call sites.
- Tests for safeDb, the constant single-source, and the typed alias.

### Phase 4 — retention prune (#3)
`lottery_kept_tickers` grows unbounded (no cleanup). Piggyback an existing post-close lottery cron — check `api/cron/enrich-lottery-outcomes.ts` (runs post-close). Add a one-statement `DELETE FROM lottery_kept_tickers WHERE trade_date < (now() AT TIME ZONE 'America/New_York')::date - INTERVAL '7 days'` at the end of that handler (wrapped so a prune failure never fails the cron's main job — best-effort, log + metric). 7-day retention keeps today's rows safe (Phase 1's diff-skip invariant holds). If `enrich-lottery-outcomes` isn't a clean fit, a tiny dedicated cron + vercel.json entry + CRON_SECRET guard. Update/add the cron's test.

### Phase 5 — process guard (#4)
`api/__tests__/db.test.ts`: add an assertion that the `MIGRATIONS` array ids are STRICTLY MONOTONIC and UNIQUE (no duplicate/again ids) — so a future concurrent-branch id collision (#187/#188 happened this round) fails CI structurally instead of relying on the SQL-call-count check (which can't distinguish two same-id entries summing to the right count).

### Phase 6 — verify + ship
Full `npm run review` (note the unrelated `takeit-score.parity` missing-ML-artifact failure). Final `code-reviewer` over the whole diff. PR → main → merge.

## Constraints
- No new migration (table exists). No behavior change beyond the write-amp reduction + retention.
- Never throw from kept-tickers helpers (degrade to `[]`/no-op).
- `git add` only touched files; worktree is clean.
