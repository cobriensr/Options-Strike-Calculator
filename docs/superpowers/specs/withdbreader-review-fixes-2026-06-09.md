# withDbReader review fixes (round 2 of /code-review on 0490f097)

**Date:** 2026-06-09. Fixes all 7 findings from the high-effort review.

## Fixes

### #1 — restore the `endpoint` Sentry tag (api/_lib/request-scope.ts)
strike-trade-volume lost `scope.setTag('endpoint', ...)`. Fix at the right
altitude: add `scope.setTag('endpoint', path)` in `withRequestScope` next to
`setTransactionName`, so EVERY withRequestScope/withDbReader endpoint gets the
tag uniformly (additive, restores strike-trade-volume, no per-endpoint code).

### #7 — centralize auth in withDbReader (api/_lib/request-scope.ts + 17 endpoints)
The auth guard was copy-pasted as the first line of all 17 inner handlers — a
forgotten guard = data exposure. Make `auth` a REQUIRED 3rd positional param so
it cannot be omitted:
```ts
type DbReaderAuth = 'owner' | 'owner-or-guest' | 'public';
export function withDbReader(path, label, auth: DbReaderAuth, handler, opts?) {
  return withRequestScope('GET', path, async (req, res, done) => {
    const onceDone = latch(done);                          // see #3
    try {
      if (auth !== 'public') {
        const guard = auth === 'owner' ? guardOwnerEndpoint : guardOwnerOrGuestEndpoint;
        if (await guard(req, res, onceDone)) return;       // rejected → response sent
      }
      await handler(req, res, onceDone);
    } catch (err) {
      sendDbErrorResponse(res, err, { label, serverErrorBody: opts?.serverErrorBody, done: onceDone });
    }
  });
}
```
Each handler drops its `if (await guard(req,res,done)) return;` line + the guard
import, and declares its mode. **Auth map (verified from source — a wrong mode is
a security bug):**
- `owner-or-guest` (15): alerts, gamma-setups/active, gamma-setups/weekly-stats,
  greek-exposure-strike, interval-ba-alerts, interval-ba-feed, ml/prediction,
  nope-intraday, periscope-chat-detail, periscope-lessons-list, periscope-playbook,
  strike-trade-volume, tracker/alerts/unread, vega-spikes, zero-gamma
- `owner` (1): journal (guardOwnerEndpoint) — keep its rejectIfRateLimited line
- `public` (1): ml/plots (no guard today)
Rate-limits (journal 20, periscope-chat-detail, periscope-lessons-list) STAY in
the handler (varied limits/keys — out of scope for the wrapper).

### #3 — done() latch (api/_lib/request-scope.ts)
`done` is not idempotent; a throw after `done({status:200})` double-records the
request. Wrap done in a once-latch (`finalized` flag) shared by guard + handler +
catch, so done fires at most once per request — kills the double-emit. (Residual:
a 200-then-throw records 200; acceptable, near-impossible with plain payloads.)

### #2 — document (api/_lib/request-scope.ts JSDoc + spec)
Guard/rate-limit failures (Redis blip, checkBot network) now run inside the
wrapper's try, so they soft-degrade through sendDbErrorResponse (Sentry-captured,
DB-flavored body) instead of a bare uncaught 500. This is intended (capture is an
improvement); documented so the body-mislabel isn't a surprise.

### #4 — drop redundant type imports (4 endpoints)
periscope-playbook, strike-trade-volume, periscope-chat-detail,
periscope-lessons-list kept `import type { VercelRequest, VercelResponse }` only
to annotate the inner handler params (ScopedHandler already infers them). Drop
the import + annotations to match the other 13.

### #5 — shared Sentry-mock factory (api/__tests__/helpers.ts)
The `withIsolationScope: vi.fn((cb)=>cb({setTransactionName, setTag}))` stub was
copy-pasted into the withDbReader test files. Add an exported
`isolationScopeStub()` (or `mockSentryModule()`) to helpers.ts and consume it from
the withDbReader-related test files touched here. (Broader 47-file rollout: noted,
not done — those mock sentry for unrelated reasons.)

### #6 — make adoption discoverable (CLAUDE.md)
The use-withDbReader boundary lives only in a dated spec. Add a one-line backend
convention to CLAUDE.md: "New GET reader endpoints (single-JSON, 405-gated) should
use `withDbReader` (api/_lib/request-scope.ts) — it owns scope + metrics + 405 +
auth + soft-degrade." CLAUDE.md is loaded every agent session → real enforcement
for this workflow.

## Phases
1. Wrapper: withDbReader auth param + setTag + latch + JSDoc; helpers.ts factory;
   request-scope.test.ts. Verify.
2. Migrate 17 handlers (auth arg, drop guard line+import, drop redundant types) +
   tests, in batches of ≤5. Verify each.
3. Docs (CLAUDE.md + spec).
4. Full review + code-reviewer + **security-reviewer (verify auth map)** + commit + push.

## Verification
`npm run review` green. Per endpoint: 200 happy, 401/403 (guard now wrapper-run),
4xx validation, transient→503, genuine→500 all still assert. Security-reviewer
confirms the 15/1/1 auth map matches the pre-refactor guards exactly.
